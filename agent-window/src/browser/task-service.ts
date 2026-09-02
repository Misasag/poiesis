import { StorageService } from '@theia/core/lib/browser';
import { Disposable, Emitter, Event } from '@theia/core/lib/common';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import {
    AgentRuntimeServer,
    GitChangeSetCapture,
    GitSnapshotCapture
} from '../common/agent-runtime-protocol';
import type { AgentActivity, AgentActivityKind } from '../common/agent-provider';

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

export interface TaskChangedFileSummary {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    additions: number;
    deletions: number;
}

export interface TaskDiffStat {
    files: TaskChangedFileSummary[];
    fileCount: number;
    additions: number;
    deletions: number;
}

/** Application-owned diffstat used by both Results chrome and built-in fallback content. */
export function summarizeTaskChangeSet(changeSet: TaskChangeSet | undefined): TaskDiffStat {
    if (!changeSet) {
        return { files: [], fileCount: 0, additions: 0, deletions: 0 };
    }
    const chunks = changeSet.diff.split(/(?=^diff --git )/m).filter(chunk => chunk.startsWith('diff --git '));
    const files = changeSet.files.map((path, index) => {
        const normalizedPath = path.replace(/\\/g, '/');
        const chunk = chunks.find(candidate => candidate.includes(` a/${normalizedPath} b/${normalizedPath}`))
            ?? chunks[index]
            ?? '';
        const additions = chunk.split(/\r?\n/).filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
        const deletions = chunk.split(/\r?\n/).filter(line => line.startsWith('-') && !line.startsWith('---')).length;
        const status = /^new file mode\b/m.test(chunk) || /^--- \/dev\/null$/m.test(chunk)
            ? 'added' as const
            : /^deleted file mode\b/m.test(chunk) || /^\+\+\+ \/dev\/null$/m.test(chunk)
                ? 'deleted' as const
                : 'modified' as const;
        return { path: normalizedPath, status, additions, deletions };
    });
    return {
        files,
        fileCount: files.length,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0)
    };
}

/** One request-title rule shared by Task storage, the Results rail, and Results chrome. */
export function taskTitleForRequest(request: string): string {
    const compact = request.replace(/\s+/g, ' ').trim();
    return compact.length > 46 ? `${compact.slice(0, 43)}…` : compact;
}

