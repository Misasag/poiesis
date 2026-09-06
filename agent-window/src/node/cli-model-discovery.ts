import { ChildProcess } from 'node:child_process';
import {
    CLI_EFFORT_LEVELS,
    CliModelCatalog,
    CliModelOption,
    KnownCliId
} from '../common/agent-runtime-protocol';
import { HiddenCliProcess, killHiddenProcessTree, spawnHiddenCli } from './hidden-process';
import { grokExecutionEnvironment } from './known-cli-registry';

const DEFAULT_CODEX_TIMEOUT_MS = 10_000;
const DEFAULT_GROK_TIMEOUT_MS = 15_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MAX_LINE_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 4 * 1_048_576;
const MAX_GROK_OUTPUT_BYTES = 256 * 1_024;
const MAX_PAGES = 20;
const MAX_MODELS = 1_000;
const MAX_CURSOR_LENGTH = 512;
const MAX_CACHE_ENTRIES = 16;

interface JsonRpcResponse {
    id?: unknown;
    result?: unknown;
    error?: { code?: unknown };
}

interface ModelListPage {
    data: unknown[];
    nextCursor?: string;
}

interface PendingResponse {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

type ProcessCleanup = (child: ChildProcess) => Promise<void>;

export interface ModelListProcessOptions {
    timeoutMs?: number;
    cleanupTimeoutMs?: number;
    cleanup?: ProcessCleanup;
}

export interface CodexModelListClientOptions extends ModelListProcessOptions {
    spawn?: (command: string) => HiddenCliProcess;
}

export interface GrokModelListClientOptions extends ModelListProcessOptions {
    spawn?: (command: string) => HiddenCliProcess;
}

/** Keeps even a faulty cleanup implementation from holding discovery in-flight forever. */
export async function boundedProcessCleanup(
    child: ChildProcess,
    cleanup: ProcessCleanup = killHiddenProcessTree,
    timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS
): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    const boundedMs = Math.max(50, Math.min(timeoutMs, 5_000));
    try {
        const outcome = await Promise.race([
            Promise.resolve().then(() => cleanup(child)).then(() => 'cleaned' as const, () => 'failed' as const),
            new Promise<'timed-out'>(resolvePromise => {
                timeout = setTimeout(() => resolvePromise('timed-out'), boundedMs);
            })
        ]);
        if (outcome === 'cleaned') {
            return;
        }
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
    try {
        child.kill();
    } catch {
        // The process may already have exited or may be an incomplete test double.
    }
}

/** Bounded newline-JSON client for Codex app-server model/list. It never starts a thread or turn. */
export class CodexModelListClient {
    protected readonly timeoutMs: number;
    protected readonly cleanupTimeoutMs: number;
    protected readonly spawnProcess: (command: string) => HiddenCliProcess;
    protected readonly cleanupProcess: ProcessCleanup;

