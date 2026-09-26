import type { GlobalStorageService } from './global-storage-service';
import type { TaskResultDocument } from './task-service';

export const MAX_RESULTS_DOCUMENT_BYTES = 8 * 1024 * 1024;
const DOCUMENT_KEY_PREFIX = 'poiesis.results-document-html.v1';
const MISSING_DOCUMENT_ERROR = '保存された成果を読み込めませんでした。作り直してください。';
const OVERSIZE_DOCUMENT_ERROR = '成果が 8 MiB を超えたため保存できませんでした。作り直してください。';

export type ResultsDocumentOwner = 'task' | 'requirement';

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

function failedDocument(document: TaskResultDocument, error: string): TaskResultDocument {
    const { html: _html, htmlStored: _stored, ...rest } = document;
    return { ...rest, status: 'failed', error, updateError: undefined };
}

/** Stores opaque HTML separately from frequently changing session and requirement metadata. */
export class ResultsDocumentStorage {
    private readonly written = new Map<string, string>();
    private readonly lastWritten = new Map<string, { html: string; marker: { version: 1; length: number; hash: string } }>();

    constructor(private readonly storage: GlobalStorageService) { }

    async persist(owner: ResultsDocumentOwner, id: string, document: TaskResultDocument): Promise<TaskResultDocument> {
        const { html, htmlStored: _stored, ...metadata } = document;
        if (html === undefined) {
            return metadata;
        }
        if (new TextEncoder().encode(html).byteLength > MAX_RESULTS_DOCUMENT_BYTES) {
            return failedDocument(document, OVERSIZE_DOCUMENT_ERROR);
        }
        const key = resultsDocumentHtmlKey(owner, id);
        // Sessions save often; an unchanged document is the same string, so skip hashing it again.
        const known = this.lastWritten.get(key);
        if (known && known.html === html && this.written.has(key)) {
            return { ...metadata, htmlStored: known.marker };
        }
        const fingerprint = hash(html);
        const signature = `${html.length}:${fingerprint}`;
        if (this.written.get(key) !== signature) {
            await this.storage.setData(key, html);
            this.written.set(key, signature);
        }
        const marker = { version: 1 as const, length: html.length, hash: fingerprint };
        this.lastWritten.set(key, { html, marker });
        return { ...metadata, htmlStored: marker };
    }

    async restore(owner: ResultsDocumentOwner, id: string, document: TaskResultDocument): Promise<TaskResultDocument> {
        const marker = document.htmlStored;
        if (!marker) {
            return document;
        }
        const key = resultsDocumentHtmlKey(owner, id);
        try {
            const html = await this.storage.getData<string>(key);
            if (typeof html === 'string' && marker.version === 1 && html.length === marker.length
                && hash(html) === marker.hash && new TextEncoder().encode(html).byteLength <= MAX_RESULTS_DOCUMENT_BYTES) {
                this.written.set(key, `${marker.length}:${marker.hash}`);
                this.lastWritten.set(key, { html, marker: { version: 1, length: marker.length, hash: marker.hash } });
                return { ...document, html };
            }
        } catch {
            // A missing or unreadable document is represented by the existing failure UI.
        }
        this.written.delete(key);
        this.lastWritten.delete(key);
        return failedDocument(document, MISSING_DOCUMENT_ERROR);
    }

    async remove(owner: ResultsDocumentOwner, id: string): Promise<void> {
        const key = resultsDocumentHtmlKey(owner, id);
        this.written.delete(key);
        this.lastWritten.delete(key);
        await this.storage.setData(key, undefined);
    }
}
