import type { ExecutionTask } from '../browser/task-service';

function storedPath(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && !/[\\\0\r\n]/.test(value)
        && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
        && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function storedPaths(value: unknown): string[] {
    return Array.isArray(value) ? [...new Set(value.filter(storedPath))] : [];
}

function normalizedEncodingFields(task: ExecutionTask): ExecutionTask {
    const rawChangeSet = task.changeSet as unknown;
    let changeSet = task.changeSet;
    if (rawChangeSet && typeof rawChangeSet === 'object' && !Array.isArray(rawChangeSet)) {
        const value = rawChangeSet as Record<string, unknown>;
        if ((value.source === 'task-diff' || value.source === 'empty')
            && typeof value.diff === 'string' && typeof value.capturedAt === 'string'
            && Array.isArray(value.files)) {
            const damage = Array.isArray(value.encodingDamage) ? value.encodingDamage.filter(item =>
                item && typeof item === 'object' && storedPath(item.path)
                && (item.reason === 'invalid-utf8' || item.reason === 'replacement-characters'))
                .map(item => ({ path: item.path as string, reason: item.reason as 'invalid-utf8' | 'replacement-characters' })) : [];
            changeSet = { ...task.changeSet!,
                encodingDamage: [...new Map(damage.map(item => [item.path, item])).values()],
                encodingDamageErrors: storedPaths(value.encodingDamageErrors) };
        } else {
            const { encodingDamage: _damage, encodingDamageErrors: _errors, ...unchanged } = value;
            changeSet = unchanged as unknown as ExecutionTask['changeSet'];
        }
    }
    const rawRestore = task.encodingRestore as unknown;
    let encodingRestore: ExecutionTask['encodingRestore'];
    if (rawRestore && typeof rawRestore === 'object') {
        const value = rawRestore as Record<string, unknown>;
        if (typeof value.restoredAt === 'string' && Array.isArray(value.restoredPaths)) {
            const restoredPaths = storedPaths(value.restoredPaths);
            const skippedPaths = storedPaths(value.skippedPaths).filter(path => !restoredPaths.includes(path));
            const rawReasons = value.skippedReasons && typeof value.skippedReasons === 'object'
                ? value.skippedReasons as Record<string, unknown> : {};
            const skippedReasons: Record<string, 'changed-after-task' | 'unavailable'> = {};
            for (const path of skippedPaths) {
                skippedReasons[path] = rawReasons[path] === 'changed-after-task' ? 'changed-after-task' : 'unavailable';
            }
            encodingRestore = { restoredAt: value.restoredAt, restoredPaths, skippedPaths, skippedReasons };
        }
    }
    return { ...task, changeSet, encodingRestore };
}

export const MAX_PERSISTED_RESULTS_HTML_CHARS = 300_000;

export interface DraftSessionLike {
    archived: boolean;
    hasUserMessage: boolean;
    agentDraft: string;
}

export function sessionHasRailContent(session: Pick<DraftSessionLike, 'hasUserMessage' | 'agentDraft'>): boolean {
    return session.hasUserMessage || Boolean(session.agentDraft.trim());
}

export function canReuseSessionForNewChat<T extends DraftSessionLike>(session: T | undefined): session is T {
    return Boolean(session && !session.archived && !sessionHasRailContent(session));
}

/** Shared structural boundary used by reload restoration before service-level normalization. */
export function restoredDurableTaskCandidates(value: unknown): ExecutionTask[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((candidate): candidate is ExecutionTask => Boolean(candidate
        && typeof candidate === 'object'
        && typeof candidate.id === 'string'
        && typeof candidate.sessionId === 'string'
        && typeof candidate.title === 'string'
        && typeof candidate.request === 'string'
        && typeof candidate.startedAt === 'string'
        && ['running', 'completed', 'failed', 'cancelled'].includes(candidate.status)))
        .map(normalizedEncodingFields);
}

/** Durable session retention is intentionally independent of bounded CLI context transport. */
export function tasksForDurableSession(
    tasks: readonly ExecutionTask[],
    interruptedAt = new Date().toISOString()
): ExecutionTask[] {
    return [...tasks]
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
        .map(task => {
            const persistedTask: ExecutionTask = task.status === 'running' ? {
                ...task,
                status: 'failed',
                endedAt: interruptedAt,
                failure: { summary: 'アプリ終了により中断されました' }
            } : task;
            return persistedTask.resultsDocument ? {
                ...persistedTask,
                resultsDocument: {
                    ...persistedTask.resultsDocument,
                    html: persistedTask.resultsDocument.html?.slice(0, MAX_PERSISTED_RESULTS_HTML_CHARS)
                }
            } : persistedTask;
        });
}
