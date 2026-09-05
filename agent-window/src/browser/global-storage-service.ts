import { MessageService } from '@theia/core/lib/common';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { DurableDataStore, DurableKeyFileAdapter, LegacyKeyValueReader } from '../common/durable-data-store';
import { DurableStorageServer } from '../common/durable-storage-protocol';

export const GlobalStorageService = Symbol('GlobalStorageService');

export interface GlobalStorageService {
    getData<T>(key: string): Promise<T | undefined>;
    setData<T>(key: string, data: T | undefined): Promise<void>;
    getWorkspaceData<T>(key: string): Promise<T[]>;
}

/** Profile-scoped file persistence, intentionally independent from Theia's workspace URL prefix. */
@injectable()
export class BrowserGlobalStorageService implements GlobalStorageService {
    protected storage?: Storage;
    protected readonly fallback = new Map<string, string>();
    protected durableStore!: DurableDataStore;
    protected saveErrorVisible = false;

    constructor(
        @inject(DurableStorageServer) protected readonly durableStorageServer: DurableStorageServer,
        @inject(MessageService) protected readonly messageService: MessageService
    ) { }

    @postConstruct()
    protected init(): void {
        if (typeof window !== 'undefined') {
            this.storage = window.localStorage;
        }
        const files: DurableKeyFileAdapter = {
            read: key => this.durableStorageServer.read(key),
            write: (key, contents) => this.durableStorageServer.write(key, contents)
        };
        const legacy: LegacyKeyValueReader = {
            getData: key => this.getLegacyGlobalData(key)
        };
        this.durableStore = new DurableDataStore(files, legacy, () => this.showSaveError());
    }

    async getData<T>(key: string): Promise<T | undefined> {
        return this.durableStore.getData<T>(key);
    }

    async setData<T>(key: string, data: T | undefined): Promise<void> {
        await this.durableStore.setData(key, data);
        this.saveErrorVisible = false;
    }

    async getWorkspaceData<T>(key: string): Promise<T[]> {
        if (!this.storage) {
            return [];
        }
        const electronKey = `theia:${key}`;
        const browserSuffix = `:${key}`;
        const values: T[] = [];
        for (let index = 0; index < this.storage.length; index++) {
            const storageKey = this.storage.key(index);
            if (!storageKey || storageKey !== electronKey
                && !(storageKey.startsWith('theia:') && storageKey.endsWith(browserSuffix))) {
                continue;
            }
            const raw = this.storage.getItem(storageKey);
            if (!raw) {
                continue;
            }
            try {
                values.push(JSON.parse(raw) as T);
            } catch {
                // A malformed legacy value is left untouched and skipped.
            }
        }
        return values;
    }

    protected key(key: string): string {
        return `poiesis:global:${key}`;
    }

    protected async getLegacyGlobalData<T>(key: string): Promise<T | undefined> {
        const storageKey = this.key(key);
        const raw = this.storage?.getItem(storageKey) ?? this.fallback.get(storageKey);
        if (raw === undefined || raw === null) {
            return undefined;
        }
        return JSON.parse(raw) as T;
    }

    protected showSaveError(): void {
        if (this.saveErrorVisible) {
            return;
        }
        this.saveErrorVisible = true;
        void this.messageService.error('会話と成果を保存できませんでした。再試行してください。');
    }
}
