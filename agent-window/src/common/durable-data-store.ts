export interface DurableKeyFileAdapter {
    read(key: string): Promise<string | undefined>;
    write(key: string, contents: string, revision: number): Promise<void>;
}

export interface LegacyKeyValueReader {
    getData<T>(key: string): Promise<T | undefined>;
}

interface DurableEnvelope<T> {
    format: 1;
    key: string;
    present: boolean;
    value?: T;
}

export interface DurableDataStoreFailure {
    operation: 'read' | 'write' | 'migrate';
    key: string;
    error: unknown;
}

/**
 * File-backed key/value coordination shared by the browser adapter and its
 * boundary tests. Writes for each key are serialized and reads wait for the
 * newest queued write, so an older write can never replace newer state.
 */
export class DurableDataStore {
    protected readonly revisions = new Map<string, number>();
    protected readonly writes = new Map<string, Promise<void>>();

    constructor(
        protected readonly files: DurableKeyFileAdapter,
        protected readonly legacy?: LegacyKeyValueReader,
        protected readonly onFailure?: (failure: DurableDataStoreFailure) => void
    ) { }

    async getData<T>(key: string): Promise<T | undefined> {
        const pending = this.writes.get(key);
        if (pending) {
            try {
                await pending;
            } catch {
                // The write caller receives the rejection. Continue by reading the last good file.
            }
        }

        let durableMissing = false;
        try {
            const raw = await this.files.read(key);
            if (raw === undefined) {
                durableMissing = true;
            } else {
                const envelope = JSON.parse(raw) as Partial<DurableEnvelope<T>>;
                if (envelope.format !== 1 || envelope.key !== key || typeof envelope.present !== 'boolean') {
                    throw new Error('Invalid durable data envelope.');
                }
                return envelope.present ? envelope.value : undefined;
            }
        } catch (error) {
            this.onFailure?.({ operation: 'read', key, error });
        }

        const legacy = await this.readLegacy<T>(key);
        if (legacy === undefined || !durableMissing) {
            return legacy;
        }
        try {
            await this.setData(key, legacy);
        } catch (error) {
            this.onFailure?.({ operation: 'migrate', key, error });
        }
        return legacy;
    }

    setData<T>(key: string, value: T | undefined): Promise<void> {
        const revision = (this.revisions.get(key) ?? 0) + 1;
        this.revisions.set(key, revision);
        const contents = JSON.stringify({
            format: 1,
            key,
            present: value !== undefined,
            ...(value !== undefined ? { value } : {})
        } satisfies DurableEnvelope<T>);
        const previous = this.writes.get(key) ?? Promise.resolve();
        const write = previous.catch(() => undefined).then(() => this.files.write(key, contents, revision));
        this.writes.set(key, write);
        void write.catch(error => this.onFailure?.({ operation: 'write', key, error }));
        void write.finally(() => {
            if (this.writes.get(key) === write) {
                this.writes.delete(key);
            }
        }).catch(() => undefined);
        return write;
    }

    protected async readLegacy<T>(key: string): Promise<T | undefined> {
        if (!this.legacy) {
            return undefined;
        }
        try {
            return await this.legacy.getData<T>(key);
        } catch (error) {
            this.onFailure?.({ operation: 'read', key, error });
            return undefined;
        }
    }
}
