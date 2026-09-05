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

const URI = require('@theia/core/lib/common/uri').default;
const { SessionStore, GLOBAL_SESSION_STORAGE_KEY, SESSION_MIGRATION_MARKER_KEY } =
    require('../agent-window/lib/browser/agent-window/session-store.js');
const { ResultsService } = require('../agent-window/lib/browser/results-skill.js');
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

class FakeRequirementService {
    requirements = new Map();
    listeners = [];
    onDidChange = listener => {
        this.listeners.push(listener);
        return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
    };
    async restore(tasks) {
        this.requirements.clear();
        for (const task of tasks) {
            const current = this.requirements.get(task.requirementId);
            if (current) {
                current.taskIds.push(task.id);
            } else {
                this.requirements.set(task.requirementId, {
                    id: task.requirementId,
                    sessionId: task.sessionId,
                    title: task.title,
                    titleSource: 'task',
                    createdAt: task.startedAt,
                    updatedAt: task.endedAt ?? task.startedAt,
                    taskIds: [task.id]
                });
            }
        }
        return this.list();
    }
    get(id) { return this.requirements.get(id); }
    list() { return [...this.requirements.values()]; }
    listForSession(sessionId) { return this.list().filter(requirement => requirement.sessionId === sessionId); }
    currentRequirementId(sessionId) { return this.listForSession(sessionId).at(-1)?.id; }
    setResultsDocument(id, document) {
        const requirement = this.requirements.get(id);
        if (!requirement) return;
        requirement.resultsDocument = document;
        for (const listener of this.listeners) {
            listener({ type: 'document-changed', requirementIds: [id] });
        }
    }
}

const workspaceA = new URI('file:///C:/work/reload-a').toString();
const workspaceB = new URI('file:///C:/work/reload-b').toString();
const generatingDocument = taskId => ({ taskId, status: 'generating' });
const task = ({
    id,
    sessionId,
    requirementId,
    workspaceUri,
    status = 'completed',
    outcomeKind = 'conversation',
    minute,
    completionSummary,
    implementerReport,
    failure,
    resultsDocument
}) => ({
    id,
    sessionId,
    requirementId,
    title: id,
    request: `request-${id}`,
    requirementChoice: 'default',
    workspaceUri,
    providerId: 'codex',
    status,
    startedAt: `2026-09-06T10:${minute}:00.000Z`,
    endedAt: status === 'running' ? undefined : `2026-09-06T10:${minute}:30.000Z`,
    completionSummary,
    implementerReport,
    outcomeKind,
    baseline: { kind: 'workspace-snapshot', capturedAt: `2026-09-06T10:${minute}:00.000Z` },
    changeSet: status === 'running' ? undefined : {
        source: 'empty',
        diff: '',
        files: [],
        capturedAt: `2026-09-06T10:${minute}:30.000Z`
    },
    failure,
    resultsDocument
});

const taskA = task({
    id: 'task-restore-a',
    sessionId: 'session-a',
    requirementId: 'requirement-a',
    workspaceUri: workspaceA,
    outcomeKind: 'result',
    minute: '01',
    completionSummary: '復元された実装結果です。',
    implementerReport: '復元された実装結果です。',
    resultsDocument: generatingDocument('task-restore-a')
});
const taskB = task({
    id: 'task-restore-b',
    sessionId: 'session-b',
    requirementId: 'requirement-b',
    workspaceUri: workspaceB,
    outcomeKind: 'result',
    minute: '02',
    completionSummary: '既存の回答です。',
    implementerReport: '既存の回答です。',
    resultsDocument: generatingDocument('task-restore-b')
});
const failedTask = task({
    id: 'task-failed',
    sessionId: 'session-b',
    requirementId: 'requirement-failed',
    workspaceUri: workspaceB,
    status: 'failed',
    outcomeKind: undefined,
    minute: '03',
    completionSummary: '成功したという誤った記録',
    failure: { summary: '実行に失敗しました。', details: 'injected failure' }
});
const cancelledTask = task({
    id: 'task-cancelled',
    sessionId: 'session-b',
    requirementId: 'requirement-cancelled',
    workspaceUri: workspaceB,
    status: 'cancelled',
    outcomeKind: undefined,
    minute: '04'
});
const interruptedTask = task({
    id: 'task-interrupted',
    sessionId: 'session-b',
    requirementId: 'requirement-interrupted',
    workspaceUri: workspaceB,
    status: 'running',
    outcomeKind: undefined,
    minute: '05',
    completionSummary: '完了したという誤った記録'
});

