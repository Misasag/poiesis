import { Emitter, Event } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import {
    ExecutionTask,
    summarizeTaskChangeSet,
    TaskChangeSet,
    TaskChangedFileSummary,
    TaskResultDocument,
    TaskService
} from './task-service';
import { hasReadableResultDocument, taskProducesResult } from '../common/task-outcome';
import { ResultsSkillBundle } from '../common/skill-bundle';
import {
    ResultsGenerationRequest,
    ResultsGenerationRequirementMetadata,
    ResultsGenerationServer
} from '../common/results-generation-protocol';
import { ResultsAssertionServer } from '../common/results-assertion-protocol';
import { AgentRuntimeServer } from '../common/agent-runtime-protocol';
import { ResultsGenerationContext } from './results-generation-context';
import { WorkspaceSkillService } from './workspace-skill-service';
import { formatExecutionEvidence, normalizeAiResultsHtml } from './results-document-normalizer';
import { Requirement } from './requirement-model';
import { RequirementService } from './requirement-service';
import { RequirementClassificationService } from './requirement-classification-service';
import { POIESIS_FONT_SANS } from './typography';
import {
    buildFailedAssertionPromptSection,
    checkAppResultsAssertions,
    extractResultsAssertionText,
    parseResultsAssertionJudgement,
    ResultsAssertionDefinition,
    ResultsAssertionResult,
    selectBetterResultsAssertionCandidate
} from './results-assertions';

export const ResultsSkill = Symbol('ResultsSkill');

export interface ResultsSkillInput {
    task: ExecutionTask;
    changeSet: TaskChangeSet;
    documentId?: string;
    requirement?: {
        id: string;
        title: string;
        tasks: ExecutionTask[];
    };
}

export interface ResultsSkill extends ResultsSkillBundle {
    generate(input: ResultsSkillInput): Promise<ResultsSkillDocument>;
    cancel?(taskId: string): Promise<void>;
}

export interface ResultsSkillDocument {
    html: string;
    generator: 'ai' | 'template' | 'fallback';
    providerId?: TaskResultDocument['providerId'];
    model?: string;
    effort?: string;
    fallbackReason?: string;
    assertions?: ResultsAssertionResult[];
    assertionAttempts?: 1 | 2;
}

