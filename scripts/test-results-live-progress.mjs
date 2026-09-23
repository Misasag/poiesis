import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Loaded by test-results-generation-events after its browser environment setup.
const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require('react-dom/server');
const { TaskService } = require('../agent-window/lib/browser/task-service.js');
const { RequirementService } = require('../agent-window/lib/browser/requirement-service.js');
const { AiResultsSkill, ResultsService } = require('../agent-window/lib/browser/results-skill.js');
const { ResultsPart } = require('../agent-window/lib/browser/agent-window/results-part.js');
const { SessionStore } = require('../agent-window/lib/browser/agent-window/session-store.js');
const { ResultsGenerationServerImpl } = require('../agent-window/lib/node/results-generation-server.js');
const { ResultsAssertionServerImpl } = require('../agent-window/lib/node/results-assertion-server.js');
const { PoiesisResultsElapsed } = require('../agent-window/lib/browser/components/elapsed.js');

for (const key of ['POIESIS_RESULTS_GENERATION_TEST_DELAY_MS', 'POIESIS_RESULTS_GENERATION_TEST_HTML', 'POIESIS_RESULTS_GENERATION_FORCE_FAILURE']) {
    assert(!process.env[key], `Real-path regression must not use ${key}.`);
}
const workspace = mkdtempSync(join(tmpdir(), 'poiesis-live-results-'));
const children = [];
const html = '<html><body><h2>検証の証跡</h2><table><tr><th>コマンド</th><th>結果</th></tr><tr><td>npm test</td><td>成功</td></tr></table><a data-poiesis-citation="src/timer.ts:1">根拠</a></body></html>';
const storage = { async getData() {}, async getWorkspaceData() { return []; }, async setData() {} };
const phaseLabels = ['成果文書を作成しています', '成果文書の条件を確認しています', '条件を満たさなかった 1 件を直して作り直しています（2回目）', '成果文書の条件を確認しています'];

