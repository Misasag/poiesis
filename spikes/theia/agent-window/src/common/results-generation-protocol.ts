import { KnownCliId } from './agent-runtime-protocol';

export const ResultsGenerationServer = Symbol('ResultsGenerationServer');
export const resultsGenerationServerPath = '/services/poiesis/results-generation';

export interface ResultsGenerationTaskMetadata {
    status: 'completed';
    title: string;
    request: string;
    startedAt: string;
    endedAt?: string;
}

export interface ResultsGenerationRequest {
    taskId: string;
    providerId: KnownCliId;
    model?: string;
    workspaceUri: string;
    taskMetadata: ResultsGenerationTaskMetadata;
    changeSetSummary: string;
    diff: string;
}

export type ResultsGenerationErrorCode =
    | 'invalid-scope'
    | 'already-running'
    | 'cli-not-found'
    | 'cli-failed'
    | 'timeout'
    | 'too-large'
    | 'cancelled'
    | 'internal';

export interface ResultsGenerationError {
    code: ResultsGenerationErrorCode;
    message: string;
    exitCode?: number | null;
    signal?: string | null;
    stderr?: string;
}

export type ResultsGenerationResult =
    | { status: 'generated'; html: string }
    | { status: 'failed'; error: ResultsGenerationError }
    | { status: 'cancelled'; error: ResultsGenerationError };

/** One complete-document RPC. taskId is also the cancellation key. */
export interface ResultsGenerationServer {
    generate(request: ResultsGenerationRequest): Promise<ResultsGenerationResult>;
    cancel(taskId: string): Promise<void>;
}
