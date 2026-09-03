import type { AgentActivity, AgentActivityKind, AgentActivityStatus } from '../common/agent-provider';
import type { KnownCliId } from '../common/agent-runtime-protocol';

export interface ActivityParseResult {
    activities: AgentActivity[];
    finalMessage?: string;
    diagnostics: string[];
    heartbeat?: 'process' | 'turn';
}

export interface AgentActivityParser {
    consumeLine(line: string, now?: Date): ActivityParseResult;
}

type JsonObject = Record<string, unknown>;

const MAX_ACTIVITY_DETAIL_CHARS = 2_000;

class CliActivityParser implements AgentActivityParser {
    protected readonly activities = new Map<string, AgentActivity>();
    protected sequence = 0;
    protected grokMessage = '';

    constructor(
        protected readonly providerId: KnownCliId,
        protected readonly workspacePath?: string
    ) { }

    consumeLine(line: string, now = new Date()): ActivityParseResult {
        if (!line.trim()) {
            return this.emptyResult();
        }
        if (this.providerId === 'grok') {
            this.grokMessage = `${this.grokMessage ? `${this.grokMessage}\n` : ''}${line}`;
            return { activities: [], finalMessage: this.grokMessage, diagnostics: [] };
        }
        let event: JsonObject;
        try {
            const parsed: unknown = JSON.parse(line);
            if (!isObject(parsed)) {
                return { activities: [], diagnostics: [line] };
            }
            event = parsed;
        } catch {
            return { activities: [], diagnostics: [line] };
        }
        return this.providerId === 'claude'
            ? this.consumeClaude(event, now)
            : this.consumeCodex(event, now, line);
    }

    protected consumeCodex(event: JsonObject, now: Date, sourceLine: string): ActivityParseResult {
        const result = this.emptyResult();
        const eventType = stringValue(event.type);
        if (eventType === 'thread.started') {
            return { ...result, heartbeat: 'process' };
        }
        if (eventType === 'turn.started') {
            return { ...result, heartbeat: 'turn' };
        }
        const item = isObject(event.item) ? event.item : undefined;
        if ((eventType === 'item.started' || eventType === 'item.completed') && item) {
            const activity = this.codexActivity(eventType, item, now);
            if (activity) {
                result.activities.push(activity);
            }
            if (eventType === 'item.completed' && item.type === 'agent_message') {
                const text = stringValue(item.text);
                if (text) {
                    result.finalMessage = text;
                }
            }
        }
        if (eventType === 'error' || eventType === 'turn.failed' || item?.type === 'error') {
            result.diagnostics.push(
                stringValue(event.message)
                ?? stringValue(item?.message)
                ?? (typeof event.error === 'string'
                    ? event.error
                    : isObject(event.error) ? stringValue(event.error.message) : undefined)
                ?? sourceLine
            );
        }
        return result;
    }

    protected codexActivity(eventType: string, item: JsonObject, now: Date): AgentActivity | undefined {
        const itemType = stringValue(item.type) ?? 'unknown';
        if (itemType === 'agent_message' && !stringValue(item.text)) {
            return undefined;
        }
        const id = stringValue(item.id) ?? this.nextId('codex');
        const previous = this.activities.get(id);
        const timestamp = now.toISOString();
        const status = itemType === 'error' ? 'failed' : codexActivityStatus(eventType, item);
        const base = this.codexActivityDescription(itemType, item);
        let detail = base.detail;
        const exitCode = numberValue(item.exit_code);
        if (itemType === 'command_execution' && exitCode !== undefined) {
            detail = status === 'failed'
                ? `${detail ?? ''} · 終了コード ${exitCode}`.trim()
                : `${detail ?? ''} (終了コード ${exitCode})`.trim();
        }
        const activity: AgentActivity = {
            id,
            kind: base.kind,
            title: base.title,
            detail: truncateDetail(detail),
            status,
            startedAt: previous?.startedAt ?? timestamp,
            endedAt: status === 'running' ? undefined : timestamp
        };
        this.activities.set(id, activity);
        return activity;
    }

