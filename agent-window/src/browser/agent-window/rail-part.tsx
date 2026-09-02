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

interface PickerAnchor {
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
}

interface WorkspaceSessionGroup {
    key: string;
    workspaceUri?: string;
    name: string;
    branch: string;
    current: boolean;
    activeSessions: WindowAgentSession[];
    archivedSessions: WindowAgentSession[];
}

const DEFAULT_RAIL_WIDTH = 258;
const MIN_RAIL_WIDTH = 196;
const MAX_RAIL_WIDTH = 420;

export class RailPart extends AgentWindowPart {
    protected deleteSessionConfirmationId?: string;

    protected railCollapsed = false;

    protected railWidth = DEFAULT_RAIL_WIDTH;

    protected openSessionMenuId?: string;

    protected renamingSessionId?: string;

    protected renameDraft = '';

    protected showArchivedSessions = false;

    protected sessionSearchVisible = false;

    protected sessionSearchQuery = '';

    protected readonly expandedWorkspaceGroups = new Set<string>();

    protected sessionSearchInput?: HTMLInputElement;

    protected workspacePickerVisible = false;

    protected workspacePickerAnchor?: PickerAnchor;

    protected workspaceSearchQuery = '';

    protected workspaceSearchInput?: HTMLInputElement;

    protected recentWorkspaceUris: string[] = [];

    protected repositoryPickerVisible = false;

    protected repositoryPickerAnchor?: PickerAnchor;

    protected repositorySearchQuery = '';

    protected repositorySearchInput?: HTMLInputElement;

    protected folderExplorerVisible = false;

    protected folderExplorerSessionId?: string;

    protected folderExplorerResult?: FolderBrowserResult;

    protected folderExplorerLoading = false;

    protected folderExplorerError?: string;

    protected folderExplorerAddress = '';

    protected creatingFolder = false;

    protected newFolderName = '';

    protected railResizeCleanup?: Disposable;

    protected renderRail(): React.ReactNode {
        const workspaceGroups = this.workspaceSessionGroups();
        const toggleLabel = this.railCollapsed ? '左サイドバーを展開' : '左サイドバーを折りたたむ';
        return (
            <aside
                className='poiesis-agent-window__rail'
                data-collapsed={this.railCollapsed ? 'true' : 'false'}
                aria-label='セッションのサイドバー'
            >
                <div className='poiesis-agent-window__rail-top'>
                    <div className='poiesis-agent-window__rail-controls'>
                        <button
                            type='button'
                            className='poiesis-agent-window__rail-toggle'
                            title={toggleLabel}
                            aria-label={toggleLabel}
                            onClick={() => this.toggleRail()}
                        >
                            <span
                                className={`codicon ${this.railCollapsed
                                    ? 'codicon-layout-sidebar-left'
                                    : 'codicon-layout-sidebar-left-off'}`}
                                aria-hidden='true'
                            />
                        </button>
                    </div>
                    <button
                        type='button'
                        className='poiesis-agent-window__rail-action'
                        title='新しいチャット'
                        onClick={() => void this.newChat()}
                    >
                        <span className='poiesis-agent-window__rail-action-icon' aria-hidden='true'>
                            <span className='codicon codicon-comment-add' />
                        </span>
                        <span className='poiesis-agent-window__rail-action-label'>新しいチャット</span>
                    </button>
                    <button
                        type='button'
                        className={`poiesis-agent-window__rail-action${this.sessionSearchVisible ? ' pressed' : ''}`}
                        aria-pressed={this.sessionSearchVisible}
                        aria-expanded={this.sessionSearchVisible && !this.railCollapsed}
                        aria-controls='poiesis-agent-window-session-search'
                        title='検索'
                        onClick={() => this.showSessionSearch()}
                    >
                        <span className='poiesis-agent-window__rail-action-icon' aria-hidden='true'>
                            <span className='codicon codicon-search' />
                        </span>
                        <span className='poiesis-agent-window__rail-action-label'>検索</span>
                    </button>
                    <button
                        type='button'
                        className={`poiesis-agent-window__rail-action${this.customizeViewVisible ? ' active' : ''}`}
                        title='カスタマイズ'
                        aria-current={this.customizeViewVisible ? 'page' : undefined}
                        onClick={() => this.openCustomize()}
                    >
                        <span className='poiesis-agent-window__rail-action-icon' aria-hidden='true'>
                            <span className='codicon codicon-tools' />
                        </span>
                        <span className='poiesis-agent-window__rail-action-label'>カスタマイズ</span>
                    </button>
                    {this.sessionSearchVisible && !this.railCollapsed && (
                        <label className='poiesis-agent-window__session-search' id='poiesis-agent-window-session-search'>
                            <span className='codicon codicon-search' aria-hidden='true' />
                            <PoiesisTextInput
                                elementRef={this.setSessionSearchInput}
                                type='search'
                                value={this.sessionSearchQuery}
                                placeholder='会話を検索'
                                aria-label='会話を検索'
                                onValueChange={value => this.setSessionSearchQuery(value)}
                                onKeyDown={event => {
                                    if (event.key === 'Escape') {
                                        this.closeSessionSearch();
                                    }
                                }}
                            />
                        </label>
                    )}
                </div>
                <div className='poiesis-agent-window__rail-heading'>
                    <span>ワークスペース</span>
                    <button
                        type='button'
                        className='poiesis-agent-window__repository-open'
                        title='フォルダーを開く'
                        aria-label='フォルダーを開く'
                        aria-expanded={this.workspacePickerVisible}
                        aria-controls='poiesis-agent-window-workspace-picker'
                        onClick={event => this.toggleWorkspacePicker(event.currentTarget)}
                    >
                        <span className='codicon codicon-add' aria-hidden='true' />
                    </button>
                </div>
                <div className='poiesis-agent-window__sessions'>
                    {workspaceGroups.map(group => this.renderWorkspaceSessionGroup(group))}
                </div>
                <div className='poiesis-agent-window__rail-footer'>
                    <span className='poiesis-agent-window__rail-footer-label'>Poiesis</span>
                    <div className='poiesis-agent-window__rail-footer-actions'>
                        <button type='button' title='設定' aria-label='設定' onClick={() => this.openSettings()}>
                            <span className='codicon codicon-settings-gear' aria-hidden='true' />
                        </button>
                    </div>
                </div>
                {!this.railCollapsed && (
                    <div
                        className='poiesis-agent-window__rail-resize-handle'
                        role='separator'
                        aria-label='サイドバーの幅を変更'
                        aria-orientation='vertical'
                        aria-valuemin={MIN_RAIL_WIDTH}
                        aria-valuemax={MAX_RAIL_WIDTH}
                        aria-valuenow={this.railWidth}
                        tabIndex={0}
                        onPointerDown={event => this.startRailResize(event)}
                        onDoubleClick={() => this.resetRailWidth()}
                        onKeyDown={event => this.resizeRailWithKeyboard(event)}
                    />
                )}
            </aside>
        );
    }

