import { injectable, postConstruct } from '@theia/core/shared/inversify';

export const GlobalStorageService = Symbol('GlobalStorageService');

export interface GlobalStorageService {
    getData<T>(key: string): Promise<T | undefined>;
    setData<T>(key: string, data: T | undefined): Promise<void>;
    getWorkspaceData<T>(key: string): Promise<T[]>;
}

/** Origin-global persistence, intentionally independent from Theia's workspace URL prefix. */
@injectable()
export class BrowserGlobalStorageService implements GlobalStorageService {
    protected storage?: Storage;
    protected readonly fallback = new Map<string, string>();

    @postConstruct()
    protected init(): void {
        if (typeof window !== 'undefined') {
            this.storage = window.localStorage;
        }
    }

    async getData<T>(key: string): Promise<T | undefined> {
        const raw = this.storage?.getItem(this.key(key)) ?? this.fallback.get(this.key(key));
        return raw === undefined || raw === null ? undefined : JSON.parse(raw) as T;
    }

    async setData<T>(key: string, data: T | undefined): Promise<void> {
        const storageKey = this.key(key);
        if (data === undefined) {
            this.storage?.removeItem(storageKey);
            this.fallback.delete(storageKey);
            return;
        }
        const raw = JSON.stringify(data);
        if (this.storage) {
            this.storage.setItem(storageKey, raw);
        } else {
            this.fallback.set(storageKey, raw);
        }
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
}
