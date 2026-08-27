import { Emitter, Event } from '@theia/core/lib/common';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { ExecutionTask, TaskChangeSet, TaskService } from './task-service';
import { CustomizationService } from './customization-service';
import { ResultsSkillBundle } from '../common/skill-bundle';
import { ResultsGenerationServer } from '../common/results-generation-protocol';
import { ResultsGenerationContext } from './results-generation-context';

export const ResultsSkill = Symbol('ResultsSkill');

export interface ResultsSkillInput {
    task: ExecutionTask;
    changeSet: TaskChangeSet;
}

export interface ResultsSkill extends ResultsSkillBundle {
    generate(input: ResultsSkillInput): Promise<string>;
    cancel?(taskId: string): Promise<void>;
}

export interface TaskResultDocument {
    taskId: string;
    status: 'generating' | 'ready' | 'failed';
    html?: string;
    error?: string;
}

interface ResultDiagramNode {
    label: string;
    detail: string;
    boundary?: boolean;
}

interface ResultPage {
    heading: string;
    summary: string;
    note: string;
    citation: string;
    nodes: ResultDiagramNode[];
}

/** The built-in document generator for this slice. */
@injectable()
export class BundledResultsSkill implements ResultsSkill {
    readonly manifest = {
        id: 'builtin.results',
        name: 'Bundled Results',
        version: '1.0.0',
        kind: 'results' as const,
        entry: 'builtin:results'
    };

