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

const { ResultsService } = require('../agent-window/lib/browser/results-skill.js');
const { RequirementClassificationService } = require('../agent-window/lib/browser/requirement-classification-service.js');
const { RequirementService } = require('../agent-window/lib/browser/requirement-service.js');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

class FakeTaskService {
    tasks = new Map();
    listeners = [];
    finalizers = [];
    onDidChangeTask = listener => { this.listeners.push(listener); return { dispose() {} }; };
    registerTerminalFinalizer(finalizer) { this.finalizers.push(finalizer); return { dispose() {} }; }
    get(id) { return this.tasks.get(id); }
    list() { return [...this.tasks.values()]; }
    setResultsDocument(id, document) {
        const task = this.tasks.get(id);
        if (task) task.resultsDocument = document;
    }
    setSkillProposals() {}
    setRequirementId(id, requirementId) {
        const value = { ...this.tasks.get(id), requirementId };
        this.tasks.set(id, value);
        return value;
    }
    setRequirementClassification(id, requirementClassification) {
        const value = { ...this.tasks.get(id), requirementClassification };
        this.tasks.set(id, value);
        return value;
    }
    emit(event) { for (const listener of this.listeners) listener(event); }
}

class FakeRequirementService {
    requirements = new Map();
    listeners = [];
    onDidChange = listener => { this.listeners.push(listener); return { dispose() {} }; };
    get(id) { return this.requirements.get(id); }
    list() { return [...this.requirements.values()]; }
    setResultsDocument(id, document) {
        const requirement = this.requirements.get(id);
        if (requirement) requirement.resultsDocument = document;
    }
    emitTasksChanged(id) {
        for (const listener of this.listeners) listener({ type: 'tasks-changed', requirementIds: [id] });
    }
}

const taskService = new FakeTaskService();
const requirementService = new FakeRequirementService();
const generationCalls = [];
const aggregateDeferred = [];
const resultsSkill = {
    async generate(input) {
        if (!input.requirement) {
            return { html: `<html><body>${input.task.id}</body></html>`, generator: 'ai' };
        }
        generationCalls.push(input.requirement.tasks.map(task => task.id));
        const pending = deferred();
        aggregateDeferred.push(pending);
        await pending.promise;
        return { html: `<html><body>${input.requirement.tasks.map(task => task.id).join('+')}</body></html>`, generator: 'ai' };
    }
};
const service = new ResultsService(
    taskService,
    resultsSkill,
    requirementService,
    { suggestTitle: async () => undefined, classify: async () => undefined },
    { listPending: async () => [] },
    { captureGitChangeSetBetween: async () => ({ source: 'empty', diff: '', files: [] }) }
);
service.init();

const changeSet = capturedAt => ({ source: 'empty', diff: '', files: [], capturedAt });
const resultTask = (id, minute) => ({
    id,
    sessionId: 'session-a',
    requirementId: 'requirement-a',
    title: id,
    request: id,
    requirementChoice: 'default',
    status: 'completed',
    startedAt: `2026-09-05T10:${minute}:00.000Z`,
    endedAt: `2026-09-05T10:${minute}:30.000Z`,
    outcomeKind: 'result',
    baseline: { kind: 'workspace-snapshot', capturedAt: `2026-09-05T10:${minute}:00.000Z` },
    changeSet: changeSet(`2026-09-05T10:${minute}:30.000Z`),
    resultsDocument: {
        taskId: id,
        status: 'ready',
        html: `<html><body>${id}</body></html>`,
        generatedAt: `2026-09-05T10:${minute}:31.000Z`
    }
});
const first = resultTask('task-1', '01');
const second = resultTask('task-2', '02');
taskService.tasks.set(first.id, first);
taskService.tasks.set(second.id, second);
const previousHtml = '<html><body>previous readable aggregate</body></html>';
const requirement = {
    id: 'requirement-a',
    sessionId: 'session-a',
    title: 'Task list design',
    titleSource: 'task',
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:02:31.000Z',
    taskIds: [first.id, second.id],
    resultsDocument: { taskId: 'requirement:requirement-a', status: 'ready', html: previousHtml }
};
requirementService.requirements.set(requirement.id, requirement);
requirementService.emitTasksChanged(requirement.id);
await waitFor(() => generationCalls.length === 1);
assert.equal(requirement.resultsDocument.html, previousHtml,
    'A readable aggregate must remain visible while its update is running.');