    protected workspaceSessionGroups(): WorkspaceSessionGroup[] {
        const currentWorkspaceUri = this.workspaceRoot()?.resource.toString();
        const groups = new Map<string, WorkspaceSessionGroup>();
        const ensureGroup = (workspaceUri?: string): WorkspaceSessionGroup => {
            const key = this.workspaceGroupKey(workspaceUri);
            let group = groups.get(key);
            if (!group) {
                const resource = workspaceUri ? new URI(workspaceUri) : undefined;
                group = {
                    key,
                    workspaceUri,
                    name: resource?.path.base || resource?.displayName || 'ワークスペースなし',
                    branch: this.sameWorkspaceUri(workspaceUri, currentWorkspaceUri)
                        ? this.gitBranchForWorkspace(workspaceUri) ?? this.currentGitBranch() ?? 'main'
                        : 'main',
                    current: this.sameWorkspaceUri(workspaceUri, currentWorkspaceUri),
                    activeSessions: [],
                    archivedSessions: []
                };
                groups.set(key, group);
            }
            return group;
        };
        if (currentWorkspaceUri) {
            ensureGroup(currentWorkspaceUri);
        }
        for (const session of this.filteredSessions(false).filter(candidate => candidate.hasUserMessage)) {
            const group = ensureGroup(session.workspaceUri);
            group.activeSessions.push(session);
            group.branch = session.branch ?? group.branch;
        }
        for (const session of this.filteredSessions(true).filter(candidate => candidate.hasUserMessage)) {
            const group = ensureGroup(session.workspaceUri);
            group.archivedSessions.push(session);
            group.branch = session.branch ?? group.branch;
        }
        return [...groups.values()].sort((left, right) => {
            if (left.current !== right.current) {
                return left.current ? -1 : 1;
            }
            const latest = (group: WorkspaceSessionGroup): number => Math.max(
                0,
                ...group.activeSessions.map(session => session.updatedAt),
                ...group.archivedSessions.map(session => session.updatedAt)
            );
            return latest(right) - latest(left) || left.name.localeCompare(right.name);
        });
    }