    protected codexActivityDescription(
        itemType: string,
        item: JsonObject
    ): { kind: AgentActivityKind; title: string; detail?: string } {
        if (itemType === 'command_execution') {
            return {
                kind: 'command',
                title: 'コマンド実行',
                detail: commandDetail(stringValue(item.command) ?? '')
            };
        }
        if (itemType === 'file_change') {
            const changes = Array.isArray(item.changes) ? item.changes : [];
            const detail = changes.flatMap(change => {
                if (!isObject(change) || !stringValue(change.path)) {
                    return [];
                }
                const kind = stringValue(change.kind);
                const suffix = kind === 'add' ? '追加' : kind === 'delete' ? '削除' : '更新';
                return [`${this.relativePath(stringValue(change.path)!)} · ${suffix}`];
            }).join(', ');
            return { kind: 'file-change', title: 'ファイル変更', detail };
        }
        if (itemType === 'reasoning') {
            return { kind: 'reasoning', title: '思考', detail: firstLine(stringValue(item.text)) };
        }
        if (itemType === 'agent_message') {
            return { kind: 'message', title: 'メッセージ', detail: stringValue(item.text) };
        }
        return {
            kind: 'tool',
            title: itemType,
            detail: genericToolDetail(itemType, item)
        };
    }

    protected consumeClaude(event: JsonObject, now: Date): ActivityParseResult {
        const result = this.emptyResult();
        const eventType = stringValue(event.type);
        if (eventType === 'system') {
            return { ...result, heartbeat: 'process' };
        }
        const message = isObject(event.message) ? event.message : undefined;
        const content = Array.isArray(message?.content) ? message.content : [];
        if (eventType === 'assistant') {
            const text = content.flatMap(item => isObject(item) && item.type === 'text' && typeof item.text === 'string'
                ? [item.text]
                : []).join('\n').trim();
            if (text) {
                result.finalMessage = text;
            }
            for (const item of content) {
                if (!isObject(item) || item.type !== 'tool_use') {
                    continue;
                }
                result.activities.push(this.claudeToolActivity(item, now));
            }
        } else if (eventType === 'user') {
            for (const item of content) {
                if (!isObject(item) || item.type !== 'tool_result') {
                    continue;
                }
                const completed = this.completeClaudeTool(item, now);
                if (completed) {
                    result.activities.push(completed);
                }
            }
        } else if (eventType === 'result') {
            const finalMessage = stringValue(event.result);
            if (finalMessage?.trim()) {
                result.finalMessage = finalMessage;
            }
        }
        if (event.is_error === true || event.subtype === 'error') {
            result.diagnostics.push(stringValue(event.result) ?? JSON.stringify(event));
        }
        return result;
    }

    protected claudeToolActivity(item: JsonObject, now: Date): AgentActivity {
        const id = stringValue(item.id) ?? this.nextId('claude');
        const name = stringValue(item.name) ?? 'tool';
        const input = isObject(item.input) ? item.input : {};
        const description = this.claudeToolDescription(name, input);
        const activity: AgentActivity = {
            id,
            ...description,
            detail: truncateDetail(description.detail),
            status: 'running',
            startedAt: now.toISOString()
        };
        this.activities.set(id, activity);
        return activity;
    }

    protected completeClaudeTool(item: JsonObject, now: Date): AgentActivity | undefined {
        const id = stringValue(item.tool_use_id);
        const previous = id ? this.activities.get(id) : undefined;
        if (!id || !previous) {
            return undefined;
        }
        const activity: AgentActivity = {
            ...previous,
            status: item.is_error === true ? 'failed' : 'completed',
            endedAt: now.toISOString()
        };
        this.activities.set(id, activity);
        return activity;
    }

