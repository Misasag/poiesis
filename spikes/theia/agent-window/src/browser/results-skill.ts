import { Emitter, Event } from '@theia/core/lib/common';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { ExecutionTask, isEmptyTaskChangeSet, TaskChangeSet, TaskService } from './task-service';
import { ResultsSkillBundle } from '../common/skill-bundle';
import { ResultsGenerationServer } from '../common/results-generation-protocol';
import { ResultsGenerationContext } from './results-generation-context';
import { WorkspaceSkillService } from './workspace-skill-service';

export const ResultsSkill = Symbol('ResultsSkill');

export interface ResultsSkillInput {
    task: ExecutionTask;
    changeSet: TaskChangeSet;
}

export interface ResultsSkill extends ResultsSkillBundle {
    generate(input: ResultsSkillInput): Promise<ResultsSkillDocument>;
    cancel?(taskId: string): Promise<void>;
}

export interface ResultsSkillDocument {
    html: string;
    generator: 'ai' | 'template' | 'fallback';
    fallbackReason?: string;
}

export interface TaskResultDocument extends Partial<Pick<ResultsSkillDocument, 'generator' | 'fallbackReason'>> {
    taskId: string;
    status: 'generating' | 'ready' | 'failed';
    html?: string;
    error?: string;
}

interface ResultFileSummary {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    additions: number;
    deletions: number;
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