try {
    for (const opened of ['before-task-end', 'during-generation']) {
        const tasks = new TaskService({
            async captureGitSnapshot() { return { source: 'git-snapshot', snapshotId: 'baseline' }; },
            async captureGitChangeSet() { return { source: 'task-diff', diff: '+notify()', files: ['src/timer.ts'] }; }
        }, { tryGetRoots: () => [] }, storage, storage);
        const requirements = new RequirementService(tasks, storage, storage);
        requirements.init();
        const requirement = requirements.create('session', 'タイマー通知');
        const cliCalls = [];
        const registry = { async resolve(_role, providerId, model) { return { id: providerId, name: 'Codex', path: 'fake-cli.exe', model }; } };
        const generation = new ResultsGenerationServerImpl(registry);
        const assertion = new ResultsAssertionServerImpl(registry);
        for (const [server, purpose] of [[generation, 'generation'], [assertion, 'judge']]) {
            // Only replace process creation: prompt, transport, decoding, parsing and call capture are real.
            server.spawnCli = (_id, _command, args, cwd, input) => {
                assert.equal(cwd, workspace);
                assert(args.includes('--json') && args.at(-1) === '-');
                assert.equal(typeof input, 'string');
                const child = new EventEmitter();
                child.stdout = new PassThrough();
                child.stderr = new PassThrough();
                child.kill = () => { child.emit('close', null, 'SIGTERM'); return true; };
                children.push(child);
                cliCalls.push({ purpose, child, input });
                return child;
            };
        }
        const skill = new AiResultsSkill(generation, { async generate() { throw new Error('Unexpected fallback'); } },
            { providerId: 'codex', model: 'gpt-6-luna', effort: 'medium',
                judge: { providerId: 'codex', model: 'gpt-6-luna', effort: 'medium' } },
            { async buildPrompt() { return { includedSkillIds: ['verification'], content: '', diagnostics: [],
                assertions: [{ text: '検証の証跡にコマンドと結果の表がある' }] }; } }, tasks, assertion);
        const results = new ResultsService(tasks, skill, requirements,
            { async suggestTitle() {}, async classify() {} }, {}, {});
        results.init();
        const session = { id: 'session', selectedResultsRequirementId: requirement.id,
            resultsDrafts: new Map(), resultsNotices: new Map(), resultsQaExpanded: new Map() };
        const host = { taskService: tasks, requirementService: requirements, resultsService: results,
            workspaceService: { tryGetRoots: () => [] },
            state: { resultsCli: 'codex', allowExternalResultsResources: false } };
        host.sessions = new SessionStore(host);
        host.sessions.persistWindowState = async () => {};
        const view = new ResultsPart(host);
        // This Node fixture measures lifecycle rendering, not browser DOM parsing.
        // The real sanitizer and media pipeline run in test:results-rich-content
        // and smoke:electron with a complete browser DOM.
        view.ensureRichResults = html => { view.richContent = { html, images: new Map(), diagnostics: [] }; };
        view.resultsDocumentHtml = html => html;
        let open = opened === 'before-task-end';
        let ui;
        const observed = [];
        host.update = () => {
            if (!open) return;
            const tree = view.renderResults(session);
            const elapsed = findComponent(tree, PoiesisResultsElapsed);
            const markup = renderToStaticMarkup(tree);
            ui = { phase: elapsed?.props.progress?.phase, progress: elapsed?.props.progress,
                generationStartedAt: elapsed?.props.generationStartedAt, markup };
            const phase = ui.phase ?? (markup.includes('poiesis-results__document') ? 'done' : undefined);
            if (phase && observed.at(-1) !== phase) observed.push(phase);
        };
        const subscriptions = [
            results.onDidChange(document => host.sessions.handleResultsDocumentChanged(document)),
            requirements.onDidChange(event => host.sessions.handleRequirementChange(event))
        ];
        const task = tasks.start('session', 'タイマー終了時に通知してください。', workspace, requirement.id,
            'default', pathToFileURL(workspace).href, 'codex', 'gpt-6-luna', 'medium');
        host.update();
        await tasks.end(task.id, '通知を追加しました。');
        await waitFor(() => cliCalls.length === 1);
        open = true;
        host.update(); // Opening after generation started must read the latest state without a new event.
        const starts = [];
        const totalStart = ui.generationStartedAt;
        for (let index = 0; index < 4; index++) {
            await waitFor(() => cliCalls.length === index + 1);
            const expected = ['generation', 'judge', 'regeneration', 'judge'][index];
            assert.equal(ui.phase, expected, `${opened}: the rendered canvas must receive ${expected}, not a stale Requirement copy.`);
            assert.match(ui.markup, new RegExp(phaseLabels[index].replace(/[（）]/g, '\\$&')));
            assert(ui.markup.includes('GPT-6-Luna') && ui.markup.includes('全体 '));
            assert.match(ui.markup, / · \d+:\d{2}/);
            assert.equal(ui.generationStartedAt, totalStart);
            assert(Number.isFinite(Date.parse(totalStart)));
            starts.push(ui.progress.startedAt);
            const call = cliCalls[index];
            assert.equal(call.purpose, index % 2 ? 'judge' : 'generation');
            if (call.purpose === 'judge') {
                assert(call.input.includes('| コマンド | 結果 |\n| --- | --- |\n| npm test | 成功 |'),
                    'The real judge CLI prompt must preserve the verification table.');
            }
            await new Promise(resolve => setTimeout(resolve, 5));
            const text = index % 2 ? JSON.stringify({ results: [{ index: 0, pass: index === 3, evidence: '表を確認しました。' }] }) : html;
            call.child.stdout.emit('data', Buffer.from([
                JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
                JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100 * (index + 1),
                    cached_input_tokens: [0, 60, 90, 0][index], output_tokens: 10 } })
            ].join('\n'), 'utf8'));
            call.child.emit('close', 0, null);
        }
        await results.whenFinished(task.id);
        host.update();
        assert.deepEqual(observed, ['generation', 'judge', 'regeneration', 'judge', 'done']);
        assert(starts.every((value, index) => index === 0 || value > starts[index - 1]), 'Each phase restarts its clock.');
        const document = results.getRequirement(requirement.id);
        assert.equal(document.status, 'ready');
        assert.equal(document.progress, undefined);
        assert.equal(document.calls.length, 4);
        // Exercise the real Details row, including a final call whose reported cache is zero.
        view.resultsAuxiliaryPanel = 'details';
        view.resultsAuxiliaryScopeKey = `requirement:${requirement.id}`;
        host.update();
        assert(ui.markup.includes('入力 1k トークン（キャッシュ 15%）'), 'Details must sum every call, not take the last usage.');
        assert(ui.markup.includes('出力 40'));
        subscriptions.forEach(subscription => subscription.dispose());
    }
    console.log('RESULTS_LIVE_UI_PROGRESS_TEST=passed (before-task-end, during-generation, four CLI calls, summed cache)');
} finally {
    children.forEach(child => child.emit('close', null, 'SIGTERM'));
    rmSync(workspace, { recursive: true, force: true });
}

function findComponent(node, type) {
    if (!node || typeof node !== 'object') return undefined;
    if (node.type === type) return node;
    for (const child of [node.props?.children].flat(Infinity)) {
        const found = findComponent(child, type);
        if (found) return found;
    }
}

async function waitFor(predicate) {
    const deadline = Date.now() + 3_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the real CLI service path.');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
