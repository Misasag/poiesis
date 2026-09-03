import { Emitter, Event } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
    RequirementClassificationScope,
    RequirementClassificationServer,
    RequirementTitleSuggestionScope
} from '../common/requirement-classification-protocol';
import {
    heuristicDecision,
    INVALID_CLASSIFICATION_REASON,
    parseClassification,
    parseSuggestedRequirementTitle,
    shouldClassify
} from './requirement-classifier';
import { shortRequirementTitleFallback } from './results-assertions';
import { RequirementService } from './requirement-service';
import { ResultsGenerationContext } from './results-generation-context';
import {
    ExecutionTask,
    isNoChangeTask,
    TaskRequirementClassification,
    TaskService
} from './task-service';

@injectable()
export class RequirementClassificationService {
    enabled = true;
    protected readonly classifyingTaskIds = new Set<string>();
    protected readonly suggestingTitleTaskIds = new Set<string>();
    protected readonly onDidClassifyEmitter = new Emitter<ExecutionTask>();
    readonly onDidClassify: Event<ExecutionTask> = this.onDidClassifyEmitter.event;

    constructor(
        @inject(RequirementClassificationServer) protected readonly server: RequirementClassificationServer,
        @inject(TaskService) protected readonly taskService: TaskService,
        @inject(RequirementService) protected readonly requirementService: RequirementService,
        @inject(ResultsGenerationContext) protected readonly resultsContext: ResultsGenerationContext
    ) { }

    async classify(taskId: string): Promise<void> {
        const task = this.taskService.get(taskId);
        if (!task || isNoChangeTask(task) || task.requirementClassification || this.classifyingTaskIds.has(taskId)) {
            return;
        }
        this.classifyingTaskIds.add(taskId);
        try {
            const requirement = this.requirementService.get(task.requirementId);
            const requirementTasks = requirement?.taskIds
                .map(id => this.taskService.get(id))
                .filter((candidate): candidate is ExecutionTask => Boolean(candidate && !isNoChangeTask(candidate)));
            const workspaceIsLocal = isLocalWorkspace(task.workspaceUri);
            if (!shouldClassify(task, requirement ? {
                taskIds: requirement.taskIds,
                tasks: requirementTasks
            } : undefined, {
                enabled: this.enabled,
                workspaceIsLocal
            })) {
                this.record(task.id, {
                    decision: 'continue',
                    source: 'skipped',
                    reason: this.skipReason(task, requirementTasks, workspaceIsLocal),
                    decidedAt: new Date().toISOString()
                });
                return;
            }

            const previousTasks = requirementTasks!
                .filter(candidate => candidate.id !== task.id
                    && candidate.status !== 'running'
                    && candidate.startedAt < task.startedAt)
                .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
            const requirementFiles = [...new Set(previousTasks.flatMap(candidate => candidate.changeSet?.files ?? []))];
            const heuristic = heuristicDecision(task.changeSet!.files, requirementFiles, task.request);
            if (heuristic) {
                this.record(task.id, {
                    ...heuristic,
                    source: 'heuristic',
                    decidedAt: new Date().toISOString()
                });
                return;
            }

            const scope: RequirementClassificationScope = {
                taskId: task.id,
                providerId: this.resultsContext.providerId,
                model: this.resultsContext.model.trim() || undefined,
                effort: this.resultsContext.effort || undefined,
                workspaceUri: task.workspaceUri!,
                currentRequirementTitle: requirement!.title,
                previousTasks: previousTasks.map(candidate => ({
                    request: candidate.request.slice(0, 600),
                    changedFiles: [...candidate.changeSet?.files ?? []]
                })),
                task: {
                    request: task.request,
                    completionSummary: task.completionSummary?.slice(0, 2_000),
                    changedFiles: [...task.changeSet!.files]
                }
            };
            const result = await this.server.classify(scope);
            if (result.status === 'failed') {
                console.warn('[Poiesis][Requirement classification] Classification failed.',
                    `${result.error.code}: ${result.error.message}`);
                this.record(task.id, {
                    decision: 'continue',
                    source: 'ai',
                    reason: result.error.code.slice(0, 300),
                    decidedAt: new Date().toISOString()
                });
                return;
            }

            const parsed = parseClassification(result.output);
            if (parsed.reason === INVALID_CLASSIFICATION_REASON) {
                console.warn('[Poiesis][Requirement classification] Could not parse the AI response.');
            }
            if (parsed.decision === 'continue') {
                this.record(task.id, {
                    decision: 'continue',
                    source: 'ai',
                    confidence: parsed.confidence,
                    reason: parsed.reason,
                    decidedAt: new Date().toISOString()
                });
                return;
            }

            const currentTask = this.taskService.get(task.id);
            if (!this.enabled || currentTask?.requirementId !== task.requirementId) {
                this.record(task.id, {
                    decision: 'continue',
                    source: 'skipped',
                    confidence: parsed.confidence,
                    reason: this.enabled ? 'requirement-changed' : 'setting-off',
                    decidedAt: new Date().toISOString()
                });
                return;
            }
            const previousRequirementId = task.requirementId;
            const split = this.requirementService.splitTaskToNew(task.id);
            if (!split) {
                console.warn('[Poiesis][Requirement classification] Could not apply the classified split.');
                this.record(task.id, {
                    decision: 'continue',
                    source: 'ai',
                    confidence: parsed.confidence,
                    reason: 'split-failed',
                    decidedAt: new Date().toISOString()
                });
                return;
            }
            this.requirementService.rename(split.id, parsed.title || task.title, 'ai');
            this.record(task.id, {
                decision: 'new',
                source: 'ai',
                confidence: parsed.confidence,
                reason: parsed.reason,
                decidedAt: new Date().toISOString(),
                appliedNewRequirementId: split.id,
                previousRequirementId
            });
        } catch (error) {
            console.warn('[Poiesis][Requirement classification] Classification failed unexpectedly.', error);
            if (!this.taskService.get(taskId)?.requirementClassification) {
                this.record(taskId, {
                    decision: 'continue',
                    source: 'ai',
                    reason: 'internal-error',
                    decidedAt: new Date().toISOString()
                });
            }
        } finally {
            this.classifyingTaskIds.delete(taskId);
        }
    }