    async generate(
        { task, changeSet }: ResultsSkillInput,
        options: { fallback?: boolean } = {}
    ): Promise<ResultsSkillDocument> {
        const files = this.describeFiles(changeSet);
        const additions = files.reduce((total, file) => total + file.additions, 0);
        const deletions = files.reduce((total, file) => total + file.deletions, 0);
        const completedAt = this.localTime(task.endedAt);
        const fallbackNotice = options.fallback ? `
    <aside class="fallback" role="status">
      <div><strong>AI 生成に失敗したため簡易表示</strong><span>変更内容から確認できる情報を表示しています。</span></div>
      <button type="button" data-poiesis-action="retry-ai-results">AI で再生成</button>
    </aside>` : '';
        const fileRows = files.map(file => `
        <li>
          <span class="status ${file.status}">${this.statusLabel(file.status)}</span>
          <a href="#" data-poiesis-citation="${this.escape(`${file.path}:1`)}">${this.escape(file.path)}</a>
          <span class="lines"><b>+${file.additions}</b><i>−${file.deletions}</i></span>
        </li>`).join('');
        const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${this.escape(task.title)} · 成果</title>
  <style>
    :root { font: 14px/1.55 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", sans-serif; background: #f1efe8; color: #262721; }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body { margin: 0; min-height: 100vh; background: #f1efe8; }
    .paper { width: 100%; min-height: 100vh; display: grid; align-content: start; gap: 22px; padding: clamp(22px, 4vw, 44px); background: #f1efe8; }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: #9a9183; background-clip: padding-box; }
    ::-webkit-scrollbar-thumb:hover { background: #766d61; background-clip: padding-box; }
    header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 24px; padding-bottom: 20px; border-bottom: 1px solid #d6d3c9; }
    .kicker, .meta { color: #686b62; font-size: 11px; font-weight: 750; letter-spacing: .1em; }
    h1 { max-width: 28ch; margin: 7px 0 0; color: #1f211c; font-size: clamp(24px, 4vw, 38px); line-height: 1.15; letter-spacing: -.025em; }
    .fallback { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 16px; border: 1px solid #c6a56e; border-radius: 8px; background: #eee3cd; }
    .fallback div { display: grid; gap: 2px; }
    .fallback span { color: #665c4d; font-size: 12px; }
    button { flex: 0 0 auto; padding: 7px 12px; border: 1px solid #79694f; border-radius: 5px; background: #f7f1e5; color: #3f372c; cursor: pointer; font: inherit; font-weight: 700; }
    button:hover { background: #fffaf0; }
    .overview { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
    article { min-width: 0; padding: 19px 20px; border: 1px solid #d6d3c9; border-radius: 8px; background: #ebe8df; }
    h2 { margin: 0 0 10px; color: #33352e; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
    p { margin: 0; color: #53564e; overflow-wrap: anywhere; }
    .changes { padding-top: 2px; }
    .changes-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; margin-bottom: 9px; }
    .changes-heading h2 { margin: 0; color: #24261f; font-size: 18px; letter-spacing: 0; text-transform: none; }
    .changes-heading span { color: #666960; font-size: 12px; }
    ul { margin: 0; padding: 0; border-block: 1px solid #d6d3c9; list-style: none; }
    li { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 48px; padding: 8px 4px; border-bottom: 1px solid #d6d3c9; }
    li:last-child { border-bottom: 0; }
    .status { width: max-content; padding: 2px 7px; border-radius: 999px; color: #55584f; background: #dfddd4; font-size: 11px; font-weight: 750; }
    .status.added { color: #3f6148; background: #dce7dc; }
    .status.deleted { color: #80524e; background: #eadbd7; }
    a { min-width: 0; color: #405879; font-weight: 650; overflow-wrap: anywhere; text-decoration: underline; text-underline-offset: 3px; }
    .lines { display: flex; gap: 9px; font-variant-numeric: tabular-nums; }
    .lines b { color: #477351; }
    .lines i { color: #98645e; font-style: normal; }
    @media (max-width: 640px) {
      .paper { gap: 16px; padding: 22px 18px; }
      header { grid-template-columns: 1fr; gap: 9px; }
      .overview { grid-template-columns: 1fr; }
      .fallback { align-items: stretch; flex-direction: column; }
      li { grid-template-columns: 64px minmax(0, 1fr); }
      .lines { grid-column: 2; }
    }
  </style>
</head>
<body>
  <main class="paper">
    <header>
      <div><div class="kicker">完了した成果</div><h1>${this.escape(task.title)}</h1></div>
      ${completedAt ? `<time class="meta" datetime="${this.escape(task.endedAt ?? '')}">${this.escape(completedAt)}</time>` : ''}
    </header>
    ${fallbackNotice}
    <section class="overview">
      <article><h2>依頼</h2><p>${this.escape(this.compact(task.request, 420))}</p></article>
      <article><h2>Agent の完了報告</h2><p>${this.escape(this.compact(task.completionSummary ?? 'タスクを完了しました。', 720))}</p></article>
    </section>
    <section class="changes">
      <div class="changes-heading"><h2>変更ファイル</h2><span>${files.length} 件 · +${additions} −${deletions}</span></div>
      <ul aria-label="変更ファイル一覧">${fileRows}
      </ul>
    </section>
  </main>
</body>
</html>`;
        return { html, generator: options.fallback ? 'fallback' : 'template' };
    }

    describeFiles(changeSet: TaskChangeSet): ResultFileSummary[] {
        const chunks = changeSet.diff.split(/(?=^diff --git )/m).filter(chunk => chunk.startsWith('diff --git '));
        return changeSet.files.map((path, index) => {
            const normalizedPath = path.replace(/\\/g, '/');
            const chunk = chunks.find(candidate => candidate.includes(` a/${normalizedPath} b/${normalizedPath}`))
                ?? chunks[index]
                ?? '';
            const additions = chunk.split(/\r?\n/).filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
            const deletions = chunk.split(/\r?\n/).filter(line => line.startsWith('-') && !line.startsWith('---')).length;
            const status = /^new file mode\b/m.test(chunk) || /^--- \/dev\/null$/m.test(chunk)
                ? 'added'
                : /^deleted file mode\b/m.test(chunk) || /^\+\+\+ \/dev\/null$/m.test(chunk)
                    ? 'deleted'
                    : 'modified';
            return { path: normalizedPath, status, additions, deletions };
        });
    }

    protected statusLabel(status: ResultFileSummary['status']): string {
        return status === 'added' ? '追加' : status === 'deleted' ? '削除' : '変更';
    }

    protected compact(value: string, maxLength: number): string {
        const compact = value.replace(/\s+/g, ' ').trim();
        return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
    }

    protected localTime(value: string | undefined): string {
        const date = value ? new Date(value) : undefined;
        if (!date || Number.isNaN(date.getTime())) {
            return '';
        }
        return new Intl.DateTimeFormat('ja-JP', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
            timeZoneName: 'short'
        }).format(date);
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
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService,
        @inject(WorkspaceSkillService) protected readonly workspaceSkillService: WorkspaceSkillService
    ) { }

    async generate(input: ResultsSkillInput): Promise<ResultsSkillDocument> {
        const workspace = this.workspaceService.tryGetRoots()[0]
            ?? (this.workspaceService.workspace?.isDirectory ? this.workspaceService.workspace : undefined);
        if (!workspace) {
            console.warn('[Poiesis][Results diagnostics] AI generation skipped: no local Workspace is open.');
            const fallback = await this.fallbackSkill.generate(input, { fallback: true });
            return { ...fallback, fallbackReason: 'no-workspace' };
        }

        try {
            const workspaceSkills = await this.workspaceSkillService.buildPrompt(workspace.resource.toString(), 'results');
            for (const diagnostic of workspaceSkills.diagnostics) {
                console.warn(`[Poiesis] ${diagnostic}`);
            }
            const result = await this.generationServer.generate({
                taskId: input.task.id,
                providerId: this.context.providerId,
                model: this.context.model || undefined,
                workspaceUri: workspace.resource.toString(),
                taskMetadata: {
                    status: 'completed',
                    title: input.task.title,
                    request: input.task.request,
                    completionSummary: input.task.completionSummary,
                    completedAtLocal: this.localTime(input.task.endedAt)
                },
                changeSetSummary: JSON.stringify(this.fallbackSkill.describeFiles(input.changeSet), undefined, 2),
                diff: input.changeSet.diff,
                workspaceSkillGuidance: workspaceSkills.content || undefined
            });
            if (result.status === 'cancelled') {
                throw new ResultsGenerationCancelledError(result.error.message);
            }
            if (result.status === 'failed') {
                throw new Error(`${result.error.code}: ${result.error.message}${result.error.stderr ? `\n${result.error.stderr}` : ''}`);
            }
            return {
                html: this.normalizeAndValidate(result.html),
                generator: 'ai'
            };
        } catch (error) {
            if (error instanceof ResultsGenerationCancelledError) {
                throw error;
            }
            console.warn('[Poiesis][Results diagnostics] AI generation failed; using bundled template.', error);
            const fallback = await this.fallbackSkill.generate(input, { fallback: true });
            return { ...fallback, fallbackReason: 'generation-failed' };
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
        return html.replace(/\bTASK-\d+(?:-\d+)+\b/gi, '完了したタスク');
    }

    protected localTime(value: string | undefined): string | undefined {
        const date = value ? new Date(value) : undefined;
        if (!date || Number.isNaN(date.getTime())) {
            return undefined;
        }
        return new Intl.DateTimeFormat('ja-JP', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
            timeZoneName: 'short'
        }).format(date);
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
        @inject(ResultsSkill) protected readonly resultsSkill: ResultsSkill
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
        if (task?.status === 'completed' && task.changeSet && !isEmptyTaskChangeSet(task.changeSet)) {
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
        if (task.status !== 'completed' || !task.changeSet || isEmptyTaskChangeSet(task.changeSet)) {
            return;
        }
        const generationToken = ++this.generationSequence;
        this.generationTokens.set(task.id, generationToken);
        this.set({ taskId: task.id, status: 'generating' });
        try {
            const generated = await this.resultsSkill.generate({ task, changeSet: task.changeSet });
            if (this.generationTokens.get(task.id) !== generationToken) {
                return;
            }
            if (!/^(?:<!doctype\s+html[^>]*>\s*)?<html[\s>]/i.test(generated.html.trim())) {
                throw new Error('Results skill did not return one complete HTML document.');
            }
            this.set({ taskId: task.id, status: 'ready', ...generated });
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
