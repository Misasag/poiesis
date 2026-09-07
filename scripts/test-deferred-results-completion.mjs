import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require.extensions['.css'] = () => undefined;

class ElementStub {
    constructor() {
        this.classList = { add() {}, remove() {} };
        this.style = {};
        this.dataset = {};
        this.children = [];
    }
    matches() { return false; }
    setAttribute() {}
    appendChild(child) { this.children.push(child); return child; }
    addEventListener() {}
    removeEventListener() {}
}
for (const name of ['Element', 'HTMLElement', 'DragEvent', 'MouseEvent', 'KeyboardEvent', 'Event', 'CustomEvent', 'FocusEvent']) {
    globalThis[name] = ElementStub;
}
globalThis.document = {
    createElement: () => new ElementStub(),
    body: new ElementStub(),
    documentElement: new ElementStub(),
    addEventListener() {},
    removeEventListener() {},
    queryCommandSupported: () => false
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform: 'Win32', userAgent: 'node' }
});
require('@theia/core/lib/browser/frontend-application-config-provider').FrontendApplicationConfigProvider.set({});

const { CliAgentProvider } = require('../agent-window/lib/browser/cli-agent-provider.js');
const { AiResultsSkill, BundledResultsSkill, ResultsService } = require('../agent-window/lib/browser/results-skill.js');
const { TaskService } = require('../agent-window/lib/browser/task-service.js');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const firstEvidenceGate = deferred();

class FakeRuntimeClient {
    listeners = [];
    onCodexEvent(listener) {
        this.listeners.push(listener);
        return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
    }
    emit(event) {
        for (const listener of this.listeners) listener(event);
    }
}

class FakeRuntimeServer {
    snapshotSequence = 0;
    runRequests = [];
    operations = [];
    async detectClis() {
        return {
            detectedAt: new Date().toISOString(),
            platform: 'win32',
            detections: [{
                id: 'codex',
                name: 'Codex',
                status: 'found',
                path: 'C:\\Tools\\codex.cmd',
                source: 'PATH',
                executableRoles: ['agent', 'results'],
                models: [],
                defaultModel: '',
                checkedLocations: []
            }]
        };
    }
    async captureGitSnapshot({ workspacePath }) {
        const snapshotId = `snapshot-${++this.snapshotSequence}`;
        this.operations.push(`baseline:${snapshotId}:${workspacePath}`);
        return { source: 'git-snapshot', snapshotId };
    }
    async captureGitChangeSet({ baselineSnapshotId }) {
        this.operations.push(`evidence:${baselineSnapshotId}`);
        if (baselineSnapshotId === 'snapshot-1') {
            await firstEvidenceGate.promise;
            return {
                source: 'task-diff',
                diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new',
                files: ['README.md'],
                endSnapshotId: 'end-1'
            };
        }
        return {
            source: 'empty',
            diff: '',
            files: [],
            endSnapshotId: `end-${baselineSnapshotId.slice('snapshot-'.length)}`
        };
    }
    async captureGitChangeSetBetween() {
        return { source: 'empty', diff: '', files: [] };
    }
    async runCodex(request) {
        this.runRequests.push(request);
        this.operations.push(`run:${request.executionId}`);
    }
    async cancelCodex(executionId) {
        this.operations.push(`cancel:${executionId}`);
    }
}

class FakeRequirementService {
    listeners = [];
    onDidChange = listener => {
        this.listeners.push(listener);
        return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
    };
    get() { return undefined; }
    list() { return []; }
    setResultsDocument() {}
}

const runtimeServer = new FakeRuntimeServer();
const runtimeClient = new FakeRuntimeClient();
const workspaceService = { tryGetRoots: () => [], workspace: undefined };
const globalStorageService = { getData: async () => undefined, setData: async () => undefined };
const legacyStorageService = { getData: async () => undefined, setData: async () => undefined };
const taskService = new TaskService(runtimeServer, workspaceService, globalStorageService, legacyStorageService);

const firstPromptGate = deferred();
const firstGenerationGate = deferred();
const rejectedGenerationGate = deferred();
let activeWorkspaceUri = 'file:///C:/work/a';
let resultPromptCalls = 0;
const resultsPromptUris = [];
const workspaceSkillService = {
    async buildPrompt(workspaceUri, role) {
        if (role === 'results') {
            resultsPromptUris.push(workspaceUri);
            resultPromptCalls++;
            if (resultPromptCalls === 1) await firstPromptGate.promise;
        }
        return { content: '', includedSkillIds: [], diagnostics: [], assertions: [] };
    },
    async listPending() { return []; }
};

