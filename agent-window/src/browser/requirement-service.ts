import { StorageService } from '@theia/core/lib/browser';
import { Emitter, Event } from '@theia/core/lib/common';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import {
    currentRequirementIdForTasks,
    migrateRequirementModel,
    moveTaskInRequirementModel,
    removeTaskFromRequirementModel,
    Requirement,
    RequirementTitleSource,
    splitTaskInRequirementModel
} from './requirement-model';
import { ExecutionTask, TaskResultDocument, TaskResultsQuestion, TaskService } from './task-service';

const REQUIREMENTS_STORAGE_KEY = 'poiesis.requirements.sessions.v1';

interface PersistedRequirements {
    version: 1;
    sessions: Record<string, Requirement[]>;
}

export interface RequirementChangeEvent {
    type: 'created' | 'renamed' | 'tasks-changed' | 'removed' | 'document-changed' | 'questions-changed';
    requirementIds: string[];
}

@injectable()
export class RequirementService {
    static readonly MAX_RESULTS_QUESTIONS = 20;
    protected readonly requirements = new Map<string, Requirement>();
    protected readonly onDidChangeEmitter = new Emitter<RequirementChangeEvent>();
    readonly onDidChange: Event<RequirementChangeEvent> = this.onDidChangeEmitter.event;
    protected sequence = 0;
    protected loading: Promise<void> = Promise.resolve();
    protected persistence: Promise<void> = Promise.resolve();

    constructor(
        @inject(TaskService) protected readonly taskService: TaskService,
        @inject(StorageService) protected readonly storageService: StorageService
    ) { }

    @postConstruct()
    protected init(): void {
        this.loading = this.storageService.getData<Partial<PersistedRequirements>>(REQUIREMENTS_STORAGE_KEY, {})
            .then(state => {
                if (state?.version !== 1 || !state.sessions || typeof state.sessions !== 'object') {
                    return;
                }
                for (const candidates of Object.values(state.sessions)) {
                    if (!Array.isArray(candidates)) {
                        continue;
                    }
                    for (const requirement of candidates) {
                        if (requirement && typeof requirement.id === 'string') {
                            this.requirements.set(requirement.id, this.normalize(requirement));
                        }
                    }
                }
            }).catch(error => console.warn('[Poiesis] Could not restore Requirements.', error));
        this.taskService.onDidChangeTask(event => {
            if (event.type === 'started' || !this.requirements.has(event.task.requirementId)) {
                this.attachTask(event.task);
            }
        });
        this.taskService.onDidRemoveTask(task => this.detachTask(task));
    }

    async restore(tasks: readonly ExecutionTask[]): Promise<Requirement[]> {
        await this.loading;
        const migrated = migrateRequirementModel(tasks, [...this.requirements.values()], () => this.nextId());
        this.requirements.clear();
        for (const requirement of migrated.requirements) {
            this.requirements.set(requirement.id, requirement);
        }
        for (const [taskId, requirementId] of migrated.assignments) {
            this.taskService.setRequirementId(taskId, requirementId);
        }
        await this.persist();
        return this.list();
    }

    create(sessionId: string, title: string): Requirement {
        const now = new Date().toISOString();
        const requirement: Requirement = {
            id: this.nextId(),
            sessionId,
            title: title.trim() || '新しい要件',
            titleSource: 'task',
            createdAt: now,
            updatedAt: now,
            taskIds: []
        };
        this.requirements.set(requirement.id, requirement);
        this.changed('created', [requirement.id]);
        return requirement;
    }

    rename(id: string, title: string, source: RequirementTitleSource = 'user'): Requirement | undefined {
        const current = this.requirements.get(id);
        const normalizedTitle = title.trim();
        if (!current || !normalizedTitle || source === 'ai' && current.titleSource === 'user') {
            return current;
        }
        const updated = { ...current, title: normalizedTitle, titleSource: source, updatedAt: new Date().toISOString() };
        this.requirements.set(id, updated);
        this.changed('renamed', [id]);
        return updated;
    }

    get(id: string): Requirement | undefined {
        return this.requirements.get(id);
    }

