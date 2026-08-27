import { Emitter, Event } from '@theia/core/lib/common';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ExecutionTask, TaskChangeSet, TaskService } from './task-service';
import { CustomizationService } from './customization-service';

export const ResultsSkill = Symbol('ResultsSkill');

export interface ResultsSkillInput {
    task: ExecutionTask;
    changeSet: TaskChangeSet;
}

export interface ResultsSkill {
    generate(input: ResultsSkillInput): Promise<string>;
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
    :root { font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #1b1c1a; color: #262721; }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body { display: grid; margin: 0; padding: clamp(10px, 3vw, 26px); place-items: start center; background: #1b1c1a; }
    .paper { width: min(100%, 760px); min-height: min(430px, calc(100vh - 52px)); display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; gap: 20px; padding: clamp(24px, 5vw, 48px); border-radius: 8px; background: #f1efe8; box-shadow: 0 10px 32px rgba(0, 0, 0, .24); }
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
      .paper { min-height: calc(100vh - 20px); gap: 16px; padding: 24px 20px; }
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

/** App-owned trigger: skills run only after a Task ends or is cancelled. */
@injectable()
export class ResultsService {
    protected readonly documents = new Map<string, TaskResultDocument>();
    protected readonly onDidChangeEmitter = new Emitter<TaskResultDocument>();
    readonly onDidChange: Event<TaskResultDocument> = this.onDidChangeEmitter.event;

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

    async retry(taskId: string): Promise<void> {
        const task = this.taskService.get(taskId);
        if (task?.status === 'completed' && task.changeSet) {
            await this.generate(task);
        }
    }

    remove(taskIds: Iterable<string>): void {
        for (const taskId of taskIds) {
            this.documents.delete(taskId);
        }
    }

    protected async generate(task: ExecutionTask): Promise<void> {
        if (task.status !== 'completed' || !task.changeSet || !this.customizationService.isSkillEnabled('results')) {
            return;
        }
        this.set({ taskId: task.id, status: 'generating' });
        try {
            const html = await this.resultsSkill.generate({ task, changeSet: task.changeSet });
            if (!/^<!doctype html>/i.test(html.trim()) || !/<html[\s>]/i.test(html)) {
                throw new Error('Results skill did not return one complete HTML document.');
            }
            this.set({ taskId: task.id, status: 'ready', html });
        } catch (error) {
            this.set({
                taskId: task.id,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    protected set(document: TaskResultDocument): void {
        this.documents.set(document.taskId, document);
        this.onDidChangeEmitter.fire(document);
    }
}
