import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { spawnHiddenCli } = require('../agent-window/lib/node/hidden-process.js');
const input = 'x'.repeat(80_000);
const child = spawnHiddenCli('codex', process.execPath, [
    '-e',
    "let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>value+=chunk);process.stdin.on('end',()=>process.stdout.write(String(value.length)))"
], { input });

let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk.toString(); });
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', resolveExit);
});

assert.equal(exitCode, 0, stderr);
assert.equal(stdout, String(input.length));
assert.ok(child.spawnargs.every(argument => argument.length < 1_000), 'The Results prompt leaked into process arguments.');
console.log('RESULTS_PROMPT_TRANSPORT_TEST={"inputChars":80000,"transport":"stdin","argvBounded":true}');

const { readChildUtf8 } = require('../agent-window/lib/node/child-utf8.js');
const { ResultsGenerationServerImpl } = require('../agent-window/lib/node/results-generation-server.js');
const { ResultsAssertionServerImpl } = require('../agent-window/lib/node/results-assertion-server.js');
const { RequirementClassificationServerImpl } = require('../agent-window/lib/node/requirement-classification-server.js');
const { ResultsQuestionServerImpl, RESULTS_QUESTION_TIMEOUT_MS, RESULTS_QUESTION_OUTPUT_MAX_CHARS } = require('../agent-window/lib/node/results-question-server.js');
const { AgentRuntimeServerImpl } = require('../agent-window/lib/node/agent-runtime-server.js');

function fakeChild() {
    const process = new EventEmitter();
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    process.kill = () => { queueMicrotask(() => process.emit('close', null, 'SIGTERM')); return true; };
    return process;
}

// Interleaved streams must keep independent decoder state, including the close flush.
const utf8Child = fakeChild();
let decodedOut = '', decodedErr = '';
readChildUtf8(utf8Child, text => decodedOut += text, text => decodedErr += text);
const japanese = Buffer.from('日本語の最終回答です。', 'utf8');
utf8Child.stdout.emit('data', japanese.subarray(0, 1));
utf8Child.stderr.emit('data', japanese.subarray(0, 2));
utf8Child.stdout.emit('data', japanese.subarray(1));
utf8Child.stderr.emit('data', japanese.subarray(2));
utf8Child.emit('close', 0, null);
assert.equal(decodedOut, '日本語の最終回答です。');
assert.equal(decodedErr, decodedOut);
const incomplete = fakeChild();
let flushed = '';
readChildUtf8(incomplete, text => flushed += text, () => {});
incomplete.stdout.emit('data', japanese.subarray(0, 1));
incomplete.emit('close', 0, null);
assert.equal(flushed, '\uFFFD', 'Only an actually incomplete final code point is replaced on close.');

const workspace = mkdtempSync(join(tmpdir(), 'poiesis-transport-test-'));
const workspaceUri = pathToFileURL(workspace).href;
const body = '日本語の最終回答です。';
const wireOutput = providerId => providerId === 'codex' ? [
    { type: 'item.completed', item: { type: 'agent_message', text: body } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 12 } }
].map(event => JSON.stringify(event)).join('\n') : providerId === 'claude'
    ? JSON.stringify({ type: 'result', result: body, usage: { input_tokens: 20, output_tokens: 12 }, total_cost_usd: 0.02 })
    : body;
const registry = { async resolve(_role, providerId, model) { return { id: providerId, name: providerId, path: 'fake.exe', model }; } };
const scope = {
    taskId: 'transport-test', workspaceUri, providerId: 'codex', model: 'explicit-model', effort: 'medium',
    taskMetadata: { status: 'completed', request: '確認してください。' },
    changeSetSummary: '変更'.repeat(15_000), diff: '差分'.repeat(40_000), resultsHtml: '<html>' + '成果'.repeat(60_000) + '</html>',
    documentText: '文書', assertions: ['説明がある'], currentRequirementTitle: '要件', previousTasks: [],
    task: { request: '確認', changedFiles: [] }, request: '確認', changedFiles: []
};

function instrument(server, providerId, output = wireOutput(providerId), stall = false) {
    server.resolveWorkspace = async () => workspace;
    const prompts = [];
    const children = [];
    server.spawnCli = (id, _command, args, cwd, stdin) => {
        assert.equal(id, providerId);
        assert.equal(cwd, workspace);
        assert(args.every(argument => argument.length <= 1_000), 'Agent and one-shot argv must stay bounded.');
        if (id === 'grok') {
            assert.equal(stdin, undefined);
            const file = args[args.indexOf('--prompt-file') + 1];
            assert(readFileSync(file, 'utf8').length > 0);
            prompts.push(file);
        } else {
            assert.equal(typeof stdin, 'string');
            assert(stdin.includes('確認') || stdin.includes('依頼'));
        }
        const child = fakeChild();
        children.push(child);
        if (!stall) setImmediate(() => {
            const bytes = Buffer.from(output, 'utf8');
            const split = bytes.indexOf(Buffer.from('日本語')) + 1;
            child.stdout.emit('data', bytes.subarray(0, split));
            child.stdout.emit('data', bytes.subarray(split));
            child.emit('close', 0, null);
        });
        return child;
    };
    return { prompts, children };
}

