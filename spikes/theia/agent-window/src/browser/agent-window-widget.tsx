import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Saveable, StorageService, WidgetManager } from '@theia/core/lib/browser';
import { IconThemeService } from '@theia/core/lib/browser/icon-theme-service';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { CommandService, Disposable } from '@theia/core/lib/common';
import { FileUri } from '@theia/core/lib/common/file-uri';
import URI from '@theia/core/lib/common/uri';
import { Message, MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { EditorManager, EditorWidget } from '@theia/editor/lib/browser';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { ScmHistoryProvider, ScmProvider } from '@theia/scm/lib/browser/scm-provider';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { FileNavigatorCommands } from '@theia/navigator/lib/browser/navigator-contribution';
import { SearchInWorkspaceCommands } from '@theia/search-in-workspace/lib/browser/search-in-workspace-frontend-contribution';
import { BUILTIN_QUERY, VSXExtensionsSearchModel } from '@theia/vsx-registry/lib/browser/vsx-extensions-search-model';
import { AgentEvent, AgentProvider, AgentSession } from '../common/agent-provider';
import { FolderBrowserResult } from '../common/agent-runtime-protocol';
import { ResultsService } from './results-skill';
import { ExecutionTask, TaskService } from './task-service';
import { getDesignVariant } from './design-variant';
import { CustomizationService } from './customization-service';
import { FolderExplorerService } from './folder-explorer-service';

type AgentWindowTab = 'agent' | 'results';
type CodeSidebarTab = 'files' | 'search' | 'git' | 'extensions';
type AppPage = 'settings' | 'customize';
type CustomizeTab = 'skills' | 'plugins';
const NEW_SESSION_TITLE = '新しい会話';
const SESSION_STORAGE_KEY = 'lens.agent-window.sessions.v1';
const DEFAULT_RAIL_WIDTH = 252;
const MIN_RAIL_WIDTH = 196;
const MAX_RAIL_WIDTH = 420;
const DEFAULT_CODE_SIDEBAR_WIDTH = 260;
const MIN_CODE_SIDEBAR_WIDTH = 180;
const MAX_CODE_SIDEBAR_WIDTH = 520;

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
    branch?: string;
    runTarget: 'local';
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
    static readonly SEARCH_WIDGET_FACTORY_ID = 'search-in-workspace';
    static readonly GIT_WIDGET_FACTORY_ID = 'scm-view';
    static readonly GIT_GRAPH_WIDGET_FACTORY_ID = 'scm-history-graph-widget';
    static readonly EDITOR_WIDGET_FACTORY_ID = 'code-editor-opener';
    static readonly SETTINGS_WIDGET_FACTORY_ID = 'settings_widget';
    static readonly EXTENSIONS_WIDGET_FACTORY_ID = 'vsx-extensions-view-container';
    protected codeMode = false;
    protected appPage?: AppPage;
    protected customizeTab: CustomizeTab = 'skills';
    protected codeSidebarTab: CodeSidebarTab = 'files';
    protected codeFilesWidget?: Widget;
    protected codeSearchWidget?: Widget;
    protected codeGitWidget?: Widget;
    protected codeGitGraphWidget?: Widget;
    protected codeGitGraphExpanded = true;
    protected codeExtensionsWidget?: Widget;
    protected codeExtensionsInitialized = false;
    protected codeTerminalWidget?: Widget;
    protected readonly codeCenterWidgets: Widget[] = [];
    protected readonly codeCenterWidgetListeners = new Map<Widget, Disposable>();
    protected readonly pendingDuplicateCodeWidgets = new WeakSet<Widget>();
    protected readonly pendingPinnedEditorUris = new Set<string>();
    protected activeCodeCenterWidget?: Widget;
    protected previewCodeCenterWidget?: Widget;
    protected pendingCodeCenterClose?: Widget;
    protected pendingCodeCenterCloseBusy = false;
    protected codeSidebarHost?: HTMLDivElement;
    protected codeGitGraphHost?: HTMLDivElement;
    protected codeEditorHost?: HTMLDivElement;
    protected codeTerminalHost?: HTMLDivElement;
    protected codeSidebarResizeObserver?: ResizeObserver;
    protected codeGitGraphResizeObserver?: ResizeObserver;
    protected codeEditorResizeObserver?: ResizeObserver;
    protected codeTerminalResizeObserver?: ResizeObserver;
    protected codeSidebarWidth = DEFAULT_CODE_SIDEBAR_WIDTH;
    protected codeSidebarResizeCleanup?: Disposable;
    protected codeSidebarTreeInteractionCleanup?: Disposable;
    protected codeFilePointerDrag?: {
        pointerId: number;
        uri: string;
        startX: number;
        startY: number;
        active: boolean;
        sourceNode: HTMLElement;
    };
    protected suppressNextCodeFileClick = false;
    protected explorerMoreVisible = false;
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
    protected agentSendButton?: HTMLButtonElement;
    protected workspacePickerVisible = false;
    protected workspaceSearchQuery = '';
    protected workspaceSearchInput?: HTMLInputElement;
    protected recentWorkspaceUris: string[] = [];
    protected repositoryPickerVisible = false;
    protected repositorySearchQuery = '';
    protected repositorySearchInput?: HTMLInputElement;
    protected branchPickerVisible = false;
    protected folderExplorerVisible = false;
    protected folderExplorerSessionId?: string;
    protected folderExplorerResult?: FolderBrowserResult;
    protected folderExplorerLoading = false;
    protected folderExplorerError?: string;
    protected folderExplorerAddress = '';
    protected creatingFolder = false;
    protected newFolderName = '';
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
        @inject(TerminalService) protected readonly terminalService: TerminalService,
        @inject(WidgetManager) protected readonly widgetManager: WidgetManager,
        @inject(EditorManager) protected readonly editorManager: EditorManager,
        @inject(CommandService) protected readonly commandService: CommandService,
        @inject(IconThemeService) protected readonly iconThemeService: IconThemeService,
        @inject(VSXExtensionsSearchModel) protected readonly extensionsSearchModel: VSXExtensionsSearchModel,
        @inject(StorageService) protected readonly storageService: StorageService,
        @inject(CustomizationService) protected readonly customizationService: CustomizationService,
        @inject(FolderExplorerService) protected readonly folderExplorerService: FolderExplorerService
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
            if ((this.repositoryPickerVisible || this.branchPickerVisible)
                && !(event.target as Element | null)?.closest('.lens-agent-window__new-agent-context')) {
                this.repositoryPickerVisible = false;
                this.branchPickerVisible = false;
                this.repositorySearchQuery = '';
                this.update();
            }
            if (this.workspacePickerVisible
                && !(event.target as Element | null)?.closest('.lens-agent-window__rail-heading')) {
                this.workspacePickerVisible = false;
                this.workspaceSearchQuery = '';
                this.update();
            }
            if (this.explorerMoreVisible
                && !(event.target as Element | null)?.closest('.lens-agent-window__code-explorer-more')) {
                this.explorerMoreVisible = false;
                this.update();
            }
        };
        document.addEventListener('pointerdown', closeSessionMenu);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('pointerdown', closeSessionMenu)));
        this.installCodeTabDropTarget();

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
        this.toDispose.push(this.customizationService.onDidChange(() => this.update()));
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => {
            void this.refreshRecentWorkspaces();
            this.update();
        }));
        this.toDispose.push(this.workspaceService.onWorkspaceLocationChanged(() => {
            void this.refreshRecentWorkspaces();
            this.update();
        }));
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
        void this.refreshRecentWorkspaces();
        this.update();
    }

    protected render(): React.ReactNode {
        const session = this.selectedSession();
        const activeTab = session?.activeTab ?? 'agent';
        const runningTask = this.runningTask(session);
        return (
            <div
                className='lens-agent-window__content'
                data-mode={this.appPage ?? (this.codeMode ? 'code' : activeTab)}
                data-rail-collapsed={this.railCollapsed ? 'true' : 'false'}
                style={{ '--lens-rail-width': `${this.railWidth}px` } as React.CSSProperties}
            >
                {!this.codeMode && this.renderRail()}
                <main className='lens-agent-window__workspace'>
                    {this.renderHeader()}
                    <div className='lens-agent-window__viewport'>
                        {this.appPage
                            ? this.renderAppPage()
                            : this.codeMode
                            ? this.renderCode()
                            : activeTab === 'agent'
                                ? this.renderAgent(session, runningTask)
                                : this.renderResults(session)}
                    </div>
                </main>
                {this.folderExplorerVisible && this.renderFolderExplorer()}
            </div>
        );
    }

    protected renderRail(): React.ReactNode {
        const activeSessions = this.filteredSessions(false).filter(session => session.hasUserMessage);
        const pinnedSessions = activeSessions.filter(session => session.pinned);
        const recentSessions = activeSessions.filter(session => !session.pinned);
        const archivedSessions = this.filteredSessions(true).filter(session => session.hasUserMessage);
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
                        aria-expanded={this.workspacePickerVisible}
                        aria-controls='lens-agent-window-workspace-picker'
                        onClick={() => this.toggleWorkspacePicker()}
                    >
                        <span className='codicon codicon-add' aria-hidden='true' />
                    </button>
                    {this.workspacePickerVisible && this.renderWorkspacePicker()}
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
                    <div className='lens-agent-window__rail-footer-actions'>
                        <button type='button' title='Customize' aria-label='Customize' onClick={() => this.openCustomize()}>
                            <span className='codicon codicon-tools' aria-hidden='true' />
                        </button>
                        <button type='button' title='設定' aria-label='設定' onClick={() => this.openSettings()}>
                            <span className='codicon codicon-settings-gear' aria-hidden='true' />
                        </button>
                    </div>
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

    protected repositoryChoices(): Array<{ uri: string; name: string; path: string }> {
        return this.workspaceService.tryGetRoots().map(root => ({
            uri: root.resource.toString(),
            name: root.resource.path.base || root.resource.displayName,
            path: root.resource.path.fsPath()
        }));
    }

    protected toggleWorkspacePicker(): void {
        this.workspacePickerVisible = !this.workspacePickerVisible;
        this.workspaceSearchQuery = '';
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
        const currentUris = new Set(this.repositoryChoices().map(choice => choice.uri));
        const choices = this.repositoryChoices().map(choice => ({ ...choice, current: true }));
        for (const workspaceUri of this.recentWorkspaceUris) {
            if (currentUris.has(workspaceUri)) {
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
                className='lens-agent-window__workspace-picker'
                id='lens-agent-window-workspace-picker'
                role='dialog'
                aria-label='Workspaceを開く'
            >
                <div className='lens-agent-window__workspace-picker-title'>Open workspace</div>
                <label className='lens-agent-window__workspace-picker-search'>
                    <span className='codicon codicon-search' aria-hidden='true' />
                    <input
                        ref={input => { this.workspaceSearchInput = input ?? undefined; }}
                        value={this.workspaceSearchQuery}
                        placeholder='Search workspaces'
                        aria-label='Workspaceを検索'
                        onChange={event => this.setWorkspaceSearchQuery(event.currentTarget.value)}
                        onKeyDown={event => {
                            if (event.key === 'Escape') {
                                this.workspacePickerVisible = false;
                                this.workspaceSearchQuery = '';
                                this.update();
                            }
                        }}
                    />
                </label>
                {currentChoices.length > 0 && (
                    <>
                        <div className='lens-agent-window__workspace-picker-label'>Current</div>
                        {currentChoices.map(choice => (
                            <button
                                type='button'
                                className='lens-agent-window__workspace-picker-item'
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
                        <div className='lens-agent-window__workspace-picker-label'>Recent</div>
                        {recentChoices.map(choice => (
                            <button
                                type='button'
                                className='lens-agent-window__workspace-picker-item'
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
                    <div className='lens-agent-window__workspace-picker-empty'>一致するWorkspaceはありません</div>
                )}
                <div className='lens-agent-window__workspace-picker-divider' />
                <button
                    type='button'
                    className='lens-agent-window__workspace-picker-item action'
                    onClick={() => void this.openRepository()}
                >
                    <span className='codicon codicon-folder-opened' aria-hidden='true' />
                    <span><strong>Open Folder…</strong><small>Choose a folder on this computer</small></span>
                </button>
            </div>
        );
    }

    protected openKnownWorkspace(workspaceUri: string): void {
        this.workspacePickerVisible = false;
        this.workspaceSearchQuery = '';
        this.workspaceService.open(new URI(workspaceUri), { preserveWindow: true });
    }

    protected repositoryLabel(workspaceUri: string | undefined): string {
        if (!workspaceUri) {
            return 'Select repository';
        }
        const known = this.repositoryChoices().find(choice => choice.uri === workspaceUri);
        return known?.name ?? new URI(workspaceUri).path.base ?? 'Repository';
    }

    protected toggleRepositoryPicker(): void {
        this.repositoryPickerVisible = !this.repositoryPickerVisible;
        this.branchPickerVisible = false;
        this.repositorySearchQuery = '';
        this.update();
        if (this.repositoryPickerVisible) {
            requestAnimationFrame(() => this.repositorySearchInput?.focus());
        }
    }

    protected toggleBranchPicker(): void {
        this.branchPickerVisible = !this.branchPickerVisible;
        this.repositoryPickerVisible = false;
        this.repositorySearchQuery = '';
        this.update();
    }

    protected closeNewAgentPickers(): void {
        this.repositoryPickerVisible = false;
        this.branchPickerVisible = false;
        this.repositorySearchQuery = '';
        this.update();
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

    protected async chooseExistingRepository(session: WindowAgentSession): Promise<void> {
        const folder = await this.fileDialogService.showOpenDialog({
            title: 'Select Repository',
            canSelectFiles: false,
            canSelectFolders: true
        }, this.workspaceRoot());
        if (!folder) {
            return;
        }
        session.workspaceUri = folder.toString();
        session.branch = 'main';
        session.updatedAt = Date.now();
        this.repositoryPickerVisible = false;
        this.repositorySearchQuery = '';
        this.persistWindowState();
        this.update();
        this.workspaceService.open(folder, { preserveWindow: true });
    }

    protected async openFolderExplorer(session: WindowAgentSession): Promise<void> {
        this.folderExplorerVisible = true;
        this.folderExplorerSessionId = session.id;
        this.folderExplorerError = undefined;
        this.creatingFolder = false;
        this.newFolderName = '';
        this.update();
        await this.loadFolderExplorer(session.workspaceUri
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
        const session = this.sessions.find(candidate => candidate.id === this.folderExplorerSessionId);
        const selectedPath = this.folderExplorerResult?.path;
        if (!session || !selectedPath) {
            return;
        }
        const folder = URI.fromFilePath(selectedPath);
        session.workspaceUri = folder.toString();
        session.branch = 'main';
        session.updatedAt = Date.now();
        this.repositoryPickerVisible = false;
        this.repositorySearchQuery = '';
        this.closeFolderExplorer();
        this.persistWindowState();
        this.workspaceService.open(folder, { preserveWindow: true });
    }

    protected async openRepository(): Promise<void> {
        this.workspacePickerVisible = false;
        this.workspaceSearchQuery = '';
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
        if (this.appPage) {
            return (
                <header className='lens-agent-window__header lens-agent-window__app-header'>
                    <div className='lens-agent-window__context'>
                        <small>Lens</small>
                        <strong>{this.appPage === 'settings' ? 'Settings' : 'Customize'}</strong>
                    </div>
                    <button type='button' className='lens-agent-window__app-close' onClick={() => this.closeAppPage()}>
                        <span className='codicon codicon-close' aria-hidden='true' />
                        <span>Close</span>
                    </button>
                </header>
            );
        }
        if (this.codeMode) {
            return (
                <header className='lens-agent-window__header lens-agent-window__code-header'>
                    <button
                        type='button'
                        className='lens-agent-window__code-control active'
                        aria-pressed='true'
                        aria-label='Agentへ戻る'
                        onClick={() => this.toggleCodeMode()}
                    >
                        <span className='codicon codicon-code' aria-hidden='true' />
                        <span>Code</span>
                    </button>
                    <span className='lens-agent-window__code-workspace'>{this.workspaceContextLabel()}</span>
                    <span className='lens-agent-window__code-hint'>Lens Workbench</span>
                </header>
            );
        }
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
                    <strong>{this.codeMode ? 'Code' : session?.hasUserMessage ? session.title : 'New Agent'}</strong>
                </div>
                {!this.codeMode && session?.hasUserMessage && (
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
        const newAgent = Boolean(session && !session.hasUserMessage);
        return (
            <section className='lens-agent-window__agent' aria-label='Agent の会話'>
                <div className='lens-agent-window__messages' aria-live='polite'>
                    <div className='lens-agent-window__messages-inner'>
                        {newAgent && session?.messages.length === 0 && (
                            <div className='lens-agent-window__new-agent-empty'>
                                <span className='codicon codicon-comment-add' aria-hidden='true' />
                                <strong>What do you want to build?</strong>
                                <small>Repository、branch、実行場所を選んでからAgentへ依頼します</small>
                            </div>
                        )}
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
                        key={session?.id ?? 'no-session'}
                        ref={input => { this.agentComposerInput = input ?? undefined; }}
                        defaultValue={session?.agentDraft ?? ''}
                        placeholder='次の変更内容や質問を入力…'
                        aria-label='Agent へのメッセージ'
                        rows={2}
                        disabled={!session || Boolean(runningTask)}
                        onChange={event => this.setAgentDraft(event.currentTarget.value)}
                        onCompositionEnd={event => this.setAgentDraft(event.currentTarget.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                                event.preventDefault();
                                void this.sendAgentMessage();
                            }
                        }}
                    />
                    <div className='lens-agent-window__composer-footer'>
                        {session && newAgent && this.renderNewAgentContext(session)}
                        <button
                            ref={button => { this.agentSendButton = button ?? undefined; }}
                            className='lens-agent-window__send'
                            type='button'
                            aria-label='Agent へ送信'
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

    protected renderAppPage(): React.ReactNode {
        const page = this.appPage ?? 'settings';
        return (
            <section className='lens-agent-window__app-page' aria-label={page === 'settings' ? 'Lensの設定' : 'Customize'}>
                <nav className='lens-agent-window__app-nav' aria-label='Lens preferences'>
                    <button
                        type='button'
                        className={page === 'settings' ? 'active' : ''}
                        aria-current={page === 'settings' ? 'page' : undefined}
                        onClick={() => this.openSettings()}
                    >
                        <span className='codicon codicon-settings-gear' aria-hidden='true' />
                        <span>Settings</span>
                    </button>
                    <button
                        type='button'
                        className={page === 'customize' ? 'active' : ''}
                        aria-current={page === 'customize' ? 'page' : undefined}
                        onClick={() => this.openCustomize()}
                    >
                        <span className='codicon codicon-tools' aria-hidden='true' />
                        <span>Customize</span>
                    </button>
                </nav>
                <div className='lens-agent-window__app-page-body'>
                    {page === 'settings' ? this.renderLensSettings() : this.renderCustomize()}
                </div>
            </section>
        );
    }

    protected renderFolderExplorer(): React.ReactNode {
        const result = this.folderExplorerResult;
        return (
            <section className='lens-folder-explorer' role='dialog' aria-modal='true' aria-label='フォルダーを選択'>
                <header className='lens-folder-explorer__header'>
                    <div>
                        <span className='codicon codicon-folder-opened' aria-hidden='true' />
                        <strong>Select workspace folder</strong>
                    </div>
                    <button type='button' aria-label='フォルダー選択を閉じる' onClick={() => this.closeFolderExplorer()}>
                        <span className='codicon codicon-close' aria-hidden='true' />
                    </button>
                </header>
                <div className='lens-folder-explorer__toolbar'>
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
                        <input
                            value={this.folderExplorerAddress}
                            aria-label='フォルダーパス'
                            onChange={event => {
                                this.folderExplorerAddress = event.currentTarget.value;
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
                <main className='lens-folder-explorer__body'>
                    <div className='lens-folder-explorer__column-heading'><span>Name</span><span>Type</span></div>
                    {this.creatingFolder && (
                        <div className='lens-folder-explorer__new-folder-row'>
                            <span className='codicon codicon-folder' aria-hidden='true' />
                            <input
                                autoFocus
                                value={this.newFolderName}
                                placeholder='New folder'
                                aria-label='新しいフォルダー名'
                                onChange={event => {
                                    this.newFolderName = event.currentTarget.value;
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
                            <button type='button' disabled={!this.newFolderName.trim()} onClick={() => void this.createFolderInExplorer()}>Create</button>
                        </div>
                    )}
                    {this.folderExplorerLoading && <div className='lens-folder-explorer__state'>Loading folders…</div>}
                    {!this.folderExplorerLoading && this.folderExplorerError && <div className='lens-folder-explorer__state error' role='alert'>{this.folderExplorerError}</div>}
                    {!this.folderExplorerLoading && !this.folderExplorerError && result?.directories.map(directory => (
                        <button
                            type='button'
                            className='lens-folder-explorer__folder-row'
                            key={directory.path}
                            onDoubleClick={() => void this.loadFolderExplorer(directory.path)}
                            onClick={() => void this.loadFolderExplorer(directory.path)}
                        >
                            <span><span className='codicon codicon-folder' aria-hidden='true' /><strong>{directory.name}</strong></span>
                            <small>File folder</small>
                            <span className='codicon codicon-chevron-right' aria-hidden='true' />
                        </button>
                    ))}
                    {!this.folderExplorerLoading && !this.folderExplorerError && result?.directories.length === 0 && (
                        <div className='lens-folder-explorer__state'>このフォルダーにサブフォルダーはありません。</div>
                    )}
                </main>
                <footer className='lens-folder-explorer__footer'>
                    <button
                        type='button'
                        className='lens-folder-explorer__new-folder'
                        onClick={() => {
                            this.creatingFolder = true;
                            this.newFolderName = '';
                            this.update();
                        }}
                    >
                        <span className='codicon codicon-new-folder' aria-hidden='true' />
                        New folder
                    </button>
                    <span className='lens-folder-explorer__selection'>{result?.path ?? ''}</span>
                    <button type='button' onClick={() => this.closeFolderExplorer()}>Cancel</button>
                    <button type='button' className='primary' disabled={!result || this.folderExplorerLoading} onClick={() => this.selectFolderFromExplorer()}>Select Folder</button>
                </footer>
            </section>
        );
    }

    protected renderLensSettings(): React.ReactNode {
        return (
            <div className='lens-agent-window__settings-page'>
                <div className='lens-agent-window__page-heading'>
                    <span className='codicon codicon-settings-gear' aria-hidden='true' />
                    <div><h1>Lens Settings</h1><p>Lens固有の動作とAgent環境を確認します。</p></div>
                </div>
                <section className='lens-agent-window__settings-section'>
                    <h2>Workspace</h2>
                    <div className='lens-agent-window__setting-row'>
                        <div><strong>Open workspace</strong><small>サイドバー内のpickerでWorkspaceを選び、その後フォルダー選択を開きます。</small></div>
                        <span className='lens-agent-window__status-badge'>Lens UI</span>
                    </div>
                </section>
                <section className='lens-agent-window__settings-section'>
                    <h2>Agent runtime</h2>
                    <div className='lens-agent-window__setting-row'>
                        <div><strong>Execution target</strong><small>Agentは現在のWorkspaceを対象に、このコンピューター上で実行されます。</small></div>
                        <span className='lens-agent-window__status-badge active'>Local</span>
                    </div>
                </section>
                <section className='lens-agent-window__settings-section'>
                    <h2>Customization</h2>
                    <div className='lens-agent-window__setting-row'>
                        <div><strong>Skills and Plugins</strong><small>利用中の機能を確認し、アプリ所有のSkillを有効・無効にします。</small></div>
                        <button type='button' className='lens-agent-window__secondary-action' onClick={() => this.openCustomize()}>
                            Open Customize
                        </button>
                    </div>
                </section>
            </div>
        );
    }

    protected renderCustomize(): React.ReactNode {
        const resultsEnabled = this.customizationService.isSkillEnabled('results');
        return (
            <div className='lens-agent-window__customize-page'>
                <div className='lens-agent-window__page-heading'>
                    <span className='codicon codicon-tools' aria-hidden='true' />
                    <div><h1>Customize Lens</h1><p>SkillsとPluginsを一か所で管理します。</p></div>
                </div>
                <div className='lens-agent-window__customize-tabs' role='tablist' aria-label='Customize categories'>
                    <button type='button' role='tab' aria-selected={this.customizeTab === 'skills'} className={this.customizeTab === 'skills' ? 'active' : ''} onClick={() => this.selectCustomizeTab('skills')}>Skills</button>
                    <button type='button' role='tab' aria-selected={this.customizeTab === 'plugins'} className={this.customizeTab === 'plugins' ? 'active' : ''} onClick={() => this.selectCustomizeTab('plugins')}>Plugins</button>
                </div>
                {this.customizeTab === 'skills' ? (
                    <div className='lens-agent-window__customize-list'>
                        <article className='lens-agent-window__customize-card'>
                            <div className='lens-agent-window__customize-icon'><span className='codicon codicon-preview' aria-hidden='true' /></div>
                            <div><div className='lens-agent-window__customize-title'><strong>Results</strong><span>Built-in</span></div><p>Task完了後に変更内容からResults文書を生成します。</p></div>
                            <label className='lens-agent-window__switch'>
                                <input type='checkbox' checked={resultsEnabled} aria-label='Results skillを有効化' onChange={event => this.customizationService.setSkillEnabled('results', event.currentTarget.checked)} />
                                <span aria-hidden='true' />
                            </label>
                        </article>
                    </div>
                ) : (
                    <div className='lens-agent-window__customize-list'>
                        <article className='lens-agent-window__customize-card'>
                            <div className='lens-agent-window__customize-icon'><span className='codicon codicon-package' aria-hidden='true' /></div>
                            <div><div className='lens-agent-window__customize-title'><strong>Lens plugin bundles</strong><span>App</span></div><p>LensのAgent、Skill、外部サービス連携を追加するアプリ用Pluginです。Code拡張機能とは別に管理されます。</p></div>
                            <span className='lens-agent-window__status-badge'>No additions</span>
                        </article>
                    </div>
                )}
            </div>
        );
    }

    protected selectCustomizeTab(tab: CustomizeTab): void {
        this.customizeTab = tab;
        this.update();
    }

    protected renderNewAgentContext(session: WindowAgentSession): React.ReactNode {
        const repositoryChoices = this.repositoryChoices();
        const query = this.repositorySearchQuery.trim().toLocaleLowerCase();
        const filteredChoices = repositoryChoices.filter(choice => !query
            || choice.name.toLocaleLowerCase().includes(query)
            || choice.path.toLocaleLowerCase().includes(query));
        const branch = session.branch ?? this.gitBranchForWorkspace(session.workspaceUri) ?? 'main';
        return (
            <div className='lens-agent-window__new-agent-context'>
                <button
                    type='button'
                    className='lens-agent-window__context-pill primary'
                    aria-expanded={this.repositoryPickerVisible}
                    aria-controls='lens-agent-window-repository-picker'
                    onClick={() => this.toggleRepositoryPicker()}
                >
                    <span className='codicon codicon-folder' aria-hidden='true' />
                    <span>{this.repositoryLabel(session.workspaceUri)}</span>
                    <span className='codicon codicon-chevron-down' aria-hidden='true' />
                </button>
                <button
                    type='button'
                    className='lens-agent-window__context-pill'
                    aria-expanded={this.branchPickerVisible}
                    aria-controls='lens-agent-window-branch-picker'
                    onClick={() => this.toggleBranchPicker()}
                >
                    <span className='codicon codicon-git-branch' aria-hidden='true' />
                    <span>{branch}</span>
                    <span className='codicon codicon-chevron-down' aria-hidden='true' />
                </button>
                <span className='lens-agent-window__context-pill static' title='現在利用できる実行先はLocalのみです'>
                    <span className='codicon codicon-device-desktop' aria-hidden='true' />
                    <span>Run on · This Computer</span>
                </span>
                {this.repositoryPickerVisible && (
                    <div
                        className='lens-agent-window__repository-picker'
                        id='lens-agent-window-repository-picker'
                        role='dialog'
                        aria-label='Repositoryを選択'
                    >
                        <label className='lens-agent-window__repository-search'>
                            <span className='codicon codicon-search' aria-hidden='true' />
                            <input
                                ref={input => { this.repositorySearchInput = input ?? undefined; }}
                                value={this.repositorySearchQuery}
                                placeholder='Search projects and repositories'
                                aria-label='Repositoryを検索'
                                onChange={event => this.setRepositorySearchQuery(event.currentTarget.value)}
                                onKeyDown={event => {
                                    if (event.key === 'Escape') {
                                        this.closeNewAgentPickers();
                                    }
                                }}
                            />
                        </label>
                        <div className='lens-agent-window__repository-group-label'>No Repo</div>
                        <button type='button' className='lens-agent-window__repository-option' disabled title='Local実行にはRepositoryが必要です'>
                            <span className='codicon codicon-circle-slash' aria-hidden='true' />
                            <span><strong>No Repo</strong><small>Local runtimeでは未対応</small></span>
                        </button>
                        {repositoryChoices.length > 0 && (
                            <>
                                <div className='lens-agent-window__repository-group-label'>Recents</div>
                                {repositoryChoices.slice(0, 2).map(choice => this.renderRepositoryChoice(session, choice, 'codicon-history'))}
                            </>
                        )}
                        <div className='lens-agent-window__repository-group-label'>On This PC</div>
                        {filteredChoices.map(choice => this.renderRepositoryChoice(session, choice, 'codicon-device-desktop'))}
                        {!filteredChoices.length && (
                            <div className='lens-agent-window__repository-empty'>一致するRepositoryはありません</div>
                        )}
                        <div className='lens-agent-window__repository-footer'>
                            <button type='button' onClick={() => void this.chooseExistingRepository(session)}>
                                <span className='codicon codicon-folder-opened' aria-hidden='true' />
                                Use Existing…
                            </button>
                            <button type='button' onClick={() => void this.openFolderExplorer(session)}>
                                <span className='codicon codicon-new-folder' aria-hidden='true' />
                                New Folder
                            </button>
                        </div>
                    </div>
                )}
                {this.branchPickerVisible && (
                    <div
                        className='lens-agent-window__branch-picker'
                        id='lens-agent-window-branch-picker'
                        role='dialog'
                        aria-label='Branchを選択'
                    >
                        <div className='lens-agent-window__repository-group-label'>Current branch</div>
                        <button type='button' className='lens-agent-window__repository-option selected' onClick={() => this.closeNewAgentPickers()}>
                            <span className='codicon codicon-git-branch' aria-hidden='true' />
                            <span><strong>{branch}</strong><small>Local checkout</small></span>
                            <span className='codicon codicon-check' aria-hidden='true' />
                        </button>
                    </div>
                )}
            </div>
        );
    }

    protected renderRepositoryChoice(
        session: WindowAgentSession,
        choice: { uri: string; name: string; path: string },
        iconClass: string
    ): React.ReactNode {
        const selected = session.workspaceUri === choice.uri;
        return (
            <button
                type='button'
                key={`${iconClass}-${choice.uri}`}
                className={`lens-agent-window__repository-option${selected ? ' selected' : ''}`}
                onClick={() => this.selectRepository(session, choice.uri)}
            >
                <span className={`codicon ${iconClass}`} aria-hidden='true' />
                <span><strong>{choice.name}</strong><small>{choice.path}</small></span>
                {selected && <span className='codicon codicon-check' aria-hidden='true' />}
            </button>
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
        const sidebarLabels: Record<CodeSidebarTab, string> = {
            files: 'Explorer',
            search: 'Search',
            git: 'Source Control',
            extensions: 'Extensions'
        };
        return (
            <section
                className='lens-agent-window__code'
                aria-label='Code モード'
                style={{ '--lens-code-sidebar-width': `${this.codeSidebarWidth}px` } as React.CSSProperties}
            >
                <nav className='lens-agent-window__code-activity' aria-label='Code Activity Bar'>
                    <div className='lens-agent-window__code-activity-main'>
                        {this.renderCodeActivity('files', 'files', 'Explorer')}
                        {this.renderCodeActivity('search', 'search', 'Search')}
                        {this.renderCodeActivity('git', 'source-control', 'Source Control')}
                        {this.renderCodeActivity('extensions', 'extensions', 'Extensions')}
                    </div>
                    <div className='lens-agent-window__code-activity-footer'>
                        <button type='button' title='Settings' aria-label='Settings' onClick={() => void this.openCodeSettings()}>
                            <span className='codicon codicon-settings-gear' aria-hidden='true' />
                        </button>
                    </div>
                </nav>
                <aside
                    className={`lens-agent-window__code-sidebar${this.codeSidebarTab === 'files' ? ' explorer' : ''}`}
                    aria-label='Code のサイドバー'
                >
                    <div className='lens-agent-window__code-sidebar-title'>
                        <span>{sidebarLabels[this.codeSidebarTab]}</span>
                        <div className='lens-agent-window__code-sidebar-actions'>
                            {this.codeSidebarTab === 'files' && (
                                <React.Fragment>
                                    {this.renderExplorerAction('new-file', 'New File', FileNavigatorCommands.NEW_FILE_TOOLBAR.id)}
                                    {this.renderExplorerAction('new-folder', 'New Folder', FileNavigatorCommands.NEW_FOLDER_TOOLBAR.id)}
                                    {this.renderExplorerAction('refresh', 'Refresh Explorer', FileNavigatorCommands.REFRESH_NAVIGATOR.id)}
                                    {this.renderExplorerAction('collapse-all', 'Collapse Folders', FileNavigatorCommands.COLLAPSE_ALL.id)}
                                </React.Fragment>
                            )}
                            {this.codeSidebarTab === 'search' && (
                                <React.Fragment>
                                    {this.renderSearchAction('refresh', 'Refresh Search Results', SearchInWorkspaceCommands.REFRESH_RESULTS.id)}
                                    {this.renderSearchAction('clear-all', 'Clear Search Results', SearchInWorkspaceCommands.CLEAR_ALL.id)}
                                    {this.renderSearchAction('collapse-all', 'Collapse All Search Results', SearchInWorkspaceCommands.COLLAPSE_ALL.id)}
                                </React.Fragment>
                            )}
                            {this.codeSidebarTab === 'git' && (
                                <button
                                    type='button'
                                    title='Refresh Source Control'
                                    aria-label='Refresh Source Control'
                                    onClick={() => void this.commandService.executeCommand('git.refresh')}
                                >
                                    <span className='codicon codicon-refresh' aria-hidden='true' />
                                </button>
                            )}
                            {this.codeSidebarTab === 'files' && (
                                <div className='lens-agent-window__code-explorer-more'>
                                    <button
                                        type='button'
                                        title='More Actions'
                                        aria-label='More Actions'
                                        aria-haspopup='menu'
                                        aria-expanded={this.explorerMoreVisible}
                                        onClick={() => {
                                            this.explorerMoreVisible = !this.explorerMoreVisible;
                                            this.update();
                                        }}
                                    >
                                        <span className='codicon codicon-ellipsis' aria-hidden='true' />
                                    </button>
                                    {this.explorerMoreVisible && this.renderExplorerMoreMenu()}
                                </div>
                            )}
                        </div>
                    </div>
                    {this.codeSidebarTab === 'files' && (
                        <div className='lens-agent-window__code-explorer-root'>
                            <span className='codicon codicon-chevron-down' aria-hidden='true' />
                            <strong>{this.workspaceFolderName()}</strong>
                        </div>
                    )}
                    {this.codeSidebarTab === 'git' ? (
                        <div className={`lens-agent-window__code-source-control${this.codeGitGraphExpanded ? ' graph-expanded' : ''}`}>
                            <div className='lens-agent-window__code-sidebar-host' ref={this.setCodeSidebarHost} />
                            <button
                                type='button'
                                className='lens-agent-window__code-git-graph-title'
                                aria-controls='lens-code-git-graph'
                                aria-expanded={this.codeGitGraphExpanded}
                                onClick={() => {
                                    this.codeGitGraphExpanded = !this.codeGitGraphExpanded;
                                    this.update();
                                }}
                            >
                                <span
                                    className={`codicon codicon-chevron-${this.codeGitGraphExpanded ? 'down' : 'right'}`}
                                    aria-hidden='true'
                                />
                                <strong>Graph</strong>
                            </button>
                            <div
                                id='lens-code-git-graph'
                                className='lens-agent-window__code-git-graph-host'
                                aria-hidden={!this.codeGitGraphExpanded}
                                hidden={!this.codeGitGraphExpanded}
                                ref={this.setCodeGitGraphHost}
                            />
                        </div>
                    ) : (
                        <div className='lens-agent-window__code-sidebar-host' ref={this.setCodeSidebarHost} />
                    )}
                    <div
                        className='lens-agent-window__code-sidebar-resize'
                        role='separator'
                        aria-label='Explorerの幅を変更'
                        aria-orientation='vertical'
                        aria-valuemin={MIN_CODE_SIDEBAR_WIDTH}
                        aria-valuemax={MAX_CODE_SIDEBAR_WIDTH}
                        aria-valuenow={this.codeSidebarWidth}
                        tabIndex={0}
                        onPointerDown={event => this.startCodeSidebarResize(event)}
                        onDoubleClick={() => this.setCodeSidebarWidth(DEFAULT_CODE_SIDEBAR_WIDTH)}
                        onKeyDown={event => {
                            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                                event.preventDefault();
                                this.setCodeSidebarWidth(this.codeSidebarWidth + (event.key === 'ArrowLeft' ? -12 : 12));
                            }
                        }}
                    />
                </aside>
                <main className='lens-agent-window__code-editor' aria-label='Editor'>
                    <div
                        className='lens-agent-window__code-editor-tabs'
                        role='tablist'
                        aria-label='開いているEditor'
                    >
                        {this.codeCenterWidgets.map(widget => {
                            const active = this.activeCodeCenterWidget === widget;
                            const dirty = Saveable.isDirty(widget);
                            const preview = this.previewCodeCenterWidget === widget;
                            const label = this.codeCenterWidgetLabel(widget);
                            return (
                                <div
                                    key={widget.id}
                                    className={`lens-agent-window__code-editor-tab${active ? ' active' : ''}${dirty ? ' dirty' : ''}${preview ? ' preview' : ''}`}
                                    data-code-widget-id={widget.id}
                                    data-preview={preview}
                                    onDoubleClick={() => this.pinCodeCenterWidget(widget)}
                                    onAuxClick={event => {
                                        if (event.button === 1) {
                                            event.preventDefault();
                                            void this.closeCodeCenterWidget(widget);
                                        }
                                    }}
                                >
                                    <button
                                        type='button'
                                        role='tab'
                                        aria-selected={active}
                                        tabIndex={active ? 0 : -1}
                                        title={widget.title.caption || label}
                                        className='lens-agent-window__code-editor-tab-label'
                                        onClick={() => this.selectCodeCenterWidget(widget)}
                                        onKeyDown={event => this.handleCodeTabKeyDown(event, widget)}
                                    >
                                        {widget.title.iconClass && <span className={widget.title.iconClass} aria-hidden='true' />}
                                        <span className='lens-agent-window__code-editor-tab-name'>{label}</span>
                                    </button>
                                    <button
                                        type='button'
                                        className='lens-agent-window__code-editor-tab-close'
                                        title='Close'
                                        aria-label={`${label}を閉じる`}
                                        onClick={() => void this.closeCodeCenterWidget(widget)}
                                    >
                                        {dirty && <span className='codicon codicon-circle-filled lens-agent-window__code-editor-tab-dirty' aria-hidden='true' />}
                                        <span className='codicon codicon-close lens-agent-window__code-editor-tab-close-icon' aria-hidden='true' />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                    <div className='lens-agent-window__code-editor-stack'>
                        <div className='lens-agent-window__code-editor-host' ref={this.setCodeEditorHost}>
                            {!this.activeCodeCenterWidget && (
                                <div className='lens-agent-window__code-empty'>ファイルを開いて編集を開始</div>
                            )}
                        </div>
                        <section className='lens-agent-window__code-panel' aria-label='Bottom Panel'>
                            <div className='lens-agent-window__code-panel-tabs'>
                                <span className='lens-agent-window__code-panel-tab active'>TERMINAL</span>
                                <span className='lens-agent-window__code-panel-spacer' />
                                <button type='button' title='New Terminal' aria-label='New Terminal' onClick={() => void this.createCodeTerminal()}>
                                    <span className='codicon codicon-add' aria-hidden='true' />
                                </button>
                            </div>
                            <div className='lens-agent-window__code-terminal-host' ref={this.setCodeTerminalHost} />
                        </section>
                    </div>
                </main>
                <footer className='lens-agent-window__code-status' aria-label='Status Bar'>
                    <span><span className='codicon codicon-source-control' aria-hidden='true' /> {this.currentGitBranch() ?? 'main'}</span>
                    <span><span className='codicon codicon-sync' aria-hidden='true' /></span>
                    <span><span className='codicon codicon-error' aria-hidden='true' /> 0</span>
                    <span><span className='codicon codicon-warning' aria-hidden='true' /> 0</span>
                    <span className='lens-agent-window__code-status-spacer' />
                    <span>UTF-8</span>
                    <span>LF</span>
                    <span>Spaces: 4</span>
                    <span><span className='codicon codicon-bell' aria-hidden='true' /></span>
                </footer>
                {this.renderCodeCenterCloseDialog()}
            </section>
        );
    }

    protected renderCodeCenterCloseDialog(): React.ReactNode {
        const widget = this.pendingCodeCenterClose;
        if (!widget) {
            return undefined;
        }
        const label = this.codeCenterWidgetLabel(widget);
        return (
            <div
                className='lens-agent-window__code-close-overlay'
                onKeyDown={event => {
                    if (event.key === 'Escape' && !this.pendingCodeCenterCloseBusy) {
                        event.preventDefault();
                        this.cancelCodeCenterClose();
                    }
                }}
            >
                <section
                    className='lens-agent-window__code-close-dialog'
                    role='dialog'
                    aria-modal='true'
                    aria-labelledby='lens-code-close-title'
                >
                    <header>
                        <h2 id='lens-code-close-title'>Save changes to {label}?</h2>
                        <button
                            type='button'
                            title='Cancel'
                            aria-label='Cancel'
                            disabled={this.pendingCodeCenterCloseBusy}
                            onClick={() => this.cancelCodeCenterClose()}
                        >
                            <span className='codicon codicon-close' aria-hidden='true' />
                        </button>
                    </header>
                    <p>Your changes will be lost if you don't save them.</p>
                    <footer>
                        <button
                            type='button'
                            disabled={this.pendingCodeCenterCloseBusy}
                            onClick={() => this.cancelCodeCenterClose()}
                        >
                            Cancel
                        </button>
                        <button
                            type='button'
                            disabled={this.pendingCodeCenterCloseBusy}
                            onClick={() => void this.resolveCodeCenterClose(false)}
                        >
                            Don't Save
                        </button>
                        <button
                            type='button'
                            className='primary'
                            autoFocus
                            disabled={this.pendingCodeCenterCloseBusy}
                            onClick={() => void this.resolveCodeCenterClose(true)}
                        >
                            Save
                        </button>
                    </footer>
                </section>
            </div>
        );
    }

    protected renderCodeActivity(tab: CodeSidebarTab, icon: string, label: string): React.ReactNode {
        return (
            <button
                type='button'
                className={this.codeSidebarTab === tab ? 'active' : ''}
                aria-pressed={this.codeSidebarTab === tab}
                title={label}
                aria-label={label}
                onClick={() => this.selectCodeSidebarTab(tab)}
            >
                <span className={`codicon codicon-${icon}`} aria-hidden='true' />
            </button>
        );
    }

    protected ensureCodeFileIcons(): void {
        if (this.iconThemeService.current === 'none' && this.iconThemeService.getDefinition('theia-file-icons')) {
            this.iconThemeService.current = 'theia-file-icons';
        }
    }

    protected renderExplorerAction(icon: string, label: string, command: string): React.ReactNode {
        return (
            <button
                type='button'
                title={label}
                aria-label={label}
                onClick={() => void this.commandService.executeCommand(command, this.codeFilesWidget)}
            >
                <span className={`codicon codicon-${icon}`} aria-hidden='true' />
            </button>
        );
    }

    protected renderSearchAction(icon: string, label: string, command: string): React.ReactNode {
        return (
            <button
                type='button'
                title={label}
                aria-label={label}
                onClick={() => void this.commandService.executeCommand(command, this.codeSearchWidget)}
            >
                <span className={`codicon codicon-${icon}`} aria-hidden='true' />
            </button>
        );
    }

    protected renderExplorerMoreMenu(): React.ReactNode {
        return (
            <div className='lens-agent-window__code-explorer-menu' role='menu' aria-label='Explorer More Actions'>
                {this.renderExplorerMenuItem('Toggle Hidden Files', FileNavigatorCommands.TOGGLE_HIDDEN_FILES.id)}
                {this.renderExplorerMenuItem('Auto Reveal', FileNavigatorCommands.TOGGLE_AUTO_REVEAL.id)}
                <div className='lens-agent-window__code-explorer-menu-separator' role='separator' />
                {this.renderExplorerMenuItem('Refresh Explorer', FileNavigatorCommands.REFRESH_NAVIGATOR.id)}
                {this.renderExplorerMenuItem('Collapse Folders', FileNavigatorCommands.COLLAPSE_ALL.id)}
            </div>
        );
    }

    protected renderExplorerMenuItem(label: string, command: string): React.ReactNode {
        return (
            <button
                type='button'
                role='menuitem'
                onClick={() => {
                    this.explorerMoreVisible = false;
                    void this.commandService.executeCommand(command, this.codeFilesWidget);
                    this.update();
                }}
            >
                {label}
            </button>
        );
    }

    registerCodeWidget(factoryId: string, widget: Widget, pinned = false): void {
        let changed = false;
        if (factoryId === AgentWindowWidget.FILES_WIDGET_FACTORY_ID) {
            changed = this.codeFilesWidget !== widget;
            this.codeFilesWidget = widget;
        } else if (factoryId === AgentWindowWidget.SEARCH_WIDGET_FACTORY_ID) {
            changed = this.codeSearchWidget !== widget;
            this.codeSearchWidget = widget;
        } else if (factoryId === AgentWindowWidget.GIT_WIDGET_FACTORY_ID) {
            changed = this.codeGitWidget !== widget;
            this.codeGitWidget = widget;
        } else if (factoryId === AgentWindowWidget.GIT_GRAPH_WIDGET_FACTORY_ID) {
            changed = this.codeGitGraphWidget !== widget;
            this.codeGitGraphWidget = widget;
        } else if (factoryId === AgentWindowWidget.EXTENSIONS_WIDGET_FACTORY_ID) {
            changed = this.codeExtensionsWidget !== widget;
            this.codeExtensionsWidget = widget;
        } else if (this.isCodeCenterWidget(factoryId, widget)
            && !this.codeCenterWidgets.includes(widget)) {
            if (widget instanceof EditorWidget) {
                const uri = widget.editor.uri.toString();
                const shouldPin = pinned || this.pendingPinnedEditorUris.has(uri);
                const existing = this.codeCenterWidgets.find(candidate => candidate instanceof EditorWidget
                    && candidate.editor.uri.toString() === uri);
                if (existing) {
                    if (shouldPin) {
                        this.pinCodeCenterWidget(existing);
                    }
                    this.selectCodeCenterWidget(existing);
                    this.closeDuplicateCodeWidget(widget);
                    return;
                }
                if (!shouldPin) {
                    const previousPreview = this.previewCodeCenterWidget;
                    if (previousPreview && previousPreview !== widget) {
                        if (Saveable.isDirty(previousPreview)) {
                            this.pinCodeCenterWidget(previousPreview);
                        } else {
                            this.previewCodeCenterWidget = undefined;
                            previousPreview.close();
                        }
                    }
                    this.previewCodeCenterWidget = widget;
                }
            }
            this.detachCodeWidget(this.activeCodeCenterWidget);
            this.codeCenterWidgets.push(widget);
            this.activeCodeCenterWidget = widget;
            changed = true;
            const onDisposed = (): void => this.removeCodeCenterWidget(widget);
            const onTitleChanged = (): void => this.update();
            widget.disposed.connect(onDisposed);
            widget.title.changed.connect(onTitleChanged);
            const dirtyListener = Saveable.get(widget)?.onDirtyChanged(() => {
                if (Saveable.isDirty(widget)) {
                    this.pinCodeCenterWidget(widget);
                } else {
                    this.update();
                }
            });
            const listeners = Disposable.create(() => {
                widget.disposed.disconnect(onDisposed);
                widget.title.changed.disconnect(onTitleChanged);
                dirtyListener?.dispose();
            });
            this.codeCenterWidgetListeners.set(widget, listeners);
            this.toDispose.push(listeners);
            requestAnimationFrame(() => this.revealCodeCenterTab(widget));
        }
        if (changed && this.codeMode) {
            this.update();
            this.syncCodeWidgetAttachments();
        }
    }

    protected closeDuplicateCodeWidget(widget: Widget): void {
        if (this.pendingDuplicateCodeWidgets.has(widget)) {
            return;
        }
        this.pendingDuplicateCodeWidgets.add(widget);
        requestAnimationFrame(() => {
            this.pendingDuplicateCodeWidgets.delete(widget);
            if (!widget.isDisposed) {
                widget.close();
            }
        });
    }

    protected isCodeCenterWidget(factoryId: string, widget: Widget): boolean {
        return widget instanceof EditorWidget
            || factoryId.startsWith(AgentWindowWidget.EDITOR_WIDGET_FACTORY_ID)
            || factoryId === AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID;
    }

    protected readonly setCodeSidebarHost = (host: HTMLDivElement | null): void => {
        this.codeSidebarTreeInteractionCleanup?.dispose();
        this.codeSidebarTreeInteractionCleanup = undefined;
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
        if (this.codeSidebarTab === 'git') {
            this.codeSidebarTreeInteractionCleanup = this.installCodeSidebarTreeInteractions(host);
        }
        this.syncCodeWidgetAttachments();
    };

    protected installCodeSidebarTreeInteractions(host: HTMLDivElement): Disposable {
        let gesture: {
            pointerId: number;
            node: HTMLElement;
            nodeId: string;
            targetCollapsed: boolean;
        } | undefined;
        let suppressClickNodeId: string | undefined;
        let suppressClickTimer: number | undefined;
        let pendingToggleNodeId: string | undefined;
        let pendingToggleCollapsed: boolean | undefined;
        let toggleGeneration = 0;
        let pendingToggleTimers: number[] = [];

        const expandableNode = (target: EventTarget | null): HTMLElement | undefined => {
            if (!(target instanceof Element)) {
                return undefined;
            }
            return target.closest<HTMLElement>('.theia-CompositeTreeNode.theia-ExpandableTreeNode') ?? undefined;
        };
        const expansionToggle = (node: HTMLElement): HTMLElement | undefined =>
            node.querySelector<HTMLElement>('.theia-ExpansionToggle[data-node-id]') ?? undefined;
        const expansionToggleByNodeId = (nodeId: string): HTMLElement | undefined =>
            Array.from(host.querySelectorAll<HTMLElement>('.theia-ExpansionToggle[data-node-id]'))
                .find(toggle => toggle.dataset.nodeId === nodeId);
        const isProtectedControl = (target: EventTarget | null): boolean => target instanceof Element
            && !!target.closest('.theia-ExpansionToggle, .theia-scm-inline-actions-container, button, input, textarea, select, a');
        const clearGesture = (): void => {
            gesture = undefined;
        };
        const clearSuppressedClick = (): void => {
            suppressClickNodeId = undefined;
            if (suppressClickTimer !== undefined) {
                window.clearTimeout(suppressClickTimer);
                suppressClickTimer = undefined;
            }
        };
        const clearPendingToggle = (): void => {
            toggleGeneration++;
            for (const timer of pendingToggleTimers) {
                window.clearTimeout(timer);
            }
            pendingToggleTimers = [];
            pendingToggleNodeId = undefined;
            pendingToggleCollapsed = undefined;
        };
        const onPointerDown = (event: PointerEvent): void => {
            if (event.button === 0 && event.isPrimary && event.pointerType === 'mouse') {
                clearSuppressedClick();
            }
            if (event.button !== 0 || !event.isPrimary || event.pointerType !== 'mouse' || isProtectedControl(event.target)) {
                clearGesture();
                return;
            }
            const node = expandableNode(event.target);
            const toggle = node && expansionToggle(node);
            const nodeId = toggle?.dataset.nodeId;
            if (!node || !nodeId) {
                clearGesture();
                return;
            }
            const currentCollapsed = pendingToggleNodeId === nodeId
                ? pendingToggleCollapsed
                : toggle.classList.contains('theia-mod-collapsed');
            clearPendingToggle();
            window.getSelection()?.removeAllRanges();
            event.preventDefault();
            gesture = {
                pointerId: event.pointerId,
                node,
                nodeId,
                targetCollapsed: !currentCollapsed
            };
            try {
                node.setPointerCapture(event.pointerId);
            } catch {
                // The node can be redrawn while Git finishes registering its actions.
            }
        };
        const onPointerUp = (event: PointerEvent): void => {
            const active = gesture;
            clearGesture();
            if (!active || event.pointerId !== active.pointerId || expandableNode(event.target) !== active.node) {
                return;
            }
            event.preventDefault();
            clearSuppressedClick();
            suppressClickNodeId = active.nodeId;
            suppressClickTimer = window.setTimeout(clearSuppressedClick, 250);
            pendingToggleNodeId = active.nodeId;
            pendingToggleCollapsed = active.targetCollapsed;
            const generation = ++toggleGeneration;
            const applyToggle = (): void => {
                if (generation !== toggleGeneration) {
                    return;
                }
                const toggle = expansionToggleByNodeId(active.nodeId);
                if (toggle && toggle.classList.contains('theia-mod-collapsed') !== active.targetCollapsed) {
                    toggle.click();
                }
            };
            pendingToggleTimers = [50, 200, 500].map((delay, index, delays) => window.setTimeout(() => {
                applyToggle();
                if (index === delays.length - 1 && generation === toggleGeneration) {
                    pendingToggleTimers = [];
                    pendingToggleNodeId = undefined;
                    pendingToggleCollapsed = undefined;
                }
            }, delay));
        };
        const onClick = (event: MouseEvent): void => {
            if (!suppressClickNodeId || (event.target instanceof Element && event.target.closest('.theia-ExpansionToggle'))) {
                return;
            }
            clearSuppressedClick();
            event.preventDefault();
            event.stopImmediatePropagation();
        };

        host.addEventListener('pointerdown', onPointerDown, true);
        host.addEventListener('pointerup', onPointerUp, true);
        host.addEventListener('pointercancel', clearGesture, true);
        host.addEventListener('click', onClick, true);
        return Disposable.create(() => {
            clearGesture();
            clearSuppressedClick();
            clearPendingToggle();
            host.removeEventListener('pointerdown', onPointerDown, true);
            host.removeEventListener('pointerup', onPointerUp, true);
            host.removeEventListener('pointercancel', clearGesture, true);
            host.removeEventListener('click', onClick, true);
        });
    }

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

    protected readonly setCodeGitGraphHost = (host: HTMLDivElement | null): void => {
        if (!host) {
            this.codeGitGraphResizeObserver?.disconnect();
            this.codeGitGraphResizeObserver = undefined;
            this.detachCodeWidget(this.codeGitGraphWidget);
            this.codeGitGraphHost = undefined;
            return;
        }
        this.codeGitGraphHost = host;
        this.codeGitGraphResizeObserver = new ResizeObserver(() =>
            this.resizeCodeWidget(this.codeGitGraphWidget, host));
        this.codeGitGraphResizeObserver.observe(host);
        this.syncCodeWidgetAttachments();
    };

    protected readonly setCodeTerminalHost = (host: HTMLDivElement | null): void => {
        if (!host) {
            this.codeTerminalResizeObserver?.disconnect();
            this.codeTerminalResizeObserver = undefined;
            this.detachCodeWidget(this.codeTerminalWidget);
            this.codeTerminalHost = undefined;
            return;
        }
        this.codeTerminalHost = host;
        this.codeTerminalResizeObserver = new ResizeObserver(() =>
            this.resizeCodeWidget(this.codeTerminalWidget, host));
        this.codeTerminalResizeObserver.observe(host);
        void this.ensureCodeTerminal();
    };

    protected activeCodeSidebarWidget(): Widget | undefined {
        if (this.codeSidebarTab === 'files') {
            return this.codeFilesWidget;
        }
        if (this.codeSidebarTab === 'search') {
            return this.codeSearchWidget;
        }
        if (this.codeSidebarTab === 'git') {
            return this.codeGitWidget;
        }
        return this.codeExtensionsWidget;
    }

    protected syncCodeWidgetAttachments(): void {
        if (!this.codeMode) {
            this.detachCodeWidgets();
            return;
        }
        this.attachCodeWidget(this.activeCodeSidebarWidget(), this.codeSidebarHost);
        if (this.codeSidebarTab === 'git') {
            this.attachCodeWidget(this.codeGitGraphWidget, this.codeGitGraphHost);
        } else {
            this.detachCodeWidget(this.codeGitGraphWidget);
        }
        this.attachCodeWidget(this.activeCodeCenterWidget, this.codeEditorHost);
        this.attachCodeWidget(this.codeTerminalWidget, this.codeTerminalHost);
    }

    protected async ensureCodeTerminal(): Promise<void> {
        if (!this.codeTerminalWidget) {
            this.codeTerminalWidget = this.terminalService.all[0] ?? await this.terminalService.newTerminal({});
        }
        if (this.codeMode) {
            this.attachCodeWidget(this.codeTerminalWidget, this.codeTerminalHost);
        }
    }

    protected async createCodeTerminal(): Promise<void> {
        this.detachCodeWidget(this.codeTerminalWidget);
        this.codeTerminalWidget = await this.terminalService.newTerminal({});
        this.attachCodeWidget(this.codeTerminalWidget, this.codeTerminalHost);
        this.update();
    }

    protected attachCodeWidget(widget: Widget | undefined, host: HTMLDivElement | undefined): void {
        if (!widget || !host) {
            return;
        }
        if (widget.node.parentElement !== host) {
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
        if (widget?.isAttached && (parent === this.codeSidebarHost
            || parent === this.codeGitGraphHost
            || parent === this.codeEditorHost
            || parent === this.codeTerminalHost)) {
            Widget.detach(widget);
        }
    }

    protected detachCodeWidgets(): void {
        this.detachCodeWidget(this.activeCodeSidebarWidget());
        this.detachCodeWidget(this.codeGitGraphWidget);
        this.detachCodeWidget(this.activeCodeCenterWidget);
        this.detachCodeWidget(this.codeTerminalWidget);
    }

    protected selectCodeSidebarTab(tab: CodeSidebarTab): void {
        this.detachCodeWidget(this.activeCodeSidebarWidget());
        this.detachCodeWidget(this.codeGitGraphWidget);
        this.explorerMoreVisible = false;
        this.codeSidebarTab = tab;
        this.update();
        if (tab === 'extensions') {
            void this.ensureCodeExtensionsWidget();
        } else {
            this.syncCodeWidgetAttachments();
        }
    }

    protected async ensureCodeExtensionsWidget(): Promise<void> {
        if (!this.codeExtensionsWidget) {
            this.codeExtensionsWidget = await this.widgetManager.getOrCreateWidget(AgentWindowWidget.EXTENSIONS_WIDGET_FACTORY_ID);
        }
        if (!this.codeExtensionsInitialized) {
            this.codeExtensionsInitialized = true;
            if (!this.extensionsSearchModel.query.trim()) {
                this.extensionsSearchModel.query = BUILTIN_QUERY;
            }
        }
        if (this.codeMode && this.codeSidebarTab === 'extensions') {
            this.attachCodeWidget(this.codeExtensionsWidget, this.codeSidebarHost);
        }
    }

    protected startCodeSidebarResize(event: React.PointerEvent<HTMLDivElement>): void {
        event.preventDefault();
        this.codeSidebarResizeCleanup?.dispose();
        const startX = event.clientX;
        const startWidth = this.codeSidebarWidth;
        const onPointerMove = (moveEvent: PointerEvent): void => {
            this.setCodeSidebarWidth(startWidth + moveEvent.clientX - startX);
        };
        const finish = (): void => {
            this.codeSidebarResizeCleanup?.dispose();
            this.codeSidebarResizeCleanup = undefined;
        };
        document.body.classList.add('lens-code-sidebar-resizing');
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', finish, { once: true });
        document.addEventListener('pointercancel', finish, { once: true });
        this.codeSidebarResizeCleanup = Disposable.create(() => {
            document.body.classList.remove('lens-code-sidebar-resizing');
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', finish);
        });
    }

    protected setCodeSidebarWidth(width: number): void {
        this.codeSidebarWidth = Math.max(MIN_CODE_SIDEBAR_WIDTH, Math.min(MAX_CODE_SIDEBAR_WIDTH, width));
        const code = this.node.querySelector<HTMLElement>('.lens-agent-window__code');
        code?.style.setProperty('--lens-code-sidebar-width', `${this.codeSidebarWidth}px`);
        this.node.querySelector('.lens-agent-window__code-sidebar-resize')
            ?.setAttribute('aria-valuenow', `${this.codeSidebarWidth}`);
    }

    protected selectCodeCenterWidget(widget: Widget, focusTab = false): void {
        this.detachCodeWidget(this.activeCodeCenterWidget);
        this.activeCodeCenterWidget = widget;
        this.update();
        this.syncCodeWidgetAttachments();
        requestAnimationFrame(() => this.revealCodeCenterTab(widget, focusTab));
    }

    protected pinCodeCenterWidget(widget: Widget): void {
        if (this.previewCodeCenterWidget === widget) {
            this.previewCodeCenterWidget = undefined;
            this.update();
        }
    }

    protected installCodeTabDropTarget(): void {
        const onPointerDown = (event: PointerEvent): void => {
            if (event.button !== 0 || !(event.target instanceof Element)) {
                return;
            }
            const node = event.target.closest<HTMLElement>('#files .theia-FileStatNode[draggable="true"]');
            if (!node || node.classList.contains('theia-ExpandableTreeNode') || !node.title) {
                return;
            }
            this.finishCodeFilePointerDrag();
            const uri = FileUri.create(node.title).toString();
            this.codeFilePointerDrag = {
                pointerId: event.pointerId,
                uri,
                startX: event.clientX,
                startY: event.clientY,
                active: false,
                sourceNode: node
            };
            node.draggable = false;
        };
        const onPointerMove = (event: PointerEvent): void => {
            const drag = this.codeFilePointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) {
                return;
            }
            if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) {
                return;
            }
            drag.active = true;
            event.preventDefault();
            document.body?.classList.add('lens-code-file-pointer-drag');
            this.setCodeTabDropActive(!!this.codeTabsAtPoint(event.clientX, event.clientY));
        };
        const onPointerUp = (event: PointerEvent): void => {
            const drag = this.codeFilePointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) {
                return;
            }
            const droppedOnTabs = drag.active && !!this.codeTabsAtPoint(event.clientX, event.clientY);
            if (drag.active) {
                event.preventDefault();
                event.stopPropagation();
                this.suppressNextCodeFileClick = true;
                setTimeout(() => this.suppressNextCodeFileClick = false, 0);
            }
            const uri = drag.uri;
            this.finishCodeFilePointerDrag();
            if (droppedOnTabs) {
                void this.openDraggedCodeFile(uri);
            }
        };
        const onPointerCancel = (event: PointerEvent): void => {
            if (this.codeFilePointerDrag?.pointerId === event.pointerId) {
                this.finishCodeFilePointerDrag();
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && this.codeFilePointerDrag?.active) {
                event.preventDefault();
                this.finishCodeFilePointerDrag();
            }
        };
        const onWindowBlur = (): void => this.finishCodeFilePointerDrag();
        const onClick = (event: MouseEvent): void => {
            if (!this.suppressNextCodeFileClick) {
                return;
            }
            this.suppressNextCodeFileClick = false;
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerCancel, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('click', onClick, true);
        window.addEventListener('blur', onWindowBlur);
        this.toDispose.push(Disposable.create(() => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('pointermove', onPointerMove, true);
            document.removeEventListener('pointerup', onPointerUp, true);
            document.removeEventListener('pointercancel', onPointerCancel, true);
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('click', onClick, true);
            window.removeEventListener('blur', onWindowBlur);
            this.finishCodeFilePointerDrag();
        }));
    }

    protected codeTabsAtPoint(clientX: number, clientY: number): HTMLElement | undefined {
        const tabs = this.node.querySelector<HTMLElement>('.lens-agent-window__code-editor-tabs');
        if (!tabs) {
            return undefined;
        }
        const bounds = tabs.getBoundingClientRect();
        return clientX >= bounds.left && clientX <= bounds.right
            && clientY >= bounds.top && clientY <= bounds.bottom
            ? tabs
            : undefined;
    }

    protected finishCodeFilePointerDrag(): void {
        const drag = this.codeFilePointerDrag;
        if (drag) {
            drag.sourceNode.draggable = true;
        }
        this.codeFilePointerDrag = undefined;
        document.body?.classList.remove('lens-code-file-pointer-drag');
        this.setCodeTabDropActive(false);
    }

    protected setCodeTabDropActive(active: boolean): void {
        this.node.querySelector('.lens-agent-window__code-editor-tabs')?.classList.toggle('drop-target', active);
    }

    protected async openDraggedCodeFile(rawUri: string): Promise<void> {
        if (!rawUri) {
            return;
        }
        const uri = new URI(rawUri);
        const uriKey = uri.toString();
        this.pendingPinnedEditorUris.add(uriKey);
        try {
            await this.editorManager.open(uri);
            const opened = this.codeCenterWidgets.find(candidate => candidate instanceof EditorWidget
                && candidate.editor.uri.toString() === uriKey);
            if (opened) {
                this.pinCodeCenterWidget(opened);
                this.selectCodeCenterWidget(opened);
            }
        } finally {
            this.pendingPinnedEditorUris.delete(uriKey);
        }
    }

    protected closeCodeCenterWidget(widget: Widget): void {
        if (widget.id === AgentWindowWidget.SETTINGS_WIDGET_FACTORY_ID) {
            this.detachCodeWidget(widget);
            widget.hide();
            this.removeCodeCenterWidget(widget);
            return;
        }
        if (!Saveable.isDirty(widget)) {
            widget.close();
            return;
        }
        this.pendingCodeCenterClose = widget;
        this.pendingCodeCenterCloseBusy = false;
        this.update();
    }

    protected cancelCodeCenterClose(): void {
        if (this.pendingCodeCenterCloseBusy) {
            return;
        }
        this.pendingCodeCenterClose = undefined;
        this.update();
    }

    protected async resolveCodeCenterClose(save: boolean): Promise<void> {
        const widget = this.pendingCodeCenterClose;
        if (!widget || this.pendingCodeCenterCloseBusy) {
            return;
        }
        const saveable = Saveable.get(widget);
        this.pendingCodeCenterCloseBusy = true;
        this.update();
        try {
            if (save) {
                await saveable?.save();
                if (Saveable.isDirty(widget)) {
                    return;
                }
            } else {
                await saveable?.revert?.();
            }
            this.pendingCodeCenterClose = undefined;
            widget.close();
        } finally {
            this.pendingCodeCenterCloseBusy = false;
            this.update();
        }
    }

    protected removeCodeCenterWidget(widget: Widget): void {
        const index = this.codeCenterWidgets.indexOf(widget);
        const nextWidget = index === -1
            ? undefined
            : this.codeCenterWidgets[index + 1] ?? this.codeCenterWidgets[index - 1];
        if (index !== -1) {
            this.codeCenterWidgets.splice(index, 1);
        }
        this.codeCenterWidgetListeners.get(widget)?.dispose();
        this.codeCenterWidgetListeners.delete(widget);
        if (this.previewCodeCenterWidget === widget) {
            this.previewCodeCenterWidget = undefined;
        }
        if (this.pendingCodeCenterClose === widget) {
            this.pendingCodeCenterClose = undefined;
            this.pendingCodeCenterCloseBusy = false;
        }
        if (this.activeCodeCenterWidget === widget) {
            this.activeCodeCenterWidget = nextWidget;
        }
        this.update();
        this.syncCodeWidgetAttachments();
        if (this.activeCodeCenterWidget) {
            requestAnimationFrame(() => this.revealCodeCenterTab(this.activeCodeCenterWidget));
        }
    }

    protected handleCodeTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, widget: Widget): void {
        const index = this.codeCenterWidgets.indexOf(widget);
        if (index === -1 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            return;
        }
        event.preventDefault();
        let nextIndex = index;
        if (event.key === 'ArrowLeft') {
            nextIndex = (index - 1 + this.codeCenterWidgets.length) % this.codeCenterWidgets.length;
        } else if (event.key === 'ArrowRight') {
            nextIndex = (index + 1) % this.codeCenterWidgets.length;
        } else if (event.key === 'Home') {
            nextIndex = 0;
        } else if (event.key === 'End') {
            nextIndex = this.codeCenterWidgets.length - 1;
        }
        this.selectCodeCenterWidget(this.codeCenterWidgets[nextIndex], true);
    }

    protected revealCodeCenterTab(widget: Widget | undefined, focus = false): void {
        if (!widget) {
            return;
        }
        const tab = Array.from(this.node.querySelectorAll<HTMLElement>('.lens-agent-window__code-editor-tab'))
            .find(candidate => candidate.dataset.codeWidgetId === widget.id);
        tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (focus) {
            tab?.querySelector<HTMLButtonElement>('.lens-agent-window__code-editor-tab-label')?.focus();
        }
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
        this.detachCodeWidgets();
        this.codeMode = false;
        this.appPage = 'settings';
        this.update();
    }

    protected openCustomize(): void {
        this.detachCodeWidgets();
        this.codeMode = false;
        this.appPage = 'customize';
        this.update();
    }

    protected closeAppPage(): void {
        this.appPage = undefined;
        this.update();
    }

    protected onBeforeDetach(message: Message): void {
        this.railResizeCleanup?.dispose();
        this.railResizeCleanup = undefined;
        this.codeSidebarResizeCleanup?.dispose();
        this.codeSidebarResizeCleanup = undefined;
        this.codeSidebarResizeObserver?.disconnect();
        this.codeEditorResizeObserver?.disconnect();
        this.codeTerminalResizeObserver?.disconnect();
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
        this.appPage = undefined;
        session.updatedAt = Date.now();
        this.openSessionMenuId = undefined;
        if (session.hasUserMessage) {
            void this.ensureProviderSession(session);
        }
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

    protected workspaceContextLabel(session = this.selectedSession()): string {
        const workspace = session?.workspaceUri ? this.repositoryLabel(session.workspaceUri) : this.workspaceFolderName();
        const branch = session?.branch ?? this.gitBranchForWorkspace(session?.workspaceUri) ?? this.currentGitBranch();
        return branch ? `${workspace} / ${branch}` : workspace;
    }

    protected gitBranchForWorkspace(workspaceUri: string | undefined): string | undefined {
        if (!workspaceUri) {
            return undefined;
        }
        const repository = this.scmService.findRepository(new URI(workspaceUri));
        const provider = repository?.provider;
        if (provider?.id.toLowerCase() !== 'git') {
            return undefined;
        }
        const ref = provider.historyProvider?.currentHistoryItemRef;
        return ref?.id.startsWith('refs/heads/') ? ref.name.trim() || undefined : undefined;
    }

    protected currentGitBranch(): string | undefined {
        const root = this.workspaceRoot();
        return this.gitBranchForWorkspace(root?.resource.toString());
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
            branch: this.currentGitBranch() ?? 'main',
            runTarget: 'local',
            title: NEW_SESSION_TITLE,
            hasUserMessage: false,
            pinned: false,
            archived: false,
            activeTab: 'agent',
            agentDraft: '',
            messages: [],
            resultsDrafts: new Map<string, string>(),
            resultsNotices: new Map<string, string>()
        };
        this.sessions.push(session);
        this.selectedSessionId = session.id;
        this.openSessionMenuId = undefined;
        this.persistWindowState();
        this.update();
    }

    protected async ensureProviderSession(
        session: WindowAgentSession,
        replaceStatus = false,
        silent = false
    ): Promise<boolean> {
        if (session.agentSession) {
            return true;
        }
        try {
            session.agentSession = await this.agentProvider.createSession({
                workspaceUri: session.workspaceUri
            });
            if (!silent && (replaceStatus || session.messages.length === 0 || session.messages.every(message => message.id.startsWith('provider-')))) {
                session.messages = [{
                    id: `provider-ready-${session.id}`,
                    role: 'agent',
                    content: '準備ができました。変更したい内容を入力してください。',
                    complete: true
                }];
            }
            this.persistWindowState();
            this.update();
            return true;
        } catch (error) {
            if (replaceStatus || session.messages.length === 0 || session.messages.every(message => message.id.startsWith('provider-'))) {
                session.messages = [{
                    id: `provider-error-${session.id}`,
                    role: 'agent',
                    content: `エージェントを準備できませんでした: ${error instanceof Error ? error.message : String(error)}`,
                    complete: true
                }];
            }
            this.persistWindowState();
            this.update();
            return false;
        }
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
                    workspaceUri: typeof candidate.workspaceUri === 'string'
                        ? candidate.workspaceUri
                        : this.workspaceRoot()?.resource.toString(),
                    branch: typeof candidate.branch === 'string' ? candidate.branch : this.currentGitBranch() ?? 'main',
                    runTarget: 'local',
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
        if (selected.hasUserMessage) {
            await this.ensureProviderSession(selected);
        }
    }

    protected async sendAgentMessage(): Promise<void> {
        const session = this.selectedSession();
        const content = session?.agentDraft.trim() ?? '';
        if (!session || !session.workspaceUri || !content || this.runningTask(session)) {
            return;
        }
        if (!session.agentSession && !await this.ensureProviderSession(session, false, true)) {
            return;
        }
        if (!session.agentSession) {
            return;
        }
        session.agentDraft = '';
        if (this.agentComposerInput) {
            this.agentComposerInput.value = '';
        }
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
        this.appPage = undefined;
        if (this.codeMode) {
            this.detachCodeWidgets();
            this.codeMode = false;
        } else {
            this.ensureCodeFileIcons();
            this.codeMode = true;
            requestAnimationFrame(() => void this.ensureCodeTerminal());
        }
        this.update();
    }

    protected selectTab(tab: AgentWindowTab): void {
        this.appPage = undefined;
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
        this.appPage = undefined;
        this.sessionSearchVisible = false;
        this.sessionSearchQuery = '';
        this.repositoryPickerVisible = false;
        this.branchPickerVisible = false;
        this.repositorySearchQuery = '';
        const current = this.selectedSession();
        if (current && !current.archived && !current.hasUserMessage) {
            current.activeTab = 'agent';
            this.persistWindowState();
            this.update();
            requestAnimationFrame(() => this.agentComposerInput?.focus());
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
        if (this.agentSendButton) {
            this.agentSendButton.disabled = !session?.workspaceUri || Boolean(this.runningTask(session)) || !value.trim();
        }
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