const third = resultTask('task-3', '03');
taskService.tasks.set(third.id, third);
requirement.taskIds.push(third.id);
requirementService.emitTasksChanged(requirement.id);
aggregateDeferred[0].resolve();
await waitFor(() => generationCalls.length === 2);
assert.deepEqual(generationCalls, [[first.id, second.id], [first.id, second.id, third.id]],
    'An outcome that finishes during generation must be coalesced into a later generation.');
assert.equal(requirement.resultsDocument.html, previousHtml,
    'A stale generation must not overwrite the readable aggregate.');
aggregateDeferred[1].resolve();
await service.requirementGenerationPromises.get(requirement.id);
assert.equal(requirement.resultsDocument.html, '<html><body>task-1+task-2+task-3</body></html>');

const ordinaryQuestion = {
    id: 'task-question',
    sessionId: 'session-a',
    requirementId: requirement.id,
    title: 'What does this mean?',
    request: 'What does this mean?',
    requirementChoice: 'default',
    status: 'running',
    startedAt: '2026-09-05T10:04:00.000Z',
    outcomeKind: 'conversation',
    baseline: { kind: 'workspace-snapshot', capturedAt: '2026-09-05T10:04:00.000Z' }
};
taskService.tasks.set(ordinaryQuestion.id, ordinaryQuestion);
requirement.taskIds.push(ordinaryQuestion.id);
requirementService.emitTasksChanged(requirement.id);
await Promise.resolve();
assert.equal(generationCalls.length, 2, 'A running ordinary question must not regenerate an older aggregate.');
ordinaryQuestion.status = 'completed';
ordinaryQuestion.endedAt = '2026-09-05T10:04:30.000Z';
ordinaryQuestion.changeSet = changeSet(ordinaryQuestion.endedAt);
await taskService.finalizers[0](ordinaryQuestion);
taskService.emit({ type: 'ended', task: ordinaryQuestion });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(generationCalls.length, 2, 'Completing an ordinary question must not duplicate or regenerate a Result.');

const taskUpdateTaskService = new FakeTaskService();
const taskUpdateRequirementService = new FakeRequirementService();
let taskUpdateAttempts = 0;
let taskUpdateFails = true;
const taskUpdateService = new ResultsService(
    taskUpdateTaskService,
    {
        async generate(input) {
            taskUpdateAttempts++;
            if (taskUpdateFails) {
                throw new Error('injected task update failure');
            }
            return { html: `<html><body>updated-${input.task.id}</body></html>`, generator: 'ai' };
        }
    },
    taskUpdateRequirementService,
    { suggestTitle: async () => undefined, classify: async () => undefined },
    { listPending: async () => [] },
    { captureGitChangeSetBetween: async () => ({ source: 'empty', diff: '', files: [] }) }
);
taskUpdateService.init();
const taskUpdate = resultTask('task-update', '10');
const taskUpdatePreviousHtml = '<html><body>readable task result</body></html>';
taskUpdate.resultsDocument = {
    taskId: taskUpdate.id,
    status: 'ready',
    html: taskUpdatePreviousHtml,
    generatedAt: '2026-09-05T10:10:31.000Z'
};
taskUpdateTaskService.tasks.set(taskUpdate.id, taskUpdate);
await taskUpdateTaskService.finalizers[0](taskUpdate);
assert.equal(taskUpdate.resultsDocument.html, taskUpdatePreviousHtml,
    'A task update failure must preserve the readable body.');
assert.equal(taskUpdate.resultsDocument.status, 'ready');
assert.equal(taskUpdate.resultsDocument.updateError, '成果の更新に失敗しました。');
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(taskUpdateAttempts, 1, 'A task update failure must not start an automatic retry loop.');
taskUpdateFails = false;
await taskUpdateService.retry(taskUpdate.id);
assert.equal(taskUpdate.resultsDocument.html, '<html><body>updated-task-update</body></html>');
assert.equal(taskUpdate.resultsDocument.updateError, undefined,
    'A successful explicit task retry must clear the update error.');
assert.equal(taskUpdateAttempts, 2);

