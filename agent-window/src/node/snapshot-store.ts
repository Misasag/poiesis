import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
    GitChangeSetBetweenRequest,
    GitChangeSetCapture,
    GitSnapshotCapture,
    GitSnapshotFileCapture,
    GitSnapshotFileContent,
    GitSnapshotFileRequest
} from '../common/agent-runtime-protocol';

const SNAPSHOT_MISSING_ERROR = 'スナップショットが見つかりません。';
const GIT_OUTPUT_MAX_BYTES = 100 * 1024 * 1024;
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
        const output = await runGit(['rev-parse', '--is-inside-work-tree'], resolve(workspacePath));
        return output.trim() === 'true';
    } catch {
        return false;
    }
}

/** Durable workspace snapshots backed by tree objects in per-workspace bare repositories. */
export class SnapshotStore {
    protected readonly capturedWorkspaces = new Map<string, string>();

    constructor(
        readonly rootPath = defaultSnapshotStoreRoot(),
        protected readonly snapshotFileMaxBytes = SNAPSHOT_FILE_MAX_BYTES
    ) { }

    async capture(workspacePath: string): Promise<GitSnapshotCapture> {
        try {
            const repository = await this.repositoryForWorkspace(workspacePath);
            const snapshotId = await this.writeWorkspaceTree(repository);
            this.capturedWorkspaces.set(snapshotId, repository.workspacePath);
            return { source: 'git-snapshot', snapshotId };
        } catch (error) {
            return { source: 'empty', error: this.errorMessage(error) };
        }
    }

    async captureChangeSet(baselineSnapshotId: string): Promise<GitChangeSetCapture> {
        const capturedWorkspace = this.capturedWorkspaces.get(baselineSnapshotId);
        const repository = capturedWorkspace
            ? await this.repositoryForWorkspace(capturedWorkspace).catch(() => undefined)
            : await this.findRepository([baselineSnapshotId]);
        if (!repository) {
            return this.missing();
        }
        try {
            const endSnapshotId = await this.writeWorkspaceTree(repository);
            return await this.diff(repository, baselineSnapshotId, endSnapshotId, undefined, endSnapshotId);
        } catch (error) {
            return { source: 'empty', diff: '', files: [], error: this.errorMessage(error) };
        }
    }

