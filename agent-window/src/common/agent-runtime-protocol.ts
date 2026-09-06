import { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

export const AgentRuntimeServer = Symbol('AgentRuntimeServer');
export const agentRuntimeServerPath = '/services/poiesis/agent-runtime';

export const KNOWN_CLI_IDS = ['codex', 'claude', 'grok', 'gemini'] as const;
export type KnownCliId = typeof KNOWN_CLI_IDS[number];
export const DEFAULT_CLI_ID: KnownCliId = 'codex';
export type AiRole = 'agent' | 'results';
export type CliLocationSource = 'PATH' | 'well-known';

export const CLI_DISPLAY_NAMES: Readonly<Record<KnownCliId, string>> = {
    codex: 'Codex',
    claude: 'Claude Code',
    grok: 'Grok',
    gemini: 'Gemini CLI'
};

/** CLI values accepted at the backend argv boundary. Model catalogs can expose a supported subset. */
export const CLI_EFFORT_LEVELS: Readonly<Record<KnownCliId, readonly string[]>> = {
    claude: ['low', 'medium', 'high', 'xhigh', 'max'],
    codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    grok: ['low', 'medium', 'high'],
    gemini: []
};

/** Capability snapshot shown only when live Codex discovery is unavailable. */
export const CODEX_FALLBACK_MODEL_EFFORTS: Readonly<Record<string, readonly string[]>> = {
    'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
    'gpt-5.4-mini': ['low', 'medium', 'high', 'xhigh'],
    'gpt-5.3-codex-spark': ['low', 'medium', 'high', 'xhigh']
};

export function isKnownCliId(value: unknown): value is KnownCliId {
    return typeof value === 'string' && (KNOWN_CLI_IDS as readonly string[]).includes(value);
}

export interface CliModelOption {
    id: string;
    label: string;
    description?: string;
    isCatalogDefault?: boolean;
    defaultReasoningEffort?: string;
    supportedReasoningEfforts?: string[];
    inputModalities?: string[];
}

export type CliModelCatalogSource = 'live' | 'cached' | 'fallback' | 'failed';

export interface CliModelCatalog {
    providerId: KnownCliId;
    source: CliModelCatalogSource;
    models: CliModelOption[];
    fetchedAt?: string;
    /** A safe user-facing summary. Raw process output is never transported. */
    error?: string;
}

export interface CliModelDiscoveryRequest {
    providerId: KnownCliId;
    refresh?: boolean;
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

export interface GitChangeSetBetweenRequest {
    fromSnapshotId: string;
    toSnapshotId: string;
    paths?: string[];
}

export interface GitChangeSetCapture {
    source: 'task-diff' | 'empty';
    diff: string;
    files: string[];
    endSnapshotId?: string;
    error?: string;
}

export interface GitSnapshotFileRequest {
    workspacePath: string;
    fromSnapshotId: string;
    toSnapshotId: string;
    path: string;
}

export interface GitSnapshotFileContent {
    state: 'text' | 'missing';
    content?: string;
}

export interface GitSnapshotFileCapture {
    source: 'snapshot-file' | 'unavailable';
    path?: string;
    before?: GitSnapshotFileContent;
    after?: GitSnapshotFileContent;
    error?: string;
}

export interface CodexExecutionRequest {
    executionId: string;
    providerId: KnownCliId;
    model?: string;
    effort?: string;
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
    discoverModels(request: CliModelDiscoveryRequest): Promise<CliModelCatalog>;
    captureGitSnapshot(request: GitSnapshotRequest): Promise<GitSnapshotCapture>;
    captureGitChangeSet(request: GitChangeSetRequest): Promise<GitChangeSetCapture>;
    captureGitChangeSetBetween(request: GitChangeSetBetweenRequest): Promise<GitChangeSetCapture>;
    readGitSnapshotFile(request: GitSnapshotFileRequest): Promise<GitSnapshotFileCapture>;
    runCodex(request: CodexExecutionRequest): Promise<void>;
    cancelCodex(executionId: string): Promise<void>;
    browseFolders(request: FolderBrowserRequest): Promise<FolderBrowserResult>;
    createFolder(request: CreateFolderRequest): Promise<string>;
}