const aggregateFailureTaskService = new FakeTaskService();
const aggregateFailureRequirementService = new FakeRequirementService();
let aggregateFailureAttempts = 0;
let aggregateUpdateFails = true;
const aggregateFailureService = new ResultsService(
    aggregateFailureTaskService,
    {
        async generate(input) {
            assert(input.requirement, 'Only aggregate generation is expected in this fixture.');
            aggregateFailureAttempts++;
            if (aggregateUpdateFails) {
                throw new Error('injected aggregate update failure');
            }
            return {
                html: `<html><body>current-${input.requirement.tasks.map(task => task.id).join('+')}</body></html>`,
                generator: 'ai'
            };
        }
    },
    aggregateFailureRequirementService,
    { suggestTitle: async () => undefined, classify: async () => undefined },
    { listPending: async () => [] },
    { captureGitChangeSetBetween: async () => ({ source: 'empty', diff: '', files: [] }) }
);
aggregateFailureService.init();
const aggregateFirst = resultTask('aggregate-1', '11');
const aggregateSecond = resultTask('aggregate-2', '12');
aggregateFailureTaskService.tasks.set(aggregateFirst.id, aggregateFirst);
aggregateFailureTaskService.tasks.set(aggregateSecond.id, aggregateSecond);
const aggregatePreviousHtml = '<html><body>readable aggregate result</body></html>';
const aggregateFailureRequirement = {
    id: 'aggregate-failure',
    sessionId: 'session-b',
    title: 'Aggregate update',
    titleSource: 'task',
    createdAt: '2026-09-05T10:11:00.000Z',
    updatedAt: '2026-09-05T10:12:31.000Z',
    taskIds: [aggregateFirst.id, aggregateSecond.id],
    resultsDocument: {
        taskId: 'requirement:aggregate-failure',
        status: 'ready',
        html: aggregatePreviousHtml,
        generatedAt: '2026-09-05T10:11:31.000Z'
    }
};
aggregateFailureRequirementService.requirements.set(aggregateFailureRequirement.id, aggregateFailureRequirement);
aggregateFailureRequirementService.emitTasksChanged(aggregateFailureRequirement.id);
await waitFor(() => aggregateFailureRequirement.resultsDocument?.updateError !== undefined);
assert.equal(aggregateFailureRequirement.resultsDocument.html, aggregatePreviousHtml,
    'An aggregate update failure must preserve the readable body.');
assert.equal(aggregateFailureRequirement.resultsDocument.updateError, '成果の更新に失敗しました。');
const failedVersion = aggregateFailureService.requestedRequirementVersions.get(aggregateFailureRequirement.id);
assert(failedVersion, 'The failed aggregate version must be recorded as requested.');
assert.notEqual(aggregateFailureService.appliedRequirementVersions.get(aggregateFailureRequirement.id), failedVersion,
    'A failed aggregate version must not be recorded as successfully applied.');
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(aggregateFailureAttempts, 1, 'An aggregate update failure must not start an automatic retry loop.');
const questionAfterFailure = {
    id: 'question-after-aggregate-failure',
    sessionId: 'session-b',
    requirementId: aggregateFailureRequirement.id,
    title: 'Question after failure',
    request: 'Could you explain the previous result?',
    requirementChoice: 'default',
    status: 'running',
    startedAt: '2026-09-05T10:13:00.000Z',
    outcomeKind: 'conversation',
    baseline: { kind: 'workspace-snapshot', capturedAt: '2026-09-05T10:13:00.000Z' }
};
aggregateFailureTaskService.tasks.set(questionAfterFailure.id, questionAfterFailure);
aggregateFailureRequirement.taskIds.push(questionAfterFailure.id);
aggregateFailureRequirementService.emitTasksChanged(aggregateFailureRequirement.id);
questionAfterFailure.status = 'completed';
questionAfterFailure.endedAt = '2026-09-05T10:13:30.000Z';
questionAfterFailure.changeSet = changeSet(questionAfterFailure.endedAt);
await aggregateFailureTaskService.finalizers[0](questionAfterFailure);
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(aggregateFailureAttempts, 1,
    'An ordinary question after an update failure must not retry the failed aggregate.');
aggregateUpdateFails = false;
await aggregateFailureService.retryRequirement(aggregateFailureRequirement.id);
assert.equal(
    aggregateFailureRequirement.resultsDocument.html,
    '<html><body>current-aggregate-1+aggregate-2</body></html>'
);
assert.equal(aggregateFailureRequirement.resultsDocument.updateError, undefined,
    'A successful explicit aggregate retry must clear the update error.');
