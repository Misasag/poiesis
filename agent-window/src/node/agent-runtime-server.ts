import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { injectable, inject } from '@theia/core/shared/inversify';
import {
    AgentRuntimeClient,
    AgentRuntimeServer,
    CliDetectionReport,
    CodexExecutionRequest,
    CreateFolderRequest,
    FolderBrowserRequest,
    FolderBrowserResult,
    GitChangeSetBetweenRequest,
    GitChangeSetCapture,
    GitChangeSetRequest,
    GitSnapshotCapture,
    GitSnapshotRequest,
    KnownCliId
} from '../common/agent-runtime-protocol';
import { CliDetector } from './cli-detector';
import { CliProviderRegistry } from './cli-provider-registry';
import { grokExecutionEnvironment } from './known-cli-registry';
import { HiddenCliProcess, killHiddenProcessTree, spawnHiddenCli } from './hidden-process';
import { isGitRepository, SnapshotStore } from './snapshot-store';

type CodexProcess = HiddenCliProcess;

interface CodexRun {
    process: CodexProcess;
    cancelled: boolean;
}

@injectable()
export class AgentRuntimeServerImpl implements AgentRuntimeServer {
    protected readonly snapshotStore = new SnapshotStore();
    protected readonly codexRuns = new Map<string, CodexRun>();
    protected client?: AgentRuntimeClient;

    constructor(
        @inject(CliDetector) protected readonly cliDetector: CliDetector,
        @inject(CliProviderRegistry) protected readonly providerRegistry: CliProviderRegistry
    ) { }

    setClient(client: AgentRuntimeClient | undefined): void {
        this.client = client;
    }

    dispose(): void {
        for (const run of this.codexRuns.values()) {
            run.cancelled = true;
            run.process.kill();
        }
        this.codexRuns.clear();
        this.client = undefined;
    }

    detectClis(): Promise<CliDetectionReport> {
        return this.cliDetector.detect();
    }

    async browseFolders({ path }: FolderBrowserRequest): Promise<FolderBrowserResult> {
        const folderPath = resolve(path || process.cwd());
        const folderStat = await stat(folderPath);
        if (!folderStat.isDirectory()) {
            throw new Error('The selected path is not a folder.');
        }
        const entries = await readdir(folderPath, { withFileTypes: true });
        const parent = dirname(folderPath);
        return {
            path: folderPath,
            parentPath: parent === folderPath ? undefined : parent,
            directories: entries
                .filter(entry => entry.isDirectory())
                .map(entry => ({ name: entry.name, path: join(folderPath, entry.name) }))
                .sort((left, right) => left.name.localeCompare(right.name))
        };
    }