const generatedHtml = '<!doctype html><html lang="ja"><body><main><h2>変更内容</h2><p>更新しました。</p><a data-poiesis-citation="README.md:1">README.md</a></main></body></html>';
const generationRequests = [];
const generationServer = {
    async generate(request) {
        generationRequests.push(request);
        if (generationRequests.length === 1) {
            await firstGenerationGate.promise;
            return { status: 'generated', html: generatedHtml };
        }
        await rejectedGenerationGate.promise;
        return { status: 'generated', html: generatedHtml };
    },
    async cancel() {}
};
let rejectFallback = false;
const fallbackSkill = {
    async generate() {
        if (rejectFallback) throw new Error('injected fallback failure');
        return { html: generatedHtml, generator: 'fallback' };
    }
};
const assertionServer = { async judge() { throw new Error('No Skill assertions are expected.'); }, async cancel() {} };
const resultsSkill = new AiResultsSkill(
    generationServer,
    fallbackSkill,
    { providerId: 'codex', model: '', effort: '' },
    workspaceSkillService,
    taskService,
    assertionServer
);
const requirementService = new FakeRequirementService();
const resultsService = new ResultsService(
    taskService,
    resultsSkill,
    requirementService,
    { async suggestTitle() {}, async classify() {} },
    workspaceSkillService,
    runtimeServer
);
resultsService.init();

const persistedDocuments = [];
resultsService.onDidChange(document => {
    const taskDocument = taskService.get(document.taskId)?.resultsDocument;
    if (taskDocument) persistedDocuments.push(JSON.parse(JSON.stringify(taskDocument)));
});

const mockProvider = {
    onEvent() { return { dispose() {} }; },
    async createSession() { throw new Error('Mock provider must not be selected.'); },
    async sendMessage() { throw new Error('Mock provider must not be selected.'); },
    async cancel() { throw new Error('Mock provider must not be selected.'); }
};
const provider = new CliAgentProvider(runtimeServer, runtimeClient, mockProvider, taskService, workspaceSkillService);
const agentEvents = [];
provider.onEvent(event => agentEvents.push(event));

const workspaceA = activeWorkspaceUri;
const session = await provider.createSession({ workspaceUri: workspaceA, providerId: 'codex' });
const message = content => ({
    role: 'user',
    content,
    ownerSessionId: 'conversation-a',
    requirementId: 'requirement-a',
    requirementChoice: 'default',
    workspaceUri: workspaceA,
    conversation: []
});

const firstTaskId = await startTurn('最初の実装を行ってください。');
emitAnswer(firstTaskId, '実装を完了しました。\n<!-- poiesis-outcome: result -->');
runtimeClient.emit({ type: 'exit', executionId: firstTaskId, code: 0, signal: null });
await waitFor(() => runtimeServer.operations.includes('evidence:snapshot-1'));
await assert.rejects(
    provider.sendMessage(session.id, message('証拠取得中には開始できないターンです。')),
    /already running/,
    'The provider must retain the run until final change evidence is captured.'
);
assert.equal(runtimeServer.snapshotSequence, 1, 'A rejected overlapping turn must not capture a contaminating baseline.');
assert.equal(hasAgentEvent('task-completed', firstTaskId), false);
firstEvidenceGate.resolve();
await waitFor(() => hasAgentEvent('task-completed', firstTaskId));

assert.equal(agentEvents.find(event => event.type === 'message-delta' && event.taskId === firstTaskId)?.delta, '実装を完了しました。');
assert(hasAgentEvent('message-completed', firstTaskId), 'The final Agent response must complete while Results is pending.');
assert.equal(taskService.get(firstTaskId)?.status, 'completed');
assert.equal(taskService.get(firstTaskId)?.outcomeKind, 'result');
assert.deepEqual(taskService.get(firstTaskId)?.changeSet?.files, ['README.md']);
assert.equal(taskService.isFinalizing(firstTaskId), false, 'Background Results must not keep the composer in a running state.');
const stableFirstEvidence = JSON.stringify(taskService.get(firstTaskId)?.changeSet);

