import { KnownCliId } from './agent-runtime-protocol';

export const ResultsQuestionServer = Symbol('ResultsQuestionServer');
export const resultsQuestionServerPath = '/services/poiesis/results-question';

export type ResultsQuestionTaskStatus = 'completed' | 'failed' | 'cancelled';

/** Serializable metadata for the selected, terminated execution Task. */
export interface ResultsQuestionTaskMetadata {
    status: ResultsQuestionTaskStatus;
    title?: string;
    request?: string;
    startedAt?: string;
    endedAt?: string;
    [key: string]: unknown;
}

export interface ResultsQuestionHistoryEntry {
    question: string;
    answer?: string;
    error?: string;
    timestamp: string;
}

/**
 * The complete information boundary for one Results question.
 * Optional fields such as a short `history` can be added later without changing
 * the ask signature or coupling this protocol to the Agent conversation.
 */
export interface ResultsQuestionScope {
    taskId: string;
    requirementTitle?: string;
    providerId: KnownCliId;
    model?: string;
    effort?: string;
    workspaceUri: string;
    taskMetadata: ResultsQuestionTaskMetadata;
    changeSetSummary: string;
    diff?: string;
    executionEvidence?: string;
    resultsHtml: string;
    history?: ResultsQuestionHistoryEntry[];
}

export type ResultsQuestionErrorCode =
    | 'invalid-question'
    | 'invalid-scope'
    | 'already-running'
    | 'cli-not-found'
    | 'cli-failed'
    | 'cancelled'
    | 'internal';

export interface ResultsQuestionError {
    code: ResultsQuestionErrorCode;
    message: string;
    exitCode?: number | null;
    signal?: string | null;
    stderr?: string;
}

export type ResultsQuestionResult =
    | { status: 'answered'; answer: string }
    | { status: 'failed'; error: ResultsQuestionError }
    | { status: 'cancelled'; error: ResultsQuestionError };

/** Single-answer RPC; taskId is also the cancellation key for the active ask. */
export interface ResultsQuestionServer {
    ask(question: string, scope: ResultsQuestionScope): Promise<ResultsQuestionResult>;
    cancel(taskId: string): Promise<void>;
}