try {
    for (const providerId of ['codex', 'claude', 'grok']) {
        for (const [Server, method, purpose, status, field] of [
            [ResultsGenerationServerImpl, 'generate', 'results-generation', 'generated', 'html'],
            [ResultsAssertionServerImpl, 'judge', 'results-judge', 'judged', 'output'],
            [RequirementClassificationServerImpl, 'classify', 'requirement-classification', 'classified', 'output'],
            [RequirementClassificationServerImpl, 'suggestTitle', 'requirement-title', 'suggested', 'output'],
            [ResultsQuestionServerImpl, 'ask', 'results-question', 'answered', 'answer']
        ]) {
            const server = new Server(registry);
            const probe = instrument(server, providerId);
            const request = { ...scope, providerId };
            const result = await (method === 'ask' ? server.ask('確認してください。', request) : server[method](request));
            assert.equal(result.status, status, JSON.stringify(result));
            assert.equal(result[field], body);
            assert.equal(result.call.purpose, purpose);
            assert.equal(result.call.providerId, providerId);
            assert.equal(result.call.model, 'explicit-model');
            assert.equal(result.call.effort, 'medium');
            assert.equal(result.call.exitCode, 0);
            assert(result.call.durationMs >= 0);
            assert.equal(result.call.taskMetadata, undefined, 'Prompts must never leak into call records.');
            assert.equal(result.call.usage?.outputTokens, providerId === 'grok' ? undefined : 12);
            await new Promise(resolve => setTimeout(resolve, 15));
            for (const file of probe.prompts) assert(!existsSync(file), 'Prompt files must be cleaned up.');
        }
        const runtime = new AgentRuntimeServerImpl({}, registry, {});
        const probe = instrument(runtime, providerId);
        const events = [];
        const exited = new Promise(resolve => runtime.setClient({ notifyCodexEvent(event) {
            events.push(event);
            if (event.type === 'exit') resolve();
        } }));
        await runtime.runCodex({ executionId: 'agent-transport', providerId, workspacePath: workspace, prompt: '長い依頼'.repeat(30_000) });
        await exited;
        assert.equal(events.filter(event => event.type === 'output').map(event => event.delta).join(''), wireOutput(providerId));
        await new Promise(resolve => setTimeout(resolve, 15));
        for (const file of probe.prompts) assert(!existsSync(file));
        runtime.dispose();
    }

    // Two jobs for one task must be distinct while each duplicate job is still rejected.
    const concurrent = new RequirementClassificationServerImpl(registry);
    const probe = instrument(concurrent, 'claude', wireOutput('claude'), true);
    const request = { ...scope, providerId: 'claude' };
    const classification = concurrent.classify(request);
    const title = concurrent.suggestTitle(request);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probe.children.length, 2);
    assert.equal((await concurrent.classify(request)).error.code, 'already-running');
    assert.equal((await concurrent.suggestTitle(request)).error.code, 'already-running');
    for (const child of probe.children) {
        child.stdout.emit('data', Buffer.from(wireOutput('claude')));
        child.emit('close', 0, null);
    }
    assert.equal((await classification).status, 'classified');
    assert.equal((await title).status, 'suggested');
    assert.equal(concurrent.runs.size, 0);
    assert.equal(concurrent.pendingRuns.size, 0);

    assert.equal(RESULTS_QUESTION_TIMEOUT_MS, 180_000);
    const timed = new ResultsQuestionServerImpl(registry);
    instrument(timed, 'claude', '', true);
    timed.timeoutMs = 10;
    const timeoutResult = await timed.ask('確認', { ...scope, providerId: 'claude' });
    assert.equal(timeoutResult.error.code, 'timeout');
    assert.match(timeoutResult.error.message, /時間内に完了しませんでした/);
    assert.equal(timeoutResult.call.purpose, 'results-question');

    const capped = new ResultsQuestionServerImpl(registry);
    instrument(capped, 'claude', 'x'.repeat(RESULTS_QUESTION_OUTPUT_MAX_CHARS + 10));
    assert.equal((await capped.ask('確認', { ...scope, providerId: 'claude' })).error.code, 'too-large');

    const cancelled = new ResultsQuestionServerImpl(registry);
    const cancelProbe = instrument(cancelled, 'grok', '', true);
    const answer = cancelled.ask('確認', { ...scope, providerId: 'grok' });
    while (!cancelProbe.children.length) await new Promise(resolve => setTimeout(resolve, 5));
    await cancelled.cancel(scope.taskId);
    assert.equal((await answer).status, 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 15));
    for (const file of cancelProbe.prompts) assert(!existsSync(file));
} finally {
    rmSync(workspace, { recursive: true, force: true });
}
console.log('CLI_TRANSPORT_TEST=passed');
