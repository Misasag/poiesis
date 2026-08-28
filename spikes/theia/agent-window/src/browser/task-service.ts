import { Emitter, Event } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import {
    AgentRuntimeServer,
    GitChangeSetCapture,
    GitSnapshotCapture
} from '../common/agent-runtime-protocol';

export type ExecutionTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskBaseline {
    kind: 'workspace-snapshot';
    capturedAt: string;
}

export interface TaskChangeSet {
    source: 'task-diff' | 'empty';
    diff: string;
    files: string[];
    capturedAt: string;
    error?: string;
}

/** A successfully captured Change Set with no changed files or diff content. */
export function isEmptyTaskChangeSet(changeSet: TaskChangeSet | undefined): boolean {
    return changeSet?.source === 'empty'
        && !changeSet.error
        && changeSet.files.length === 0
        && !changeSet.diff.trim();
}

export interface TaskFailure {
    summary: string;
    details?: string;
}

export interface TaskResultsQuestion {
    question: string;
    answer?: string;
    error?: string;
    timestamp: string;
}

export interface ExecutionTask {
    id: string;
    sessionId: string;
    title: string;
    request: string;
    status: ExecutionTaskStatus;
    startedAt: string;
    endedAt?: string;
    baseline: TaskBaseline;
    changeSet?: TaskChangeSet;
    failure?: TaskFailure;
    resultsQuestions?: TaskResultsQuestion[];
}

export interface TaskEvent {
    type: 'started' | 'ended' | 'failed' | 'cancelled';
    task: ExecutionTask;
}

/** Application-owned lifecycle and workspace change-set boundary. */
@injectable()
export class TaskService {
    static readonly MAX_RESULTS_QUESTIONS_PER_TASK = 20;
    static readonly MAX_RESULTS_QUESTION_CHARS = 4_000;
    static readonly MAX_RESULTS_RESPONSE_CHARS = 12_000;
    protected readonly tasks = new Map<string, ExecutionTask>();
    protected readonly baselineCaptures = new Map<string, Promise<GitSnapshotCapture>>();
    protected readonly onDidChangeEmitter = new Emitter<TaskEvent>();
    readonly onDidChangeTask: Event<TaskEvent> = this.onDidChangeEmitter.event;
    protected sequence = 0;

    constructor(
        @inject(AgentRuntimeServer) protected readonly runtimeServer: AgentRuntimeServer,
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService
    ) { }

    start(sessionId: string, request: string, workspacePath?: string): ExecutionTask {
        const startedAt = new Date().toISOString();
        const task: ExecutionTask = {
            id: `task-${Date.now()}-${++this.sequence}`,
            sessionId,
            title: this.titleFor(request),
            request,
            status: 'running',
            startedAt,
            baseline: {
                kind: 'workspace-snapshot',
                capturedAt: startedAt
            }
        };
        this.tasks.set(task.id, task);
        this.baselineCaptures.set(task.id, this.captureBaseline(workspacePath));
        this.onDidChangeEmitter.fire({ type: 'started', task });
        return task;
    }

    failBeforeStart(sessionId: string, request: string, failure: TaskFailure): ExecutionTask {
        const startedAt = new Date().toISOString();
        const task: ExecutionTask = {
            id: `task-${Date.now()}-${++this.sequence}`,
            sessionId,
            title: this.titleFor(request),
            request,
            status: 'failed',
            startedAt,
            endedAt: startedAt,
            baseline: { kind: 'workspace-snapshot', capturedAt: startedAt },
            changeSet: {
                source: 'empty',
                diff: '',
                files: [],
                capturedAt: startedAt,
                error: 'Agent provider did not start; no workspace changes were made.'
            },
            failure
        };
        this.tasks.set(task.id, task);
        this.onDidChangeEmitter.fire({ type: 'failed', task });
        return task;
    }

    async end(taskId: string): Promise<ExecutionTask | undefined> {
        return this.finish(taskId, 'completed', 'ended');
    }

    async cancel(taskId: string): Promise<ExecutionTask | undefined> {
        return this.finish(taskId, 'cancelled', 'cancelled');
    }

    async fail(taskId: string, failure?: TaskFailure): Promise<ExecutionTask | undefined> {
        return this.finish(taskId, 'failed', 'failed', failure);
    }

    async whenBaselineCaptured(taskId: string): Promise<void> {
        await this.baselineCaptures.get(taskId);
    }

    get(taskId: string): ExecutionTask | undefined {
        return this.tasks.get(taskId);
    }

    list(sessionId?: string): ExecutionTask[] {
        return [...this.tasks.values()]
            .filter(task => !sessionId || task.sessionId === sessionId)
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    }

