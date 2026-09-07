import { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
    GitChangeSetBetweenRequest,
    GitChangeSetCapture,
    GitSnapshotCapture,
    GitSnapshotFileCapture,
    GitSnapshotFileContent,
    GitSnapshotFileRequest
} from '../common/agent-runtime-protocol';
import { killHiddenProcessTree } from './hidden-process';

const SNAPSHOT_MISSING_ERROR = 'スナップショットが見つかりません。';
const SNAPSHOT_TIMEOUT_ERROR = '変更の記録が時間内に完了しませんでした。';
const SNAPSHOT_CANCELLED_ERROR = '変更の記録をキャンセルしました。';
const SNAPSHOT_FAILED_ERROR = '変更の記録中に問題が発生しました。';
const SNAPSHOT_CLEANUP_ERROR = '変更の記録を安全に停止できなかったため、Agent を開始しませんでした。';
const GIT_OUTPUT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000;
const DEFAULT_PROCESS_CLEANUP_TIMEOUT_MS = 2_000;
const TEMPORARY_INDEX_PREFIX = 'poiesis-snapshot-index-';
const SNAPSHOT_ATTRIBUTES = '* -filter -text -ident -working-tree-encoding -eol\n';
export const SNAPSHOT_FILE_MAX_BYTES = 50 * 1024 * 1024;
const NPM_RUNTIME_ARTIFACT_ROOTS = [
    '.npm-cache/_npx',
    '.npm-cache/_cacache',
    '.npm-cache/_logs',
    '.npm-cache/_update-notifier-last-checked'
] as const;
const NPM_RUNTIME_ARTIFACT_EXCLUDES = [
    ':(exclude).npm-cache/_npx/**',
    ':(exclude).npm-cache/_cacache/**',
    ':(exclude).npm-cache/_logs/**',
    ':(exclude).npm-cache/_update-notifier-last-checked'
] as const;

interface SnapshotRepository {
    gitDir: string;
    workspacePath: string;
}

export interface SnapshotStoreOptions {
    captureTimeoutMs?: number;
    processCleanupTimeoutMs?: number;
    homePath?: string;
    temporaryDirectory?: string;
    gitInvocation?: {
        executable: string;
        argsPrefix?: readonly string[];
    };
    gitEnvironment?: NodeJS.ProcessEnv;
    processTreeTerminator?: (child: ChildProcess, timeoutMs: number) => Promise<void>;
}

export function defaultSnapshotStoreRoot(): string {
    if (process.env.POIESIS_SNAPSHOT_STORE_DIR) {
        return resolve(process.env.POIESIS_SNAPSHOT_STORE_DIR);
    }
    try {
        const electron = require('electron') as { app?: { getPath(name: 'userData'): string } };
        if (electron.app?.getPath) {
            return join(electron.app.getPath('userData'), 'poiesis-snapshots');
        }
    } catch {
        // The browser backend and pure tests do not necessarily run inside Electron.
    }
    return join(homedir(), '.poiesis', 'snapshots');
}

export async function isGitRepository(workspacePath: string): Promise<boolean> {
    try {
        const output = await executeGit(['rev-parse', '--is-inside-work-tree'], resolve(workspacePath));
        return output.trim() === 'true';
    } catch {
        return false;
    }
}

/** Durable workspace snapshots backed by tree objects in per-workspace bare repositories. */
export class SnapshotStore {
    protected readonly capturedWorkspaces = new Map<string, string>();
    protected readonly activeCaptures = new Map<string, Set<SnapshotCaptureContext>>();
    protected readonly workspaceLocks = new Map<string, SnapshotCaptureLock>();
    protected readonly captureTimeoutMs: number;
    protected readonly processCleanupTimeoutMs: number;
    protected readonly homePath: string;
    protected readonly temporaryDirectory: string;
    protected readonly gitInvocation: GitInvocation;
    protected readonly gitEnvironment: NodeJS.ProcessEnv;
    protected readonly processTreeTerminator: SnapshotProcessTreeTerminator;
    protected unsafeCleanupError?: SnapshotCleanupError;
    protected captureSequence = 0;
    protected disposed = false;

    constructor(
        readonly rootPath = defaultSnapshotStoreRoot(),
        protected readonly snapshotFileMaxBytes = SNAPSHOT_FILE_MAX_BYTES,
        options: SnapshotStoreOptions = {}
    ) {
        this.captureTimeoutMs = Math.max(50, options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);
        this.processCleanupTimeoutMs = Math.max(
            100,
            options.processCleanupTimeoutMs ?? DEFAULT_PROCESS_CLEANUP_TIMEOUT_MS
        );
        this.homePath = resolve(options.homePath ?? homedir());
        this.temporaryDirectory = resolve(options.temporaryDirectory ?? tmpdir());
        this.gitInvocation = {
            executable: options.gitInvocation?.executable ?? 'git',
            argsPrefix: [...options.gitInvocation?.argsPrefix ?? []]
        };
        this.gitEnvironment = { ...(options.gitEnvironment ?? process.env) };
        this.processTreeTerminator = options.processTreeTerminator ?? terminateGitProcess;
    }

