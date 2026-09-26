import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
require.extensions['.css'] = () => {};
class ElementStub {
    classList = { add() {}, remove() {} }; style = {}; dataset = {}; children = [];
    matches() { return false; } setAttribute() {} appendChild(child) { this.children.push(child); return child; }
    addEventListener() {} removeEventListener() {}
}
for (const name of ['Element', 'HTMLElement', 'DragEvent', 'MouseEvent', 'KeyboardEvent', 'Event', 'CustomEvent', 'FocusEvent']) globalThis[name] = ElementStub;
globalThis.document = { createElement: () => new ElementStub(), body: new ElementStub(), documentElement: new ElementStub(), addEventListener() {}, removeEventListener() {}, queryCommandSupported: () => false };
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'Win32', userAgent: 'node' } });
require('@theia/core/lib/browser/frontend-application-config-provider').FrontendApplicationConfigProvider.set({});
const { HooksServerImpl, parseHooks, resolveHookCommand } = require('../agent-window/lib/node/hooks-server.js');
const { hookContext, emptyHookResult } = require('../agent-window/lib/common/hooks-protocol.js');
const { buildAgentExecutionPrompt } = require('../agent-window/lib/common/agent-prompt.js');
const { TaskService } = require('../agent-window/lib/browser/task-service.js');
const { CliAgentProvider } = require('../agent-window/lib/browser/cli-agent-provider.js');
const { AgentPart } = require('../agent-window/lib/browser/agent-window/agent-part.js');
const { CustomizePart } = require('../agent-window/lib/browser/agent-window/customize-part.js');
const { tasksForDurableSession } = require('../agent-window/lib/common/session-persistence.js');
const { renderToStaticMarkup } = require('react-dom/server');
const root = await mkdtemp(join(tmpdir(), 'poiesis-hooks-'));
const home = join(root, 'home'); const workspace = join(root, 'workspace'); const other = join(root, 'other');
const fixture = resolve('scripts/fixtures/hook.mjs');
const definition = (id, mode = 'context', policy = 'advisory', extra = []) => ({ id, command: [process.execPath, fixture, mode, ...extra], timeoutMs: 10000, policy, enabled: true });
const input = event => ({ schemaVersion: 1, event, workspace, sessionId: 'session', taskId: 'task', requirementId: 'requirement', runId: 'run', providerId: 'codex', model: 'model', data: { prompt: 'hello' } });
const config = async (where, hooks) => writeFile(join(where, '.poiesis/hooks.json'), JSON.stringify({ version: 1, hooks }), 'utf8');
try {
    for (const dir of [home, workspace, other]) await mkdir(join(dir, '.poiesis'), { recursive: true });
    const server = new HooksServerImpl(home);
    await config(home, { taskEnd: [definition('versions', 'versioned-evidence')] });
    const versionInput = { ...input('taskEnd'), data: { changeSetHash: 'sha256:current' } };
    const versioned = await server.run(versionInput);
    assert.deepEqual(versioned.evidence[0].evidence.map(row => row.status), ['pass', 'fail', 'pass', 'human']);
    assert.equal(versioned.evidence[0].evidence[0].changeSetHash, 'sha256:current');
    assert.equal(versioned.evidence[0].evidence[0].capturedAt, '2026-09-24T00:00:00Z');
    assert.equal(versioned.evidence[0].evidence[1].runId, 'run');
    assert.ok(versioned.evidence[0].evidence[1].capturedAt);
    for (const mode of ['bad-evidence-version', 'bad-human']) {
        await config(home, { taskEnd: [definition('bad', mode, 'required')] });
        assert.equal((await server.run(versionInput)).evidence[0].incomplete, true);
    }
    assert.throws(() => parseHooks('{"version":2,"hooks":{}}', 'user'));
    assert.throws(() => parseHooks(JSON.stringify({ version: 1, hooks: { gateDecision: [] } }), 'user'));
    assert.throws(() => parseHooks(JSON.stringify({ version: 1, hooks: { taskStart: [definition('a'), definition('a')] } }), 'user'));
    assert.throws(() => parseHooks(JSON.stringify({ version: 1, hooks: { taskStart: [{ ...definition('a'), command: 'node foo' }] } }), 'user'));
    assert.equal(parseHooks('\uFEFF{"version":1,"hooks":{}}', 'user').length, 0);
    await config(home, { taskStart: [definition('same')] });
    await config(workspace, { taskStart: [definition('same')] });
    assert.equal((await server.list(workspace)).rows.length, 2);
    assert.equal((await server.run(input('taskStart'))).runs.length, 1, 'Cloned workspace hooks must not run');
    await server.setWorkspaceEnabled(workspace, true);
    assert.deepEqual((await server.run(input('taskStart'))).runs.map(run => run.scope), ['user', 'workspace']);
    assert.equal((await new HooksServerImpl(home).list(workspace)).workspaceEnabled, true);
    assert.equal((await server.list(other)).workspaceEnabled, false);
    await server.setEnabled(workspace, 'workspace', 'taskStart', 'same', false);
    assert.equal((await server.run(input('taskStart'))).runs.length, 1);
    await server.setWorkspaceEnabled(workspace, false);
    await writeFile(join(workspace, '.poiesis/hooks.json'), 'bad config', 'utf8');
    assert.equal((await server.run(input('taskStart'))).blockReason, undefined, 'Untrusted malformed workspace config cannot block user hooks');
    const invocation = await resolveHookCommand(['node', fixture, 'context', 'space & | literal']);
    assert.equal(invocation.args.at(-1), 'space & | literal');
    await assert.rejects(resolveHookCommand(['test.cmd']));
    await assert.rejects(resolveHookCommand(['test.bat']));
    await assert.rejects(resolveHookCommand(['./relative.exe']));
    for (const policy of ['advisory', 'required']) {
        for (const mode of ['invalid', 'exit', 'timeout']) {
            for (const event of ['promptSubmit', 'taskStart', 'taskEnd']) {
                await config(home, { [event]: [{ ...definition('broken', mode, policy), timeoutMs: mode === 'timeout' ? 150 : 10000 }] });
                const result = await server.run(input(event));
                assert.equal(result.runs[0].status, 'fail');
                assert.equal(Boolean(result.blockReason), policy === 'required' && event !== 'taskEnd');
                assert.equal(result.evidence.some(item => item.incomplete), policy === 'required' && event === 'taskEnd');
                assert.ok(result.runs[0].stdinBytes > 0);
            }
        }
    }
    const pidFile = join(root, 'child.pid');
    await config(home, { taskStart: [{ ...definition('tree', 'timeout', 'advisory', [pidFile]), timeoutMs: 1500 }] });
    await server.run(input('taskStart'));
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), 'Timeout must terminate descendants');
    for (const policy of ['advisory', 'required']) {
        await config(home, { promptSubmit: [definition('gate', 'block', policy)] });
        assert.equal(Boolean((await server.run(input('promptSubmit'))).blockReason), policy === 'required');
    }
    const context = hookContext([{ ...emptyHookResult(), contexts: [{ id: 'first', content: 'A'.repeat(9000) }, { id: 'second', content: 'B'.repeat(9000) }, { id: 'third', content: 'C' }] }]);
    assert.equal((context.match(/A/g) ?? []).length, 8000); assert.equal((context.match(/B/g) ?? []).length, 8000);
    assert.ok(!context.includes('third'));
    const prompt = buildAgentExecutionPrompt('request', [{ role: 'user', content: 'history' }], '', context);
    assert.ok(prompt.includes('Edit files with your file-editing tool (for example apply_patch).'));
    assert.ok(prompt.includes('git checkout, git restore, git reset, git stash or git show'));
    assert.ok(prompt.startsWith('## Harness context (hooks)')); assert.ok(prompt.indexOf('first') < prompt.indexOf('second'));
    assert.ok(prompt.indexOf('second') < prompt.indexOf('## Conversation context'));
    await config(workspace, {});
    await config(home, { promptSubmit: [definition('submit')], taskStart: [definition('start')], sessionResume: [definition('resume')], taskEnd: [definition('verify', 'evidence')] });
    const storage = { async getData() {}, async setData() {} };
    const spawned = [];
    const runtime = {
        async captureGitSnapshot() { return { source: 'git-snapshot', snapshotId: 'a'.repeat(40) }; },
        async captureGitChangeSet() { return { source: 'task-diff', diff: 'diff --git a/a b/a\n+x', files: ['a'] }; },
        async runCodex(request) { spawned.push(request); }
    };
    const tasks = new TaskService(runtime, { tryGetRoots: () => [] }, storage, storage, server);
    const provider = new CliAgentProvider(runtime, { onCodexEvent() {} }, { onEvent() {} }, tasks,
        { async buildPrompt() { return { content: '', includedSkillIds: [], catalogSkills: [], diagnostics: [] }; } });
    const workspaceUri = pathToFileURL(workspace).href;
    provider.sessions.set('cli', { id: 'cli', providerId: 'codex', providerName: 'Codex', workspaceUri, workspacePath: workspace });
    await provider.sendMessage('cli', { content: 'hello', ownerSessionId: 'session', requirementId: 'requirement', workspaceUri, conversation: [{ role: 'user', content: 'history' }], resumeHooks: true });
    assert.equal(spawned.length, 1);
    const actual = spawned[0].prompt;
    assert.ok(actual.startsWith('## Harness context (hooks)'));
    assert.ok(actual.indexOf('### submit') < actual.indexOf('### start'));
    assert.ok(actual.indexOf('### start') < actual.indexOf('### resume'));
    assert.ok(actual.indexOf('### resume') < actual.indexOf('## Conversation context'));
    const taskId = tasks.list()[0].id;
    await tasks.end(taskId, 'finished', 'result');
    const saved = JSON.parse(JSON.stringify(tasksForDurableSession(tasks.list())));
    const restored = new TaskService(runtime, { tryGetRoots: () => [] }, storage, storage, server).restore(saved)[0];
    assert.equal(restored.hookEvidence[0].evidence[0].detail, taskId);
    assert.equal(restored.hookEvidence[0].evidence[0].image, 'evidence/after.png');
    assert.equal(restored.hookRuns.length, 4);
    assert.equal(restored.changeSet.files[0], 'a');
    await config(home, { taskStart: [definition('stop-before-spawn', 'exit', 'required')], taskEnd: [definition('unfinished', 'exit', 'required')] });
    provider.runs.clear();
    await provider.sendMessage('cli', { content: 'blocked', ownerSessionId: 'session', requirementId: 'requirement', workspaceUri });
    assert.equal(spawned.length, 1);
    assert.ok(tasks.list().at(-1).hookEvidence.some(item => item.incomplete));
    assert.equal(tasks.list().at(-1).status, 'failed');
    const session = { id: 'session', agentDraft: 'keep this', workspaceUri, messages: [] };
    const warnings = [];
    const host = { taskService: tasks, state: { agentCli: 'codex', agentModel: '' }, sessions: { sessions: [session] }, messageService: { warn: value => warnings.push(value) } };
    const agent = new AgentPart(host);
    agent.requirementForSend = () => ({ requirementId: 'requirement', requirementChoice: 'default' });
    await config(home, { promptSubmit: [definition('hold', 'block', 'required')] });
    const count = tasks.list().length;
    await agent.sendPreparedAgentMessage(session, session.agentDraft);
    assert.equal(session.agentDraft, 'keep this'); assert.equal(session.messages.length, 0); assert.equal(tasks.list().length, count); assert.ok(warnings[0].includes('hold'));
    const view = new CustomizePart({ taskService: tasks, sessions: { workspaceRoot: () => undefined } });
    view.hooksConfiguration = await server.list(workspace);
    const html = renderToStaticMarkup(view.renderHooksPanel());
    assert.ok(html.includes('このワークスペースで有効にする')); assert.ok(html.includes('未実行') || html.includes('成功'));
    console.log('HOOKS_TEST=passed config trust argv policies timeout-tree injection persistence composer ui');
} finally { await rm(root, { recursive: true, force: true }); }
