import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
    GitChangeSetBetweenRequest,
    GitChangeSetCapture,
    GitSnapshotCapture
} from '../common/agent-runtime-protocol';

const SNAPSHOT_MISSING_ERROR = 'スナップショットが見つかりません。';
const GIT_OUTPUT_MAX_BYTES = 100 * 1024 * 1024;

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

    constructor(readonly rootPath = defaultSnapshotStoreRoot()) { }

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
        const env = {
            ...process.env,
            GIT_DIR: repository.gitDir,
            GIT_WORK_TREE: repository.workspacePath,
            GIT_INDEX_FILE: indexFile
        };
        try {
            await runGit(['-c', 'core.autocrlf=false', 'read-tree', '--empty'], repository.workspacePath, env);
            await runGit([
                '-c', 'core.autocrlf=false', 'add', '-A', '--ignore-errors', '--', '.'
            ], repository.workspacePath, env);
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
        if (files.length === 0) {
            return { source: 'empty', diff: '', files: [], endSnapshotId };
        }
        const diff = await runGit([
            '--git-dir', repository.gitDir,
            '-c', 'core.autocrlf=false',
            '-c', 'core.quotepath=false',
            'diff-tree', '-p', '--binary', '--no-color', '--find-renames',
            fromSnapshotId, toSnapshotId,
            ...pathArgs
        ], repository.workspacePath);
        return diff
            ? { source: 'task-diff', diff, files, endSnapshotId }
            : { source: 'empty', diff: '', files: [], endSnapshotId };
    }

    protected async findRepository(snapshotIds: string[]): Promise<SnapshotRepository | undefined> {
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
                const workspacePath = (await runGit([
                    '--git-dir', gitDir, 'config', '--get', 'poiesis.workspacePath'
                ], this.rootPath)).trim();
                if (workspacePath) {
                    return { gitDir, workspacePath: resolve(workspacePath) };
                }
            } catch {
                // Ignore malformed or unrelated bare repositories in the store root.
            }
        }
        return undefined;
    }

    protected normalizePaths(paths: string[]): string[] {
        return [...new Set(paths.map(candidate => candidate.replace(/\\/g, '/').replace(/^\.\//, '')))]
            .filter(candidate => {
                if (!candidate || candidate.includes('\0') || isAbsolute(candidate)) {
                    return false;
                }
                const resolved = resolve('/', ...candidate.split('/'));
                const withinRoot = relative('/', resolved);
                return withinRoot !== '..' && !withinRoot.startsWith(`..${sep}`);
            })
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
