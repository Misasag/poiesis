import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { StorageService, WidgetManager } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Disposable } from '@theia/core/lib/common';
import { Message, MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { EditorWidget } from '@theia/editor/lib/browser';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { ScmHistoryProvider, ScmProvider } from '@theia/scm/lib/browser/scm-provider';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { AgentEvent, AgentProvider, AgentSession } from '../common/agent-provider';
import { ResultsService } from './results-skill';
import { ExecutionTask, TaskService } from './task-service';
import { getDesignVariant } from './design-variant';

type AgentWindowTab = 'agent' | 'results';
type CodeSidebarTab = 'files' | 'git';
const NEW_SESSION_TITLE = '新しい会話';
const SESSION_STORAGE_KEY = 'lens.agent-window.sessions.v1';
const DEFAULT_RAIL_WIDTH = 252;
const MIN_RAIL_WIDTH = 196;
const MAX_RAIL_WIDTH = 420;

interface ChatMessage {
    id: string;
    role: 'user' | 'agent';
    content: string;
    complete: boolean;
}

interface WindowAgentSession {
    id: string;
    createdAt: number;
    updatedAt: number;
    workspaceUri?: string;
    agentSession?: AgentSession;
    title: string;
    hasUserMessage: boolean;
    pinned: boolean;
    archived: boolean;
    activeTab: AgentWindowTab;
    agentDraft: string;
    messages: ChatMessage[];
    selectedResultsTaskId?: string;
    readonly resultsDrafts: Map<string, string>;
    readonly resultsNotices: Map<string, string>;
}

interface PersistedAgentWindowState {
    version: 1;
    selectedSessionId?: string;
    railWidth: number;
    railCollapsed: boolean;
    sessions: Array<Omit<WindowAgentSession, 'agentSession' | 'resultsDrafts' | 'resultsNotices'> & {
        resultsDrafts: Array<[string, string]>;
    }>;
}

@injectable()
export class AgentWindowWidget extends ReactWidget {
    static readonly ID = 'lens-agent-window';
    static readonly FILES_WIDGET_FACTORY_ID = 'files';
    static readonly GIT_WIDGET_FACTORY_ID = 'scm-view';
    static readonly EDITOR_WIDGET_FACTORY_ID = 'code-editor-opener';
    static readonly SETTINGS_WIDGET_FACTORY_ID = 'settings_widget';
    protected codeMode = false;
    protected codeSidebarTab: CodeSidebarTab = 'files';
    protected codeFilesWidget?: Widget;
    protected codeGitWidget?: Widget;
    protected readonly codeCenterWidgets: Widget[] = [];
    protected activeCodeCenterWidget?: Widget;
    protected codeSidebarHost?: HTMLDivElement;
    protected codeEditorHost?: HTMLDivElement;
    protected codeSidebarResizeObserver?: ResizeObserver;
    protected codeEditorResizeObserver?: ResizeObserver;
    protected readonly sessions: WindowAgentSession[] = [];
    protected selectedSessionId?: string;
    protected sessionSequence = 0;
    protected railCollapsed = false;
    protected railWidth = DEFAULT_RAIL_WIDTH;
    protected openSessionMenuId?: string;
    protected renamingSessionId?: string;
    protected renameDraft = '';
    protected showArchivedSessions = false;
    protected sessionSearchVisible = false;
    protected sessionSearchQuery = '';
    protected workspaceExpanded = true;
    protected sessionSearchInput?: HTMLInputElement;
    protected agentComposerInput?: HTMLTextAreaElement;
    protected railResizeCleanup?: Disposable;
    protected readonly watchedScmProviders = new WeakSet<ScmProvider>();
    protected readonly watchedScmHistoryProviders = new WeakSet<ScmHistoryProvider>();

    constructor(
        @inject(AgentProvider) protected readonly agentProvider: AgentProvider,
        @inject(TaskService) protected readonly taskService: TaskService,
        @inject(ResultsService) protected readonly resultsService: ResultsService,
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService,
        @inject(FileDialogService) protected readonly fileDialogService: FileDialogService,
        @inject(ScmService) protected readonly scmService: ScmService,
        @inject(WidgetManager) protected readonly widgetManager: WidgetManager,
        @inject(StorageService) protected readonly storageService: StorageService
    ) {
        super();
    }

    @postConstruct()
    protected init(): void {
        getDesignVariant();
        this.id = AgentWindowWidget.ID;
        this.addClass('lens-agent-window');

        const closeSessionMenu = (event: PointerEvent): void => {
            if (this.openSessionMenuId && !(event.target as Element | null)?.closest('.lens-agent-window__session-actions')) {
                this.openSessionMenuId = undefined;
                this.update();
            }
        };
        document.addEventListener('pointerdown', closeSessionMenu);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('pointerdown', closeSessionMenu)));

        this.toDispose.push(this.agentProvider.onEvent(event => this.handleAgentEvent(event)));
        this.toDispose.push(this.taskService.onDidChangeTask(event => {
            const session = this.findSessionByAgentId(event.task.sessionId);
            if ((event.type === 'ended' || event.type === 'failed' || event.type === 'cancelled')
                && session && !session.selectedResultsTaskId) {
                session.selectedResultsTaskId = event.task.id;
            }
            this.persistWindowState();
            this.update();
        }));
        this.toDispose.push(this.resultsService.onDidChange(() => this.update()));
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => this.update()));
        this.toDispose.push(this.workspaceService.onWorkspaceLocationChanged(() => this.update()));
        this.toDispose.push(this.scmService.onDidAddRepository(repository => {
            this.watchScmProvider(repository.provider);
            this.update();
        }));
        this.toDispose.push(this.scmService.onDidRemoveRepository(() => this.update()));
        this.toDispose.push(this.scmService.onDidChangeSelectedRepository(() => this.update()));
        this.toDispose.push(this.scmService.onDidChangeStatusBarCommands(() => this.update()));
        for (const repository of this.scmService.repositories) {
            this.watchScmProvider(repository.provider);
        }

        void this.initializeSessions();
        this.update();
    }

    protected render(): React.ReactNode {
        const session = this.selectedSession();
        const activeTab = session?.activeTab ?? 'agent';
        const runningTask = this.runningTask(session);
        return (
            <div
                className='lens-agent-window__content'
                data-mode={this.codeMode ? 'code' : activeTab}
                data-rail-collapsed={this.railCollapsed ? 'true' : 'false'}
                style={{ '--lens-rail-width': `${this.railWidth}px` } as React.CSSProperties}
            >
                {!this.codeMode && this.renderRail()}
                <main className='lens-agent-window__workspace'>
                    {this.renderHeader()}
                    <div className='lens-agent-window__viewport'>
                        {this.codeMode
                            ? this.renderCode()
                            : activeTab === 'agent'
                                ? this.renderAgent(session, runningTask)
                                : this.renderResults(session)}
                    </div>
                </main>
            </div>
        );
    }

    protected renderRail(): React.ReactNode {
        const activeSessions = this.filteredSessions(false);
        const pinnedSessions = activeSessions.filter(session => session.pinned);
        const recentSessions = activeSessions.filter(session => !session.pinned);
        const archivedSessions = this.filteredSessions(true);
        const toggleLabel = this.railCollapsed ? '左サイドバーを展開' : '左サイドバーを折りたたむ';
        return (
            <aside
                className='lens-agent-window__rail'
                data-collapsed={this.railCollapsed ? 'true' : 'false'}
                aria-label='セッションのサイドバー'
            >
                <div className='lens-agent-window__rail-top'>
                    <div className='lens-agent-window__rail-controls'>
                        <button
                            type='button'
                            className='lens-agent-window__rail-toggle'
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
                        className='lens-agent-window__rail-action'
                        title='New Chat'
                        onClick={() => void this.newChat()}
                    >
                        <span className='lens-agent-window__rail-action-icon' aria-hidden='true'>
                            <span className='codicon codicon-comment-add' />
                        </span>
                        <span className='lens-agent-window__rail-action-label'>New Chat</span>
                    </button>
                    <button
                        type='button'
                        className={`lens-agent-window__rail-action${this.sessionSearchVisible ? ' active' : ''}`}
                        aria-expanded={this.sessionSearchVisible && !this.railCollapsed}
                        aria-controls='lens-agent-window-session-search'
                        title='Search'
                        onClick={() => this.showSessionSearch()}
                    >
                        <span className='lens-agent-window__rail-action-icon' aria-hidden='true'>
                            <span className='codicon codicon-search' />
                        </span>
                        <span className='lens-agent-window__rail-action-label'>Search</span>
                    </button>
                    {this.sessionSearchVisible && !this.railCollapsed && (
                        <label className='lens-agent-window__session-search' id='lens-agent-window-session-search'>
                            <span className='codicon codicon-search' aria-hidden='true' />
                            <input
                                ref={this.setSessionSearchInput}
                                type='search'
                                value={this.sessionSearchQuery}
                                placeholder='Search conversations'
                                aria-label='会話をタイトルで検索'
                                onChange={event => this.setSessionSearchQuery(event.currentTarget.value)}
                                onKeyDown={event => {
                                    if (event.key === 'Escape') {
                                        this.closeSessionSearch();
                                    }
                                }}
                            />
                        </label>
                    )}
                </div>
                <div className='lens-agent-window__rail-heading'>
                    <span>Workspaces</span>
                    <button
                        type='button'
                        className='lens-agent-window__repository-open'
                        title='Open Folder'
                        aria-label='フォルダーを開いてリポジトリを選択または追加'
                        onClick={() => void this.openRepository()}
                    >
                        <span className='codicon codicon-add' aria-hidden='true' />
                    </button>
                </div>
                <div className='lens-agent-window__sessions'>
                    <div className='lens-agent-window__workspace-group'>
                        <button
                            type='button'
                            className='lens-agent-window__workspace-name'
                            aria-expanded={this.workspaceExpanded}
                            onClick={() => this.toggleWorkspace()}
                        >
                            <span className='codicon codicon-folder-opened' aria-hidden='true' />
                            <strong>{this.workspaceFolderName()}</strong>
                            <span
                                className={`codicon codicon-chevron-${this.workspaceExpanded ? 'down' : 'right'}`}
                                aria-hidden='true'
                            />
                        </button>
                        {this.workspaceExpanded && pinnedSessions.length > 0 && (
                            <div className='lens-agent-window__session-section-label'>Pinned</div>
                        )}
                        {this.workspaceExpanded && pinnedSessions.map(session => this.renderSessionRow(session))}
                        {this.workspaceExpanded && pinnedSessions.length > 0 && recentSessions.length > 0 && (
                            <div className='lens-agent-window__session-section-label'>Recent</div>
                        )}
                        {this.workspaceExpanded && recentSessions.map(session => this.renderSessionRow(session))}
                        {this.workspaceExpanded && !activeSessions.length && (
                            <div className='lens-agent-window__session-empty'>
                                {this.sessionSearchQuery.trim() ? '一致する会話はありません。' : 'セッションはありません。'}
                            </div>
                        )}
                        {this.workspaceExpanded && archivedSessions.length > 0 && (
                            <>
                                <button
                                    type='button'
                                    className='lens-agent-window__archived-toggle'
                                    aria-expanded={this.showArchivedSessions}
                                    onClick={() => this.toggleArchivedSessions()}
                                >
                                    <span className={`codicon codicon-chevron-${this.showArchivedSessions ? 'down' : 'right'}`} aria-hidden='true' />
                                    <span>Archived</span>
                                    <small>{archivedSessions.length}</small>
                                </button>
                                {this.showArchivedSessions && archivedSessions.map(session => this.renderSessionRow(session))}
                            </>
                        )}
                    </div>
                </div>
                <div className='lens-agent-window__rail-footer'>
                    <span className='lens-agent-window__rail-footer-label'>Lens</span>
                    <button type='button' title='設定' aria-label='設定' onClick={() => this.openSettings()}>
                        <span className='codicon codicon-settings-gear' aria-hidden='true' />
                    </button>
                </div>
                {!this.railCollapsed && (
                    <div
                        className='lens-agent-window__rail-resize-handle'
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

    protected renderSessionRow(session: WindowAgentSession): React.ReactNode {
        const selected = session.id === this.selectedSessionId;
        const renaming = session.id === this.renamingSessionId;
        const menuOpen = session.id === this.openSessionMenuId;
        const running = Boolean(this.runningTask(session));
        return (
            <div
                key={session.id}
                className={`lens-agent-window__session-row${selected ? ' active' : ''}${session.archived ? ' archived' : ''}`}
                data-session-id={session.id}
                data-session-archived={session.archived ? 'true' : 'false'}
                data-session-pinned={session.pinned ? 'true' : 'false'}
            >
                {renaming ? (
                    <input
                        className='lens-agent-window__session-rename'
                        value={this.renameDraft}
                        aria-label='セッション名を変更'
                        autoFocus
                        onChange={event => {
                            this.renameDraft = event.currentTarget.value;
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
                        className='lens-agent-window__session'
                        aria-current={selected ? 'true' : undefined}
                        onClick={() => session.archived ? this.restoreSession(session.id, true) : this.selectSession(session.id)}
                    >
                        {session.pinned && <span className='codicon codicon-pinned' aria-label='ピン留め済み' />}
                        <span className='lens-agent-window__session-title'>{session.title}</span>
                        <small className={`lens-agent-window__session-meta${running ? ' running' : ''}`}>
                            {running ? '実行中' : this.sessionMeta(session)}
                        </small>
                    </button>
                )}
                {!renaming && (
                    <div className='lens-agent-window__session-actions'>
                        <button
                            type='button'
                            className='lens-agent-window__session-menu-trigger'
                            title='その他の操作'
                            aria-label={`${session.title}のその他の操作`}
                            aria-haspopup='menu'
                            aria-expanded={menuOpen}
                            onClick={() => this.toggleSessionMenu(session.id)}
                        >
                            <span className='codicon codicon-more' aria-hidden='true' />
                        </button>
                        {menuOpen && (
                            <div className='lens-agent-window__session-menu' role='menu'>
                                {session.archived ? (
                                    <>
                                        <button type='button' role='menuitem' onClick={() => this.restoreSession(session.id)}>
                                            <span className='codicon codicon-archive' aria-hidden='true' />復元
                                        </button>
                                        <button type='button' role='menuitem' className='danger' onClick={() => void this.deleteSession(session.id)}>
                                            <span className='codicon codicon-trash' aria-hidden='true' />完全に削除
                                        </button>
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
            this.selectedSessionId = session.id;
            session.activeTab = 'agent';
            void this.ensureProviderSession(session);
        }
        this.persistWindowState();
        this.update();
    }

    protected async deleteSession(sessionId: string): Promise<void> {
        const session = this.sessions.find(candidate => candidate.id === sessionId && candidate.archived);
        if (!session || !window.confirm(`「${session.title}」を完全に削除しますか？この操作は取り消せません。`)) {
            return;
        }
        if (session.agentSession) {
            const taskIds = this.taskService.removeSession(session.agentSession.id);
            this.resultsService.remove(taskIds);
        }
        const index = this.sessions.indexOf(session);
        if (index !== -1) {
            this.sessions.splice(index, 1);
        }
        this.openSessionMenuId = undefined;
        this.persistWindowState();
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
        document.body.classList.add('lens-is-resizing-rail');
        document.addEventListener('pointermove', resize);
        document.addEventListener('pointerup', finish, { once: true });
        this.railResizeCleanup = Disposable.create(() => {
            document.body.classList.remove('lens-is-resizing-rail');
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

    protected toggleWorkspace(): void {
        this.workspaceExpanded = !this.workspaceExpanded;
        this.update();
    }

    protected async openRepository(): Promise<void> {
        const folder = await this.fileDialogService.showOpenDialog({
            title: 'Open Folder',
            canSelectFiles: false,
            canSelectFolders: true
        }, this.workspaceRoot());
        if (folder) {
            this.workspaceService.open(folder, { preserveWindow: true });
        }
    }

    protected sessionMeta(session: WindowAgentSession): string {
        const ageInMinutes = Math.floor(Math.max(0, Date.now() - session.createdAt) / 60_000);
        if (ageInMinutes < 1) {
            return '今';
        }
        if (ageInMinutes < 60) {
            return `${ageInMinutes}m`;
        }
        const ageInHours = Math.floor(ageInMinutes / 60);
        return ageInHours < 24 ? `${ageInHours}h` : `${Math.floor(ageInHours / 24)}d`;
    }

    protected renderHeader(): React.ReactNode {
        const session = this.selectedSession();
        const activeTab = session?.activeTab ?? 'agent';
        return (
            <header className='lens-agent-window__header'>
                <div className='lens-agent-window__context'>
                    <div className='lens-agent-window__context-scope'>
                        <small>{this.workspaceContextLabel()}</small>
                        <button
                            type='button'
                            className={`lens-agent-window__code-control${this.codeMode ? ' active' : ''}`}
                            aria-pressed={this.codeMode}
                            onClick={() => this.toggleCodeMode()}
                        >
                            <span className='codicon codicon-code' aria-hidden='true' />
                            <span>Code</span>
                        </button>
                    </div>
                    <strong>{this.codeMode ? 'Code' : session?.title ?? NEW_SESSION_TITLE}</strong>
                </div>
                {!this.codeMode && (
                    <nav className='lens-agent-window__tabs' aria-label='Agent と Results の切り替え'>
                        <button
                            type='button'
                            className={activeTab === 'agent' ? 'active' : ''}
                            aria-current={activeTab === 'agent' ? 'page' : undefined}
                            onClick={() => this.selectTab('agent')}
                        >
                            Agent
                        </button>
                        <span className='lens-agent-window__tab-divider' aria-hidden='true'>|</span>
                        <button
                            type='button'
                            className={activeTab === 'results' ? 'active' : ''}
                            aria-current={activeTab === 'results' ? 'page' : undefined}
                            onClick={() => this.selectTab('results')}
                        >
                            Results
                        </button>
                    </nav>
                )}
            </header>
        );
    }

    protected renderAgent(session: WindowAgentSession | undefined, runningTask?: ExecutionTask): React.ReactNode {
        return (
            <section className='lens-agent-window__agent' aria-label='Agent の会話'>
                <div className='lens-agent-window__messages' aria-live='polite'>
                    <div className='lens-agent-window__messages-inner'>
                        {(session?.messages ?? []).map(message => (
                            <section
                                key={message.id}
                                aria-label={message.role === 'user' ? 'あなたのメッセージ' : 'Agent のメッセージ'}
                                className={message.role === 'user'
                                    ? 'lens-agent-window__user-message'
                                    : 'lens-agent-window__message'}
                            >
                                <p>{message.content || '…'}</p>
                                {!message.complete && <small className='lens-agent-window__message-state'>作業中…</small>}
                            </section>
                        ))}
                    </div>
                </div>
                {runningTask && (
                    <div className='lens-agent-window__task-state' role='status'>
                        <span>タスクを実行中 · {runningTask.title}</span>
                        <button type='button' onClick={() => void this.cancelRun()}>
                            キャンセル
                        </button>
                    </div>
                )}
                <section className='lens-agent-window__composer' aria-label='Agent の入力欄'>
                    <textarea
                        ref={input => { this.agentComposerInput = input ?? undefined; }}
                        value={session?.agentDraft ?? ''}
                        placeholder='次の変更内容や質問を入力…'
                        aria-label='Agent へのメッセージ'
                        rows={2}
                        disabled={!session || Boolean(runningTask)}
                        onChange={event => this.setAgentDraft(event.currentTarget.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                                event.preventDefault();
                                void this.sendAgentMessage();
                            }
                        }}
                    />
                    <div className='lens-agent-window__composer-footer'>
                        <button
                            className='lens-agent-window__send'
                            type='button'
                            aria-label='Agent へ送信'
                            disabled={!session?.agentSession || Boolean(runningTask) || !session.agentDraft.trim()}
                            onClick={() => void this.sendAgentMessage()}
                        >
                            <span className='codicon codicon-arrow-up' aria-hidden='true' />
                        </button>
                    </div>
                </section>
            </section>
        );
    }

    protected renderResults(session: WindowAgentSession | undefined): React.ReactNode {
        const finishedTasks = [...this.finishedTasks(session)].reverse();
        const selectedTask = finishedTasks.find(task => task.id === session?.selectedResultsTaskId)
            ?? finishedTasks[0];
        const document = selectedTask ? this.resultsService.get(selectedTask.id) : undefined;
        const draft = selectedTask ? session?.resultsDrafts.get(selectedTask.id) ?? '' : '';
        const notice = selectedTask ? session?.resultsNotices.get(selectedTask.id) : undefined;

        return (
            <section className='lens-results' aria-label='Results 画面'>
                <div className='lens-results__main'>
                    <div className='lens-results__canvas' aria-label='Results HTML キャンバス'>
                        {!selectedTask && <div className='lens-results__empty'>Agent でタスクを完了すると、ここに成果が表示されます。</div>}
                        {selectedTask && (!document || document.status === 'generating') && (
                            <div className='lens-results__empty' role='status'>成果を作成しています…</div>
                        )}
                        {document?.status === 'failed' && (
                            <div className='lens-results__empty' role='alert'>成果を作成できませんでした。{document.error}</div>
                        )}
                        {document?.status === 'ready' && document.html && (
                            <iframe
                                key={selectedTask?.id}
                                className='lens-results__document'
                                title={`${selectedTask?.title}の成果`}
                                sandbox=''
                                srcDoc={document.html}
                            />
                        )}
                    </div>
                    {notice && <div className='lens-results__answer' role='status'>{notice}</div>}
                    <section className='lens-results__composer' aria-label='Results の入力欄'>
                        <input
                            value={draft}
                            placeholder='この結果について質問…'
                            aria-label='表示中の成果について質問'
                            disabled={!selectedTask || document?.status !== 'ready'}
                            onChange={event => selectedTask && this.setResultsDraft(selectedTask.id, event.currentTarget.value)}
                            onKeyDown={event => {
                                if (event.key === 'Enter' && selectedTask) {
                                    void this.submitResultsQuestion(selectedTask.id);
                                }
                            }}
                        />
                        <button
                            type='button'
                            aria-label='Results 内へ送信'
                            disabled={!selectedTask || document?.status !== 'ready' || !draft.trim()}
                            onClick={() => selectedTask && void this.submitResultsQuestion(selectedTask.id)}
                        >
                            <span className='codicon codicon-arrow-up' aria-hidden='true' />
                        </button>
                    </section>
                </div>
                <aside className='lens-results__task-switcher' aria-label='同じセッションの実行タスク'>
                    <div className='lens-results__task-switcher-header'>
                        <strong>タスク</strong>
                        <span>{finishedTasks.length}</span>
                    </div>
                    <div className='lens-results__task-list' role='tablist'>
                        {finishedTasks.map((task, index) => (
                            <button
                                key={task.id}
                                type='button'
                                role='tab'
                                aria-selected={selectedTask?.id === task.id}
                                className={selectedTask?.id === task.id ? 'active' : ''}
                                onClick={() => this.selectResultsTask(task.id)}
                            >
                                <small>
                                    {index === 0 ? '最新 · ' : ''}
                                    {task.status === 'cancelled' ? 'キャンセル' : task.status === 'failed' ? '失敗' : '完了'}
                                </small>
                                <span>{task.title}</span>
                            </button>
                        ))}
                    </div>
                    {!finishedTasks.length && <p>完了したタスクはありません。</p>}
                </aside>
            </section>
        );
    }

    protected renderCode(): React.ReactNode {
        return (
            <section className='lens-agent-window__code' aria-label='Code モード'>
                <aside className='lens-agent-window__code-sidebar' aria-label='Code のサイドバー'>
                    <div className='lens-agent-window__code-sidebar-tabs' role='tablist' aria-label='Code の表示'>
                        <button
                            type='button'
                            role='tab'
                            aria-selected={this.codeSidebarTab === 'files'}
                            className={this.codeSidebarTab === 'files' ? 'active' : ''}
                            onClick={() => this.selectCodeSidebarTab('files')}
                        >
                            Files
                        </button>
                        <button
                            type='button'
                            role='tab'
                            aria-selected={this.codeSidebarTab === 'git'}
                            className={this.codeSidebarTab === 'git' ? 'active' : ''}
                            onClick={() => this.selectCodeSidebarTab('git')}
                        >
                            Git
                        </button>
                    </div>
                    <div className='lens-agent-window__code-sidebar-host' ref={this.setCodeSidebarHost} />
                    <footer className='lens-agent-window__code-footer'>
                        <span>{this.codeSidebarTab === 'files' ? 'Files' : 'Git'}</span>
                        <button type='button' title='設定' aria-label='設定' onClick={() => this.openSettings()}>
                            <span className='codicon codicon-settings-gear' aria-hidden='true' />
                        </button>
                    </footer>
                </aside>
                <main className='lens-agent-window__code-editor' aria-label='Editor'>
                    <div className='lens-agent-window__code-editor-tabs' role='tablist' aria-label='開いているEditor'>
                        {this.codeCenterWidgets.map(widget => (
                            <button
                                key={widget.id}
                                type='button'
                                role='tab'
                                aria-selected={this.activeCodeCenterWidget === widget}
                                className={this.activeCodeCenterWidget === widget ? 'active' : ''}
                                onClick={() => this.selectCodeCenterWidget(widget)}
                            >
                                {widget.title.iconClass && <span className={widget.title.iconClass} aria-hidden='true' />}
                                <span>{this.codeCenterWidgetLabel(widget)}</span>
                            </button>
                        ))}
                    </div>
                    <div className='lens-agent-window__code-editor-host' ref={this.setCodeEditorHost}>
                        {!this.activeCodeCenterWidget && (
                            <div className='lens-agent-window__code-empty'>Filesからファイルを開いてください。</div>
                        )}
                    </div>
                </main>
            </section>
        );
    }

    registerCodeWidget(factoryId: string, widget: Widget): void {
        let changed = false;
        if (factoryId === AgentWindowWidget.FILES_WIDGET_FACTORY_ID) {
            changed = this.codeFilesWidget !== widget;
            this.codeFilesWidget = widget;
        } else if (factoryId === AgentWindowWidget.GIT_WIDGET_FACTORY_ID) {
            changed = this.codeGitWidget !== widget;
            this.codeGitWidget = widget;
        } else if (this.isCodeCenterWidget(factoryId, widget)
            && !this.codeCenterWidgets.includes(widget)) {
            this.detachCodeWidget(this.activeCodeCenterWidget);
            this.codeCenterWidgets.push(widget);
            this.activeCodeCenterWidget = widget;
            changed = true;
            const onDisposed = (): void => this.removeCodeCenterWidget(widget);
            widget.disposed.connect(onDisposed);
            this.toDispose.push(Disposable.create(() => widget.disposed.disconnect(onDisposed)));
        }
        if (changed && this.codeMode) {
            this.update();
            this.syncCodeWidgetAttachments();
        }
    }

    protected isCodeCenterWidget(factoryId: string, widget: Widget): boolean {
        return widget instanceof EditorWidget
            || factoryId.startsWith(AgentWindowWidget.EDITOR_WIDGET_FACTORY_ID)
            || factoryId === AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID;
    }

    protected readonly setCodeSidebarHost = (host: HTMLDivElement | null): void => {
        if (!host) {
            this.codeSidebarResizeObserver?.disconnect();
            this.codeSidebarResizeObserver = undefined;
            this.detachCodeWidget(this.activeCodeSidebarWidget());
            this.codeSidebarHost = undefined;
            return;
        }
        this.codeSidebarHost = host;
        this.codeSidebarResizeObserver = new ResizeObserver(() =>
            this.resizeCodeWidget(this.activeCodeSidebarWidget(), host));
        this.codeSidebarResizeObserver.observe(host);
        this.syncCodeWidgetAttachments();
    };

    protected readonly setCodeEditorHost = (host: HTMLDivElement | null): void => {
        if (!host) {
            this.codeEditorResizeObserver?.disconnect();
            this.codeEditorResizeObserver = undefined;
            this.detachCodeWidget(this.activeCodeCenterWidget);
            this.codeEditorHost = undefined;
            return;
        }
        this.codeEditorHost = host;
        this.codeEditorResizeObserver = new ResizeObserver(() =>
            this.resizeCodeWidget(this.activeCodeCenterWidget, host));
        this.codeEditorResizeObserver.observe(host);
        this.syncCodeWidgetAttachments();
    };

    protected activeCodeSidebarWidget(): Widget | undefined {
        return this.codeSidebarTab === 'files' ? this.codeFilesWidget : this.codeGitWidget;
    }

    protected syncCodeWidgetAttachments(): void {
        if (!this.codeMode) {
            this.detachCodeWidgets();
            return;
        }
        this.attachCodeWidget(this.activeCodeSidebarWidget(), this.codeSidebarHost);
        this.attachCodeWidget(this.activeCodeCenterWidget, this.codeEditorHost);
    }

    protected attachCodeWidget(widget: Widget | undefined, host: HTMLDivElement | undefined): void {
        if (!widget || !host) {
            return;
        }
        if (widget.node.parentElement !== host) {
            // Files and Git normally belong to ViewContainerPart; editors may
            // already belong to the detached shell. Make each a root first.
            if (widget.parent) {
                widget.parent = null;
            }
            if (widget.isAttached) {
                Widget.detach(widget);
            }
            Widget.attach(widget, host);
        }
        this.revealCodeWidget(widget, host);
    }

    protected revealCodeWidget(widget: Widget, host: HTMLDivElement): void {
        widget.show();
        widget.update();
        widget.activate();
        this.resizeCodeWidget(widget, host);
        requestAnimationFrame(() => {
            if (!widget.isDisposed && widget.isAttached && widget.node.parentElement === host) {
                widget.show();
                widget.update();
                this.resizeCodeWidget(widget, host);
            }
        });
    }

    protected resizeCodeWidget(widget: Widget | undefined, host: HTMLDivElement): void {
        if (!widget?.isAttached || widget.node.parentElement !== host) {
            return;
        }
        const width = host.clientWidth;
        const height = host.clientHeight;
        MessageLoop.sendMessage(widget, new Widget.ResizeMessage(width, height));
        widget.update();
        if (widget instanceof EditorWidget) {
            widget.editor.resizeToFit();
            widget.editor.refresh();
        }
    }

    protected detachCodeWidget(widget: Widget | undefined): void {
        const parent = widget?.node.parentElement;
        if (widget?.isAttached && (parent === this.codeSidebarHost || parent === this.codeEditorHost)) {
            Widget.detach(widget);
        }
    }

    protected detachCodeWidgets(): void {
        this.detachCodeWidget(this.activeCodeSidebarWidget());
        this.detachCodeWidget(this.activeCodeCenterWidget);
    }

    protected selectCodeSidebarTab(tab: CodeSidebarTab): void {
        this.detachCodeWidget(this.activeCodeSidebarWidget());
        this.codeSidebarTab = tab;
        this.update();
        this.syncCodeWidgetAttachments();
    }

    protected selectCodeCenterWidget(widget: Widget): void {
        this.detachCodeWidget(this.activeCodeCenterWidget);
        this.activeCodeCenterWidget = widget;
        this.update();
        this.syncCodeWidgetAttachments();
    }

    protected removeCodeCenterWidget(widget: Widget): void {
        const index = this.codeCenterWidgets.indexOf(widget);
        if (index !== -1) {
            this.codeCenterWidgets.splice(index, 1);
        }
        if (this.activeCodeCenterWidget === widget) {
            this.activeCodeCenterWidget = this.codeCenterWidgets.at(-1);
        }
        this.update();
        this.syncCodeWidgetAttachments();
    }

    protected codeCenterWidgetLabel(widget: Widget): string {
        if (widget.id === AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID) {
            return 'Settings';
        }
        return widget.title.label || widget.title.caption || 'Editor';
    }

    protected async openCodeSettings(): Promise<void> {
        const settings = await this.widgetManager.getOrCreateWidget(AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID);
        this.registerCodeWidget(AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID, settings);
        this.selectCodeCenterWidget(settings);
    }

    protected openSettings(): void {
        if (!this.codeMode) {
            this.codeMode = true;
            this.update();
        }
        requestAnimationFrame(() => void this.openCodeSettings());
    }

    protected onBeforeDetach(message: Message): void {
        this.railResizeCleanup?.dispose();
        this.railResizeCleanup = undefined;
        this.codeSidebarResizeObserver?.disconnect();
        this.codeEditorResizeObserver?.disconnect();
        this.detachCodeWidgets();
        super.onBeforeDetach(message);
    }

    protected selectedSession(): WindowAgentSession | undefined {
        return this.sessions.find(session => session.id === this.selectedSessionId);
    }

    protected findSessionByAgentId(sessionId: string): WindowAgentSession | undefined {
        return this.sessions.find(session => session.agentSession?.id === sessionId);
    }

    protected selectSession(sessionId: string): void {
        const session = this.sessions.find(candidate => candidate.id === sessionId && !candidate.archived);
        if (!session) {
            return;
        }
        this.selectedSessionId = sessionId;
        session.updatedAt = Date.now();
        this.openSessionMenuId = undefined;
        void this.ensureProviderSession(session);
        this.persistWindowState();
        this.update();
    }

    protected workspaceRoot() {
        return this.workspaceService.tryGetRoots()[0]
            ?? (this.workspaceService.workspace?.isDirectory ? this.workspaceService.workspace : undefined);
    }

    protected workspaceFolderName(): string {
        return this.workspaceRoot()?.resource.path.base || 'ワークスペースなし';
    }

    protected workspaceContextLabel(): string {
        const workspace = this.workspaceFolderName();
        const branch = this.currentGitBranch();
        return branch ? `${workspace} / ${branch}` : workspace;
    }

    protected currentGitBranch(): string | undefined {
        const root = this.workspaceRoot();
        const repository = root ? this.scmService.findRepository(root.resource) : undefined;
        const provider = repository?.provider;
        if (provider?.id.toLowerCase() !== 'git') {
            return undefined;
        }
        const ref = provider.historyProvider?.currentHistoryItemRef;
        if (!ref?.id.startsWith('refs/heads/')) {
            return undefined;
        }
        return ref.name.trim() || undefined;
    }

    protected watchScmProvider(provider: ScmProvider): void {
        if (this.watchedScmProviders.has(provider)) {
            return;
        }
        this.watchedScmProviders.add(provider);
        this.watchScmHistoryProvider(provider.historyProvider);
        this.toDispose.push(provider.onDidChange(() => {
            this.watchScmHistoryProvider(provider.historyProvider);
            queueMicrotask(() => this.update());
        }));
    }

    protected watchScmHistoryProvider(historyProvider: ScmHistoryProvider | undefined): void {
        if (!historyProvider || this.watchedScmHistoryProviders.has(historyProvider)) {
            return;
        }
        this.watchedScmHistoryProviders.add(historyProvider);
        this.toDispose.push(historyProvider.onDidChangeCurrentHistoryItemRefs(() => this.update()));
    }

    protected async createSession(): Promise<void> {
        const id = `window-session-${Date.now()}-${++this.sessionSequence}`;
        const now = Date.now();
        const session: WindowAgentSession = {
            id,
            createdAt: now,
            updatedAt: now,
            workspaceUri: this.workspaceRoot()?.resource.toString(),
            title: NEW_SESSION_TITLE,
            hasUserMessage: false,
            pinned: false,
            archived: false,
            activeTab: 'agent',
            agentDraft: '',
            messages: [{
                id: `provider-pending-${id}`,
                role: 'agent',
                content: '利用できるエージェントを準備しています…',
                complete: true
            }],
            resultsDrafts: new Map<string, string>(),
            resultsNotices: new Map<string, string>()
        };
        this.sessions.push(session);
        this.selectedSessionId = session.id;
        this.openSessionMenuId = undefined;
        this.persistWindowState();
        this.update();
        await this.ensureProviderSession(session, true);
    }

    protected async ensureProviderSession(session: WindowAgentSession, replaceStatus = false): Promise<void> {
        if (session.agentSession) {
            return;
        }
        try {
            session.agentSession = await this.agentProvider.createSession({
                workspaceUri: session.workspaceUri ?? this.workspaceRoot()?.resource.toString()
            });
            if (replaceStatus || session.messages.length === 0 || session.messages.every(message => message.id.startsWith('provider-'))) {
                session.messages = [{
                    id: `provider-ready-${session.id}`,
                    role: 'agent',
                    content: '準備ができました。変更したい内容を入力してください。',
                    complete: true
                }];
            }
        } catch (error) {
            if (replaceStatus || session.messages.length === 0 || session.messages.every(message => message.id.startsWith('provider-'))) {
                session.messages = [{
                    id: `provider-error-${session.id}`,
                    role: 'agent',
                    content: `エージェントを準備できませんでした: ${error instanceof Error ? error.message : String(error)}`,
                    complete: true
                }];
            }
        }
        this.persistWindowState();
        this.update();
    }

    protected async restoreWindowState(): Promise<boolean> {
        try {
            const state = await this.storageService.getData<Partial<PersistedAgentWindowState>>(SESSION_STORAGE_KEY);
            if (!state) {
                return false;
            }
            if (state.version !== 1 || !Array.isArray(state.sessions) || state.sessions.length === 0) {
                return false;
            }
            this.sessions.splice(0, this.sessions.length, ...state.sessions.flatMap(candidate => {
                if (!candidate || typeof candidate.id !== 'string' || typeof candidate.title !== 'string') {
                    return [];
                }
                const createdAt = Number(candidate.createdAt) || Date.now();
                const restored: WindowAgentSession = {
                    id: candidate.id,
                    createdAt,
                    updatedAt: Number(candidate.updatedAt) || createdAt,
                    workspaceUri: typeof candidate.workspaceUri === 'string' ? candidate.workspaceUri : undefined,
                    title: candidate.title || NEW_SESSION_TITLE,
                    hasUserMessage: Boolean(candidate.hasUserMessage),
                    pinned: Boolean(candidate.pinned),
                    archived: Boolean(candidate.archived),
                    activeTab: candidate.activeTab === 'results' ? 'results' : 'agent',
                    agentDraft: typeof candidate.agentDraft === 'string' ? candidate.agentDraft : '',
                    messages: Array.isArray(candidate.messages) ? candidate.messages.filter(message =>
                        message && typeof message.id === 'string'
                        && (message.role === 'user' || message.role === 'agent')
                        && typeof message.content === 'string'
                    ).map(message => ({ ...message, complete: Boolean(message.complete) })) : [],
                    selectedResultsTaskId: typeof candidate.selectedResultsTaskId === 'string'
                        ? candidate.selectedResultsTaskId
                        : undefined,
                    resultsDrafts: new Map(Array.isArray(candidate.resultsDrafts) ? candidate.resultsDrafts : []),
                    resultsNotices: new Map<string, string>()
                };
                return [restored];
            }));
            this.selectedSessionId = typeof state.selectedSessionId === 'string' ? state.selectedSessionId : undefined;
            this.railWidth = this.clampRailWidth(Number(state.railWidth) || DEFAULT_RAIL_WIDTH);
            this.railCollapsed = Boolean(state.railCollapsed);
            this.sessionSequence = this.sessions.length;
            return this.sessions.length > 0;
        } catch (error) {
            console.warn('[Lens] Could not restore Agent Window sessions.', error);
            return false;
        }
    }

    protected async persistWindowState(): Promise<void> {
        try {
            const state: PersistedAgentWindowState = {
                version: 1,
                selectedSessionId: this.selectedSessionId,
                railWidth: this.railWidth,
                railCollapsed: this.railCollapsed,
                sessions: this.sessions.map(session => {
                    const { agentSession: _agentSession, resultsDrafts, resultsNotices: _resultsNotices, ...persisted } = session;
                    return {
                        ...persisted,
                        resultsDrafts: [...resultsDrafts.entries()]
                    };
                })
            };
            await this.storageService.setData(SESSION_STORAGE_KEY, state);
        } catch (error) {
            console.warn('[Lens] Could not persist Agent Window sessions.', error);
        }
    }

    protected titleForSession(message: string): string {
        const compact = message.replace(/\s+/g, ' ').trim();
        return compact.length > 46 ? `${compact.slice(0, 43)}…` : compact;
    }

    protected async initializeSessions(): Promise<void> {
        const restored = await this.restoreWindowState();
        if (!restored) {
            await this.createSession();
            return;
        }
        const activeSessions = this.filteredSessions(false);
        const selected = activeSessions.find(session => session.id === this.selectedSessionId) ?? activeSessions[0];
        if (!selected) {
            await this.createSession();
            return;
        }
        this.selectedSessionId = selected.id;
        this.update();
        await this.ensureProviderSession(selected);
    }

    protected async sendAgentMessage(): Promise<void> {
        const session = this.selectedSession();
        const content = session?.agentDraft.trim() ?? '';
        if (!session?.agentSession || !content || this.runningTask(session)) {
            return;
        }
        session.agentDraft = '';
        session.messages.push({ id: `user-${Date.now()}`, role: 'user', content, complete: true });
        session.updatedAt = Date.now();
        if (!session.hasUserMessage) {
            session.title = this.titleForSession(content);
            session.hasUserMessage = true;
        }
        this.persistWindowState();
        this.update();
        try {
            await this.agentProvider.sendMessage(session.agentSession.id, { role: 'user', content });
        } catch (error) {
            session.messages.push({
                id: `error-${Date.now()}`,
                role: 'agent',
                content: `エージェントとの通信でエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`,
                complete: true
            });
            this.persistWindowState();
            this.update();
        }
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
        if (event.type === 'task-started') {
            session.messages.push({ id: `agent-${event.taskId}`, role: 'agent', content: '', complete: false });
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
                content: `${message.content} 実行に失敗しました。`.trim(),
                complete: true
            }));
        }
        session.updatedAt = Date.now();
        this.persistWindowState();
        this.update();
    }

    protected updateAgentMessage(session: WindowAgentSession, taskId: string, update: (message: ChatMessage) => ChatMessage): void {
        const id = `agent-${taskId}`;
        session.messages = session.messages.map(message => message.id === id ? update(message) : message);
    }

    protected runningTask(session = this.selectedSession()): ExecutionTask | undefined {
        const agentSessionId = session?.agentSession?.id;
        return agentSessionId
            ? this.taskService.list(agentSessionId).find(task => task.status === 'running')
            : undefined;
    }

    protected finishedTasks(session = this.selectedSession()): ExecutionTask[] {
        const agentSessionId = session?.agentSession?.id;
        return agentSessionId
            ? this.taskService.list(agentSessionId).filter(task => task.status !== 'running')
            : [];
    }

    protected toggleCodeMode(): void {
        if (this.codeMode) {
            this.detachCodeWidgets();
            this.codeMode = false;
        } else {
            this.codeMode = true;
        }
        this.update();
    }

    protected selectTab(tab: AgentWindowTab): void {
        const session = this.selectedSession();
        if (session) {
            session.activeTab = tab;
            this.persistWindowState();
        }
        this.update();
    }

    protected async newChat(): Promise<void> {
        this.detachCodeWidgets();
        this.codeMode = false;
        this.sessionSearchVisible = false;
        this.sessionSearchQuery = '';
        const current = this.selectedSession();
        if (current && !current.archived && !current.hasUserMessage) {
            current.activeTab = 'agent';
            this.persistWindowState();
            this.update();
            requestAnimationFrame(() => this.agentComposerInput?.focus());
            void this.ensureProviderSession(current);
            return;
        }
        const creation = this.createSession();
        requestAnimationFrame(() => this.agentComposerInput?.focus());
        await creation;
        requestAnimationFrame(() => this.agentComposerInput?.focus());
    }

    protected setAgentDraft(value: string): void {
        const session = this.selectedSession();
        if (session) {
            session.agentDraft = value;
            this.persistWindowState();
        }
        this.update();
    }

    protected selectResultsTask(taskId: string): void {
        const session = this.selectedSession();
        if (session) {
            session.selectedResultsTaskId = taskId;
            this.persistWindowState();
        }
        this.update();
    }

    protected setResultsDraft(taskId: string, value: string): void {
        const session = this.selectedSession();
        session?.resultsDrafts.set(taskId, value);
        session?.resultsNotices.delete(taskId);
        this.persistWindowState();
        this.update();
    }

    protected async submitResultsQuestion(taskId: string): Promise<void> {
        const session = this.selectedSession();
        const question = session?.resultsDrafts.get(taskId)?.trim();
        if (!session || !question) {
            return;
        }
        session.resultsDrafts.set(taskId, '');
        session.resultsNotices.set(taskId, 'この質問は Results 内だけに保存され、Agent の会話やタスクには送信されません。');
        this.persistWindowState();
        this.update();
    }
}