export function formatRequirementExecutionEvidence(tasks: readonly ExecutionTask[], maxChars = 16_000): string {
    const combined = tasks.map((task, index) => {
        const evidence = formatExecutionEvidence(task.activities, maxChars);
        return `### Task ${index + 1}\n${evidence || '記録なし'}`;
    }).join('\n\n');
    if (combined.length <= maxChars) {
        return combined;
    }
    const marker = `\n[Execution evidence truncated; original length: ${combined.length} characters]`;
    return `${combined.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
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
        { task, changeSet, requirement }: ResultsSkillInput,
        options: { fallback?: boolean } = {}
    ): Promise<ResultsSkillDocument> {
        const files = summarizeTaskChangeSet(changeSet).files;
        const tasks = task.status === 'running' ? [] : [task];
        const displayedTasks = task.status === 'running' ? [] : requirement?.tasks ?? tasks;
        const taskRows = displayedTasks.map((candidate, index) => `
        <li class="task-item">
          <span>${index + 1}</span>
          <strong>${this.escape(candidate.title)}</strong>
          <small>${candidate.status === 'completed' ? '完了' : candidate.status === 'failed' ? '失敗' : 'キャンセル'}</small>
        </li>`).join('');
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
        const changedFiles = files.length > 0
            ? `<ul aria-label="変更ファイル一覧">${fileRows}
      </ul>`
            : `<p class="no-changes">${changeSet.error
                ? '変更ファイルを確認できませんでした。'
                : '変更ファイルはありません。'}</p>`;
        const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>成果本文</title>
  <style>
    :root { font: 14px/1.55 ${POIESIS_FONT_SANS}; background: #f1efe8; color: #262721; }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body { margin: 0; min-height: 100vh; background: #f1efe8; }
    .paper { width: 100%; max-width: none; min-height: 100vh; display: grid; align-content: start; gap: 22px; margin-inline: 0; padding: clamp(14px, 1.2vw, 20px) clamp(16px, 2vw, 28px); background: #f1efe8; }
    .paper > :first-child { margin-top: 0; }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: #9a9183; background-clip: padding-box; }
    ::-webkit-scrollbar-thumb:hover { background: #766d61; background-clip: padding-box; }
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
    .changes-heading { display: flex; align-items: baseline; gap: 20px; margin-bottom: 9px; }
    .changes-heading h2 { margin: 0; color: #24261f; font-size: 18px; letter-spacing: 0; text-transform: none; }
    .no-changes { padding: 14px 0; border-block: 1px solid #d6d3c9; }
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
    .task-list { display: grid; gap: 0; }
    .task-item { grid-template-columns: 32px minmax(0, 1fr) auto; }
    .task-item > span, .task-item small { color: #686b63; }
    @media (max-width: 640px) {
      .paper { gap: 16px; padding: 14px 16px; }
      .overview { grid-template-columns: 1fr; }
      .fallback { align-items: stretch; flex-direction: column; }
      li { grid-template-columns: 64px minmax(0, 1fr); }
      .lines { grid-column: 2; }
    }
  </style>
</head>
<body>
  <main class="paper">
    ${fallbackNotice}
    <section class="overview">
      <article><h2>${requirement ? '要件' : '依頼'}</h2><p>${this.escape(this.compact(requirement?.title ?? task.request, 420))}</p></article>
      <article><h2>実行結果</h2><p>${this.escape(this.compact(this.executionSummary(displayedTasks.at(-1) ?? task), 720))}</p></article>
    </section>
    ${requirement ? `<section class="changes"><div class="changes-heading"><h2>含まれるタスク</h2></div><ul class="task-list">${taskRows}</ul></section>` : ''}
    <section class="changes">
      <div class="changes-heading"><h2>変更ファイル</h2></div>
      ${changedFiles}
    </section>
  </main>
</body>
</html>`;
        return { html, generator: options.fallback ? 'fallback' : 'template' };
    }

    protected statusLabel(status: TaskChangedFileSummary['status']): string {
        return status === 'added' ? '追加' : status === 'deleted' ? '削除' : '変更';
    }

    protected executionSummary(task: ExecutionTask): string {
        return task.status === 'completed'
            ? task.implementerReport ?? task.completionSummary ?? 'タスクを完了しました。'
            : task.status === 'failed'
                ? task.failure?.summary ?? 'タスクを完了できませんでした。'
                : 'タスクはキャンセルされました。';
    }

    protected compact(value: string, maxLength: number): string {
        const compact = value.replace(/\s+/g, ' ').trim();
        return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
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
    protected readonly cancelledDocumentIds = new Set<string>();

    constructor(
        @inject(ResultsGenerationServer) protected readonly generationServer: ResultsGenerationServer,
        @inject(BundledResultsSkill) protected readonly fallbackSkill: BundledResultsSkill,
        @inject(ResultsGenerationContext) protected readonly context: ResultsGenerationContext,
        @inject(WorkspaceSkillService) protected readonly workspaceSkillService: WorkspaceSkillService,
        @inject(TaskService) protected readonly taskService: TaskService,
        @inject(ResultsAssertionServer) protected readonly assertionServer: ResultsAssertionServer
    ) { }

    async generate(input: ResultsSkillInput): Promise<ResultsSkillDocument> {
        if (input.task.status === 'running') {
            throw new Error('Results generation requires a finished Task.');
        }
        const providerId = this.context.providerId;
        const model = this.context.model.trim() || undefined;
        const effort = this.context.effort || undefined;
        const documentId = input.documentId ?? input.task.id;
        const workspaceUri = input.task.workspaceUri;
        this.cancelledDocumentIds.delete(documentId);
        if (!workspaceUri) {
            this.taskService.setAppliedSkills(input.task.id, 'results', []);
            console.warn('[Poiesis][Results diagnostics] AI generation skipped: the Task has no local Workspace.');
            const fallback = await this.fallbackSkill.generate(input, { fallback: true });
            return { ...fallback, fallbackReason: 'no-workspace' };
        }

        try {
            const workspaceSkills = await this.workspaceSkillService.buildPrompt(workspaceUri, 'results');
            this.taskService.setAppliedSkills(input.task.id, 'results', workspaceSkills.includedSkillIds);
            for (const diagnostic of workspaceSkills.diagnostics) {
                console.warn(`[Poiesis] ${diagnostic}`);
            }
            const changeSetSummary = JSON.stringify({
                files: summarizeTaskChangeSet(input.changeSet).files,
                captureError: input.changeSet.error
            }, undefined, 2);
            const request: ResultsGenerationRequest = {
                taskId: documentId,
                providerId,
                model,
                effort,
                workspaceUri,
                taskMetadata: {
                    status: input.task.status,
                    title: input.task.title,
                    request: input.task.request,
                    endedAt: input.task.endedAt,
                    completionSummary: input.task.completionSummary,
                    implementerReport: input.task.implementerReport,
                    failureSummary: input.task.failure?.summary
                },
                requirement: input.requirement ? this.requirementMetadata(input.requirement) : undefined,
                changeSetSummary,
                diff: input.changeSet.diff,
                executionEvidence: input.requirement
                    ? formatRequirementExecutionEvidence(input.requirement.tasks, 16_000) || undefined
                    : formatExecutionEvidence(input.task.activities, 12_000) || undefined,
                workspaceSkillGuidance: workspaceSkills.content || undefined
            };
            const result = await this.generationServer.generate(request);
            if (result.status === 'cancelled') {
                throw new ResultsGenerationCancelledError(result.error.message);
            }
            if (result.status === 'failed') {
                console.warn('[Poiesis][Results diagnostics] AI generation failed; using bundled template.',
                    `${result.error.code}: ${result.error.message}${result.error.stderr ? `\n${result.error.stderr}` : ''}`);
                this.taskService.setAppliedSkills(input.task.id, 'results', []);
                const fallback = await this.fallbackSkill.generate(input, { fallback: true });
                return {
                    ...fallback,
                    providerId,
                    model,
                    effort,
                    fallbackReason: result.error.code === 'timeout' ? 'timeout' : 'generation-failed'
                };
            }
            const first = await this.assertCandidate(
                result.html,
                input,
                workspaceSkills.assertions,
                request,
                changeSetSummary
            );
            if (!first.assertions.some(assertion => assertion.status === 'fail')) {
                return { ...first.document, assertions: [...first.assertions], assertionAttempts: 1 };
            }

            const retryGuidance = buildFailedAssertionPromptSection(first.assertions);
            this.throwIfCancelled(documentId);
            const retryResult = await this.generationServer.generate({ ...request, assertionRetryGuidance: retryGuidance });
            if (retryResult.status === 'cancelled') {
                throw new ResultsGenerationCancelledError(retryResult.error.message);
            }
            if (retryResult.status === 'failed') {
                console.warn('[Poiesis][Results diagnostics] Assertion regeneration failed; keeping the first document.',
                    `${retryResult.error.code}: ${retryResult.error.message}`);
                return { ...first.document, assertions: [...first.assertions], assertionAttempts: 2 };
            }
            try {
                const second = await this.assertCandidate(
                    retryResult.html,
                    input,
                    workspaceSkills.assertions,
                    request,
                    changeSetSummary
                );
                const selected = selectBetterResultsAssertionCandidate(first, second);
                return { ...selected.document, assertions: [...selected.assertions], assertionAttempts: 2 };
            } catch (error) {
                if (error instanceof ResultsGenerationCancelledError) {
                    throw error;
                }
                console.warn('[Poiesis][Results diagnostics] Assertion regeneration was invalid; keeping the first document.', error);
                return { ...first.document, assertions: [...first.assertions], assertionAttempts: 2 };
            }
        } catch (error) {
            if (error instanceof ResultsGenerationCancelledError) {
                throw error;
            }
            this.taskService.setAppliedSkills(input.task.id, 'results', []);
            console.warn('[Poiesis][Results diagnostics] AI generation failed; using bundled template.', error);
            const fallback = await this.fallbackSkill.generate(input, { fallback: true });
            return { ...fallback, providerId, model, effort, fallbackReason: 'generation-failed' };
        }
    }

    async cancel(taskId: string): Promise<void> {
        this.cancelledDocumentIds.add(taskId);
        await Promise.all([
            this.generationServer.cancel(taskId),
            this.assertionServer.cancel(taskId)
        ]);
    }

    protected throwIfCancelled(taskId: string): void {
        if (this.cancelledDocumentIds.has(taskId)) {
            throw new ResultsGenerationCancelledError('Results generation was cancelled.');
        }
    }

    protected async assertCandidate(
        output: string,
        input: ResultsSkillInput,
        definitions: readonly ResultsAssertionDefinition[],
        request: ResultsGenerationRequest,
        changeSetSummary: string
    ): Promise<{
        document: ResultsSkillDocument;
        assertions: ResultsAssertionResult[];
    }> {
        const html = this.normalizeAndValidate(output, input.requirement?.title ?? input.task.title);
        const appAssertions = checkAppResultsAssertions(html, input.changeSet.files);
        let skillAssertions: ResultsAssertionResult[] = [];
        if (definitions.length > 0) {
            try {
                const judged = await this.assertionServer.judge({
                    taskId: request.taskId,
                    providerId: request.providerId,
                    model: request.model,
                    effort: request.effort,
                    workspaceUri: request.workspaceUri,
                    documentText: extractResultsAssertionText(html),
                    assertions: definitions.map(definition => definition.text),
                    changeSetSummary
                });
                if (judged.status === 'cancelled') {
                    throw new ResultsGenerationCancelledError(judged.error.message);
                }
                if (judged.status === 'failed') {
                    console.warn('[Poiesis][Results diagnostics] Skill assertions could not be judged; recording unknown.',
                        `${judged.error.code}: ${judged.error.message}`);
                    skillAssertions = parseResultsAssertionJudgement('', definitions);
                } else {
                    skillAssertions = parseResultsAssertionJudgement(judged.output, definitions);
                }
            } catch (error) {
                this.throwIfCancelled(request.taskId);
                if (error instanceof ResultsGenerationCancelledError) {
                    throw error;
                }
                console.warn('[Poiesis][Results diagnostics] Skill assertion judging failed unexpectedly; recording unknown.', error);
                skillAssertions = parseResultsAssertionJudgement('', definitions);
            }
        }
        return {
            document: {
                html,
                generator: 'ai',
                providerId: request.providerId,
                model: request.model,
                effort: request.effort
            },
            assertions: [...appAssertions, ...skillAssertions]
        };
    }

    protected normalizeAndValidate(output: string, taskTitle: string): string {
        const normalized = normalizeAiResultsHtml(output, { taskTitle });
        for (const note of normalized.notes) {
            console.warn(`[Poiesis][Results diagnostics] ${note}`);
        }
        return normalized.html;
    }

    protected compact(value: string, maxChars: number): string {
        return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
    }

    protected compactOptional(value: string | undefined, maxChars: number): string | undefined {
        return value ? this.compact(value, maxChars) : undefined;
    }

    protected requirementMetadata(
        requirement: NonNullable<ResultsSkillInput['requirement']>
    ): ResultsGenerationRequirementMetadata {
        const metadata: ResultsGenerationRequirementMetadata = {
            title: this.compact(requirement.title, 1_000),
            tasks: requirement.tasks.map(task => ({
                status: task.status === 'running' ? 'cancelled' : task.status,
                title: this.compact(task.title, 500),
                request: this.compact(task.request, 4_000),
                endedAt: this.compactOptional(task.endedAt, 80),
                completionSummary: this.compactOptional(task.completionSummary, 2_000),
                implementerReport: this.compactOptional(task.implementerReport, 4_000),
                failureSummary: this.compactOptional(task.failure?.summary, 1_000),
                changeSetSummary: this.compact(JSON.stringify({
                    files: summarizeTaskChangeSet(task.changeSet).files,
                    captureError: task.changeSet?.error
                }), 4_000)
            }))
        };
        const maxChars = 30_000;
        let serializedLength = JSON.stringify(metadata).length;
        while (serializedLength > maxChars) {
            type CompactableKey = 'request' | 'implementerReport' | 'changeSetSummary'
                | 'completionSummary' | 'failureSummary' | 'title';
            const keys: CompactableKey[] = [
                'request', 'implementerReport', 'changeSetSummary',
                'completionSummary', 'failureSummary', 'title'
            ];
            const strings: Array<{
                task: ResultsGenerationRequirementMetadata['tasks'][number];
                key: CompactableKey;
                value: string;
            }> = [];
            for (const task of metadata.tasks) {
                for (const key of keys) {
                    const value = task[key];
                    if (typeof value === 'string' && value.length > 1) {
                        strings.push({ task, key, value });
                    }
                }
            }
            const longest = strings.sort((left, right) => right.value.length - left.value.length)[0];
            if (!longest) {
                break;
            }
            const nextLength = Math.max(1, longest.value.length - (serializedLength - maxChars));
            longest.task[longest.key] = this.compact(longest.value, nextLength);
            serializedLength = JSON.stringify(metadata).length;
        }
        return metadata;
    }

}