    list(): Requirement[] {
        return [...this.requirements.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    }

    listForSession(sessionId: string): Requirement[] {
        return this.list().filter(requirement => requirement.sessionId === sessionId);
    }

    moveTask(taskId: string, targetRequirementId: string): Requirement | undefined {
        const task = this.taskService.get(taskId);
        const previousId = task?.requirementId;
        if (!task || previousId === targetRequirementId) {
            return this.requirements.get(targetRequirementId);
        }
        const result = moveTaskInRequirementModel(
            [...this.requirements.values()],
            this.taskService.list(),
            taskId,
            targetRequirementId
        );
        if (result.assignments.get(taskId) !== targetRequirementId) {
            return undefined;
        }
        this.replace(result.requirements);
        this.taskService.setRequirementId(taskId, targetRequirementId);
        this.changed('tasks-changed', [...new Set([previousId, targetRequirementId].filter(Boolean) as string[])]);
        return this.requirements.get(targetRequirementId);
    }

    splitTaskToNew(taskId: string): Requirement | undefined {
        const task = this.taskService.get(taskId);
        if (!task) {
            return undefined;
        }
        const previousId = task.requirementId;
        const result = splitTaskInRequirementModel(
            [...this.requirements.values()],
            this.taskService.list(),
            taskId,
            () => this.nextId()
        );
        const targetId = result.assignments.get(taskId);
        if (!targetId) {
            return undefined;
        }
        this.replace(result.requirements);
        this.taskService.setRequirementId(taskId, targetId);
        this.changed('tasks-changed', [...new Set([previousId, targetId].filter(Boolean))]);
        return this.requirements.get(targetId);
    }

    currentRequirementId(sessionId: string): string | undefined {
        return currentRequirementIdForTasks(this.taskService.list(sessionId));
    }

    remove(id: string): boolean {
        const requirement = this.requirements.get(id);
        if (!requirement || requirement.taskIds.length > 0) {
            return false;
        }
        this.requirements.delete(id);
        this.changed('removed', [id]);
        return true;
    }

    setResultsDocument(id: string, document: TaskResultDocument | undefined): Requirement | undefined {
        const current = this.requirements.get(id);
        if (!current) {
            return undefined;
        }
        const updated = { ...current, resultsDocument: document, updatedAt: new Date().toISOString() };
        this.requirements.set(id, updated);
        this.changed('document-changed', [id]);
        return updated;
    }

    recordResultsQuestion(id: string, entry: TaskResultsQuestion): TaskResultsQuestion | undefined {
        const current = this.requirements.get(id);
        if (!current) {
            return undefined;
        }
        const stored: TaskResultsQuestion = {
            question: entry.question.slice(0, TaskService.MAX_RESULTS_QUESTION_CHARS),
            answer: entry.answer?.slice(0, TaskService.MAX_RESULTS_RESPONSE_CHARS),
            error: entry.error?.slice(0, TaskService.MAX_RESULTS_RESPONSE_CHARS),
            timestamp: entry.timestamp
        };
        this.requirements.set(id, {
            ...current,
            resultsQuestions: [...current.resultsQuestions ?? [], stored].slice(-RequirementService.MAX_RESULTS_QUESTIONS),
            updatedAt: new Date().toISOString()
        });
        this.changed('questions-changed', [id]);
        return stored;
    }

    protected attachTask(task: ExecutionTask): void {
        let requirement = this.requirements.get(task.requirementId);
        if (!requirement || requirement.sessionId !== task.sessionId) {
            requirement = this.create(task.sessionId, task.title);
            this.taskService.setRequirementId(task.id, requirement.id);
        }
        if (requirement.taskIds.includes(task.id)) {
            return;
        }
        this.requirements.set(requirement.id, {
            ...requirement,
            taskIds: [...requirement.taskIds, task.id],
            updatedAt: new Date().toISOString()
        });
        this.changed('tasks-changed', [requirement.id]);
    }

    protected detachTask(task: ExecutionTask): void {
        const before = [...this.requirements.values()];
        const after = removeTaskFromRequirementModel(before, task.id);
        const affected = before.filter(requirement => requirement.taskIds.includes(task.id)).map(requirement => requirement.id);
        if (!affected.length) {
            return;
        }
        this.replace(after);
        this.changed('tasks-changed', affected);
    }

    protected replace(requirements: readonly Requirement[]): void {
        this.requirements.clear();
        for (const requirement of requirements) {
            this.requirements.set(requirement.id, requirement);
        }
    }

    protected normalize(requirement: Requirement): Requirement {
        return {
            ...requirement,
            title: typeof requirement.title === 'string' && requirement.title.trim() ? requirement.title.trim() : '要件',
            titleSource: requirement.titleSource === 'ai' || requirement.titleSource === 'user' ? requirement.titleSource : 'task',
            taskIds: Array.isArray(requirement.taskIds)
                ? [...new Set(requirement.taskIds.filter(id => typeof id === 'string'))]
                : [],
            resultsQuestions: Array.isArray(requirement.resultsQuestions)
                ? requirement.resultsQuestions.slice(-RequirementService.MAX_RESULTS_QUESTIONS)
                : undefined
        };
    }

    protected nextId(): string {
        return `requirement-${Date.now()}-${++this.sequence}`;
    }

    protected changed(type: RequirementChangeEvent['type'], requirementIds: string[]): void {
        void this.persist();
        this.onDidChangeEmitter.fire({ type, requirementIds });
    }

    protected persist(): Promise<void> {
        const sessions: Record<string, Requirement[]> = {};
        for (const requirement of this.requirements.values()) {
            (sessions[requirement.sessionId] ??= []).push(requirement);
        }
        const state: PersistedRequirements = { version: 1, sessions };
        this.persistence = this.persistence.catch(() => undefined)
            .then(() => this.storageService.setData(REQUIREMENTS_STORAGE_KEY, state))
            .catch(error => console.warn('[Poiesis] Could not persist Requirements.', error));
        return this.persistence;
    }
}
