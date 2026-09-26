import { CliCallRecord } from '../common/cli-usage';
import { hashChangeSet } from '../common/change-set-hash';
import { buildVerificationTable } from './results-evidence';
import { Emitter, Event } from '@theia/core/lib/common';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import {
    ExecutionTask,
    summarizeTaskChangeSet,
    TaskChangeSet,
    TaskResultDocument,
    TaskService
} from './task-service';
import { hasReadableResultDocument, taskProducesResult } from '../common/task-outcome';
import { ResultsSkillBundle } from '../common/skill-bundle';
import {
    ResultsGenerationProgress,
    ResultsGenerationRequest,
    ResultsGenerationRequirementMetadata,
    ResultsGenerationServer
} from '../common/results-generation-protocol';
import { ResultsAssertionServer } from '../common/results-assertion-protocol';
import { AgentRuntimeServer } from '../common/agent-runtime-protocol';
import { ResultsGenerationContext } from './results-generation-context';
import { WorkspaceSkillService } from './workspace-skill-service';
import { formatExecutionEvidence } from './results-document-normalizer';
import { Requirement } from './requirement-model';
import { RequirementService } from './requirement-service';
import { RequirementClassificationService } from './requirement-classification-service';
import {
    buildFailedAssertionPromptSection,
    extractResultsAssertionText,
    parseResultsAssertionJudgement,
    ResultsAssertionDefinition,
    ResultsAssertionResult,
    selectBetterResultsAssertionCandidate
} from './results-assertions';

export const ResultsSkill = Symbol('ResultsSkill');

export interface ResultsSkillInput {
    task: ExecutionTask;
    changeSet: TaskChangeSet;
    documentId?: string;
    onProgress?: (progress: ResultsGenerationProgress) => void;
    onCall?: (call: CliCallRecord) => void;
    requirement?: {
        id: string;
        title: string;
        tasks: ExecutionTask[];
    };
}

export interface ResultsSkill extends ResultsSkillBundle {
    generate(input: ResultsSkillInput): Promise<ResultsSkillDocument>;
    cancel?(taskId: string): Promise<void>;
}

export interface ResultsSkillDocument {
    calls?: CliCallRecord[];
    html: string;
    generator: 'ai' | 'template' | 'fallback';
    providerId?: TaskResultDocument['providerId'];
    model?: string;
    effort?: string;
    fallbackReason?: string;
    assertions?: ResultsAssertionResult[];
    assertionAttempts?: 1 | 2;
}

