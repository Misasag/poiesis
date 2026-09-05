import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { DurableStorageServer } from '../common/durable-storage-protocol';

const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 120_000;

interface DurableFilePaths {
    target: string;
    backup: string;
    lock: string;
    temporary: string;
}

export interface DurableFileStoreHooks {
    /** Test seam immediately before the new temporary file is installed. */
    beforeInstall?(key: string): Promise<void> | void;
    /** Test seam immediately before a saved backup is restored. */
    beforeRestore?(key: string): Promise<void> | void;
}

/**
 * The production file boundary for Poiesis state.
 *
 * A per-key filesystem lock coordinates every backend client. The previous
 * target is renamed to a backup before installation, and readers recover that
 * backup after an interrupted or failed replacement.
 */
export class DurableFileStore {
    protected readonly queues = new Map<string, Promise<unknown>>();

    constructor(
        protected readonly rootDirectory: string,
        protected readonly hooks: DurableFileStoreHooks = {}
    ) { }

    read(key: string): Promise<string | undefined> {
        return this.enqueue(key, async () => this.withLock(key, async paths => {
            if (await this.exists(paths.backup)) {
                const saved = await readFile(paths.backup, 'utf8');
                try {
                    if (await this.exists(paths.target)) {
                        await rm(paths.target, { force: true });
                    }
                    await rename(paths.backup, paths.target);
                } catch {
                    // The backup remains the authoritative saved value and is returned below.
                }
                return saved;
            }
            return await this.exists(paths.target) ? readFile(paths.target, 'utf8') : undefined;
        }));
    }

    write(key: string, contents: string): Promise<void> {
        return this.enqueue(key, async () => this.withLock(key, async paths => {
            await this.recoverInterruptedReplacement(paths);
            await this.writeTemporary(paths.temporary, contents);
            let previousMovedToBackup = false;
            try {
                if (await this.exists(paths.target)) {
                    await rm(paths.backup, { force: true });
                    await rename(paths.target, paths.backup);
                    previousMovedToBackup = true;
                }
                await this.hooks.beforeInstall?.(key);
                await rename(paths.temporary, paths.target);
                const persisted = await readFile(paths.target, 'utf8');
                if (persisted !== contents) {
                    throw new Error('Durable state verification failed.');
                }
                await rm(paths.backup, { force: true });
            } catch (error) {
                if (previousMovedToBackup) {
                    try {
                        await this.restoreBackup(key, paths);
                    } catch {
                        // A reload can still read and restore the preserved backup.
                    }
                }
                throw error;
            } finally {
                await rm(paths.temporary, { force: true }).catch(() => undefined);
            }
        }));
    }

