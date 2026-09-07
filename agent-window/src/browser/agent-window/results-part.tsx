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
import { taskProducesResult } from '../../common/task-outcome';
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

interface ResultsFrameMessage {
    type: 'poiesis:open-citation' | 'poiesis:retry-ai-results';
    citation?: string;
}

interface ResultsMetadataBadge {
    label: string;
    accessibleLabel: string;
}

export class ResultsPart extends AgentWindowPart {
    protected readonly resultsSkillNames = new Map<string, string>();

    protected resultsSkillNamesWorkspaceUri?: string;

    protected resultsSkillNamesLoading?: Promise<void>;

    protected deleteTaskConfirmationId?: string;

    protected renamingRequirementId?: string;

    protected requirementRenameDraft = '';

    protected readonly expandedRequirementIds = new Set<string>();

    protected resultsAuxiliaryPanel?: 'navigator' | 'details';

    protected resultsAuxiliaryScopeKey?: string;

    protected resultsAuxiliaryTrigger?: HTMLElement;

    public renderResults(session: WindowAgentSession | undefined): React.ReactNode {
        const requirements = this.host.sessions.resultsRequirements(session);
        const selectedRequirement = requirements.find(requirement => requirement.id === session?.selectedResultsRequirementId)
            ?? requirements[0];
        const selectedTask = selectedRequirement && session?.selectedResultsTaskId
                ? selectedRequirement.taskIds.map(taskId => this.taskService.get(taskId))
                .find(task => task?.id === session.selectedResultsTaskId && task?.status !== 'running')
            : undefined;
        const latestTask = selectedRequirement ? this.host.sessions.latestTaskForRequirement(selectedRequirement) : undefined;
        const scopeKey = selectedTask?.id ?? (selectedRequirement ? `requirement:${selectedRequirement.id}` : undefined);
        const document = selectedTask
            ? this.resultsService.get(selectedTask.id)
            : selectedRequirement ? this.resultsService.getRequirement(selectedRequirement.id) : undefined;
        const visibleChangeSet = selectedTask?.changeSet
            ?? (selectedRequirement
                ? this.resultsService.getRequirementChangeSet(selectedRequirement.id)
                    ?? this.host.sessions.fallbackRequirementChangeSet(selectedRequirement)
                : undefined);
        const draft = scopeKey ? session?.resultsDrafts.get(scopeKey) ?? '' : '';
        const notice = scopeKey ? session?.resultsNotices.get(scopeKey) : undefined;
        const questionSending = notice?.status === 'sending';
        const questionHistory = selectedTask?.resultsQuestions ?? selectedRequirement?.resultsQuestions ?? [];
        const questionPanelExpanded = scopeKey
            ? session?.resultsQaExpanded.get(scopeKey) === true
            : false;
        const selectedTitle = selectedTask?.title ?? selectedRequirement?.title;
        const questionCount = questionHistory.length + (questionSending ? 1 : 0);
        const auxiliaryPanel = this.resultsAuxiliaryScopeKey === scopeKey ? this.resultsAuxiliaryPanel : undefined;

        return (
            <section
                id='poiesis-results-panel'
                className='poiesis-results'
                data-auxiliary-panel={questionPanelExpanded ? 'questions' : auxiliaryPanel ?? 'none'}
                role='tabpanel'
                aria-labelledby='poiesis-results-tab'
            >
                <div
                    id='poiesis-results-task-panel'
                    className='poiesis-results__main'
                    role='tabpanel'
                    aria-labelledby={selectedTask
                        ? `poiesis-results-task-tab-${selectedTask.id}`
                        : selectedRequirement ? `poiesis-results-requirement-tab-${selectedRequirement.id}` : undefined}
                >
                    <div className='poiesis-results__canvas' aria-label='Results HTML キャンバス'>
                        {!selectedRequirement && <div className='poiesis-results__empty'>Agent でタスクを完了すると、ここに要件ごとの成果が表示されます。</div>}
                        {selectedTask && this.renderResultsHeader(
                            selectedTask,
                            requirements.length,
                            scopeKey,
                            draft,
                            questionCount,
                            questionSending,
                            questionPanelExpanded
                        )}
                        {!selectedTask && selectedRequirement && latestTask
                            && this.renderRequirementResultsHeader(
                                selectedRequirement,
                                latestTask,
                                requirements.length,
                                scopeKey,
                                draft,
                                questionCount,
                                questionSending,
                                questionPanelExpanded
                            )}
                        {latestTask?.status === 'failed' && !document && (
                            <div className='poiesis-results__state error' role='alert'>
                                <strong>タスクに失敗しました</strong>
                                <p>{latestTask.failure?.summary ?? 'Agent がタスクを完了できませんでした。'}</p>
                                {!session?.archived && <button type='button' onClick={() => void this.retryTask(latestTask.id)}>再試行</button>}
                            </div>
                        )}
                        {latestTask?.status === 'cancelled' && !document && (
                            <div className='poiesis-results__state cancelled' role='status'>
                                <strong>タスクはキャンセルされました</strong>
                                <p>成果は確定していません。必要なら同じ依頼を再試行できます。</p>
                                {!session?.archived && <button type='button' onClick={() => void this.retryTask(latestTask.id)}>再試行</button>}
                            </div>
                        )}
                        {visibleChangeSet?.error && (
                            <div className='poiesis-results__state poiesis-results__capture-notice' role='status'>
                                <strong>変更の記録を利用できません</strong>
                                <p>{visibleChangeSet.error}</p>
                            </div>
                        )}
                        {selectedRequirement && (document?.status === 'generating' && !document.html
                                || latestTask?.status === 'completed' && !document) && (
                            <div className='poiesis-results__empty poiesis-results__generating'>
                                <PoiesisResultsElapsed key={scopeKey} />
                            </div>
                        )}
                        {selectedRequirement && document?.status === 'failed' && (
                            <div className='poiesis-results__state error' role='alert'>
                                <strong>成果を作成できませんでした</strong>
                                <p>成果の作成中に問題が発生しました。再試行してください。</p>
                                {!session?.archived && <button type='button' onClick={() => selectedTask
                                    ? void this.retryResults(selectedTask.id)
                                    : void this.retryRequirementResults(selectedRequirement.id)}>再試行</button>}
                            </div>
                        )}
                        {selectedRequirement && document?.html && document.updateError && (
                            <div className='poiesis-results__state error' role='alert'>
                                <strong>{document.updateError}</strong>
                                <p>前回の内容を表示しています。</p>
                                {!session?.archived && <button type='button' onClick={() => selectedTask
                                    ? void this.retryResults(selectedTask.id)
                                    : void this.retryRequirementResults(selectedRequirement.id)}>再試行</button>}
                            </div>
                        )}
                        {selectedRequirement && document?.html && (document.status === 'ready' || document.status === 'generating') && (
                            <iframe
                                key={`${scopeKey}-${this.host.state.allowExternalResultsResources ? 'external' : 'isolated'}`}
                                className='poiesis-results__document'
                                title={`${selectedTitle}の成果`}
                                sandbox='allow-scripts'
                                srcDoc={this.resultsDocumentHtml(document.html)}
                            />
                        )}
                    </div>
                </div>
                {auxiliaryPanel === 'navigator' && this.renderResultsNavigator(
                    requirements,
                    selectedRequirement,
                    selectedTask?.id
                )}
                {auxiliaryPanel === 'details' && selectedRequirement && latestTask
                    && this.renderResultsDetails(selectedRequirement, selectedTask, latestTask)}
                {questionPanelExpanded && scopeKey && selectedTitle && this.renderResultsQuestionPanel(
                    scopeKey,
                    selectedTitle,
                    questionHistory,
                    questionSending ? notice : undefined,
                    draft,
                    document?.status === 'ready',
                    Boolean(session?.archived)
                )}
            </section>
        );
    }