    async captureBetween(request: GitChangeSetBetweenRequest): Promise<GitChangeSetCapture> {
        const { fromSnapshotId, toSnapshotId, paths } = request;
        const repository = await this.findRepository([fromSnapshotId, toSnapshotId]);
        if (!repository) {
            return this.missing();
        }
        try {
            const normalizedPaths = paths === undefined ? undefined : this.normalizePaths(paths);
            if (normalizedPaths?.length === 0) {
                return { source: 'empty', diff: '', files: [], endSnapshotId: toSnapshotId };
            }
            return await this.diff(repository, fromSnapshotId, toSnapshotId, normalizedPaths, toSnapshotId);
        } catch (error) {
            return { source: 'empty', diff: '', files: [], error: this.errorMessage(error) };
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

    protected async repositoryForWorkspace(workspacePath: string): Promise<SnapshotRepository> {
        const resolvedWorkspace = resolve(workspacePath);
        const workspaceStat = await stat(resolvedWorkspace);
        if (!workspaceStat.isDirectory()) {
            throw new Error(`The Workspace directory was not found: ${resolvedWorkspace}`);
        }
        await mkdir(this.rootPath, { recursive: true });
        const normalized = this.normalizeWorkspacePath(resolvedWorkspace);
        const directoryName = `${createHash('sha1').update(normalized, 'utf8').digest('hex')}.git`;
        const gitDir = join(this.rootPath, directoryName);
        try {
            await stat(gitDir);
        } catch {
            await runGit(['init', '--bare', gitDir], this.rootPath);
        }
        await runGit(['--git-dir', gitDir, 'config', 'core.autocrlf', 'false'], resolvedWorkspace);
        await runGit(['--git-dir', gitDir, 'config', 'poiesis.workspacePath', resolvedWorkspace], resolvedWorkspace);
        return { gitDir, workspacePath: resolvedWorkspace };
    }

    protected async writeWorkspaceTree(repository: SnapshotRepository): Promise<string> {
        const temporaryRoot = await mkdtemp(join(tmpdir(), 'poiesis-snapshot-index-'));
        const indexFile = join(temporaryRoot, 'index');
        const trackedRuntimeArtifacts = await this.trackedRuntimeArtifactPaths(repository.workspacePath);
        const env = {
            ...process.env,
            GIT_DIR: repository.gitDir,
            GIT_WORK_TREE: repository.workspacePath,
            GIT_INDEX_FILE: indexFile
        };
        try {
            await runGit(['-c', 'core.autocrlf=false', 'read-tree', '--empty'], repository.workspacePath, env);
            await runGit([
                '-c', 'core.autocrlf=false', 'add', '-A', '--ignore-errors', '--', '.',
                ...NPM_RUNTIME_ARTIFACT_EXCLUDES
            ], repository.workspacePath, env);
            if (trackedRuntimeArtifacts.length > 0) {
                await runGit([
                    '-c', 'core.autocrlf=false', 'add', '-A', '-f', '--ignore-errors', '--',
                    ...trackedRuntimeArtifacts
                ], repository.workspacePath, env);
            }
            return (await runGit([
                '-c', 'core.autocrlf=false', 'write-tree'
            ], repository.workspacePath, env)).trim();
        } finally {
            await rm(temporaryRoot, { recursive: true, force: true });
        }
    }

    protected async diff(
        repository: SnapshotRepository,
        fromSnapshotId: string,
        toSnapshotId: string,
        paths: string[] | undefined,
        endSnapshotId: string
    ): Promise<GitChangeSetCapture> {
        const pathArgs = paths ? ['--', ...paths] : [];
        const filesOutput = await runGit([
            '--git-dir', repository.gitDir,
            '-c', 'core.autocrlf=false',
            '-c', 'core.quotepath=false',
            'diff-tree', '--name-only', '-r', fromSnapshotId, toSnapshotId,
            ...pathArgs
        ], repository.workspacePath);
        const files = filesOutput.split(/\r?\n/)
            .map(path => path.trim().replace(/\\/g, '/'))
            .filter(Boolean);
        const trackedRuntimeArtifacts = new Set(await this.trackedRuntimeArtifactPaths(repository.workspacePath));
        const filteredFiles = files.filter(path =>
            !this.isNpmRuntimeArtifact(path) || trackedRuntimeArtifacts.has(this.comparablePath(path))
        );
        if (filteredFiles.length === 0) {
            return { source: 'empty', diff: '', files: [], endSnapshotId };
        }
        const diff = await runGit([
            '--git-dir', repository.gitDir,
            '-c', 'core.autocrlf=false',
            '-c', 'core.quotepath=false',
            'diff-tree', '-p', '--binary', '--no-color', '--find-renames',
            fromSnapshotId, toSnapshotId,
            '--', ...filteredFiles
        ], repository.workspacePath);
        return diff
            ? { source: 'task-diff', diff, files: filteredFiles, endSnapshotId }
            : { source: 'empty', diff: '', files: [], endSnapshotId };
    }

    protected async trackedRuntimeArtifactPaths(workspacePath: string): Promise<string[]> {
        try {
            const output = await runGit([
                '-c', 'core.quotepath=false', 'ls-files', '-z', '--cached', '--',
                ...NPM_RUNTIME_ARTIFACT_ROOTS
            ], workspacePath);
            return [...new Set(output.split('\0')
                .map(path => path.replace(/\\/g, '/').replace(/^\.\//, ''))
                .filter(path => path && this.isNpmRuntimeArtifact(path))
                .map(path => this.comparablePath(path)))]
                .sort();
        } catch {
            return [];
        }
    }

    protected async readSnapshotFile(
        repository: SnapshotRepository,
        snapshotId: string,
        path: string
    ): Promise<GitSnapshotFileContent> {
        const object = `${snapshotId}:${path}`;
        const exists = await runGit(['--git-dir', repository.gitDir, 'cat-file', '-e', object], repository.workspacePath)
            .then(() => true, () => false);
        if (!exists) {
            return { state: 'missing' };
        }
        const type = (await runGit([
            '--git-dir', repository.gitDir, 'cat-file', '-t', object
        ], repository.workspacePath)).trim();
        if (type !== 'blob') {
            throw new SnapshotFileError('保存された項目はテキストファイルではありません。');
        }
        const size = Number((await runGit([
            '--git-dir', repository.gitDir, 'cat-file', '-s', object
        ], repository.workspacePath)).trim());
        if (!Number.isSafeInteger(size) || size < 0 || size > this.snapshotFileMaxBytes) {
            throw new SnapshotFileError('ファイルが大きすぎるため、変更を表示できません。');
        }
        const buffer = await runGitBuffer([
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

    protected async findRepository(snapshotIds: string[], expectedWorkspacePath?: string): Promise<SnapshotRepository | undefined> {
        if (snapshotIds.some(snapshotId => !/^[0-9a-f]{40}$/i.test(snapshotId))) {
            return undefined;
        }
        let entries;
        try {
            entries = await readdir(this.rootPath, { withFileTypes: true });
        } catch {
            return undefined;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.endsWith('.git')) {
                continue;
            }
            const gitDir = join(this.rootPath, entry.name);
            const containsAll = await Promise.all(snapshotIds.map(snapshotId =>
                runGit(['--git-dir', gitDir, 'cat-file', '-e', `${snapshotId}^{tree}`], this.rootPath)
                    .then(() => true, () => false)
            ));
            if (!containsAll.every(Boolean)) {
                continue;
            }
            try {
                const storedWorkspacePath = (await runGit([
                    '--git-dir', gitDir, 'config', '--get', 'poiesis.workspacePath'
                ], this.rootPath)).trim();
                if (storedWorkspacePath) {
                    const resolvedWorkspace = resolve(storedWorkspacePath);
                    if (expectedWorkspacePath && this.normalizeWorkspacePath(resolvedWorkspace)
                        !== this.normalizeWorkspacePath(expectedWorkspacePath)) {
                        continue;
                    }
                    return { gitDir, workspacePath: resolvedWorkspace };
                }
            } catch {
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

    protected missing(): GitChangeSetCapture {
        return { source: 'empty', diff: '', files: [], error: SNAPSHOT_MISSING_ERROR };
    }

    protected errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}

class SnapshotFileError extends Error { }

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

function runGit(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = process.env
): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        execFile('git', args, {
            cwd,
            env,
            windowsHide: true,
            encoding: 'utf8',
            maxBuffer: GIT_OUTPUT_MAX_BYTES
        }, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                resolvePromise(stdout);
            }
        });
    });
}

function runGitBuffer(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = process.env
): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
        execFile('git', args, {
            cwd,
            env,
            windowsHide: true,
            encoding: 'buffer',
            maxBuffer: GIT_OUTPUT_MAX_BYTES
        }, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
            }
        });
    });
}