    protected enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
        this.validateKey(key);
        const previous = this.queues.get(key) ?? Promise.resolve();
        const queued = previous.catch(() => undefined).then(operation);
        this.queues.set(key, queued);
        void queued.finally(() => {
            if (this.queues.get(key) === queued) {
                this.queues.delete(key);
            }
        }).catch(() => undefined);
        return queued;
    }

    protected async withLock<T>(key: string, operation: (paths: DurableFilePaths) => Promise<T>): Promise<T> {
        await mkdir(this.rootDirectory, { recursive: true });
        const paths = this.paths(key);
        const release = await this.acquireLock(paths.lock);
        try {
            return await operation(paths);
        } finally {
            await release();
        }
    }

    protected async acquireLock(lockPath: string): Promise<() => Promise<void>> {
        const token = randomUUID();
        const deadline = Date.now() + LOCK_WAIT_MS;
        while (true) {
            if (await this.tryCreateLock(lockPath, token)) {
                return async () => {
                    try {
                        const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: string };
                        if (lock.token === token) {
                            await rm(lockPath, { force: true });
                        }
                    } catch {
                        // A missing or replaced lock is not owned by this operation.
                    }
                };
            }
            if (await this.removeAbandonedLock(lockPath)) {
                continue;
            }
            if (Date.now() >= deadline) {
                throw new Error('Timed out waiting to save durable state.');
            }
            await new Promise(resolveDelay => setTimeout(resolveDelay, LOCK_RETRY_MS));
        }
    }

    protected async tryCreateLock(lockPath: string, token: string): Promise<boolean> {
        let handle;
        try {
            handle = await open(lockPath, 'wx');
        } catch (error) {
            if (this.errorCode(error) === 'EEXIST') {
                return false;
            }
            throw error;
        }
        try {
            await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), 'utf8');
            await handle.sync();
            await handle.close();
            return true;
        } catch (error) {
            await handle.close().catch(() => undefined);
            await rm(lockPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    protected async removeAbandonedLock(lockPath: string): Promise<boolean> {
        try {
            const [metadata, details] = await Promise.all([
                readFile(lockPath, 'utf8')
                    .then(value => JSON.parse(value) as { pid?: number })
                    .catch((): { pid?: number } => ({})),
                stat(lockPath)
            ]);
            const tooOld = Date.now() - details.mtimeMs >= STALE_LOCK_MS;
            const ownerPid = Number.isInteger(metadata.pid) && metadata.pid! > 0 ? metadata.pid : undefined;
            const ownerGone = ownerPid !== undefined && !this.processIsAlive(ownerPid);
            if (!ownerGone && (ownerPid !== undefined || !tooOld)) {
                return false;
            }
            await rm(lockPath, { force: true });
            return true;
        } catch (error) {
            return this.errorCode(error) === 'ENOENT';
        }
    }

    protected processIsAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return this.errorCode(error) === 'EPERM';
        }
    }

    protected async recoverInterruptedReplacement(paths: DurableFilePaths): Promise<void> {
        if (!await this.exists(paths.backup)) {
            return;
        }
        if (await this.exists(paths.target)) {
            await rm(paths.target, { force: true });
        }
        await rename(paths.backup, paths.target);
    }

    protected async restoreBackup(key: string, paths: DurableFilePaths): Promise<void> {
        if (!await this.exists(paths.backup)) {
            return;
        }
        if (await this.exists(paths.target)) {
            await rm(paths.target, { force: true });
        }
        await this.hooks.beforeRestore?.(key);
        await rename(paths.backup, paths.target);
    }

    protected async writeTemporary(temporary: string, contents: string): Promise<void> {
        const handle = await open(temporary, 'wx');
        let failed = false;
        let writeError: unknown;
        try {
            await handle.writeFile(contents, 'utf8');
            await handle.sync();
        } catch (error) {
            failed = true;
            writeError = error;
        } finally {
            await handle.close();
        }
        if (failed) {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw writeError;
        }
    }

    protected paths(key: string): DurableFilePaths {
        const fileName = `${encodeURIComponent(key)}.json`;
        const target = resolve(this.rootDirectory, fileName);
        return {
            target,
            backup: `${target}.bak`,
            lock: `${target}.lock`,
            temporary: `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
        };
    }

    protected validateKey(key: string): void {
        if (!key || key.length > 160 || /[\u0000-\u001f]/.test(key)) {
            throw new Error('Invalid durable state key.');
        }
    }

    protected async exists(path: string): Promise<boolean> {
        try {
            await stat(path);
            return true;
        } catch (error) {
            if (this.errorCode(error) === 'ENOENT') {
                return false;
            }
            throw error;
        }
    }

    protected errorCode(error: unknown): string | undefined {
        return error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code)
            : undefined;
    }
}

@injectable()
export class DurableStorageServerImpl implements DurableStorageServer {
    protected storePromise?: Promise<DurableFileStore>;

    constructor(@inject(EnvVariablesServer) protected readonly envVariablesServer: EnvVariablesServer) { }

    async read(key: string): Promise<string | undefined> {
        return (await this.store()).read(key);
    }

    async write(key: string, contents: string): Promise<void> {
        await (await this.store()).write(key, contents);
    }

    protected store(): Promise<DurableFileStore> {
        if (!this.storePromise) {
            this.storePromise = this.envVariablesServer.getConfigDirUri().then(configDir =>
                new DurableFileStore(resolve(FileUri.fsPath(configDir), 'poiesis', 'state-v1'))
            );
        }
        return this.storePromise;
    }
}
