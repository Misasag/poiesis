import { KnownCliId } from './agent-runtime-protocol';

export const ResultsGenerationServer = Symbol('ResultsGenerationServer');
export const resultsGenerationServerPath = '/services/poiesis/results-generation';

export interface ResultsGenerationTaskMetadata {
    status: 'completed' | 'failed' | 'cancelled';
    title?: string;
    request: string;
    endedAt?: string;
    completionSummary?: string;
    implementerReport?: string;
    failureSummary?: string;
    changeSetSummary?: string;
}

export interface ResultsGenerationRequirementMetadata {
    title: string;
    tasks: ResultsGenerationTaskMetadata[];
}

export interface ResultsGenerationRequest {
    taskId: string;
    providerId: KnownCliId;
    model?: string;
    workspaceUri: string;
    taskMetadata: ResultsGenerationTaskMetadata;
    requirement?: ResultsGenerationRequirementMetadata;
    changeSetSummary: string;
    diff: string;
    executionEvidence?: string;
    workspaceSkillGuidance?: string;
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