    constructor(options: CodexModelListClientOptions = {}) {
        this.timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS, 30_000));
        this.cleanupTimeoutMs = Math.max(50, Math.min(options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS, 5_000));
        this.cleanupProcess = options.cleanup ?? killHiddenProcessTree;
        this.spawnProcess = options.spawn ?? (command => spawnHiddenCli('codex', command, ['app-server'], {
            keepStdinOpen: true
        }));
    }

    async listModels(command: string): Promise<CliModelOption[]> {
        const child = this.spawnProcess(command);
        const pending = new Map<number, PendingResponse>();
        let lineBuffer = Buffer.alloc(0);
        let outputBytes = 0;
        let terminalError: Error | undefined;
        let cleanupPromise: Promise<void> | undefined;
        const cleanupOnce = (): Promise<void> => cleanupPromise ??= boundedProcessCleanup(
            child, this.cleanupProcess, this.cleanupTimeoutMs
        );

        const fail = (error: Error): void => {
            if (terminalError) {
                return;
            }
            terminalError = error;
            for (const response of pending.values()) {
                response.reject(error);
            }
            pending.clear();
        };

        const acceptLine = (line: Buffer): void => {
            if (!line.length || terminalError) {
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(line.toString('utf8')) as unknown;
            } catch {
                fail(new Error('Codex app-server returned malformed JSON.'));
                return;
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                fail(new Error('Codex app-server returned an invalid response envelope.'));
                return;
            }
            const message = parsed as JsonRpcResponse;
            if (!Number.isSafeInteger(message.id)) {
                return;
            }
            const response = pending.get(message.id as number);
            if (!response) {
                return;
            }
            pending.delete(message.id as number);
            if (message.error) {
                const code = typeof message.error.code === 'number' || typeof message.error.code === 'string'
                    ? ` (${message.error.code})`
                    : '';
                response.reject(new Error(`Codex app-server returned a protocol error${code}.`));
                return;
            }
            if (!Object.prototype.hasOwnProperty.call(message, 'result')) {
                response.reject(new Error('Codex app-server response did not contain a result.'));
                return;
            }
            response.resolve(message.result);
        };

        child.stdout.on('data', (chunk: Buffer | string) => {
            if (terminalError) {
                return;
            }
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            outputBytes += bytes.length;
            if (outputBytes > MAX_OUTPUT_BYTES) {
                fail(new Error('Codex app-server output exceeded the safe limit.'));
                return;
            }
            lineBuffer = Buffer.concat([lineBuffer, bytes]);
            if (lineBuffer.length > MAX_LINE_BYTES && !lineBuffer.includes(0x0a)) {
                fail(new Error('Codex app-server response line exceeded the safe limit.'));
                return;
            }
            let newline = lineBuffer.indexOf(0x0a);
            while (newline >= 0) {
                const lineEnd = newline > 0 && lineBuffer[newline - 1] === 0x0d ? newline - 1 : newline;
                const line = lineBuffer.subarray(0, lineEnd);
                lineBuffer = lineBuffer.subarray(newline + 1);
                if (line.length > MAX_LINE_BYTES) {
                    fail(new Error('Codex app-server response line exceeded the safe limit.'));
                    return;
                }
                acceptLine(line);
                newline = lineBuffer.indexOf(0x0a);
            }
        });
        child.stdout.once('error', () => fail(new Error('Codex app-server output stream failed.')));
        child.stderr.on('data', () => {
            // Stderr may contain local diagnostics. Do not retain or transport it.
        });
        child.stderr.once('error', () => fail(new Error('Codex app-server diagnostic stream failed.')));
        child.stdin?.once('error', () => fail(new Error('Codex app-server request could not be written.')));
        child.once('error', () => fail(new Error('Codex app-server could not be started.')));
        child.once('close', () => fail(new Error('Codex app-server closed before model discovery completed.')));

        const send = (message: object): void => {
            if (terminalError) {
                throw terminalError;
            }
            if (!child.stdin?.writable) {
                throw new Error('Codex app-server input is unavailable.');
            }
            child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', error => {
                if (error) {
                    fail(new Error('Codex app-server request could not be written.'));
                }
            });
        };
        const request = (id: number, method: string, params: object): Promise<unknown> => {
            if (terminalError) {
                return Promise.reject(terminalError);
            }
            const response = new Promise<unknown>((resolvePromise, rejectPromise) => {
                pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
            });
            try {
                send({ jsonrpc: '2.0', id, method, params });
            } catch (error) {
                pending.delete(id);
                return Promise.reject(error);
            }
            return response;
        };

        const timeout = setTimeout(() => {
            fail(new Error('Codex model discovery timed out.'));
            void cleanupOnce();
        }, this.timeoutMs);
        try {
            await request(0, 'initialize', {
                clientInfo: { name: 'poiesis', title: 'Poiesis', version: '0.0.0' }
            });
            send({ jsonrpc: '2.0', method: 'initialized', params: {} });

            const models: CliModelOption[] = [];
            const modelIds = new Set<string>();
            const cursors = new Set<string>();
            let cursor: string | undefined;
            for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
                const rawPage = await request(pageIndex + 1, 'model/list', {
                    limit: 100,
                    includeHidden: false,
                    ...(cursor ? { cursor } : {})
                });
                const page = this.parsePage(rawPage);
                if (models.length + page.data.length > MAX_MODELS) {
                    throw new Error('Codex model catalog exceeded the safe model limit.');
                }
                for (const rawModel of page.data) {
                    const model = this.parseModel(rawModel);
                    if (model && !modelIds.has(model.id)) {
                        modelIds.add(model.id);
                        models.push(model);
                    }
                }
                cursor = page.nextCursor;
                if (!cursor) {
                    child.stdin?.end();
                    return models;
                }
                if (cursors.has(cursor)) {
                    throw new Error('Codex model catalog repeated a pagination cursor.');
                }
                cursors.add(cursor);
            }
            throw new Error('Codex model catalog exceeded the safe page limit.');
        } finally {
            clearTimeout(timeout);
            for (const response of pending.values()) {
                response.reject(new Error('Codex model discovery ended before a response arrived.'));
            }
            pending.clear();
            await cleanupOnce();
        }
    }

    protected parsePage(value: unknown): ModelListPage {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Codex model/list returned an invalid result.');
        }
        const record = value as { data?: unknown; nextCursor?: unknown };
        if (!Array.isArray(record.data)) {
            throw new Error('Codex model/list result did not contain a model array.');
        }
        if (record.nextCursor !== undefined && record.nextCursor !== null
            && (typeof record.nextCursor !== 'string' || !record.nextCursor || record.nextCursor.length > MAX_CURSOR_LENGTH)) {
            throw new Error('Codex model/list returned an invalid pagination cursor.');
        }
        return {
            data: record.data,
            nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : undefined
        };
    }

    protected parseModel(value: unknown): CliModelOption | undefined {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Codex model/list contained an invalid model entry.');
        }
        const record = value as Record<string, unknown>;
        if (record.hidden === true) {
            return undefined;
        }
        const id = typeof record.model === 'string' ? record.model.trim() : '';
        if (!id || id.length > 160) {
            throw new Error('Codex model/list contained an invalid model id.');
        }
        const label = typeof record.displayName === 'string' && record.displayName.trim()
            ? record.displayName.trim().slice(0, 200)
            : id;
        const supportedReasoningEfforts = Array.isArray(record.supportedReasoningEfforts)
            ? [...new Set(record.supportedReasoningEfforts.flatMap(item => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                    return [];
                }
                const effort = (item as Record<string, unknown>).reasoningEffort;
                return typeof effort === 'string' && CLI_EFFORT_LEVELS.codex.includes(effort) ? [effort] : [];
            }))]
            : [];
        const defaultReasoningEffort = typeof record.defaultReasoningEffort === 'string'
            && supportedReasoningEfforts.includes(record.defaultReasoningEffort)
            ? record.defaultReasoningEffort
            : undefined;
        const inputModalities = Array.isArray(record.inputModalities)
            ? [...new Set(record.inputModalities.filter((item): item is string => typeof item === 'string' && item.length <= 40))]
            : [];
        return {
            id,
            label,
            ...(typeof record.description === 'string' && record.description.trim()
                ? { description: record.description.trim().slice(0, 400) }
                : {}),
            ...(record.isDefault === true ? { isCatalogDefault: true } : {}),
            ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
            ...(supportedReasoningEfforts.length ? { supportedReasoningEfforts } : {}),
            ...(inputModalities.length ? { inputModalities } : {})
        };
    }
}