let finalizationFinished = false;
void taskService.whenFinalized(firstTaskId).then(() => { finalizationFinished = true; });
let resultsFinished = false;
void resultsService.whenFinished(firstTaskId).then(() => { resultsFinished = true; });
await Promise.resolve();
assert.equal(finalizationFinished, false, 'Explicit finalization waits must still observe pending Results work.');
assert.equal(resultsFinished, false, 'Explicit Results waits must retain their background-generation semantics.');

const secondTaskId = await startTurn('先ほどの内容を確認しました。');
emitAnswer(secondTaskId, '承知しました。\n<!-- poiesis-outcome: conversation -->');
runtimeClient.emit({ type: 'exit', executionId: secondTaskId, code: 0, signal: null });
await waitFor(() => hasAgentEvent('task-completed', secondTaskId));
assert.equal(taskService.get(secondTaskId)?.status, 'completed', 'A second turn must proceed before prior Results settles.');
assert.equal(JSON.stringify(taskService.get(firstTaskId)?.changeSet), stableFirstEvidence,
    'A later turn must not contaminate finalized change evidence.');
assert(runtimeServer.operations.indexOf('evidence:snapshot-1') < runtimeServer.operations.findIndex(value => value.startsWith('baseline:snapshot-2:')),
    'The next baseline must be captured only after the prior change evidence is complete.');

const failedTaskId = await startTurn('失敗経路を確認します。');
runtimeClient.emit({ type: 'exit', executionId: failedTaskId, code: 2, signal: null });
await waitFor(() => hasAgentEvent('task-failed', failedTaskId));
assert(hasAgentEvent('message-completed', failedTaskId), 'A failed run must complete its Agent response while older Results is pending.');

const cancelledTaskId = await startTurn('キャンセル経路を確認します。');
await provider.cancel(session.id);
await waitFor(() => hasAgentEvent('task-cancelled', cancelledTaskId));
assert.equal(taskService.get(cancelledTaskId)?.status, 'cancelled',
    'A cancelled run must become ready while older Results is pending.');

activeWorkspaceUri = 'file:///C:/work/b';
await provider.createSession({ workspaceUri: activeWorkspaceUri, providerId: 'codex' });
firstPromptGate.resolve();
await waitFor(() => generationRequests.length === 1);
assert.equal(resultsPromptUris[0], workspaceA);
assert.equal(generationRequests[0].workspaceUri, workspaceA,
    'Delayed Results must retain the workspace captured by their Task after the active workspace switches.');
assert.equal(finalizationFinished, false);

firstGenerationGate.resolve();
const firstDocument = await resultsService.whenFinished(firstTaskId);
assert.equal(firstDocument?.status, 'ready');
assert(firstDocument?.html?.includes('更新しました。'));
assert.equal(finalizationFinished, true);
assert.equal(resultsFinished, true);
assert(persistedDocuments.some(document => document.taskId === firstTaskId && document.status === 'ready'),
    'The settled Result must emit its task-attached document for event-driven persistence.');

const rejectedTaskId = await startTurn('ファイルを変更せず設計を確定してください。');
emitAnswer(rejectedTaskId, '設計を確定しました。\n<!-- poiesis-outcome: result -->');
runtimeClient.emit({ type: 'exit', executionId: rejectedTaskId, code: 0, signal: null });
await waitFor(() => hasAgentEvent('task-completed', rejectedTaskId));
await waitFor(() => generationRequests.length === 2);
rejectFallback = true;
rejectedGenerationGate.reject(new Error('injected Results rejection'));
const rejectedDocument = await resultsService.whenFinished(rejectedTaskId);
assert.equal(rejectedDocument?.status, 'failed');
assert.equal(rejectedDocument?.error, 'injected fallback failure');
assert(hasAgentEvent('message-completed', rejectedTaskId),
    'A rejected background Results update must not retract the completed Agent response.');

const unavailableReason = '変更の記録が時間内に完了しませんでした。';
taskService.get(rejectedTaskId).changeSet.error = unavailableReason;
const unavailableAggregate = await resultsService.cumulativeChangeSet({
    id: 'requirement-unavailable',
    title: '記録できない変更',
    taskIds: [rejectedTaskId]
});
assert.equal(unavailableAggregate.error, unavailableReason,
    'Requirement Results aggregation must preserve the unavailable capture reason.');
