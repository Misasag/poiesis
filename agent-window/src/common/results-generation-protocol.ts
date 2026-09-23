import type { CliCallRecord } from './cli-usage';
import type { ResultsImageResolution } from './results-images';
import { KnownCliId } from './agent-runtime-protocol';

export const ResultsGenerationServer = Symbol('ResultsGenerationServer');
export const resultsGenerationServerPath = '/services/poiesis/results-generation';

export interface ResultsGenerationProgress {
    phase: 'generation' | 'judge' | 'regeneration';
    startedAt: string;
    providerId: KnownCliId;
    model?: string;
    effort?: string;
    attempt: number;
    failedAssertions?: number;
}

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
    attempt?: number;
    model?: string;
    effort?: string;
    workspaceUri: string;
    taskMetadata: ResultsGenerationTaskMetadata;
    requirement?: ResultsGenerationRequirementMetadata;
    changeSetSummary: string;
    diff: string;
    executionEvidence?: string;
    hookMaterial?: string;
    workspaceSkillGuidance?: string;
    assertionRetryGuidance?: string;
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

export type ResultsGenerationResult = (
    | { status: 'generated'; html: string }
    | { status: 'failed'; error: ResultsGenerationError }
    | { status: 'cancelled'; error: ResultsGenerationError }) & { call?: CliCallRecord };

/** One complete-document RPC. taskId is also the cancellation key. */
export interface ResultsGenerationServer {
    resolveImages(workspaceUri: string, paths: string[]): Promise<ResultsImageResolution>;
    generate(request: ResultsGenerationRequest): Promise<ResultsGenerationResult>;
    cancel(taskId: string): Promise<void>;
}