/** App-owned trigger: skills run only after a Task ends or is cancelled. */
@injectable()
export class ResultsService {
    protected static readonly UPDATE_ERROR = '成果の更新に失敗しました。';
    protected readonly documents = new Map<string, TaskResultDocument>();
    protected readonly requirementChangeSets = new Map<string, TaskChangeSet>();
    protected readonly onDidChangeEmitter = new Emitter<TaskResultDocument>();
    readonly onDidChange: Event<TaskResultDocument> = this.onDidChangeEmitter.event;
    protected readonly generationTokens = new Map<string, number>();
    protected readonly generationPromises = new Map<string, Promise<void>>();
    protected readonly requirementGenerationPromises = new Map<string, Promise<void>>();
    protected readonly requestedRequirementVersions = new Map<string, string>();
    protected readonly appliedRequirementVersions = new Map<string, string>();
    protected readonly attemptedRequirementVersions = new Map<string, string>();
    protected readonly restoredGenerationTaskIds = new Set<string>();
    protected generationSequence = 0;

    constructor(
        @inject(TaskService) protected readonly taskService: TaskService,
        @inject(ResultsSkill) protected readonly resultsSkill: ResultsSkill,
        @inject(RequirementService) protected readonly requirementService: RequirementService,
        @inject(RequirementClassificationService) protected readonly requirementClassificationService: RequirementClassificationService,
        @inject(WorkspaceSkillService) protected readonly workspaceSkillService: WorkspaceSkillService,
        @inject(AgentRuntimeServer) protected readonly runtimeServer: AgentRuntimeServer
    ) { }

