import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, symlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import './fixtures/results-browser-env.mjs';

const require = createRequire(import.meta.url);
const { ResultsGenerationServerImpl, RESULTS_GENERATION_TIMEOUT_MS } = require('../agent-window/lib/node/results-generation-server.js');
const { resultsExecutionEnvironment, resultsNodeExecutable, pathWithin, loadBundledResultsSkill, resultsSkillCandidates, writeClaudeResultsSettings } = require('../agent-window/lib/node/results-skill-runtime.js');
const { buildResultsSkillInput } = require('../agent-window/lib/node/results-skill-input.js');
const { spawnHiddenCli } = require('../agent-window/lib/node/hidden-process.js');
const { AiResultsSkill } = require('../agent-window/lib/browser/results-skill.js');
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');
const { PoiesisResultsElapsed } = require('../agent-window/lib/browser/components/elapsed.js');
const { cliRoleAvailability } = require('../agent-window/lib/common/cli-detection-lifecycle.js');
const fixture = resolve('scripts/fixtures/results-stub-skill');
const root = await mkdtemp(join(tmpdir(), 'poiesis-skill-test-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
const savedEnv = { ...process.env };
process.env.POIESIS_RESULTS_SKILL_DIR = fixture;
delete process.env.POIESIS_RESULTS_KEEP_RUN_DIR;
process.env.POIESIS_TEST_SECRET = 'fixture-secret-value-9d731';
const task = { id: 'test-task', status: 'completed', title: '成果の接続', request: '確認してください',
    workspaceUri: pathToFileURL(workspace).href, requirementId: 'test-requirement', activities: [],
    endedAt: '2026-09-26T12:00:00.000Z', changeSet: { source: 'task-diff', files: ['src/a.ts'],
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n' } };
const calls = [];
const scopes = [];
const progresses = [];
const request = { taskId: task.id, providerId: 'codex', workspaceUri: task.workspaceUri, taskMetadata: task,
    changeSetSummary: '{}', diff: task.changeSet.diff, changedFiles: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }],
    workspaceSkillGuidance: '追加の指示', executionEvidence: 'POIESIS_TEST_SECRET=fixture-secret-value-9d731' };
const registry = { async resolve(_role, id, model) { return { id, name: id, path: process.execPath, model }; } };
class FixtureServer extends ResultsGenerationServerImpl {
    spawnCli(id, command, args, cwd, input, env) {
        const bytes = readFileSync(join(cwd, 'input.json'));
        assert.notDeepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
        const data = JSON.parse(bytes.toString('utf8'));
        scopes.push({ args, cwd, input, data });
        assert(!pathWithin(workspace, cwd));
        assert.equal(data.schema, 'poiesis-results-input/1');
        assert.equal(data.workspace, workspace.replaceAll('\\', '/'));
        assert.equal(data.skillDir, fixture.replaceAll('\\', '/'));
        assert(!bytes.toString().includes(process.env.POIESIS_TEST_SECRET));
        assert(input.includes(readFileSync(join(fixture, 'SKILL.md'), 'utf8').trim()));
        assert(input.includes(data.userGuidance));
        assert(args.every(value => value.length <= 1000));
        // Start with no caller PATH: the app still has to make `node` work in the skill's shell.
        env = resultsExecutionEnvironment(resultsNodeExecutable(), { ...env, PATH: '', Path: '' });
        return spawnHiddenCli(id, process.execPath, [resolve('scripts/fixtures/results-fake-cli.mjs'), ...args], { cwd, input, env });
    }
}
let definitions = [];
let judgeAttempts = 0;
let judgeFailOnce = false;
const judge = { async judge() { judgeAttempts++; return { status: 'judged', output: JSON.stringify({ results: definitions.map((_, index) => ({
    index, pass: !(judgeFailOnce && judgeAttempts === 1), evidence: '利用者の条件' })) }) }; }, async cancel() {} };
function skill(server, providerId = 'codex') {
    return new AiResultsSkill(server, { providerId, model: '', judge: { providerId: 'codex' } },
        { async buildPrompt() { return { content: '追加の指示', includedSkillIds: [], diagnostics: [], assertions: definitions }; } },
        { setAppliedSkills() {}, async runHooks() { return { material: 'フックの資料' }; } }, judge);
}
const generate = server => skill(server).generate({ task, changeSet: task.changeSet,
    onCall: call => calls.push(call), onProgress: progress => progresses.push(progress) });

try {
    assert.equal(RESULTS_GENERATION_TIMEOUT_MS, 600_000);
    const server = new FixtureServer(registry);
    const metadata = await server.bundledSkillInfo();
    assert.equal(metadata.name, 'poiesis-results'); assert(metadata.description.includes('試験用'));
    assert(resultsSkillCandidates().some(path => path.endsWith(join('agent-window', 'skills', 'poiesis-results'))));
    assert(resultsSkillCandidates().some(path => path.endsWith(join('resources', 'poiesis-results'))));
    const direct = await server.generate(request);
    assert.equal(direct.status, 'generated', JSON.stringify(direct));
    assert(direct.html.includes('成果の接続') && direct.html.includes('<script>'));
    assert(!direct.html.includes('成果を保存しました。'), 'CLI stdout is never treated as the document');
    assert.equal(direct.call.usage.outputTokens, 10);
    assert(!existsSync(scopes[0].cwd));
    const args = scopes[0].args;
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.equal(args[args.indexOf('-C') + 1], scopes[0].cwd);
    assert(args.includes('sandbox_workspace_write.network_access=false'));
    assert(args.includes('web_search="disabled"'));
    assert.deepEqual(scopes[0].data.changedFiles, request.changedFiles);
    assert.equal(scopes[0].data.diff, task.changeSet.diff);
    assert.equal(scopes[0].data.retry, null);
    assert(scopes[0].data.executionEvidence.includes('[REDACTED]'));
    const fullDiff = 'diff --git a/a b/a\n' + '+data\n'.repeat(20_000);
    const material = buildResultsSkillInput({ ...request, diff: fullDiff, executionEvidence: 'x'.repeat(300_000),
        requirement: { title: 'まとめ', tasks: [{ ...request.taskMetadata, changedFiles: request.changedFiles }] } }, workspace, fixture);
    assert.equal(material.diff, fullDiff); assert(material.executionEvidence.includes('[Truncated:'));
    assert.deepEqual(material.requirement.tasks[0].changedFiles, request.changedFiles);
    assert.throws(() => buildResultsSkillInput({ ...request, diff: 'x'.repeat(16 * 1024 * 1024 + 1) }, workspace, fixture), /16 MiB/);
    assert.throws(() => buildResultsSkillInput({ ...request, images: [{ path: '../outside.png', label: '' }] }, workspace, fixture));

    for (const providerId of ['grok', 'pi']) {
        const before = scopes.length;
        const unsupported = await server.generate({ ...request, providerId });
        assert.equal(unsupported.error.message, '成果文書の作成には未対応');
        assert.equal(scopes.length, before);
        assert.equal(cliRoleAvailability('pending', undefined, providerId, 'results'), 'unsupported');
        await assert.rejects(skill(server, providerId).generate({ task, changeSet: task.changeSet }), /成果文書の作成には未対応/);
    }
    await assert.rejects(skill(server).generate({ task: { ...task, workspaceUri: undefined }, changeSet: task.changeSet }), /作業場所/);
    for (const mode of ['missing', 'empty', 'large', 'missing-always', 'empty-always', 'large-always']) {
        process.env.POIESIS_FIXTURE_OUTPUT = mode;
        const before = scopes.length;
        progresses.length = 0;
        if (mode.endsWith('-always')) await assert.rejects(generate(server), /成果文書/);
        else assert.equal((await generate(server)).generator, 'ai');
        assert.equal(scopes.length - before, 2, mode);
        assert.equal(scopes.at(-1).data.retry.attempt, 2);
        assert(scopes.at(-1).data.retry.reason.length > 0);
        assert.deepEqual(progresses.map(progress => progress.phase), ['generation', 'regeneration']);
        const progressText = renderToStaticMarkup(React.createElement(PoiesisResultsElapsed, { progress: progresses.at(-1) }));
        assert(progressText.includes('成果文書を作り直しています（2回目）') && !progressText.includes('0 件'));
        assert(!existsSync(scopes.at(-1).cwd));
    }
    process.env.POIESIS_FIXTURE_OUTPUT = 'valid';
    definitions = [{ text: '利用者の条件がある' }]; judgeFailOnce = true;
    const assertionDocument = await generate(server);
    assert.equal(judgeAttempts, 2); assert.equal(assertionDocument.assertionAttempts, 2);
    assert(scopes.at(-1).data.retry.reason.includes('利用者の条件がある'));
    assert.deepEqual(assertionDocument.assertions.map(a => a.source), ['skill']);
    definitions = []; judgeFailOnce = false;

    const claude = await server.generate({ ...request, providerId: 'claude' });
    assert.equal(claude.status, 'generated');
    const claudeArgs = scopes.at(-1).args;
    assert.equal(claudeArgs[claudeArgs.indexOf('--tools') + 1], 'Read,Write,Bash');
    assert.equal(claudeArgs[claudeArgs.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(claudeArgs[claudeArgs.indexOf('--setting-sources') + 1], '');
    assert(!claudeArgs.includes('--safe-mode'), 'The mandatory permission gate must be active');

    const control = join(root, 'control'), run = join(root, 'run');
    await mkdir(control); await mkdir(run);
    const settingsPath = await writeClaudeResultsSettings(control, run, workspace, fixture, process.execPath);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(settings.hooks.PreToolUse[0].matcher, '*');
    await symlink(workspace, join(run, 'escape'), 'junction');
    const check = (tool_name, tool_input) => {
        const result = spawnSync(process.execPath, [join(control, 'gate.cjs'), join(control, 'policy.json')], {
            input: JSON.stringify({ tool_name, tool_input }), encoding: 'utf8', shell: false, windowsHide: true
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
    };
    for (const path of [join(run, 'draft.json'), join(workspace, 'source.ts'), join(fixture, 'SKILL.md')]) assert.equal(check('Read', { file_path: path }), 'allow');
    assert.equal(check('Read', { file_path: join(root, 'secret.txt') }), 'deny');
    assert.equal(check('Write', { file_path: join(run, 'draft.json') }), 'allow');
    assert.equal(check('Write', { file_path: join(run, 'escape', 'source.ts') }), 'deny');
    assert.equal(check('Write', { file_path: join(control, 'gate.cjs') }), 'deny');
    assert.equal(check('Write', { file_path: join(workspace, 'source.ts') }), 'deny');
    const command = `node "${fixture.replaceAll('\\', '/')}/scripts/render.mjs"`;
    assert.equal(check('Bash', { command }), 'allow');
    for (const bad of [command + '; curl https://example.com', command + ' && node -e "bad()"',
        'node -e "bad()"', 'node "' + run.replaceAll('\\', '/') + '/untrusted.mjs"', command + ' $(whoami)', command + ' > ../out']) {
        assert.equal(check('Bash', { command: bad }), 'deny', bad);
    }
    assert.equal(check('Bash', { command, run_in_background: true }), 'deny');
    assert.equal(check('WebFetch', { url: 'https://example.com' }), 'deny');

    process.env.POIESIS_FIXTURE_OUTPUT = 'stall';
    const cancelledServer = new FixtureServer(registry);
    const beforeCancel = scopes.length;
    const pending = cancelledServer.generate(request);
    const cancelDeadline = Date.now() + 5000;
    while (scopes.length === beforeCancel) {
        assert(Date.now() < cancelDeadline, 'Cancellation fixture failed to start');
        await new Promise(done => setTimeout(done, 10));
    }
    assert.equal((await cancelledServer.generate(request)).error.code, 'already-running');
    await cancelledServer.cancel(request.taskId);
    assert.equal((await pending).status, 'cancelled');
    assert(!existsSync(scopes.at(-1).cwd));
    const timed = new FixtureServer(registry); timed.timeoutMs = 100;
    assert.equal((await timed.generate(request)).error.code, 'timeout');
    assert(!existsSync(scopes.at(-1).cwd));

    const forbidden = ['data-poiesis-figure', 'data-poiesis-decision', 'data-poiesis-citation', 'data-poiesis-image',
        'data-poiesis-action', 'poiesis-figure', 'poiesis-decision', 'figcaption', '<details', '主図', '図の部品'];
    async function scan(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await scan(path);
            else if (/results/i.test(entry.name)) {
                let source = await readFile(path, 'utf8');
                // App chrome outside the iframe: preserve the existing move-menu disclosure and image-viewer semantics.
                if (entry.name === 'results-part.tsx') {
                    source = source.replace("<details className='poiesis-results__move-submenu'>", '')
                        .replace('<figcaption>{image.label}</figcaption>', '');
                }
                if (entry.name === 'results.css') {
                    source = source.replace('.poiesis-results__image-viewer figcaption { overflow-wrap: anywhere; }', '');
                }
                for (const marker of forbidden) assert(!source.includes(marker), `${path}: ${marker}`);
            }
        }
    }
    await scan(resolve('agent-window/src'));
    const packaging = await readFile('electron-app/electron-builder.yml', 'utf8');
    assert(packaging.includes('from: ../agent-window/skills/poiesis-results'));
    assert(packaging.includes('from: lib/results-runtime'));
    console.log('RESULTS_SKILL_RUN_TEST=passed');
} finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(root, { recursive: true, force: true });
}

// Exercise the actual sanitizer and opaque frame in Chromium, including script messages and retry limits.
await import('./test-results-rich-content.mjs');
await import('./test-results-runtime-package.mjs');