    async capture(workspacePath: string, captureId?: string): Promise<GitSnapshotCapture> {
        const context = this.beginCapture(captureId);
        try {
            const resolvedWorkspace = await this.guardWorkspace(workspacePath, context);
            return await this.withWorkspaceLock(resolvedWorkspace, context, async () => {
                const repository = await this.repositoryForWorkspace(resolvedWorkspace, context);
                const snapshotId = await this.writeWorkspaceTree(repository, context);
                this.capturedWorkspaces.set(snapshotId, repository.workspacePath);
                return { source: 'git-snapshot', snapshotId };
            });
        } catch (error) {
            return {
                source: 'empty',
                error: this.captureErrorMessage(error, context),
                blocksAgentStart: context.blocksAgentStart || error instanceof SnapshotCleanupError || undefined
            };
        } finally {
            await this.finishCapture(context);
        }
    }

    async captureChangeSet(baselineSnapshotId: string, captureId?: string): Promise<GitChangeSetCapture> {
        const context = this.beginCapture(captureId);
        try {
            const capturedWorkspace = this.capturedWorkspaces.get(baselineSnapshotId);
            if (capturedWorkspace) {
                const guardedWorkspace = await this.guardWorkspace(capturedWorkspace, context);
                return await this.withWorkspaceLock(guardedWorkspace, context, async () => {
                    const repository = await this.repositoryForWorkspace(guardedWorkspace, context);
                    const endSnapshotId = await this.writeWorkspaceTree(repository, context);
                    return this.diff(repository, baselineSnapshotId, endSnapshotId, undefined, endSnapshotId, context);
                });
            }
            const repository = await this.findRepository([baselineSnapshotId], undefined, context);
            if (!repository) {
                return this.missing();
            }
            const guardedWorkspace = await this.guardWorkspace(repository.workspacePath, context);
            return await this.withWorkspaceLock(guardedWorkspace, context, async () => {
                const endSnapshotId = await this.writeWorkspaceTree(repository, context);
                return this.diff(repository, baselineSnapshotId, endSnapshotId, undefined, endSnapshotId, context);
            });
        } catch (error) {
            return { source: 'empty', diff: '', files: [], error: this.captureErrorMessage(error, context) };
        } finally {
            await this.finishCapture(context);
        }
    }

    async captureBetween(request: GitChangeSetBetweenRequest): Promise<GitChangeSetCapture> {
        const context = this.beginCapture();
        try {
            const { fromSnapshotId, toSnapshotId, paths } = request;
            const repository = await this.findRepository([fromSnapshotId, toSnapshotId], undefined, context);
            if (!repository) {
                return this.missing();
            }
            const normalizedPaths = paths === undefined ? undefined : this.normalizePaths(paths);
            if (normalizedPaths?.length === 0) {
                return { source: 'empty', diff: '', files: [], endSnapshotId: toSnapshotId };
            }
            return await this.withWorkspaceLock(repository.workspacePath, context, () =>
                this.diff(repository, fromSnapshotId, toSnapshotId, normalizedPaths, toSnapshotId, context)
            );
        } catch (error) {
            return { source: 'empty', diff: '', files: [], error: this.captureErrorMessage(error, context) };
        } finally {
            await this.finishCapture(context);
        }
    }

    async cancel(captureId: string): Promise<void> {
        const contexts = [...this.activeCaptures.get(captureId) ?? []];
        await Promise.all(contexts.map(async context => {
            await context.abort(new SnapshotCaptureError(SNAPSHOT_CANCELLED_ERROR));
            await context.done;
        }));
    }

    dispose(): void {
        this.disposed = true;
        for (const contexts of this.activeCaptures.values()) {
            for (const context of contexts) {
                void context.abort(new SnapshotCaptureError(SNAPSHOT_CANCELLED_ERROR));
            }
        }
    }