assert.equal(aggregateFailureAttempts, 2);
assert.equal(
    aggregateFailureService.appliedRequirementVersions.get(aggregateFailureRequirement.id),
    aggregateFailureService.requestedRequirementVersions.get(aggregateFailureRequirement.id),
    'The successful retry must apply the current aggregate version.'
);

const restoredFailureTaskService = new FakeTaskService();
const restoredFailureRequirementService = new FakeRequirementService();
const restoredFirst = resultTask('restored-aggregate-1', '14');
const restoredSecond = resultTask('restored-aggregate-2', '15');
restoredFailureTaskService.tasks.set(restoredFirst.id, restoredFirst);
restoredFailureTaskService.tasks.set(restoredSecond.id, restoredSecond);
const restoredFailureRequirement = {
    id: 'restored-aggregate-failure',
    sessionId: 'session-c',
    title: 'Restored aggregate update',
    titleSource: 'task',
    createdAt: '2026-09-05T10:14:00.000Z',
    updatedAt: '2026-09-05T10:15:31.000Z',
    taskIds: [restoredFirst.id, restoredSecond.id],
    resultsDocument: {
        taskId: 'requirement:restored-aggregate-failure',
        status: 'ready',
        html: '<html><body>restored readable aggregate</body></html>',
        updateError: '成果の更新に失敗しました。',
        generatedAt: '2026-09-05T10:14:31.000Z'
    }
};
restoredFailureRequirementService.requirements.set(restoredFailureRequirement.id, restoredFailureRequirement);
let restoredFailureAttempts = 0;
const restoredFailureService = new ResultsService(
    restoredFailureTaskService,
    {
        async generate() {
            restoredFailureAttempts++;
            return { html: '<html><body>restored retry current</body></html>', generator: 'ai' };
        }
    },
    restoredFailureRequirementService,
    { suggestTitle: async () => undefined, classify: async () => undefined },
    { listPending: async () => [] },
    { captureGitChangeSetBetween: async () => ({ source: 'empty', diff: '', files: [] }) }
);
restoredFailureService.init();
await restoredFailureService.restoreRequirements();
const restoredFailedVersion = restoredFailureService.attemptedRequirementVersions.get(restoredFailureRequirement.id);
assert(restoredFailedVersion, 'A restored update failure must retain its attempted version.');
assert.equal(restoredFailureService.appliedRequirementVersions.get(restoredFailureRequirement.id), undefined,
    'Reload must not promote a failed aggregate version to successfully applied.');
restoredFailureRequirementService.emitTasksChanged(restoredFailureRequirement.id);
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(restoredFailureAttempts, 0, 'Reload must not automatically retry a failed aggregate version.');
await restoredFailureService.retryRequirement(restoredFailureRequirement.id);
assert.equal(restoredFailureAttempts, 1, 'The restored failure must remain explicitly retryable.');
assert.equal(restoredFailureRequirement.resultsDocument.html, '<html><body>restored retry current</body></html>');
assert.equal(restoredFailureRequirement.resultsDocument.updateError, undefined);
assert.equal(
    restoredFailureService.appliedRequirementVersions.get(restoredFailureRequirement.id),
    restoredFailureService.requestedRequirementVersions.get(restoredFailureRequirement.id)
);