const bundledResults = new BundledResultsSkill();
const unavailableDocument = await bundledResults.generate({
    task: taskService.get(rejectedTaskId),
    changeSet: unavailableAggregate
});
assert.match(unavailableDocument.html, /変更ファイルを確認できませんでした。/);
assert.doesNotMatch(unavailableDocument.html, /変更ファイルはありません。/,
    'Unavailable capture must not be presented as a verified zero-change result.');
const verifiedZeroDocument = await bundledResults.generate({
    task: taskService.get(rejectedTaskId),
    changeSet: { source: 'empty', diff: '', files: [], capturedAt: new Date().toISOString() }
});
assert.match(verifiedZeroDocument.html, /変更ファイルはありません。/,
    'A successfully captured zero-change result must retain its existing presentation.');

const preparationBehavior = await verifyPreparationCancellationAndFailure();

console.log(`DEFERRED_RESULTS_COMPLETION_TEST=${JSON.stringify({
    agentCompletedBeforeResults: true,
    secondTurnBeforeResults: true,
    stableEvidence: true,
    terminalPathsReady: ['completed', 'failed', 'cancelled'],
    taskWorkspaceRetained: generationRequests[0].workspaceUri,
    resultPersisted: true,
    rejectedBackgroundHandled: true,
    unavailableReasonPreserved: true,
    verifiedZeroChangesUnchanged: true,
    preparationBehavior
})}`);

async function verifyPreparationCancellationAndFailure() {
    const baselineRelease = deferred();
    const baselineStarted = deferred();
    const baselineFinished = deferred();
    const cancellationRuntime = new FakeRuntimeServer();
    cancellationRuntime.captureGitSnapshot = async ({ taskId }) => {
        cancellationRuntime.operations.push(`baseline-start:${taskId}`);
        baselineStarted.resolve();
        await baselineRelease.promise;
        cancellationRuntime.operations.push(`baseline-finished:${taskId}`);
        baselineFinished.resolve();
        return { source: 'empty', error: '変更の記録をキャンセルしました。' };
    };
    cancellationRuntime.captureGitChangeSet = async () => {
        cancellationRuntime.operations.push('unexpected-post-capture');
        return { source: 'empty', diff: '', files: [] };
    };
    cancellationRuntime.cancelCodex = async executionId => {
        cancellationRuntime.operations.push(`cancel:${executionId}`);
        baselineRelease.resolve();
        await baselineFinished.promise;
    };
    const cancelled = await preparationProvider(cancellationRuntime, 'cancel');
    const sendPromise = cancelled.provider.sendMessage(cancelled.session.id, cancelled.message('準備中に停止します。'));
    await baselineStarted.promise;
    const taskId = cancelled.events.find(event => event.type === 'task-started')?.taskId;
    assert(taskId);
    await cancelled.provider.cancel(cancelled.session.id);
    await sendPromise;
    assert.equal(cancellationRuntime.runRequests.length, 0,
        'Cancelling preparation must prevent the Agent process from launching.');
    assert.equal(cancellationRuntime.operations.includes('unexpected-post-capture'), false,
        'Cancelling preparation must not start a post-task snapshot.');
    assert.equal(cancelled.taskService.get(taskId)?.status, 'cancelled');

    const launchStarted = deferred();
    const launchAcknowledged = deferred();
    const stopFinished = deferred();
    const startupRuntime = new FakeRuntimeServer();
    startupRuntime.runCodex = async request => {
        startupRuntime.runRequests.push(request);
        launchStarted.resolve();
        await launchAcknowledged.promise;
    };
    startupRuntime.cancelCodex = async () => { await stopFinished.promise; };
    startupRuntime.captureGitChangeSet = async () => {
        startupRuntime.operations.push('startup-change-captured');
        return { source: 'task-diff', diff: 'startup change', files: ['startup.txt'] };
    };
    const startup = await preparationProvider(startupRuntime, 'startup-race');
    const startupSend = startup.provider.sendMessage(
        startup.session.id,
        startup.message('起動応答待ちのキャンセルを確認します。')
    );
    await launchStarted.promise;
    const startupTaskId = startup.events.find(event => event.type === 'task-started')?.taskId;
    assert(startupTaskId);
    const startupCancel = startup.provider.cancel(startup.session.id);
    launchAcknowledged.resolve();
    await startupSend;
    assert.equal(startup.provider.runs.get(startup.session.id)?.state, 'cancelling',
        'A launch acknowledgement must not undo pending cancellation.');
    assert.equal(startup.events.some(event => event.type === 'progress' && event.progress.phase === 'waiting'), false,
        'A launch acknowledgement must not emit a waiting phase during cancellation.');
    stopFinished.resolve();
    await startupCancel;
    assert.equal(startupRuntime.operations.includes('startup-change-captured'), true,
        'Cancellation after baseline capture must preserve changes made during process startup.');
    assert.deepEqual(startup.taskService.get(startupTaskId)?.changeSet?.files, ['startup.txt']);

    let cleanupFinished = false;
    const failedRuntime = new FakeRuntimeServer();
    failedRuntime.captureGitSnapshot = async () => {
        await Promise.resolve();
        cleanupFinished = true;
        return { source: 'empty', error: '変更の記録が時間内に完了しませんでした。' };
    };
    failedRuntime.runCodex = async request => {
        assert.equal(cleanupFinished, true,
            'The Agent may start after failed capture only when subprocess cleanup has finished.');
        failedRuntime.runRequests.push(request);
    };
    const failed = await preparationProvider(failedRuntime, 'failed');
    await failed.provider.sendMessage(failed.session.id, failed.message('記録失敗後に開始します。'));
    assert.equal(failedRuntime.runRequests.length, 1);
    const phases = failed.events
        .filter(event => event.type === 'progress')
        .map(event => event.progress.phase);
    assert.deepEqual(phases.slice(0, 2), ['preparing', 'starting'],
        'Preparation and Agent startup must be reported as distinct phases.');

    const blockedRuntime = new FakeRuntimeServer();
    blockedRuntime.captureGitSnapshot = async () => ({
        source: 'empty',
        error: '変更の記録を安全に停止できなかったため、Agent を開始しませんでした。',
        blocksAgentStart: true
    });
    const blocked = await preparationProvider(blockedRuntime, 'blocked');
    await blocked.provider.sendMessage(blocked.session.id, blocked.message('安全に停止できない場合は開始しません。'));
    const blockedTaskId = blocked.events.find(event => event.type === 'task-started')?.taskId;
    assert(blockedTaskId);
    assert.equal(blockedRuntime.runRequests.length, 0,
        'Unconfirmed capture cleanup must block Agent launch.');
    assert.equal(blocked.taskService.get(blockedTaskId)?.status, 'failed');
    return {
        cancellationPreventedAgentLaunch: true,
        cancellationPreventedPostCapture: true,
        launchAcknowledgementKeptCancelling: true,
        startupChangesCaptured: true,
        failureWaitedForCleanup: true,
        unconfirmedCleanupBlockedAgentLaunch: true,
        phases: phases.slice(0, 2)
    };
}