    async readFileComparison(request: GitSnapshotFileRequest): Promise<GitSnapshotFileCapture> {
        const repository = await this.findRepository(
            [request.fromSnapshotId, request.toSnapshotId],
            request.workspacePath
        );
        if (!repository) {
            const otherRepository = await this.findRepository([request.fromSnapshotId, request.toSnapshotId]);
            return {
                source: 'unavailable',
                error: otherRepository
                    ? 'このワークスペースの変更ではありません。'
                    : '保存された変更を利用できません。'
            };
        }
        const workspacePath = resolve(request.workspacePath);
        if (this.normalizeWorkspacePath(repository.workspacePath) !== this.normalizeWorkspacePath(workspacePath)) {
            return { source: 'unavailable', error: 'このワークスペースの変更ではありません。' };
        }
        const path = normalizeSnapshotPath(request.path);
        if (!path) {
            return { source: 'unavailable', error: 'ファイルを特定できません。' };
        }
        try {
            const [before, after] = await Promise.all([
                this.readSnapshotFile(repository, request.fromSnapshotId, path),
                this.readSnapshotFile(repository, request.toSnapshotId, path)
            ]);
            if (before.state === 'missing' && after.state === 'missing') {
                return { source: 'unavailable', path, error: '保存された変更にファイルが見つかりません。' };
            }
            return { source: 'snapshot-file', path, before, after };
        } catch (error) {
            return {
                source: 'unavailable',
                path,
                error: error instanceof SnapshotFileError
                    ? error.message
                    : '保存された変更を読み込めませんでした。'
            };
        }
    }

    protected async repositoryForWorkspace(
        workspacePath: string,
        context: SnapshotCaptureContext
    ): Promise<SnapshotRepository> {
        const resolvedWorkspace = resolve(workspacePath);
        const workspaceStat = await stat(resolvedWorkspace);
        if (!workspaceStat.isDirectory()) {
            throw new Error(`The Workspace directory was not found: ${resolvedWorkspace}`);
        }
        context.throwIfAborted();
        await mkdir(this.rootPath, { recursive: true });
        context.throwIfAborted();
        const normalized = this.normalizeWorkspacePath(resolvedWorkspace);
        const directoryName = `${createHash('sha1').update(normalized, 'utf8').digest('hex')}.git`;
        const gitDir = join(this.rootPath, directoryName);
        try {
            await stat(gitDir);
        } catch {
            await this.runGit(['init', '--bare', gitDir], this.rootPath, context);
        }
        return { gitDir, workspacePath: resolvedWorkspace };
    }

    protected async configureSnapshotRepository(
        repository: SnapshotRepository,
        context: SnapshotCaptureContext
    ): Promise<string> {
        const hooksPath = join(repository.gitDir, 'poiesis-hooks');
        const infoPath = join(repository.gitDir, 'info');
        await Promise.all([
            mkdir(hooksPath, { recursive: true }),
            mkdir(infoPath, { recursive: true })
        ]);
        context.throwIfAborted();
        await writeFile(join(infoPath, 'attributes'), SNAPSHOT_ATTRIBUTES, 'utf8');
        context.throwIfAborted();
        const gitConfig = ['--git-dir', repository.gitDir, 'config'];
        await this.runGit([...gitConfig, 'core.autocrlf', 'false'], repository.workspacePath, context);
        await this.runGit([...gitConfig, 'core.hooksPath', hooksPath], repository.workspacePath, context);
        await this.runGit([...gitConfig, 'core.fsmonitor', 'false'], repository.workspacePath, context);
        await this.runGit([
            ...gitConfig, 'poiesis.workspacePath', repository.workspacePath
        ], repository.workspacePath, context);
        return hooksPath;
    }

    protected async writeWorkspaceTree(
        repository: SnapshotRepository,
        context: SnapshotCaptureContext
    ): Promise<string> {
        context.throwIfAborted();
        const temporaryRoot = await mkdtemp(join(this.temporaryDirectory, TEMPORARY_INDEX_PREFIX));
        const indexFile = join(temporaryRoot, 'index');
        try {
            const hooksPath = await this.configureSnapshotRepository(repository, context);
            const trackedRuntimeArtifacts = await this.trackedRuntimeArtifactPaths(
                repository.workspacePath,
                context,
                hooksPath
            );
            const internalExcludes = await this.internalArtifactExcludes(repository.workspacePath, temporaryRoot);
            const env = {
                ...this.gitEnvironment,
                GIT_DIR: repository.gitDir,
                GIT_WORK_TREE: repository.workspacePath,
                GIT_INDEX_FILE: indexFile
            };
            const isolatedConfig = [
                '-c', 'core.autocrlf=false',
                '-c', `core.hooksPath=${hooksPath}`,
                '-c', 'core.fsmonitor=false'
            ];
            await this.runGit([...isolatedConfig, 'read-tree', '--empty'], repository.workspacePath, context, env);
            await this.runGit([
                ...isolatedConfig, 'add', '-A', '--ignore-errors', '--', '.',
                ...NPM_RUNTIME_ARTIFACT_EXCLUDES,
                ...internalExcludes
            ], repository.workspacePath, context, env);
            if (trackedRuntimeArtifacts.length > 0) {
                await this.runGit([
                    ...isolatedConfig, 'add', '-A', '-f', '--ignore-errors', '--',
                    ...trackedRuntimeArtifacts
                ], repository.workspacePath, context, env);
            }
            return (await this.runGit([
                ...isolatedConfig, 'write-tree'
            ], repository.workspacePath, context, env)).trim();
        } finally {
            try {
                await rm(temporaryRoot, { recursive: true, force: true });
            } catch (error) {
                context.throwIfAborted();
                throw error;
            }
            context.throwIfAborted();
        }
    }

