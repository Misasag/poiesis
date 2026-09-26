import { readChildUtf8 } from './child-utf8';
import { resolveResultsImages } from './results-images';
import { CliStdoutBuffer } from '../common/cli-usage';
import { captureCliCall, CliCallCapture } from './cli-call';
import { mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import { isKnownCliId, KnownCliId } from '../common/agent-runtime-protocol';
import { BundledResultsSkillInfo, ResultsGenerationError, ResultsGenerationRequest, ResultsGenerationResult, ResultsGenerationServer } from '../common/results-generation-protocol';
import { CliProviderRegistry } from './cli-provider-registry';
import { unsupportedModelEffortMessage } from './cli-model-discovery';
import { HiddenCliProcess, killHiddenProcessTree, spawnHiddenCli } from './hidden-process';
import { buildResultsSkillInput, resultsRedactor } from './results-skill-input';
import { loadBundledResultsSkill, pathWithin, resultsExecutionEnvironment, resultsNodeExecutable, resultsSkillCliArgs, writeClaudeResultsSettings } from './results-skill-runtime';

interface ResultsGenerationRun {
    call: CliCallCapture;
    process: HiddenCliProcess;
    cancelled: boolean;
    providerName: string;
    directory: string;
}

export const GENERATED_RESULTS_HTML_MAX_BYTES = 8 * 1024 * 1024;
export const RESULTS_GENERATION_TIMEOUT_MS = 600_000;
const OUTPUT_MAX_CHARS = 8 * 1024 * 1024;
const STDERR_MAX_CHARS = 8_000;

/** Starts the skill's AI and receives its file. Document policy belongs entirely to the skill. */
@injectable()
export class ResultsGenerationServerImpl implements ResultsGenerationServer {
    readonly resolveImages = resolveResultsImages;
    protected readonly runs = new Map<string, ResultsGenerationRun>();
    protected readonly pendingTaskIds = new Set<string>();
    protected readonly cancelledTaskIds = new Set<string>();
    protected timeoutMs = RESULTS_GENERATION_TIMEOUT_MS;

    constructor(@inject(CliProviderRegistry) protected readonly providerRegistry: CliProviderRegistry) { }

    async bundledSkillInfo(): Promise<BundledResultsSkillInfo> {
        const { name, description } = await loadBundledResultsSkill();
        return { name, description };
    }

    async generate(request: ResultsGenerationRequest): Promise<ResultsGenerationResult> {
        const invalid = this.validate(request);
        if (invalid) { return this.failed(invalid); }
        if (this.pendingTaskIds.has(request.taskId)) {
            return this.failed({ code: 'already-running', message: "このタスクの成果文書はすでに作成中です。" });
        }
        this.pendingTaskIds.add(request.taskId);
        try {
            return await captureCliCall(request, 'results-generation', call => this.generateOnce(request, call));
        } finally {
            this.pendingTaskIds.delete(request.taskId);
            this.cancelledTaskIds.delete(request.taskId);
            this.runs.delete(request.taskId);
        }
    }

    protected async generateOnce(request: ResultsGenerationRequest, call: CliCallCapture): Promise<ResultsGenerationResult> {
        let root: string | undefined;
        try {
            const delay = Number(process.env.POIESIS_RESULTS_GENERATION_TEST_DELAY_MS);
            if (delay > 0) { await new Promise(done => setTimeout(done, Math.min(delay, 10_000))); }
            if (this.cancelledTaskIds.has(request.taskId)) { return this.cancelled(); }
            if (process.env.POIESIS_RESULTS_GENERATION_FORCE_FAILURE === '1') {
                return this.failed({ code: 'internal', message: "成果文書生成のテスト用失敗が指定されました。" });
            }
            const deterministic = process.env.POIESIS_RESULTS_GENERATION_TEST_HTML;
            if (deterministic !== undefined) { return this.checkedHtml(deterministic); }
            const workspace = await this.resolveWorkspace(request.workspaceUri);
            const skill = await loadBundledResultsSkill();
            const input = buildResultsSkillInput(request, workspace, skill.directory);
            const provider = await this.providerRegistry.resolve('results', request.providerId, request.model, request.effort);
            const node = resultsNodeExecutable();
            const temp = await realpath(tmpdir());
            const parent = pathWithin(workspace, temp) ? dirname(workspace) : temp;
            if (pathWithin(workspace, parent)) { throw new Error("作業場所の外に成果作成の一時フォルダーを用意できません。"); }
            root = await mkdtemp(join(parent, 'poiesis-results-'));
            const directory = join(root, 'run');
            const control = join(root, 'control');
            await mkdir(directory);
            await mkdir(control);
            await writeFile(join(directory, 'input.json'), JSON.stringify(input, null, 2), 'utf8');
            const settings = provider.id === 'claude'
                ? await writeClaudeResultsSettings(control, directory, workspace, skill.directory, node) : undefined;
            const prompt = this.buildPrompt(skill.content, skill.directory, (input as { userGuidance: string }).userGuidance);
            const args = resultsSkillCliArgs({ providerId: provider.id, model: provider.model, effort: request.effort,
                workspace: directory, prompt, promptViaStdin: true }, settings);
            if (this.cancelledTaskIds.has(request.taskId)) { return this.cancelled(); }
            const child = this.spawnCli(provider.id, provider.path, args, directory, prompt, resultsExecutionEnvironment(node));
            const run = { call, process: child, cancelled: false, providerName: provider.name, directory };
            this.runs.set(request.taskId, run);
            return await this.collectResult(request.taskId, run);
        } catch (error) {
            if (this.cancelledTaskIds.has(request.taskId)) { return this.cancelled(); }
            return this.failed({ code: this.isCommandMissing(error) ? 'cli-not-found' : 'internal',
                message: unsupportedModelEffortMessage(error) ?? (error instanceof Error && /^[組成果作変]/.test(error.message)
                    ? resultsRedactor()(error.message) : '成果文書の作成を開始できませんでした。') });
        } finally {
            if (root && process.env.POIESIS_RESULTS_KEEP_RUN_DIR !== '1') {
                await rm(root, { recursive: true, force: true }).catch(() => undefined);
            }
        }
    }

    protected buildPrompt(content: string, skillDir: string, userGuidance: string): string {
        return ["成果文書を作成してください。", 'Skill directory: ' + skillDir.replace(/\\/g, '/'), content,
            'Input: input.json (current directory)', 'Output: results.html (current directory)',
            "利用者の追加の指示:", userGuidance].join('\n\n');
    }

    async cancel(taskId: string): Promise<void> {
        if (this.pendingTaskIds.has(taskId)) { this.cancelledTaskIds.add(taskId); }
        const run = this.runs.get(taskId);
        if (run) { run.cancelled = true; await this.killProcess(run.process); }
    }

    protected collectResult(taskId: string, run: ResultsGenerationRun): Promise<ResultsGenerationResult> {
        return new Promise(resolvePromise => {
            const stdout = new CliStdoutBuffer(run.call.start.providerId);
            let stderr = '';
            let settled = false;
            let timedOut = false;
            let tooLarge = false;
            const finish = (result: ResultsGenerationResult): void => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timeout);
                run.call.parse(stdout.toString());
                resolvePromise(result);
            };
            const timeout = setTimeout(() => { timedOut = true; void this.killProcess(run.process); }, this.timeoutMs);
            readChildUtf8(run.process, text => {
                if (tooLarge) { return; }
                stdout.append(text);
                if (stdout.length > OUTPUT_MAX_CHARS) { tooLarge = true; void this.killProcess(run.process); }
            }, text => { stderr = (stderr + text).slice(-STDERR_MAX_CHARS); });
            run.process.once('error', error => finish(this.failed({ code: this.isCommandMissing(error) ? 'cli-not-found' : 'internal',
                message: "成果作成の AI を起動できませんでした。" })));
            run.process.once('close', (code, signal) => {
                clearTimeout(timeout);
                run.call.exitCode = code ?? undefined;
                const output = run.call.parse(stdout.toString());
                if (run.cancelled || this.cancelledTaskIds.has(taskId)) { finish(this.cancelled()); return; }
                if (timedOut) { finish(this.failed({ code: 'timeout', message: "成果文書の作成が時間内に完了しませんでした。" })); return; }
                if (tooLarge) { finish(this.failed({ code: 'too-large', message: "成果作成の作業記録が上限を超えました。" })); return; }
                if (code !== 0 || signal || output.failed) {
                    finish(this.failed({ code: 'cli-failed', message: run.providerName + "による成果文書の作成に失敗しました。",
                        exitCode: code, signal, stderr: resultsRedactor()(stderr.trim()) }));
                    return;
                }
                void this.readOutput(run.directory).then(result => finish(run.cancelled || this.cancelledTaskIds.has(taskId) ? this.cancelled() : result),
                    () => finish(this.failed({ code: 'invalid-output', message: "成果文書を読み込めませんでした。", retryable: true })));
            });
        });
    }

    protected async readOutput(directory: string): Promise<ResultsGenerationResult> {
        const path = join(directory, 'results.html');
        try {
            if (!pathWithin(await realpath(directory), await realpath(path))) {
                return this.failed({ code: 'invalid-output', message: "成果文書が実行場所の外に保存されています。", retryable: true });
            }
            const file = await open(path, 'r');
            try {
                const info = await file.stat();
                if (!info.isFile()) { return this.failed({ code: 'invalid-output', message: "成果文書を読み込めませんでした。", retryable: true }); }
                if (info.size > GENERATED_RESULTS_HTML_MAX_BYTES) { return this.outputTooLarge(); }
                const buffer = Buffer.alloc(GENERATED_RESULTS_HTML_MAX_BYTES + 1);
                let offset = 0;
                while (offset < buffer.length) {
                    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
                    if (!bytesRead) { break; }
                    offset += bytesRead;
                }
                return this.checkedHtml(buffer.subarray(0, offset).toString('utf8'));
            } finally { await file.close(); }
        } catch {
            return this.failed({ code: 'invalid-output', message: "成果文書が保存されていないか、読み込めませんでした。", retryable: true });
        }
    }

    protected checkedHtml(value: string): ResultsGenerationResult {
        if (Buffer.byteLength(value, 'utf8') > GENERATED_RESULTS_HTML_MAX_BYTES) { return this.outputTooLarge(); }
        const html = value.replace(/^\uFEFF/, '');
        return html.trim() ? { status: 'generated', html }
            : this.failed({ code: 'invalid-output', message: "成果文書の内容が空でした。", retryable: true });
    }

    protected outputTooLarge(): ResultsGenerationResult {
        return this.failed({ code: 'too-large', message: "成果文書が上限（8 MiB）を超えました。", retryable: true });
    }

    protected validate(request: ResultsGenerationRequest): ResultsGenerationError | undefined {
        if (!request || typeof request.taskId !== 'string' || !request.taskId.trim() || !isKnownCliId(request.providerId)
            || typeof request.workspaceUri !== 'string' || !request.workspaceUri.trim() || !request.taskMetadata
            || !['completed', 'failed', 'cancelled'].includes(request.taskMetadata.status)
            || typeof request.taskMetadata.request !== 'string' || typeof request.diff !== 'string'
            || request.model !== undefined && typeof request.model !== 'string'
            || request.effort !== undefined && typeof request.effort !== 'string'
            || request.attempt !== undefined && request.attempt !== 1 && request.attempt !== 2) {
            return { code: 'invalid-scope', message: "成果文書の作成に必要な作業情報が揃っていません。" };
        }
        if (request.providerId !== 'codex' && request.providerId !== 'claude') {
            return { code: 'unsupported-provider', message: "成果文書の作成には未対応" };
        }
        return undefined;
    }

    protected async resolveWorkspace(workspaceUri: string): Promise<string> {
        const resource = new URI(workspaceUri);
        if (resource.scheme !== 'file') { throw new Error("成果作成にはこの端末の作業場所が必要です。"); }
        const path = await realpath(resolve(resource.path.fsPath()));
        return (await stat(path)).isDirectory() ? path : dirname(path);
    }

    protected spawnCli(providerId: KnownCliId, command: string, args: string[], cwd: string, input?: string, env?: NodeJS.ProcessEnv): HiddenCliProcess {
        return spawnHiddenCli(providerId, command, args, { cwd, env, input });
    }
    protected killProcess(child: HiddenCliProcess): Promise<void> { return killHiddenProcessTree(child); }
    protected failed(error: ResultsGenerationError): ResultsGenerationResult { return { status: 'failed', error }; }
    protected cancelled(): ResultsGenerationResult { return { status: 'cancelled', error: { code: 'cancelled', message: "成果文書の作成をキャンセルしました。" } }; }
    protected isCommandMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'; }
}
