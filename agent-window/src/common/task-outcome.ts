export type TaskOutcomeKind = 'result' | 'conversation';

export interface TaskOutcomeLike {
    status: string;
    outcomeKind?: TaskOutcomeKind;
    changeSet?: {
        files?: readonly string[];
        diff?: string;
    };
    resultsDocument?: {
        status?: string;
        html?: string;
    };
}

export interface ParsedAgentCompletion {
    message: string;
    outcomeKind?: TaskOutcomeKind;
}

const OUTCOME_MARKER = /(?:\r?\n)?\s*<!--\s*poiesis-outcome:\s*(result|conversation)\s*-->\s*$/i;
const TRAILING_OUTCOME_METADATA = /(?:\r?\n)?[ \t]*<!--\s*poiesis-outcome\b[\s\S]*?(?:-->|$)[ \t]*$/i;

/** Removes the application-owned outcome marker before the reply reaches conversation or Results. */
export function parseAgentCompletion(value: string): ParsedAgentCompletion {
    const source = value.trim();
    const match = source.match(OUTCOME_MARKER);
    if (!match) {
        return { message: source.replace(TRAILING_OUTCOME_METADATA, '').trim() };
    }
    const message = source.slice(0, match.index).trim();
    return {
        message,
        outcomeKind: message ? match[1].toLocaleLowerCase() as TaskOutcomeKind : undefined
    };
}

export function hasMaterialTaskChanges(task: TaskOutcomeLike): boolean {
    return Boolean(task.changeSet?.files?.length || task.changeSet?.diff?.trim());
}

export function hasReadableResultDocument(document: TaskOutcomeLike['resultsDocument']): boolean {
    return Boolean(document?.html?.trim());
}

/**
 * A Result represents a durable outcome, not every successful CLI turn. Existing
 * legacy documents remain visible even though older tasks have no outcomeKind.
 */
export function taskProducesResult(task: TaskOutcomeLike): boolean {
    if (task.status === 'running') {
        return false;
    }
    if (hasMaterialTaskChanges(task)) {
        return true;
    }
    if (task.status !== 'completed') {
        return task.outcomeKind === undefined && hasReadableResultDocument(task.resultsDocument);
    }
    if (task.outcomeKind) {
        return task.outcomeKind === 'result';
    }
    return hasReadableResultDocument(task.resultsDocument);
}
