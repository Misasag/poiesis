import { injectable } from '@theia/core/shared/inversify';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { HOOK_EVENTS, HookConfiguration, HookDefinition, HookEvent, HookInput, HookResult, HookRow, HookScope, HooksServer, emptyHookResult } from '../common/hooks-protocol';
import { childCliEnvironment, killHiddenProcessTree } from './hidden-process';

export function parseHooks(text: string, scope: HookScope): HookRow[] {
    const config = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (config?.version !== 1 || !config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
        throw new Error('設定の形式またはバージョンが正しくありません。');
    }
    const rows: HookRow[] = [];
    for (const [event, definitions] of Object.entries(config.hooks)) {
        if (!HOOK_EVENTS.includes(event as HookEvent) || !Array.isArray(definitions)) { throw new Error('実行契機の設定が正しくありません。'); }
        const ids = new Set<string>();
        for (const value of definitions as HookDefinition[]) {
            if (!value || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200 || /[\r\n]/.test(value.id)
                || ids.has(value.id) || !Array.isArray(value.command) || !value.command.length
                || value.command.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !value.command[0].trim()
                || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 300_000
                || !['advisory', 'required'].includes(value.policy) || typeof value.enabled !== 'boolean') {
                throw new Error('フックの名前、コマンド、制限時間、実行方針を確認してください。');
            }
            ids.add(value.id);
            rows.push({ id: value.id, command: [...value.command], timeoutMs: value.timeoutMs,
                policy: value.policy, enabled: value.enabled, event: event as HookEvent, scope });
        }
    }
    return rows;
}

/** Resolve PATH ourselves so a Windows script shim can never reach spawn. */
export async function resolveHookCommand(argv: readonly string[], env = process.env): Promise<{ executable: string; args: string[] }> {
    const command = argv[0];
    if (!command) { throw new Error('コマンドが空です。'); }
    if (['.cmd', '.bat', '.ps1'].includes(extname(command).toLowerCase())) { throw new Error('スクリプトの代わりに実行ファイルを指定してください。'); }
    const candidates = isAbsolute(command) ? [command] : command.includes('/') || command.includes('\\') ? []
        : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).flatMap(dir =>
            process.platform === 'win32' ? [join(dir, command + (extname(command) ? '' : '.exe'))] : [join(dir, command)]);
    for (const candidate of candidates) {
        try {
            const executable = await realpath(candidate);
            if (['.cmd', '.bat', '.ps1'].includes(extname(executable).toLowerCase())) { continue; }
            if ((await stat(executable)).isFile()) { return { executable, args: argv.slice(1) }; }
        } catch { /* Try the next PATH entry. */ }
    }
    throw new Error('コマンドの実行ファイルが見つかりません。絶対パスも指定できます。');
}