    protected renderWorkspaceSessionGroup(group: WorkspaceSessionGroup): React.ReactNode {
        const expanded = this.expandedWorkspaceGroups.has(group.key);
        const pinnedSessions = group.activeSessions.filter(session => session.pinned);
        const recentSessions = group.activeSessions.filter(session => !session.pinned);
        return (
            <div className={`poiesis-agent-window__workspace-group${group.current ? ' current' : ''}`} key={group.key}>
                <button
                    type='button'
                    className='poiesis-agent-window__workspace-name'
                    aria-expanded={expanded}
                    onClick={() => this.toggleWorkspaceGroup(group.key)}
                >
                    <span className='codicon codicon-folder-opened' aria-hidden='true' />
                    <span className='poiesis-agent-window__workspace-name-copy'>
                        <strong>{group.name}</strong>
                        <small>Local · {group.branch}</small>
                    </span>
                    <span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} aria-hidden='true' />
                </button>
                {expanded && pinnedSessions.length > 0 && (
                    <div className='poiesis-agent-window__session-section-label'>ピン留め</div>
                )}
                {expanded && pinnedSessions.map(session => this.renderSessionRow(session))}
                {expanded && pinnedSessions.length > 0 && recentSessions.length > 0 && (
                    <div className='poiesis-agent-window__session-section-label'>最近</div>
                )}
                {expanded && recentSessions.map(session => this.renderSessionRow(session))}
                {expanded && !group.activeSessions.length && (
                    <div className='poiesis-agent-window__session-empty'>
                        {this.sessionSearchQuery.trim() ? '一致する会話はありません。' : 'セッションはありません。'}
                    </div>
                )}
                {expanded && group.archivedSessions.length > 0 && (
                    <>
                        <button
                            type='button'
                            className='poiesis-agent-window__archived-toggle'
                            aria-expanded={this.showArchivedSessions}
                            onClick={() => this.toggleArchivedSessions()}
                        >
                            <span className={`codicon codicon-chevron-${this.showArchivedSessions ? 'down' : 'right'}`} aria-hidden='true' />
                            <span>アーカイブ</span>
                            <small>{group.archivedSessions.length}</small>
                        </button>
                        {this.showArchivedSessions && group.archivedSessions.map(session => this.renderSessionRow(session))}
                    </>
                )}
            </div>
        );
    }

    protected workspaceGroupKey(workspaceUri: string | undefined): string {
        return this.canonicalWorkspaceUri(workspaceUri) ?? '__no-workspace__';
    }

    protected canonicalWorkspaceUri(workspaceUri: string | undefined): string | undefined {
        if (!workspaceUri) {
            return undefined;
        }
        try {
            return new URI(workspaceUri).toString();
        } catch {
            return workspaceUri;
        }
    }

    protected sameWorkspaceUri(left: string | undefined, right: string | undefined): boolean {
        return this.canonicalWorkspaceUri(left) === this.canonicalWorkspaceUri(right);
    }

    protected renderSessionRow(session: WindowAgentSession): React.ReactNode {
        const selected = session.id === this.selectedSessionId;
        const renaming = session.id === this.renamingSessionId;
        const menuOpen = session.id === this.openSessionMenuId;
        const state = this.sessionState(session);
        const running = state.kind === 'running';
        const switchesWorkspace = Boolean(session.workspaceUri
            && !this.sameWorkspaceUri(session.workspaceUri, this.workspaceRoot()?.resource.toString()));
        return (
            <div
                key={session.id}
                className={`poiesis-agent-window__session-row${selected ? ' active' : ''}${session.archived ? ' archived' : ''}`}
                data-session-id={session.id}
                data-session-archived={session.archived ? 'true' : 'false'}
                data-session-pinned={session.pinned ? 'true' : 'false'}
            >
                {renaming ? (
                    <PoiesisTextInput
                        className='poiesis-agent-window__session-rename'
                        value={this.renameDraft}
                        aria-label='セッション名を変更'
                        autoFocus
                        onValueChange={value => {
                            this.renameDraft = value;
                            this.update();
                        }}
                        onBlur={() => this.commitSessionRename(session.id)}
                        onKeyDown={event => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                this.commitSessionRename(session.id);
                            } else if (event.key === 'Escape') {
                                event.preventDefault();
                                this.cancelSessionRename();
                            }
                        }}
                    />
                ) : (
                    <button
                        type='button'
                        className='poiesis-agent-window__session'
                        title={switchesWorkspace
                            ? `${session.title} ・ ${this.repositoryLabel(session.workspaceUri)}へ切り替え`
                            : session.title}
                        aria-current={selected ? 'true' : undefined}
                        onClick={() => session.archived ? this.restoreSession(session.id, true) : this.selectSession(session.id)}
                    >
                        {session.pinned && <span className='codicon codicon-pinned' aria-label='ピン留め済み' />}
                        <span className={`poiesis-agent-window__status-dot ${state.kind}`} aria-hidden='true' />
                        <span className='poiesis-agent-window__session-copy'>
                            <span className='poiesis-agent-window__session-title'>{session.title}</span>
                            {state.label && <small className={`poiesis-agent-window__session-meta ${state.kind}`}>{state.label}</small>}
                        </span>
                        <time className='poiesis-agent-window__session-time'>{this.sessionMeta(session)}</time>
                    </button>
                )}
                {!renaming && (
                    <div className='poiesis-agent-window__session-actions'>
                        <button
                            type='button'
                            className='poiesis-agent-window__session-menu-trigger'
                            title='その他の操作'
                            aria-label={`${session.title}のその他の操作`}
                            aria-haspopup='menu'
                            aria-expanded={menuOpen}
                            onClick={() => this.toggleSessionMenu(session.id)}
                        >
                            <span className='codicon codicon-more' aria-hidden='true' />
                        </button>
                        {menuOpen && (
                            <div className='poiesis-agent-window__session-menu' role='menu'>
                                {session.archived ? (
                                    <>
                                        <button type='button' role='menuitem' onClick={() => this.restoreSession(session.id)}>
                                            <span className='codicon codicon-archive' aria-hidden='true' />復元
                                        </button>
                                        {this.deleteSessionConfirmationId === session.id ? (
                                            <div className='poiesis-agent-window__inline-confirm' role='group' aria-label='完全削除の確認'>
                                                <span>取り消せません</span>
                                                <button type='button' className='danger' onClick={() => void this.deleteSession(session.id)}>削除</button>
                                                <button type='button' onClick={() => this.cancelDeleteSession()}>戻る</button>
                                            </div>
                                        ) : (
                                            <button type='button' role='menuitem' className='danger' onClick={() => this.beginDeleteSession(session.id)}>
                                                <span className='codicon codicon-trash' aria-hidden='true' />完全に削除
                                            </button>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <button type='button' role='menuitem' onClick={() => this.togglePinnedSession(session.id)}>
                                            <span className={`codicon codicon-${session.pinned ? 'pinned-dirty' : 'pin'}`} aria-hidden='true' />
                                            {session.pinned ? 'ピン留めを外す' : 'ピン留め'}
                                        </button>
                                        <button type='button' role='menuitem' onClick={() => this.beginSessionRename(session.id)}>
                                            <span className='codicon codicon-edit' aria-hidden='true' />名前を変更
                                        </button>
                                        <button type='button' role='menuitem' disabled={running} onClick={() => void this.archiveSession(session.id)}>
                                            <span className='codicon codicon-archive' aria-hidden='true' />
                                            {running ? '実行中はアーカイブ不可' : 'アーカイブ'}
                                        </button>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    }

    protected readonly setSessionSearchInput = (input: HTMLInputElement | null): void => {
        this.sessionSearchInput = input ?? undefined;
    };

    protected filteredSessions(archived: boolean): WindowAgentSession[] {
        const query = this.sessionSearchQuery.trim().toLocaleLowerCase();
        return this.sessions
            .filter(session => session.archived === archived)
            .filter(session => !query
                || session.title.toLocaleLowerCase().includes(query)
                || session.messages.some(message => message.content.toLocaleLowerCase().includes(query)))
            .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt);
    }

    protected toggleSessionMenu(sessionId: string): void {
        this.openSessionMenuId = this.openSessionMenuId === sessionId ? undefined : sessionId;
        this.update();
    }

    protected beginSessionRename(sessionId: string): void {
        const session = this.sessions.find(candidate => candidate.id === sessionId);
        if (!session) {
            return;
        }
        this.openSessionMenuId = undefined;
        this.renamingSessionId = sessionId;
        this.renameDraft = session.title;
        this.update();
    }

    protected commitSessionRename(sessionId: string): void {
        if (this.renamingSessionId !== sessionId) {
            return;
        }
        const session = this.sessions.find(candidate => candidate.id === sessionId);
        const title = this.renameDraft.replace(/\s+/g, ' ').trim();
        if (session && title) {
            session.title = title.slice(0, 80);
            session.updatedAt = Date.now();
        }
        this.renamingSessionId = undefined;
        this.renameDraft = '';
        this.persistWindowState();
        this.update();
    }

    protected cancelSessionRename(): void {
        this.renamingSessionId = undefined;
        this.renameDraft = '';
        this.update();
    }

    protected togglePinnedSession(sessionId: string): void {
        const session = this.sessions.find(candidate => candidate.id === sessionId && !candidate.archived);
        if (!session) {
            return;
        }
        session.pinned = !session.pinned;
        session.updatedAt = Date.now();
        this.openSessionMenuId = undefined;
        this.persistWindowState();
        this.update();
    }

    protected async archiveSession(sessionId: string): Promise<void> {
        const session = this.sessions.find(candidate => candidate.id === sessionId && !candidate.archived);
        if (!session || this.runningTask(session)) {
            return;
        }
        session.archived = true;
        session.pinned = false;
        session.updatedAt = Date.now();
        this.openSessionMenuId = undefined;
        if (this.selectedSessionId === sessionId) {
            const next = this.filteredSessions(false)[0];
            this.selectedSessionId = next?.id;
            if (!next) {
                await this.createSession();
                return;
            }
        }
        this.persistWindowState();
        this.update();
    }

    protected restoreSession(sessionId: string, select = false): void {
        const session = this.sessions.find(candidate => candidate.id === sessionId && candidate.archived);
        if (!session) {
            return;
        }
        session.archived = false;
        session.updatedAt = Date.now();
        this.openSessionMenuId = undefined;
        if (select) {
            session.activeTab = 'agent';
            this.selectSession(session.id);
            return;
        }
        this.persistWindowState();
        this.update();
    }

    protected beginDeleteSession(sessionId: string): void {
        this.deleteSessionConfirmationId = sessionId;
        this.update();
    }

    protected cancelDeleteSession(): void {
        this.deleteSessionConfirmationId = undefined;
        this.update();
    }

    protected async deleteSession(sessionId: string): Promise<void> {
        const session = this.sessions.find(candidate => candidate.id === sessionId && candidate.archived);
        if (!session || this.deleteSessionConfirmationId !== sessionId) {
            return;
        }
        for (const [taskId, notice] of session.resultsNotices) {
            if (notice.status === 'sending') {
                await this.resultsQuestionService.cancel(taskId);
            }
        }
        this.taskService.remove(session.taskIds);
        this.resultsService.remove(session.taskIds);
        this.disposeAgentRichContentForSession(session.id);
        const index = this.sessions.indexOf(session);
        if (index !== -1) {
            this.sessions.splice(index, 1);
        }
        this.openSessionMenuId = undefined;
        this.deleteSessionConfirmationId = undefined;
        this.persistWindowState();
        this.persistResultsQaPanelState();
        this.update();
    }

    protected toggleArchivedSessions(): void {
        this.showArchivedSessions = !this.showArchivedSessions;
        this.update();
    }

    protected startRailResize(event: React.PointerEvent<HTMLDivElement>): void {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = this.railWidth;
        const resize = (moveEvent: PointerEvent): void => {
            this.railWidth = this.clampRailWidth(startWidth + moveEvent.clientX - startX);
            this.update();
        };
        const finish = (): void => {
            this.railResizeCleanup?.dispose();
            this.railResizeCleanup = undefined;
            this.persistWindowState();
        };
        this.railResizeCleanup?.dispose();
        document.body.classList.add('poiesis-is-resizing-rail');
        document.addEventListener('pointermove', resize);
        document.addEventListener('pointerup', finish, { once: true });
        this.railResizeCleanup = Disposable.create(() => {
            document.body.classList.remove('poiesis-is-resizing-rail');
            document.removeEventListener('pointermove', resize);
            document.removeEventListener('pointerup', finish);
        });
    }

    protected resizeRailWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>): void {
        const delta = event.key === 'ArrowLeft' ? -12 : event.key === 'ArrowRight' ? 12 : 0;
        if (!delta && event.key !== 'Home' && event.key !== 'End') {
            return;
        }
        event.preventDefault();
        this.railWidth = event.key === 'Home'
            ? MIN_RAIL_WIDTH
            : event.key === 'End'
                ? MAX_RAIL_WIDTH
                : this.clampRailWidth(this.railWidth + delta);
        this.persistWindowState();
        this.update();
    }

    protected resetRailWidth(): void {
        this.railWidth = DEFAULT_RAIL_WIDTH;
        this.persistWindowState();
        this.update();
    }

    protected clampRailWidth(width: number): number {
        return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(width)));
    }

    protected toggleRail(): void {
        this.railCollapsed = !this.railCollapsed;
        this.persistWindowState();
        this.update();
        if (!this.railCollapsed && this.sessionSearchVisible) {
            requestAnimationFrame(() => this.sessionSearchInput?.focus());
        }
    }

    protected showSessionSearch(): void {
        this.railCollapsed = false;
        this.sessionSearchVisible = true;
        this.update();
        requestAnimationFrame(() => this.sessionSearchInput?.focus());
    }

    protected closeSessionSearch(): void {
        this.sessionSearchVisible = false;
        this.sessionSearchQuery = '';
        this.update();
    }

    protected setSessionSearchQuery(value: string): void {
        this.sessionSearchQuery = value;
        this.update();
    }

    protected toggleWorkspaceGroup(groupKey: string): void {
        if (this.expandedWorkspaceGroups.has(groupKey)) {
            this.expandedWorkspaceGroups.delete(groupKey);
        } else {
            this.expandedWorkspaceGroups.add(groupKey);
        }
        this.update();
    }

    protected repositoryChoices(): Array<{ uri: string; name: string; path: string }> {
        return this.workspaceService.tryGetRoots().map(root => ({
            uri: root.resource.toString(),
            name: root.resource.path.base || root.resource.displayName,
            path: root.resource.path.fsPath()
        }));
    }

    protected toggleWorkspacePicker(anchor: HTMLElement): void {
        this.workspacePickerVisible = !this.workspacePickerVisible;
        this.repositoryPickerVisible = false;
        this.repositoryPickerAnchor = undefined;
        this.workspaceSearchQuery = '';
        this.workspacePickerAnchor = this.workspacePickerVisible
            ? this.pickerAnchor(anchor, 'right')
            : undefined;
        this.update();
        if (this.workspacePickerVisible) {
            requestAnimationFrame(() => this.workspaceSearchInput?.focus());
        }
    }

    protected async refreshRecentWorkspaces(): Promise<void> {
        try {
            this.recentWorkspaceUris = await this.workspaceService.recentWorkspaces();
            this.update();
        } catch {
            this.recentWorkspaceUris = [];
        }
    }

    protected workspaceChoices(): Array<{ uri: string; name: string; path: string; current: boolean }> {
        const currentUris = new Set(this.repositoryChoices().map(choice => this.workspaceGroupKey(choice.uri)));
        const choices = this.repositoryChoices().map(choice => ({ ...choice, current: true }));
        for (const workspaceUri of this.recentWorkspaceUris) {
            if (currentUris.has(this.workspaceGroupKey(workspaceUri))) {
                continue;
            }
            const resource = new URI(workspaceUri);
            choices.push({
                uri: workspaceUri,
                name: resource.path.base || resource.displayName,
                path: resource.path.fsPath(),
                current: false
            });
        }
        return choices;
    }

    protected setWorkspaceSearchQuery(value: string): void {
        this.workspaceSearchQuery = value;
        this.update();
        requestAnimationFrame(() => {
            this.workspaceSearchInput?.focus();
            this.workspaceSearchInput?.setSelectionRange(value.length, value.length);
        });
    }

    protected renderWorkspacePicker(): React.ReactNode {
        const query = this.workspaceSearchQuery.trim().toLocaleLowerCase();
        const choices = this.workspaceChoices().filter(choice => !query
            || choice.name.toLocaleLowerCase().includes(query)
            || choice.path.toLocaleLowerCase().includes(query));
        const currentChoices = choices.filter(choice => choice.current);
        const recentChoices = choices.filter(choice => !choice.current);
        return (
            <div
                className='poiesis-agent-window__workspace-picker'
                id='poiesis-agent-window-workspace-picker'
                role='dialog'
                aria-label='ワークスペースを開く'
                style={this.workspacePickerAnchor}
            >
                <div className='poiesis-agent-window__workspace-picker-title'>ワークスペースを開く</div>
                <label className='poiesis-agent-window__workspace-picker-search'>
                    <span className='codicon codicon-search' aria-hidden='true' />
                    <PoiesisTextInput
                        elementRef={input => { this.workspaceSearchInput = input ?? undefined; }}
                        value={this.workspaceSearchQuery}
                        placeholder='ワークスペースを検索'
                        aria-label='ワークスペースを検索'
                        onValueChange={value => this.setWorkspaceSearchQuery(value)}
                        onKeyDown={event => {
                            if (event.key === 'Escape') {
                                this.workspacePickerVisible = false;
                                this.workspacePickerAnchor = undefined;
                                this.workspaceSearchQuery = '';
                                this.update();
                            }
                        }}
                    />
                </label>
                {currentChoices.length > 0 && (
                    <>
                        <div className='poiesis-agent-window__workspace-picker-label'>この PC</div>
                        {currentChoices.map(choice => (
                            <button
                                type='button'
                                className='poiesis-agent-window__workspace-picker-item'
                                key={choice.uri}
                                onClick={() => this.openKnownWorkspace(choice.uri)}
                            >
                                <span className='codicon codicon-folder-opened' aria-hidden='true' />
                                <span><strong>{choice.name}</strong><small>{choice.path}</small></span>
                                <span className='codicon codicon-arrow-right' aria-hidden='true' />
                            </button>
                        ))}
                    </>
                )}
                {recentChoices.length > 0 && (
                    <>
                        <div className='poiesis-agent-window__workspace-picker-label'>最近</div>
                        {recentChoices.map(choice => (
                            <button
                                type='button'
                                className='poiesis-agent-window__workspace-picker-item'
                                key={choice.uri}
                                onClick={() => this.openKnownWorkspace(choice.uri)}
                            >
                                <span className='codicon codicon-history' aria-hidden='true' />
                                <span><strong>{choice.name}</strong><small>{choice.path}</small></span>
                                <span className='codicon codicon-arrow-right' aria-hidden='true' />
                            </button>
                        ))}
                    </>
                )}
                {choices.length === 0 && query && (
                    <div className='poiesis-agent-window__workspace-picker-empty'>一致するワークスペースはありません</div>
                )}
                <div className='poiesis-agent-window__workspace-picker-divider' />
                <button
                    type='button'
                    className='poiesis-agent-window__workspace-picker-item action'
                    onClick={() => void this.openRepository()}
                >
                    <span className='codicon codicon-folder-opened' aria-hidden='true' />
                    <span><strong>フォルダーを開く…</strong><small>この PC からフォルダーを選択</small></span>
                </button>
            </div>
        );
    }

    protected openKnownWorkspace(workspaceUri: string): void {
        this.workspacePickerVisible = false;
        this.workspacePickerAnchor = undefined;
        this.workspaceSearchQuery = '';
        this.workspaceService.open(new URI(workspaceUri), { preserveWindow: true });
    }

    protected repositoryLabel(workspaceUri: string | undefined): string {
        if (!workspaceUri) {
            return 'Repositoryを選択';
        }
        const known = this.repositoryChoices().find(choice => this.sameWorkspaceUri(choice.uri, workspaceUri));
        return known?.name ?? new URI(workspaceUri).path.base ?? 'Repository';
    }

    protected toggleRepositoryPicker(anchor: HTMLElement): void {
        this.repositoryPickerVisible = !this.repositoryPickerVisible;
        this.workspacePickerVisible = false;
        this.workspacePickerAnchor = undefined;
        this.repositorySearchQuery = '';
        this.repositoryPickerAnchor = this.repositoryPickerVisible
            ? this.pickerAnchor(anchor, 'above')
            : undefined;
        this.update();
        if (this.repositoryPickerVisible) {
            requestAnimationFrame(() => this.repositorySearchInput?.focus());
        }
    }

    protected closeNewAgentPickers(): void {
        this.repositoryPickerVisible = false;
        this.repositoryPickerAnchor = undefined;
        this.repositorySearchQuery = '';
        this.update();
    }

    protected pickerAnchor(anchor: HTMLElement, placement: 'right' | 'above'): PickerAnchor {
        const rect = anchor.getBoundingClientRect();
        const edge = 8;
        const width = Math.min(360, window.innerWidth - edge * 2);
        const left = placement === 'right'
            ? Math.min(Math.max(edge, rect.right + 8), window.innerWidth - width - edge)
            : Math.min(Math.max(edge, rect.left), window.innerWidth - width - edge);
        if (placement === 'above') {
            return {
                left,
                bottom: Math.max(edge, window.innerHeight - rect.top + 7),
                maxHeight: Math.max(180, Math.min(500, rect.top - edge * 2))
            };
        }
        const top = Math.min(Math.max(edge, rect.top), Math.max(edge, window.innerHeight - 240));
        return {
            left,
            top,
            maxHeight: Math.max(180, window.innerHeight - top - edge)
        };
    }

    protected setRepositorySearchQuery(value: string): void {
        this.repositorySearchQuery = value;
        this.update();
        requestAnimationFrame(() => {
            this.repositorySearchInput?.focus();
            this.repositorySearchInput?.setSelectionRange(value.length, value.length);
        });
    }

    protected selectRepository(session: WindowAgentSession, workspaceUri: string): void {
        if (session.hasUserMessage || session.agentSession) {
            return;
        }
        session.workspaceUri = workspaceUri;
        session.branch = this.gitBranchForWorkspace(workspaceUri) ?? 'main';
        session.updatedAt = Date.now();
        this.closeNewAgentPickers();
        this.persistWindowState();
    }

    protected async openFolderExplorer(session?: WindowAgentSession, createFolder = false): Promise<void> {
        this.folderExplorerVisible = true;
        this.folderExplorerSessionId = session?.id;
        this.folderExplorerError = undefined;
        this.creatingFolder = createFolder;
        this.newFolderName = '';
        this.update();
        await this.loadFolderExplorer(session?.workspaceUri
            ? new URI(session.workspaceUri).path.fsPath()
            : this.workspaceRoot()?.resource.path.fsPath());
    }

    protected async loadFolderExplorer(path?: string): Promise<void> {
        this.folderExplorerLoading = true;
        this.folderExplorerError = undefined;
        this.update();
        try {
            this.folderExplorerResult = await this.folderExplorerService.browse(path);
            this.folderExplorerAddress = this.folderExplorerResult.path;
        } catch (error) {
            this.folderExplorerError = `フォルダーを開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.folderExplorerLoading = false;
            this.update();
        }
    }

    protected closeFolderExplorer(): void {
        this.folderExplorerVisible = false;
        this.folderExplorerSessionId = undefined;
        this.folderExplorerError = undefined;
        this.creatingFolder = false;
        this.update();
    }

    protected async createFolderInExplorer(): Promise<void> {
        const parentPath = this.folderExplorerResult?.path;
        const name = this.newFolderName.trim();
        if (!parentPath || !name) {
            return;
        }
        this.folderExplorerLoading = true;
        this.folderExplorerError = undefined;
        this.update();
        try {
            const folderPath = await this.folderExplorerService.create(parentPath, name);
            this.creatingFolder = false;
            this.newFolderName = '';
            await this.loadFolderExplorer(folderPath);
        } catch (error) {
            this.folderExplorerLoading = false;
            this.folderExplorerError = `フォルダーを作成できませんでした: ${error instanceof Error ? error.message : String(error)}`;
            this.update();
        }
    }

    protected selectFolderFromExplorer(): void {
        const session = this.folderExplorerSessionId
            ? this.sessions.find(candidate => candidate.id === this.folderExplorerSessionId)
            : undefined;
        const selectedPath = this.folderExplorerResult?.path;
        if (!selectedPath || (this.folderExplorerSessionId && !session)) {
            return;
        }
        const folder = URI.fromFilePath(selectedPath);
        if (session) {
            session.workspaceUri = folder.toString();
            session.branch = 'main';
            session.updatedAt = Date.now();
        }
        this.repositoryPickerVisible = false;
        this.repositoryPickerAnchor = undefined;
        this.repositorySearchQuery = '';
        this.closeFolderExplorer();
        this.persistWindowState();
        this.workspaceService.open(folder, { preserveWindow: true });
    }

    protected async openRepository(): Promise<void> {
        this.workspacePickerVisible = false;
        this.workspacePickerAnchor = undefined;
        this.workspaceSearchQuery = '';
        await this.openFolderExplorer();
    }

    protected sessionMeta(session: WindowAgentSession): string {
        const ageInMinutes = Math.floor(Math.max(0, Date.now() - session.createdAt) / 60_000);
        if (ageInMinutes < 1) {
            return '今';
        }
        if (ageInMinutes < 60) {
            return `${ageInMinutes}分`;
        }
        const ageInHours = Math.floor(ageInMinutes / 60);
        return ageInHours < 24 ? `${ageInHours}時間` : `${Math.floor(ageInHours / 24)}日`;
    }

    protected sessionState(session: WindowAgentSession): {
        kind: 'running' | 'failed' | 'unread' | 'cancelled' | 'idle';
        label: string;
    } {
        if (this.runningTask(session)) {
            return { kind: 'running', label: '実行中' };
        }
        if (session.lastTaskStatus === 'failed') {
            return { kind: 'failed', label: '失敗' };
        }
        if (session.unreadTaskCompletion) {
            return { kind: 'unread', label: '完了 · 未読' };
        }
        if (session.lastTaskStatus === 'cancelled') {
            return { kind: 'cancelled', label: 'キャンセル' };
        }
        if (session.lastTaskStatus === 'completed') {
            return { kind: 'idle', label: '完了' };
        }
        return { kind: 'idle', label: '' };
    }

    protected renderFolderExplorer(): React.ReactNode {
        const result = this.folderExplorerResult;
        return (
            <section className='poiesis-folder-explorer' role='dialog' aria-modal='true' aria-label='フォルダーを選択'>
                <header className='poiesis-folder-explorer__header'>
                    <div>
                        <span className='codicon codicon-folder-opened' aria-hidden='true' />
                        <strong>ワークスペースのフォルダーを選択</strong>
                    </div>
                    <button type='button' aria-label='フォルダー選択を閉じる' onClick={() => this.closeFolderExplorer()}>
                        <span className='codicon codicon-close' aria-hidden='true' />
                    </button>
                </header>
                <div className='poiesis-folder-explorer__toolbar'>
                    <button
                        type='button'
                        title='一つ上のフォルダーへ'
                        aria-label='一つ上のフォルダーへ'
                        disabled={!result?.parentPath || this.folderExplorerLoading}
                        onClick={() => void this.loadFolderExplorer(result?.parentPath)}
                    >
                        <span className='codicon codicon-arrow-up' aria-hidden='true' />
                    </button>
                    <label>
                        <span className='codicon codicon-folder' aria-hidden='true' />
                        <PoiesisTextInput
                            value={this.folderExplorerAddress}
                            aria-label='フォルダーパス'
                            onValueChange={value => {
                                this.folderExplorerAddress = value;
                                this.update();
                            }}
                            onKeyDown={event => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    void this.loadFolderExplorer(this.folderExplorerAddress);
                                }
                            }}
                        />
                    </label>
                    <button type='button' title='再読み込み' aria-label='再読み込み' disabled={this.folderExplorerLoading} onClick={() => void this.loadFolderExplorer(result?.path)}>
                        <span className='codicon codicon-refresh' aria-hidden='true' />
                    </button>
                </div>
                <main className='poiesis-folder-explorer__body'>
                    <div className='poiesis-folder-explorer__column-heading'><span>名前</span><span>種類</span></div>
                    {this.creatingFolder && (
                        <div className='poiesis-folder-explorer__new-folder-row'>
                            <span className='codicon codicon-folder' aria-hidden='true' />
                            <PoiesisTextInput
                                autoFocus
                                value={this.newFolderName}
                                placeholder='新しいフォルダー'
                                aria-label='新しいフォルダー名'
                                onValueChange={value => {
                                    this.newFolderName = value;
                                    this.update();
                                }}
                                onKeyDown={event => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        void this.createFolderInExplorer();
                                    } else if (event.key === 'Escape') {
                                        this.creatingFolder = false;
                                        this.newFolderName = '';
                                        this.update();
                                    }
                                }}
                            />
                            <button type='button' disabled={!this.newFolderName.trim()} onClick={() => void this.createFolderInExplorer()}>作成</button>
                        </div>
                    )}
                    {this.folderExplorerLoading && <div className='poiesis-folder-explorer__state'>フォルダーを読み込み中…</div>}
                    {!this.folderExplorerLoading && this.folderExplorerError && <div className='poiesis-folder-explorer__state error' role='alert'>{this.folderExplorerError}</div>}
                    {!this.folderExplorerLoading && !this.folderExplorerError && result?.directories.map(directory => (
                        <button
                            type='button'
                            className='poiesis-folder-explorer__folder-row'
                            key={directory.path}
                            onDoubleClick={() => void this.loadFolderExplorer(directory.path)}
                            onClick={() => void this.loadFolderExplorer(directory.path)}
                        >
                            <span><span className='codicon codicon-folder' aria-hidden='true' /><strong>{directory.name}</strong></span>
                            <small>フォルダー</small>
                            <span className='codicon codicon-chevron-right' aria-hidden='true' />
                        </button>
                    ))}
                    {!this.folderExplorerLoading && !this.folderExplorerError && result?.directories.length === 0 && (
                        <div className='poiesis-folder-explorer__state'>このフォルダーにサブフォルダーはありません。</div>
                    )}
                </main>
                <footer className='poiesis-folder-explorer__footer'>
                    <button
                        type='button'
                        className='poiesis-folder-explorer__new-folder'
                        onClick={() => {
                            this.creatingFolder = true;
                            this.newFolderName = '';
                            this.update();
                        }}
                    >
                        <span className='codicon codicon-new-folder' aria-hidden='true' />
                        新しいフォルダー
                    </button>
                    <span className='poiesis-folder-explorer__selection'>{result?.path ?? ''}</span>
                    <button type='button' onClick={() => this.closeFolderExplorer()}>キャンセル</button>
                    <button type='button' className='primary' disabled={!result || this.folderExplorerLoading} onClick={() => this.selectFolderFromExplorer()}>フォルダーを選択</button>
                </footer>
            </section>
        );
    }

    protected renderRepositoryPicker(session: WindowAgentSession): React.ReactNode {
        const repositoryChoices = this.repositoryChoices();
        const query = this.repositorySearchQuery.trim().toLocaleLowerCase();
        const filteredChoices = repositoryChoices.filter(choice => !query
            || choice.name.toLocaleLowerCase().includes(query)
            || choice.path.toLocaleLowerCase().includes(query));
        return (
            <div
                className='poiesis-agent-window__repository-picker'
                id='poiesis-agent-window-repository-picker'
                role='dialog'
                aria-label='Repositoryを選択'
                style={this.repositoryPickerAnchor}
            >
                <label className='poiesis-agent-window__repository-search'>
                    <span className='codicon codicon-search' aria-hidden='true' />
                    <PoiesisTextInput
                        elementRef={input => { this.repositorySearchInput = input ?? undefined; }}
                        value={this.repositorySearchQuery}
                        placeholder='Repositoryを検索'
                        aria-label='Repositoryを検索'
                        onValueChange={value => this.setRepositorySearchQuery(value)}
                    />
                </label>
                {repositoryChoices.length > 0 && (
                    <>
                        <div className='poiesis-agent-window__repository-group-label'>最近</div>
                        {repositoryChoices.slice(0, 2).map(choice => this.renderRepositoryChoice(session, choice, 'codicon-history'))}
                    </>
                )}
                <div className='poiesis-agent-window__repository-group-label'>この PC</div>
                {filteredChoices.map(choice => this.renderRepositoryChoice(session, choice, 'codicon-device-desktop'))}
                {!filteredChoices.length && (
                    <div className='poiesis-agent-window__repository-empty'>一致するRepositoryはありません</div>
                )}
                <div className='poiesis-agent-window__repository-footer'>
                    <button type='button' onClick={() => void this.openFolderExplorer(session)}>
                        <span className='codicon codicon-folder-opened' aria-hidden='true' />
                        既存のフォルダーを使用…
                    </button>
                    <button type='button' onClick={() => void this.openFolderExplorer(session, true)}>
                        <span className='codicon codicon-new-folder' aria-hidden='true' />
                        新しいフォルダー
                    </button>
                </div>
            </div>
        );
    }

    protected renderRepositoryChoice(
        session: WindowAgentSession,
        choice: { uri: string; name: string; path: string },
        iconClass: string
    ): React.ReactNode {
        const selected = this.sameWorkspaceUri(session.workspaceUri, choice.uri);
        return (
            <button
                type='button'
                key={`${iconClass}-${choice.uri}`}
                className={`poiesis-agent-window__repository-option${selected ? ' selected' : ''}`}
                onClick={() => this.selectRepository(session, choice.uri)}
            >
                <span className={`codicon ${iconClass}`} aria-hidden='true' />
                <span><strong>{choice.name}</strong><small>{choice.path}</small></span>
                {selected && <span className='codicon codicon-check' aria-hidden='true' />}
            </button>
        );
    }

    constructor(host: AgentWindowHost) {
        super(host);
    }
}
