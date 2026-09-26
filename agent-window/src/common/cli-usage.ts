import type { KnownCliId } from './agent-runtime-protocol';

/** Input includes cache reads and cache creation. Missing values stay unknown. */
export interface CliUsage {
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    costUsd?: number;
    costSource?: 'cli-estimate';
    modelUsage?: Record<string, CliUsage>;
}

export interface CliCallRecord {
    purpose: 'agent' | 'results-generation' | 'results-judge' | 'requirement-classification' | 'requirement-title' | 'results-question';
    providerId: KnownCliId;
    model?: string;
    effort?: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    exitCode?: number;
    usage?: CliUsage;
    attempt?: number;
}

type JsonObject = Record<string, unknown>;
const counters = ['inputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'outputTokens', 'reasoningOutputTokens', 'costUsd'] as const;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function sumCliUsage(values: readonly (CliUsage | undefined)[]): CliUsage | undefined {
    const result: CliUsage = {};
    for (const value of values) {
        if (!value) { continue; }
        for (const key of counters) {
            const n = count(value[key]);
            if (n !== undefined) { result[key] = (result[key] ?? 0) + n; }
        }
        for (const [model, usage] of Object.entries(value.modelUsage ?? {})) {
            result.modelUsage ??= {};
            result.modelUsage[model] = sumCliUsage([result.modelUsage[model], usage])!;
        }
    }
    if (result.costUsd !== undefined) { result.costSource = 'cli-estimate'; }
    return Object.keys(result).length ? result : undefined;
}

function definedUsage(value: CliUsage): CliUsage | undefined {
    return Object.values(value).some(item => item !== undefined) ? value : undefined;
}

export function codexTurnUsage(event: JsonObject): CliUsage | undefined {
    if (event.type !== 'turn.completed') { return undefined; }
    const usage = object(event.usage);
    return definedUsage({
        inputTokens: count(usage.input_tokens),
        cachedInputTokens: count(usage.cached_input_tokens),
        outputTokens: count(usage.output_tokens),
        reasoningOutputTokens: count(usage.reasoning_output_tokens) ?? count(object(usage.output_tokens_details).reasoning_tokens)
    });
}

export function claudeResultUsage(event: JsonObject): CliUsage | undefined {
    if (event.type !== 'result') { return undefined; }
    const usage = object(event.usage);
    const input = count(usage.input_tokens);
    const cached = count(usage.cache_read_input_tokens);
    const created = count(usage.cache_creation_input_tokens);
    const cost = count(event.total_cost_usd);
    const models: Record<string, CliUsage> = {};
    for (const [model, raw] of Object.entries(object(event.modelUsage))) {
        const value = object(raw);
        const parts = [count(value.inputTokens), count(value.cacheReadInputTokens), count(value.cacheCreationInputTokens)];
        const modelCost = count(value.costUSD);
        const parsed = definedUsage({
            inputTokens: parts.some(n => n !== undefined) ? parts.reduce<number>((total, n) => total + (n ?? 0), 0) : undefined,
            cachedInputTokens: count(value.cacheReadInputTokens),
            cacheCreationInputTokens: count(value.cacheCreationInputTokens),
            outputTokens: count(value.outputTokens),
            reasoningOutputTokens: count(value.thinkingTokens),
            costUsd: modelCost,
            costSource: modelCost === undefined ? undefined : 'cli-estimate'
        });
        if (parsed) { models[model] = parsed; }
    }
    return definedUsage({
        inputTokens: [input, cached, created].some(n => n !== undefined) ? (input ?? 0) + (cached ?? 0) + (created ?? 0) : undefined,
        cachedInputTokens: cached,
        cacheCreationInputTokens: created,
        outputTokens: count(usage.output_tokens),
        reasoningOutputTokens: count(object(usage.output_tokens_details).thinking_tokens),
        costUsd: cost,
        costSource: cost === undefined ? undefined : 'cli-estimate',
        modelUsage: Object.keys(models).length ? models : undefined
    });
}

export function piMessageUsage(event: JsonObject): CliUsage | undefined {
    if (event.type !== 'message_end' || object(event.message).role !== 'assistant') { return undefined; }
    const usage = object(object(event.message).usage);
    const cost = count(object(usage.cost).total);
    return definedUsage({
        inputTokens: count(usage.input), cachedInputTokens: count(usage.cacheRead),
        cacheCreationInputTokens: count(usage.cacheWrite), outputTokens: count(usage.output),
        costUsd: cost, costSource: cost === undefined ? undefined : 'cli-estimate'
    });
}