/** Parses only the documented model rows inside Grok CLI's Available models section. */
export function parseGrokModelsOutput(output: string): CliModelOption[] {
    const models: CliModelOption[] = [];
    const ids = new Set<string>();
    let inAvailableModels = false;
    for (const line of output.split(/\r?\n/)) {
        if (!inAvailableModels) {
            if (line.trim() === 'Available models:') {
                inAvailableModels = true;
            }
            continue;
        }
        if (/^Default model:\s*/.test(line.trim())) {
            break;
        }
        const match = /^  ([*-]) ([A-Za-z0-9][A-Za-z0-9._:/-]{0,159})(?: \(default\))?$/.exec(line);
        if (!match) {
            continue;
        }
        const isDefault = match[1] === '*';
        if ((isDefault && !line.endsWith(' (default)')) || (!isDefault && line.endsWith(' (default)'))) {
            continue;
        }
        const id = match[2];
        if (!ids.has(id)) {
            ids.add(id);
            models.push({ id, label: id, ...(isDefault ? { isCatalogDefault: true } : {}) });
        }
    }
    if (!inAvailableModels || !models.length) {
        throw new Error('Grok CLI returned an invalid model list.');
    }
    return models;
}

/** Bounded text client for the read-only `grok models` command. */
export class GrokModelListClient {
    protected readonly timeoutMs: number;
    protected readonly cleanupTimeoutMs: number;
    protected readonly spawnProcess: (command: string) => HiddenCliProcess;
    protected readonly cleanupProcess: ProcessCleanup;