    @postConstruct()
    protected init(): void {
        this.taskService.registerTerminalFinalizer(task => this.startGeneration(task));
        this.requirementService.onDidChange(event => {
            if (event.type === 'tasks-changed') {
                for (const requirementId of event.requirementIds) {
                    const requirement = this.requirementService.get(requirementId);
                    const attachedTasks = requirement?.taskIds.map(taskId => this.taskService.get(taskId))
                        .filter((task): task is ExecutionTask => Boolean(task)) ?? [];
                    if (requirement && !attachedTasks.some(task => task.status === 'running')) {
                        void this.startRequirementGeneration(requirementId);
                    } else if (!requirement) {
                        this.requirementChangeSets.delete(requirementId);
                        this.requestedRequirementVersions.delete(requirementId);
                        this.appliedRequirementVersions.delete(requirementId);
                        this.attemptedRequirementVersions.delete(requirementId);
                    }
                }
            }
        });
    }

    get(taskId: string): TaskResultDocument | undefined {
        return this.documents.get(taskId) ?? this.taskService.get(taskId)?.resultsDocument;
    }

    list(taskIds?: Iterable<string>): TaskResultDocument[] {
        const selected = taskIds ? new Set(taskIds) : undefined;
        return [...this.documents.values()].filter(document => !selected || selected.has(document.taskId));
    }

