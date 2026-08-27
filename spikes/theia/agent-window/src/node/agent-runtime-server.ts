import { ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { injectable, inject } from '@theia/core/shared/inversify';
import {
    AgentRuntimeClient,
    AgentRuntimeServer,
    CliDetectionReport,
    CodexExecutionRequest,
    CreateFolderRequest,
    FolderBrowserRequest,
    FolderBrowserResult,
    GitChangeSetCapture,
    GitChangeSetRequest,
    GitSnapshotCapture,
    GitSnapshotRequest
} from '../common/agent-runtime-protocol';
import { CliDetector } from './cli-detector';

interface SnapshotEntry {
    content: Buffer;
    executable: boolean;
    kind: 'file' | 'symlink';
}

interface WorkspaceSnapshot {
    repositoryRoot: string;
    workspacePath: string;
    entries: Map<string, SnapshotEntry>;
}

type CodexProcess = ChildProcessByStdio<null, Readable, Readable>;

interface CodexRun {
    process: CodexProcess;
    cancelled: boolean;
}

@injectable()
export class AgentRuntimeServerImpl implements AgentRuntimeServer {
    protected readonly snapshots = new Map<string, WorkspaceSnapshot>();
    protected readonly codexRuns = new Map<string, CodexRun>();
    protected client?: AgentRuntimeClient;
    protected snapshotSequence = 0;

    constructor(@inject(CliDetector) protected readonly cliDetector: CliDetector) { }

    setClient(client: AgentRuntimeClient | undefined): void {
        this.client = client;
    }

    dispose(): void {
        for (const run of this.codexRuns.values()) {
            run.cancelled = true;
            run.process.kill();
        }
        this.codexRuns.clear();
        this.snapshots.clear();
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
        try {
            const resolvedWorkspace = await this.resolveWorkspace(workspacePath);
            const snapshot = await this.captureWorkspace(resolvedWorkspace);
            const snapshotId = `git-snapshot-${Date.now()}-${++this.snapshotSequence}`;
            this.snapshots.set(snapshotId, snapshot);
            return { source: 'git-snapshot', snapshotId };
        } catch (error) {
            return {
                source: 'empty',
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    async captureGitChangeSet({ baselineSnapshotId }: GitChangeSetRequest): Promise<GitChangeSetCapture> {
        const baseline = this.snapshots.get(baselineSnapshotId);
        this.snapshots.delete(baselineSnapshotId);
        if (!baseline) {
            return {
                source: 'empty',
                diff: '',
                files: [],
                error: 'The Task baseline snapshot expired or was not found.'
            };
        }

        try {
            const current = await this.captureWorkspace(baseline.workspacePath);
            const files = this.changedFiles(baseline.entries, current.entries);
            if (files.length === 0) {
                return { source: 'empty', diff: '', files: [] };
            }
            const diff = await this.diffSnapshots(baseline, current, files);
            return diff
                ? { source: 'task-diff', diff, files }
                : { source: 'empty', diff: '', files: [] };
        } catch (error) {
            return {
                source: 'empty',
                diff: '',
                files: [],
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    async runCodex({ executionId, workspacePath, prompt }: CodexExecutionRequest): Promise<void> {
        if (process.platform !== 'win32') {
            throw new Error('This implementation slice runs Codex only on Windows.');
        }
        if (this.codexRuns.has(executionId)) {
            throw new Error(`Codex execution already exists: ${executionId}`);
        }
        if (!workspacePath) {
            throw new Error('No workspace root is open.');
        }

        const report = this.cliDetector.recordedReport ?? await this.cliDetector.detect();
        const codex = report.detections.find(item => item.id === 'codex');
        if (codex?.status !== 'found' || !codex.path) {
            throw new Error('Codex is not installed.');
        }

        const resolvedWorkspace = await this.resolveWorkspace(workspacePath);
        const args = [
            'exec',
            '--json',
            '--color', 'never',
            '--sandbox', 'workspace-write',
            '-C', resolvedWorkspace,
            '--', prompt
        ];
        const child = this.spawnCodex(codex.path, args, resolvedWorkspace);
        const run: CodexRun = { process: child, cancelled: false };
        this.codexRuns.set(executionId, run);

        child.stdout.on('data', chunk => this.notifyOutput(executionId, 'stdout', chunk));
        child.stderr.on('data', chunk => this.notifyOutput(executionId, 'stderr', chunk));
        child.once('error', error => {
            this.notifyOutput(executionId, 'stderr', Buffer.from(`Codex process error: ${error.message}\n`));
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

    protected async captureWorkspace(workspacePath: string): Promise<WorkspaceSnapshot> {
        const resolvedWorkspacePath = resolve(workspacePath);
        const repositoryRoot = (await this.git(
            ['rev-parse', '--show-toplevel'],
            resolvedWorkspacePath
        )).trim();
        const listed = await this.git([
            'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--full-name', '--', '.'
        ], resolvedWorkspacePath);
        const paths = listed.split('\0').filter(Boolean).sort();
        const entries = new Map<string, SnapshotEntry>();

        for (const path of paths) {
            const absolutePath = this.safePath(repositoryRoot, path);
            try {
                const stats = await lstat(absolutePath);
                if (stats.isSymbolicLink()) {
                    entries.set(path, {
                        content: Buffer.from(await readlink(absolutePath)),
                        executable: false,
                        kind: 'symlink'
                    });
                } else if (stats.isFile()) {
                    entries.set(path, {
                        content: await readFile(absolutePath),
                        executable: (stats.mode & 0o111) !== 0,
                        kind: 'file'
                    });
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
        }

        return { repositoryRoot, workspacePath: resolvedWorkspacePath, entries };
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

    protected spawnCodex(command: string, args: string[], cwd: string): CodexProcess {
        if (!['.cmd', '.bat'].includes(extname(command).toLocaleLowerCase())) {
            return spawn(command, args, {
                cwd, windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        }

        const entryPoint = join(dirname(command), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        return spawn(process.execPath, [entryPoint, ...args], {
            cwd, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
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
        if (process.platform !== 'win32' || child.pid === undefined) {
            child.kill();
            return Promise.resolve();
        }
        return new Promise(resolvePromise => {
            const killer = spawn(
                'taskkill',
                ['/pid', String(child.pid), '/T', '/F'],
                { windowsHide: true }
            );
            killer.once('error', () => {
                child.kill();
                resolvePromise();
            });
            killer.once('close', () => {
                child.kill();
                resolvePromise();
            });
        });
    }

    protected changedFiles(
        baseline: Map<string, SnapshotEntry>,
        current: Map<string, SnapshotEntry>
    ): string[] {
        return [...new Set([...baseline.keys(), ...current.keys()])]
            .filter(path => !this.entriesEqual(baseline.get(path), current.get(path)))
            .sort();
    }

    protected entriesEqual(left?: SnapshotEntry, right?: SnapshotEntry): boolean {
        return left === right || !!left && !!right
            && left.kind === right.kind
            && left.executable === right.executable
            && left.content.equals(right.content);
    }

    protected async diffSnapshots(
        baseline: WorkspaceSnapshot,
        current: WorkspaceSnapshot,
        files: string[]
    ): Promise<string> {
        const temporaryRoot = await mkdtemp(join(tmpdir(), 'poiesis-task-diff-'));
        const beforeRoot = join(temporaryRoot, 'before');
        const afterRoot = join(temporaryRoot, 'after');
        try {
            await Promise.all([
                this.writeSnapshot(beforeRoot, baseline.entries, files),
                this.writeSnapshot(afterRoot, current.entries, files)
            ]);
            const diff = await this.git([
                '-c', 'core.autocrlf=false',
                'diff', '--no-index', '--binary', '--no-color', '--find-renames', '--', 'before', 'after'
            ], temporaryRoot, true);
            return this.normalizeSnapshotPaths(diff);
        } finally {
            await rm(temporaryRoot, { recursive: true, force: true });
        }
    }

    protected async writeSnapshot(
        root: string,
        entries: Map<string, SnapshotEntry>,
        files: string[]
    ): Promise<void> {
        await mkdir(root, { recursive: true });
        for (const path of files) {
            const entry = entries.get(path);
            if (!entry) {
                continue;
            }
            const destination = this.safePath(root, path);
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, entry.content, { mode: entry.executable ? 0o755 : 0o644 });
        }
    }

    protected normalizeSnapshotPaths(diff: string): string {
        return diff.split('\n').map(line => {
            if (line.startsWith('diff --git ')) {
                return line.replace('a/before/', 'a/').replace('b/after/', 'b/');
            }
            if (line.startsWith('--- a/before/')) {
                return line.replace('--- a/before/', '--- a/');
            }
            if (line.startsWith('+++ b/after/')) {
                return line.replace('+++ b/after/', '+++ b/');
            }
            if (line.startsWith('rename from before/')) {
                return line.replace('rename from before/', 'rename from ');
            }
            if (line.startsWith('rename to after/')) {
                return line.replace('rename to after/', 'rename to ');
            }
            if (line.startsWith('Binary files ')) {
                return line.replace('a/before/', 'a/').replace('b/after/', 'b/');
            }
            return line;
        }).join('\n');
    }

    protected safePath(root: string, gitPath: string): string {
        const path = resolve(root, ...gitPath.split('/'));
        const pathWithinRoot = relative(root, path);
        if (pathWithinRoot.startsWith('..') || isAbsolute(pathWithinRoot)) {
            throw new Error(`Git returned a path outside the workspace: ${gitPath}`);
        }
        return path;
    }

    protected git(args: string[], cwd: string, acceptDiff = false): Promise<string> {
        return new Promise((resolvePromise, reject) => {
            execFile(
                'git',
                args,
                { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
                (error, stdout) => {
                    if (error && !(acceptDiff && error.code === 1)) {
                        reject(error);
                    } else {
                        resolvePromise(stdout);
                    }
                }
            );
        });
    }
}