const resumedAggregateCases = [];
for (const coverage of ['older-legacy-aggregate', 'copied-task-document', 'persisted-old-version', 'current-legacy-aggregate']) {
    const restoredTasks = new FakeTaskService();
    const restoredRequirements = new FakeRequirementService();
    const earlier = resultTask('restored-earlier', '20');
    const later = resultTask('restored-later', '21');
    restoredTasks.tasks.set(earlier.id, earlier);
    restoredTasks.tasks.set(later.id, later);
    const restoredRequirement = {
        ...requirement,
        taskIds: [earlier.id, later.id],
        resultsDocument: {
            taskId: coverage === 'copied-task-document' ? earlier.id : `requirement:${requirement.id}`,
            status: 'ready',
            html: previousHtml,
            generatedAt: coverage === 'older-legacy-aggregate' ? '2026-09-05T10:20:32.000Z' : '2026-09-05T10:22:00.000Z',
            ...(coverage === 'persisted-old-version' ? { sourceVersion: 'previous-task-outcomes' } : {})
        }
    };
    restoredRequirements.requirements.set(restoredRequirement.id, restoredRequirement);
    const pendingUpdate = deferred();
    let resumedCalls = 0;
    const restoredSkill = {
        async generate(input) {
            resumedCalls++;
            assert.deepEqual(input.requirement.tasks.map(task => task.id), [earlier.id, later.id]);
            await pendingUpdate.promise;
            return { html: '<html><body>both restored outcomes</body></html>', generator: 'ai' };
        }
    };
    const restoredService = new ResultsService(
        restoredTasks, restoredSkill, restoredRequirements,
        { suggestTitle: async () => undefined, classify: async () => undefined },
        { listPending: async () => [] },
        { captureGitChangeSetBetween: async () => ({ source: 'empty', diff: '', files: [] }) }
    );
    restoredService.init();
    await restoredService.restoreRequirements();
    assert.equal(resumedCalls, 0, 'Restoration must not wait for aggregate AI generation.');
    restoredService.resumeRestoredGeneration();
    const requiresUpdate = coverage !== 'current-legacy-aggregate';
    if (requiresUpdate) {
        await waitFor(() => resumedCalls === 1);
        assert.equal(restoredRequirement.resultsDocument.html, previousHtml,
            'Restoring an unfinished aggregate update must preserve its readable prior document.');
        pendingUpdate.resolve();
        await restoredService.requirementGenerationPromises.get(restoredRequirement.id);
        assert.equal(restoredRequirement.resultsDocument.html, '<html><body>both restored outcomes</body></html>');
        assert.equal(typeof restoredRequirement.resultsDocument.sourceVersion, 'string');
    } else {
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(resumedCalls, 0, 'A legacy document covering every completed task must not regenerate on reload.');
    }

    // A second instance consumes serialized state, not the prior instance's in-memory version map.
    const savedRequirement = JSON.parse(JSON.stringify(restoredRequirement));
    const reloadedRequirements = new FakeRequirementService();
    reloadedRequirements.requirements.set(savedRequirement.id, savedRequirement);
    let redundantCalls = 0;
    const reloadedService = new ResultsService(
        restoredTasks,
        { async generate() { redundantCalls++; throw new Error('Unexpected generation after a settled reload.'); } },
        reloadedRequirements,
        { suggestTitle: async () => undefined, classify: async () => undefined },
        { listPending: async () => [] },
        { captureGitChangeSetBetween: async () => ({ source: 'empty', diff: '', files: [] }) }
    );
    reloadedService.init();
    await reloadedService.restoreRequirements();
    reloadedService.resumeRestoredGeneration();
    reloadedRequirements.emitTasksChanged(savedRequirement.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(redundantCalls, 0, 'A persisted completed aggregate must remain current after reload and task events.');
    assert.equal(savedRequirement.resultsDocument.html, restoredRequirement.resultsDocument.html);
    resumedAggregateCases.push({ coverage, generations: resumedCalls, generationsAfterReload: redundantCalls });
}

const namingTasks = new FakeTaskService();
const namingRequirements = new FakeRequirementService();
namingRequirements.rename = (id, title, source) => {
    const value = namingRequirements.get(id);
    Object.assign(value, { title, titleSource: source });
    return value;
};
const rememberedName = { ...resultTask('remember-name', '30'), outcomeKind: 'conversation', resultsDocument: undefined };
const namedDesign = {
    ...resultTask('named-design', '31'),
    workspaceUri: 'file:///C:/work/a',
    title: 'タスクの並び順を設計',
    request: '未完了が先になる安定した並び順を設計してください。'
};
namingTasks.tasks.set(rememberedName.id, rememberedName);
namingTasks.tasks.set(namedDesign.id, namedDesign);
const namedRequirement = {
    ...requirement, title: '仮の機能名を覚えてください', titleSource: 'task',
    taskIds: [rememberedName.id, namedDesign.id]
};
namingRequirements.requirements.set(namedRequirement.id, namedRequirement);
let titleGate = deferred();
let titleCalls = 0;
const namingService = new RequirementClassificationService(
    { async suggestTitle(scope) {
        titleCalls++;
        assert.equal(scope.request, namedDesign.request, 'The title request must describe the outcome rather than prior conversation.');
        await titleGate.promise;
        return { status: 'suggested', output: '{"title":"未完了を先に並べる"}' };
    } },
    namingTasks, namingRequirements, { providerId: 'codex', model: '', effort: '' }
);
const titleSuggestion = namingService.suggestTitle(namedDesign.id);
assert.equal(namedRequirement.title, 'タスクの並び順', 'The first actual outcome must immediately replace a conversation-derived title.');
titleGate.resolve();
await titleSuggestion;
assert.equal(namedRequirement.title, '未完了を先に並べる');
await namingService.suggestTitle(namedDesign.id);
assert.equal(titleCalls, 1, 'An already named outcome must not be renamed on every restore.');
Object.assign(namedRequirement, { title: namedDesign.title, titleSource: 'ai' });
await namingService.suggestTitle(namedDesign.id);
assert.equal(titleCalls, 1, 'An accepted title matching the task title must not trigger another AI request.');
titleGate = deferred();
Object.assign(namedRequirement, { title: '以前の会話題名', titleSource: 'task' });
const lateSuggestion = namingService.suggestTitle(namedDesign.id);
namingRequirements.rename(namedRequirement.id, '利用者が決めた名前', 'user');
titleGate.resolve();
await lateSuggestion;
assert.equal(namedRequirement.title, '利用者が決めた名前', 'A delayed title suggestion must preserve the user\'s rename.');

const semanticReferenceCases = [];
for (const kind of ['separate-goal', 'legacy-word-decision', 'same-goal-refinement']) {
    const semanticTasks = new FakeTaskService();
    const semanticRequirements = new RequirementService(semanticTasks, { async setData() {} }, {});
    const semanticRequirement = semanticRequirements.create('session-a', '並び順の改善');
    const earlier = { ...resultTask('ordering', '40'), requirementId: semanticRequirement.id, workspaceUri: 'file:///C:/work/a', request: '未完了を先に並べる' };
    const later = {
        ...resultTask('later-outcome', '41'), requirementId: semanticRequirement.id, workspaceUri: 'file:///C:/work/a',
        request: kind === 'same-goal-refinement'
            ? '先ほどの並び順の設計に空配列の仕様を追加してください。'
            : '並び順とは別の機能として入力検証を追加してください。先ほどの並び替え処理は変更しないでください。',
        ...(kind === 'legacy-word-decision' ? { requirementClassification: { decision: 'continue', source: 'heuristic', reason: 'previous-task-reference', decidedAt: '2026-09-05T10:41:32.000Z' } } : {})
    };
    earlier.changeSet.files = ['src/todo.js'];
    later.changeSet.files = ['src/todo.js'];
    semanticTasks.tasks.set(earlier.id, earlier);
    semanticTasks.tasks.set(later.id, later);
    semanticRequirement.taskIds = [earlier.id, later.id];
    let semanticCalls = 0;
    const decision = kind === 'same-goal-refinement' ? 'continue' : 'new';
    const semanticService = new RequirementClassificationService({ async classify(scope) {
        semanticCalls++;
        assert.equal(scope.task.request, later.request);
        assert.equal(scope.previousTasks[0].request, earlier.request);
        assert.deepEqual(scope.task.changedFiles, scope.previousTasks[0].changedFiles);
        return { status: 'classified', output: JSON.stringify({ decision, confidence: 0.96, title: 'タスク名の入力検証', reason: 'Completed outcome purpose compared with earlier work.' }) };
    } }, semanticTasks, semanticRequirements, { providerId: 'codex', model: '', effort: '' });
    await semanticService.classify(later.id);
    assert.equal(semanticCalls, 1, 'A prior-reference word must reach semantic classification instead of forcing continuation.');
    assert.equal(semanticTasks.get(later.id).requirementClassification.source, 'ai');
    assert.equal(semanticRequirements.list().length, decision === 'new' ? 2 : 1);
    assert.equal(semanticTasks.get(later.id).requirementId === semanticRequirement.id, decision === 'continue');
    semanticReferenceCases.push({ kind, semanticCalls, requirements: semanticRequirements.list().length });
}

console.log(`RESULTS_GENERATION_EVENTS_TEST=${JSON.stringify({
    aggregateGenerations: generationCalls.length,
    staleDiscarded: true,
    ordinaryQuestionIgnored: true,
    taskUpdateRetry: taskUpdateAttempts,
    aggregateUpdateRetry: aggregateFailureAttempts,
    restoredFailureRetry: restoredFailureAttempts,
    resumedAggregateCases,
    firstOutcomeTitle: true,
    userTitlePreserved: true,
    semanticReferenceCases
})}`);

async function waitFor(predicate) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for Results generation event.');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
