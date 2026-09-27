import type { GlobalStorageService } from './global-storage-service';
import type { TaskResultDocument } from './task-service';

export const MAX_RESULTS_DOCUMENT_BYTES = 8 * 1024 * 1024;
const DOCUMENT_KEY_PREFIX = 'poiesis.results-document-html.v1';
const MISSING_DOCUMENT_ERROR = '保存された成果を読み込めませんでした。作り直してください。';
const OVERSIZE_DOCUMENT_ERROR = '成果が 8 MiB を超えたため保存できませんでした。作り直してください。';

export type ResultsDocumentOwner = 'task' | 'requirement';
type StoredMarker = NonNullable<TaskResultDocument['htmlStored']>;

function hash(value: string): string {
    let first = 2166136261;
    let second = 2246822519;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 16777619);
        second = Math.imul(second ^ code, 3266489917);
    }
    return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

export function resultsDocumentHtmlKey(owner: ResultsDocumentOwner, id: string): string {
    const encoded = encodeURIComponent(id);
    const suffix = encoded.length <= 100 ? encoded : `${encoded.slice(0, 80)}.${hash(id)}`;
    return `${DOCUMENT_KEY_PREFIX}.${owner}.${suffix}`;
}

function failedDocument(document: TaskResultDocument, error: string, retainMarker = false): TaskResultDocument {
    const { html: _html, htmlStored, ...rest } = document;
    return { ...rest, htmlStored: retainMarker ? htmlStored : undefined, status: 'failed', error, updateError: undefined };
}

/** Stores opaque HTML separately from frequently changing session and requirement metadata. */
export class ResultsDocumentStorage {
    private readonly committed = new Map<string, StoredMarker>();
    private readonly lastWritten = new Map<string, { html: string; marker: StoredMarker }>();
    private sequence = 0;

    constructor(private readonly storage: GlobalStorageService) { }

    async persist(owner: ResultsDocumentOwner, id: string, document: TaskResultDocument): Promise<TaskResultDocument> {
        const { html, ...metadata } = document;
        if (html === undefined) {
            return metadata;
        }
        const key = resultsDocumentHtmlKey(owner, id);
        if (new TextEncoder().encode(html).byteLength > MAX_RESULTS_DOCUMENT_BYTES) {
            const previous = this.committed.get(key);
            if (previous) {
                const { html: _html, ...rest } = document;
                return { ...rest, htmlStored: previous, status: 'ready', error: undefined,
                    updateError: OVERSIZE_DOCUMENT_ERROR };
            }
            return failedDocument(document, OVERSIZE_DOCUMENT_ERROR);
        }
        // Sessions save often; an unchanged document is the same string, so skip hashing it again.
        const known = this.lastWritten.get(key);
        if (known && known.html === html) {
            return { ...metadata, htmlStored: known.marker };
        }
        const fingerprint = hash(html);
        // Write a new key before metadata changes. A crash here leaves the old key readable.
        // Keep the key short: the durable store turns each key into a file name.
        const nonce = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12)
            ?? `${Date.now().toString(36)}${(++this.sequence).toString(36)}`;
        const marker: StoredMarker = { version: 1, length: html.length, hash: fingerprint,
            key: `${key}.${nonce}` };
        await this.storage.setData(marker.key!, html);
        this.lastWritten.set(key, { html, marker });
        return { ...metadata, htmlStored: marker };
    }

    async restore(owner: ResultsDocumentOwner, id: string, document: TaskResultDocument): Promise<TaskResultDocument> {
        const marker = document.htmlStored;
        if (!marker) {
            return document;
        }
        const key = resultsDocumentHtmlKey(owner, id);
        this.committed.set(key, marker);
        try {
            const html = await this.storage.getData<string>(marker.key ?? key);
            if (typeof html === 'string' && marker.version === 1 && html.length === marker.length
                && hash(html) === marker.hash && new TextEncoder().encode(html).byteLength <= MAX_RESULTS_DOCUMENT_BYTES) {
                this.lastWritten.set(key, { html, marker });
                return document.status === 'failed' && document.error === MISSING_DOCUMENT_ERROR
                    ? { ...document, html, status: 'ready', error: undefined }
                    : { ...document, html };
            }
        } catch {
            // A missing or unreadable document is represented by the existing failure UI.
        }
        this.lastWritten.delete(key);
        return failedDocument(document, MISSING_DOCUMENT_ERROR, true);
    }

    /** Call only after the owning metadata has been saved successfully. */
    async commit(owner: ResultsDocumentOwner, id: string, marker: StoredMarker): Promise<void> {
        const key = resultsDocumentHtmlKey(owner, id);
        const previous = this.committed.get(key);
        if (previous && (previous.key ?? key) !== (marker.key ?? key)) {
            await this.storage.setData(previous.key ?? key, undefined);
        }
        this.committed.set(key, marker);
    }

    async remove(owner: ResultsDocumentOwner, id: string): Promise<void> {
        const key = resultsDocumentHtmlKey(owner, id);
        const marker = this.committed.get(key);
        await this.storage.setData(marker?.key ?? key, undefined);
        this.committed.delete(key);
        this.lastWritten.delete(key);
    }
}