    constructor(options: GrokModelListClientOptions = {}) {
        this.timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? DEFAULT_GROK_TIMEOUT_MS, 30_000));
        this.cleanupTimeoutMs = Math.max(50, Math.min(options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS, 5_000));
        this.cleanupProcess = options.cleanup ?? killHiddenProcessTree;
        this.spawnProcess = options.spawn ?? (command => spawnHiddenCli('grok', command, ['models'], {
            env: { ...grokExecutionEnvironment(), NO_COLOR: '1' }
        }));
    }

    async listModels(command: string): Promise<CliModelOption[]> {
        const child = this.spawnProcess(command);
        let cleanupPromise: Promise<void> | undefined;
        const cleanupOnce = (): Promise<void> => cleanupPromise ??= boundedProcessCleanup(
            child, this.cleanupProcess, this.cleanupTimeoutMs
        );
        try {
            return await new Promise<CliModelOption[]>((resolvePromise, rejectPromise) => {
                const chunks: Buffer[] = [];
                let outputBytes = 0;
                let settled = false;
                let timeout: NodeJS.Timeout | undefined;
                const finish = (error?: Error, models?: CliModelOption[]): void => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    if (timeout) {
                        clearTimeout(timeout);
                    }
                    if (error) {
                        rejectPromise(error);
                        void cleanupOnce();
                    } else {
                        resolvePromise(models ?? []);
                    }
                };
                timeout = setTimeout(() => finish(new Error('Grok model discovery timed out.')), this.timeoutMs);
                child.stdout.on('data', (chunk: Buffer | string) => {
                    if (settled) {
                        return;
                    }
                    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    outputBytes += bytes.length;
                    if (outputBytes > MAX_GROK_OUTPUT_BYTES) {
                        finish(new Error('Grok model list output exceeded the safe limit.'));
                        return;
                    }
                    chunks.push(bytes);
                });
                child.stdout.once('error', () => finish(new Error('Grok model list output stream failed.')));
                child.stderr.on('data', () => {
                    // Startup and account diagnostics are deliberately ignored.
                });
                child.stderr.once('error', () => finish(new Error('Grok model list diagnostic stream failed.')));
                child.once('error', () => finish(new Error('Grok CLI could not be started.')));
                child.once('close', code => {
                    if (settled) {
                        return;
                    }
                    if (code !== 0) {
                        finish(new Error('Grok model list command failed.'));
                        return;
                    }
                    try {
                        finish(undefined, parseGrokModelsOutput(Buffer.concat(chunks).toString('utf8')));
                    } catch (error) {
                        finish(error instanceof Error ? error : new Error('Grok CLI returned an invalid model list.'));
                    }
                });
            });
        } finally {
            await cleanupOnce();
        }
    }
}

interface CachedCatalog {
    fetchedAt: string;
    expiresAt: number;
    models: CliModelOption[];
}

export interface CliModelDiscoveryInput {
    providerId: KnownCliId;
    command?: string;
    version?: string;
    fallbackModels: readonly CliModelOption[];
    refresh?: boolean;
}

export interface CliModelEffortSelection {
    providerId: KnownCliId;
    command?: string;
    version?: string;
    model?: string;
    effort?: string;
}

export class UnsupportedModelEffortError extends Error {
    readonly code = 'unsupported-model-effort';

    constructor(readonly model: string, readonly effort: string, readonly supportedEfforts: readonly string[]) {
        super(`選択したモデル「${model}」では、この処理の深さを利用できません。`
            + 'モデル選択から「処理の深さ」を「既定」または対応する値に変更してください。');
        this.name = 'UnsupportedModelEffortError';
    }
}

export function unsupportedModelEffortMessage(error: unknown): string | undefined {
    return error instanceof UnsupportedModelEffortError ? error.message : undefined;
}

export function modelDiscoveryIdentity(providerId: KnownCliId, command?: string, version?: string): string {
    const trimmedCommand = command?.trim() ?? '';
    const commandIdentity = process.platform === 'win32'
        ? trimmedCommand.replaceAll('/', '\\').toLocaleLowerCase()
        : trimmedCommand;
    return `${providerId}\u0000${commandIdentity}\u0000${version?.trim() ?? ''}`;
}

/** Command-scoped discovery with TTL caching, in-flight de-duplication, and last-good retention. */
export class CliModelDiscoveryService {
    protected readonly cache = new Map<string, CachedCatalog>();
    protected readonly inFlight = new Map<string, Promise<CliModelCatalog>>();

    constructor(
        protected readonly codexClient: Pick<CodexModelListClient, 'listModels'> = new CodexModelListClient(),
        protected readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
        protected readonly grokClient: Pick<GrokModelListClient, 'listModels'> = new GrokModelListClient()
    ) { }