const initialState = {
    version: 1,
    selectedSessionId: 'session-a',
    railWidth: 258,
    railCollapsed: false,
    sessions: [
        {
            id: 'session-a',
            createdAt: 1,
            updatedAt: 2,
            workspaceUri: workspaceA,
            runTarget: 'local',
            title: '復元する会話 A',
            hasUserMessage: true,
            pinned: false,
            archived: false,
            activeTab: 'agent',
            agentDraft: '',
            messages: [
                { id: 'user-a', role: 'user', content: taskA.request, complete: true, taskId: taskA.id },
                { id: 'agent-a', role: 'agent', content: '', complete: false, taskId: taskA.id }
            ],
            resultsDrafts: [],
            tasks: [taskA]
        },
        {
            id: 'session-b',
            createdAt: 3,
            updatedAt: 4,
            workspaceUri: workspaceB,
            runTarget: 'local',
            title: '復元する会話 B',
            hasUserMessage: true,
            pinned: false,
            archived: false,
            activeTab: 'agent',
            agentDraft: '',
            messages: [
                { id: 'user-b', role: 'user', content: taskB.request, complete: true, taskId: taskB.id },
                { id: 'agent-b', role: 'agent', content: '既存の回答です。', complete: true, taskId: taskB.id },
                { id: 'agent-failed', role: 'agent', content: '', complete: false, taskId: failedTask.id },
                { id: 'agent-cancelled', role: 'agent', content: '', complete: false, taskId: cancelledTask.id },
                { id: 'agent-interrupted', role: 'agent', content: '', complete: false, taskId: interruptedTask.id }
            ],
            resultsDrafts: [],
            tasks: [taskB, failedTask, cancelledTask, interruptedTask]
        }
    ]
};

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const stored = new Map([
    [GLOBAL_SESSION_STORAGE_KEY, clone(initialState)],
    [SESSION_MIGRATION_MARKER_KEY, true]
]);
const durableWrites = [];
const globalStorageService = {
    async getData(key) { return clone(stored.get(key)); },
    async getWorkspaceData() { return []; },
    async setData(key, value) {
        const snapshot = clone(value);
        stored.set(key, snapshot);
        if (key === GLOBAL_SESSION_STORAGE_KEY) durableWrites.push(snapshot);
    }
};
const legacyStorageService = {
    async getData(_key, fallback) { return fallback; },
    async setData() {}
};
const runtimeServer = {
    async captureGitSnapshot() { return { source: 'empty' }; },
    async captureGitChangeSet() { return { source: 'empty', diff: '', files: [] }; },
    async captureGitChangeSetBetween() { return { source: 'empty', diff: '', files: [] }; }
};
const workspaceRoot = { resource: new URI(workspaceA) };
const workspaceService = {
    roots: Promise.resolve([workspaceRoot]),
    tryGetRoots: () => [workspaceRoot],
    workspace: workspaceRoot,
    async open() {}
};
const taskService = new TaskService(runtimeServer, workspaceService, globalStorageService, legacyStorageService);
const requirementService = new FakeRequirementService();
const successGate = deferred();
const rejectionGate = deferred();
const generationCalls = [];
const resultsSkill = {
    async generate(input) {
        generationCalls.push({ taskId: input.task.id, workspaceUri: input.task.workspaceUri });
        if (input.task.id === taskA.id) {
            await successGate.promise;
            return { html: '<html><body><h2>復元後の成果</h2></body></html>', generator: 'ai' };
        }
        await rejectionGate.promise;
        return { html: '<html><body><h2>到達しない成果</h2></body></html>', generator: 'ai' };
    }
};
const workspaceSkillService = { async listPending() { return []; } };
const resultsService = new ResultsService(
    taskService,
    resultsSkill,
    requirementService,
    { async suggestTitle() {}, async classify() {} },
    workspaceSkillService,
    runtimeServer
);
resultsService.init();

const state = {
    railWidth: 258,
    railCollapsed: false,
    resultsTaskRailCollapsed: false,
    resultsSkillNamesLoaded: false,
    agentCli: 'codex',
    agentModel: '',
    agentEffort: '',
    openSessionMenuId: undefined,
    expandedWorkspaceGroups: new Set(),
    providerPreparationErrors: new Map()
};
let store;
const host = {
    node: new ElementStub(),
    isDisposed: false,
    state,
    taskService,
    resultsService,
    requirementService,
    requirementClassificationService: {},
    workspaceService,
    scmService: { findRepository: () => undefined },
    storageService: legacyStorageService,
    globalStorageService,
    messageService: { async error() {} },
    agentProvider: {
        async createSession(input) {
            return { id: 'provider-restored-a', providerName: 'Codex', providerId: 'codex', workspaceUri: input.workspaceUri };
        }
    },
    closeCustomize() {},
    canonicalWorkspaceUri: value => value ? new URI(value).toString() : undefined,
    sameWorkspaceUri: (left, right) => left?.toLocaleLowerCase() === right?.toLocaleLowerCase(),
    workspaceGroupKey: value => value ?? 'workspace:none',
    repositoryLabel: value => value ?? 'ワークスペースなし',
    filteredSessions: archived => store.sessions.filter(session => session.archived === archived),
    clampRailWidth: width => width,
    restoreAgentActivities: () => undefined,
    update() {},
    ensureResultsSkillNames: async () => undefined
};
store = new SessionStore(host);
host.sessions = store;
resultsService.onDidChange(document => store.handleResultsDocumentChanged(document));
requirementService.onDidChange(event => store.handleRequirementChange(event));

