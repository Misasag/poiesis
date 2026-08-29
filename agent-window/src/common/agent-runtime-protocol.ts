import { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

export const AgentRuntimeServer = Symbol('AgentRuntimeServer');
export const agentRuntimeServerPath = '/services/poiesis/agent-runtime';

export const KNOWN_CLI_IDS = ['codex', 'claude', 'grok', 'gemini'] as const;
export type KnownCliId = typeof KNOWN_CLI_IDS[number];
export const DEFAULT_CLI_ID: KnownCliId = 'codex';
export type AiRole = 'agent' | 'results';
export type CliLocationSource = 'PATH' | 'well-known';

export function isKnownCliId(value: unknown): value is KnownCliId {
    return typeof value === 'string' && (KNOWN_CLI_IDS as readonly string[]).includes(value);
}

export interface CliModelOption {
    id: string;
    label: string;
}

export interface CliDetection {
    id: KnownCliId;
    name: string;
    status: 'found' | 'missing';
    path?: string;
    source?: CliLocationSource;
    version?: string;
    executableRoles: AiRole[];
    models: CliModelOption[];
    defaultModel: string;
    checkedLocations: string[];
}

export interface CliDetectionReport {
    detectedAt: string;
    platform: string;
    detections: CliDetection[];
}

export interface GitSnapshotRequest {
    workspacePath?: string;
}

export interface GitSnapshotCapture {
    source: 'git-snapshot' | 'empty';
    snapshotId?: string;
    error?: string;
}

export interface GitChangeSetRequest {
    baselineSnapshotId: string;
}

export interface GitChangeSetCapture {
    source: 'task-diff' | 'empty';
    diff: string;
    files: string[];
    error?: string;
}

export interface CodexExecutionRequest {
    executionId: string;
    providerId: KnownCliId;
    model?: string;
    workspacePath?: string;
    prompt: string;
}

export interface FolderBrowserRequest {
    path?: string;
}

export interface FolderBrowserResult {
    path: string;
    parentPath?: string;
    directories: Array<{ name: string; path: string }>;
}

export interface CreateFolderRequest {
    parentPath: string;
    name: string;
}

export type CodexExecutionEvent =
    | { type: 'output'; executionId: string; stream: 'stdout' | 'stderr'; delta: string }
    | { type: 'exit'; executionId: string; code: number | null; signal: string | null };

export interface AgentRuntimeClient {
    notifyCodexEvent(event: CodexExecutionEvent): void;
}

export interface AgentRuntimeServer extends RpcServer<AgentRuntimeClient> {
    detectClis(): Promise<CliDetectionReport>;
    captureGitSnapshot(request: GitSnapshotRequest): Promise<GitSnapshotCapture>;
    captureGitChangeSet(request: GitChangeSetRequest): Promise<GitChangeSetCapture>;
    runCodex(request: CodexExecutionRequest): Promise<void>;
    cancelCodex(executionId: string): Promise<void>;
    browseFolders(request: FolderBrowserRequest): Promise<FolderBrowserResult>;
    createFolder(request: CreateFolderRequest): Promise<string>;
}