async function preparationProvider(runtimeServer, suffix) {
    const runtimeClient = new FakeRuntimeClient();
    const taskService = new TaskService(
        runtimeServer,
        workspaceService,
        globalStorageService,
        legacyStorageService
    );
    const workspaceSkillService = {
        async buildPrompt() { return { content: '', includedSkillIds: [], diagnostics: [], assertions: [] }; }
    };
    const provider = new CliAgentProvider(runtimeServer, runtimeClient, mockProvider, taskService, workspaceSkillService);
    const events = [];
    provider.onEvent(event => events.push(event));
    const workspaceUri = `file:///C:/work/${suffix}`;
    const session = await provider.createSession({ workspaceUri, providerId: 'codex' });
    return {
        provider,
        session,
        taskService,
        events,
        message: content => ({
            role: 'user',
            content,
            ownerSessionId: `conversation-${suffix}`,
            requirementId: `requirement-${suffix}`,
            requirementChoice: 'default',
            workspaceUri,
            conversation: []
        })
    };
}

async function startTurn(content) {
    const before = agentEvents.filter(event => event.type === 'task-started').length;
    await provider.sendMessage(session.id, message(content));
    const started = agentEvents.filter(event => event.type === 'task-started');
    assert.equal(started.length, before + 1);
    return started.at(-1).taskId;
}

function emitAnswer(taskId, text) {
    runtimeClient.emit({
        type: 'output',
        executionId: taskId,
        stream: 'stdout',
        delta: `${JSON.stringify({
            type: 'item.completed',
            item: { id: `message-${taskId}`, type: 'agent_message', text }
        })}\n`
    });
}

function hasAgentEvent(type, taskId) {
    return agentEvents.some(event => event.type === type && event.taskId === taskId);
}

async function waitFor(predicate) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for deferred Results behavior.');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