const unhandled = [];
const captureUnhandled = reason => unhandled.push(reason);
process.on('unhandledRejection', captureUnhandled);
try {
    const initialization = store.initializeSessions();
    await Promise.race([
        initialization,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Session initialization waited for Results generation.')), 500))
    ]);
    assert.equal(generationCalls.length, 2, 'Both incomplete restored Results must resume in the background.');
    assert.equal(store.sessions.length, 2);
    assert.equal(store.selectedSessionId, 'session-a');
    assert.equal(store.runningTask(), undefined, 'Pending restored Results must not keep the restored session busy.');

    const restoredA = store.sessions.find(session => session.id === 'session-a');
    const recoveredReply = restoredA.messages.find(message => message.id === 'agent-a');
    assert.deepEqual(
        { content: recoveredReply.content, complete: recoveredReply.complete, error: recoveredReply.error },
        { content: '復元された実装結果です。', complete: true, error: undefined },
        'A completed Task must recover its blank incomplete Agent reply from the stored report.'
    );
    const restoredB = store.sessions.find(session => session.id === 'session-b');
    assert.equal(restoredB.messages.filter(message => message.content === '既存の回答です。').length, 1,
        'An existing completed Agent reply must not be duplicated during restoration.');
    const restoredFailure = restoredB.messages.find(message => message.id === 'agent-failed');
    assert.equal(restoredFailure.content, '実行に失敗しました。');
    assert.equal(restoredFailure.complete, true);
    assert.equal(restoredFailure.error, true);
    const restoredCancellation = restoredB.messages.find(message => message.id === 'agent-cancelled');
    assert.equal(restoredCancellation.content, '実行をキャンセルしました。');
    assert.equal(restoredCancellation.complete, true);
    assert.equal(restoredCancellation.error, undefined);
    const restoredInterruption = restoredB.messages.find(message => message.id === 'agent-interrupted');
    assert.equal(restoredInterruption.content, 'アプリ終了により中断されました');
    assert.equal(restoredInterruption.error, true,
        'A genuinely interrupted Task must not be restored as a successful completion.');

    assert(durableWrites.length >= 1, 'The complete restored state must be durably written before generation resumes.');
    assert.equal(durableWrites[0].sessions.length, 2);
    for (const write of durableWrites) {
        assert.deepEqual(write.sessions.map(session => session.id).sort(), ['session-a', 'session-b'],
            'No initialization write may lose a restored Session.');
        assert.equal(write.sessions.flatMap(session => session.tasks ?? []).length, 5,
            'No initialization write may lose restored Tasks.');
        for (const taskId of [taskA.id, taskB.id]) {
            const persistedTask = write.sessions.flatMap(session => session.tasks ?? []).find(candidate => candidate.id === taskId);
            assert(persistedTask?.resultsDocument,
                'No initialization write may drop an incomplete restored Results document.');
        }
    }

    rejectionGate.reject(new Error('injected restored Results rejection'));
    const rejected = await resultsService.whenFinished(taskB.id);
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.error, 'injected restored Results rejection');
    await waitFor(() => resultsService.getRequirement('requirement-b')?.status === 'failed');
    assert.equal(store.selectedSessionId, 'session-a', 'A background Results failure must not make the app unavailable.');

    successGate.resolve();
    const generated = await resultsService.whenFinished(taskA.id);
    assert.equal(generated.status, 'ready');
    await waitFor(() => resultsService.getRequirement('requirement-a')?.status === 'ready');
    await store.windowStatePersistence;
    assert.deepEqual(generationCalls.find(call => call.taskId === taskA.id), {
        taskId: taskA.id,
        workspaceUri: workspaceA
    }, 'Restored generation must retain the original Task workspace.');
    const latest = durableWrites.at(-1);
    const persistedA = latest.sessions.find(session => session.id === 'session-a').tasks
        .find(candidate => candidate.id === taskA.id);
    const persistedB = latest.sessions.find(session => session.id === 'session-b').tasks
        .find(candidate => candidate.id === taskB.id);
    assert.equal(persistedA.resultsDocument.status, 'ready');
    assert.equal(persistedA.resultsDocument.html, '<html><body><h2>復元後の成果</h2></body></html>');
    assert.equal(persistedB.resultsDocument.status, 'failed',
        'A rejected restored generation must persist a retryable Result error.');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(unhandled, [], 'Restored background generation rejection must not be unhandled.');
} finally {
    process.off('unhandledRejection', captureUnhandled);
}

console.log(`SESSION_RESTORE_BACKGROUND_RESULTS_TEST=${JSON.stringify({
    sessionsRestored: store.sessions.length,
    initializationResolvedWhilePending: true,
    recoveredCompletion: true,
    safeDurableWrites: durableWrites.length,
    originalWorkspaceRetained: true,
    rejectedGenerationRetryable: true
})}`);

async function waitFor(predicate) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for restored Results state.');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
