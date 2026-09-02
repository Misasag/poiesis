import type { TaskResultDocument, TaskResultsQuestion } from './task-service';

export type RequirementTitleSource = 'task' | 'ai' | 'user';

export interface Requirement {
    id: string;
    sessionId: string;
    title: string;
    titleSource: RequirementTitleSource;
    createdAt: string;
    updatedAt: string;
    taskIds: string[];
    resultsDocument?: TaskResultDocument;
    resultsQuestions?: TaskResultsQuestion[];
}

export interface RequirementTaskLike {
    id: string;
    sessionId: string;
    title: string;
    startedAt: string;
    requirementId?: string;
}

export interface RequirementMigrationResult {
    requirements: Requirement[];
    assignments: Map<string, string>;
}

export function migrateRequirementModel(
    tasks: readonly RequirementTaskLike[],
    storedRequirements: readonly Requirement[],
    createId: () => string,
    now = new Date().toISOString()
): RequirementMigrationResult {
    const taskById = new Map(tasks.map(task => [task.id, task]));
    const requirements = storedRequirements.flatMap<Requirement>(candidate => {
        if (!candidate
            || typeof candidate.id !== 'string'
            || typeof candidate.sessionId !== 'string'
            || typeof candidate.title !== 'string') {
            return [];
        }
        return [{
            ...candidate,
            titleSource: candidate.titleSource === 'ai' || candidate.titleSource === 'user' ? candidate.titleSource : 'task',
            createdAt: validDate(candidate.createdAt) ? candidate.createdAt : now,
            updatedAt: validDate(candidate.updatedAt) ? candidate.updatedAt : now,
            taskIds: [] as string[]
        }];
    });
    const requirementById = new Map(requirements.map(requirement => [requirement.id, requirement]));
    const assignments = new Map<string, string>();

    for (const task of tasks) {
        const explicit = task.requirementId ? requirementById.get(task.requirementId) : undefined;
        if (explicit?.sessionId === task.sessionId) {
            explicit.taskIds.push(task.id);
            assignments.set(task.id, explicit.id);
        }
    }
    for (const stored of storedRequirements) {
        const requirement = requirementById.get(stored.id);
        if (!requirement) {
            continue;
        }
        for (const taskId of Array.isArray(stored.taskIds) ? stored.taskIds : []) {
            const task = taskById.get(taskId);
            if (!task || task.sessionId !== requirement.sessionId || assignments.has(taskId)) {
                continue;
            }
            requirement.taskIds.push(taskId);
            assignments.set(taskId, requirement.id);
        }
    }
    for (const task of tasks) {
        if (assignments.has(task.id)) {
            continue;
        }
        const requirement: Requirement = {
            id: createId(),
            sessionId: task.sessionId,
            title: task.title,
            titleSource: 'task',
            createdAt: validDate(task.startedAt) ? task.startedAt : now,
            updatedAt: now,
            taskIds: [task.id]
        };
        requirements.push(requirement);
        requirementById.set(requirement.id, requirement);
        assignments.set(task.id, requirement.id);
    }

    return {
        requirements: requirements
            .filter(requirement => requirement.taskIds.length > 0)
            .map(requirement => ({
                ...requirement,
                taskIds: [...new Set(requirement.taskIds)].sort((left, right) =>
                    (taskById.get(left)?.startedAt ?? '').localeCompare(taskById.get(right)?.startedAt ?? ''))
            })),
        assignments
    };
}

export function moveTaskInRequirementModel(
    requirements: readonly Requirement[],
    tasks: readonly RequirementTaskLike[],
    taskId: string,
    targetRequirementId: string,
    now = new Date().toISOString()
): RequirementMigrationResult {
    const task = tasks.find(candidate => candidate.id === taskId);
    const target = requirements.find(candidate => candidate.id === targetRequirementId);
    if (!task || !target || target.sessionId !== task.sessionId) {
        return migrateRequirementModel(tasks, requirements, () => `requirement-${Date.now()}`, now);
    }
    const moved = requirements.map(requirement => {
        const taskIds = requirement.taskIds.filter(candidate => candidate !== taskId);
        if (requirement.id === targetRequirementId) {
            taskIds.push(taskId);
        }
        return taskIds.length === requirement.taskIds.length
            && requirement.id !== targetRequirementId
            ? requirement
            : { ...requirement, taskIds: [...new Set(taskIds)], updatedAt: now };
    }).filter(requirement => requirement.taskIds.length > 0);
    const assignments = new Map<string, string>();
    for (const requirement of moved) {
        for (const id of requirement.taskIds) {
            assignments.set(id, requirement.id);
        }
    }
    return { requirements: moved, assignments };
}

export function splitTaskInRequirementModel(
    requirements: readonly Requirement[],
    tasks: readonly RequirementTaskLike[],
    taskId: string,
    createId: () => string,
    now = new Date().toISOString()
): RequirementMigrationResult {
    const task = tasks.find(candidate => candidate.id === taskId);
    if (!task) {
        return migrateRequirementModel(tasks, requirements, createId, now);
    }
    const requirement: Requirement = {
        id: createId(),
        sessionId: task.sessionId,
        title: task.title,
        titleSource: 'task',
        createdAt: now,
        updatedAt: now,
        taskIds: []
    };
    return moveTaskInRequirementModel([...requirements, requirement], tasks, taskId, requirement.id, now);
}

export function removeTaskFromRequirementModel(
    requirements: readonly Requirement[],
    taskId: string,
    now = new Date().toISOString()
): Requirement[] {
    return requirements.map(requirement => requirement.taskIds.includes(taskId)
        ? { ...requirement, taskIds: requirement.taskIds.filter(candidate => candidate !== taskId), updatedAt: now }
        : requirement
    ).filter(requirement => requirement.taskIds.length > 0);
}

export function currentRequirementIdForTasks(tasks: readonly RequirementTaskLike[]): string | undefined {
    return [...tasks]
        .filter(task => Boolean(task.requirementId))
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
        .at(-1)?.requirementId;
}

function validDate(value: string): boolean {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