    discover(input: CliModelDiscoveryInput): Promise<CliModelCatalog> {
        const identity = modelDiscoveryIdentity(input.providerId, input.command, input.version);
        const cached = this.cache.get(identity);
        if (!input.refresh && cached && cached.expiresAt > Date.now()) {
            return Promise.resolve({
                providerId: input.providerId,
                source: 'cached',
                models: this.cloneModels(cached.models),
                fetchedAt: cached.fetchedAt
            });
        }
        const running = this.inFlight.get(identity);
        if (running) {
            return running;
        }
        const discovery = this.performDiscovery(input, identity).finally(() => this.inFlight.delete(identity));
        this.inFlight.set(identity, discovery);
        return discovery;
    }

    /** Uses only already-fetched metadata. It never starts discovery during an AI send. */
    assertEffortSupported(selection: CliModelEffortSelection): void {
        const model = selection.model?.trim();
        const effort = selection.effort?.trim();
        if (!model || !effort) {
            return;
        }
        const identity = modelDiscoveryIdentity(selection.providerId, selection.command, selection.version);
        const metadata = this.cache.get(identity)?.models.find(candidate => candidate.id === model);
        if (metadata?.supportedReasoningEfforts
            && !metadata.supportedReasoningEfforts.includes(effort)) {
            throw new UnsupportedModelEffortError(metadata.label || model, effort, metadata.supportedReasoningEfforts);
        }
    }

    protected async performDiscovery(input: CliModelDiscoveryInput, identity: string): Promise<CliModelCatalog> {
        if (!input.command || (input.providerId !== 'codex' && input.providerId !== 'grok')) {
            return this.fallback(input.providerId, input.fallbackModels);
        }
        try {
            const discovered = input.providerId === 'codex'
                ? await this.codexClient.listModels(input.command)
                : await this.grokClient.listModels(input.command);
            if (!discovered.length) {
                throw new Error('The live catalog was empty.');
            }
            const fetchedAt = new Date().toISOString();
            const models = this.withCliDefault(discovered);
            this.storeCache(identity, {
                fetchedAt,
                expiresAt: Date.now() + Math.max(1_000, this.cacheTtlMs),
                models: this.cloneModels(models)
            });
            return { providerId: input.providerId, source: 'live', models, fetchedAt };
        } catch {
            const cached = this.cache.get(identity);
            if (cached) {
                return {
                    providerId: input.providerId,
                    source: 'cached',
                    models: this.cloneModels(cached.models),
                    fetchedAt: cached.fetchedAt,
                    error: 'モデル一覧を更新できなかったため、前回取得した一覧を表示しています。'
                };
            }
            return this.fallback(input.providerId, input.fallbackModels,
                'モデル一覧を取得できなかったため、同梱の一覧を表示しています。');
        }
    }

    protected fallback(
        providerId: KnownCliId,
        fallbackModels: readonly CliModelOption[],
        error?: string
    ): CliModelCatalog {
        const models = this.cloneModels(fallbackModels);
        return models.length
            ? { providerId, source: 'fallback', models, ...(error ? { error } : {}) }
            : { providerId, source: 'failed', models: [], error: error ?? 'モデル一覧を取得できませんでした。' };
    }

    protected storeCache(identity: string, catalog: CachedCatalog): void {
        this.cache.delete(identity);
        this.cache.set(identity, catalog);
        while (this.cache.size > MAX_CACHE_ENTRIES) {
            const oldestIdentity = this.cache.keys().next().value as string | undefined;
            if (!oldestIdentity) {
                break;
            }
            this.cache.delete(oldestIdentity);
        }
    }

    protected withCliDefault(models: readonly CliModelOption[]): CliModelOption[] {
        return [
            { id: '', label: '既定' },
            ...this.cloneModels(models.filter(model => model.id))
        ];
    }

    protected cloneModels(models: readonly CliModelOption[]): CliModelOption[] {
        return models.map(model => ({
            ...model,
            supportedReasoningEfforts: model.supportedReasoningEfforts
                ? [...model.supportedReasoningEfforts]
                : undefined,
            inputModalities: model.inputModalities ? [...model.inputModalities] : undefined
        }));
    }
}

/** Test helper type: callers can provide a fake process without invoking a real CLI. */
export type ModelDiscoveryChildProcess = ChildProcess;
