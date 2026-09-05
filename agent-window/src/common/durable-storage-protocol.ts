export const DurableStorageServer = Symbol('DurableStorageServer');
export const durableStorageServerPath = '/services/poiesis/durable-storage';

/** Profile-scoped persistence implemented by the application backend. */
export interface DurableStorageServer {
    read(key: string): Promise<string | undefined>;
    write(key: string, contents: string): Promise<void>;
}