interface Preferences { trusted: string[]; enabled: Record<string, boolean> }
@injectable()
export class HooksServerImpl implements HooksServer {
    protected readonly lastRuns = new Map<string, HookRow['lastRun']>();
    protected writes: Promise<void> = Promise.resolve();
    constructor(protected readonly home = homedir()) { }
    protected async workspaceKey(workspace: string): Promise<string> {
        if (!workspace) { return ''; }
        const path = await realpath(workspace);
        return process.platform === 'win32' ? path.toLowerCase() : path;
    }
    protected key(workspace: string, row: Pick<HookRow, 'scope' | 'event' | 'id'>): string {
        return JSON.stringify([row.scope === 'user' ? this.home : workspace, row.scope, row.event, row.id]);
    }
    protected async preferences(): Promise<Preferences> {
        try {
            const value = JSON.parse((await readFile(join(this.home, '.poiesis', 'hook-preferences.json'), 'utf8')).replace(/^\uFEFF/, ''));
            return { trusted: Array.isArray(value.trusted) ? value.trusted.filter((v: unknown) => typeof v === 'string') : [], enabled: value.enabled ?? {} };
        } catch { return { trusted: [], enabled: {} }; }
    }
    protected updatePreferences(update: (value: Preferences) => void): Promise<void> {
        const operation = this.writes.catch(() => undefined).then(async () => {
            const value = await this.preferences(); update(value);
            await mkdir(join(this.home, '.poiesis'), { recursive: true });
            await writeFile(join(this.home, '.poiesis', 'hook-preferences.json'), JSON.stringify(value), 'utf8');
        });
        this.writes = operation; return operation;
    }
    async setWorkspaceEnabled(workspace: string, enabled: boolean): Promise<void> {
        const key = await this.workspaceKey(workspace);
        if (!key) { throw new Error('フォルダーを開いてください。'); }
        await this.updatePreferences(value => { value.trusted = value.trusted.filter(item => item !== key); if (enabled) { value.trusted.push(key); } });
    }
    async setEnabled(workspace: string, scope: HookScope, event: HookEvent, id: string, enabled: boolean): Promise<void> {
        const key = this.key(await this.workspaceKey(workspace), { scope, event, id });
        await this.updatePreferences(value => { value.enabled[key] = enabled; });
    }
    async list(workspace: string): Promise<HookConfiguration> {
        const key = await this.workspaceKey(workspace);
        const preferences = await this.preferences();
        const rows: HookRow[] = []; const errors: string[] = []; const errorScopes: HookScope[] = [];
        for (const scope of ['user', 'workspace'] as const) {
            if (scope === 'workspace' && !key) { continue; }
            try {
                const text = await readFile(join(scope === 'user' ? this.home : key, '.poiesis', 'hooks.json'), 'utf8');
                for (const row of parseHooks(text, scope)) {
                    const rowKey = this.key(key, row);
                    rows.push({ ...row, enabled: preferences.enabled[rowKey] ?? row.enabled, lastRun: this.lastRuns.get(rowKey) });
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    errorScopes.push(scope);
                    errors.push(`${scope === 'user' ? 'ユーザー' : 'ワークスペース'}の Hooks 設定を読み込めません。${error instanceof SyntaxError ? 'JSON の形式を確認してください。' : (error as Error).message}`);
                }
            }
        }
        return { rows, errors, errorScopes, workspaceEnabled: preferences.trusted.includes(key) };
    }
    async run(input: HookInput): Promise<HookResult> {
        if (input.schemaVersion !== 1 || !HOOK_EVENTS.includes(input.event)) { throw new Error('未対応のフック実行です。'); }
        const config = await this.list(input.workspace);
        const result = emptyHookResult();
        const errors = config.errors.filter((_, index) => config.errorScopes?.[index] !== 'workspace' || config.workspaceEnabled);
        if (errors.length) {
            console.warn('[Poiesis][Hooks]', ...errors);
            if (input.event === 'promptSubmit' || input.event === 'taskStart') { result.blockReason = errors.join('\n'); }
            if (input.event === 'taskEnd') { result.evidence.push({ hookId: 'Hooks', runId: input.runId, incomplete: true, notes: errors.join('\n'), evidence: [] }); }
        }
        for (const row of config.rows.filter(row => row.event === input.event && row.enabled && (row.scope === 'user' || config.workspaceEnabled))) {
            const started = Date.now();
            const stdin = JSON.stringify(input);
            const run = { id: row.id, scope: row.scope, event: input.event, runId: input.runId,
                status: 'pass' as 'pass' | 'fail', time: new Date().toISOString(), durationMs: 0,
                stdinBytes: Buffer.byteLength(stdin), stdoutBytes: 0, error: undefined as string | undefined };
            try {
                const stdout = await this.execute(row, stdin, input.workspace, bytes => { run.stdoutBytes = bytes; });
                const value = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, '')) : {};
                if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('出力は JSON オブジェクトにしてください。'); }
                if (['promptSubmit', 'taskStart', 'sessionResume'].includes(input.event) && value.additionalContext !== undefined) {
                    if (typeof value.additionalContext !== 'string') { throw new Error('追加文脈の形式が正しくありません。'); }
                    result.contexts.push({ id: row.id, content: value.additionalContext.slice(0, 8_000) });
                }
                if (input.event === 'promptSubmit' && row.policy === 'required' && value.block !== undefined) {
                    if (typeof value.block?.reason !== 'string' || !value.block.reason.trim()) { throw new Error('保留理由がありません。'); }
                    result.blockReason = `フック「${row.id}」が送信を保留しました: ${value.block.reason.slice(0, 2_000)}`;
                }
                if (input.event === 'resultsGenerate' && value.material !== undefined) {
                    if (typeof value.material !== 'string') { throw new Error('成果の材料の形式が正しくありません。'); }
                    result.material = (result.material + value.material + '\n').slice(0, 16_000);
                }
                if (input.event === 'taskEnd') {
                    if (value.notes !== undefined && typeof value.notes !== 'string' || value.evidence !== undefined && (!Array.isArray(value.evidence)
                        || value.evidence.some((item: { label?: unknown; status?: string; detail?: unknown; image?: unknown }) => !item || typeof item.label !== 'string'
                            || !['pass', 'fail', 'unknown'].includes(item.status ?? '') || typeof item.detail !== 'string'
                            || item.image !== undefined && (typeof item.image !== 'string' || item.image.length > 1024)))) {
                        throw new Error('検証記録の形式が正しくありません。');
                    }
                    result.evidence.push({ hookId: row.id, runId: input.runId, notes: value.notes?.slice(0, 8_000),
                        evidence: (value.evidence ?? []).slice(0, 100).map((item: { label: string; status: 'pass' | 'fail' | 'unknown'; detail: string; image?: string }) =>
                            ({ label: item.label.slice(0, 200), status: item.status, detail: item.detail.slice(0, 2_000), ...(item.image !== undefined ? { image: item.image } : {}) })) });
                }
            } catch (error) {
                run.status = 'fail'; run.error = error instanceof SyntaxError ? '出力が正しい JSON ではありません。' : (error as Error).message;
                console.warn(`[Poiesis][Hooks] ${row.id}: ${run.error}`);
                if (row.policy === 'required') {
                    if (input.event === 'promptSubmit' || input.event === 'taskStart') { result.blockReason = `フック「${row.id}」を完了できないため、作業を開始しませんでした。${run.error}`; }
                    if (input.event === 'taskEnd') { result.evidence.push({ hookId: row.id, runId: input.runId, incomplete: true, notes: '検証未完了', evidence: [] }); }
                }
            }
            run.durationMs = Date.now() - started;
            this.lastRuns.set(this.key(await this.workspaceKey(input.workspace), row), run);
            result.runs.push(run);
            if (result.blockReason) { break; }
        }
        return result;
    }
    protected async execute(row: HookRow, input: string, workspace: string, onSize: (bytes: number) => void): Promise<string> {
        const invocation = await resolveHookCommand(row.command);
        return new Promise((resolvePromise, reject) => {
            const child = spawn(invocation.executable, invocation.args, { cwd: workspace || undefined,
                env: childCliEnvironment(process.env, workspace), shell: false, windowsHide: true,
                detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
            const chunks: Buffer[] = []; let bytes = 0; let stopped = false;
            const stop = async (message: string): Promise<void> => {
                if (stopped) { return; } stopped = true; clearTimeout(timer);
                if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
                else {
                    try { await killHiddenProcessTree(child, 2_000, true); }
                    catch { message += ' 子プロセスの終了を確認できませんでした。'; }
                }
                reject(new Error(message));
            };
            const timer = setTimeout(() => { void stop('制限時間を超えました。'); }, row.timeoutMs);
            child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; onSize(bytes); if (bytes > 1_048_576) { void stop('出力の上限を超えました。'); } else { chunks.push(chunk); } });
            child.stderr.resume();
            child.stdin.on('error', () => { /* Early exit is reported by close. */ });
            child.once('error', () => { void stop('コマンドを起動できませんでした。'); });
            child.once('close', code => {
                if (stopped) { return; } stopped = true; clearTimeout(timer);
                if (code !== 0) { reject(new Error(`終了コード ${code ?? '不明'} で失敗しました。`)); }
                else { resolvePromise(Buffer.concat(chunks).toString('utf8')); }
            });
            child.stdin.end(input, 'utf8');
        });
    }
}
