import type { ExecutionTask } from '../browser/task-service';

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
        && ['running', 'completed', 'failed', 'cancelled'].includes(candidate.status)));
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