    async createFolder({ parentPath, name }: CreateFolderRequest): Promise<string> {
        const normalizedName = name.trim();
        if (!normalizedName || normalizedName === '.' || normalizedName === '..' || /[\\/:*?"<>|]/.test(normalizedName)) {
            throw new Error('フォルダー名に使用できない文字が含まれています。');
        }
        const parent = resolve(parentPath);
        const folderPath = resolve(parent, normalizedName);
        if (dirname(folderPath) !== parent) {
            throw new Error('フォルダーは現在の場所の直下に作成してください。');
        }
        await mkdir(folderPath);
        return folderPath;
    }

    async captureGitSnapshot({ workspacePath }: GitSnapshotRequest): Promise<GitSnapshotCapture> {
        if (!workspacePath) {
            return { source: 'empty', error: 'No workspace root is open.' };
        }
        return this.snapshotStore.capture(await this.resolveWorkspace(workspacePath));
    }

    async captureGitChangeSet({ baselineSnapshotId }: GitChangeSetRequest): Promise<GitChangeSetCapture> {
        return this.snapshotStore.captureChangeSet(baselineSnapshotId);
    }

    async captureGitChangeSetBetween(request: GitChangeSetBetweenRequest): Promise<GitChangeSetCapture> {
        return this.snapshotStore.captureBetween(request);
    }

    async runCodex({ executionId, providerId, model, workspacePath, prompt }: CodexExecutionRequest): Promise<void> {
        if (process.platform !== 'win32') {
            throw new Error('This implementation slice runs Codex only on Windows.');
        }
        if (this.codexRuns.has(executionId)) {
            throw new Error(`Codex execution already exists: ${executionId}`);
        }
        if (!workspacePath) {
            throw new Error('No workspace root is open.');
        }
        if (process.env.POIESIS_AGENT_FORCE_PRESPAWN_FAILURE === '1') {
            throw new Error('Agent pre-spawn failure requested by test hook.');
        }
        const testReply = process.env.POIESIS_AGENT_TEST_REPLY;
        if (testReply !== undefined) {
            const configuredDelay = Number(process.env.POIESIS_AGENT_TEST_DELAY_MS);
            const testDelay = Number.isFinite(configuredDelay) ? Math.max(0, Math.min(configuredDelay, 10_000)) : 0;
            if (process.env.POIESIS_AGENT_TEST_ACTIVITIES === '1') {
                const changedPath = join(workspacePath, 'docs', 'UX.md');
                const events = [
                    {
                        type: 'item.completed',
                        item: { id: 'test-message-start', type: 'agent_message', text: '作業を開始します' }
                    },
                    {
                        type: 'item.started',
                        item: {
                            id: 'test-command', type: 'command_execution', command: 'dir',
                            aggregated_output: '', exit_code: null, status: 'in_progress'
                        }
                    },
                    {
                        type: 'item.completed',
                        item: {
                            id: 'test-command', type: 'command_execution', command: 'dir',
                            aggregated_output: '', exit_code: 0, status: 'completed'
                        }
                    },
                    {
                        type: 'item.started',
                        item: {
                            id: 'test-file-change', type: 'file_change',
                            changes: [{ path: changedPath, kind: 'update' }], status: 'in_progress'
                        }
                    },
                    {
                        type: 'item.completed',
                        item: {
                            id: 'test-file-change', type: 'file_change',
                            changes: [{ path: changedPath, kind: 'update' }], status: 'completed'
                        }
                    }
                ];
                const stepDelay = testDelay / (events.length + 1);
                events.forEach((event, index) => {
                    setTimeout(() => {
                        this.client?.notifyCodexEvent({
                            type: 'output', executionId, stream: 'stdout',
                            delta: `${JSON.stringify(event)}\n`
                        });
                    }, stepDelay * (index + 1));
                });
                setTimeout(() => {
                    this.client?.notifyCodexEvent({
                        type: 'output',
                        executionId,
                        stream: 'stdout',
                        delta: `${JSON.stringify({
                            type: 'item.completed',
                            item: { id: 'test-message-final', type: 'agent_message', text: testReply }
                        })}\n`
                    });
                    this.client?.notifyCodexEvent({ type: 'exit', executionId, code: 0, signal: null });
                }, testDelay);
                return;
            }
            setTimeout(() => {
                this.client?.notifyCodexEvent({
                    type: 'output',
                    executionId,
                    stream: 'stdout',
                    delta: `${JSON.stringify({
                        type: 'item.completed',
                        item: { type: 'agent_message', text: testReply }
                    })}\n`
                });
                this.client?.notifyCodexEvent({ type: 'exit', executionId, code: 0, signal: null });
            }, testDelay);
            return;
        }

        const provider = await this.providerRegistry.resolve('agent', providerId, model);

        const resolvedWorkspace = await this.resolveWorkspace(workspacePath);
        const skipGitRepositoryCheck = provider.id === 'codex' && !await isGitRepository(resolvedWorkspace);
        const args = provider.id === 'claude'
            ? [
                '-p', prompt,
                ...(provider.model ? ['--model', provider.model] : []),
                '--output-format', 'stream-json',
                '--verbose',
                '--permission-mode', 'acceptEdits',
                '--no-session-persistence',
                '--safe-mode',
                '--disable-slash-commands',
                '--strict-mcp-config',
                '--mcp-config', '{"mcpServers":{}}'
            ]
            : provider.id === 'grok'
                ? [
                    '-p', prompt,
                    '--cwd', resolvedWorkspace,
                    ...(provider.model ? ['--model', provider.model] : []),
                    '--output-format', 'plain',
                    '--permission-mode', 'acceptEdits',
                    '--sandbox', 'workspace',
                    '--disable-web-search',
                    '--no-subagents',
                    '--no-plan'
                ]
                : [
                'exec',
                ...(provider.model ? ['-m', provider.model] : []),
                ...(skipGitRepositoryCheck ? ['--skip-git-repo-check'] : []),
                '--json',
                '--color', 'never',
                '--sandbox', 'workspace-write',
                '-C', resolvedWorkspace,
                '--', prompt
            ];
        const child = this.spawnCli(provider.id, provider.path, args, resolvedWorkspace);
        const run: CodexRun = { process: child, cancelled: false };
        this.codexRuns.set(executionId, run);

        child.stdout.on('data', chunk => this.notifyOutput(executionId, 'stdout', chunk));
        child.stderr.on('data', chunk => this.notifyOutput(executionId, 'stderr', chunk));
        child.once('error', error => {
            this.notifyOutput(executionId, 'stderr', Buffer.from(`${provider.name} process error: ${error.message}\n`));
        });
        child.once('close', (code, signal) => {
            this.codexRuns.delete(executionId);
            if (!run.cancelled) {
                this.client?.notifyCodexEvent({
                    type: 'exit',
                    executionId,
                    code,
                    signal
                });
            }
        });
    }

    async cancelCodex(executionId: string): Promise<void> {
        const run = this.codexRuns.get(executionId);
        if (!run) {
            return;
        }
        run.cancelled = true;
        await this.killProcess(run.process);
    }

    protected async resolveWorkspace(workspacePath: string): Promise<string> {
        const resolvedWorkspace = resolve(workspacePath);
        try {
            if ((await stat(resolvedWorkspace)).isDirectory()) {
                return resolvedWorkspace;
            }
        } catch {
            // Report one stable error below.
        }
        throw new Error(`The Workspace directory was not found: ${resolvedWorkspace}`);
    }

    protected spawnCli(providerId: KnownCliId, command: string, args: string[], cwd: string): CodexProcess {
        const env = providerId === 'grok' ? grokExecutionEnvironment() : process.env;
        return spawnHiddenCli(providerId, command, args, { cwd, env });
    }

    protected notifyOutput(executionId: string, stream: 'stdout' | 'stderr', chunk: Buffer): void {
        const run = this.codexRuns.get(executionId);
        if (!run || run.cancelled) {
            return;
        }
        this.client?.notifyCodexEvent({
            type: 'output',
            executionId,
            stream,
            delta: chunk.toString()
        });
    }

    protected killProcess(child: CodexProcess): Promise<void> {
        return killHiddenProcessTree(child);
    }

}