    protected async diff(
        repository: SnapshotRepository,
        fromSnapshotId: string,
        toSnapshotId: string,
        paths: string[] | undefined,
        endSnapshotId: string,
        context: SnapshotCaptureContext
    ): Promise<GitChangeSetCapture> {
        const pathArgs = paths ? ['--', ...paths] : [];
        const filesOutput = await this.runGit([
            '--git-dir', repository.gitDir,
            '-c', 'core.autocrlf=false',
            '-c', 'core.quotepath=false',
            'diff-tree', '--name-only', '-r', fromSnapshotId, toSnapshotId,
            ...pathArgs
        ], repository.workspacePath, context);
        const files = filesOutput.split(/\r?\n/)
            .map(path => path.trim().replace(/\\/g, '/'))
            .filter(Boolean);
        const [trackedPaths, internalBoundaries] = await Promise.all([
            this.trackedRuntimeArtifactPaths(repository.workspacePath, context),
            this.internalArtifactBoundaries(repository.workspacePath)
        ]);
        context.throwIfAborted();
        const trackedRuntimeArtifacts = new Set(trackedPaths);
        const filteredFiles = files.filter(path => !this.isInternalArtifact(path, internalBoundaries)
            && (!this.isNpmRuntimeArtifact(path) || trackedRuntimeArtifacts.has(this.comparablePath(path))));
        if (filteredFiles.length === 0) {
            return { source: 'empty', diff: '', files: [], endSnapshotId };
        }
        const diff = await this.runGit([
            '--git-dir', repository.gitDir,
            '-c', 'core.autocrlf=false',
            '-c', 'core.quotepath=false',
            'diff-tree', '-p', '--binary', '--no-color', '--find-renames',
            fromSnapshotId, toSnapshotId,
            '--', ...filteredFiles
        ], repository.workspacePath, context);
        return diff
            ? { source: 'task-diff', diff, files: filteredFiles, endSnapshotId }
            : { source: 'empty', diff: '', files: [], endSnapshotId };
    }