export function formatRequirementExecutionEvidence(tasks: readonly ExecutionTask[], maxChars = 16_000): string {
    const combined = tasks.map((task, index) => {
        const evidence = formatExecutionEvidence(task.activities, maxChars);
        return `### Task ${index + 1}\n${evidence || '記録なし'}`;
    }).join('\n\n');
    if (combined.length <= maxChars) {
        return combined;
    }
    const marker = `\n[Execution evidence truncated; original length: ${combined.length} characters]`;
    return `${combined.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

class ResultsGenerationCancelledError extends Error { }

/** Runs the bundled skill with the selected AI; the app never substitutes a document. */
@injectable()
export class AiResultsSkill implements ResultsSkill {
    readonly manifest = {
        id: 'builtin.ai-results',
        name: "組み込みの成果作成",
        version: '1.0.0',
        kind: 'results' as const,
        entry: 'builtin:ai-results'
    };
    protected readonly cancelledDocumentIds = new Set<string>();

    constructor(
        @inject(ResultsGenerationServer) protected readonly generationServer: ResultsGenerationServer,
        @inject(ResultsGenerationContext) protected readonly context: ResultsGenerationContext,
        @inject(WorkspaceSkillService) protected readonly workspaceSkillService: WorkspaceSkillService,
        @inject(TaskService) protected readonly taskService: TaskService,
        @inject(ResultsAssertionServer) protected readonly assertionServer: ResultsAssertionServer
    ) { }

    async generate(input: ResultsSkillInput): Promise<ResultsSkillDocument> {
        if (input.task.status === 'running') { throw new Error("作業の終了後に成果を作成できます。"); }
        const providerId = this.context.providerId;
        const model = this.context.model.trim() || undefined;
        const effort = this.context.effort || undefined;
        const judgeSelection = this.context.judge;
        const documentId = input.documentId ?? input.task.id;
        const calls: CliCallRecord[] = [];
        const workspaceUri = input.task.workspaceUri;
        this.cancelledDocumentIds.delete(documentId);
        if (!workspaceUri) { throw new Error("成果を作成する作業場所がありません。"); }
        if (providerId !== 'codex' && providerId !== 'claude') { throw new Error("成果文書の作成には未対応"); }
        const workspaceSkills = await this.workspaceSkillService.buildPrompt(workspaceUri, 'results');
        this.taskService.setAppliedSkills(input.task.id, 'results', workspaceSkills.includedSkillIds);
        const generatedHooks = await this.taskService.runHooks('resultsGenerate', input.task, {
            requirementId: input.task.requirementId, taskIds: input.requirement?.tasks.map(task => task.id) ?? [input.task.id]
        });
        this.throwIfCancelled(documentId);
        const tasks = input.requirement?.tasks ?? [input.task];
        const changedFiles = summarizeTaskChangeSet(input.changeSet).files;
        const changeSetSummary = JSON.stringify({ files: changedFiles, captureError: input.changeSet.error, hookEvidence: tasks.flatMap(task => task.hookEvidence ?? []) });
        const verification = buildVerificationTable(tasks, input.changeSet);
        const request: ResultsGenerationRequest = {
            taskId: documentId, attempt: 1, providerId, model, effort, workspaceUri,
            taskMetadata: { status: input.task.status, title: input.task.title, request: input.task.request,
                endedAt: input.task.endedAt, completionSummary: input.task.completionSummary,
                implementerReport: input.task.implementerReport, failureSummary: input.task.failure?.summary },
            requirement: input.requirement ? this.requirementMetadata(input.requirement) : undefined,
            changeSetSummary, changedFiles, changeCaptureError: input.changeSet.error,
            diff: input.changeSet.diff, hookMaterial: generatedHooks.material, verification,
            images: verification.rows.flatMap(row => row.image ? [{ path: row.image, label: row.label }] : []),
            executionEvidence: input.requirement ? formatRequirementExecutionEvidence(tasks, 256_000)
                : formatExecutionEvidence(input.task.activities, 256_000),
            workspaceSkillGuidance: workspaceSkills.content || undefined
        };
        let first: Awaited<ReturnType<AiResultsSkill['assertCandidate']>> | undefined;
        for (const attempt of [1, 2] as const) {
            this.throwIfCancelled(documentId);
            request.attempt = attempt;
            input.onProgress?.({ phase: attempt === 1 ? 'generation' : 'regeneration', providerId, model, effort, attempt,
                failedAssertions: first?.assertions.filter(assertion => assertion.status === 'fail').length,
                startedAt: new Date().toISOString() });
            const result = await this.generationServer.generate(request);
            if (result.call) { calls.push(result.call); input.onCall?.(result.call); }
            this.throwIfCancelled(documentId);
            if (result.status === 'cancelled') { throw new ResultsGenerationCancelledError(result.error.message); }
            if (result.status === 'failed') {
                if (attempt === 1 && result.error.retryable) {
                    request.assertionRetryGuidance = result.error.message;
                    continue;
                }
                throw new Error(result.error.message);
            }
            const candidate = await this.assertCandidate(result.html, input, workspaceSkills.assertions, request,
                changeSetSummary, calls, judgeSelection);
            this.throwIfCancelled(documentId);
            if (attempt === 2 || !candidate.assertions.some(assertion => assertion.status === 'fail')) {
                const selected = first ? selectBetterResultsAssertionCandidate(first, candidate) : candidate;
                return { ...selected.document, calls, assertions: [...selected.assertions], assertionAttempts: attempt };
            }
            first = candidate;
            request.assertionRetryGuidance = buildFailedAssertionPromptSection(candidate.assertions);
        }
        throw new Error("成果文書を作成できませんでした。");
    }

    async cancel(taskId: string): Promise<void> {
        this.cancelledDocumentIds.add(taskId);
        await Promise.all([
            this.generationServer.cancel(taskId),
            this.assertionServer.cancel(taskId)
        ]);
    }

    protected throwIfCancelled(taskId: string): void {
        if (this.cancelledDocumentIds.has(taskId)) {
            throw new ResultsGenerationCancelledError('Results generation was cancelled.');
        }
    }

    protected async assertCandidate(
        output: string,
        input: ResultsSkillInput,
        definitions: readonly ResultsAssertionDefinition[],
        request: ResultsGenerationRequest,
        changeSetSummary: string,
        calls: CliCallRecord[],
        judgeSelection = this.context.judge
    ): Promise<{
        document: ResultsSkillDocument;
        assertions: ResultsAssertionResult[];
    }> {
        const observedModel = calls.filter(call => call.purpose === 'results-generation').at(-1)?.model ?? request.model;
        const html = output;
        let skillAssertions: ResultsAssertionResult[] = [];
        if (definitions.length > 0) {
            input.onProgress?.({ phase: 'judge', ...judgeSelection, attempt: request.attempt ?? 1, startedAt: new Date().toISOString() });
            try {
                const judged = await this.assertionServer.judge({
                    taskId: request.taskId,
                    attempt: request.attempt,
                    ...judgeSelection,
                    workspaceUri: request.workspaceUri,
                    documentText: extractResultsAssertionText(html),
                    assertions: definitions.map(definition => definition.text),
                    changeSetSummary
                });
                if (judged.call) { calls.push(judged.call); input.onCall?.(judged.call); }
                if (judged.status === 'cancelled') {
                    throw new ResultsGenerationCancelledError(judged.error.message);
                }
                if (judged.status === 'failed') {
                    console.warn('[Poiesis][Results diagnostics] Skill assertions could not be judged; recording unknown.',
                        `${judged.error.code}: ${judged.error.message}`);
                    skillAssertions = parseResultsAssertionJudgement('', definitions);
                } else {
                    skillAssertions = parseResultsAssertionJudgement(judged.output, definitions);
                }
            } catch (error) {
                this.throwIfCancelled(request.taskId);
                if (error instanceof ResultsGenerationCancelledError) {
                    throw error;
                }
                console.warn('[Poiesis][Results diagnostics] Skill assertion judging failed unexpectedly; recording unknown.', error);
                skillAssertions = parseResultsAssertionJudgement('', definitions);
            }
        }
        return {
            document: {
                html,
                generator: 'ai',
                providerId: request.providerId,
                model: observedModel,
                effort: request.effort
            },
            assertions: skillAssertions
        };
    }

    protected requirementMetadata(
        requirement: NonNullable<ResultsSkillInput['requirement']>
    ): ResultsGenerationRequirementMetadata {
        return { title: requirement.title, tasks: requirement.tasks.map(task => ({
            status: task.status === 'running' ? 'cancelled' : task.status,
            title: task.title, request: task.request, endedAt: task.endedAt,
            completionSummary: task.completionSummary, implementerReport: task.implementerReport,
            failureSummary: task.failure?.summary, changedFiles: summarizeTaskChangeSet(task.changeSet).files
        })) };
    }

}

/** App-owned trigger: skills run only after a Task ends or is cancelled. */
@injectable()
export class ResultsService {
    public isGenerating(documentId: string): boolean { return this.generationTokens.has(documentId); }

    protected static readonly UPDATE_ERROR = '成果の更新に失敗しました。';
    protected readonly documents = new Map<string, TaskResultDocument>();
    protected readonly requirementChangeSets = new Map<string, TaskChangeSet>();
    protected readonly onDidChangeEmitter = new Emitter<TaskResultDocument>();
    readonly onDidChange: Event<TaskResultDocument> = this.onDidChangeEmitter.event;
    protected readonly generationTokens = new Map<string, number>();
    protected readonly generationPromises = new Map<string, Promise<void>>();
    protected readonly requirementGenerationPromises = new Map<string, Promise<void>>();
    protected readonly requestedRequirementVersions = new Map<string, string>();
    protected readonly appliedRequirementVersions = new Map<string, string>();
    protected readonly attemptedRequirementVersions = new Map<string, string>();
    protected readonly restoredGenerationTaskIds = new Set<string>();
    protected generationSequence = 0;

    constructor(
        @inject(TaskService) protected readonly taskService: TaskService,
        @inject(ResultsSkill) protected readonly resultsSkill: ResultsSkill,
        @inject(RequirementService) protected readonly requirementService: RequirementService,
        @inject(RequirementClassificationService) protected readonly requirementClassificationService: RequirementClassificationService,
        @inject(WorkspaceSkillService) protected readonly workspaceSkillService: WorkspaceSkillService,
        @inject(AgentRuntimeServer) protected readonly runtimeServer: AgentRuntimeServer
    ) { }

    @postConstruct()
    protected init(): void {
        this.taskService.registerTerminalFinalizer(task => this.startGeneration(task));
        this.requirementService.onDidChange(event => {
            if (event.type === 'tasks-changed') {
                for (const requirementId of event.requirementIds) {
                    const requirement = this.requirementService.get(requirementId);
                    const attachedTasks = requirement?.taskIds.map(taskId => this.taskService.get(taskId))
                        .filter((task): task is ExecutionTask => Boolean(task)) ?? [];
                    if (requirement && !attachedTasks.some(task => task.status === 'running')) {
                        void this.startRequirementGeneration(requirementId);
                    } else if (!requirement) {
                        this.requirementChangeSets.delete(requirementId);
                        this.requestedRequirementVersions.delete(requirementId);
                        this.appliedRequirementVersions.delete(requirementId);
                        this.attemptedRequirementVersions.delete(requirementId);
                    }
                }
            }
        });
    }

    get(taskId: string): TaskResultDocument | undefined {
        return this.documents.get(taskId) ?? this.taskService.get(taskId)?.resultsDocument;
    }

    list(taskIds?: Iterable<string>): TaskResultDocument[] {
        const selected = taskIds ? new Set(taskIds) : undefined;
        return [...this.documents.values()].filter(document => !selected || selected.has(document.taskId));
    }

    getRequirement(requirementId: string): TaskResultDocument | undefined {
        const requirement = this.requirementService.get(requirementId);
        if (!requirement) { return undefined; }
        const tasks = this.finishedRequirementTasks(requirement);
        // A single outcome uses its Task document throughout generation. The stored
        // Requirement copy is only refreshed after generation/classification finishes.
        return tasks.length === 1 ? this.get(tasks[0].id) ?? requirement.resultsDocument : requirement.resultsDocument;
    }

    getRequirementChangeSet(requirementId: string): TaskChangeSet | undefined {
        const requirement = this.requirementService.get(requirementId);
        const tasks = requirement ? this.finishedRequirementTasks(requirement) : [];
        if (tasks.length === 1) { return tasks[0].changeSet; }
        return this.requirementChangeSets.get(requirementId);
    }

    restore(documents: readonly TaskResultDocument[], taskIds: ReadonlySet<string>): void {
        for (const document of documents) {
            if (!document
                || typeof document.taskId !== 'string'
                || !taskIds.has(document.taskId)
                || !['ready', 'failed'].includes(document.status)) {
                continue;
            }
            this.documents.set(document.taskId, document);
            this.taskService.setResultsDocument(document.taskId, document);
        }
        for (const taskId of taskIds) {
            const task = this.taskService.get(taskId);
            const document = this.get(taskId);
            if (task && (!document || document.status === 'generating')) {
                this.restoredGenerationTaskIds.add(taskId);
            }
        }
    }

    async restoreRequirements(): Promise<void> {
        for (const requirement of this.requirementService.list()) {
            const tasks = this.finishedRequirementTasks(requirement);
            if (!tasks.length) {
                continue;
            }
            if (tasks.length === 1) {
                const document = this.get(tasks[0].id);
                if (document) {
                    const version = this.requirementOutcomeVersion(requirement);
                    this.requirementService.setResultsDocument(requirement.id, { ...document, sourceVersion: version });
                    if (document.updateError || document.status === 'failed') {
                        this.attemptedRequirementVersions.set(requirement.id, version);
                    } else if (document.status === 'ready') {
                        this.appliedRequirementVersions.set(requirement.id, version);
                    }
                }
                this.requirementChangeSets.set(requirement.id, tasks[0].changeSet!);
            } else if (requirement.resultsDocument) {
                const version = this.requirementOutcomeVersion(requirement);
                if (requirement.resultsDocument.updateError || requirement.resultsDocument.status === 'failed') {
                    this.attemptedRequirementVersions.set(requirement.id, version);
                } else if (requirement.resultsDocument.status === 'ready'
                    && this.restoredRequirementDocumentIsCurrent(requirement, version)) {
                    this.appliedRequirementVersions.set(requirement.id, version);
                }
            }
        }
    }

    /** Restarts incomplete restored work only after Session and Requirement membership is stable. */
    resumeRestoredGeneration(): void {
        const taskIds = [...this.restoredGenerationTaskIds];
        this.restoredGenerationTaskIds.clear();
        const pendingRequirementIds = new Set<string>();
        for (const taskId of taskIds) {
            const task = this.taskService.get(taskId);
            if (!task) {
                continue;
            }
            pendingRequirementIds.add(task.requirementId);
            void this.startGeneration(task).catch(error =>
                console.warn('[Poiesis] Could not resume restored Results generation.', error)
            );
        }
        for (const requirement of this.requirementService.list()) {
            const tasks = this.finishedRequirementTasks(requirement);
            if (tasks[0]) {
                void this.requirementClassificationService.suggestTitle(tasks[0].id).catch(error =>
                    console.warn('[Poiesis][Requirement title] Could not name the restored outcome.', error)
                );
            }
            if (tasks.length < 2) {
                continue;
            }
            const document = requirement.resultsDocument;
            const needsUpdate = document?.status === 'generating'
                || document?.status === 'ready' && !document.updateError
                    && this.appliedRequirementVersions.get(requirement.id) !== this.requirementOutcomeVersion(requirement);
            if (needsUpdate) {
                if (!pendingRequirementIds.has(requirement.id)) {
                    void this.startRequirementGeneration(requirement.id).catch(error =>
                        console.warn('[Poiesis] Could not resume restored Requirement Results.', error)
                    );
                }
            } else if (requirement.resultsDocument) {
                void this.cumulativeChangeSet(requirement).then(() => {
                    const restored = this.getRequirement(requirement.id);
                    if (restored) { this.onDidChangeEmitter.fire(restored); }
                }).catch(error =>
                    console.warn('[Poiesis] Could not restore cumulative Results evidence.', error)
                );
            } else if (!pendingRequirementIds.has(requirement.id)) {
                void this.startRequirementGeneration(requirement.id).catch(error =>
                    console.warn('[Poiesis] Could not resume restored Requirement Results.', error)
                );
            }
        }
    }

    async retry(taskId: string): Promise<void> {
        const task = this.taskService.get(taskId);
        if (task && task.status !== 'running' && this.shouldGenerate(task)) {
            await this.startGeneration(task);
        }
    }

    async retryRequirement(requirementId: string): Promise<void> {
        const requirement = this.requirementService.get(requirementId);
        const tasks = requirement ? this.finishedRequirementTasks(requirement) : [];
        if (tasks.length === 1) {
            await this.retry(tasks[0].id);
        }
        await this.startRequirementGeneration(requirementId, true);
    }

    async requirementChangeSet(requirementId: string): Promise<TaskChangeSet | undefined> {
        const cached = this.requirementChangeSets.get(requirementId);
        if (cached) {
            return cached;
        }
        const requirement = this.requirementService.get(requirementId);
        return requirement ? this.cumulativeChangeSet(requirement) : undefined;
    }

    /** Resolves only after the terminal Task's Results document has been attached to that Task. */
    async whenFinished(taskId: string): Promise<TaskResultDocument | undefined> {
        await this.taskService.whenFinalized(taskId);
        await this.generationPromises.get(taskId);
        return this.get(taskId);
    }

    remove(taskIds: Iterable<string>): void {
        for (const taskId of [...taskIds]) {
            this.generationTokens.delete(taskId);
            this.generationPromises.delete(taskId);
            void this.resultsSkill.cancel?.(taskId).catch(error =>
                console.warn('[Poiesis] Could not cancel Results generation.', error)
            );
            this.documents.delete(taskId);
            this.taskService.setResultsDocument(taskId, undefined);
        }
    }

    protected startGeneration(task: ExecutionTask): Promise<void> {
        if (!this.shouldGenerate(task)) {
            this.documents.delete(task.id);
            this.taskService.setResultsDocument(task.id, undefined);
            const requirementId = this.taskService.get(task.id)?.requirementId ?? task.requirementId;
            void this.startRequirementGeneration(requirementId).catch(error =>
                console.warn('[Poiesis] Could not finish pending Requirement Results.', error)
            );
            return Promise.resolve();
        }
        const current = this.generationPromises.get(task.id);
        if (current && this.generationTokens.has(task.id)) {
            return current;
        }
        void this.requirementClassificationService.suggestTitle(task.id).catch(error =>
            console.warn('[Poiesis][Requirement title] Suggestion failed unexpectedly.', error)
        );
        const generation = this.generateTask(task).then(() => {
            void this.requirementClassificationService.classify(task.id)
                .catch(error =>
                    console.warn('[Poiesis][Requirement classification] Classification failed unexpectedly.', error)
                ).finally(() => {
                    const requirementId = this.taskService.get(task.id)?.requirementId ?? task.requirementId;
                    void this.startRequirementGeneration(requirementId).catch(error =>
                        console.warn('[Poiesis] Could not generate Requirement Results in the background.', error)
                    );
                });
        }).finally(() => {
            if (this.generationPromises.get(task.id) === generation) {
                this.generationPromises.delete(task.id);
            }
        });
        this.generationPromises.set(task.id, generation);
        return generation;
    }

    protected async generateTask(task: ExecutionTask): Promise<void> {
        if (!this.shouldGenerate(task)) {
            return;
        }
        const changeSet = task.changeSet!;
        const generationToken = ++this.generationSequence;
        const generationStartedAt = Date.now();
        const previousDocument = this.get(task.id);
        const calls: CliCallRecord[] = [];
        this.generationTokens.set(task.id, generationToken);
        if (!hasReadableResultDocument(previousDocument)) {
            this.set({ taskId: task.id, status: 'generating', generationStartedAt: new Date(generationStartedAt).toISOString() }, task);
        }
        try {
            const generated = await this.resultsSkill.generate({ task, changeSet,
                onCall: call => { calls.push(call); this.taskService.recordCliCall(task.id, call); },
                onProgress: progress => {
                    if (this.generationTokens.get(task.id) !== generationToken) { return; }
                    this.set({ ...previousDocument, taskId: task.id,
                        status: hasReadableResultDocument(previousDocument) ? 'ready' : 'generating',
                        generationStartedAt: new Date(generationStartedAt).toISOString(), progress, calls: [...calls]
                    }, task);
                }
            });
            if (this.generationTokens.get(task.id) !== generationToken) {
                return;
            }
            this.set({
                taskId: task.id,
                status: 'ready',
                ...generated,
                generatedAt: new Date().toISOString(),
                durationMs: Math.max(0, Date.now() - generationStartedAt)
            }, task);
        } catch (error) {
            if (this.generationTokens.get(task.id) !== generationToken) {
                return;
            }
            if (hasReadableResultDocument(previousDocument)) {
                this.set({
                    ...previousDocument!,
                    status: 'ready',
                    updateError: error instanceof Error ? error.message : ResultsService.UPDATE_ERROR
                }, task);
            } else {
                this.set({
                    taskId: task.id,
                    status: 'failed',
                    calls,
                    error: error instanceof Error ? error.message : String(error),
                    generatedAt: new Date().toISOString(),
                    durationMs: Math.max(0, Date.now() - generationStartedAt)
                }, task);
            }
        } finally {
            if (this.generationTokens.get(task.id) === generationToken) {
                this.generationTokens.delete(task.id);
            }
        }
    }

    protected startRequirementGeneration(requirementId: string, force = false): Promise<void> {
        const requirement = this.requirementService.get(requirementId);
        if (!requirement) {
            this.requestedRequirementVersions.delete(requirementId);
            this.appliedRequirementVersions.delete(requirementId);
            this.attemptedRequirementVersions.delete(requirementId);
            return Promise.resolve();
        }
        const attachedTasks = requirement.taskIds.map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => Boolean(task));
        if (attachedTasks.some(task => task.status === 'running')) {
            return this.requirementGenerationPromises.get(requirementId) ?? Promise.resolve();
        }
        const requestedVersion = this.requirementOutcomeVersion(requirement);
        if (!requestedVersion) {
            return this.requirementGenerationPromises.get(requirementId) ?? Promise.resolve();
        }
        this.requestedRequirementVersions.set(requirementId, requestedVersion);
        if (force) {
            this.appliedRequirementVersions.delete(requirementId);
        }
        const current = this.requirementGenerationPromises.get(requirementId);
        if (current) {
            return current;
        }
        if (!force && requestedVersion === this.attemptedRequirementVersions.get(requirementId)) {
            return Promise.resolve();
        }
        const generation = this.drainRequirementGenerations(requirementId).finally(() => {
            if (this.requirementGenerationPromises.get(requirementId) === generation) {
                this.requirementGenerationPromises.delete(requirementId);
            }
            if (this.requestedRequirementVersions.get(requirementId)
                !== this.attemptedRequirementVersions.get(requirementId)
                && this.requestedRequirementVersions.get(requirementId)
                    !== this.appliedRequirementVersions.get(requirementId)) {
                void this.startRequirementGeneration(requirementId).catch(error =>
                    console.warn('[Poiesis] Could not generate the newest Requirement Results.', error)
                );
            }
        });
        this.requirementGenerationPromises.set(requirementId, generation);
        return generation;
    }

    protected async drainRequirementGenerations(requirementId: string): Promise<void> {
        while (true) {
            const requestedVersion = this.requestedRequirementVersions.get(requirementId);
            if (!requestedVersion || requestedVersion === this.appliedRequirementVersions.get(requirementId)) {
                return;
            }
            this.attemptedRequirementVersions.set(requirementId, requestedVersion);
            const applied = await this.generateRequirement(requirementId, requestedVersion);
            if (applied) {
                this.appliedRequirementVersions.set(requirementId, requestedVersion);
            }
            const latestVersion = this.requestedRequirementVersions.get(requirementId);
            if (latestVersion === requestedVersion) {
                return;
            }
        }
    }

    protected async generateRequirement(requirementId: string, requestedVersion: string): Promise<boolean> {
        const requirement = this.requirementService.get(requirementId);
        if (!requirement || !this.requirementGenerationIsCurrent(requirement, requestedVersion)) {
            return false;
        }
        const tasks = this.finishedRequirementTasks(requirement);
        if (!tasks.length || tasks.some(task => !task.changeSet)) {
            return false;
        }
        if (tasks.length === 1) {
            const document = this.get(tasks[0].id);
            if (document && this.requirementGenerationIsCurrent(requirement, requestedVersion)) {
                this.requirementService.setResultsDocument(requirement.id, { ...document, sourceVersion: requestedVersion });
                this.requirementChangeSets.set(requirement.id, tasks[0].changeSet!);
                this.onDidChangeEmitter.fire(document);
                return true;
            }
            return false;
        }

        const latestTask = tasks.at(-1)!;
        const documentId = this.requirementDocumentId(requirement.id);
        const generationToken = ++this.generationSequence;
        const generationStartedAt = Date.now();
        const previousDocument = requirement.resultsDocument;
        const calls: CliCallRecord[] = [];
        this.generationTokens.set(documentId, generationToken);
        if (!hasReadableResultDocument(previousDocument)) {
            this.setRequirementDocument(requirement, { taskId: documentId, status: 'generating', generationStartedAt: new Date(generationStartedAt).toISOString() });
        }
        try {
            const changeSet = await this.cumulativeChangeSet(requirement);
            const generated = await this.resultsSkill.generate({
                task: latestTask,
                changeSet,
                documentId,
                requirement: { id: requirement.id, title: requirement.title, tasks },
                onCall: call => { calls.push(call); },
                onProgress: progress => {
                    if (this.generationTokens.get(documentId) !== generationToken
                        || !this.requirementGenerationIsCurrent(requirement, requestedVersion)) { return; }
                    this.setRequirementDocument(requirement, { ...previousDocument, taskId: documentId,
                        status: hasReadableResultDocument(previousDocument) ? 'ready' : 'generating',
                        generationStartedAt: new Date(generationStartedAt).toISOString(), progress, calls: [...calls]
                    });
                }
            });
            if (this.generationTokens.get(documentId) !== generationToken
                || !this.requirementGenerationIsCurrent(requirement, requestedVersion)) {
                return false;
            }
            this.setRequirementDocument(requirement, {
                taskId: documentId,
                status: 'ready',
                ...generated,
                generatedAt: new Date().toISOString(),
                sourceVersion: requestedVersion,
                durationMs: Math.max(0, Date.now() - generationStartedAt)
            });
            return true;
        } catch (error) {
            if (this.generationTokens.get(documentId) !== generationToken
                || !this.requirementGenerationIsCurrent(requirement, requestedVersion)) {
                return false;
            }
            if (hasReadableResultDocument(previousDocument)) {
                this.setRequirementDocument(requirement, {
                    ...previousDocument!,
                    status: 'ready',
                    updateError: error instanceof Error ? error.message : ResultsService.UPDATE_ERROR
                });
            } else {
                this.setRequirementDocument(requirement, {
                    taskId: documentId,
                    status: 'failed',
                    calls,
                    error: error instanceof Error ? error.message : String(error),
                    generatedAt: new Date().toISOString(),
                    durationMs: Math.max(0, Date.now() - generationStartedAt)
                });
            }
            return false;
        } finally {
            if (this.generationTokens.get(documentId) === generationToken) {
                this.generationTokens.delete(documentId);
            }
        }
    }

    protected restoredRequirementDocumentIsCurrent(requirement: Requirement, version: string): boolean {
        const document = requirement.resultsDocument;
        if (document?.sourceVersion !== undefined) {
            return document.sourceVersion === version;
        }
        // Legacy aggregate timestamps can prove coverage; a copied single-task document cannot.
        if (document?.taskId !== this.requirementDocumentId(requirement.id)) {
            return false;
        }
        const generatedAt = Date.parse(document.generatedAt ?? '');
        return Number.isFinite(generatedAt) && this.finishedRequirementTasks(requirement).every(task =>
            [task.endedAt, task.changeSet?.capturedAt, task.resultsDocument?.generatedAt]
                .every(timestamp => {
                    const time = Date.parse(timestamp ?? '');
                    return Number.isFinite(time) && time <= generatedAt;
                })
        );
    }

    protected requirementOutcomeVersion(requirement: Requirement): string {
        return this.finishedRequirementTasks(requirement).map(task => [
            task.id,
            task.endedAt ?? '',
            task.outcomeKind ?? 'legacy',
            task.changeSet?.capturedAt ?? '',
            task.resultsDocument?.status ?? '',
            task.resultsDocument?.generatedAt ?? ''
        ].join(':')).join('|');
    }

    protected requirementGenerationIsCurrent(requirement: Requirement, requestedVersion: string): boolean {
        const current = this.requirementService.get(requirement.id);
        if (!current || this.requestedRequirementVersions.get(requirement.id) !== requestedVersion) {
            return false;
        }
        const attachedTasks = current.taskIds.map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => Boolean(task));
        return !attachedTasks.some(task => task.status === 'running')
            && this.requirementOutcomeVersion(current) === requestedVersion;
    }

    protected async cumulativeChangeSet(requirement: Requirement): Promise<TaskChangeSet> {
        const tasks = this.finishedRequirementTasks(requirement);
        const first = tasks[0];
        const last = tasks.at(-1);
        const paths = [...new Set(tasks.flatMap(task => task.changeSet?.files ?? []))].sort();
        const unavailableReasons = [...new Set(tasks
            .map(task => task.changeSet?.error?.trim())
            .filter((error): error is string => Boolean(error)))];
        let unavailableReason = unavailableReasons.join(' / ') || undefined;
        if (!unavailableReason && first?.baselineSnapshotId && last?.endSnapshotId) {
            try {
                const capture = await this.runtimeServer.captureGitChangeSetBetween({
                    fromSnapshotId: first.baselineSnapshotId,
                    toSnapshotId: last.endSnapshotId,
                    paths
                });
                if (!capture.error) {
                    const changeSet: TaskChangeSet = {
                        source: capture.source,
                        diff: capture.diff,
                        files: capture.files,
                        capturedAt: new Date().toISOString()
                    };
                    changeSet.changeSetHash = await hashChangeSet(changeSet);
                    this.requirementChangeSets.set(requirement.id, changeSet);
                    return changeSet;
                }
                unavailableReason = capture.error;
            } catch {
                unavailableReason = '変更内容をまとめて確認できませんでした。';
                // Legacy concatenation below keeps Results available when the durable store is missing.
            }
        }
        const diffs = tasks.flatMap((task, index) => task.changeSet?.diff
            ? [`### Task ${index + 1}: ${task.title}\n${task.changeSet.diff}`]
            : []);
        const note = '[Legacy snapshot note: cumulative range was unavailable; per-task diffs follow.]';
        const changeSet: TaskChangeSet = {
            source: diffs.length ? 'task-diff' : 'empty',
            diff: diffs.length ? `${note}\n\n${diffs.join('\n\n')}` : '',
            files: paths,
            capturedAt: new Date().toISOString(),
            error: unavailableReason
        };
        changeSet.changeSetHash = await hashChangeSet(changeSet);
        this.requirementChangeSets.set(requirement.id, changeSet);
        return changeSet;
    }

    protected finishedRequirementTasks(requirement: Requirement): ExecutionTask[] {
        return requirement.taskIds
            .map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => Boolean(task && task.changeSet && taskProducesResult(task)))
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    }

    protected requirementDocumentId(requirementId: string): string {
        return `requirement:${requirementId}`;
    }

    protected set(document: TaskResultDocument, task?: ExecutionTask): void {
        this.documents.set(document.taskId, document);
        if (task) {
            task.resultsDocument = document;
        }
        if (this.taskService.get(document.taskId)?.status !== 'running') {
            this.taskService.setResultsDocument(document.taskId, document);
        }
        this.onDidChangeEmitter.fire(document);
    }

    protected setRequirementDocument(requirement: Requirement, document: TaskResultDocument): void {
        this.requirementService.setResultsDocument(requirement.id, document);
        this.onDidChangeEmitter.fire(document);
    }

    protected shouldGenerate(task: ExecutionTask): boolean {
        return Boolean(task.changeSet) && taskProducesResult(task);
    }
}