export function piCompactionUsage(event: JsonObject): CliUsage | undefined {
    if (event.type !== 'compaction_end') { return undefined; }
    const usage = object(object(event.result).usage);
    const cost = count(object(usage.cost).total);
    return definedUsage({ inputTokens: count(usage.input), outputTokens: count(usage.output),
        cachedInputTokens: count(usage.cacheRead), cacheCreationInputTokens: count(usage.cacheWrite),
        costUsd: cost, costSource: cost === undefined ? undefined : 'cli-estimate' });
}

export interface CliOutput {
    text: string;
    usage?: CliUsage;
    model?: string;
    failed?: boolean;
}

/** Parse the envelope, never JSON embedded in the final assistant text. */
export function parseCliOutput(providerId: KnownCliId, stdout: string): CliOutput {
    if (providerId === 'grok') { return { text: stdout.trim() }; }
    const result: CliOutput = { text: '' };
    if (providerId === 'pi') {
        let lastStopReason: string | undefined;
        let settled = false;
        for (const line of stdout.split(/\r?\n/)) {
            try {
                const event = object(JSON.parse(line));
                if (event.type === 'message_end' && object(event.message).role === 'assistant') {
                    const message = object(event.message);
                    result.text = (Array.isArray(message.content) ? message.content : [])
                        .flatMap(part => object(part).type === 'text' && typeof object(part).text === 'string'
                            ? [object(part).text as string] : []).join('\n').trim();
                    lastStopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined;
                    const model = message.model;
                    if (typeof model === 'string') { result.model = model; }
                    result.usage = sumCliUsage([result.usage, piMessageUsage(event)]);
                }
                result.usage = sumCliUsage([result.usage, piCompactionUsage(event)]);
                if (event.type === 'agent_settled') { settled = true; }
                if (event.type === 'error' || event.type === 'auto_retry_end' && event.success === false
                    || event.type === 'compaction_end' && event.errorMessage) { result.failed = true; }
            } catch { /* Ignore malformed diagnostic lines. */ }
        }
        if (!settled || lastStopReason !== 'stop') { result.failed = true; }
        return result;
    }
    if (providerId === 'claude') {
        try {
            const event = object(JSON.parse(stdout));
            if (event.type !== 'result') { return result; }
            result.text = typeof event.result === 'string' ? event.result.trim() : '';
            result.usage = claudeResultUsage(event);
            const models = Object.keys(object(event.modelUsage));
            if (models.length === 1) { result.model = models[0]; }
            result.failed = event.is_error === true || String(event.subtype ?? '').startsWith('error');
        } catch { /* Invalid structured output is handled by the caller as a failed response. */ }
        return result;
    }
    for (const line of stdout.split(/\r?\n/)) {
        try {
            const event = object(JSON.parse(line));
            const item = object(event.item);
            if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
                result.text = item.text.trim();
            }
            result.usage = sumCliUsage([result.usage, codexTurnUsage(event)]);
            if (event.type === 'turn.failed' || event.type === 'error') { result.failed = true; }
        } catch { /* Ignore non-event diagnostic lines. */ }
    }
    return result;
}

const PI_DELTA_EVENT = /^\s*\{\s*"type"\s*:\s*"message_update"\s*[,}]/;

/**
 * Collects one-shot CLI stdout for parseCliOutput. pi's JSON mode emits one message_update event per
 * token delta with a fixed envelope, so a Japanese reply grows about 90 times in transit; the parser
 * never reads those events, so they are dropped before callers measure the output against their limit.
 */
export class CliStdoutBuffer {
    protected kept = '';
    protected partial = '';

    constructor(protected readonly providerId: KnownCliId) { }

    append(text: string): void {
        if (this.providerId !== 'pi') {
            this.kept += text;
            return;
        }
        const lines = `${this.partial}${text}`.split('\n');
        this.partial = lines.pop() ?? '';
        for (const line of lines) {
            if (!PI_DELTA_EVENT.test(line)) {
                this.kept += `${line}\n`;
            }
        }
    }

    get length(): number {
        return this.kept.length + this.partial.length;
    }

    toString(): string {
        return `${this.kept}${this.partial}`;
    }
}

export function finishCliCall(
    start: Pick<CliCallRecord, 'purpose' | 'providerId' | 'model' | 'effort' | 'startedAt' | 'attempt'>,
    usage?: CliUsage, exitCode?: number | null, now = new Date()
): CliCallRecord {
    return { ...start, endedAt: now.toISOString(), durationMs: Math.max(0, now.getTime() - Date.parse(start.startedAt)),
        exitCode: exitCode ?? undefined, usage };
}