    protected async trackedRuntimeArtifactPaths(
        workspacePath: string,
        context?: SnapshotCaptureContext,
        hooksPath?: string
    ): Promise<string[]> {
        try {
            const output = await this.runGit([
                '-c', 'core.quotepath=false',
                '-c', 'core.fsmonitor=false',
                ...hooksPath ? ['-c', `core.hooksPath=${hooksPath}`] : [],
                'ls-files', '-z', '--cached', '--',
                ...NPM_RUNTIME_ARTIFACT_ROOTS
            ], workspacePath, context);
            return [...new Set(output.split('\0')
                .map(path => path.replace(/\\/g, '/').replace(/^\.\//, ''))
                .filter(path => path && this.isNpmRuntimeArtifact(path))
                .map(path => this.comparablePath(path)))]
                .sort();
        } catch {
            context?.throwIfAborted();
            return [];
        }
    }

    protected async readSnapshotFile(
        repository: SnapshotRepository,
        snapshotId: string,
        path: string
    ): Promise<GitSnapshotFileContent> {
        const object = `${snapshotId}:${path}`;
        const exists = await this.runGit(['--git-dir', repository.gitDir, 'cat-file', '-e', object], repository.workspacePath)
            .then(() => true, () => false);
        if (!exists) {
            return { state: 'missing' };
        }
        const type = (await this.runGit([
            '--git-dir', repository.gitDir, 'cat-file', '-t', object
        ], repository.workspacePath)).trim();
        if (type !== 'blob') {
            throw new SnapshotFileError('保存された項目はテキストファイルではありません。');
        }
        const size = Number((await this.runGit([
            '--git-dir', repository.gitDir, 'cat-file', '-s', object
        ], repository.workspacePath)).trim());
        if (!Number.isSafeInteger(size) || size < 0 || size > this.snapshotFileMaxBytes) {
            throw new SnapshotFileError('ファイルが大きすぎるため、変更を表示できません。');
        }
        const buffer = await this.runGitBuffer([
            '--git-dir', repository.gitDir, 'cat-file', 'blob', object
        ], repository.workspacePath);
        if (buffer.includes(0)) {
            throw new SnapshotFileError('バイナリファイルの変更は表示できません。');
        }
        try {
            return { state: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(buffer) };
        } catch {
            throw new SnapshotFileError('この文字コードのファイルは表示できません。');
        }
    }

    protected isNpmRuntimeArtifact(path: string): boolean {
        const comparable = this.comparablePath(path);
        return comparable === '.npm-cache/_update-notifier-last-checked'
            || comparable.startsWith('.npm-cache/_npx/')
            || comparable.startsWith('.npm-cache/_cacache/')
            || comparable.startsWith('.npm-cache/_logs/');
    }

    protected comparablePath(path: string): string {
        const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
        return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
    }

    protected async findRepository(
        snapshotIds: string[],
        expectedWorkspacePath?: string,
        context?: SnapshotCaptureContext
    ): Promise<SnapshotRepository | undefined> {
        context?.throwIfAborted();
        if (snapshotIds.some(snapshotId => !/^[0-9a-f]{40}$/i.test(snapshotId))) {
            return undefined;
        }
        let entries;
        try {
            entries = await readdir(this.rootPath, { withFileTypes: true });
        } catch {
            context?.throwIfAborted();
            return undefined;
        }
        for (const entry of entries) {
            context?.throwIfAborted();
            if (!entry.isDirectory() || !entry.name.endsWith('.git')) {
                continue;
            }
            const gitDir = join(this.rootPath, entry.name);
            const containsAll = await Promise.all(snapshotIds.map(snapshotId =>
                this.runGit(['--git-dir', gitDir, 'cat-file', '-e', `${snapshotId}^{tree}`], this.rootPath, context)
                    .then(() => true, () => {
                        context?.throwIfAborted();
                        return false;
                    })
            ));
            context?.throwIfAborted();
            if (!containsAll.every(Boolean)) {
                continue;
            }
            try {
                const storedWorkspacePath = (await this.runGit([
                    '--git-dir', gitDir, 'config', '--get', 'poiesis.workspacePath'
                ], this.rootPath, context)).trim();
                if (storedWorkspacePath) {
                    const resolvedWorkspace = resolve(storedWorkspacePath);
                    if (expectedWorkspacePath && this.normalizeWorkspacePath(resolvedWorkspace)
                        !== this.normalizeWorkspacePath(expectedWorkspacePath)) {
                        continue;
                    }
                    return { gitDir, workspacePath: resolvedWorkspace };
                }
            } catch {
                context?.throwIfAborted();
                // Ignore malformed or unrelated bare repositories in the store root.
            }
        }
        return undefined;
    }

    protected normalizePaths(paths: string[]): string[] {
        return [...new Set(paths.map(normalizeSnapshotPath).filter((path): path is string => Boolean(path)))]
            .sort();
    }

    protected normalizeWorkspacePath(workspacePath: string): string {
        const normalized = resolve(workspacePath).replace(/\\/g, '/').replace(/\/$/, '');
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }

    protected async guardWorkspace(
        workspacePath: string,
        context: SnapshotCaptureContext
    ): Promise<string> {
        const resolvedWorkspace = resolve(workspacePath);
        if (dirname(resolvedWorkspace) === resolvedWorkspace) {
            throw new SnapshotCaptureError('ドライブ全体では変更を記録しません。');
        }
        let workspaceStat;
        try {
            workspaceStat = await stat(resolvedWorkspace);
        } catch {
            context.throwIfAborted();
            throw new SnapshotCaptureError('作業フォルダーが見つかりません。');
        }
        if (!workspaceStat.isDirectory()) {
            throw new SnapshotCaptureError('作業フォルダーが見つかりません。');
        }
        context.throwIfAborted();
        const [canonicalWorkspace, canonicalHome, canonicalStore] = await Promise.all([
            this.canonicalPath(resolvedWorkspace),
            this.canonicalPath(this.homePath),
            this.canonicalPath(this.rootPath)
        ]);
        context.throwIfAborted();
        if (pathIsWithin(canonicalWorkspace, canonicalHome)) {
            throw new SnapshotCaptureError('ホームフォルダー全体では変更を記録しません。');
        }
        if (pathIsWithin(canonicalStore, canonicalWorkspace)) {
            throw new SnapshotCaptureError('変更記録の保存場所は記録対象にできません。');
        }
        return resolvedWorkspace;
    }

    protected async internalArtifactExcludes(workspacePath: string, temporaryRoot: string): Promise<string[]> {
        const excludes = new Set<string>();
        const snapshotStorePath = await this.relativeContainedPath(workspacePath, this.rootPath);
        if (snapshotStorePath) {
            excludes.add(`:(top,exclude,literal)${snapshotStorePath}`);
        }
        const temporaryRootPath = await this.relativeContainedPath(workspacePath, temporaryRoot);
        if (temporaryRootPath) {
            excludes.add(`:(top,exclude,literal)${temporaryRootPath}`);
        }
        const temporaryDirectoryPath = await this.relativeContainedPath(workspacePath, this.temporaryDirectory);
        if (temporaryDirectoryPath) {
            excludes.add(`:(top,glob,exclude)${escapeGitGlob(temporaryDirectoryPath)}/${TEMPORARY_INDEX_PREFIX}*/**`);
        }
        return [...excludes];
    }

    protected async internalArtifactBoundaries(workspacePath: string): Promise<{
        snapshotStorePath?: string;
        temporaryDirectoryPath?: string;
    }> {
        const [snapshotStorePath, temporaryDirectoryPath] = await Promise.all([
            this.relativeContainedPath(workspacePath, this.rootPath),
            this.relativeContainedPath(workspacePath, this.temporaryDirectory)
        ]);
        return { snapshotStorePath, temporaryDirectoryPath };
    }

    protected isInternalArtifact(
        candidate: string,
        boundaries: { snapshotStorePath?: string; temporaryDirectoryPath?: string }
    ): boolean {
        const comparable = this.comparablePath(candidate);
        const snapshotStorePath = boundaries.snapshotStorePath;
        if (snapshotStorePath) {
            const store = this.comparablePath(snapshotStorePath);
            if (comparable === store || comparable.startsWith(`${store}/`)) {
                return true;
            }
        }
        const temporaryDirectoryPath = boundaries.temporaryDirectoryPath;
        if (!temporaryDirectoryPath) {
            return false;
        }
        const temporary = this.comparablePath(temporaryDirectoryPath);
        const relativeToTemporary = comparable.slice(temporary.length).replace(/^\//, '');
        return (comparable === temporary || comparable.startsWith(`${temporary}/`))
            && relativeToTemporary.split('/')[0]?.startsWith(this.comparablePath(TEMPORARY_INDEX_PREFIX));
    }

    protected async relativeContainedPath(workspacePath: string, candidatePath: string): Promise<string | undefined> {
        const resolvedWorkspace = resolve(workspacePath);
        const resolvedCandidate = resolve(candidatePath);
        if (pathIsWithin(resolvedWorkspace, resolvedCandidate)) {
            return normalizeRelativePath(relative(resolvedWorkspace, resolvedCandidate));
        }
        const [canonicalWorkspace, canonicalCandidate] = await Promise.all([
            this.canonicalPath(resolvedWorkspace),
            this.canonicalPath(resolvedCandidate)
        ]);
        return pathIsWithin(canonicalWorkspace, canonicalCandidate)
            ? normalizeRelativePath(relative(canonicalWorkspace, canonicalCandidate))
            : undefined;
    }

    protected async canonicalPath(candidate: string): Promise<string> {
        try {
            return await realpath(resolve(candidate));
        } catch {
            return resolve(candidate);
        }
    }

    protected beginCapture(captureId = `snapshot-${Date.now()}-${++this.captureSequence}`): SnapshotCaptureContext {
        const context = new SnapshotCaptureContext(
            captureId,
            this.captureTimeoutMs,
            this.processCleanupTimeoutMs,
            cleanupError => {
                if (this.unsafeCleanupError) {
                    return;
                }
                this.unsafeCleanupError = cleanupError;
                for (const captures of this.activeCaptures.values()) {
                    for (const activeCapture of captures) {
                        activeCapture.markCleanupFailure(cleanupError);
                    }
                }
            }
        );
        const captures = this.activeCaptures.get(captureId) ?? new Set<SnapshotCaptureContext>();
        captures.add(context);
        this.activeCaptures.set(captureId, captures);
        if (this.disposed) {
            void context.abort(new SnapshotCaptureError(SNAPSHOT_CANCELLED_ERROR));
        } else if (this.unsafeCleanupError) {
            context.markCleanupFailure(this.unsafeCleanupError);
        }
        return context;
    }

    protected async finishCapture(context: SnapshotCaptureContext): Promise<void> {
        await context.finish();
        const captures = this.activeCaptures.get(context.id);
        captures?.delete(context);
        if (captures?.size === 0) {
            this.activeCaptures.delete(context.id);
        }
    }

    protected async withWorkspaceLock<T>(
        workspacePath: string,
        context: SnapshotCaptureContext,
        action: () => Promise<T>
    ): Promise<T> {
        const key = this.normalizeWorkspacePath(workspacePath);
        const lock = this.workspaceLocks.get(key) ?? new SnapshotCaptureLock();
        this.workspaceLocks.set(key, lock);
        const release = await lock.acquire(context);
        try {
            context.throwIfAborted();
            return await action();
        } finally {
            release();
            if (lock.idle && this.workspaceLocks.get(key) === lock) {
                this.workspaceLocks.delete(key);
            }
        }
    }

    protected runGit(
        args: string[],
        cwd: string,
        context?: SnapshotCaptureContext,
        env: NodeJS.ProcessEnv = this.gitEnvironment
    ): Promise<string> {
        return executeGit(
            args,
            cwd,
            env,
            context,
            this.gitInvocation,
            this.processCleanupTimeoutMs,
            this.processTreeTerminator
        );
    }

    protected runGitBuffer(
        args: string[],
        cwd: string,
        context?: SnapshotCaptureContext,
        env: NodeJS.ProcessEnv = this.gitEnvironment
    ): Promise<Buffer> {
        return executeGitBuffer(
            args,
            cwd,
            env,
            context,
            this.gitInvocation,
            this.processCleanupTimeoutMs,
            this.processTreeTerminator
        );
    }

    protected missing(): GitChangeSetCapture {
        return { source: 'empty', diff: '', files: [], error: SNAPSHOT_MISSING_ERROR };
    }

    protected errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    protected captureErrorMessage(error: unknown, context?: SnapshotCaptureContext): string {
        if (context?.blocksAgentStart) {
            return context.error.message;
        }
        return error instanceof SnapshotCaptureError ? error.message : SNAPSHOT_FAILED_ERROR;
    }
}

class SnapshotFileError extends Error { }

class SnapshotCaptureError extends Error { }

class SnapshotCleanupError extends SnapshotCaptureError {
    constructor() {
        super(SNAPSHOT_CLEANUP_ERROR);
    }
}

interface GitInvocation {
    executable: string;
    argsPrefix: readonly string[];
}

type SnapshotProcessTreeTerminator = (child: ChildProcess, timeoutMs: number) => Promise<void>;

class SnapshotCaptureContext {
    readonly controller = new AbortController();
    readonly done: Promise<void>;
    protected finishDone!: () => void;
    protected readonly timeout: NodeJS.Timeout;
    protected readonly cleanupPromises = new Set<Promise<void>>();
    protected abortError?: SnapshotCaptureError;
    protected cleanupError?: SnapshotCleanupError;
    protected finished = false;

    constructor(
        readonly id: string,
        timeoutMs: number,
        readonly processCleanupTimeoutMs: number,
        protected readonly onCleanupFailure: (error: SnapshotCleanupError) => void
    ) {
        this.done = new Promise(resolvePromise => {
            this.finishDone = resolvePromise;
        });
        this.timeout = setTimeout(() => {
            void this.abort(new SnapshotCaptureError(SNAPSHOT_TIMEOUT_ERROR));
        }, timeoutMs);
    }

    get signal(): AbortSignal {
        return this.controller.signal;
    }

    get error(): SnapshotCaptureError {
        return this.cleanupError ?? this.abortError ?? new SnapshotCaptureError(SNAPSHOT_CANCELLED_ERROR);
    }

    get blocksAgentStart(): boolean {
        return Boolean(this.cleanupError);
    }

    throwIfAborted(): void {
        if (this.cleanupError) {
            throw this.cleanupError;
        }
        if (this.signal.aborted) {
            throw this.error;
        }
    }

    trackCleanup(cleanup: Promise<void>): void {
        this.cleanupPromises.add(cleanup);
        void cleanup.then(
            () => this.cleanupPromises.delete(cleanup),
            () => {
                this.cleanupPromises.delete(cleanup);
                this.markCleanupFailure();
            }
        );
    }

    markCleanupFailure(error = new SnapshotCleanupError()): void {
        if (!this.cleanupError) {
            this.cleanupError = error;
            this.onCleanupFailure(error);
        }
        if (!this.signal.aborted) {
            this.abortError = this.cleanupError;
            this.controller.abort();
        }
    }

    async abort(error: SnapshotCaptureError): Promise<void> {
        if (!this.signal.aborted) {
            this.abortError = error;
            this.controller.abort();
        }
        await Promise.allSettled([...this.cleanupPromises]);
    }

    async finish(): Promise<void> {
        if (this.finished) {
            return;
        }
        this.finished = true;
        clearTimeout(this.timeout);
        await Promise.allSettled([...this.cleanupPromises]);
        this.finishDone();
    }
}

interface SnapshotCaptureWaiter {
    context: SnapshotCaptureContext;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    onAbort: () => void;
}

class SnapshotCaptureLock {
    protected locked = false;
    protected readonly waiters: SnapshotCaptureWaiter[] = [];

    get idle(): boolean {
        return !this.locked && this.waiters.length === 0;
    }

    acquire(context: SnapshotCaptureContext): Promise<() => void> {
        context.throwIfAborted();
        if (!this.locked) {
            this.locked = true;
            return Promise.resolve(this.releaseFunction());
        }
        return new Promise((resolvePromise, reject) => {
            const waiter: SnapshotCaptureWaiter = {
                context,
                resolve: resolvePromise,
                reject,
                onAbort: () => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) {
                        this.waiters.splice(index, 1);
                    }
                    reject(context.error);
                }
            };
            this.waiters.push(waiter);
            context.signal.addEventListener('abort', waiter.onAbort, { once: true });
        });
    }

    protected releaseFunction(): () => void {
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.release();
        };
    }