    getRequirement(requirementId: string): TaskResultDocument | undefined {
        return this.requirementService.get(requirementId)?.resultsDocument;
    }

    getRequirementChangeSet(requirementId: string): TaskChangeSet | undefined {
        return this.requirementChangeSets.get(requirementId);
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
            this.taskService.setResultsDocument(document.taskId, document);
        }
        for (const taskId of taskIds) {
            const task = this.taskService.get(taskId);
            const document = this.get(taskId);
            if (task && (!document || document.status === 'generating')) {
                this.restoredGenerationTaskIds.add(taskId);
            }
        }
    }

    async restoreRequirements(): Promise<void> {
        for (const requirement of this.requirementService.list()) {
            const tasks = this.finishedRequirementTasks(requirement);
            if (!tasks.length) {
                continue;
            }
            if (tasks.length === 1) {
                const document = this.get(tasks[0].id);
                if (document) {
                    const version = this.requirementOutcomeVersion(requirement);
                    this.requirementService.setResultsDocument(requirement.id, { ...document, sourceVersion: version });
                    if (document.updateError || document.status === 'failed') {
                        this.attemptedRequirementVersions.set(requirement.id, version);
                    } else if (document.status === 'ready') {
                        this.appliedRequirementVersions.set(requirement.id, version);
                    }
                }
                this.requirementChangeSets.set(requirement.id, tasks[0].changeSet!);
            } else if (requirement.resultsDocument) {
                const version = this.requirementOutcomeVersion(requirement);
                if (requirement.resultsDocument.updateError || requirement.resultsDocument.status === 'failed') {
                    this.attemptedRequirementVersions.set(requirement.id, version);
                } else if (requirement.resultsDocument.status === 'ready'
                    && this.restoredRequirementDocumentIsCurrent(requirement, version)) {
                    this.appliedRequirementVersions.set(requirement.id, version);
                }
            }
        }
    }

    /** Restarts incomplete restored work only after Session and Requirement membership is stable. */
    resumeRestoredGeneration(): void {
        const taskIds = [...this.restoredGenerationTaskIds];
        this.restoredGenerationTaskIds.clear();
        const pendingRequirementIds = new Set<string>();
        for (const taskId of taskIds) {
            const task = this.taskService.get(taskId);
            if (!task) {
                continue;
            }
            pendingRequirementIds.add(task.requirementId);
            void this.startGeneration(task).catch(error =>
                console.warn('[Poiesis] Could not resume restored Results generation.', error)
            );
        }
        for (const requirement of this.requirementService.list()) {
            const tasks = this.finishedRequirementTasks(requirement);
            if (tasks[0]) {
                void this.requirementClassificationService.suggestTitle(tasks[0].id).catch(error =>
                    console.warn('[Poiesis][Requirement title] Could not name the restored outcome.', error)
                );
            }
            if (tasks.length < 2) {
                continue;
            }
            const document = requirement.resultsDocument;
            const needsUpdate = document?.status === 'generating'
                || document?.status === 'ready' && !document.updateError
                    && this.appliedRequirementVersions.get(requirement.id) !== this.requirementOutcomeVersion(requirement);
            if (needsUpdate) {
                if (!pendingRequirementIds.has(requirement.id)) {
                    void this.startRequirementGeneration(requirement.id).catch(error =>
                        console.warn('[Poiesis] Could not resume restored Requirement Results.', error)
                    );
                }
            } else if (requirement.resultsDocument) {
                void this.cumulativeChangeSet(requirement).catch(error =>
                    console.warn('[Poiesis] Could not restore cumulative Results evidence.', error)
                );
            } else if (!pendingRequirementIds.has(requirement.id)) {
                void this.startRequirementGeneration(requirement.id).catch(error =>
                    console.warn('[Poiesis] Could not resume restored Requirement Results.', error)
                );
            }
        }
    }

    async retry(taskId: string): Promise<void> {
        const task = this.taskService.get(taskId);
        if (task && task.status !== 'running' && this.shouldGenerate(task)) {
            await this.startGeneration(task);
        }
    }

    async retryRequirement(requirementId: string): Promise<void> {
        const requirement = this.requirementService.get(requirementId);
        const tasks = requirement ? this.finishedRequirementTasks(requirement) : [];
        if (tasks.length === 1) {
            await this.retry(tasks[0].id);
        }
        await this.startRequirementGeneration(requirementId, true);
    }

    async requirementChangeSet(requirementId: string): Promise<TaskChangeSet | undefined> {
        const cached = this.requirementChangeSets.get(requirementId);
        if (cached) {
            return cached;
        }
        const requirement = this.requirementService.get(requirementId);
        return requirement ? this.cumulativeChangeSet(requirement) : undefined;
    }

    /** Resolves only after the terminal Task's Results document has been attached to that Task. */
    async whenFinished(taskId: string): Promise<TaskResultDocument | undefined> {
        await this.taskService.whenFinalized(taskId);
        await this.generationPromises.get(taskId);
        return this.get(taskId);
    }

    remove(taskIds: Iterable<string>): void {
        for (const taskId of [...taskIds]) {
            this.generationTokens.delete(taskId);
            this.generationPromises.delete(taskId);
            void this.resultsSkill.cancel?.(taskId).catch(error =>
                console.warn('[Poiesis] Could not cancel Results generation.', error)
            );
            this.documents.delete(taskId);
            this.taskService.setResultsDocument(taskId, undefined);
        }
    }

    protected startGeneration(task: ExecutionTask): Promise<void> {
        if (!this.shouldGenerate(task)) {
            this.documents.delete(task.id);
            this.taskService.setResultsDocument(task.id, undefined);
            const requirementId = this.taskService.get(task.id)?.requirementId ?? task.requirementId;
            void this.startRequirementGeneration(requirementId).catch(error =>
                console.warn('[Poiesis] Could not finish pending Requirement Results.', error)
            );
            return Promise.resolve();
        }
        const current = this.generationPromises.get(task.id);
        if (current && this.generationTokens.has(task.id)) {
            return current;
        }
        void this.requirementClassificationService.suggestTitle(task.id).catch(error =>
            console.warn('[Poiesis][Requirement title] Suggestion failed unexpectedly.', error)
        );
        const generation = this.generateTask(task).then(() => {
            void this.recordPendingSkillProposals(task).catch(error =>
                console.warn('[Poiesis] Could not record pending Skill proposals.', error)
            );
            void this.requirementClassificationService.classify(task.id)
                .catch(error =>
                    console.warn('[Poiesis][Requirement classification] Classification failed unexpectedly.', error)
                ).finally(() => {
                    const requirementId = this.taskService.get(task.id)?.requirementId ?? task.requirementId;
                    void this.startRequirementGeneration(requirementId).catch(error =>
                        console.warn('[Poiesis] Could not generate Requirement Results in the background.', error)
                    );
                });
        }).finally(() => {
            if (this.generationPromises.get(task.id) === generation) {
                this.generationPromises.delete(task.id);
            }
        });
        this.generationPromises.set(task.id, generation);
        return generation;
    }

    protected async recordPendingSkillProposals(task: ExecutionTask): Promise<void> {
        if (!task.workspaceUri) {
            this.taskService.setSkillProposals(task.id, []);
            return;
        }
        const proposals = await this.workspaceSkillService.listPending(new URI(task.workspaceUri));
        this.taskService.setSkillProposals(task.id, proposals.map(proposal => proposal.id));
    }

    protected async generateTask(task: ExecutionTask): Promise<void> {
        if (!this.shouldGenerate(task)) {
            return;
        }
        const changeSet = task.changeSet!;
        const generationToken = ++this.generationSequence;
        const generationStartedAt = Date.now();
        const previousDocument = this.get(task.id);
        this.generationTokens.set(task.id, generationToken);
        if (!hasReadableResultDocument(previousDocument)) {
            this.set({ taskId: task.id, status: 'generating' }, task);
        }
        try {
            const generated = await this.resultsSkill.generate({ task, changeSet });
            if (this.generationTokens.get(task.id) !== generationToken) {
                return;
            }
            if (!/^(?:<!doctype\s+html[^>]*>\s*)?<html[\s>]/i.test(generated.html.trim())) {
                throw new Error('Results skill did not return one complete HTML document.');
            }
            this.set({
                taskId: task.id,
                status: 'ready',
                ...generated,
                generatedAt: new Date().toISOString(),
                durationMs: Math.max(0, Date.now() - generationStartedAt)
            }, task);
        } catch (error) {
            if (this.generationTokens.get(task.id) !== generationToken) {
                return;
            }
            if (hasReadableResultDocument(previousDocument)) {
                this.set({
                    ...previousDocument!,
                    status: 'ready',
                    updateError: ResultsService.UPDATE_ERROR
                }, task);
            } else {
                this.set({
                    taskId: task.id,
                    status: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                    generatedAt: new Date().toISOString(),
                    durationMs: Math.max(0, Date.now() - generationStartedAt)
                }, task);
            }
        } finally {
            if (this.generationTokens.get(task.id) === generationToken) {
                this.generationTokens.delete(task.id);
            }
        }
    }

    protected startRequirementGeneration(requirementId: string, force = false): Promise<void> {
        const requirement = this.requirementService.get(requirementId);
        if (!requirement) {
            this.requestedRequirementVersions.delete(requirementId);
            this.appliedRequirementVersions.delete(requirementId);
            this.attemptedRequirementVersions.delete(requirementId);
            return Promise.resolve();
        }
        const attachedTasks = requirement.taskIds.map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => Boolean(task));
        if (attachedTasks.some(task => task.status === 'running')) {
            return this.requirementGenerationPromises.get(requirementId) ?? Promise.resolve();
        }
        const requestedVersion = this.requirementOutcomeVersion(requirement);
        if (!requestedVersion) {
            return this.requirementGenerationPromises.get(requirementId) ?? Promise.resolve();
        }
        this.requestedRequirementVersions.set(requirementId, requestedVersion);
        if (force) {
            this.appliedRequirementVersions.delete(requirementId);
        }
        const current = this.requirementGenerationPromises.get(requirementId);
        if (current) {
            return current;
        }
        if (!force && requestedVersion === this.attemptedRequirementVersions.get(requirementId)) {
            return Promise.resolve();
        }
        const generation = this.drainRequirementGenerations(requirementId).finally(() => {
            if (this.requirementGenerationPromises.get(requirementId) === generation) {
                this.requirementGenerationPromises.delete(requirementId);
            }
            if (this.requestedRequirementVersions.get(requirementId)
                !== this.attemptedRequirementVersions.get(requirementId)
                && this.requestedRequirementVersions.get(requirementId)
                    !== this.appliedRequirementVersions.get(requirementId)) {
                void this.startRequirementGeneration(requirementId).catch(error =>
                    console.warn('[Poiesis] Could not generate the newest Requirement Results.', error)
                );
            }
        });
        this.requirementGenerationPromises.set(requirementId, generation);
        return generation;
    }

    protected async drainRequirementGenerations(requirementId: string): Promise<void> {
        while (true) {
            const requestedVersion = this.requestedRequirementVersions.get(requirementId);
            if (!requestedVersion || requestedVersion === this.appliedRequirementVersions.get(requirementId)) {
                return;
            }
            this.attemptedRequirementVersions.set(requirementId, requestedVersion);
            const applied = await this.generateRequirement(requirementId, requestedVersion);
            if (applied) {
                this.appliedRequirementVersions.set(requirementId, requestedVersion);
            }
            const latestVersion = this.requestedRequirementVersions.get(requirementId);
            if (latestVersion === requestedVersion) {
                return;
            }
        }
    }

    protected async generateRequirement(requirementId: string, requestedVersion: string): Promise<boolean> {
        const requirement = this.requirementService.get(requirementId);
        if (!requirement || !this.requirementGenerationIsCurrent(requirement, requestedVersion)) {
            return false;
        }
        const tasks = this.finishedRequirementTasks(requirement);
        if (!tasks.length || tasks.some(task => !task.changeSet)) {
            return false;
        }
        if (tasks.length === 1) {
            const document = this.get(tasks[0].id);
            if (document && this.requirementGenerationIsCurrent(requirement, requestedVersion)) {
                this.requirementService.setResultsDocument(requirement.id, { ...document, sourceVersion: requestedVersion });
                this.requirementChangeSets.set(requirement.id, tasks[0].changeSet!);
                this.onDidChangeEmitter.fire(document);
                return true;
            }
            return false;
        }

        const latestTask = tasks.at(-1)!;
        const documentId = this.requirementDocumentId(requirement.id);
        const generationToken = ++this.generationSequence;
        const generationStartedAt = Date.now();
        const previousDocument = requirement.resultsDocument;
        this.generationTokens.set(documentId, generationToken);
        if (!hasReadableResultDocument(previousDocument)) {
            this.setRequirementDocument(requirement, { taskId: documentId, status: 'generating' });
        }
        try {
            const changeSet = await this.cumulativeChangeSet(requirement);
            const generated = await this.resultsSkill.generate({
                task: latestTask,
                changeSet,
                documentId,
                requirement: { id: requirement.id, title: requirement.title, tasks }
            });
            if (this.generationTokens.get(documentId) !== generationToken
                || !this.requirementGenerationIsCurrent(requirement, requestedVersion)) {
                return false;
            }
            if (!/^(?:<!doctype\s+html[^>]*>\s*)?<html[\s>]/i.test(generated.html.trim())) {
                throw new Error('Results skill did not return one complete HTML document.');
            }
            this.setRequirementDocument(requirement, {
                taskId: documentId,
                status: 'ready',
                ...generated,
                generatedAt: new Date().toISOString(),
                sourceVersion: requestedVersion,
                durationMs: Math.max(0, Date.now() - generationStartedAt)
            });
            return true;
        } catch (error) {
            if (this.generationTokens.get(documentId) !== generationToken
                || !this.requirementGenerationIsCurrent(requirement, requestedVersion)) {
                return false;
            }
            if (hasReadableResultDocument(previousDocument)) {
                this.setRequirementDocument(requirement, {
                    ...previousDocument!,
                    status: 'ready',
                    updateError: ResultsService.UPDATE_ERROR
                });
            } else {
                this.setRequirementDocument(requirement, {
                    taskId: documentId,
                    status: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                    generatedAt: new Date().toISOString(),
                    durationMs: Math.max(0, Date.now() - generationStartedAt)
                });
            }
            return false;
        } finally {
            if (this.generationTokens.get(documentId) === generationToken) {
                this.generationTokens.delete(documentId);
            }
        }
    }

    protected restoredRequirementDocumentIsCurrent(requirement: Requirement, version: string): boolean {
        const document = requirement.resultsDocument;
        if (document?.sourceVersion !== undefined) {
            return document.sourceVersion === version;
        }
        // Legacy aggregate timestamps can prove coverage; a copied single-task document cannot.
        if (document?.taskId !== this.requirementDocumentId(requirement.id)) {
            return false;
        }
        const generatedAt = Date.parse(document.generatedAt ?? '');
        return Number.isFinite(generatedAt) && this.finishedRequirementTasks(requirement).every(task =>
            [task.endedAt, task.changeSet?.capturedAt, task.resultsDocument?.generatedAt]
                .every(timestamp => {
                    const time = Date.parse(timestamp ?? '');
                    return Number.isFinite(time) && time <= generatedAt;
                })
        );
    }

    protected requirementOutcomeVersion(requirement: Requirement): string {
        return this.finishedRequirementTasks(requirement).map(task => [
            task.id,
            task.endedAt ?? '',
            task.outcomeKind ?? 'legacy',
            task.changeSet?.capturedAt ?? '',
            task.resultsDocument?.status ?? '',
            task.resultsDocument?.generatedAt ?? ''
        ].join(':')).join('|');
    }

    protected requirementGenerationIsCurrent(requirement: Requirement, requestedVersion: string): boolean {
        const current = this.requirementService.get(requirement.id);
        if (!current || this.requestedRequirementVersions.get(requirement.id) !== requestedVersion) {
            return false;
        }
        const attachedTasks = current.taskIds.map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => Boolean(task));
        return !attachedTasks.some(task => task.status === 'running')
            && this.requirementOutcomeVersion(current) === requestedVersion;
    }

    protected async cumulativeChangeSet(requirement: Requirement): Promise<TaskChangeSet> {
        const tasks = this.finishedRequirementTasks(requirement);
        const first = tasks[0];
        const last = tasks.at(-1);
        const paths = [...new Set(tasks.flatMap(task => task.changeSet?.files ?? []))].sort();
        const unavailableReasons = [...new Set(tasks
            .map(task => task.changeSet?.error?.trim())
            .filter((error): error is string => Boolean(error)))];
        let unavailableReason = unavailableReasons.join(' / ') || undefined;
        if (!unavailableReason && first?.baselineSnapshotId && last?.endSnapshotId) {
            try {
                const capture = await this.runtimeServer.captureGitChangeSetBetween({
                    fromSnapshotId: first.baselineSnapshotId,
                    toSnapshotId: last.endSnapshotId,
                    paths
                });
                if (!capture.error) {
                    const changeSet: TaskChangeSet = {
                        source: capture.source,
                        diff: capture.diff,
                        files: capture.files,
                        capturedAt: new Date().toISOString()
                    };
                    this.requirementChangeSets.set(requirement.id, changeSet);
                    return changeSet;
                }
                unavailableReason = capture.error;
            } catch {
                unavailableReason = '変更内容をまとめて確認できませんでした。';
                // Legacy concatenation below keeps Results available when the durable store is missing.
            }
        }
        const diffs = tasks.flatMap((task, index) => task.changeSet?.diff
            ? [`### Task ${index + 1}: ${task.title}\n${task.changeSet.diff}`]
            : []);
        const note = '[Legacy snapshot note: cumulative range was unavailable; per-task diffs follow.]';
        const changeSet: TaskChangeSet = {
            source: diffs.length ? 'task-diff' : 'empty',
            diff: diffs.length ? `${note}\n\n${diffs.join('\n\n')}` : '',
            files: paths,
            capturedAt: new Date().toISOString(),
            error: unavailableReason
        };
        this.requirementChangeSets.set(requirement.id, changeSet);
        return changeSet;
    }

    protected finishedRequirementTasks(requirement: Requirement): ExecutionTask[] {
        return requirement.taskIds
            .map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => Boolean(task && task.changeSet && taskProducesResult(task)))
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    }

    protected requirementDocumentId(requirementId: string): string {
        return `requirement:${requirementId}`;
    }

    protected set(document: TaskResultDocument, task?: ExecutionTask): void {
        this.documents.set(document.taskId, document);
        if (task) {
            task.resultsDocument = document;
        }
        if (this.taskService.get(document.taskId)?.status !== 'running') {
            this.taskService.setResultsDocument(document.taskId, document);
        }
        this.onDidChangeEmitter.fire(document);
    }

    protected setRequirementDocument(requirement: Requirement, document: TaskResultDocument): void {
        this.requirementService.setResultsDocument(requirement.id, document);
        this.onDidChangeEmitter.fire(document);
    }

    protected shouldGenerate(task: ExecutionTask): boolean {
        return Boolean(task.changeSet) && taskProducesResult(task);
    }
}
