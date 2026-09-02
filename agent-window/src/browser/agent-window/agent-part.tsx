import * as React from '@theia/core/shared/react';
import * as ReactDOM from '@theia/core/shared/react-dom';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { FormatType, open, OpenerService, Saveable, SaveableService, SaveReason, StorageService, WidgetManager } from '@theia/core/lib/browser';
import { IconThemeService } from '@theia/core/lib/browser/icon-theme-service';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { CommandService, Disposable, DisposableCollection, MessageService } from '@theia/core/lib/common';
import { FileUri } from '@theia/core/lib/common/file-uri';
import URI from '@theia/core/lib/common/uri';
import { Message, MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { EditorManager, EditorWidget } from '@theia/editor/lib/browser';
import { ScmCommand, ScmHistoryProvider, ScmProvider } from '@theia/scm/lib/browser/scm-provider';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { FileNavigatorCommands } from '@theia/navigator/lib/browser/navigator-contribution';
import { SearchInWorkspaceCommands } from '@theia/search-in-workspace/lib/browser/search-in-workspace-frontend-contribution';
import { BUILTIN_QUERY, VSXExtensionsSearchModel } from '@theia/vsx-registry/lib/browser/vsx-extensions-search-model';
import { AgentActivity, AgentActivityKind, AgentEvent, AgentProvider, AgentSession } from '../../common/agent-provider';
import {
    AgentRuntimeServer,
    AiRole,
    CliDetectionReport,
    DEFAULT_CLI_ID,
    FolderBrowserResult,
    isKnownCliId,
    KnownCliId
} from '../../common/agent-runtime-protocol';
import { formatRequirementExecutionEvidence, ResultsService } from '../results-skill';
import {
    ExecutionTask,
    formatTaskEndedAtJst,
    summarizeTaskChangeSet,
    TaskChangeSet,
    TaskResultDocument,
    TaskResultsQuestion,
    TaskService,
    taskTitleForRequest
} from '../task-service';
import { getDesignVariant } from '../design-variant';
import { FolderExplorerService } from '../folder-explorer-service';
import { ResultsQuestionService } from '../results-question-service';
import { GlobalStorageService } from '../global-storage-service';
import { ResultsGenerationContext } from '../results-generation-context';
import { SkillBundleKind } from '../../common/skill-bundle';
import {
    collectWorkspaceRichContentReferences,
    POIESIS_EXTERNAL_LINK_ATTRIBUTE,
    POIESIS_FILE_LINK_ATTRIBUTE,
    POIESIS_INLINE_IMAGE_ATTRIBUTE,
    renderSafeMarkdown
} from '../safe-markdown';
import {
    PendingSkillProposal,
    WorkspaceSkillDefinition,
    WorkspaceSkillDiscoveryRoot,
    WorkspaceSkillPreview,
    WorkspaceSkillService,
    WorkspaceSkillSource
} from '../workspace-skill-service';
import { diffTextLines } from '../text-diff';
import { formatTaskElapsedTime, shouldSubmitComposer } from '../composer-behavior';
import { POIESIS_FONT_MONO, POIESIS_FONT_SANS } from '../typography';
import { formatExecutionEvidence } from '../results-document-normalizer';
import { Requirement } from '../requirement-model';
import { RequirementService } from '../requirement-service';
import { RequirementClassificationService } from '../requirement-classification-service';
import { PoiesisSelect, PoiesisSelectOption } from '../components/poiesis-select';
import { PoiesisTextArea, PoiesisTextInput } from '../components/poiesis-inputs';
import { PoiesisComposer } from '../components/poiesis-composer';
import { PoiesisResultsElapsed, PoiesisTaskElapsed } from '../components/elapsed';
import { AgentWindowTab, ChatMessage, ResultsNotice, SessionStore, WindowAgentSession } from '../agent-window/session-store';
import { AgentWindowHost, AgentWindowPart } from './agent-window-host';

interface AgentHtmlPreview {
    uri: string;
    fileName: string;
    html: string;
    revision: number;
}

interface AgentRichContentState {
    signature: string;
    workspaceUri: string;
    imageSources: Map<string, string>;
    htmlPreviews: AgentHtmlPreview[];
}

const MAX_AGENT_ACTIVITIES_PER_MESSAGE = 300;

export class AgentPart extends AgentWindowPart {
    protected readonly providerPreparationErrors = new Map<string, string>();

    protected readonly agentRichContent = new Map<string, AgentRichContentState>();

    protected readonly agentRichContentPending = new Map<string, string>();

    protected readonly agentHtmlPreviewExpanded = new Map<string, boolean>();

    protected readonly agentActivityExpanded = new Set<string>();

    protected agentComposerInput?: HTMLTextAreaElement;

    protected renderAgent(session: WindowAgentSession | undefined, runningTask?: ExecutionTask): React.ReactNode {
        const newAgent = Boolean(session && !session.hasUserMessage);
        const latestAgentMessageId = [...(session?.messages ?? [])].reverse()
            .find(message => message.role === 'agent')?.id;
        return (
            <section
                id={session?.hasUserMessage ? 'poiesis-agent-panel' : undefined}
                className='poiesis-agent-window__agent'
                role={session?.hasUserMessage ? 'tabpanel' : undefined}
                aria-labelledby={session?.hasUserMessage ? 'poiesis-agent-tab' : undefined}
                aria-label={session?.hasUserMessage ? undefined : 'Agent の会話'}
            >
                <div className='poiesis-agent-window__messages' aria-live='polite'>
                    <div className='poiesis-agent-window__messages-inner'>
                        {newAgent && session?.messages.length === 0 && (
                            <div className='poiesis-agent-window__new-agent-empty'>
                                <span className='codicon codicon-comment-add' aria-hidden='true' />
                                <strong>何を作りますか?</strong>
                                <small>Repository と branch を確認して、Agent へ依頼します</small>
                            </div>
                        )}
                        {(session?.messages ?? []).map(message => (
                            <section
                                key={message.id}
                                aria-label={message.role === 'user' ? 'あなたのメッセージ' : 'Agent のメッセージ'}
                                className={message.role === 'user'
                                    ? 'poiesis-agent-window__user-message'
                                    : 'poiesis-agent-window__message'}
                            >
                                {message.role === 'agent' && this.renderAgentActivities(session, message)}
                                {message.error ? (
                                    <div className='poiesis-agent-window__message-error' role='alert'>
                                        <strong>{message.content}</strong>
                                        {message.errorDetails && (
                                            <details>
                                                <summary>詳細</summary>
                                                <pre>{message.errorDetails}</pre>
                                            </details>
                                        )}
                                        {message.taskId && (
                                            <button type='button' onClick={() => void this.retryTask(message.taskId!)}>再試行</button>
                                        )}
                                    </div>
                                ) : message.role === 'agent'
                                    ? this.renderAgentMessage(session, message, message.id === latestAgentMessageId)
                                    : <p>{message.content || '…'}</p>}
                                {!message.complete && runningTask && runningTask.id === message.taskId && (
                                    <small className='poiesis-agent-window__message-state'>
                                        <PoiesisTaskElapsed startedAt={runningTask.startedAt} />
                                    </small>
                                )}
                            </section>
                        ))}
                    </div>
                </div>
                {runningTask && (
                    <div className='poiesis-agent-window__task-state' role='status'>
                        <span>{this.taskService.isFinalizing(runningTask.id) ? '成果を作成中' : 'タスクを実行中'} · {runningTask.title}</span>
                        {!this.taskService.isFinalizing(runningTask.id) && (
                            <button type='button' onClick={() => void this.cancelRun()}>
                                キャンセル
                            </button>
                        )}
                    </div>
                )}
                <section className='poiesis-agent-window__composer' aria-label='Agent の入力欄'>
                    <PoiesisComposer
                        key={session?.id ?? 'no-session'}
                        elementRef={input => { this.agentComposerInput = input ?? undefined; }}
                        value={session?.agentDraft ?? ''}
                        placeholder='次の変更内容や質問を入力…'
                        aria-label='Agent へのメッセージ'
                        rows={2}
                        disabled={!session}
                        onValueChange={value => this.setAgentDraft(session?.id, value)}
                        onSubmit={() => {
                            if (!runningTask) {
                                void this.sendAgentMessage();
                            }
                        }}
                    />
                    <div className='poiesis-agent-window__composer-footer'>
                        {session && newAgent && this.renderNewAgentContext(session)}
                        {session && !newAgent && this.renderAiRolePill('agent')}
                        {session && this.renderRequirementPill(session)}
                        <button
                            className='poiesis-agent-window__send'
                            type='button'
                            aria-label='Agent へ送信'
                            title={runningTask ? 'タスクの実行中は送信できません' : undefined}
                            disabled={!session?.workspaceUri || Boolean(runningTask) || !session.agentDraft.trim()}
                            onClick={() => void this.sendAgentMessage()}
                        >
                            <span className='codicon codicon-arrow-up' aria-hidden='true' />
                        </button>
                    </div>
                </section>
            </section>
        );
    }

    protected renderRequirementPill(session: WindowAgentSession): React.ReactNode {
        const requirements = this.requirementsForSession(session);
        const currentId = this.requirementService.currentRequirementId(session.id);
        const selected = session.requirementDraft && (session.requirementDraft === 'new'
            || requirements.some(requirement => requirement.id === session.requirementDraft))
            ? session.requirementDraft
            : currentId ?? 'new';
        const options: PoiesisSelectOption[] = [
            {
                value: 'new',
                label: '新しい要件として送信',
                triggerLabel: '要件: 新規',
                group: '新規'
            },
            ...requirements.map(requirement => ({
                value: requirement.id,
                label: `${requirement.title}（タスク ${requirement.taskIds.length}件）`,
                triggerLabel: `要件: ${requirement.title}`,
                group: 'このセッションの要件'
            }))
        ];
        return (
            <div className='poiesis-requirement-pill'>
                <PoiesisSelect
                    value={selected}
                    options={options}
                    ariaLabel='送信先の要件'
                    popoverClassName='poiesis-requirement-pill__popover'
                    popoverMinWidth={280}
                    leadingIconClass='codicon-tag'
                    onChange={value => {
                        session.requirementDraft = value === 'new' ? 'new' : value;
                        session.requirementDraftExplicit = true;
                        void this.persistWindowState();
                        this.update();
                    }}
                />
            </div>
        );
    }

    protected renderNewAgentContext(session: WindowAgentSession): React.ReactNode {
        const branch = session.branch ?? this.gitBranchForWorkspace(session.workspaceUri) ?? 'main';
        return (
            <div className='poiesis-agent-window__new-agent-context'>
                <button
                    type='button'
                    className='poiesis-agent-window__context-pill primary'
                    aria-expanded={this.repositoryPickerVisible}
                    aria-controls='poiesis-agent-window-repository-picker'
                    onClick={event => this.toggleRepositoryPicker(event.currentTarget)}
                >
                    <span className='codicon codicon-folder' aria-hidden='true' />
                    <span>{this.repositoryLabel(session.workspaceUri)}</span>
                    <span className='codicon codicon-chevron-down' aria-hidden='true' />
                </button>
                <span className='poiesis-agent-window__context-pill static' title='現在のローカルブランチ'>
                    <span className='codicon codicon-git-branch' aria-hidden='true' />
                    <span>{branch}</span>
                </span>
                {this.renderAiRolePill('agent')}
            </div>
        );
    }

    protected renderAgentMessage(
        session: WindowAgentSession | undefined,
        message: ChatMessage,
        isMostRecentAgentMessage: boolean
    ): React.ReactNode {
        const workspaceUri = session?.workspaceUri ?? this.workspaceRoot()?.resource.toString();
        const messageKey = `${session?.id ?? 'workspace'}:${message.id}`;
        const signature = `${workspaceUri ?? ''}\0${message.content}`;
        const richContent = this.agentRichContent.get(messageKey);
        if (message.complete && workspaceUri && richContent?.signature !== signature
            && this.agentRichContentPending.get(messageKey) !== signature) {
            this.agentRichContentPending.set(messageKey, signature);
            queueMicrotask(() => void this.prepareAgentRichContent(messageKey, signature, message.content, workspaceUri));
        }
        const current = richContent?.signature === signature ? richContent : undefined;
        const task = message.taskId ? this.taskService.get(message.taskId) : undefined;
        const showResultsAction = message.complete
            && task?.status === 'completed'
            && task.changeSet?.source === 'task-diff'
            && task.changeSet.files.length > 0;
        const skillProposalCount = message.complete && task?.status === 'completed'
            ? task.skillProposals?.length ?? 0
            : 0;
        return (
            <>
                {this.renderMarkdown(message.content, current?.imageSources, workspaceUri)}
                {current?.htmlPreviews.map((preview, index) =>
                    this.renderAgentHtmlPreview(messageKey, preview, index, isMostRecentAgentMessage))}
                {(showResultsAction || skillProposalCount > 0) && (
                    <div className='poiesis-agent-window__message-actions'>
                        {showResultsAction && (
                            <button
                                type='button'
                                onClick={() => {
                                    this.selectResultsTask(task.id);
                                    this.selectResultsRequirement(task.requirementId);
                                    this.selectTab('results');
                                }}
                            >
                                Results で確認
                            </button>
                        )}
                        {skillProposalCount > 0 && (
                            <span className='poiesis-agent-window__skill-proposal-notice'>
                                <span>Skill の提案が {skillProposalCount}件あります</span>
                                <button type='button' onClick={() => this.openCustomize()}>カスタマイズで確認</button>
                            </span>
                        )}
                    </div>
                )}
                {task && this.renderAutomaticRequirementClassification(task)}
            </>
        );
    }

    protected renderAutomaticRequirementClassification(task: ExecutionTask): React.ReactNode {
        const classification = task.requirementClassification;
        if (classification?.decision !== 'new'
            || classification.source !== 'ai'
            || !classification.appliedNewRequirementId) {
            return undefined;
        }
        if (classification.undone) {
            return (
                <div className='poiesis-agent-window__requirement-classification undone'>
                    元の要件に戻しました
                </div>
            );
        }
        const title = this.requirementService.get(classification.appliedNewRequirementId)?.title ?? task.title;
        return (
            <div className='poiesis-agent-window__requirement-classification'>
                <span>新しい要件「{title}」として分けました</span>
                <span aria-hidden='true'>·</span>
                <button type='button' onClick={() => this.undoAutomaticRequirementSplit(task.id)}>戻す</button>
            </div>
        );
    }

    protected renderAgentActivities(session: WindowAgentSession | undefined, message: ChatMessage): React.ReactNode {
        const task = message.taskId ? this.taskService.get(message.taskId) : undefined;
        const finalReports = new Set([
            message.complete ? this.normalizeActivityComparison(message.content) : '',
            message.complete ? this.normalizeActivityComparison(task?.implementerReport ?? '') : ''
        ].filter(Boolean));
        const activities = (task ? task.activities ?? [] : message.activities ?? []).filter(activity =>
            activity.kind !== 'message'
            || !activity.detail
            || !finalReports.has(this.normalizeActivityComparison(activity.detail))
        );
        if (!activities.length) {
            return undefined;
        }
        const messageKey = `${session?.id ?? 'workspace'}:${message.id}`;
        const expanded = this.agentActivityExpanded.has(messageKey);
        const finished = task ? task.status !== 'running' : message.complete;
        if (finished) {
            const commandCount = activities.filter(activity => activity.kind === 'command').length;
            const fileChangeCount = activities.filter(activity => activity.kind === 'file-change').length;
            return (
                <div className={`poiesis-agent-activity${expanded ? ' expanded' : ' collapsed'}`}>
                    <button
                        type='button'
                        className='poiesis-agent-activity__summary'
                        aria-expanded={expanded}
                        onClick={() => this.toggleAgentActivity(messageKey)}
                    >
                        <span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} aria-hidden='true' />
                        <span>
                            作業ログ {activities.length}件 · コマンド {commandCount} · ファイル変更 {fileChangeCount}
                        </span>
                    </button>
                    {expanded && (
                        <div className='poiesis-agent-activity__rows'>
                            {activities.map(activity => this.renderAgentActivityRow(activity))}
                        </div>
                    )}
                </div>
            );
        }
        const visibleActivities = expanded ? activities : activities.slice(-8);
        return (
            <div className='poiesis-agent-activity'>
                <div className='poiesis-agent-activity__header'>
                    <strong>作業ログ · {activities.length}件</strong>
                    {activities.length > 8 && (
                        <button
                            type='button'
                            aria-expanded={expanded}
                            onClick={() => this.toggleAgentActivity(messageKey)}
                        >
                            {expanded ? '折りたたむ' : 'すべて表示'}
                        </button>
                    )}
                </div>
                <div className='poiesis-agent-activity__rows'>
                    {visibleActivities.map(activity => this.renderAgentActivityRow(activity))}
                </div>
            </div>
        );
    }

    protected normalizeActivityComparison(value: string): string {
        return value.replace(/\s+/g, ' ').trim();
    }

    protected renderAgentActivityRow(activity: AgentActivity): React.ReactNode {
        const icon = this.agentActivityIcon(activity);
        const statusIcon = activity.status === 'running'
            ? 'codicon-loading codicon-modifier-spin'
            : activity.status === 'failed' ? 'codicon-error' : 'codicon-check';
        const statusLabel = activity.status === 'running'
            ? '実行中'
            : activity.status === 'failed' ? '失敗' : '完了';
        return (
            <div
                key={activity.id}
                className={`poiesis-agent-activity__row poiesis-agent-activity__row--${activity.kind}`}
            >
                <span className={`codicon ${icon}`} aria-hidden='true' />
                <strong>{activity.title}</strong>
                {activity.kind === 'message'
                    ? <p className='poiesis-agent-activity__message-detail' title={activity.detail}>{activity.detail}</p>
                    : <span className='poiesis-agent-activity__detail' title={activity.detail}>{activity.detail}</span>}
                <span
                    className={`poiesis-agent-activity__status poiesis-agent-activity__status--${activity.status} codicon ${statusIcon}`}
                    aria-label={statusLabel}
                    title={statusLabel}
                />
            </div>
        );
    }

    protected agentActivityIcon(activity: AgentActivity): string {
        if (activity.kind === 'command') {
            return 'codicon-terminal';
        }
        if (activity.kind === 'file-change') {
            return 'codicon-edit';
        }
        if (activity.kind === 'read') {
            return activity.title === '検索' ? 'codicon-search' : 'codicon-file';
        }
        if (activity.kind === 'reasoning') {
            return 'codicon-lightbulb';
        }
        if (activity.kind === 'message') {
            return 'codicon-comment';
        }
        return 'codicon-tools';
    }

    protected toggleAgentActivity(messageKey: string): void {
        if (this.agentActivityExpanded.has(messageKey)) {
            this.agentActivityExpanded.delete(messageKey);
        } else {
            this.agentActivityExpanded.add(messageKey);
        }
        this.update();
    }

    protected renderMarkdown(
        content: string,
        workspaceImageSources?: ReadonlyMap<string, string>,
        explicitWorkspaceUri?: string
    ): React.ReactNode {
        const workspaceUri = explicitWorkspaceUri ?? this.workspaceRoot()?.resource.toString();
        return (
            <div
                className='poiesis-markdown'
                onClick={event => this.handleMarkdownClick(event)}
                onErrorCapture={event => this.handleMarkdownImageError(event)}
                dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(content, workspaceUri, workspaceImageSources) }}
            />
        );
    }

    protected renderAgentHtmlPreview(
        messageKey: string,
        preview: AgentHtmlPreview,
        index: number,
        isMostRecentAgentMessage: boolean
    ): React.ReactNode {
        const previewKey = `${messageKey}:${preview.uri}`;
        const expanded = this.agentHtmlPreviewExpanded.get(previewKey) ?? (isMostRecentAgentMessage && index === 0);
        return (
            <section className={`poiesis-agent-html-preview${expanded ? ' expanded' : ' collapsed'}`} key={preview.uri}>
                <header className='poiesis-agent-html-preview__header'>
                    <button
                        type='button'
                        className='poiesis-agent-html-preview__toggle'
                        aria-expanded={expanded}
                        aria-label={`${preview.fileName} のプレビューを${expanded ? 'たたむ' : '展開'}`}
                        onClick={() => {
                            this.agentHtmlPreviewExpanded.set(previewKey, !expanded);
                            this.update();
                        }}
                    >
                        <span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} aria-hidden='true' />
                        <strong>{preview.fileName}</strong>
                    </button>
                    <div className='poiesis-agent-html-preview__actions'>
                        <button
                            type='button'
                            title='プレビューを再読み込み'
                            aria-label={`${preview.fileName} のプレビューを再読み込み`}
                            onClick={() => void this.reloadAgentHtmlPreview(messageKey, preview.uri)}
                        >
                            <span className='codicon codicon-refresh' aria-hidden='true' />
                        </button>
                        <button
                            type='button'
                            className='poiesis-agent-html-preview__open-code'
                            aria-label={`${preview.fileName} を Code で開く`}
                            onClick={() => void this.openMarkdownFile(preview.uri)}
                        >
                            Code で開く
                        </button>
                    </div>
                </header>
                {expanded && (
                    <iframe
                        key={`${preview.uri}:${preview.revision}`}
                        className='poiesis-agent-html-preview__frame'
                        title={`${preview.fileName} のHTMLプレビュー`}
                        sandbox='allow-scripts'
                        referrerPolicy='no-referrer'
                        srcDoc={this.agentHtmlPreviewDocument(preview.html)}
                    />
                )}
            </section>
        );
    }

    protected async prepareAgentRichContent(
        messageKey: string,
        signature: string,
        content: string,
        workspaceUri: string
    ): Promise<void> {
        const references = collectWorkspaceRichContentReferences(content, workspaceUri);
        const workspace = new URI(workspaceUri).normalizePath();
        const imageSources = new Map<string, string>();
        const htmlPreviews: AgentHtmlPreview[] = [];
        await Promise.all(references.imageUris.map(async file => {
            try {
                const stat = await this.fileService.resolve(file);
                if (!stat.isFile || !workspace.isEqualOrParent(file, false)) {
                    return;
                }
                const contentResult = await this.fileService.readFile(file);
                const blob = new Blob([contentResult.value.buffer as BlobPart], { type: this.agentImageMimeType(file) });
                imageSources.set(file.toString(), URL.createObjectURL(blob));
            } catch {
                // Missing and unreadable image targets stay as ordinary file links.
            }
        }));
        for (const file of references.htmlUris) {
            const preview = await this.readAgentHtmlPreview(file, workspace);
            if (preview) {
                htmlPreviews.push(preview);
            }
        }
        if (this.agentRichContentPending.get(messageKey) !== signature) {
            this.revokeAgentImageSources(imageSources);
            return;
        }
        const previous = this.agentRichContent.get(messageKey);
        if (previous) {
            this.revokeAgentImageSources(previous.imageSources);
        }
        this.agentRichContent.set(messageKey, { signature, workspaceUri, imageSources, htmlPreviews });
        this.agentRichContentPending.delete(messageKey);
        this.update();
    }

    protected async readAgentHtmlPreview(file: URI, workspace: URI): Promise<AgentHtmlPreview | undefined> {
        try {
            const normalized = file.withQuery('').withFragment('').normalizePath();
            if (!workspace.isEqualOrParent(normalized, false) || !/\.html?$/i.test(normalized.path.base)) {
                return undefined;
            }
            if (!await this.isAgentHtmlPreviewWorkspaceFile(normalized, workspace)) {
                return undefined;
            }
            const content = await this.fileService.readFile(normalized);
            return {
                uri: normalized.toString(),
                fileName: normalized.path.base,
                html: await this.inlineAgentHtmlPreviewAssets(content.value.toString(), normalized, workspace),
                revision: Date.now()
            };
        } catch {
            return undefined;
        }
    }

    protected async reloadAgentHtmlPreview(messageKey: string, rawUri: string): Promise<void> {
        const current = this.agentRichContent.get(messageKey);
        if (!current) {
            return;
        }
        const workspace = new URI(current.workspaceUri).normalizePath();
        const preview = await this.readAgentHtmlPreview(new URI(rawUri), workspace);
        if (!preview || this.agentRichContent.get(messageKey) !== current) {
            this.messageService.error('HTMLプレビューを再読み込みできませんでした。');
            return;
        }
        current.htmlPreviews = current.htmlPreviews.map(item => item.uri === preview.uri ? preview : item);
        this.update();
    }

    protected async inlineAgentHtmlPreviewAssets(html: string, sourceFile: URI, workspace: URI): Promise<string> {
        const document = new DOMParser().parseFromString(html, 'text/html');
        const baseDirectory = sourceFile.parent;
        const verifiedFiles = new Map<string, Promise<boolean>>();
        const imageSources = new Map<string, Promise<string | undefined>>();

        const verifyFile = (file: URI): Promise<boolean> => {
            const key = file.toString();
            const existing = verifiedFiles.get(key);
            if (existing) {
                return existing;
            }
            const pending = this.isAgentHtmlPreviewWorkspaceFile(file, workspace);
            verifiedFiles.set(key, pending);
            return pending;
        };
        const imageSource = async (rawReference: string, relativeTo: URI): Promise<string | undefined> => {
            const trimmed = rawReference.trim();
            if (/^data:image\//i.test(trimmed)) {
                return trimmed;
            }
            const file = this.resolveAgentHtmlPreviewAsset(trimmed, relativeTo, workspace);
            const mimeType = file && this.agentHtmlPreviewImageMimeType(file);
            if (!file || !mimeType) {
                return undefined;
            }
            const key = file.toString();
            const existing = imageSources.get(key);
            if (existing) {
                return existing;
            }
            const pending = (async () => {
                if (!await verifyFile(file)) {
                    return undefined;
                }
                const content = await this.fileService.readFile(file);
                return this.agentHtmlPreviewDataUrl(content.value.buffer as BlobPart, mimeType);
            })().catch(() => undefined);
            imageSources.set(key, pending);
            return pending;
        };
        const rewriteCss = async (css: string, relativeTo: URI): Promise<string> => {
            const withoutImports = css.replace(
                /@import\s+(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)|"[^"]*"|'[^']*')[^;]*;/gi,
                ''
            );
            const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
            const matches = [...withoutImports.matchAll(pattern)];
            let rewritten = '';
            let offset = 0;
            for (const match of matches) {
                const index = match.index ?? offset;
                const reference = match[1] ?? match[2] ?? match[3] ?? '';
                rewritten += withoutImports.slice(offset, index);
                if (reference.trim().startsWith('#')) {
                    rewritten += match[0];
                } else {
                    const source = await imageSource(reference, relativeTo);
                    rewritten += source ? `url("${source}")` : 'none';
                }
                offset = index + match[0].length;
            }
            return `${rewritten}${withoutImports.slice(offset)}`;
        };
        const safeStyleText = (css: string): string => css.replace(/<\/style/gi, '<\\/style');

        for (const base of Array.from(document.querySelectorAll('base'))) {
            base.remove();
        }
        for (const style of Array.from(document.querySelectorAll('style'))) {
            style.textContent = safeStyleText(await rewriteCss(style.textContent ?? '', baseDirectory));
        }
        for (const element of Array.from(document.querySelectorAll<HTMLElement>('[style]'))) {
            element.setAttribute('style', await rewriteCss(element.getAttribute('style') ?? '', baseDirectory));
        }
        for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))) {
            const file = this.resolveAgentHtmlPreviewAsset(link.getAttribute('href') ?? '', baseDirectory, workspace);
            if (!file || file.path.ext.toLocaleLowerCase() !== '.css' || !await verifyFile(file)) {
                link.remove();
                continue;
            }
            try {
                const content = await this.fileService.readFile(file);
                const style = document.createElement('style');
                style.setAttribute('data-poiesis-preview-asset', file.path.base);
                if (link.media) {
                    style.media = link.media;
                }
                style.textContent = safeStyleText(await rewriteCss(content.value.toString(), file.parent));
                link.replaceWith(style);
            } catch {
                link.remove();
            }
        }
        for (const element of Array.from(document.querySelectorAll('img[src], input[type="image"][src], picture source[src], image[href]'))) {
            const source = await imageSource(element.getAttribute('src') ?? element.getAttribute('href') ?? '', baseDirectory);
            const attribute = element.hasAttribute('src') ? 'src' : 'href';
            if (source) {
                element.setAttribute(attribute, source);
                element.setAttribute('data-poiesis-preview-asset', 'inlined');
            } else {
                element.removeAttribute(attribute);
                element.setAttribute('data-poiesis-preview-asset', 'blocked');
            }
        }
        for (const element of Array.from(document.querySelectorAll('[srcset]'))) {
            element.removeAttribute('srcset');
        }

        return `<!doctype html>\n${document.documentElement.outerHTML}`;
    }

    protected resolveAgentHtmlPreviewAsset(rawReference: string, baseDirectory: URI, workspace: URI): URI | undefined {
        const encodedPath = rawReference.trim().split(/[?#]/, 1)[0];
        if (!encodedPath) {
            return undefined;
        }
        let decodedPath: string;
        try {
            decodedPath = decodeURIComponent(encodedPath);
        } catch {
            return undefined;
        }
        if (!decodedPath
            || decodedPath.includes('\0')
            || /^[\\/]/.test(decodedPath)
            || /^[A-Za-z]:[\\/]/.test(decodedPath)
            || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decodedPath)) {
            return undefined;
        }
        const candidate = baseDirectory.resolve(decodedPath.replaceAll('\\', '/')).normalizePath();
        return workspace.isEqualOrParent(candidate, false) ? candidate : undefined;
    }

    protected async isAgentHtmlPreviewWorkspaceFile(file: URI, workspace: URI): Promise<boolean> {
        if (!workspace.isEqualOrParent(file, false)) {
            return false;
        }
        try {
            const fileStat = await this.fileService.resolve(file);
            if (!fileStat.isFile || fileStat.isSymbolicLink) {
                return false;
            }
            let directory = file.parent;
            while (!directory.isEqual(workspace, false)) {
                if (!workspace.isEqualOrParent(directory, false)) {
                    return false;
                }
                const directoryStat = await this.fileService.resolve(directory);
                if (!directoryStat.isDirectory || directoryStat.isSymbolicLink) {
                    return false;
                }
                const parent = directory.parent;
                if (parent.isEqual(directory, false)) {
                    return false;
                }
                directory = parent;
            }
            return true;
        } catch {
            return false;
        }
    }

    protected agentHtmlPreviewImageMimeType(file: URI): string | undefined {
        switch (file.path.ext.toLocaleLowerCase()) {
            case '.png': return 'image/png';
            case '.jpg':
            case '.jpeg': return 'image/jpeg';
            case '.gif': return 'image/gif';
            case '.webp': return 'image/webp';
            case '.svg': return 'image/svg+xml';
            case '.avif': return 'image/avif';
            case '.bmp': return 'image/bmp';
            case '.ico': return 'image/x-icon';
            default: return undefined;
        }
    }

    protected agentHtmlPreviewDataUrl(content: BlobPart, mimeType: string): Promise<string> {
        return new Promise((resolveDataUrl, rejectDataUrl) => {
            const reader = new FileReader();
            reader.addEventListener('load', () => typeof reader.result === 'string'
                ? resolveDataUrl(reader.result)
                : rejectDataUrl(new Error('Preview asset did not produce a data URL.')));
            reader.addEventListener('error', () => rejectDataUrl(reader.error ?? new Error('Preview asset could not be read.')));
            reader.readAsDataURL(new Blob([content], { type: mimeType }));
        });
    }

    protected agentHtmlPreviewDocument(html: string): string {
        const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'">`;
        if (/<head(?:\s[^>]*)?>/i.test(html)) {
            return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n  ${policy}`);
        }
        if (/<html(?:\s[^>]*)?>/i.test(html)) {
            return html.replace(/<html(?:\s[^>]*)?>/i, match => `${match}\n<head>${policy}</head>`);
        }
        return `${policy}\n${html}`;
    }

    protected agentImageMimeType(file: URI): string {
        const extension = file.path.ext.toLocaleLowerCase();
        switch (extension) {
            case '.jpg':
            case '.jpeg': return 'image/jpeg';
            case '.gif': return 'image/gif';
            case '.webp': return 'image/webp';
            case '.svg': return 'image/svg+xml';
            default: return 'image/png';
        }
    }

    protected revokeAgentImageSources(sources: ReadonlyMap<string, string>): void {
        for (const source of sources.values()) {
            URL.revokeObjectURL(source);
        }
    }

    protected disposeAgentRichContentForSession(sessionId: string): void {
        const prefix = `${sessionId}:`;
        for (const [messageKey, content] of this.agentRichContent) {
            if (messageKey.startsWith(prefix)) {
                this.revokeAgentImageSources(content.imageSources);
                this.agentRichContent.delete(messageKey);
            }
        }
        for (const messageKey of this.agentRichContentPending.keys()) {
            if (messageKey.startsWith(prefix)) {
                this.agentRichContentPending.delete(messageKey);
            }
        }
        for (const previewKey of this.agentHtmlPreviewExpanded.keys()) {
            if (previewKey.startsWith(prefix)) {
                this.agentHtmlPreviewExpanded.delete(previewKey);
            }
        }
    }

    protected handleMarkdownImageError(event: React.SyntheticEvent<HTMLElement>): void {
        const image = event.target;
        if (!(image instanceof HTMLImageElement) || !image.hasAttribute(POIESIS_INLINE_IMAGE_ATTRIBUTE)) {
            return;
        }
        const anchor = image.closest(`a[${POIESIS_FILE_LINK_ATTRIBUTE}]`);
        if (!anchor) {
            image.remove();
            return;
        }
        const code = document.createElement('code');
        code.textContent = image.alt || anchor.getAttribute('title') || 'image';
        image.replaceWith(code);
    }

    protected handleMarkdownClick(event: React.MouseEvent<HTMLElement>): void {
        const target = event.target instanceof Element ? event.target.closest('a') : undefined;
        if (!(target instanceof HTMLAnchorElement)) {
            return;
        }
        const fileUri = target.getAttribute(POIESIS_FILE_LINK_ATTRIBUTE);
        const externalUri = target.getAttribute(POIESIS_EXTERNAL_LINK_ATTRIBUTE);
        if (!fileUri && !externalUri) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (fileUri) {
            try {
                const citationSuffix = target.nextSibling?.textContent?.match(/^:(\d+)(?:\s*[-–—]\s*(\d+))?/);
                const citationPath = target.textContent?.trim().replace(/\\/g, '/');
                if (citationSuffix && citationPath && !citationPath.startsWith('/') && !/^[A-Za-z]:/.test(citationPath)) {
                    void this.openResultsCitation(
                        `${citationPath}:${citationSuffix[1]}${citationSuffix[2] ? `-${citationSuffix[2]}` : ''}`
                    );
                } else {
                    void this.openMarkdownFile(decodeURIComponent(fileUri));
                }
            } catch {
                return;
            }
        } else if (externalUri) {
            void open(this.openerService, new URI(externalUri)).catch(error => {
                console.error(`Poiesis could not open the external Agent link: ${externalUri}`, error);
            });
        }
    }

    protected async openMarkdownFile(rawUri: string): Promise<void> {
        try {
            const workspace = this.workspaceRoot()?.resource.normalizePath();
            const file = new URI(rawUri).withQuery('').withFragment('').normalizePath();
            if (!workspace?.isEqualOrParent(file, false) || !await this.fileService.exists(file)) {
                return;
            }
            await this.openCodeFile(file.toString());
        } catch (error) {
            console.error(`Poiesis could not open the Agent file link: ${rawUri}`, error);
        }
    }

    protected requirementForSend(
        session: WindowAgentSession,
        request: string
    ): { requirementId: string; requirementChoice: ExecutionTask['requirementChoice'] } {
        const requirementChoice: ExecutionTask['requirementChoice'] = session.requirementDraftExplicit
            ? 'explicit'
            : 'default';
        const available = this.requirementsForSession(session);
        const selected = session.requirementDraft && session.requirementDraft !== 'new'
            ? available.find(requirement => requirement.id === session.requirementDraft)
            : undefined;
        const current = this.requirementService.currentRequirementId(session.id);
        const requirement = session.requirementDraft === 'new'
            ? this.requirementService.create(session.id, taskTitleForRequest(request))
            : selected
                ?? available.find(candidate => candidate.id === current)
                ?? this.requirementService.create(session.id, taskTitleForRequest(request));
        session.requirementDraft = requirement.id;
        session.requirementDraftExplicit = false;
        return { requirementId: requirement.id, requirementChoice };
    }

    protected async sendAgentMessage(): Promise<void> {
        await this.sessionsInitialization;
        const session = this.selectedSession();
        const content = session?.agentDraft.trim() ?? '';
        if (!session || !session.workspaceUri || !content || this.runningTask(session)) {
            return;
        }
        const { requirementId, requirementChoice } = this.requirementForSend(session, content);
        session.agentDraft = '';
        const sentAt = Date.now();
        session.messages.push({ id: `user-${sentAt}`, role: 'user', content, complete: true });
        session.updatedAt = sentAt;
        if (!session.hasUserMessage) {
            session.createdAt = sentAt;
            session.title = this.titleForSession(content);
            session.hasUserMessage = true;
        }
        this.update();
        await this.persistWindowState();
        if (session.agentSession?.providerId && (session.agentSession.providerId !== this.agentCli
            || (session.agentSession.model ?? '') !== this.agentModel.trim())) {
            session.agentSession = undefined;
        }
        if (!session.agentSession && !await this.ensureProviderSession(session, false, true)) {
            await this.recordPreSpawnFailure(
                session,
                content,
                requirementId,
                requirementChoice,
                'Agentを開始できませんでした。',
                this.providerPreparationErrors.get(session.id)
            );
            return;
        }
        if (!session.agentSession) {
            await this.recordPreSpawnFailure(
                session,
                content,
                requirementId,
                requirementChoice,
                'Agentを開始できませんでした。'
            );
            return;
        }
        try {
            await this.agentProvider.sendMessage(session.agentSession.id, {
                role: 'user',
                content,
                ownerSessionId: session.id,
                requirementId,
                requirementChoice,
                workspaceUri: session.workspaceUri
            });
        } catch (error) {
            await this.recordPreSpawnFailure(
                session,
                content,
                requirementId,
                requirementChoice,
                'Agentを開始できませんでした。',
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    protected async recordPreSpawnFailure(
        session: WindowAgentSession,
        request: string,
        requirementId: string,
        requirementChoice: ExecutionTask['requirementChoice'],
        summary: string,
        details?: string
    ): Promise<void> {
        const task = await this.taskService.failBeforeStart(
            session.id,
            request,
            requirementId,
            { summary, details },
            requirementChoice,
            session.workspaceUri
        );
        session.messages.push({
            id: `agent-${task.id}`,
            role: 'agent',
            content: summary,
            complete: true,
            taskId: task.id,
            error: true,
            errorDetails: details
        });
        session.updatedAt = Date.now();
        await this.persistWindowState();
        this.update();
    }

    protected async cancelRun(): Promise<void> {
        const session = this.selectedSession()?.agentSession;
        if (session) {
            await this.agentProvider.cancel(session.id);
        }
    }

    protected handleAgentEvent(event: AgentEvent): void {
        const session = this.findSessionByAgentId(event.sessionId);
        if (!session) {
            return;
        }
        const autoFollowActivities = event.type === 'activity'
            && session.id === this.selectedSessionId
            && this.isAgentMessagesNearBottom();
        if (event.type === 'task-started') {
            session.messages.push({ id: `agent-${event.taskId}`, role: 'agent', content: '', complete: false, taskId: event.taskId });
        } else if (event.type === 'activity') {
            this.taskService.recordActivity(event.taskId, event.activity);
        } else if (event.type === 'message-delta') {
            this.updateAgentMessage(session, event.taskId, message => ({ ...message, content: message.content + event.delta }));
        } else if (event.type === 'message-completed') {
            this.updateAgentMessage(session, event.taskId, message => ({ ...message, complete: true }));
        } else if (event.type === 'task-cancelled') {
            this.updateAgentMessage(session, event.taskId, message => ({
                ...message,
                content: `${message.content} 実行をキャンセルしました。`.trim(),
                complete: true
            }));
        } else if (event.type === 'task-failed') {
            this.updateAgentMessage(session, event.taskId, message => ({
                ...message,
                content: event.summary,
                complete: true,
                error: true,
                errorDetails: event.details
            }));
        }
        session.updatedAt = Date.now();
        this.persistWindowState();
        this.update();
        if (autoFollowActivities) {
            requestAnimationFrame(() => {
                if (session.id !== this.selectedSessionId) {
                    return;
                }
                const messages = this.node.querySelector<HTMLElement>('.poiesis-agent-window__messages');
                if (messages) {
                    messages.scrollTop = messages.scrollHeight;
                }
            });
        }
    }

    protected isAgentMessagesNearBottom(): boolean {
        const messages = this.node.querySelector<HTMLElement>('.poiesis-agent-window__messages');
        return Boolean(messages && messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 40);
    }

    protected upsertAgentActivity(current: AgentActivity[] | undefined, incoming: AgentActivity): AgentActivity[] {
        const activity = {
            ...incoming,
            detail: incoming.detail?.slice(0, 2_000)
        };
        const activities = [...(current ?? [])];
        const existing = activities.findIndex(candidate => candidate.id === activity.id);
        if (existing >= 0) {
            activities[existing] = activity;
        } else {
            activities.push(activity);
        }
        return this.capAgentActivities(activities);
    }

    protected capAgentActivities(activities: AgentActivity[]): AgentActivity[] {
        const capped = activities.slice();
        while (capped.length > MAX_AGENT_ACTIVITIES_PER_MESSAGE) {
            const disposable = capped.findIndex(activity => activity.kind === 'reasoning' || activity.kind === 'message');
            capped.splice(disposable >= 0 ? disposable : 0, 1);
        }
        return capped;
    }

    protected restoreAgentActivities(value: unknown): AgentActivity[] | undefined {
        if (!Array.isArray(value)) {
            return undefined;
        }
        const kinds = new Set<AgentActivityKind>(['command', 'file-change', 'read', 'reasoning', 'message', 'tool']);
        const statuses = new Set(['running', 'completed', 'failed']);
        const activities = value.flatMap(candidate => {
            const activity = candidate as Partial<AgentActivity> | null;
            if (!activity
                || typeof activity.id !== 'string'
                || !kinds.has(activity.kind as AgentActivityKind)
                || typeof activity.title !== 'string'
                || !statuses.has(activity.status ?? '')
                || typeof activity.startedAt !== 'string'
                || !Number.isFinite(Date.parse(activity.startedAt))) {
                return [];
            }
            return [{
                id: activity.id,
                kind: activity.kind as AgentActivityKind,
                title: activity.title,
                detail: typeof activity.detail === 'string' ? activity.detail.slice(0, 2_000) : undefined,
                status: activity.status as AgentActivity['status'],
                startedAt: activity.startedAt,
                endedAt: typeof activity.endedAt === 'string' && Number.isFinite(Date.parse(activity.endedAt))
                    ? activity.endedAt
                    : undefined
            }];
        });
        return this.capAgentActivities(activities);
    }

    protected updateAgentMessage(session: WindowAgentSession, taskId: string, update: (message: ChatMessage) => ChatMessage): void {
        const id = `agent-${taskId}`;
        session.messages = session.messages.map(message => message.id === id ? update(message) : message);
    }

    protected setAgentDraft(sessionId: string | undefined, value: string): void {
        const session = this.selectedSession();
        if (!sessionId || session?.id !== sessionId) {
            return;
        }
        session.agentDraft = value;
        this.persistWindowState();
        this.update();
    }

    constructor(host: AgentWindowHost) {
        super(host);
    }
}