    async generate({ task, changeSet }: ResultsSkillInput): Promise<string> {
        const diff = changeSet.diff.trim();
        const page = this.describe(task, changeSet, diff);
        const diagram = page.nodes.length > 0 ? this.renderDiagram(page.nodes) : '';
        const state = task.status === 'cancelled' ? 'キャンセル' : task.status === 'failed' ? '失敗' : '完了';

        return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${this.escape(task.title)} · 設計ノート</title>
  <style>
    :root { font: 14px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", sans-serif; background: #f1efe8; color: #262721; }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    html { background: #f1efe8; }
    body { margin: 0; min-height: 100vh; background: #f1efe8; }
    .paper { width: 100%; min-height: 100vh; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; gap: 20px; padding: clamp(20px, 4vw, 40px); background: #f1efe8; }
    .paper > * { width: min(100%, 72ch); margin-inline: auto; }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: #9a9183; background-clip: padding-box; }
    ::-webkit-scrollbar-thumb:hover { background: #766d61; background-clip: padding-box; }
    .kicker { color: #686b62; font-size: 11px; font-weight: 750; letter-spacing: .13em; }
    .heading { display: grid; gap: 8px; }
    h1 { margin: 0; color: #1f211c; font-size: clamp(22px, 4vw, 34px); line-height: 1.2; letter-spacing: -.02em; }
    p { max-width: 64ch; margin: 0; color: #61645c; font-size: 14px; }
    code { font: inherit; }
    .diagram { display: grid; grid-template-columns: repeat(var(--nodes), minmax(0, 1fr)); align-items: stretch; gap: 28px; padding: 24px 2px; border-block: 1px solid #d6d3c9; }
    .node { position: relative; min-width: 0; padding: 14px 15px; border: 1px solid #c8c8be; border-radius: 7px; background: #e9e7df; }
    .node.is-boundary { border-color: #879278; background: #e1e6d9; }
    .node + .node::before { position: absolute; top: 50%; right: calc(100% + 8px); width: 12px; color: #878a81; content: "→"; font-size: 16px; transform: translateY(-50%); }
    .node strong, .node small { display: block; overflow-wrap: anywhere; }
    .node strong { color: #272922; font-size: 14px; }
    .node small { margin-top: 4px; color: #74776e; font-size: 11px; }
    footer { display: flex; grid-row: 4; align-items: flex-end; justify-content: space-between; gap: 22px; }
    .note { min-width: 0; color: #53564e; font-size: 12px; }
    .citation { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 6px; color: #4d607e; font-size: 12px; font-style: normal; text-decoration: underline; text-underline-offset: 3px; }
    .citation code { max-width: 34ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (max-width: 560px) {
      .paper { gap: 16px; padding: 24px 20px; }
      .diagram { grid-template-columns: 1fr; gap: 22px; }
      .node + .node::before { top: auto; right: auto; bottom: calc(100% + 1px); left: 50%; transform: translateX(-50%) rotate(90deg); }
      footer { align-items: flex-start; flex-direction: column; gap: 10px; }
    }
  </style>
</head>
<body>
  <main class="paper">
    <div class="kicker">タスク設計 · ${state}</div>
    <header class="heading">
      <h1>${this.escape(page.heading)}</h1>
      <p>${this.escape(page.summary)}</p>
    </header>
    ${diagram}
    <footer>
      <div class="note">${this.escape(page.note)}</div>
      <cite class="citation" aria-label="変更ファイルの引用"><span aria-hidden="true">▤</span><code>${this.escape(page.citation)}</code></cite>
    </footer>
  </main>
</body>
</html>`;
    }

    protected describe(task: ExecutionTask, changeSet: TaskChangeSet, diff: string): ResultPage {
        if (changeSet.files.length === 0 || !diff) {
            return {
                heading: 'この Task に設計変更はありません',
                summary: 'この Task ではファイルは変更されませんでした。',
                note: '既存の設計境界はそのままです。次の実行は新しい Task として記録されます。',
                citation: '変更ファイルなし',
                nodes: []
            };
        }

        const file = changeSet.files[0];
        if (this.addedLogout(diff)) {
            return {
                heading: 'AuthService に logout の出口が加わった',
                summary: 'セッション終了の入口はできましたが、トークン失効を担う revoke はまだ空のままです。',
                note: '次の設計判断は、logout から revoke を呼び出し、失効の責務を認証境界の内側へ閉じることです。',
                citation: this.citationFor(file, diff),
                nodes: [
                    { label: 'AuthService', detail: '認証の入口' },
                    { label: 'logout(userId)', detail: '追加された出口', boundary: true },
                    { label: 'revoke', detail: '未実装' }
                ]
            };
        }

        const types = this.changedTypes(diff);
        const fileName = file.split('/').pop() ?? file;
        return {
            heading: types.length > 0 ? `${types[0]} の設計境界が更新された` : `${fileName} の変更範囲を記録した`,
            summary: types.length > 0
                ? `この Task は ${changeSet.files.length} 件のファイルに触れ、${types.join('・')} の関係を更新しました。`
                : `この Task の変更は ${changeSet.files.length} 件のファイルに収まっています。`,
            note: types.length > 0
                ? '差分そのものではなく、変更が置かれた型の境界を示しています。'
                : '型の関係として表せる変更はないため、変更範囲だけを要約しています。',
            citation: this.citationFor(file, diff),
            nodes: types.slice(0, 3).map((type, index) => ({
                label: type,
                detail: index === 0 ? '変更の中心' : '関連する型',
                boundary: index === 0
            }))
        };
    }

    protected addedLogout(diff: string): boolean {
        return diff.split(/\r?\n/).some(line =>
            /^\+\s*(?:(?:public|protected|private)\s+)?(?:async\s+)?logout\s*\(/.test(line)
        );
    }

    protected changedTypes(diff: string): string[] {
        const names: string[] = [];
        for (const line of diff.split(/\r?\n/)) {
            if (!/^[ +]/.test(line) || line.startsWith('+++')) {
                continue;
            }
            const match = line.slice(1).match(/^(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
            if (match && !names.includes(match[1])) {
                names.push(match[1]);
            }
        }
        return names;
    }

    protected citationFor(file: string, diff: string): string {
        const hunk = diff.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/m);
        if (!hunk) {
            return file;
        }
        const start = Number(hunk[1]);
        const count = Number(hunk[2] ?? '1');
        return count > 1 ? `${file}:${start}–${start + count - 1}` : `${file}:${start}`;
    }

    protected renderDiagram(nodes: ResultDiagramNode[]): string {
        const content = nodes.map(node => `      <div class="node${node.boundary ? ' is-boundary' : ''}">
        <strong>${this.escape(node.label)}</strong>
        <small>${this.escape(node.detail)}</small>
      </div>`).join('\n');
        return `<div class="diagram" style="--nodes: ${nodes.length}" role="img" aria-label="変更された設計境界">
${content}
    </div>`;
    }

    protected escape(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

const AI_RESULTS_HTML_MAX_CHARS = 280_000;

class ResultsGenerationCancelledError extends Error { }

/** Default Results bundle: asks the selected Results AI, then falls back to the built-in template. */
@injectable()
export class AiResultsSkill implements ResultsSkill {
    readonly manifest = {
        id: 'builtin.ai-results',
        name: 'AI Results',
        version: '1.0.0',
        kind: 'results' as const,
        entry: 'builtin:ai-results'
    };

    constructor(
        @inject(ResultsGenerationServer) protected readonly generationServer: ResultsGenerationServer,
        @inject(BundledResultsSkill) protected readonly fallbackSkill: BundledResultsSkill,
        @inject(ResultsGenerationContext) protected readonly context: ResultsGenerationContext,
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService
    ) { }

    async generate(input: ResultsSkillInput): Promise<string> {
        const workspace = this.workspaceService.tryGetRoots()[0]
            ?? (this.workspaceService.workspace?.isDirectory ? this.workspaceService.workspace : undefined);
        if (!workspace) {
            console.warn('[Poiesis] AI Results generation skipped because no local Workspace is open; using bundled template.');
            return this.fallbackSkill.generate(input);
        }

        try {
            const result = await this.generationServer.generate({
                taskId: input.task.id,
                providerId: this.context.providerId,
                workspaceUri: workspace.resource.toString(),
                taskMetadata: {
                    status: 'completed',
                    title: input.task.title,
                    request: input.task.request,
                    startedAt: input.task.startedAt,
                    endedAt: input.task.endedAt
                },
                changeSetSummary: JSON.stringify({
                    source: input.changeSet.source,
                    files: input.changeSet.files,
                    capturedAt: input.changeSet.capturedAt,
                    error: input.changeSet.error
                }, undefined, 2),
                diff: input.changeSet.diff
            });
            if (result.status === 'cancelled') {
                throw new ResultsGenerationCancelledError(result.error.message);
            }
            if (result.status === 'failed') {
                throw new Error(`${result.error.code}: ${result.error.message}${result.error.stderr ? `\n${result.error.stderr}` : ''}`);
            }
            return this.normalizeAndValidate(result.html);
        } catch (error) {
            if (error instanceof ResultsGenerationCancelledError) {
                throw error;
            }
            console.warn('[Poiesis] AI Results generation failed; using bundled template.', error);
            return this.fallbackSkill.generate(input);
        }
    }

    cancel(taskId: string): Promise<void> {
        return this.generationServer.cancel(taskId);
    }

    protected normalizeAndValidate(output: string): string {
        let html = output.trim();
        const fenced = html.match(/```(?:html)?\s*([\s\S]*?)```/i);
        if (fenced) {
            html = fenced[1].trim();
        }
        if (html.length > AI_RESULTS_HTML_MAX_CHARS) {
            throw new Error(`AI Results HTML exceeded ${AI_RESULTS_HTML_MAX_CHARS} characters.`);
        }
        if (!/^(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s|>)/i.test(html)) {
            throw new Error('AI Results did not return one complete HTML document.');
        }
        if (/<script\b|<link\b|\son\w+\s*=|(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i.test(html)) {
            throw new Error('AI Results HTML contained scripts or external resources.');
        }
        return html;
    }
}

/** App-owned trigger: skills run only after a Task ends or is cancelled. */
@injectable()
export class ResultsService {
    protected readonly documents = new Map<string, TaskResultDocument>();
    protected readonly onDidChangeEmitter = new Emitter<TaskResultDocument>();
    readonly onDidChange: Event<TaskResultDocument> = this.onDidChangeEmitter.event;
    protected readonly generationTokens = new Map<string, number>();
    protected generationSequence = 0;

    constructor(
        @inject(TaskService) protected readonly taskService: TaskService,
        @inject(ResultsSkill) protected readonly resultsSkill: ResultsSkill,
        @inject(CustomizationService) protected readonly customizationService: CustomizationService
    ) { }

    @postConstruct()
    protected init(): void {
        this.taskService.onDidChangeTask(event => {
            if (event.type === 'ended' || event.type === 'failed' || event.type === 'cancelled') {
                void this.generate(event.task);
            }
        });
    }

    get(taskId: string): TaskResultDocument | undefined {
        return this.documents.get(taskId);
    }

    list(taskIds?: Iterable<string>): TaskResultDocument[] {
        const selected = taskIds ? new Set(taskIds) : undefined;
        return [...this.documents.values()].filter(document => !selected || selected.has(document.taskId));
    }

    restore(documents: readonly TaskResultDocument[], taskIds: ReadonlySet<string>): void {
        for (const document of documents) {
            if (!document
                || typeof document.taskId !== 'string'
                || !taskIds.has(document.taskId)
                || !['ready', 'failed'].includes(document.status)) {
                continue;
            }
            this.documents.set(document.taskId, document);
        }
    }

    async retry(taskId: string): Promise<void> {
        const task = this.taskService.get(taskId);
        if (task?.status === 'completed' && task.changeSet) {
            await this.generate(task);
        }
    }

    remove(taskIds: Iterable<string>): void {
        for (const taskId of [...taskIds]) {
            this.generationTokens.delete(taskId);
            void this.resultsSkill.cancel?.(taskId).catch(error =>
                console.warn('[Poiesis] Could not cancel Results generation.', error)
            );
            this.documents.delete(taskId);
        }
    }

    protected async generate(task: ExecutionTask): Promise<void> {
        if (task.status !== 'completed' || !task.changeSet || !this.customizationService.isSkillEnabled('results')) {
            return;
        }
        const generationToken = ++this.generationSequence;
        this.generationTokens.set(task.id, generationToken);
        this.set({ taskId: task.id, status: 'generating' });
        try {
            const html = await this.resultsSkill.generate({ task, changeSet: task.changeSet });
            if (this.generationTokens.get(task.id) !== generationToken) {
                return;
            }
            if (!/^(?:<!doctype\s+html[^>]*>\s*)?<html[\s>]/i.test(html.trim())) {
                throw new Error('Results skill did not return one complete HTML document.');
            }
            this.set({ taskId: task.id, status: 'ready', html });
        } catch (error) {
            if (this.generationTokens.get(task.id) !== generationToken) {
                return;
            }
            this.set({
                taskId: task.id,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error)
            });
        } finally {
            if (this.generationTokens.get(task.id) === generationToken) {
                this.generationTokens.delete(task.id);
            }
        }
    }

    protected set(document: TaskResultDocument): void {
        this.documents.set(document.taskId, document);
        this.onDidChangeEmitter.fire(document);
    }
}
