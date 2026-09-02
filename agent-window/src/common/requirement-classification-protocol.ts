import { KnownCliId } from './agent-runtime-protocol';

export const RequirementClassificationServer = Symbol('RequirementClassificationServer');
export const requirementClassificationServerPath = '/services/poiesis/requirement-classification';

export interface RequirementClassificationTaskData {
    request: string;
    completionSummary?: string;
    changedFiles: string[];
}

export interface RequirementClassificationScope {
    taskId: string;
    providerId: KnownCliId;
    model?: string;
    workspaceUri: string;
    currentRequirementTitle: string;
    previousTasks: Array<Pick<RequirementClassificationTaskData, 'request' | 'changedFiles'>>;
    task: RequirementClassificationTaskData;
}

export type RequirementClassificationErrorCode =
    | 'invalid-scope'
    | 'already-running'
    | 'cli-not-found'
    | 'cli-failed'
    | 'timeout'
    | 'internal';

export interface RequirementClassificationError {
    code: RequirementClassificationErrorCode;
    message: string;
    exitCode?: number | null;
    signal?: string | null;
    stderr?: string;
}

export type RequirementClassificationResult =
    | { status: 'classified'; output: string }
    | { status: 'failed'; error: RequirementClassificationError };

export interface RequirementClassificationServer {
    classify(scope: RequirementClassificationScope): Promise<RequirementClassificationResult>;
}