/** Application-owned completion timestamp. Results Skills never receive or format this value. */
export function formatTaskEndedAtJst(value: string | undefined): string {
    const date = value ? new Date(value) : undefined;
    if (!date || Number.isNaN(date.getTime())) {
        return '';
    }
    const parts = new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: 'Asia/Tokyo'
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find(candidate => candidate.type === type)?.value ?? '';
    return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')} JST`;
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

export interface TaskResultDocument {
    taskId: string;
    status: 'generating' | 'ready' | 'failed';
    html?: string;
    error?: string;
    generator?: 'ai' | 'template' | 'fallback';
    fallbackReason?: string;
    generatedAt?: string;
    durationMs?: number;
}

export interface ExecutionTask {
    id: string;
    sessionId: string;
    title: string;
    request: string;
    status: ExecutionTaskStatus;
    startedAt: string;
    endedAt?: string;
    completionSummary?: string;
    /** Full implementer handoff for Results; never rendered directly in Agent conversation. */
    implementerReport?: string;
    baseline: TaskBaseline;
    changeSet?: TaskChangeSet;
    failure?: TaskFailure;
    activities?: AgentActivity[];
    appliedSkills?: { agent: string[]; results: string[] };
    resultsQuestions?: TaskResultsQuestion[];
    /** New Results documents are persisted with their owning Task. */
    resultsDocument?: TaskResultDocument;
}

export interface TaskEvent {
    type: 'started' | 'ended' | 'failed' | 'cancelled';
    task: ExecutionTask;
}

export const RESULTS_QUESTION_HISTORY_STORAGE_KEY = 'poiesis.results-question.sessions.v1';

interface PersistedResultsQuestionHistory {
    version: 1;
    sessions: Record<string, Record<string, TaskResultsQuestion[]>>;
}

/** Application-owned lifecycle and workspace change-set boundary. */
@injectable()
export class TaskService {
    static readonly MAX_ACTIVITIES_PER_TASK = 300;
    static readonly MAX_ACTIVITY_DETAIL_CHARS = 2_000;
    static readonly MAX_RESULTS_QUESTIONS_PER_TASK = 20;
    static readonly MAX_RESULTS_QUESTION_CHARS = 4_000;
    static readonly MAX_RESULTS_RESPONSE_CHARS = 12_000;
    protected readonly tasks = new Map<string, ExecutionTask>();
    protected readonly baselineCaptures = new Map<string, Promise<GitSnapshotCapture>>();
    protected readonly terminalFinalizers = new Set<(task: ExecutionTask) => Promise<void>>();
    protected readonly finalizingTaskIds = new Set<string>();
    protected readonly persistedResultsQuestions = new Map<string, Map<string, TaskResultsQuestion[]>>();
    protected readonly onDidChangeEmitter = new Emitter<TaskEvent>();
    readonly onDidChangeTask: Event<TaskEvent> = this.onDidChangeEmitter.event;
    protected sequence = 0;
    protected resultsQuestionHistoryLoading: Promise<void> = Promise.resolve();
    protected resultsQuestionHistoryPersistence: Promise<void> = Promise.resolve();

    constructor(
        @inject(AgentRuntimeServer) protected readonly runtimeServer: AgentRuntimeServer,
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService,
        @inject(StorageService) protected readonly storageService: StorageService
    ) { }

    @postConstruct()
    protected loadResultsQuestionHistory(): void {
        this.resultsQuestionHistoryLoading = this.storageService
            .getData<Partial<PersistedResultsQuestionHistory>>(RESULTS_QUESTION_HISTORY_STORAGE_KEY, {})
            .then(state => {
                if (state?.version !== 1 || !state.sessions || typeof state.sessions !== 'object') {
                    return;
                }
                for (const [sessionId, byTask] of Object.entries(state.sessions)) {
                    const sessionHistory = this.normalizeResultsQuestionTasks(byTask);
                    if (sessionHistory.size > 0) {
                        this.persistedResultsQuestions.set(sessionId, sessionHistory);
                    }
                }
                this.applyPersistedResultsQuestions();
            })
            .catch(error => {
                console.warn('[Poiesis] Could not restore Results question history.', error);
            });
    }

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

    async failBeforeStart(sessionId: string, request: string, failure: TaskFailure): Promise<ExecutionTask> {
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
        await this.finalizeTerminalTask(task, 'failed');
        return task;
    }

    async end(taskId: string, completionSummary?: string): Promise<ExecutionTask | undefined> {
        return this.finish(taskId, 'completed', 'ended', undefined, completionSummary);
    }

    async cancel(taskId: string): Promise<ExecutionTask | undefined> {
        return this.finish(taskId, 'cancelled', 'cancelled');
    }

    async fail(taskId: string, failure?: TaskFailure): Promise<ExecutionTask | undefined> {
        return this.finish(taskId, 'failed', 'failed', failure);
    }

    setResultsDocument(taskId: string, document: TaskResultDocument | undefined): ExecutionTask | undefined {
        const current = this.tasks.get(taskId);
        if (!current || document && document.taskId !== taskId) {
            return current;
        }
        const updated = { ...current, resultsDocument: document };
        this.tasks.set(taskId, updated);
        return updated;
    }

    recordActivity(taskId: string, incoming: AgentActivity): ExecutionTask | undefined {
        const current = this.tasks.get(taskId);
        const activity = this.normalizeActivity(incoming);
        if (!current || !activity) {
            return current;
        }
        const activities = [...current.activities ?? []];
        const existing = activities.findIndex(candidate => candidate.id === activity.id);
        if (existing >= 0) {
            activities[existing] = activity;
        } else {
            activities.push(activity);
        }
        while (activities.length > TaskService.MAX_ACTIVITIES_PER_TASK) {
            const disposable = activities.findIndex(candidate => candidate.kind === 'reasoning' || candidate.kind === 'message');
            activities.splice(disposable >= 0 ? disposable : 0, 1);
        }
        const updated = { ...current, activities };
        this.tasks.set(taskId, updated);
        return updated;
    }

    setAppliedSkills(taskId: string, role: 'agent' | 'results', ids: readonly string[]): ExecutionTask | undefined {
        const current = this.tasks.get(taskId);
        if (!current) {
            return undefined;
        }
        const normalizedIds = [...new Set(ids.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
        const updated: ExecutionTask = {
            ...current,
            appliedSkills: {
                agent: [...current.appliedSkills?.agent ?? []],
                results: [...current.appliedSkills?.results ?? []],
                [role]: normalizedIds
            }
        };
        this.tasks.set(taskId, updated);
        return updated;
    }

    registerTerminalFinalizer(finalizer: (task: ExecutionTask) => Promise<void>): Disposable {
        this.terminalFinalizers.add(finalizer);
        return Disposable.create(() => this.terminalFinalizers.delete(finalizer));
    }

    isFinalizing(taskId: string): boolean {
        return this.finalizingTaskIds.has(taskId);
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
            const legacyResultsQuestions = this.normalizeResultsQuestions(candidate.resultsQuestions);
            const resultsQuestions = this.persistedResultsQuestions
                .get(candidate.sessionId)?.get(candidate.id)
                ?? legacyResultsQuestions;
            const resultsDocument = this.normalizeResultsDocument(candidate.resultsDocument, candidate.id);
            const activities = this.normalizeActivities(candidate.activities);
            const appliedSkills = this.normalizeAppliedSkills(candidate.appliedSkills);
            const task: ExecutionTask = candidate.status === 'running'
                ? {
                    ...candidate,
                    status: 'failed',
                    endedAt: new Date().toISOString(),
                    failure: { summary: 'アプリ終了により中断されました' },
                    activities,
                    appliedSkills,
                    resultsQuestions,
                    resultsDocument
                }
                : { ...candidate, activities, appliedSkills, resultsQuestions, resultsDocument };
            this.tasks.set(task.id, task);
            if (legacyResultsQuestions.length > 0) {
                this.migrateLegacyResultsQuestions(task.sessionId, task.id, legacyResultsQuestions);
            }
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
        this.storeResultsQuestion(current.sessionId, taskId, stored);
        return stored;
    }

    remove(taskIds: Iterable<string>): void {
        for (const taskId of taskIds) {
            if (this.finalizingTaskIds.has(taskId)) {
                continue;
            }
            const task = this.tasks.get(taskId);
            this.tasks.delete(taskId);
            this.baselineCaptures.delete(taskId);
            if (task) {
                this.removePersistedResultsQuestion(task.sessionId, taskId);
            }
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
        failure?: TaskFailure,
        completionSummary?: string
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
            completionSummary: status === 'completed'
                ? this.completionReport(completionSummary, capture.files)
                : undefined,
            implementerReport: status === 'completed'
                ? completionSummary?.trim().slice(0, 12_000) || undefined
                : undefined,
            failure
        };
        await this.finalizeTerminalTask(task, eventType);
        return task;
    }

    protected async finalizeTerminalTask(
        task: ExecutionTask,
        eventType: Extract<TaskEvent['type'], 'ended' | 'failed' | 'cancelled'>
    ): Promise<void> {
        this.tasks.set(task.id, task);
        this.finalizingTaskIds.add(task.id);
        try {
            for (const finalizer of this.terminalFinalizers) {
                try {
                    await finalizer(task);
                } catch (error) {
                    console.warn('[Poiesis] A Task terminal finalizer failed.', error);
                }
            }
        } finally {
            this.finalizingTaskIds.delete(task.id);
        }
        this.onDidChangeEmitter.fire({ type: eventType, task });
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
        return taskTitleForRequest(request);
    }

    protected completionReport(raw: string | undefined, files: readonly string[]): string {
        const firstContentLine = (raw ?? '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .find(line => line && !/^```/.test(line));
        const compact = (firstContentLine ?? 'タスクを完了しました。')
            .replace(/^#{1,6}\s+/, '')
            .replace(/^[-*+]\s+/, '')
            .replace(/\s+/g, ' ')
            .trim();
        const summary = compact.length > 140 ? `${compact.slice(0, 139)}…` : compact;
        const visibleFiles = files.slice(0, 5).map(path => path.replace(/\\/g, '/'));
        const remaining = files.length - visibleFiles.length;
        const fileSummary = visibleFiles.length > 0
            ? `変更ファイル: ${visibleFiles.join(', ')}${remaining > 0 ? `、ほか${remaining}件` : ''}。`
            : '変更ファイル: なし。';
        return `${summary}\n${fileSummary} 詳細は Results を確認してください。`;
    }

    protected normalizeResultsDocument(
        document: TaskResultDocument | undefined,
        taskId: string
    ): TaskResultDocument | undefined {
        if (!document
            || document.taskId !== taskId
            || !['ready', 'failed'].includes(document.status)
            || document.status === 'ready' && typeof document.html !== 'string') {
            return undefined;
        }
        return document;
    }

    protected normalizeActivities(activities: readonly AgentActivity[] | undefined): AgentActivity[] | undefined {
        if (!Array.isArray(activities)) {
            return undefined;
        }
        const normalized = activities.flatMap(activity => {
            const candidate = this.normalizeActivity(activity);
            return candidate ? [candidate] : [];
        });
        while (normalized.length > TaskService.MAX_ACTIVITIES_PER_TASK) {
            const disposable = normalized.findIndex(activity => activity.kind === 'reasoning' || activity.kind === 'message');
            normalized.splice(disposable >= 0 ? disposable : 0, 1);
        }
        return normalized.length ? normalized : undefined;
    }

    protected normalizeActivity(activity: AgentActivity | undefined): AgentActivity | undefined {
        const kinds = new Set<AgentActivityKind>(['command', 'file-change', 'read', 'reasoning', 'message', 'tool']);
        if (!activity
            || typeof activity.id !== 'string'
            || !kinds.has(activity.kind)
            || typeof activity.title !== 'string'
            || !['running', 'completed', 'failed'].includes(activity.status)
            || typeof activity.startedAt !== 'string'
            || !Number.isFinite(Date.parse(activity.startedAt))) {
            return undefined;
        }
        return {
            id: activity.id,
            kind: activity.kind,
            title: activity.title,
            detail: typeof activity.detail === 'string'
                ? activity.detail.slice(0, TaskService.MAX_ACTIVITY_DETAIL_CHARS)
                : undefined,
            status: activity.status,
            startedAt: activity.startedAt,
            endedAt: typeof activity.endedAt === 'string' && Number.isFinite(Date.parse(activity.endedAt))
                ? activity.endedAt
                : undefined
        };
    }

    protected normalizeAppliedSkills(
        appliedSkills: ExecutionTask['appliedSkills'] | undefined
    ): ExecutionTask['appliedSkills'] | undefined {
        if (!appliedSkills || !Array.isArray(appliedSkills.agent) || !Array.isArray(appliedSkills.results)) {
            return undefined;
        }
        const normalize = (ids: readonly string[]): string[] =>
            [...new Set(ids.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
        return { agent: normalize(appliedSkills.agent), results: normalize(appliedSkills.results) };
    }

    protected normalizeResultsQuestionTasks(
        byTask: Readonly<Record<string, readonly TaskResultsQuestion[]>> | undefined
    ): Map<string, TaskResultsQuestion[]> {
        const normalized = new Map<string, TaskResultsQuestion[]>();
        if (!byTask || typeof byTask !== 'object') {
            return normalized;
        }
        for (const [taskId, entries] of Object.entries(byTask)) {
            const history = this.normalizeResultsQuestions(entries);
            if (history.length > 0) {
                normalized.set(taskId, history);
            }
        }
        return normalized;
    }

    protected normalizeResultsQuestions(entries: readonly TaskResultsQuestion[] | undefined): TaskResultsQuestion[] {
        if (!Array.isArray(entries)) {
            return [];
        }
        return entries.flatMap(entry => {
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
        }).slice(-TaskService.MAX_RESULTS_QUESTIONS_PER_TASK);
    }

    protected applyPersistedResultsQuestions(): void {
        for (const task of this.tasks.values()) {
            const history = this.persistedResultsQuestions.get(task.sessionId)?.get(task.id);
            if (history) {
                task.resultsQuestions = [...history];
            }
        }
    }

    protected storeResultsQuestion(sessionId: string, taskId: string, entry: TaskResultsQuestion): void {
        void this.resultsQuestionHistoryLoading.then(() => {
            let sessionHistory = this.persistedResultsQuestions.get(sessionId);
            if (!sessionHistory) {
                sessionHistory = new Map();
                this.persistedResultsQuestions.set(sessionId, sessionHistory);
            }
            const history = [...sessionHistory.get(taskId) ?? [], entry]
                .slice(-TaskService.MAX_RESULTS_QUESTIONS_PER_TASK);
            sessionHistory.set(taskId, history);
            const task = this.tasks.get(taskId);
            if (task) {
                task.resultsQuestions = [...history];
            }
            return this.persistResultsQuestionHistory();
        }).catch(error => {
            console.warn('[Poiesis] Could not persist Results question history.', error);
        });
    }

    protected migrateLegacyResultsQuestions(
        sessionId: string,
        taskId: string,
        history: TaskResultsQuestion[]
    ): void {
        void this.resultsQuestionHistoryLoading.then(() => {
            let sessionHistory = this.persistedResultsQuestions.get(sessionId);
            if (!sessionHistory) {
                sessionHistory = new Map();
                this.persistedResultsQuestions.set(sessionId, sessionHistory);
            }
            if (sessionHistory.has(taskId)) {
                return;
            }
            sessionHistory.set(taskId, history);
            return this.persistResultsQuestionHistory();
        }).catch(error => {
            console.warn('[Poiesis] Could not migrate Results question history.', error);
        });
    }

    protected removePersistedResultsQuestion(sessionId: string, taskId: string): void {
        void this.resultsQuestionHistoryLoading.then(() => {
            const sessionHistory = this.persistedResultsQuestions.get(sessionId);
            if (!sessionHistory?.delete(taskId)) {
                return;
            }
            if (sessionHistory.size === 0) {
                this.persistedResultsQuestions.delete(sessionId);
            }
            return this.persistResultsQuestionHistory();
        }).catch(error => {
            console.warn('[Poiesis] Could not remove Results question history.', error);
        });
    }

    protected persistResultsQuestionHistory(): Promise<void> {
        const state: PersistedResultsQuestionHistory = {
            version: 1,
            sessions: Object.fromEntries([...this.persistedResultsQuestions].map(([sessionId, byTask]) => [
                sessionId,
                Object.fromEntries([...byTask].map(([taskId, history]) => [taskId, history]))
            ]))
        };
        this.resultsQuestionHistoryPersistence = this.resultsQuestionHistoryPersistence
            .catch(() => undefined)
            .then(() => this.storageService.setData(
                RESULTS_QUESTION_HISTORY_STORAGE_KEY,
                Object.keys(state.sessions).length > 0 ? state : undefined
            ));
        return this.resultsQuestionHistoryPersistence;
    }
}