    restore(tasks: readonly ExecutionTask[]): ExecutionTask[] {
        const restored: ExecutionTask[] = [];
        for (const candidate of tasks) {
            if (!candidate
                || typeof candidate.id !== 'string'
                || typeof candidate.sessionId !== 'string'
                || typeof candidate.title !== 'string'
                || typeof candidate.request !== 'string'
                || typeof candidate.startedAt !== 'string'
                || !['running', 'completed', 'failed', 'cancelled'].includes(candidate.status)) {
                continue;
            }
            const resultsQuestions = Array.isArray(candidate.resultsQuestions)
                ? candidate.resultsQuestions.flatMap(entry => {
                    if (!entry
                        || typeof entry.question !== 'string'
                        || typeof entry.timestamp !== 'string'
                        || entry.answer !== undefined && typeof entry.answer !== 'string'
                        || entry.error !== undefined && typeof entry.error !== 'string'
                        || !entry.answer && !entry.error) {
                        return [];
                    }
                    return [{
                        question: entry.question.slice(0, TaskService.MAX_RESULTS_QUESTION_CHARS),
                        answer: entry.answer?.slice(0, TaskService.MAX_RESULTS_RESPONSE_CHARS),
                        error: entry.error?.slice(0, TaskService.MAX_RESULTS_RESPONSE_CHARS),
                        timestamp: entry.timestamp
                    }];
                }).slice(-TaskService.MAX_RESULTS_QUESTIONS_PER_TASK)
                : [];
            const task: ExecutionTask = candidate.status === 'running'
                ? {
                    ...candidate,
                    status: 'failed',
                    endedAt: new Date().toISOString(),
                    failure: { summary: 'アプリ終了により中断されました' },
                    resultsQuestions
                }
                : { ...candidate, resultsQuestions };
            this.tasks.set(task.id, task);
            restored.push(task);
        }
        return restored.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    }

    recordResultsQuestion(taskId: string, entry: TaskResultsQuestion): TaskResultsQuestion | undefined {
        const current = this.tasks.get(taskId);
        if (!current || current.status === 'running') {
            return undefined;
        }
        const stored: TaskResultsQuestion = {
            question: entry.question.slice(0, TaskService.MAX_RESULTS_QUESTION_CHARS),
            answer: entry.answer?.slice(0, TaskService.MAX_RESULTS_RESPONSE_CHARS),
            error: entry.error?.slice(0, TaskService.MAX_RESULTS_RESPONSE_CHARS),
            timestamp: entry.timestamp
        };
        const resultsQuestions = [...current.resultsQuestions ?? [], stored]
            .slice(-TaskService.MAX_RESULTS_QUESTIONS_PER_TASK);
        this.tasks.set(taskId, { ...current, resultsQuestions });
        return stored;
    }

    remove(taskIds: Iterable<string>): void {
        for (const taskId of taskIds) {
            this.tasks.delete(taskId);
            this.baselineCaptures.delete(taskId);
        }
    }

    removeSession(sessionId: string): string[] {
        const taskIds = this.list(sessionId).map(task => task.id);
        this.remove(taskIds);
        return taskIds;
    }

    protected async finish(
        taskId: string,
        status: Exclude<ExecutionTaskStatus, 'running'>,
        eventType: Extract<TaskEvent['type'], 'ended' | 'failed' | 'cancelled'>,
        failure?: TaskFailure
    ): Promise<ExecutionTask | undefined> {
        const current = this.tasks.get(taskId);
        if (!current || current.status !== 'running') {
            return current;
        }

        const capture = await this.captureChangeSet(taskId);
        const task: ExecutionTask = {
            ...current,
            status,
            endedAt: new Date().toISOString(),
            changeSet: {
                ...capture,
                capturedAt: new Date().toISOString()
            },
            failure
        };
        this.tasks.set(task.id, task);
        this.onDidChangeEmitter.fire({ type: eventType, task });
        return task;
    }

    protected async captureBaseline(workspacePath?: string): Promise<GitSnapshotCapture> {
        try {
            const root = this.workspaceService.tryGetRoots()[0]
                ?? (this.workspaceService.workspace?.isDirectory ? this.workspaceService.workspace : undefined);
            return await this.runtimeServer.captureGitSnapshot({
                workspacePath: workspacePath ?? root?.resource.path.fsPath()
            });
        } catch (error) {
            return {
                source: 'empty',
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    protected async captureChangeSet(taskId: string): Promise<GitChangeSetCapture> {
        const baselinePromise = this.baselineCaptures.get(taskId);
        this.baselineCaptures.delete(taskId);
        let baseline: GitSnapshotCapture | undefined;
        try {
            baseline = await baselinePromise;
        } catch (error) {
            return {
                source: 'empty',
                diff: '',
                files: [],
                error: error instanceof Error ? error.message : String(error)
            };
        }
        if (!baseline?.snapshotId) {
            return {
                source: 'empty',
                diff: '',
                files: [],
                error: baseline?.error ?? 'The Task baseline snapshot was not available.'
            };
        }
        try {
            return await this.runtimeServer.captureGitChangeSet({
                baselineSnapshotId: baseline.snapshotId
            });
        } catch (error) {
            return {
                source: 'empty',
                diff: '',
                files: [],
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    protected titleFor(request: string): string {
        const compact = request.replace(/\s+/g, ' ').trim();
        return compact.length > 46 ? `${compact.slice(0, 43)}…` : compact;
    }
}
