import { KnownCliId } from './agent-runtime-protocol';

export const ResultsAssertionServer = Symbol('ResultsAssertionServer');
export const resultsAssertionServerPath = '/services/poiesis/results-assertion';

export interface ResultsAssertionScope {
    taskId: string;
    providerId: KnownCliId;
    model?: string;
    effort?: string;
    workspaceUri: string;
    documentText: string;
    assertions: string[];
    changeSetSummary: string;
}

export type ResultsAssertionErrorCode =
    | 'invalid-scope'
    | 'already-running'
    | 'cli-not-found'
    | 'cli-failed'
    | 'timeout'
    | 'cancelled'
    | 'internal';

export interface ResultsAssertionError {
    code: ResultsAssertionErrorCode;
    message: string;
    exitCode?: number | null;
    signal?: string | null;
    stderr?: string;
}

export type ResultsAssertionJudgeResult =
    | { status: 'judged'; output: string }
    | { status: 'failed'; error: ResultsAssertionError }
    | { status: 'cancelled'; error: ResultsAssertionError };

export interface ResultsAssertionServer {
    judge(scope: ResultsAssertionScope): Promise<ResultsAssertionJudgeResult>;
    cancel(taskId: string): Promise<void>;
}