    protected release(): void {
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!;
            waiter.context.signal.removeEventListener('abort', waiter.onAbort);
            if (waiter.context.signal.aborted) {
                waiter.reject(waiter.context.error);
                continue;
            }
            waiter.resolve(this.releaseFunction());
            return;
        }
        this.locked = false;
    }
}

export function normalizeSnapshotPath(candidate: unknown): string | undefined {
    if (typeof candidate !== 'string' || !candidate || /[\0\r\n]/.test(candidate)
        || isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) {
        return undefined;
    }
    const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
    const segments = normalized.split('/');
    if (!normalized || segments.some(segment => !segment || segment === '.' || segment === '..')) {
        return undefined;
    }
    return segments.join('/');
}

function executeGit(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
    context?: SnapshotCaptureContext,
    invocation: GitInvocation = { executable: 'git', argsPrefix: [] },
    processCleanupTimeoutMs = DEFAULT_PROCESS_CLEANUP_TIMEOUT_MS,
    processTreeTerminator: SnapshotProcessTreeTerminator = terminateGitProcess
): Promise<string> {
    return executeGitBuffer(args, cwd, env, context, invocation, processCleanupTimeoutMs, processTreeTerminator)
        .then(output => output.toString('utf8'));
}

function executeGitBuffer(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
    context?: SnapshotCaptureContext,
    invocation: GitInvocation = { executable: 'git', argsPrefix: [] },
    processCleanupTimeoutMs = DEFAULT_PROCESS_CLEANUP_TIMEOUT_MS,
    processTreeTerminator: SnapshotProcessTreeTerminator = terminateGitProcess
): Promise<Buffer> {
    context?.throwIfAborted();
    return new Promise((resolvePromise, reject) => {
        let settled = false;
        let terminating: Promise<void> | undefined;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        const child = spawn(invocation.executable, [...invocation.argsPrefix, ...args], {
            cwd,
            env,
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const finish = (error?: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            context?.signal.removeEventListener('abort', onAbort);
            if (error) {
                reject(error);
            } else {
                resolvePromise(Buffer.concat(stdout));
            }
        };
        const terminate = (error: unknown): void => {
            if (!terminating) {
                terminating = processTreeTerminator(child, processCleanupTimeoutMs);
                context?.trackCleanup(terminating);
            }
            void terminating.then(
                () => finish(error),
                () => {
                    context?.markCleanupFailure();
                    finish(context?.error ?? new SnapshotCleanupError());
                }
            );
        };
        const onAbort = (): void => terminate(context?.error ?? new SnapshotCaptureError(SNAPSHOT_CANCELLED_ERROR));
        const collect = (target: Buffer[], chunk: Buffer | string): void => {
            if (terminating) {
                return;
            }
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            outputBytes += buffer.length;
            if (outputBytes > GIT_OUTPUT_MAX_BYTES) {
                terminate(new SnapshotCaptureError(SNAPSHOT_FAILED_ERROR));
                return;
            }
            target.push(buffer);
        };
        child.stdout?.on('data', chunk => collect(stdout, chunk));
        child.stderr?.on('data', chunk => collect(stderr, chunk));
        child.once('error', error => terminate(error));
        child.once('close', code => {
            if (terminating) {
                return;
            } else if (context?.signal.aborted) {
                terminate(context.error);
            } else if (code === 0) {
                finish();
            } else {
                const detail = Buffer.concat(stderr).toString('utf8').trim().slice(-4_000);
                finish(new Error(`Git exited with code ${code ?? 'unknown'}.${detail ? ` ${detail}` : ''}`));
            }
        });
        if (context?.signal.aborted) {
            onAbort();
        } else {
            context?.signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

async function terminateGitProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
    await killHiddenProcessTree(child, timeoutMs, true);
}

function pathIsWithin(parent: string, candidate: string): boolean {
    const parentPath = resolve(parent);
    const candidatePath = resolve(candidate);
    const comparisonParent = process.platform === 'win32' ? parentPath.toLocaleLowerCase() : parentPath;
    const comparisonCandidate = process.platform === 'win32' ? candidatePath.toLocaleLowerCase() : candidatePath;
    const relativePath = relative(comparisonParent, comparisonCandidate);
    return relativePath === '' || relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath);
}

function normalizeRelativePath(candidate: string): string | undefined {
    const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    return normalized || undefined;
}

function escapeGitGlob(candidate: string): string {
    return candidate.replace(/\[/g, '[[]').replace(/\*/g, '[*]').replace(/\?/g, '[?]');
}