    async suggestTitle(taskId: string): Promise<void> {
        const task = this.taskService.get(taskId);
        if (!task
            || task.status !== 'completed'
            || !task.changeSet
            || isNoChangeTask(task)
            || this.suggestingTitleTaskIds.has(taskId)) {
            return;
        }
        const requirement = this.requirementService.get(task.requirementId);
        const firstTaskId = requirement?.taskIds
            .map(id => this.taskService.get(id))
            .filter((candidate): candidate is ExecutionTask => Boolean(candidate && !isNoChangeTask(candidate)))
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt))[0]?.id;
        if (!requirement
            || firstTaskId !== task.id
            || requirement.title !== task.title
            || requirement.titleSource === 'user') {
            return;
        }

        this.suggestingTitleTaskIds.add(taskId);
        const originalTitle = task.title;
        try {
            let suggested: string | undefined;
            if (isLocalWorkspace(task.workspaceUri)) {
                const scope: RequirementTitleSuggestionScope = {
                    taskId: task.id,
                    providerId: this.resultsContext.providerId,
                    model: this.resultsContext.model.trim() || undefined,
                    effort: this.resultsContext.effort || undefined,
                    workspaceUri: task.workspaceUri!,
                    request: task.request,
                    completionSummary: task.completionSummary?.slice(0, 2_000),
                    changedFiles: [...task.changeSet.files]
                };
                const result = await this.server.suggestTitle(scope);
                if (result.status === 'suggested') {
                    suggested = parseSuggestedRequirementTitle(result.output);
                    if (!suggested) {
                        console.warn('[Poiesis][Requirement title] Could not parse the AI response; using the fallback title.');
                    }
                } else {
                    console.warn('[Poiesis][Requirement title] Suggestion failed; using the fallback title.',
                        `${result.error.code}: ${result.error.message}`);
                }
            }
            const title = suggested ?? shortRequirementTitleFallback(originalTitle);
            const current = this.requirementService.get(task.requirementId);
            if (current
                && current.title === originalTitle
                && current.titleSource !== 'user'
                && current.taskIds.includes(task.id)) {
                this.requirementService.rename(current.id, title, 'ai');
            }
        } catch (error) {
            console.warn('[Poiesis][Requirement title] Suggestion failed unexpectedly; using the fallback title.', error);
            const current = this.requirementService.get(task.requirementId);
            if (current && current.title === originalTitle && current.titleSource !== 'user') {
                this.requirementService.rename(current.id, shortRequirementTitleFallback(originalTitle), 'ai');
            }
        } finally {
            this.suggestingTitleTaskIds.delete(taskId);
        }
    }

    undo(taskId: string): boolean {
        const task = this.taskService.get(taskId);
        const classification = task?.requirementClassification;
        if (!task
            || classification?.decision !== 'new'
            || classification.undone
            || !classification.previousRequirementId
            || !this.requirementService.get(classification.previousRequirementId)
            || !this.requirementService.moveTask(task.id, classification.previousRequirementId)) {
            return false;
        }
        this.record(task.id, { ...classification, undone: true });
        return true;
    }

    protected record(taskId: string, classification: TaskRequirementClassification): void {
        const updated = this.taskService.setRequirementClassification(taskId, {
            ...classification,
            reason: classification.reason.slice(0, 300)
        });
        if (updated) {
            this.onDidClassifyEmitter.fire(updated);
        }
    }

    protected skipReason(
        task: ExecutionTask,
        requirementTasks: readonly ExecutionTask[] | undefined,
        workspaceIsLocal: boolean
    ): string {
        if (!this.enabled) {
            return 'setting-off';
        }
        if (task.requirementChoice !== 'default') {
            return 'explicit-choice';
        }
        if (task.status !== 'completed') {
            return 'task-not-completed';
        }
        if (task.changeSet?.source === 'empty' || task.changeSet?.error || !task.changeSet?.files.length) {
            return 'empty-change-set';
        }
        if (!workspaceIsLocal) {
            return 'non-local-workspace';
        }
        if (!requirementTasks) {
            return 'missing-requirement';
        }
        return 'first-task';
    }
}

function isLocalWorkspace(workspaceUri: string | undefined): boolean {
    return typeof workspaceUri === 'string' && /^file:/i.test(workspaceUri);
}