    protected renderResultsNavigator(
        requirements: readonly Requirement[],
        selectedRequirement: Requirement | undefined,
        selectedTaskId: string | undefined
    ): React.ReactNode {
        return <>
            <div className='poiesis-results__auxiliary-scrim' onPointerDown={() => this.closeResultsAuxiliary()} />
            <aside
                id='poiesis-results-navigator'
                className='poiesis-results__auxiliary poiesis-results__navigator'
                role='dialog'
                aria-modal='true'
                aria-label='成果を選択'
                onKeyDown={event => this.handleResultsAuxiliaryKeyDown(event, () => this.closeResultsAuxiliary())}
            >
                {this.renderResultsAuxiliaryHeader('成果', '成果ナビゲーターを閉じる', () => this.closeResultsAuxiliary())}
                <div id='poiesis-results-task-list' className='poiesis-results__task-list' role='tablist'>
                    {requirements.map(requirement => this.renderRequirementCard(
                        requirement,
                        selectedRequirement?.id === requirement.id,
                        selectedTaskId
                    ))}
                </div>
                {!requirements.length && <p className='poiesis-results__auxiliary-empty'>完了した成果はありません。</p>}
            </aside>
        </>;
    }

    protected renderRequirementCard(
        requirement: Requirement,
        selected: boolean,
        selectedTaskId: string | undefined
    ): React.ReactNode {
        const latestTask = this.host.sessions.latestTaskForRequirement(requirement);
        const expanded = this.expandedRequirementIds.has(requirement.id);
        const menuKey = `requirement:${requirement.id}`;
        const renaming = this.renamingRequirementId === requirement.id;
        const tasks = requirement.taskIds.map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => Boolean(task && taskProducesResult(task)))
            .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
        const automaticSplitTask = tasks.length === 1
            && tasks[0].requirementClassification?.decision === 'new'
            && tasks[0].requirementClassification?.source === 'ai'
            && tasks[0].requirementClassification?.appliedNewRequirementId === requirement.id
            && !tasks[0].requirementClassification?.undone
            ? tasks[0]
            : undefined;
        const session = this.host.sessions.selectedSession();
        const scopeKey = `requirement:${requirement.id}`;
        const questionState = session?.resultsNotices.get(scopeKey)?.status === 'sending'
            ? '回答中'
            : session?.resultsDrafts.get(scopeKey)?.trim() ? '下書き' : undefined;
        return (
            <article
                key={requirement.id}
                className={`poiesis-results__requirement-card${selected ? ' active' : ''}`}
            >
                <div className='poiesis-results__requirement-main'>
                    <button
                        type='button'
                        className='poiesis-results__requirement-expand'
                        aria-label={expanded ? `${requirement.title}のタスクを閉じる` : `${requirement.title}のタスクを表示`}
                        aria-expanded={expanded}
                        onClick={() => this.toggleRequirementExpanded(requirement.id)}
                    >
                        <span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} aria-hidden='true' />
                    </button>
                    {renaming ? (
                        <form className='poiesis-results__requirement-rename' onSubmit={event => {
                            event.preventDefault();
                            this.commitRequirementRename(requirement.id);
                        }}>
                            <PoiesisTextInput
                                autoFocus
                                value={this.requirementRenameDraft}
                                maxLength={120}
                                aria-label='要件名'
                                onValueChange={value => {
                                    this.requirementRenameDraft = value;
                                    this.update();
                                }}
                                onKeyDown={event => {
                                    if (event.key === 'Escape') {
                                        event.preventDefault();
                                        this.cancelRequirementRename();
                                    }
                                }}
                            />
                            <button type='submit' disabled={!this.requirementRenameDraft.trim()}>保存</button>
                        </form>
                    ) : (
                        <button
                            id={`poiesis-results-requirement-tab-${requirement.id}`}
                            type='button'
                            role='tab'
                            aria-selected={selected && !selectedTaskId}
                            aria-controls='poiesis-results-task-panel'
                            className='poiesis-results__requirement-select'
                            onClick={() => this.selectResultsRequirement(requirement.id)}
                        >
                            <span title={requirement.title}>{requirement.title}</span>
                            <small>
                                タスク {tasks.length}件
                                {latestTask && latestTask.status !== 'completed' ? ` · ${this.host.sessions.taskStatusLabel(latestTask)}` : ''}
                                {questionState ? ` · ${questionState}` : ''}
                            </small>
                        </button>
                    )}
                    {!renaming && !session?.archived && (
                        <div className='poiesis-results__menu-host'>
                            <button
                                type='button'
                                className='poiesis-results__more'
                                aria-label={`${requirement.title}のメニュー`}
                                aria-expanded={this.host.state.openResultsMenuKey === menuKey}
                                onClick={() => {
                                    this.host.state.openResultsMenuKey = this.host.state.openResultsMenuKey === menuKey ? undefined : menuKey;
                                    this.update();
                                }}
                            >
                                <span className='codicon codicon-ellipsis' aria-hidden='true' />
                            </button>
                            {this.host.state.openResultsMenuKey === menuKey && (
                                <div className='poiesis-results__card-menu' role='menu'>
                                    <button type='button' role='menuitem' onClick={() => this.beginRequirementRename(requirement)}>名前を変更</button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                {automaticSplitTask && (
                    <div className='poiesis-results__automatic-requirement-note'>
                        <span>自動で分けました</span>
                        {!session?.archived && <><span aria-hidden='true'>·</span>
                            <button type='button' onClick={() => this.undoAutomaticRequirementSplit(automaticSplitTask.id)}>戻す</button></>}
                    </div>
                )}
                {expanded && (
                    <div className='poiesis-results__requirement-tasks' role='group' aria-label={`${requirement.title}のタスク履歴`}>
                        {tasks.map(task => this.renderRequirementTaskRow(requirement, task, selectedTaskId === task.id))}
                    </div>
                )}
            </article>
        );
    }

    protected renderRequirementTaskRow(
        requirement: Requirement,
        task: ExecutionTask,
        selected: boolean
    ): React.ReactNode {
        const menuKey = `task:${task.id}`;
        const confirmingDelete = this.deleteTaskConfirmationId === task.id;
        const finalizing = task.status === 'running' || this.taskService.isFinalizing(task.id);
        const otherRequirements = this.host.sessions.requirementsForSession(this.host.sessions.findSessionForTask(task))
            .filter(candidate => candidate.id !== requirement.id);
        const session = this.host.sessions.selectedSession();
        const questionState = session?.resultsNotices.get(task.id)?.status === 'sending'
            ? '回答中'
            : session?.resultsDrafts.get(task.id)?.trim() ? '下書き' : undefined;
        return (
            <div className={`poiesis-results__history-row${selected ? ' active' : ''}`} key={task.id}>
                <button
                    id={`poiesis-results-task-tab-${task.id}`}
                    type='button'
                    role='tab'
                    aria-selected={selected}
                    aria-controls='poiesis-results-task-panel'
                    disabled={task.status === 'running'}
                    onClick={() => this.selectResultsTask(task.id)}
                >
                    <span title={task.title}>{task.title}</span>
                    <small>
                        {task.status === 'completed' ? this.compactResultsDate(task.endedAt) : this.host.sessions.taskStatusLabel(task)}
                        {questionState ? ` · ${questionState}` : ''}
                    </small>
                </button>
                {!finalizing && !session?.archived && (
                    <div className='poiesis-results__menu-host'>
                        <button
                            type='button'
                            className='poiesis-results__more'
                            aria-label={`${task.title}のメニュー`}
                            aria-expanded={this.host.state.openResultsMenuKey === menuKey}
                            onClick={() => {
                                this.host.state.openResultsMenuKey = this.host.state.openResultsMenuKey === menuKey ? undefined : menuKey;
                                this.update();
                            }}
                        >
                            <span className='codicon codicon-ellipsis' aria-hidden='true' />
                        </button>
                        {this.host.state.openResultsMenuKey === menuKey && (
                            <div className='poiesis-results__card-menu task-menu' role='menu'>
                                {otherRequirements.length > 0 && (
                                    <details className='poiesis-results__move-submenu'>
                                        <summary role='menuitem' aria-haspopup='menu'>
                                            別の要件へ移動
                                            <span className='codicon codicon-chevron-right' aria-hidden='true' />
                                        </summary>
                                        <div className='poiesis-results__move-submenu-list' role='menu'>
                                            {otherRequirements.map(target => (
                                                <button type='button' role='menuitem' key={target.id}
                                                    onClick={() => this.moveTaskToRequirement(task.id, target.id)}>
                                                    {target.title}
                                                </button>
                                            ))}
                                        </div>
                                    </details>
                                )}
                                <button type='button' role='menuitem' onClick={() => this.splitTaskToNewRequirement(task.id)}>新しい要件へ分割</button>
                                <button type='button' role='menuitem' className='danger' onClick={() => this.beginDeleteResultsTask(task.id)}>タスクを削除</button>
                            </div>
                        )}
                    </div>
                )}
                {confirmingDelete && (
                    <div className='poiesis-results__task-delete-confirm' role='group' aria-label={`${task.title}の削除を確認`}>
                        <span>削除しますか？</span>
                        <button type='button' className='danger' onClick={() => void this.deleteResultsTask(task.id)}>削除</button>
                        <button type='button' onClick={() => this.cancelDeleteResultsTask()}>戻る</button>
                    </div>
                )}
            </div>
        );
    }

    protected renderResultsHeader(
        task: ExecutionTask,
        resultsCount: number,
        scopeKey: string | undefined,
        draft: string,
        questionCount: number,
        questionSending: boolean,
        questionPanelExpanded: boolean
    ): React.ReactNode {
        const document = this.resultsService.get(task.id);
        return this.renderResultsToolbar(
            task.title,
            resultsCount,
            scopeKey,
            draft,
            questionCount,
            questionSending,
            questionPanelExpanded,
            this.resultsActionStatus(document, task)
        );
    }

    protected renderRequirementResultsHeader(
        requirement: Requirement,
        latestTask: ExecutionTask,
        resultsCount: number,
        scopeKey: string | undefined,
        draft: string,
        questionCount: number,
        questionSending: boolean,
        questionPanelExpanded: boolean
    ): React.ReactNode {
        const document = this.resultsService.getRequirement(requirement.id);
        return this.renderResultsToolbar(
            requirement.title,
            resultsCount,
            scopeKey,
            draft,
            questionCount,
            questionSending,
            questionPanelExpanded,
            this.resultsActionStatus(document, latestTask)
        );
    }

    protected renderResultsToolbar(
        title: string,
        resultsCount: number,
        scopeKey: string | undefined,
        draft: string,
        questionCount: number,
        questionSending: boolean,
        questionPanelExpanded: boolean,
        actionStatus: { label: string; kind: string } | undefined
    ): React.ReactNode {
        const navigatorExpanded = this.resultsAuxiliaryPanel === 'navigator' && this.resultsAuxiliaryScopeKey === scopeKey;
        const detailsExpanded = this.resultsAuxiliaryPanel === 'details' && this.resultsAuxiliaryScopeKey === scopeKey;
        const questionLabel = questionSending
            ? '回答中'
            : draft.trim() ? '質問・下書き' : questionCount > 0 ? `質問 ${questionCount}` : '質問';
        return (
            <header className='poiesis-results__fixed-header'>
                <div className='poiesis-results__fixed-title'>
                    <h1 data-result-title={title} title={title}>{title}</h1>
                    {actionStatus && (
                        <span className={`poiesis-results__action-status ${actionStatus.kind}`} role='status'>
                            {actionStatus.kind === 'running' && <span className='codicon codicon-loading codicon-modifier-spin' aria-hidden='true' />}
                            {actionStatus.label}
                        </span>
                    )}
                </div>
                <div className='poiesis-results__toolbar-actions'>
                    <button
                        type='button'
                        className='poiesis-results__toolbar-button poiesis-results__outcome-trigger'
                        aria-label={`成果を選択、${resultsCount}件`}
                        aria-expanded={navigatorExpanded}
                        aria-controls='poiesis-results-navigator'
                        onClick={event => this.toggleResultsAuxiliary('navigator', event.currentTarget, scopeKey)}
                    >
                        <span>成果 {resultsCount}</span>
                        <span className='codicon codicon-chevron-down' aria-hidden='true' />
                    </button>
                    <button
                        id='poiesis-results-question-trigger'
                        type='button'
                        className='poiesis-results__toolbar-button'
                        data-has-draft={draft.trim() ? 'true' : 'false'}
                        data-pending={questionSending ? 'true' : 'false'}
                        aria-label={`${questionLabel}パネルを${questionPanelExpanded ? '閉じる' : '開く'}`}
                        aria-expanded={questionPanelExpanded}
                        aria-controls='poiesis-results-questions-panel'
                        disabled={!scopeKey}
                        onClick={event => scopeKey && this.toggleResultsQuestionPanel(scopeKey, questionPanelExpanded, event.currentTarget)}
                    >
                        {questionSending
                            ? <span className='codicon codicon-loading codicon-modifier-spin' aria-hidden='true' />
                            : <span className='codicon codicon-comment-discussion' aria-hidden='true' />}
                        <span>{questionLabel}</span>
                    </button>
                    <button
                        type='button'
                        className='poiesis-results__toolbar-button poiesis-results__details-trigger'
                        aria-label='成果の詳細を表示'
                        aria-expanded={detailsExpanded}
                        aria-controls='poiesis-results-details-panel'
                        onClick={event => this.toggleResultsAuxiliary('details', event.currentTarget, scopeKey)}
                    >
                        <span>詳細</span>
                    </button>
                </div>
            </header>
        );
    }

    protected resultsActionStatus(
        document: TaskResultDocument | undefined,
        task: ExecutionTask
    ): { label: string; kind: string } | undefined {
        if (document?.status === 'generating') {
            return { label: document.html ? '更新中' : '作成中', kind: 'running' };
        }
        if (document?.updateError) {
            return { label: '更新失敗', kind: 'failed' };
        }
        if (document?.status === 'failed') {
            return { label: '作成失敗', kind: 'failed' };
        }
        if (task.status === 'failed') {
            return { label: '失敗', kind: 'failed' };
        }
        if (task.status === 'cancelled') {
            return { label: '停止', kind: 'cancelled' };
        }
        return undefined;
    }

    protected renderResultsDetails(
        requirement: Requirement,
        selectedTask: ExecutionTask | undefined,
        latestTask: ExecutionTask
    ): React.ReactNode {
        const tasks = selectedTask ? [selectedTask] : this.host.sessions.finishedTasksForRequirement(requirement);
        const document = selectedTask
            ? this.resultsService.get(selectedTask.id)
            : this.resultsService.getRequirement(requirement.id);
        const changeSet = selectedTask?.changeSet
            ?? this.resultsService.getRequirementChangeSet(requirement.id)
            ?? this.host.sessions.fallbackRequirementChangeSet(requirement);
        const diffstat = summarizeTaskChangeSet(changeSet);
        const appliedSkillIds = [...new Set(tasks.flatMap(task => [
            ...task.appliedSkills?.agent ?? [],
            ...task.appliedSkills?.results ?? []
        ]))];
        if (appliedSkillIds.some(id => !this.resultsSkillNames.has(id))) {
            void this.ensureResultsSkillNames();
        }
        const appliedSkillNames = appliedSkillIds.map(id => this.resultsSkillNames.get(id) ?? id);
        const assertions = document?.status === 'ready' && Array.isArray(document.assertions)
            ? document.assertions
            : [];
        const passedAssertions = assertions.filter(assertion => assertion.status === 'pass').length;
        const generation = this.resultsGenerationBadge(document);
        const task = selectedTask ?? latestTask;
        const completedAtJst = formatTaskEndedAtJst(task.endedAt);
        return <>
            <div className='poiesis-results__auxiliary-scrim' onPointerDown={() => this.closeResultsAuxiliary()} />
            <aside
                id='poiesis-results-details-panel'
                className='poiesis-results__auxiliary poiesis-results__details'
                role='dialog'
                aria-modal='true'
                aria-label='成果の詳細'
                onKeyDown={event => this.handleResultsAuxiliaryKeyDown(event, () => this.closeResultsAuxiliary())}
            >
                {this.renderResultsAuxiliaryHeader('詳細', '詳細を閉じる', () => this.closeResultsAuxiliary())}
                <dl className='poiesis-results__details-list'>
                    <div>
                        <dt>状態</dt>
                        <dd>{this.host.sessions.taskStatusLabel(task)}</dd>
                    </div>
                    {completedAtJst && (
                        <div>
                            <dt>完了日時</dt>
                            <dd><time dateTime={task.endedAt}>{completedAtJst}</time></dd>
                        </div>
                    )}
                    <div>
                        <dt>変更</dt>
                        <dd>{changeSet?.error
                            ? '確認できません'
                            : `${diffstat.fileCount}ファイル · +${diffstat.additions} −${diffstat.deletions}`}</dd>
                    </div>
                    <div>
                        <dt>成果の作成</dt>
                        <dd>{generation?.accessibleLabel ?? (document?.status === 'generating' ? '作成中' : document?.status === 'failed' ? '作成失敗' : '未作成')}</dd>
                    </div>
                    {assertions.length > 0 && (
                        <div>
                            <dt>成果の生成条件</dt>
                            <dd>{passedAssertions}/{assertions.length} 通過</dd>
                        </div>
                    )}
                    <div>
                        <dt>適用 Skills</dt>
                        <dd>{appliedSkillNames.length > 0 ? appliedSkillNames.join('、') : 'なし'}</dd>
                    </div>
                    <div>
                        <dt>タスク履歴</dt>
                        <dd>{this.host.sessions.finishedTasksForRequirement(requirement).length}件</dd>
                    </div>
                </dl>
                {assertions.length > 0 && (
                    <ul className='poiesis-results__assertion-list' aria-label='成果の生成条件'>
                        {assertions.map((assertion, index) => (
                            <li key={`${assertion.text}-${index}`} data-status={assertion.status}>
                                <span>{assertion.status === 'pass' ? '通過' : assertion.status === 'fail' ? '不通過' : '未判定'}</span>
                                <p>{assertion.text}</p>
                            </li>
                        ))}
                    </ul>
                )}
            </aside>
        </>;
    }

    protected renderResultsAuxiliaryHeader(title: string, closeLabel: string, onClose: () => void): React.ReactNode {
        return (
            <header className='poiesis-results__auxiliary-header'>
                <h2>{title}</h2>
                <button type='button' aria-label={closeLabel} data-results-autofocus='true' onClick={onClose}>
                    <span className='codicon codicon-close' aria-hidden='true' />
                </button>
            </header>
        );
    }

    protected toggleResultsAuxiliary(
        panel: 'navigator' | 'details',
        trigger: HTMLElement,
        scopeKey: string | undefined
    ): void {
        if (this.resultsAuxiliaryPanel === panel && this.resultsAuxiliaryScopeKey === scopeKey) {
            this.closeResultsAuxiliary();
            return;
        }
        const session = this.host.sessions.selectedSession();
        if (session && scopeKey) {
            session.resultsQaExpanded.delete(scopeKey);
            this.host.sessions.persistResultsQaPanelState();
        }
        this.resultsAuxiliaryPanel = panel;
        this.resultsAuxiliaryScopeKey = scopeKey;
        this.resultsAuxiliaryTrigger = trigger;
        this.host.state.openResultsMenuKey = undefined;
        this.update();
        requestAnimationFrame(() => {
            const auxiliary = this.node.querySelector<HTMLElement>(`[data-auxiliary-panel='${panel}'] .poiesis-results__auxiliary`);
            const selected = auxiliary?.querySelector<HTMLElement>('[aria-selected="true"]');
            (selected ?? auxiliary?.querySelector<HTMLElement>('[data-results-autofocus="true"]'))?.focus();
        });
    }

    protected closeResultsAuxiliary(returnFocus = true): void {
        const trigger = this.resultsAuxiliaryTrigger;
        this.resultsAuxiliaryPanel = undefined;
        this.resultsAuxiliaryScopeKey = undefined;
        this.host.state.openResultsMenuKey = undefined;
        this.update();
        if (returnFocus) {
            requestAnimationFrame(() => trigger?.focus());
        }
    }

    protected toggleResultsQuestionPanel(scopeKey: string, expanded: boolean, trigger: HTMLElement): void {
        this.resultsAuxiliaryPanel = undefined;
        this.resultsAuxiliaryScopeKey = undefined;
        this.resultsAuxiliaryTrigger = trigger;
        if (expanded) {
            this.setResultsQuestionPanelExpanded(scopeKey, false);
            requestAnimationFrame(() => trigger.focus());
            return;
        }
        this.setResultsQuestionPanelExpanded(scopeKey, true);
        requestAnimationFrame(() => {
            const panel = this.node.querySelector<HTMLElement>('.poiesis-results__question-panel');
            const input = panel?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)');
            const enabledControl = panel?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
            (input ?? enabledControl ?? panel)?.focus();
        });
    }

    protected handleResultsAuxiliaryKeyDown(event: React.KeyboardEvent<HTMLElement>, close: () => void): void {
        if (event.defaultPrevented) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }
        if (event.key !== 'Tab') {
            return;
        }
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )).filter(element => element.getClientRects().length > 0);
        if (!focusable.length) {
            event.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    protected resultsGenerationBadge(document: TaskResultDocument | undefined): ResultsMetadataBadge | undefined {
        if (document?.status !== 'ready') {
            return undefined;
        }
        if (document.generator === 'ai') {
            const providerId: KnownCliId = isKnownCliId(document.providerId) ? document.providerId : this.host.state.resultsCli;
            const provider = this.host.state.cliDetectionReport?.detections.find((candidate: CliDetectionReport['detections'][number]) => candidate.id === providerId)?.name
                ?? ({ codex: 'Codex', claude: 'Claude Code', grok: 'Grok', gemini: 'Gemini CLI' } satisfies Record<KnownCliId, string>)[providerId];
            const suffix = document.effort ? ` · ${document.effort}` : '';
            return {
                label: `AI · ${provider}${suffix}`,
                accessibleLabel: `AI 生成 · ${provider}${suffix}`
            };
        }
        const fallbackLabel = document.fallbackReason === 'no-workspace'
            ? 'Workspace 未選択'
            : document.fallbackReason === 'timeout'
                ? '時間切れ'
                : document.fallbackReason === 'generation-failed'
                    ? 'AI 生成に失敗'
                    : undefined;
        const accessibleLabel = `テンプレート表示${fallbackLabel ? ` · ${fallbackLabel}` : ''}`;
        return {
            label: fallbackLabel ? `テンプレート · ${fallbackLabel.replace('AI 生成に', '生成')}` : 'テンプレート',
            accessibleLabel
        };
    }

    protected renderResultsAssertionBadge(document: TaskResultDocument | undefined): React.ReactNode {
        const assertions = document?.status === 'ready' && Array.isArray(document.assertions)
            ? document.assertions
            : [];
        if (!assertions.length) {
            return undefined;
        }
        const passed = assertions.filter(assertion => assertion.status === 'pass').length;
        const unresolved = assertions.filter(assertion => assertion.status !== 'pass');
        const accessibleLabel = `Skill 条件 ${passed}/${assertions.length} 合格`;
        const title = unresolved.length > 0
            ? `${accessibleLabel}\n${unresolved.map(assertion => `${assertion.status === 'fail' ? '不合格' : '未判定'}: ${assertion.text}`).join('\n')}`
            : accessibleLabel;
        return (
            <span
                className={`poiesis-results__assertion-badge ${unresolved.length === 0 ? 'passed' : 'warning'}`}
                title={title}
                aria-label={accessibleLabel}
            >
                条件 {passed}/{assertions.length}
            </span>
        );
    }

    protected compactResultsDate(timestamp: string | undefined): string {
        if (!timestamp) {
            return '';
        }
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) {
            return '';
        }
        const parts = new Intl.DateTimeFormat('ja-JP', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'Asia/Tokyo'
        }).formatToParts(date);
        const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(candidate => candidate.type === type)?.value ?? '';
        return `${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`;
    }

    public ensureResultsSkillNames(): Promise<void> {
        const root = this.host.sessions.workspaceRoot()?.resource;
        const workspaceUri = root?.toString();
        if (!root || !workspaceUri) {
            return Promise.resolve();
        }
        if (this.resultsSkillNamesWorkspaceUri === workspaceUri && this.resultsSkillNamesLoading) {
            return this.resultsSkillNamesLoading;
        }
        if (this.resultsSkillNamesWorkspaceUri === workspaceUri && this.host.state.resultsSkillNamesLoaded) {
            return Promise.resolve();
        }
        this.resultsSkillNamesWorkspaceUri = workspaceUri;
        this.host.state.resultsSkillNamesLoaded = false;
        this.resultsSkillNames.clear();
        const loading = this.workspaceSkillService.list(root).then(skills => {
            if (this.resultsSkillNamesWorkspaceUri !== workspaceUri) {
                return;
            }
            for (const skill of skills) {
                this.resultsSkillNames.set(skill.id, skill.name || skill.id);
            }
            this.host.state.resultsSkillNamesLoaded = true;
            this.update();
        }).catch(error => {
            console.warn('[Poiesis] Could not resolve applied Workspace Skill names.', error);
        }).finally(() => {
            if (this.resultsSkillNamesLoading === loading) {
                this.resultsSkillNamesLoading = undefined;
            }
        });
        this.resultsSkillNamesLoading = loading;
        return loading;
    }

    protected renderResultsQuestionPanel(
        scopeKey: string,
        title: string,
        history: readonly TaskResultsQuestion[],
        pending: ResultsNotice | undefined,
        draft: string,
        documentReady: boolean,
        archived: boolean
    ): React.ReactNode {
        return <>
            <div className='poiesis-results__auxiliary-scrim' onPointerDown={() => this.closeResultsQuestionPanel(scopeKey)} />
            <section
                id='poiesis-results-questions-panel'
                className='poiesis-results__auxiliary poiesis-results__question-panel'
                role='dialog'
                aria-modal='true'
                aria-label={`${title}への質問`}
                data-results-scope={scopeKey}
                tabIndex={-1}
                onKeyDown={event => this.handleResultsAuxiliaryKeyDown(event, () => this.closeResultsQuestionPanel(scopeKey))}
            >
                <header className='poiesis-results__auxiliary-header poiesis-results__question-header'>
                    <div>
                        <h2>質問</h2>
                        <small title={title}>{title}</small>
                    </div>
                    <button type='button' aria-label='質問を閉じる' onClick={() => this.closeResultsQuestionPanel(scopeKey)}>
                        <span className='codicon codicon-close' aria-hidden='true' />
                    </button>
                </header>
                <div className='poiesis-results__qa-history' aria-label={`${title}への質問履歴`}>
                    {history.map((entry, index) => (
                        <article className={`poiesis-results__qa-entry${entry.error ? ' failed' : ''}`} key={`${entry.timestamp}-${index}`}>
                            <div className='poiesis-results__qa-meta'>
                                <strong>質問</strong>
                                <time dateTime={entry.timestamp}>{this.questionTime(entry.timestamp)}</time>
                            </div>
                            <p>{entry.question}</p>
                            <div className='poiesis-results__qa-response'>
                                <strong>{entry.error ? '回答に失敗' : '回答'}</strong>
                                {entry.error
                                    ? <p>{entry.error}</p>
                                    : this.host.renderMarkdown(entry.answer ?? '')}
                                {entry.error && !archived && (
                                    <button type='button' onClick={() => void this.submitResultsQuestion(scopeKey, entry.question)}>再試行</button>
                                )}
                            </div>
                        </article>
                    ))}
                    {pending && (
                        <article className='poiesis-results__qa-entry sending' role='status' aria-live='polite'>
                            <div className='poiesis-results__qa-meta'>
                                <strong>質問</strong>
                                <span>送信中</span>
                            </div>
                            <p>{pending.question}</p>
                            <div className='poiesis-results__qa-response'>
                                <strong>回答</strong>
                                <p className='poiesis-results__qa-sending'>
                                    <span className='codicon codicon-loading codicon-modifier-spin' aria-hidden='true' />
                                    回答を作成しています…
                                </p>
                            </div>
                        </article>
                    )}
                </div>
                <section className='poiesis-results__composer' aria-label='Results の入力欄'>
                    {archived ? (
                        <div className='poiesis-agent-window__archived-composer-state'>
                            <span><span className='codicon codicon-archive' aria-hidden='true' />アーカイブ済み</span>
                            <button type='button' onClick={() => this.host.restoreSession(this.host.sessions.selectedSessionId!)}>復元</button>
                        </div>
                    ) : <>
                        <PoiesisComposer
                            key={scopeKey}
                            autoFocus
                            value={draft}
                            placeholder='この成果について質問…'
                            aria-label='表示中の成果について質問'
                            rows={3}
                            maxLength={4_000}
                            disabled={!documentReady || Boolean(pending)}
                            onValueChange={value => this.setResultsDraft(scopeKey, value)}
                            onSubmit={() => void this.submitResultsQuestion(scopeKey)}
                        />
                        <button
                            type='button'
                            className='poiesis-results__send'
                            aria-label='Results 内へ送信'
                            disabled={!documentReady || Boolean(pending) || !draft.trim()}
                            onClick={() => void this.submitResultsQuestion(scopeKey)}
                        >
                            <span className='codicon codicon-arrow-up' aria-hidden='true' />
                        </button>
                        {documentReady && this.host.renderAiRolePill('results', true)}
                    </>}
                </section>
            </section>
        </>;
    }

    protected questionTime(timestamp: string): string {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) {
            return '';
        }
        return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    }

    protected resultsDocumentHtml(html: string): string {
        const sanitized = html
            .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
            .replace(/<script\b[^>]*\/\s*>/gi, '')
            .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
        const policy = this.host.state.allowExternalResultsResources
            ? ''
            : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`;
        const baseStyle = `<style data-poiesis-base>
* { box-sizing: border-box; }
html, body { font-family: ${POIESIS_FONT_SANS}; font-size: 16px; }
body *:not(code):not(pre):not(kbd):not(samp):not(svg):not(svg *) { font-family: inherit !important; }
code, pre, kbd, samp { font-family: ${POIESIS_FONT_MONO} !important; }
body { font-size: 15px !important; line-height: 1.65; margin: 0 !important; padding: 0 0 40px !important; }
body > :not(script):not(style) { margin-inline: auto !important; max-width: 980px !important; min-width: 0; padding-top: clamp(22px, 3vw, 42px) !important; padding-inline: clamp(20px, 4vw, 48px) !important; width: 100% !important; }
body > :not(script):not(style) > :only-child:not(code):not(pre):not(table):not(img) { max-width: none !important; margin-inline: 0 !important; padding-top: 0 !important; padding-inline: 0 !important; }
body > :first-child, body > * > :first-child, body > * > * > :first-child { margin-top: 0 !important; }
p, li, td, th { font-size: max(15px, .9375rem) !important; }
table, pre { max-width: 100%; overflow-x: auto; }
table { display: block; }
img, svg, figure { max-width: 100%; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: #9a9183; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: #766d61; background-clip: padding-box; }
</style>`;
        const bridge = `<script data-poiesis-results-bridge="v1">
(function () {
  function send(message) { window.parent.postMessage(message, '*'); }
  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    var action = target.closest('[data-poiesis-action="retry-ai-results"]');
    if (action) {
      event.preventDefault();
      send({ type: 'poiesis:retry-ai-results' });
      return;
    }
    var citationNode = target.closest('[data-poiesis-citation]');
    var citation = citationNode && citationNode.getAttribute('data-poiesis-citation');
    if (!citation) {
      var plainNode = target.closest('a, cite, code');
      var match = plainNode && (plainNode.textContent || '').match(/((?:[^\\s:()]+[\\\\/])*[^\\s:()]+\\.[A-Za-z0-9_-]+):(\\d+)(?:\\s*[-–—]\\s*(\\d+))?/);
      if (match) citation = match[1] + ':' + match[2] + (match[3] ? '-' + match[3] : '');
    }
    if (!citation) return;
    event.preventDefault();
    send({ type: 'poiesis:open-citation', citation: citation });
  }, true);
})();
</script>`;
        const headContent = [policy, baseStyle].filter(Boolean).join('\n  ');
        const withHead = /<head(?:\s[^>]*)?>/i.test(sanitized)
            ? sanitized.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n  ${headContent}`)
            : /<html(?:\s[^>]*)?>/i.test(sanitized)
                ? sanitized.replace(/<html(?:\s[^>]*)?>/i, match => `${match}\n<head>\n  ${headContent}\n</head>`)
                : `<head>\n  ${headContent}\n</head>\n${sanitized}`;
        return /<\/body\s*>/i.test(withHead)
            ? withHead.replace(/<\/body\s*>/i, `${bridge}\n</body>`)
            : `${withHead}\n${bridge}`;
    }

    public handleResultsFrameMessage(event: MessageEvent): void {
        const frame = this.node.querySelector<HTMLIFrameElement>('.poiesis-results__document');
        if (!frame?.contentWindow || event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') {
            return;
        }
        const message = event.data as Partial<ResultsFrameMessage>;
        if (message.type === 'poiesis:retry-ai-results') {
            const session = this.host.sessions.selectedSession();
            if (session?.selectedResultsTaskId) {
                void this.retryResults(session.selectedResultsTaskId);
            } else if (session?.selectedResultsRequirementId) {
                const requirement = this.requirementService.get(session.selectedResultsRequirementId);
                const onlyTask = requirement && this.host.sessions.finishedTasksForRequirement(requirement).length === 1
                    ? this.host.sessions.finishedTasksForRequirement(requirement)[0]
                    : undefined;
                if (onlyTask) {
                    void this.retryResults(onlyTask.id);
                } else {
                    void this.retryRequirementResults(session.selectedResultsRequirementId);
                }
            }
        } else if (message.type === 'poiesis:open-citation' && typeof message.citation === 'string') {
            void this.openResultsCitation(message.citation);
        }
    }

    public async openResultsCitation(rawCitation: string): Promise<void> {
        const match = rawCitation.trim().match(/^(.*):(\d+)(?:\s*[-–—]\s*(\d+))?$/);
        const path = match?.[1].trim().replace(/^`|`$/g, '').replace(/\\/g, '/');
        const startLine = Number(match?.[2]);
        const endLine = Number(match?.[3] ?? match?.[2]);
        const invalidPath = !path
            || path.startsWith('/')
            || /^[A-Za-z]:/.test(path)
            || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
            || path.split('/').some(segment => !segment || segment === '.' || segment === '..');
        if (invalidPath || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
            || startLine < 1 || endLine < startLine || endLine > 10_000_000) {
            this.messageService.error('引用先を開けません。ワークスペース内のファイルと行番号を確認してください。');
            return;
        }
        const workspace = this.host.sessions.workspaceRoot()?.resource.normalizePath();
        const file = workspace?.resolve(path).normalizePath();
        try {
            if (!workspace || !file || !workspace.isEqualOrParent(file, false) || !await this.fileService.exists(file)) {
                this.messageService.error('引用先のファイルがワークスペース内に見つかりません。');
                return;
            }
            const stat = await this.fileService.resolve(file);
            if (!stat.isFile) {
                this.messageService.error('引用先はファイルではありません。');
                return;
            }
            await this.host.openCodeCitation(file, startLine, endLine);
        } catch (error) {
            console.warn(`[Poiesis] Could not open Results citation: ${rawCitation}`, error);
            this.messageService.error('引用先を Editor で開けませんでした。');
        }
    }

    public selectResultsTask(taskId: string): void {
        const session = this.host.sessions.selectedSession();
        const task = this.taskService.get(taskId);
        if (session && task && task.status !== 'running') {
            this.closeResultsPanelsForSelection(session);
            session.selectedResultsRequirementId = task.requirementId;
            session.selectedResultsTaskId = taskId;
            this.deleteTaskConfirmationId = undefined;
            this.host.sessions.persistWindowState();
            this.host.sessions.persistResultsQaPanelState();
        }
        this.update();
    }

    public selectResultsRequirement(requirementId: string): void {
        const session = this.host.sessions.selectedSession();
        const requirement = this.requirementService.get(requirementId);
        if (!session || requirement?.sessionId !== session.id) {
            return;
        }
        this.closeResultsPanelsForSelection(session);
        session.selectedResultsRequirementId = requirementId;
        session.selectedResultsTaskId = undefined;
        this.deleteTaskConfirmationId = undefined;
        void this.host.sessions.persistWindowState();
        void this.host.sessions.persistResultsQaPanelState();
        this.update();
    }

    protected toggleRequirementExpanded(requirementId: string): void {
        if (this.expandedRequirementIds.has(requirementId)) {
            this.expandedRequirementIds.delete(requirementId);
        } else {
            this.expandedRequirementIds.add(requirementId);
        }
        this.update();
    }

    protected beginRequirementRename(requirement: Requirement): void {
        if (this.host.sessions.selectedSession()?.archived) {
            return;
        }
        this.host.state.openResultsMenuKey = undefined;
        this.renamingRequirementId = requirement.id;
        this.requirementRenameDraft = requirement.title;
        this.update();
    }

    protected beginSplitRequirementRename(requirement: Requirement): void {
        this.beginRequirementRename(requirement);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (this.renamingRequirementId === requirement.id) {
                const input = this.node.querySelector<HTMLInputElement>('.poiesis-results__requirement-rename input');
                input?.focus();
                input?.select();
            }
        }));
    }

    protected cancelRequirementRename(): void {
        this.renamingRequirementId = undefined;
        this.requirementRenameDraft = '';
        this.update();
    }

    protected commitRequirementRename(requirementId: string): void {
        if (this.host.sessions.selectedSession()?.archived
            || this.renamingRequirementId !== requirementId || !this.requirementRenameDraft.trim()) {
            return;
        }
        this.requirementService.rename(requirementId, this.requirementRenameDraft);
        this.cancelRequirementRename();
    }

    protected moveTaskToRequirement(taskId: string, targetRequirementId: string): void {
        const session = this.host.sessions.selectedSession();
        if (!session || session.archived) {
            return;
        }
        const moved = this.requirementService.moveTask(taskId, targetRequirementId);
        if (!moved) {
            return;
        }
        session.selectedResultsRequirementId = moved.id;
        session.selectedResultsTaskId = taskId;
        this.expandedRequirementIds.add(moved.id);
        this.host.state.openResultsMenuKey = undefined;
        void this.host.sessions.persistWindowState();
        void this.host.sessions.persistResultsQaPanelState();
        this.update();
    }

    protected splitTaskToNewRequirement(taskId: string): void {
        const session = this.host.sessions.selectedSession();
        if (!session || session.archived) {
            return;
        }
        const requirement = this.requirementService.splitTaskToNew(taskId);
        if (!requirement) {
            return;
        }
        session.selectedResultsRequirementId = requirement.id;
        session.selectedResultsTaskId = undefined;
        session.requirementDraft = requirement.id;
        this.expandedRequirementIds.add(requirement.id);
        this.host.state.openResultsMenuKey = undefined;
        void this.host.sessions.persistWindowState();
        void this.host.sessions.persistResultsQaPanelState();
        this.beginSplitRequirementRename(requirement);
    }

    public undoAutomaticRequirementSplit(taskId: string): void {
        if (this.host.sessions.selectedSession()?.archived
            || !this.requirementClassificationService.undo(taskId)) {
            return;
        }
        void this.host.sessions.persistWindowState();
        void this.host.sessions.persistResultsQaPanelState();
        this.update();
    }

    protected closeResultsPanelsForSelection(session: WindowAgentSession): void {
        const scopeKey = this.host.sessions.selectedResultsScopeKey(session);
        if (scopeKey) {
            session.resultsQaExpanded.delete(scopeKey);
        }
        this.resultsAuxiliaryPanel = undefined;
        this.resultsAuxiliaryScopeKey = undefined;
        this.resultsAuxiliaryTrigger = undefined;
        this.host.state.openResultsMenuKey = undefined;
    }

    protected closeResultsQuestionPanel(scopeKey: string): void {
        const trigger = this.resultsAuxiliaryTrigger;
        this.setResultsQuestionPanelExpanded(scopeKey, false);
        requestAnimationFrame(() => {
            const fallback = this.node.querySelector<HTMLElement>('#poiesis-results-question-trigger');
            (trigger?.isConnected ? trigger : fallback)?.focus();
        });
    }

    protected setResultsQuestionPanelExpanded(scopeKey: string, expanded: boolean, revealLatest = false): void {
        const session = this.host.sessions.selectedSession();
        if (!session || this.host.sessions.selectedResultsScopeKey(session) !== scopeKey) {
            return;
        }
        if (expanded) {
            session.resultsQaExpanded.set(scopeKey, true);
        } else {
            session.resultsQaExpanded.delete(scopeKey);
        }
        this.host.sessions.persistResultsQaPanelState();
        this.update();
        if (expanded && revealLatest) {
            requestAnimationFrame(() => {
                if (this.host.sessions.selectedSessionId !== session.id || this.host.sessions.selectedResultsScopeKey(this.host.sessions.selectedSession()) !== scopeKey) {
                    return;
                }
                const history = this.node.querySelector<HTMLElement>('.poiesis-results__qa-history');
                if (history) {
                    history.scrollTop = history.scrollHeight;
                }
            });
        }
    }

    protected beginDeleteResultsTask(taskId: string): void {
        if (this.host.sessions.selectedSession()?.archived
            || !this.host.sessions.finishedTasks().some(task => task.id === taskId)) {
            return;
        }
        this.deleteTaskConfirmationId = taskId;
        this.host.state.openResultsMenuKey = undefined;
        this.update();
    }

    protected cancelDeleteResultsTask(): void {
        this.deleteTaskConfirmationId = undefined;
        this.update();
    }

    protected async deleteResultsTask(taskId: string): Promise<void> {
        const session = this.host.sessions.selectedSession();
        if (!session
            || session.archived
            || this.deleteTaskConfirmationId !== taskId
            || !this.host.sessions.finishedTasks(session).some(task => task.id === taskId)) {
            return;
        }
        const deletedWasSelected = session.selectedResultsTaskId === taskId;
        const deletedTask = this.taskService.get(taskId);
        const previousRequirementId = deletedTask?.requirementId;
        session.taskIds = session.taskIds.filter(candidate => candidate !== taskId);
        session.resultsDrafts.delete(taskId);
        session.resultsNotices.delete(taskId);
        session.resultsQaExpanded.delete(taskId);
        this.resultsService.remove([taskId]);
        this.taskService.remove([taskId]);
        const newestRemainingTask = this.host.sessions.finishedTasks(session).at(-1);
        if (deletedWasSelected) {
            session.selectedResultsTaskId = undefined;
            session.selectedResultsRequirementId = previousRequirementId && this.requirementService.get(previousRequirementId)
                ? previousRequirementId
                : this.host.sessions.latestRequirement(session)?.id;
        } else if (session.selectedResultsRequirementId
            && !this.requirementService.get(session.selectedResultsRequirementId)) {
            session.selectedResultsRequirementId = this.host.sessions.latestRequirement(session)?.id;
        }
        session.lastTaskStatus = newestRemainingTask?.status === 'running'
            ? undefined
            : newestRemainingTask?.status;
        if (!newestRemainingTask) {
            session.unreadTaskCompletion = false;
        }
        session.updatedAt = Date.now();
        this.deleteTaskConfirmationId = undefined;
        await Promise.all([this.host.sessions.persistWindowState(), this.host.sessions.persistResultsQaPanelState()]);
        this.update();
    }

    protected setResultsDraft(scopeKey: string, value: string): void {
        const session = this.host.sessions.selectedSession();
        if (!session || session.archived) {
            return;
        }
        if (session.resultsDrafts.get(scopeKey) === value) {
            return;
        }
        session.resultsDrafts.set(scopeKey, value);
        session.resultsNotices.delete(scopeKey);
        session.updatedAt = Date.now();
        this.host.sessions.persistWindowState();
        this.update();
    }

    protected async submitResultsQuestion(scopeKey: string, retryQuestion?: string): Promise<void> {
        const session = this.host.sessions.selectedSession();
        if (!session || session.archived) {
            return;
        }
        const requirementId = scopeKey.startsWith('requirement:') ? scopeKey.slice('requirement:'.length) : undefined;
        const requirement = requirementId ? this.requirementService.get(requirementId) : undefined;
        const task = requirement ? this.host.sessions.finishedTasksForRequirement(requirement).at(-1) : this.taskService.get(scopeKey);
        const document = requirement
            ? this.resultsService.getRequirement(requirement.id)
            : this.resultsService.get(scopeKey);
        const changeSet = requirement
            ? await this.resultsService.requirementChangeSet(requirement.id)
            : task?.changeSet;
        const question = retryQuestion?.trim() || session?.resultsDrafts.get(scopeKey)?.trim();
        const currentNotice = session?.resultsNotices.get(scopeKey);
        if (!session.workspaceUri
            || !task
            || task.status === 'running'
            || requirement && requirement.sessionId !== session.id
            || !requirement && !this.host.sessions.finishedTasks(session).some(candidate => candidate.id === scopeKey)
            || document?.status !== 'ready'
            || !document.html
            || !question
            || question.length > 4_000
            || currentNotice?.status === 'sending') {
            return;
        }
        session.selectedResultsRequirementId = requirement?.id ?? task.requirementId;
        session.selectedResultsTaskId = requirement ? undefined : task.id;
        this.resultsAuxiliaryPanel = undefined;
        this.resultsAuxiliaryScopeKey = undefined;
        this.resultsAuxiliaryTrigger = this.node.querySelector<HTMLElement>('#poiesis-results-question-trigger') ?? undefined;
        session.resultsDrafts.set(scopeKey, '');
        session.resultsNotices.set(scopeKey, { question, status: 'sending', text: '' });
        session.resultsQaExpanded.set(scopeKey, true);
        session.updatedAt = Date.now();
        this.host.sessions.persistWindowState();
        this.host.sessions.persistResultsQaPanelState();
        this.update();
        requestAnimationFrame(() => {
            const history = this.node.querySelector<HTMLElement>('.poiesis-results__qa-history');
            if (this.host.sessions.selectedSessionId === session.id && this.host.sessions.selectedResultsScopeKey(session) === scopeKey && history) {
                history.scrollTop = history.scrollHeight;
            }
        });
        try {
            const result = await this.resultsQuestionService.ask(question, {
                taskId: scopeKey,
                requirementTitle: requirement?.title,
                providerId: this.host.state.resultsCli,
                model: this.host.state.resultsModel.trim() || undefined,
                effort: this.host.state.resultsEffort || undefined,
                workspaceUri: session.workspaceUri,
                taskMetadata: {
                    title: task.title,
                    request: task.request,
                    status: task.status,
                    startedAt: task.startedAt,
                    endedAt: task.endedAt
                },
                changeSetSummary: JSON.stringify({
                    requirement: requirement?.title,
                    tasks: requirement ? this.host.sessions.finishedTasksForRequirement(requirement).length : undefined,
                    files: summarizeTaskChangeSet(changeSet).files,
                    captureError: changeSet?.error
                }, undefined, 2),
                diff: this.truncateResultsReference(changeSet?.diff ?? '', 40_000, 'Diff'),
                executionEvidence: requirement
                    ? formatRequirementExecutionEvidence(this.host.sessions.finishedTasksForRequirement(requirement), 16_000) || undefined
                    : formatExecutionEvidence(task.activities, 8_000) || undefined,
                resultsHtml: document.html,
                history: (requirement?.resultsQuestions ?? task.resultsQuestions ?? []).slice(-6)
            });
            if (result.status === 'answered') {
                const entry = {
                    question,
                    answer: result.answer,
                    timestamp: new Date().toISOString()
                };
                requirement
                    ? this.requirementService.recordResultsQuestion(requirement.id, entry)
                    : this.taskService.recordResultsQuestion(task.id, entry);
                session.resultsNotices.set(scopeKey, {
                    question,
                    status: 'answered',
                    text: result.answer
                });
            } else if (result.status === 'failed') {
                const entry = {
                    question,
                    error: result.error.message,
                    timestamp: new Date().toISOString()
                };
                const history = requirement
                    ? this.requirementService.recordResultsQuestion(requirement.id, entry)
                    : this.taskService.recordResultsQuestion(task.id, entry);
                session.resultsNotices.set(scopeKey, {
                    question,
                    status: 'failed',
                    text: result.error.message,
                    historyTimestamp: history?.timestamp
                });
            } else {
                session.resultsDrafts.set(scopeKey, question);
                session.resultsNotices.delete(scopeKey);
            }
        } catch {
            const text = '回答を作成できませんでした。もう一度お試しください。';
            const entry = {
                question,
                error: text,
                timestamp: new Date().toISOString()
            };
            const history = requirement
                ? this.requirementService.recordResultsQuestion(requirement.id, entry)
                : this.taskService.recordResultsQuestion(task.id, entry);
            session.resultsNotices.set(scopeKey, {
                question,
                status: 'failed',
                text,
                historyTimestamp: history?.timestamp
            });
        }
        this.host.sessions.persistWindowState();
        this.host.sessions.persistResultsQaPanelState();
        this.update();
        requestAnimationFrame(() => {
            const history = this.node.querySelector<HTMLElement>('.poiesis-results__qa-history');
            if (this.host.sessions.selectedSessionId === session.id && this.host.sessions.selectedResultsScopeKey(session) === scopeKey && history) {
                history.scrollTop = history.scrollHeight;
            }
        });
    }

    protected async retryResults(taskId: string): Promise<void> {
        const task = this.taskService.get(taskId);
        const session = task ? this.host.sessions.findSessionForTask(task) : undefined;
        if (session?.archived) {
            return;
        }
        await this.resultsService.retry(taskId);
    }

    protected async retryRequirementResults(requirementId: string): Promise<void> {
        const requirement = this.requirementService.get(requirementId);
        const session = requirement
            ? this.host.sessions.sessions.find(candidate => candidate.id === requirement.sessionId)
            : undefined;
        if (session?.archived) {
            return;
        }
        await this.resultsService.retryRequirement(requirementId);
    }

    public async retryTask(taskId: string): Promise<void> {
        const task = this.taskService.get(taskId);
        const session = task ? this.host.sessions.sessions.find(candidate => candidate.taskIds.includes(task.id)) : undefined;
        if (!task || !session || session.archived || this.host.sessions.runningTask(session)) {
            return;
        }
        this.host.detachCodeWidgets();
        this.host.closeCustomize(false);
        this.host.state.codeMode = false;
        this.host.sessions.selectedSessionId = session.id;
        session.activeTab = 'agent';
        session.selectedResultsTaskId = undefined;
        session.requirementDraft = task.requirementId;
        this.host.sessions.persistResultsQaPanelState();
        session.agentDraft = task.request;
        this.host.sessions.persistWindowState();
        this.update();
        await this.host.sendAgentMessage();
    }

    protected truncateResultsReference(value: string, maxChars: number, label: string): string | undefined {
        if (!value) {
            return undefined;
        }
        if (value.length <= maxChars) {
            return value;
        }
        const marker = `\n[${label} truncated; original length: ${value.length} characters]`;
        return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`.slice(0, maxChars);
    }

    constructor(host: AgentWindowHost) {
        super(host);
    }
}