    protected claudeToolDescription(
        name: string,
        input: JsonObject
    ): { kind: AgentActivityKind; title: string; detail?: string } {
        if (name === 'Read') {
            return {
                kind: 'read',
                title: 'ファイル読み取り',
                detail: this.relativePath(stringValue(input.file_path) ?? '')
            };
        }
        if (name === 'Glob' || name === 'Grep' || name === 'LS') {
            const value = name === 'LS'
                ? stringValue(input.path)
                : stringValue(input.pattern) ?? stringValue(input.path);
            return { kind: 'read', title: '検索', detail: this.relativePath(value ?? '') };
        }
        if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
            const path = this.relativePath(stringValue(input.file_path) ?? stringValue(input.notebook_path) ?? '');
            const detail = name === 'Write' ? path : `${path} · 更新`;
            return { kind: 'file-change', title: 'ファイル変更', detail };
        }
        if (name === 'Bash') {
            return {
                kind: 'command',
                title: 'コマンド実行',
                detail: commandDetail(stringValue(input.command) ?? '')
            };
        }
        return { kind: 'tool', title: name, detail: compactJson(input) };
    }

    protected relativePath(path: string): string {
        const value = path.trim();
        if (!value || !isAbsolutePath(value)) {
            return value;
        }
        if (this.workspacePath) {
            const normalizedPath = normalizeComparablePath(value);
            const normalizedWorkspace = normalizeComparablePath(this.workspacePath).replace(/\/$/, '');
            const caseInsensitive = /^[a-z]:\//i.test(normalizedWorkspace);
            const comparedPath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
            const comparedWorkspace = caseInsensitive ? normalizedWorkspace.toLowerCase() : normalizedWorkspace;
            if (comparedPath === comparedWorkspace) {
                return '.';
            }
            if (comparedPath.startsWith(`${comparedWorkspace}/`)) {
                return normalizedPath.slice(normalizedWorkspace.length + 1);
            }
        }
        return basename(value);
    }

    protected nextId(prefix: string): string {
        return `${prefix}-activity-${++this.sequence}`;
    }

    protected emptyResult(): ActivityParseResult {
        return { activities: [], diagnostics: [] };
    }
}

export function createAgentActivityParser(providerId: KnownCliId, workspacePath?: string): AgentActivityParser {
    return new CliActivityParser(providerId, workspacePath);
}

function codexActivityStatus(eventType: string, item: JsonObject): AgentActivityStatus {
    const status = stringValue(item.status);
    const exitCode = numberValue(item.exit_code);
    if (status === 'failed' || exitCode !== undefined && exitCode !== 0) {
        return 'failed';
    }
    if (eventType === 'item.started' || status === 'in_progress') {
        return 'running';
    }
    return 'completed';
}

function stripShellWrapper(command: string): string {
    let stripped = command.trim();
    const wrappers = [
        /^(?:"[^"]*\\powershell(?:\.exe)?"|(?:[A-Za-z]:\\[^\s"]*\\)?powershell(?:\.exe)?)\s+(?:-Command|-C)\s+([\s\S]+)$/i,
        /^(?:"[^"]*\\pwsh(?:\.exe)?"|(?:[A-Za-z]:\\[^\s"]*\\)?pwsh(?:\.exe)?)\s+(?:-Command|-C)\s+([\s\S]+)$/i,
        /^(?:\/bin\/)?(?:ba|z|k|da)?sh\s+-lc\s+([\s\S]+)$/i,
        /^(?:"[^"]*\\cmd(?:\.exe)?"|(?:[A-Za-z]:\\[^\s"]*\\)?cmd(?:\.exe)?)\s+\/c\s+([\s\S]+)$/i
    ];
    for (const wrapper of wrappers) {
        const match = stripped.match(wrapper);
        if (match) {
            stripped = match[1].trim();
            break;
        }
    }
    if (stripped.length >= 2) {
        const quote = stripped[0];
        if ((quote === '"' || quote === "'") && stripped.at(-1) === quote) {
            stripped = stripped.slice(1, -1);
        }
    }
    return stripped;
}

function commandDetail(command: string): string {
    return stripShellWrapper(command)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .join('; ');
}

function genericToolDetail(itemType: string, item: JsonObject): string | undefined {
    if (itemType === 'web_search') {
        return stringValue(item.query);
    }
    if (itemType === 'mcp_tool_call') {
        return stringValue(item.tool)
            ?? stringValue(item.name)
            ?? stringValue(item.server);
    }
    return stringValue(item.text)
        ?? stringValue(item.message)
        ?? stringValue(item.query);
}

function compactJson(value: JsonObject): string | undefined {
    const keys = Object.keys(value);
    return keys.length ? JSON.stringify(value) : undefined;
}

function truncateDetail(value: string | undefined): string | undefined {
    const normalized = value?.replace(/\r?\n/g, ' ').trim();
    return normalized ? normalized.slice(0, MAX_ACTIVITY_DETAIL_CHARS) : undefined;
}

function firstLine(value: string | undefined): string | undefined {
    return value?.split(/\r?\n/, 1)[0]?.trim();
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isAbsolutePath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

function normalizeComparablePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function basename(value: string): string {
    return value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? value;
}
