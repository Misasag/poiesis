import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { FormatType, Saveable, SaveableService, SaveReason, StorageService, WidgetManager } from '@theia/core/lib/browser';
import { IconThemeService } from '@theia/core/lib/browser/icon-theme-service';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { CommandService, Disposable } from '@theia/core/lib/common';
import { FileUri } from '@theia/core/lib/common/file-uri';
import URI from '@theia/core/lib/common/uri';
import { Message, MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { EditorManager, EditorWidget } from '@theia/editor/lib/browser';
import { ScmHistoryProvider, ScmProvider } from '@theia/scm/lib/browser/scm-provider';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { FileNavigatorCommands } from '@theia/navigator/lib/browser/navigator-contribution';
import { SearchInWorkspaceCommands } from '@theia/search-in-workspace/lib/browser/search-in-workspace-frontend-contribution';
import { BUILTIN_QUERY, VSXExtensionsSearchModel } from '@theia/vsx-registry/lib/browser/vsx-extensions-search-model';
import { AgentEvent, AgentProvider, AgentSession } from '../common/agent-provider';
import {
    AgentRuntimeServer,
    AiRole,
    CliDetectionReport,
    DEFAULT_CLI_ID,
    FolderBrowserResult,
    isKnownCliId,
    KnownCliId
} from '../common/agent-runtime-protocol';
import { ResultsService, TaskResultDocument } from './results-skill';
import { ExecutionTask, TaskService } from './task-service';
import { getDesignVariant } from './design-variant';
import { FolderExplorerService } from './folder-explorer-service';
import { ResultsQuestionService } from './results-question-service';
import { GlobalStorageService } from './global-storage-service';
import { ResultsGenerationContext } from './results-generation-context';
import { SkillBundleKind } from '../common/skill-bundle';

type AgentWindowTab = 'agent' | 'results';
type CodeSidebarTab = 'files' | 'search' | 'git' | 'extensions';
type UiFontScale = 'small' | 'standard' | 'large';
const NEW_SESSION_TITLE = '新しい会話';
const SESSION_STORAGE_KEY = 'poiesis.agent-window.sessions.v1';
const GLOBAL_SESSION_STORAGE_KEY = 'poiesis.agent-window.sessions.global.v1';
const SESSION_MIGRATION_MARKER_KEY = 'poiesis.agent-window.sessions.migrated.v1';
const SETTINGS_STORAGE_KEY = 'poiesis.settings.v1';
const DEFAULT_RAIL_WIDTH = 258;
const MIN_RAIL_WIDTH = 196;
const MAX_RAIL_WIDTH = 420;
const DEFAULT_CODE_SIDEBAR_WIDTH = 260;
const MIN_CODE_SIDEBAR_WIDTH = 180;
const MAX_CODE_SIDEBAR_WIDTH = 520;
const DEFAULT_CODE_PANEL_HEIGHT = 190;
const MIN_CODE_PANEL_HEIGHT = 96;
const MAX_PERSISTED_TASKS_PER_SESSION = 10;
const MAX_PERSISTED_RESULTS_HTML_CHARS = 300_000;

interface ChatMessage {
    id: string;
    role: 'user' | 'agent';
    content: string;
    complete: boolean;
    taskId?: string;
    error?: boolean;
    errorDetails?: string;
}

interface ResultsNotice {
    question: string;
    status: 'sending' | 'answered' | 'failed';
    text: string;
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
    lastTaskStatus?: 'completed' | 'failed' | 'cancelled';
    unreadTaskCompletion?: boolean;
    pinned: boolean;
    archived: boolean;
    activeTab: AgentWindowTab;
    agentDraft: string;
    messages: ChatMessage[];
    taskIds: string[];
    selectedResultsTaskId?: string;
    readonly resultsDrafts: Map<string, string>;
    readonly resultsNotices: Map<string, ResultsNotice>;
}

interface PersistedAgentWindowState {
    version: 1;
    selectedSessionId?: string;
    railWidth: number;
    railCollapsed: boolean;
    sessions: Array<Omit<WindowAgentSession, 'agentSession' | 'taskIds' | 'resultsDrafts' | 'resultsNotices'> & {
        resultsDrafts: Array<[string, string]>;
        tasks?: ExecutionTask[];
        resultsDocuments?: TaskResultDocument[];
    }>;
}

interface PersistedPoiesisSettings {
    version: 3;
    uiFontScale: UiFontScale;
    agentCli: KnownCliId;
    agentModel: string;
    resultsCli: KnownCliId;
    resultsModel: string;
    allowExternalResultsResources: boolean;
}

interface LegacyPoiesisSettings {
    version?: 1 | 2;
    uiFontScale?: UiFontScale;
    preferredCli?: KnownCliId;
    agentCli?: KnownCliId;
    resultsCli?: KnownCliId;
    allowExternalResultsResources?: boolean;
}

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

interface WorkspaceSkillDefinition {
    id: string;
    name: string;
    description: string;
    kind?: SkillBundleKind;
    uri: string;
    error?: string;
}

@injectable()
export class AgentWindowWidget extends ReactWidget {
    static readonly ID = 'poiesis-agent-window';
    static readonly FILES_WIDGET_FACTORY_ID = 'files';
    static readonly SEARCH_WIDGET_FACTORY_ID = 'search-in-workspace';
    static readonly GIT_WIDGET_FACTORY_ID = 'scm-view';
    static readonly GIT_GRAPH_WIDGET_FACTORY_ID = 'scm-history-graph-widget';
    static readonly EDITOR_WIDGET_FACTORY_ID = 'code-editor-opener';
    static readonly SETTINGS_WIDGET_FACTORY_ID = 'settings_widget';
    static readonly EXTENSIONS_WIDGET_FACTORY_ID = 'vsx-extensions-view-container';
    protected codeMode = false;
    protected settingsModalVisible = false;
    protected customizeModalVisible = false;
    protected workspaceSkills: WorkspaceSkillDefinition[] = [];
    protected workspaceSkillsLoading = false;
    protected workspaceSkillsError?: string;
    protected workspaceSkillsRefreshGeneration = 0;
    protected newSkillFormVisible = false;
    protected newSkillId = '';
    protected newSkillKind: SkillBundleKind = 'agent';
    protected newSkillError?: string;
    protected newSkillCreating = false;
    protected uiFontScale: UiFontScale = 'standard';
    protected agentCli: KnownCliId = DEFAULT_CLI_ID;
    protected agentModel = '';
    protected resultsCli: KnownCliId = DEFAULT_CLI_ID;
    protected resultsModel = '';
    protected readonly customModelRoles = new Set<AiRole>();
    protected allowExternalResultsResources = false;
    protected cliDetectionReport?: CliDetectionReport;
    protected cliDetectionLoading = false;
    protected deleteSessionConfirmationId?: string;
    protected clearDataConfirmation = false;
    protected codeSidebarTab: CodeSidebarTab = 'files';
    protected codeFilesWidget?: Widget;
    protected codeSearchWidget?: Widget;
    protected codeGitWidget?: Widget;
    protected codeGitGraphWidget?: Widget;
    protected codeGitGraphExpanded = true;
    protected codeExtensionsWidget?: Widget;
    protected codeExtensionsInitialized = false;
    protected codeTerminalWidget?: TerminalWidget;
    protected readonly codeTerminalWidgets: TerminalWidget[] = [];
    protected readonly codeTerminalWidgetListeners = new Map<TerminalWidget, Disposable>();
    protected codeTerminalCreation?: Promise<TerminalWidget>;
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
    protected codeWidgetAttachmentFrame?: number;
    protected codeSidebarWidth = DEFAULT_CODE_SIDEBAR_WIDTH;
    protected codeSidebarResizeCleanup?: Disposable;
    protected codePanelVisible = true;
    protected codePanelHeight = DEFAULT_CODE_PANEL_HEIGHT;
    protected codePanelResizeCleanup?: Disposable;
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
    protected sessionsInitialized = false;
    protected sessionsInitialization: Promise<void> = Promise.resolve();
    protected windowStatePersistence: Promise<void> = Promise.resolve();
    protected readonly providerPreparationErrors = new Map<string, string>();
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
    protected readonly expandedWorkspaceGroups = new Set<string>();
    protected sessionSearchInput?: HTMLInputElement;
    protected agentComposerInput?: HTMLTextAreaElement;
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
    protected readonly watchedScmProviders = new WeakSet<ScmProvider>();
    protected readonly watchedScmHistoryProviders = new WeakSet<ScmHistoryProvider>();

    constructor(
        @inject(AgentProvider) protected readonly agentProvider: AgentProvider,
        @inject(TaskService) protected readonly taskService: TaskService,
        @inject(ResultsService) protected readonly resultsService: ResultsService,
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService,
        @inject(ScmService) protected readonly scmService: ScmService,
        @inject(TerminalService) protected readonly terminalService: TerminalService,
        @inject(WidgetManager) protected readonly widgetManager: WidgetManager,
        @inject(EditorManager) protected readonly editorManager: EditorManager,
        @inject(FileService) protected readonly fileService: FileService,
        @inject(CommandService) protected readonly commandService: CommandService,
        @inject(SaveableService) protected readonly saveableService: SaveableService,
        @inject(IconThemeService) protected readonly iconThemeService: IconThemeService,
        @inject(VSXExtensionsSearchModel) protected readonly extensionsSearchModel: VSXExtensionsSearchModel,
        @inject(StorageService) protected readonly storageService: StorageService,
        @inject(GlobalStorageService) protected readonly globalStorageService: GlobalStorageService,
        @inject(FolderExplorerService) protected readonly folderExplorerService: FolderExplorerService,
        @inject(AgentRuntimeServer) protected readonly agentRuntimeServer: AgentRuntimeServer,
        @inject(ResultsQuestionService) protected readonly resultsQuestionService: ResultsQuestionService,
        @inject(ResultsGenerationContext) protected readonly resultsGenerationContext: ResultsGenerationContext
    ) {
        super();
    }

    @postConstruct()
    protected init(): void {
        getDesignVariant();
        this.id = AgentWindowWidget.ID;
        this.addClass('poiesis-agent-window');

        const closeSessionMenu = (event: PointerEvent): void => {
            if (this.openSessionMenuId && !(event.target as Element | null)?.closest('.poiesis-agent-window__session-actions')) {
                this.openSessionMenuId = undefined;
                this.update();
            }
            if (this.repositoryPickerVisible
                && !(event.target as Element | null)?.closest('.poiesis-agent-window__repository-picker, .poiesis-agent-window__context-pill.primary')) {
                this.repositoryPickerVisible = false;
                this.repositoryPickerAnchor = undefined;
                this.repositorySearchQuery = '';
                this.update();
            }
            if (this.workspacePickerVisible
                && !(event.target as Element | null)?.closest('.poiesis-agent-window__workspace-picker, .poiesis-agent-window__repository-open')) {
                this.workspacePickerVisible = false;
                this.workspacePickerAnchor = undefined;
                this.workspaceSearchQuery = '';
                this.update();
            }
            if (this.explorerMoreVisible
                && !(event.target as Element | null)?.closest('.poiesis-agent-window__code-explorer-more')) {
                this.explorerMoreVisible = false;
                this.update();
            }
        };
        document.addEventListener('pointerdown', closeSessionMenu);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('pointerdown', closeSessionMenu)));
        const closeOverlaysOnEscape = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') {
                return;
            }
            if (this.settingsModalVisible) {
                event.preventDefault();
                event.stopPropagation();
                this.closeSettings();
            } else if (this.customizeModalVisible) {
                event.preventDefault();
                event.stopPropagation();
                this.closeCustomize();
            } else if (this.workspacePickerVisible || this.repositoryPickerVisible) {
                event.preventDefault();
                this.workspacePickerVisible = false;
                this.workspacePickerAnchor = undefined;
                this.repositoryPickerVisible = false;
                this.repositoryPickerAnchor = undefined;
                this.workspaceSearchQuery = '';
                this.repositorySearchQuery = '';
                this.update();
            }
        };
        document.addEventListener('keydown', closeOverlaysOnEscape, true);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('keydown', closeOverlaysOnEscape, true)));
        this.installCodeEditorSaveShortcut();
        this.installCodeTerminalShortcut();
        this.installCodeTabDropTarget();

        this.toDispose.push(this.agentProvider.onEvent(event => this.handleAgentEvent(event)));
        this.toDispose.push(this.taskService.onDidChangeTask(event => {
            const session = this.findSessionForTask(event.task);
            if (session) {
                if (!session.taskIds.includes(event.task.id)) {
                    session.taskIds.push(event.task.id);
                }
                session.unreadTaskCompletion = event.type === 'ended' && session.id !== this.selectedSessionId;
                session.lastTaskStatus = event.type === 'started'
                    ? undefined
                    : event.type === 'ended' ? 'completed' : event.type;
                session.updatedAt = Date.now();
            }
            if ((event.type === 'ended' || event.type === 'failed' || event.type === 'cancelled') && session) {
                session.selectedResultsTaskId = event.task.id;
            }
            this.persistWindowState();
            this.update();
        }));
        this.toDispose.push(this.resultsService.onDidChange(() => {
            this.persistWindowState();
            this.update();
        }));
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => {
            void this.refreshRecentWorkspaces();
            if (this.customizeModalVisible) {
                void this.refreshWorkspaceSkills();
            }
            this.update();
        }));
        this.toDispose.push(this.workspaceService.onWorkspaceLocationChanged(() => {
            void this.refreshRecentWorkspaces();
            if (this.customizeModalVisible) {
                void this.refreshWorkspaceSkills();
            }
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

        this.sessionsInitialization = this.restorePoiesisSettings()
            .then(() => this.refreshCliDetection())
            .then(() => this.initializeSessions()).catch(error => {
            console.error('[Poiesis] Could not initialize Agent Window sessions.', error);
        }).finally(() => {
            this.sessionsInitialized = true;
            this.update();
        });
        void this.refreshRecentWorkspaces();
        this.update();
    }

    protected render(): React.ReactNode {
        if (!this.sessionsInitialized) {
            return (
                <div
                    className='poiesis-agent-window__content poiesis-agent-window__content--initializing'
                    data-mode='agent'
                    data-rail-collapsed='false'
                    style={{ '--poiesis-ui-font-scale': this.uiFontScaleValue() } as React.CSSProperties}
                >
                    <div className='poiesis-agent-window__initializing' role='status'>
                        <span className='codicon codicon-loading codicon-modifier-spin' aria-hidden='true' />
                        <span>セッションを復元しています…</span>
                    </div>
                </div>
            );
        }
        const session = this.selectedSession();
        const activeTab = session?.activeTab ?? 'agent';
        const runningTask = this.runningTask(session);
        return (
            <div
                className='poiesis-agent-window__content'
                data-mode={this.codeMode ? 'code' : activeTab}
                data-rail-collapsed={this.railCollapsed ? 'true' : 'false'}
                style={{
                    '--poiesis-rail-width': `${this.railWidth}px`,
                    '--poiesis-ui-font-scale': this.uiFontScaleValue()
                } as React.CSSProperties}
            >
                {!this.codeMode && this.renderRail()}
                <main className='poiesis-agent-window__workspace'>
                    {this.renderHeader()}
                    <div className='poiesis-agent-window__viewport'>
                        {this.codeMode
                            ? this.renderCode()
                            : activeTab === 'agent'
                                ? <>
                                    {this.renderAgent(session, runningTask)}
                                    {session?.hasUserMessage && (
                                        <section
                                            id='poiesis-results-panel'
                                            role='tabpanel'
                                            aria-labelledby='poiesis-results-tab'
                                            hidden
                                        />
                                    )}
                                </>
                                : <>
                                    <section
                                        id='poiesis-agent-panel'
                                        role='tabpanel'
                                        aria-labelledby='poiesis-agent-tab'
                                        hidden
                                    />
                                    {this.renderResults(session)}
                                </>}
                    </div>
                </main>
                {this.workspacePickerVisible && this.workspacePickerAnchor && this.renderWorkspacePicker()}
                {this.repositoryPickerVisible && this.repositoryPickerAnchor && session && this.renderRepositoryPicker(session)}
                {this.folderExplorerVisible && this.renderFolderExplorer()}
                {this.settingsModalVisible && this.renderSettingsModal()}
                {this.customizeModalVisible && this.renderCustomizeModal()}
            </div>
        );
    }

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
                        title='New Chat'
                        onClick={() => void this.newChat()}
                    >
                        <span className='poiesis-agent-window__rail-action-icon' aria-hidden='true'>
                            <span className='codicon codicon-comment-add' />
                        </span>
                        <span className='poiesis-agent-window__rail-action-label'>New Chat</span>
                    </button>
                    <button
                        type='button'
                        className={`poiesis-agent-window__rail-action${this.sessionSearchVisible ? ' active' : ''}`}
                        aria-expanded={this.sessionSearchVisible && !this.railCollapsed}
                        aria-controls='poiesis-agent-window-session-search'
                        title='Search'
                        onClick={() => this.showSessionSearch()}
                    >
                        <span className='poiesis-agent-window__rail-action-icon' aria-hidden='true'>
                            <span className='codicon codicon-search' />
                        </span>
                        <span className='poiesis-agent-window__rail-action-label'>Search</span>
                    </button>
                    <button
                        type='button'
                        className={`poiesis-agent-window__rail-action${this.customizeModalVisible ? ' active' : ''}`}
                        title='Customize'
                        aria-haspopup='dialog'
                        aria-expanded={this.customizeModalVisible}
                        onClick={() => this.openCustomize()}
                    >
                        <span className='poiesis-agent-window__rail-action-icon' aria-hidden='true'>
                            <span className='codicon codicon-tools' />
                        </span>
                        <span className='poiesis-agent-window__rail-action-label'>Customize</span>
                    </button>
                    {this.sessionSearchVisible && !this.railCollapsed && (
                        <label className='poiesis-agent-window__session-search' id='poiesis-agent-window-session-search'>
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
                <div className='poiesis-agent-window__rail-heading'>
                    <span>Workspaces</span>
                    <button
                        type='button'
                        className='poiesis-agent-window__repository-open'
                        title='Open Folder'
                        aria-label='フォルダーを開いてリポジトリを選択または追加'
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
                    <div className='poiesis-agent-window__session-section-label'>Pinned</div>
                )}
                {expanded && pinnedSessions.map(session => this.renderSessionRow(session))}
                {expanded && pinnedSessions.length > 0 && recentSessions.length > 0 && (
                    <div className='poiesis-agent-window__session-section-label'>Recent</div>
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
                            <span>Archived</span>
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
                    <input
                        className='poiesis-agent-window__session-rename'
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
                        className='poiesis-agent-window__session'
                        title={switchesWorkspace
                            ? `${session.title} — ${this.repositoryLabel(session.workspaceUri)}へ切り替え`
                            : session.title}
                        aria-current={selected ? 'true' : undefined}
                        onClick={() => session.archived ? this.restoreSession(session.id, true) : this.selectSession(session.id)}
                    >
                        {session.pinned && <span className='codicon codicon-pinned' aria-label='ピン留め済み' />}
                        <span className={`poiesis-agent-window__status-dot ${state.kind}`} aria-hidden='true' />
                        <span className='poiesis-agent-window__session-copy'>
                            <span className='poiesis-agent-window__session-title'>{session.title}</span>
                            <small className={`poiesis-agent-window__session-meta ${state.kind}`}>{state.label}</small>
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
        const index = this.sessions.indexOf(session);
        if (index !== -1) {
            this.sessions.splice(index, 1);
        }
        this.openSessionMenuId = undefined;
        this.deleteSessionConfirmationId = undefined;
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
                aria-label='Workspaceを開く'
                style={this.workspacePickerAnchor}
            >
                <div className='poiesis-agent-window__workspace-picker-title'>Workspaceを開く</div>
                <label className='poiesis-agent-window__workspace-picker-search'>
                    <span className='codicon codicon-search' aria-hidden='true' />
                    <input
                        ref={input => { this.workspaceSearchInput = input ?? undefined; }}
                        value={this.workspaceSearchQuery}
                        placeholder='Workspaceを検索'
                        aria-label='Workspaceを検索'
                        onChange={event => this.setWorkspaceSearchQuery(event.currentTarget.value)}
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
                        <div className='poiesis-agent-window__workspace-picker-label'>On This PC</div>
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
                        <div className='poiesis-agent-window__workspace-picker-label'>Recent</div>
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
                    <div className='poiesis-agent-window__workspace-picker-empty'>一致するWorkspaceはありません</div>
                )}
                <div className='poiesis-agent-window__workspace-picker-divider' />
                <button
                    type='button'
                    className='poiesis-agent-window__workspace-picker-item action'
                    onClick={() => void this.openRepository()}
                >
                    <span className='codicon codicon-folder-opened' aria-hidden='true' />
                    <span><strong>Open Folder…</strong><small>このPCからフォルダーを選択</small></span>
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
            return 'Select repository';
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
            return `${ageInMinutes}m`;
        }
        const ageInHours = Math.floor(ageInMinutes / 60);
        return ageInHours < 24 ? `${ageInHours}h` : `${Math.floor(ageInHours / 24)}d`;
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
        return { kind: 'idle', label: '待機中' };
    }

    protected renderHeader(): React.ReactNode {
        if (this.codeMode) {
            return (
                <header className='poiesis-agent-window__header poiesis-agent-window__code-header'>
                    <button
                        type='button'
                        className='poiesis-agent-window__code-control active'
                        aria-pressed='true'
                        aria-label='Agentへ戻る'
                        onClick={() => this.toggleCodeMode()}
                    >
                        <span className='codicon codicon-code' aria-hidden='true' />
                        <span>Code</span>
                    </button>
                    <span className='poiesis-agent-window__code-workspace'>{this.workspaceContextLabel()}</span>
                    <span className='poiesis-agent-window__code-hint'>Poiesis Workbench</span>
                </header>
            );
        }
        const session = this.selectedSession();
        const activeTab = session?.activeTab ?? 'agent';
        return (
            <header className='poiesis-agent-window__header'>
                <div className='poiesis-agent-window__context'>
                    <div className='poiesis-agent-window__context-scope'>
                        <small>{this.workspaceContextLabel()}</small>
                        <button
                            type='button'
                            className={`poiesis-agent-window__code-control${this.codeMode ? ' active' : ''}`}
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
                    <nav className='poiesis-agent-window__tabs' role='tablist' aria-label='Agent と Results の切り替え'>
                        <button
                            id='poiesis-agent-tab'
                            type='button'
                            role='tab'
                            className={activeTab === 'agent' ? 'active' : ''}
                            aria-selected={activeTab === 'agent'}
                            aria-controls='poiesis-agent-panel'
                            tabIndex={activeTab === 'agent' ? 0 : -1}
                            onClick={() => this.selectTab('agent')}
                        >
                            Agent
                        </button>
                        <button
                            id='poiesis-results-tab'
                            type='button'
                            role='tab'
                            className={activeTab === 'results' ? 'active' : ''}
                            aria-selected={activeTab === 'results'}
                            aria-controls='poiesis-results-panel'
                            tabIndex={activeTab === 'results' ? 0 : -1}
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
                                <strong>What do you want to build?</strong>
                                <small>Repository、branch、実行場所を選んでからAgentへ依頼します</small>
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
                                ) : <p>{message.content || '…'}</p>}
                                {!message.complete && <small className='poiesis-agent-window__message-state'>作業中…</small>}
                            </section>
                        ))}
                    </div>
                </div>
                {runningTask && (
                    <div className='poiesis-agent-window__task-state' role='status'>
                        <span>タスクを実行中 · {runningTask.title}</span>
                        <button type='button' onClick={() => void this.cancelRun()}>
                            キャンセル
                        </button>
                    </div>
                )}
                <section className='poiesis-agent-window__composer' aria-label='Agent の入力欄'>
                    <textarea
                        key={session?.id ?? 'no-session'}
                        ref={input => { this.agentComposerInput = input ?? undefined; }}
                        value={session?.agentDraft ?? ''}
                        placeholder='次の変更内容や質問を入力…'
                        aria-label='Agent へのメッセージ'
                        rows={2}
                        disabled={!session || Boolean(runningTask)}
                        onChange={event => this.setAgentDraft(session?.id, event.currentTarget.value)}
                        onCompositionEnd={event => this.setAgentDraft(session?.id, event.currentTarget.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                                event.preventDefault();
                                void this.sendAgentMessage();
                            }
                        }}
                    />
                    <div className='poiesis-agent-window__composer-footer'>
                        {session && newAgent && this.renderNewAgentContext(session)}
                        <button
                            className='poiesis-agent-window__send'
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

    protected renderFolderExplorer(): React.ReactNode {
        const result = this.folderExplorerResult;
        return (
            <section className='poiesis-folder-explorer' role='dialog' aria-modal='true' aria-label='フォルダーを選択'>
                <header className='poiesis-folder-explorer__header'>
                    <div>
                        <span className='codicon codicon-folder-opened' aria-hidden='true' />
                        <strong>Select workspace folder</strong>
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
                <main className='poiesis-folder-explorer__body'>
                    <div className='poiesis-folder-explorer__column-heading'><span>Name</span><span>Type</span></div>
                    {this.creatingFolder && (
                        <div className='poiesis-folder-explorer__new-folder-row'>
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
                    {this.folderExplorerLoading && <div className='poiesis-folder-explorer__state'>Loading folders…</div>}
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
                            <small>File folder</small>
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
                        New folder
                    </button>
                    <span className='poiesis-folder-explorer__selection'>{result?.path ?? ''}</span>
                    <button type='button' onClick={() => this.closeFolderExplorer()}>Cancel</button>
                    <button type='button' className='primary' disabled={!result || this.folderExplorerLoading} onClick={() => this.selectFolderFromExplorer()}>Select Folder</button>
                </footer>
            </section>
        );
    }

    protected renderSettingsModal(): React.ReactNode {
        const archivedSessions = this.sessions
            .filter(session => session.archived && session.hasUserMessage)
            .sort((left, right) => right.updatedAt - left.updatedAt);
        return (
            <div
                className='poiesis-settings-modal__backdrop'
                onMouseDown={event => {
                    if (event.target === event.currentTarget) {
                        this.closeSettings();
                    }
                }}
            >
                <section
                    className='poiesis-settings-modal'
                    role='dialog'
                    aria-modal='true'
                    aria-labelledby='poiesis-settings-title'
                >
                    <header className='poiesis-settings-modal__header'>
                        <div>
                            <span className='codicon codicon-settings-gear' aria-hidden='true' />
                            <div><h1 id='poiesis-settings-title'>Poiesisの設定</h1><p>アプリの表示とAgent環境を管理します。</p></div>
                        </div>
                        <button type='button' aria-label='設定を閉じる' onClick={() => this.closeSettings()} autoFocus>
                            <span className='codicon codicon-close' aria-hidden='true' />
                        </button>
                    </header>
                    <div className='poiesis-settings-modal__body'>
                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-general'>
                            <h2 id='poiesis-settings-general'>一般</h2>
                            <div className='poiesis-settings-modal__row'>
                                <div><strong>UI文字サイズ</strong><small>Poiesisのサイドバー、会話、Resultsの表示スケールを変更します。</small></div>
                                <div className='poiesis-settings-modal__segmented' role='radiogroup' aria-label='UI文字サイズ'>
                                    {([['small', '小'], ['standard', '標準'], ['large', '大']] as Array<[UiFontScale, string]>).map(([scale, label]) => (
                                        <label key={scale} className={this.uiFontScale === scale ? 'active' : ''}>
                                            <input type='radio' name='poiesis-ui-scale' value={scale} checked={this.uiFontScale === scale} onChange={() => this.setUiFontScale(scale)} />
                                            <span>{label}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        </section>

                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-cli'>
                            <div className='poiesis-settings-modal__section-heading'>
                                <h2 id='poiesis-settings-cli'>AI — Provider / Model</h2>
                                <button type='button' className='poiesis-settings-modal__text-button' disabled={this.cliDetectionLoading} onClick={() => void this.refreshCliDetection()}>再検出</button>
                            </div>
                            {this.renderCliRoleSelector('agent', 'Agent の AI', this.agentCli)}
                            {this.renderCliRoleSelector('results', 'Results の AI', this.resultsCli)}
                        </section>

                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-results'>
                            <h2 id='poiesis-settings-results'>Results — 外部リソース</h2>
                            <p className='poiesis-settings-modal__section-copy'>成果文書は Results の AI が生成します（未検出時は組み込みテンプレート）。</p>
                            <div className='poiesis-settings-modal__row'>
                                <div><strong>成果文書の外部リソース読み込みを許可</strong><small>OFFではResults HTMLからのネットワーク画像や外部スタイルをブロックします。</small></div>
                                <label className='poiesis-agent-window__switch'>
                                    <input type='checkbox' checked={this.allowExternalResultsResources} aria-label='成果文書の外部リソースを許可' onChange={event => this.setAllowExternalResultsResources(event.currentTarget.checked)} />
                                    <span aria-hidden='true' />
                                </label>
                            </div>
                        </section>

                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-settings-sessions'>
                            <h2 id='poiesis-settings-sessions'>セッション — データ管理</h2>
                            <div className='poiesis-settings-modal__archived'>
                                <strong>アーカイブ済み</strong>
                                {archivedSessions.length === 0 && <p>アーカイブ済みのセッションはありません。</p>}
                                {archivedSessions.map(session => (
                                    <div className='poiesis-settings-modal__archived-row' key={session.id}>
                                        <span><strong>{session.title}</strong><small>{this.sessionMeta(session)}</small></span>
                                        {this.deleteSessionConfirmationId === session.id ? (
                                            <div className='poiesis-settings-modal__confirm' role='group' aria-label={`${session.title}の完全削除を確認`}>
                                                <span>完全に削除しますか？</span>
                                                <button type='button' className='danger' onClick={() => void this.deleteSession(session.id)}>削除</button>
                                                <button type='button' onClick={() => this.cancelDeleteSession()}>戻る</button>
                                            </div>
                                        ) : (
                                            <button type='button' className='danger ghost' onClick={() => this.beginDeleteSession(session.id)}>完全削除</button>
                                        )}
                                    </div>
                                ))}
                            </div>
                            <div className='poiesis-settings-modal__danger-zone'>
                                <div><strong>保存データをすべてクリア</strong><small>会話、タスク、Resultsの保存状態をこのWindowから削除します。</small></div>
                                {this.clearDataConfirmation ? (
                                    <div className='poiesis-settings-modal__confirm' role='group' aria-label='保存データのクリアを確認'>
                                        <span>この操作は取り消せません。</span>
                                        <button type='button' className='danger' onClick={() => void this.clearSavedSessionData()}>クリア</button>
                                        <button type='button' onClick={() => { this.clearDataConfirmation = false; this.update(); }}>戻る</button>
                                    </div>
                                ) : (
                                    <button type='button' className='danger' onClick={() => { this.clearDataConfirmation = true; this.update(); }}>保存データをすべてクリア</button>
                                )}
                            </div>
                        </section>

                    </div>
                    <footer className='poiesis-settings-modal__footer'>
                        <button type='button' onClick={() => void this.openTheiaSettings()}>エディタとTerminalの設定は Theia Settings で</button>
                    </footer>
                </section>
            </div>
        );
    }

    protected renderCustomizeModal(): React.ReactNode {
        const workspaceName = this.workspaceRoot()?.resource.path.base;
        return (
            <div
                className='poiesis-settings-modal__backdrop poiesis-customize-modal__backdrop'
                onMouseDown={event => {
                    if (event.target === event.currentTarget) {
                        this.closeCustomize();
                    }
                }}
            >
                <section
                    className='poiesis-settings-modal poiesis-customize-modal'
                    role='dialog'
                    aria-modal='true'
                    aria-labelledby='poiesis-customize-title'
                >
                    <header className='poiesis-settings-modal__header'>
                        <div>
                            <span className='codicon codicon-tools' aria-hidden='true' />
                            <div><h1 id='poiesis-customize-title'>Customize</h1><p>PoiesisのSkillとPluginを管理します。</p></div>
                        </div>
                        <button type='button' aria-label='Customizeを閉じる' onClick={() => this.closeCustomize()} autoFocus>
                            <span className='codicon codicon-close' aria-hidden='true' />
                        </button>
                    </header>
                    <div className='poiesis-settings-modal__body'>
                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-customize-skills'>
                            <div className='poiesis-settings-modal__section-heading'>
                                <h2 id='poiesis-customize-skills'>Skills</h2>
                                <button
                                    type='button'
                                    className='poiesis-settings-modal__text-button'
                                    onClick={() => this.showNewSkillForm()}
                                >
                                    新しいSkill
                                </button>
                            </div>
                            <p className='poiesis-settings-modal__section-copy'>
                                現在の実行に反映されるのは組み込みのResults Skillsだけです。WorkspaceのUser Skillは定義・編集できますが、Agent／Results実行への反映は今後です。
                            </p>

                            <h3 className='poiesis-customize-modal__group-title'>組み込み</h3>
                            <div className='poiesis-agent-window__customize-list'>
                                <article className='poiesis-agent-window__customize-card'>
                                    <div className='poiesis-agent-window__customize-icon'><span className='codicon codicon-file-code' aria-hidden='true' /></div>
                                    <div>
                                        <div className='poiesis-agent-window__customize-title'><strong>Bundled Results</strong><span>Results</span></div>
                                        <p>確定したTaskとChange Setから、組み込みテンプレートで完成HTMLを生成します。</p>
                                    </div>
                                    <span className='poiesis-agent-window__status-badge active'>組み込み</span>
                                </article>
                                <article className='poiesis-agent-window__customize-card'>
                                    <div className='poiesis-agent-window__customize-icon'><span className='codicon codicon-preview' aria-hidden='true' /></div>
                                    <div>
                                        <div className='poiesis-agent-window__customize-title'><strong>AI Results</strong><span>Results</span></div>
                                        <p>Results AIが完成HTMLを生成し、実行できない場合は組み込みテンプレートへ切り替えます。</p>
                                    </div>
                                    <span className='poiesis-agent-window__status-badge active'>組み込み</span>
                                </article>
                            </div>

                            <div className='poiesis-customize-modal__user-heading'>
                                <h3 className='poiesis-customize-modal__group-title'>User Skills</h3>
                                <span>{workspaceName ? `${workspaceName} / .poiesis/skills` : 'Workspaceが開かれていません'}</span>
                            </div>
                            {this.workspaceSkillsLoading && (
                                <div className='poiesis-customize-modal__state' role='status'>
                                    <span className='codicon codicon-loading codicon-modifier-spin' aria-hidden='true' />
                                    Skillを読み込んでいます…
                                </div>
                            )}
                            {!this.workspaceSkillsLoading && this.workspaceSkillsError && (
                                <div className='poiesis-customize-modal__state error' role='alert'>{this.workspaceSkillsError}</div>
                            )}
                            {!this.workspaceSkillsLoading && !this.workspaceSkillsError && this.workspaceSkills.length === 0 && (
                                <div className='poiesis-customize-modal__state'>User Skillはまだありません。</div>
                            )}
                            {!this.workspaceSkillsLoading && this.workspaceSkills.length > 0 && (
                                <div className='poiesis-agent-window__customize-list'>
                                    {this.workspaceSkills.map(skill => (
                                        <button
                                            type='button'
                                            className='poiesis-agent-window__customize-card poiesis-customize-modal__skill-card'
                                            key={skill.id}
                                            onClick={() => void this.openWorkspaceSkill(skill.uri)}
                                        >
                                            <div className='poiesis-agent-window__customize-icon'><span className='codicon codicon-book' aria-hidden='true' /></div>
                                            <div>
                                                <div className='poiesis-agent-window__customize-title'>
                                                    <strong>{skill.name}</strong>
                                                    <span>{skill.kind ? (skill.kind === 'agent' ? 'Agent' : 'Results') : '要修正'}</span>
                                                </div>
                                                <p>{skill.error ?? skill.description}</p>
                                                <small>.poiesis/skills/{skill.id}/skill.md</small>
                                            </div>
                                            <span className='codicon codicon-chevron-right' aria-hidden='true' />
                                        </button>
                                    ))}
                                </div>
                            )}

                            {this.newSkillFormVisible && (
                                <form className='poiesis-customize-modal__new-skill' onSubmit={event => {
                                    event.preventDefault();
                                    void this.createWorkspaceSkill();
                                }}>
                                    <label>
                                        <span>Skill ID</span>
                                        <input
                                            autoFocus
                                            value={this.newSkillId}
                                            placeholder='my-skill'
                                            aria-label='新しいSkill ID'
                                            disabled={this.newSkillCreating}
                                            onChange={event => this.setNewSkillId(event.currentTarget.value)}
                                        />
                                    </label>
                                    <label>
                                        <span>Kind</span>
                                        <select
                                            value={this.newSkillKind}
                                            aria-label='新しいSkillの種類'
                                            disabled={this.newSkillCreating}
                                            onChange={event => this.setNewSkillKind(event.currentTarget.value as SkillBundleKind)}
                                        >
                                            <option value='agent'>Agent</option>
                                            <option value='results'>Results</option>
                                        </select>
                                    </label>
                                    <small>.poiesis/skills/&lt;skill-id&gt;/skill.md を作成します。</small>
                                    {this.newSkillError && <p role='alert'>{this.newSkillError}</p>}
                                    <div>
                                        <button type='button' disabled={this.newSkillCreating} onClick={() => this.hideNewSkillForm()}>キャンセル</button>
                                        <button type='submit' className='primary' disabled={this.newSkillCreating || !this.newSkillId.trim()}>
                                            {this.newSkillCreating ? '作成中…' : '作成して開く'}
                                        </button>
                                    </div>
                                </form>
                            )}
                        </section>

                        <section className='poiesis-settings-modal__section' aria-labelledby='poiesis-customize-plugins'>
                            <h2 id='poiesis-customize-plugins'>Plugins</h2>
                            <div className='poiesis-agent-window__customize-list'>
                                <article className='poiesis-agent-window__customize-card'>
                                    <div className='poiesis-agent-window__customize-icon'><span className='codicon codicon-package' aria-hidden='true' /></div>
                                    <div><div className='poiesis-agent-window__customize-title'><strong>Poiesis plugin bundles</strong><span>App</span></div><p>PoiesisのAgent、Skill、外部サービス連携を追加するアプリ用Pluginです。Code拡張機能とは別に管理されます。</p></div>
                                    <span className='poiesis-agent-window__status-badge'>No additions</span>
                                </article>
                            </div>
                        </section>
                    </div>
                    <footer className='poiesis-settings-modal__footer poiesis-customize-modal__footer'>
                        <span>User SkillはCodeで編集し、Ctrl+Sで保存します。</span>
                    </footer>
                </section>
            </div>
        );
    }

    protected renderCliRoleSelector(role: AiRole, label: string, selected: KnownCliId): React.ReactNode {
        const detections = this.cliDetectionReport?.detections ?? [];
        const selectedDetection = detections.find(detection => detection.id === selected);
        const model = this.roleModel(role);
        const modelIds = selectedDetection?.models.map(option => option.id) ?? [];
        const customModel = this.customModelRoles.has(role) || !modelIds.includes(model);
        const modelSelection = customModel ? '__custom__' : model;
        return (
            <div className='poiesis-settings-modal__cli-role'>
                <h3>{label}</h3>
                <div className='poiesis-settings-modal__cli-list' role='radiogroup' aria-label={label}>
                    {detections.map(detection => {
                        const executable = detection.status === 'found' && detection.executableRoles.includes(role);
                        const status = this.cliDetectionLoading && !detection.path
                            ? '検出中…'
                            : detection.status === 'missing'
                                ? '未検出'
                                : executable ? '検出済み（実行可）' : '検出済み（実行対応は今後）';
                        return (
                            <label key={`${role}-${detection.id}`} className={`poiesis-settings-modal__cli-row${executable ? '' : ' unavailable'}`}>
                                <input
                                    type='radio'
                                    name={`poiesis-${role}-cli`}
                                    value={detection.id}
                                    checked={selected === detection.id}
                                    disabled={!executable}
                                    onChange={() => this.setRoleCli(role, detection.id)}
                                />
                                <span className='poiesis-settings-modal__cli-copy'>
                                    <strong>{detection.name}</strong>
                                    <small title={detection.path}>{detection.path ?? `${detection.id} CLI`}{detection.version ? ` · ${detection.version}` : ''}</small>
                                </span>
                                <span className={`poiesis-settings-modal__cli-status ${executable ? 'found' : detection.status === 'found' ? 'unsupported' : 'missing'}`}>{status}</span>
                            </label>
                        );
                    })}
                </div>
                {selectedDetection && (
                    <div className='poiesis-settings-modal__model-field'>
                        <label>
                            <span>モデル</span>
                            <select
                                aria-label={`${label} モデル`}
                                value={modelSelection}
                                disabled={selectedDetection.status !== 'found' || !selectedDetection.executableRoles.includes(role)}
                                onChange={event => this.setRoleModelChoice(role, event.currentTarget.value)}
                            >
                                {selectedDetection.models.map(option => <option key={option.id || 'cli-default'} value={option.id}>{option.label}</option>)}
                                <option value='__custom__'>カスタム…</option>
                            </select>
                        </label>
                        {customModel && (
                            <label>
                                <span>カスタムモデルID</span>
                                <input
                                    value={model}
                                    maxLength={160}
                                    placeholder='モデルIDを入力'
                                    aria-label={`${label} カスタムモデルID`}
                                    onChange={event => this.setRoleModel(role, event.currentTarget.value)}
                                />
                            </label>
                        )}
                    </div>
                )}
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
                <span className='poiesis-agent-window__context-pill static' title='現在利用できる実行先はLocalのみです'>
                    <span className='codicon codicon-device-desktop' aria-hidden='true' />
                    <span>Run on · This Computer</span>
                </span>
            </div>
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
                    <input
                        ref={input => { this.repositorySearchInput = input ?? undefined; }}
                        value={this.repositorySearchQuery}
                        placeholder='Repositoryを検索'
                        aria-label='Repositoryを検索'
                        onChange={event => this.setRepositorySearchQuery(event.currentTarget.value)}
                    />
                </label>
                {repositoryChoices.length > 0 && (
                    <>
                        <div className='poiesis-agent-window__repository-group-label'>Recent</div>
                        {repositoryChoices.slice(0, 2).map(choice => this.renderRepositoryChoice(session, choice, 'codicon-history'))}
                    </>
                )}
                <div className='poiesis-agent-window__repository-group-label'>On This PC</div>
                {filteredChoices.map(choice => this.renderRepositoryChoice(session, choice, 'codicon-device-desktop'))}
                {!filteredChoices.length && (
                    <div className='poiesis-agent-window__repository-empty'>一致するRepositoryはありません</div>
                )}
                <div className='poiesis-agent-window__repository-footer'>
                    <button type='button' onClick={() => void this.openFolderExplorer(session)}>
                        <span className='codicon codicon-folder-opened' aria-hidden='true' />
                        Use Existing…
                    </button>
                    <button type='button' onClick={() => void this.openFolderExplorer(session, true)}>
                        <span className='codicon codicon-new-folder' aria-hidden='true' />
                        New Folder
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

    protected renderResults(session: WindowAgentSession | undefined): React.ReactNode {
        const finishedTasks = [...this.finishedTasks(session)].reverse();
        const selectedTask = finishedTasks.find(task => task.id === session?.selectedResultsTaskId)
            ?? finishedTasks[0];
        const document = selectedTask ? this.resultsService.get(selectedTask.id) : undefined;
        const draft = selectedTask ? session?.resultsDrafts.get(selectedTask.id) ?? '' : '';
        const notice = selectedTask ? session?.resultsNotices.get(selectedTask.id) : undefined;
        const questionSending = notice?.status === 'sending';

        return (
            <section
                id='poiesis-results-panel'
                className='poiesis-results'
                role='tabpanel'
                aria-labelledby='poiesis-results-tab'
            >
                <div
                    id='poiesis-results-task-panel'
                    className='poiesis-results__main'
                    role='tabpanel'
                    aria-labelledby={selectedTask ? `poiesis-results-task-tab-${selectedTask.id}` : undefined}
                >
                    <div className='poiesis-results__canvas' aria-label='Results HTML キャンバス'>
                        {!selectedTask && <div className='poiesis-results__empty'>Agent でタスクを完了すると、ここに成果が表示されます。</div>}
                        {selectedTask?.status === 'failed' && (
                            <div className='poiesis-results__state error' role='alert'>
                                <strong>タスクに失敗しました</strong>
                                <p>{selectedTask.failure?.summary ?? 'Codex がタスクを完了できませんでした。'}</p>
                                <button type='button' onClick={() => void this.retryTask(selectedTask.id)}>再試行</button>
                            </div>
                        )}
                        {selectedTask?.status === 'cancelled' && (
                            <div className='poiesis-results__state cancelled' role='status'>
                                <strong>タスクはキャンセルされました</strong>
                                <p>成果は確定していません。必要なら同じ依頼を再試行できます。</p>
                                <button type='button' onClick={() => void this.retryTask(selectedTask.id)}>再試行</button>
                            </div>
                        )}
                        {selectedTask?.status === 'completed' && selectedTask.changeSet?.error && (
                            <div className='poiesis-results__state error' role='alert'>
                                <strong>変更内容を取得できませんでした</strong>
                                <p>Repository の状態を確認して、タスクを再試行してください。</p>
                                <button type='button' onClick={() => void this.retryTask(selectedTask.id)}>再試行</button>
                            </div>
                        )}
                        {selectedTask?.status === 'completed' && !selectedTask.changeSet?.error
                            && (!document || document.status === 'generating') && (
                            <div className='poiesis-results__empty' role='status'>成果を作成しています…</div>
                        )}
                        {selectedTask?.status === 'completed' && !selectedTask.changeSet?.error && document?.status === 'failed' && (
                            <div className='poiesis-results__state error' role='alert'>
                                <strong>成果を作成できませんでした</strong>
                                <p>Results skill の処理に失敗しました。</p>
                                <button type='button' onClick={() => void this.retryResults(selectedTask.id)}>再試行</button>
                            </div>
                        )}
                        {selectedTask?.status === 'completed' && !selectedTask.changeSet?.error
                            && document?.status === 'ready' && document.html && (
                            <iframe
                                key={`${selectedTask?.id}-${this.allowExternalResultsResources ? 'external' : 'isolated'}`}
                                className='poiesis-results__document'
                                title={`${selectedTask?.title}の成果`}
                                sandbox=''
                                srcDoc={this.resultsDocumentHtml(document.html)}
                            />
                        )}
                    </div>
                    {notice && (
                        <div
                            className={`poiesis-results__answer ${notice.status}`}
                            role={notice.status === 'failed' ? 'alert' : 'status'}
                        >
                            <strong>{notice.status === 'sending' ? '回答を作成しています…' : notice.question}</strong>
                            {notice.status !== 'sending' && <p>{notice.text}</p>}
                            {notice.status === 'failed' && (
                                <button type='button' onClick={() => void this.submitResultsQuestion(selectedTask!.id, notice.question)}>再試行</button>
                            )}
                        </div>
                    )}
                    <section className='poiesis-results__composer' aria-label='Results の入力欄'>
                        <input
                            value={draft}
                            placeholder='この結果について質問…'
                            aria-label='表示中の成果について質問'
                            maxLength={4_000}
                            disabled={!selectedTask || document?.status !== 'ready' || questionSending}
                            onChange={event => selectedTask && this.setResultsDraft(selectedTask.id, event.currentTarget.value)}
                            onKeyDown={event => {
                                if (event.key === 'Enter' && selectedTask && !questionSending) {
                                    event.preventDefault();
                                    void this.submitResultsQuestion(selectedTask.id);
                                }
                            }}
                        />
                        <button
                            type='button'
                            aria-label='Results 内へ送信'
                            disabled={!selectedTask || document?.status !== 'ready' || questionSending || !draft.trim()}
                            onClick={() => selectedTask && void this.submitResultsQuestion(selectedTask.id)}
                        >
                            <span className='codicon codicon-arrow-up' aria-hidden='true' />
                        </button>
                    </section>
                </div>
                <aside className='poiesis-results__task-switcher' aria-label='同じセッションの実行タスク'>
                    <div className='poiesis-results__task-switcher-header'>
                        <strong>タスク</strong>
                        <span>{finishedTasks.length}</span>
                    </div>
                    <div className='poiesis-results__task-list' role='tablist'>
                        {finishedTasks.map((task, index) => (
                            <button
                                key={task.id}
                                id={`poiesis-results-task-tab-${task.id}`}
                                type='button'
                                role='tab'
                                aria-selected={selectedTask?.id === task.id}
                                aria-controls='poiesis-results-task-panel'
                                tabIndex={selectedTask?.id === task.id ? 0 : -1}
                                className={selectedTask?.id === task.id ? 'active' : ''}
                                onClick={() => this.selectResultsTask(task.id)}
                            >
                                <small>
                                    {index === 0 ? '最新 · ' : ''}
                                    {task.status === 'cancelled' ? 'キャンセル' : task.status === 'failed' ? '失敗' : '完了'}
                                    {task.endedAt ? ` · ${this.taskFinishedTime(task)}` : ''}
                                </small>
                                <span title={task.title}>{task.title}</span>
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
                className='poiesis-agent-window__code'
                aria-label='Code モード'
                style={{ '--poiesis-code-sidebar-width': `${this.codeSidebarWidth}px` } as React.CSSProperties}
            >
                <nav className='poiesis-agent-window__code-activity' aria-label='Code Activity Bar'>
                    <div className='poiesis-agent-window__code-activity-main'>
                        {this.renderCodeActivity('files', 'files', 'Explorer')}
                        {this.renderCodeActivity('search', 'search', 'Search')}
                        {this.renderCodeActivity('git', 'source-control', 'Source Control')}
                        {this.renderCodeActivity('extensions', 'extensions', 'Extensions')}
                    </div>
                    <div className='poiesis-agent-window__code-activity-footer'>
                        <button type='button' title='設定' aria-label='設定' onClick={() => this.openSettings()}>
                            <span className='codicon codicon-settings-gear' aria-hidden='true' />
                        </button>
                    </div>
                </nav>
                <aside
                    className={`poiesis-agent-window__code-sidebar${this.codeSidebarTab === 'files' ? ' explorer' : ''}`}
                    aria-label='Code のサイドバー'
                >
                    <div className='poiesis-agent-window__code-sidebar-title'>
                        <span>{sidebarLabels[this.codeSidebarTab]}</span>
                        <div className='poiesis-agent-window__code-sidebar-actions'>
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
                                <div className='poiesis-agent-window__code-explorer-more'>
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
                        <div className='poiesis-agent-window__code-explorer-root'>
                            <span className='codicon codicon-chevron-down' aria-hidden='true' />
                            <strong>{this.workspaceFolderName()}</strong>
                        </div>
                    )}
                    {this.codeSidebarTab === 'git' ? (
                        <div className={`poiesis-agent-window__code-source-control${this.codeGitGraphExpanded ? ' graph-expanded' : ''}`}>
                            <div className='poiesis-agent-window__code-sidebar-host' ref={this.setCodeSidebarHost} />
                            <button
                                type='button'
                                className='poiesis-agent-window__code-git-graph-title'
                                aria-controls='poiesis-code-git-graph'
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
                                id='poiesis-code-git-graph'
                                className='poiesis-agent-window__code-git-graph-host'
                                aria-hidden={!this.codeGitGraphExpanded}
                                hidden={!this.codeGitGraphExpanded}
                                ref={this.setCodeGitGraphHost}
                            />
                        </div>
                    ) : (
                        <div className='poiesis-agent-window__code-sidebar-host' ref={this.setCodeSidebarHost} />
                    )}
                    <div
                        className='poiesis-agent-window__code-sidebar-resize'
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
                <main className='poiesis-agent-window__code-editor' aria-label='Editor'>
                    <div
                        className='poiesis-agent-window__code-editor-tabs'
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
                                    className={`poiesis-agent-window__code-editor-tab${active ? ' active' : ''}${dirty ? ' dirty' : ''}${preview ? ' preview' : ''}`}
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
                                        className='poiesis-agent-window__code-editor-tab-label'
                                        onClick={() => this.selectCodeCenterWidget(widget)}
                                        onKeyDown={event => this.handleCodeTabKeyDown(event, widget)}
                                    >
                                        {widget.title.iconClass && <span className={widget.title.iconClass} aria-hidden='true' />}
                                        <span className='poiesis-agent-window__code-editor-tab-name'>{label}</span>
                                    </button>
                                    <button
                                        type='button'
                                        className='poiesis-agent-window__code-editor-tab-close'
                                        title='Close'
                                        aria-label={`${label}を閉じる`}
                                        onClick={() => void this.closeCodeCenterWidget(widget)}
                                    >
                                        {dirty && <span className='codicon codicon-circle-filled poiesis-agent-window__code-editor-tab-dirty' aria-hidden='true' />}
                                        <span className='codicon codicon-close poiesis-agent-window__code-editor-tab-close-icon' aria-hidden='true' />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                    <div
                        className={`poiesis-agent-window__code-editor-stack${this.codePanelVisible ? '' : ' panel-collapsed'}`}
                        style={{ '--poiesis-code-panel-height': `${this.codePanelHeight}px` } as React.CSSProperties}
                    >
                        <div className='poiesis-agent-window__code-editor-host' ref={this.setCodeEditorHost}>
                            {!this.activeCodeCenterWidget && (
                                <div className='poiesis-agent-window__code-empty'>ファイルを開いて編集を開始</div>
                            )}
                        </div>
                        {this.codePanelVisible && (
                            <section className='poiesis-agent-window__code-panel' aria-label='Bottom Panel'>
                                <div
                                    className='poiesis-agent-window__code-panel-resize'
                                    role='separator'
                                    aria-label='Resize Terminal Panel'
                                    aria-orientation='horizontal'
                                    aria-valuemin={MIN_CODE_PANEL_HEIGHT}
                                    aria-valuenow={this.codePanelHeight}
                                    tabIndex={0}
                                    onPointerDown={event => this.startCodePanelResize(event)}
                                    onDoubleClick={() => this.setCodePanelHeight(DEFAULT_CODE_PANEL_HEIGHT)}
                                    onKeyDown={event => {
                                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                            event.preventDefault();
                                            this.setCodePanelHeight(this.codePanelHeight + (event.key === 'ArrowUp' ? 12 : -12));
                                        }
                                    }}
                                />
                                <div className='poiesis-agent-window__code-panel-tabs'>
                                    <button
                                        type='button'
                                        className='poiesis-agent-window__code-panel-tab active'
                                        aria-pressed='true'
                                        aria-label='ターミナルを選択'
                                        onClick={() => this.codeTerminalWidget?.activate()}
                                    >
                                        TERMINAL
                                    </button>
                                    <span className='poiesis-agent-window__code-panel-spacer' />
                                    {this.codeTerminalWidgets.length > 0 && this.codeTerminalWidget && (
                                        <select
                                            className='poiesis-agent-window__code-terminal-select'
                                            aria-label='Active Terminal'
                                            value={this.codeTerminalWidget.id}
                                            onChange={event => this.selectCodeTerminalById(event.currentTarget.value)}
                                        >
                                            {this.codeTerminalWidgets.map(terminal => (
                                                <option key={terminal.id} value={terminal.id}>{this.codeTerminalLabel(terminal)}</option>
                                            ))}
                                        </select>
                                    )}
                                    <button type='button' title='New Terminal' aria-label='New Terminal' onClick={() => void this.createCodeTerminal()}>
                                        <span className='codicon codicon-add' aria-hidden='true' />
                                    </button>
                                    <button
                                        type='button'
                                        title='Kill Terminal'
                                        aria-label='Kill Terminal'
                                        disabled={!this.codeTerminalWidget}
                                        onClick={() => this.closeCodeTerminal()}
                                    >
                                        <span className='codicon codicon-trash' aria-hidden='true' />
                                    </button>
                                    <button type='button' title='Close Panel' aria-label='Close Panel' onClick={() => this.toggleCodePanel(false)}>
                                        <span className='codicon codicon-close' aria-hidden='true' />
                                    </button>
                                </div>
                                <div className='poiesis-agent-window__code-terminal-host' ref={this.setCodeTerminalHost} />
                            </section>
                        )}
                    </div>
                </main>
                <footer className='poiesis-agent-window__code-status' aria-label='Status Bar'>
                    <span><span className='codicon codicon-source-control' aria-hidden='true' /> {this.currentGitBranch() ?? 'main'}</span>
                    <span><span className='codicon codicon-sync' aria-hidden='true' /></span>
                    <span><span className='codicon codicon-error' aria-hidden='true' /> 0</span>
                    <span><span className='codicon codicon-warning' aria-hidden='true' /> 0</span>
                    <span className='poiesis-agent-window__code-status-spacer' />
                    <span>UTF-8</span>
                    <span>LF</span>
                    <span>Spaces: 4</span>
                    <span><span className='codicon codicon-bell' aria-hidden='true' /></span>
                    <button
                        type='button'
                        className={this.codePanelVisible ? 'active' : ''}
                        title='Toggle Panel'
                        aria-label='Toggle Panel'
                        aria-expanded={this.codePanelVisible}
                        onClick={() => this.toggleCodePanel()}
                    >
                        <span className='codicon codicon-layout-panel' aria-hidden='true' />
                    </button>
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
                className='poiesis-agent-window__code-close-overlay'
                onKeyDown={event => {
                    if (event.key === 'Escape' && !this.pendingCodeCenterCloseBusy) {
                        event.preventDefault();
                        this.cancelCodeCenterClose();
                    }
                }}
            >
                <section
                    className='poiesis-agent-window__code-close-dialog'
                    role='dialog'
                    aria-modal='true'
                    aria-labelledby='poiesis-code-close-title'
                >
                    <header>
                        <h2 id='poiesis-code-close-title'>Save changes to {label}?</h2>
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
            <div className='poiesis-agent-window__code-explorer-menu' role='menu' aria-label='Explorer More Actions'>
                {this.renderExplorerMenuItem('Toggle Hidden Files', FileNavigatorCommands.TOGGLE_HIDDEN_FILES.id)}
                {this.renderExplorerMenuItem('Auto Reveal', FileNavigatorCommands.TOGGLE_AUTO_REVEAL.id)}
                <div className='poiesis-agent-window__code-explorer-menu-separator' role='separator' />
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
            this.scheduleCodeWidgetAttachments();
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
            this.detachCodeWidget(this.activeCodeSidebarWidget());
            this.codeSidebarResizeObserver?.disconnect();
            this.codeSidebarResizeObserver = undefined;
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
        this.scheduleCodeWidgetAttachments();
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
            this.codeEditorHost = undefined;
            return;
        }
        this.codeEditorHost = host;
        this.codeEditorResizeObserver = new ResizeObserver(() =>
            this.resizeCodeWidget(this.activeCodeCenterWidget, host));
        this.codeEditorResizeObserver.observe(host);
        this.scheduleCodeWidgetAttachments();
    };

    protected readonly setCodeGitGraphHost = (host: HTMLDivElement | null): void => {
        if (!host) {
            this.codeGitGraphResizeObserver?.disconnect();
            this.codeGitGraphResizeObserver = undefined;
            this.codeGitGraphHost = undefined;
            return;
        }
        this.codeGitGraphHost = host;
        this.codeGitGraphResizeObserver = new ResizeObserver(() =>
            this.resizeCodeWidget(this.codeGitGraphWidget, host));
        this.codeGitGraphResizeObserver.observe(host);
        this.scheduleCodeWidgetAttachments();
    };

    protected readonly setCodeTerminalHost = (host: HTMLDivElement | null): void => {
        if (!host) {
            this.codeTerminalResizeObserver?.disconnect();
            this.codeTerminalResizeObserver = undefined;
            this.codeTerminalHost = undefined;
            return;
        }
        this.codeTerminalHost = host;
        this.codeTerminalResizeObserver = new ResizeObserver(() =>
            this.resizeCodeWidget(this.codeTerminalWidget, host));
        this.codeTerminalResizeObserver.observe(host);
        this.scheduleCodeWidgetAttachments();
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

    protected scheduleCodeWidgetAttachments(): void {
        if (this.codeWidgetAttachmentFrame !== undefined) {
            return;
        }
        this.codeWidgetAttachmentFrame = requestAnimationFrame(() => {
            this.codeWidgetAttachmentFrame = undefined;
            if (this.isDisposed) {
                return;
            }
            this.syncCodeWidgetAttachments();
            if (this.codeMode && this.codePanelVisible && this.codeTerminalHost) {
                void this.ensureCodeTerminal();
            }
        });
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
        if (this.codePanelVisible) {
            this.attachCodeWidget(this.codeTerminalWidget, this.codeTerminalHost);
        } else {
            this.detachCodeWidget(this.codeTerminalWidget);
        }
    }

    protected async ensureCodeTerminal(): Promise<void> {
        if (!this.codeTerminalWidget) {
            if (!this.codeTerminalCreation) {
                this.codeTerminalCreation = this.newCodeTerminal()
                    .then(terminal => {
                        this.registerCodeTerminal(terminal);
                        return terminal;
                    })
                    .finally(() => {
                        this.codeTerminalCreation = undefined;
                    });
            }
            await this.codeTerminalCreation;
        }
        if (this.codeMode && this.codePanelVisible) {
            this.attachCodeWidget(this.codeTerminalWidget, this.codeTerminalHost);
        }
    }

    protected async createCodeTerminal(): Promise<void> {
        const terminal = await this.newCodeTerminal();
        this.registerCodeTerminal(terminal);
        this.codePanelVisible = true;
        this.selectCodeTerminal(terminal);
        this.update();
    }

    protected async newCodeTerminal(): Promise<TerminalWidget> {
        const cwd = this.workspaceService.tryGetRoots()[0]?.resource.toString();
        const terminal = await this.terminalService.newTerminal({ cwd, destroyTermOnClose: true });
        void terminal.start();
        return terminal;
    }

    protected registerCodeTerminal(terminal: TerminalWidget): void {
        if (this.codeTerminalWidgets.includes(terminal)) {
            return;
        }
        this.codeTerminalWidgets.push(terminal);
        this.codeTerminalWidget ??= terminal;
        const onDisposed = (): void => this.removeCodeTerminal(terminal);
        const onTitleChanged = (): void => this.update();
        const closedListener = terminal.onTerminalDidClose(() => this.removeCodeTerminal(terminal));
        terminal.disposed.connect(onDisposed);
        terminal.title.changed.connect(onTitleChanged);
        const listeners = Disposable.create(() => {
            closedListener.dispose();
            terminal.disposed.disconnect(onDisposed);
            terminal.title.changed.disconnect(onTitleChanged);
        });
        this.codeTerminalWidgetListeners.set(terminal, listeners);
        this.toDispose.push(listeners);
        this.update();
    }

    protected removeCodeTerminal(terminal: TerminalWidget): void {
        const index = this.codeTerminalWidgets.indexOf(terminal);
        if (index === -1) {
            return;
        }
        const next = this.codeTerminalWidgets[index + 1] ?? this.codeTerminalWidgets[index - 1];
        if (this.codeTerminalWidget === terminal) {
            this.detachCodeWidget(terminal);
            this.codeTerminalWidget = next;
        }
        this.codeTerminalWidgets.splice(index, 1);
        this.codeTerminalWidgetListeners.get(terminal)?.dispose();
        this.codeTerminalWidgetListeners.delete(terminal);
        if (!this.codeTerminalWidget) {
            this.codePanelVisible = false;
        }
        this.update();
        this.syncCodeWidgetAttachments();
    }

    protected selectCodeTerminalById(id: string): void {
        const terminal = this.codeTerminalWidgets.find(candidate => candidate.id === id);
        if (terminal) {
            this.selectCodeTerminal(terminal);
        }
    }

    protected selectCodeTerminal(terminal: TerminalWidget): void {
        if (this.codeTerminalWidget !== terminal) {
            this.detachCodeWidget(this.codeTerminalWidget);
            this.codeTerminalWidget = terminal;
        }
        this.codePanelVisible = true;
        this.update();
        this.attachCodeWidget(terminal, this.codeTerminalHost);
    }

    protected closeCodeTerminal(): void {
        this.codeTerminalWidget?.close();
    }

    protected codeTerminalLabel(terminal: TerminalWidget): string {
        const index = this.codeTerminalWidgets.indexOf(terminal);
        const label = terminal.title.label || 'Terminal';
        const fileName = label.split(/[\\/]/).pop() || label;
        const basename = fileName.replace(/\.[^.]+$/, '');
        return `${index + 1}: ${basename}`;
    }

    protected toggleCodePanel(visible = !this.codePanelVisible): void {
        if (visible === this.codePanelVisible) {
            return;
        }
        if (!visible) {
            this.detachCodeWidget(this.codeTerminalWidget);
        }
        this.codePanelVisible = visible;
        this.update();
        if (visible) {
            requestAnimationFrame(() => void this.ensureCodeTerminal());
        }
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
            this.scheduleCodeWidgetAttachments();
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
            this.scheduleCodeWidgetAttachments();
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
        document.body.classList.add('poiesis-code-sidebar-resizing');
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', finish, { once: true });
        document.addEventListener('pointercancel', finish, { once: true });
        this.codeSidebarResizeCleanup = Disposable.create(() => {
            document.body.classList.remove('poiesis-code-sidebar-resizing');
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', finish);
        });
    }

    protected setCodeSidebarWidth(width: number): void {
        this.codeSidebarWidth = Math.max(MIN_CODE_SIDEBAR_WIDTH, Math.min(MAX_CODE_SIDEBAR_WIDTH, width));
        const code = this.node.querySelector<HTMLElement>('.poiesis-agent-window__code');
        code?.style.setProperty('--poiesis-code-sidebar-width', `${this.codeSidebarWidth}px`);
        this.node.querySelector('.poiesis-agent-window__code-sidebar-resize')
            ?.setAttribute('aria-valuenow', `${this.codeSidebarWidth}`);
    }

    protected startCodePanelResize(event: React.PointerEvent<HTMLDivElement>): void {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        this.codePanelResizeCleanup?.dispose();
        const startY = event.clientY;
        const startHeight = this.codePanelHeight;
        const onPointerMove = (moveEvent: PointerEvent): void => {
            this.setCodePanelHeight(startHeight + startY - moveEvent.clientY);
        };
        const finish = (): void => {
            this.codePanelResizeCleanup?.dispose();
            this.codePanelResizeCleanup = undefined;
        };
        document.body.classList.add('poiesis-code-panel-resizing');
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', finish, { once: true });
        document.addEventListener('pointercancel', finish, { once: true });
        this.codePanelResizeCleanup = Disposable.create(() => {
            document.body.classList.remove('poiesis-code-panel-resizing');
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', finish);
        });
    }

    protected setCodePanelHeight(height: number): void {
        const stack = this.node.querySelector<HTMLElement>('.poiesis-agent-window__code-editor-stack');
        const maximum = Math.max(MIN_CODE_PANEL_HEIGHT, (stack?.clientHeight ?? DEFAULT_CODE_PANEL_HEIGHT + 80) - 80);
        this.codePanelHeight = Math.max(MIN_CODE_PANEL_HEIGHT, Math.min(maximum, height));
        stack?.style.setProperty('--poiesis-code-panel-height', `${this.codePanelHeight}px`);
        this.node.querySelector('.poiesis-agent-window__code-panel-resize')
            ?.setAttribute('aria-valuenow', `${this.codePanelHeight}`);
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
            document.body?.classList.add('poiesis-code-file-pointer-drag');
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
        const tabs = this.node.querySelector<HTMLElement>('.poiesis-agent-window__code-editor-tabs');
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
        document.body?.classList.remove('poiesis-code-file-pointer-drag');
        this.setCodeTabDropActive(false);
    }

    protected setCodeTabDropActive(active: boolean): void {
        this.node.querySelector('.poiesis-agent-window__code-editor-tabs')?.classList.toggle('drop-target', active);
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

    protected installCodeEditorSaveShortcut(): void {
        const onKeyDown = (event: KeyboardEvent): void => {
            const savePressed = (event.ctrlKey || event.metaKey)
                && !event.altKey
                && !event.shiftKey
                && (event.key.toLocaleLowerCase() === 's' || event.code === 'KeyS');
            const widget = this.codeMode ? this.activeCodeCenterWidget : undefined;
            if (!savePressed || !widget || !Saveable.get(widget)) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            void this.saveableService.save(widget, {
                formatType: FormatType.ON,
                saveReason: SaveReason.Manual
            });
        };
        document.addEventListener('keydown', onKeyDown, true);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('keydown', onKeyDown, true)));
    }

    protected installCodeTerminalShortcut(): void {
        const onKeyDown = (event: KeyboardEvent): void => {
            const togglePressed = (event.ctrlKey || event.metaKey)
                && !event.altKey
                && !event.shiftKey
                && (event.key === '`' || event.code === 'Backquote');
            if (!this.codeMode || !togglePressed) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            this.toggleCodePanel();
        };
        document.addEventListener('keydown', onKeyDown, true);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('keydown', onKeyDown, true)));
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
        const tab = Array.from(this.node.querySelectorAll<HTMLElement>('.poiesis-agent-window__code-editor-tab'))
            .find(candidate => candidate.dataset.codeWidgetId === widget.id);
        tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        if (focus) {
            tab?.querySelector<HTMLButtonElement>('.poiesis-agent-window__code-editor-tab-label')?.focus();
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
        this.closeCustomize(false);
        this.settingsModalVisible = true;
        this.deleteSessionConfirmationId = undefined;
        this.clearDataConfirmation = false;
        this.update();
        void this.refreshCliDetection();
    }

    protected closeSettings(): void {
        this.settingsModalVisible = false;
        this.deleteSessionConfirmationId = undefined;
        this.clearDataConfirmation = false;
        this.update();
    }

    protected openCustomize(): void {
        this.settingsModalVisible = false;
        this.customizeModalVisible = true;
        this.newSkillFormVisible = false;
        this.newSkillError = undefined;
        this.update();
        void this.refreshWorkspaceSkills();
    }

    protected closeCustomize(update = true): void {
        this.customizeModalVisible = false;
        this.newSkillFormVisible = false;
        this.newSkillId = '';
        this.newSkillKind = 'agent';
        this.newSkillError = undefined;
        this.newSkillCreating = false;
        if (update) {
            this.update();
        }
    }

    protected showNewSkillForm(): void {
        this.newSkillFormVisible = true;
        this.newSkillId = '';
        this.newSkillKind = 'agent';
        this.newSkillError = undefined;
        this.update();
    }

    protected hideNewSkillForm(): void {
        if (this.newSkillCreating) {
            return;
        }
        this.newSkillFormVisible = false;
        this.newSkillId = '';
        this.newSkillError = undefined;
        this.update();
    }

    protected setNewSkillId(id: string): void {
        this.newSkillId = id;
        this.newSkillError = undefined;
        this.update();
    }

    protected setNewSkillKind(kind: SkillBundleKind): void {
        this.newSkillKind = kind;
        this.update();
    }

    protected async refreshWorkspaceSkills(): Promise<void> {
        const generation = ++this.workspaceSkillsRefreshGeneration;
        const root = this.workspaceRoot()?.resource;
        this.workspaceSkillsLoading = true;
        this.workspaceSkillsError = undefined;
        this.update();
        if (!root) {
            this.workspaceSkills = [];
            this.workspaceSkillsLoading = false;
            this.workspaceSkillsError = 'User Skillを表示するにはWorkspaceを開いてください。';
            this.update();
            return;
        }
        const skillsDirectory = root.resolve('.poiesis/skills');
        try {
            if (!await this.fileService.exists(skillsDirectory)) {
                if (generation === this.workspaceSkillsRefreshGeneration) {
                    this.workspaceSkills = [];
                }
                return;
            }
            const stat = await this.fileService.resolve(skillsDirectory);
            const definitions = await Promise.all((stat.children ?? [])
                .filter(child => child.isDirectory)
                .sort((left, right) => left.name.localeCompare(right.name))
                .map(async child => {
                    const skillUri = child.resource.resolve('skill.md');
                    if (!await this.fileService.exists(skillUri)) {
                        return undefined;
                    }
                    try {
                        const content = await this.fileService.read(skillUri);
                        return this.parseWorkspaceSkill(child.name, skillUri, content.value);
                    } catch (error) {
                        return {
                            id: child.name,
                            name: child.name,
                            description: '',
                            uri: skillUri.toString(),
                            error: `skill.mdを読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`
                        } satisfies WorkspaceSkillDefinition;
                    }
                }));
            if (generation === this.workspaceSkillsRefreshGeneration) {
                this.workspaceSkills = definitions.filter((definition): definition is WorkspaceSkillDefinition => Boolean(definition));
            }
        } catch (error) {
            if (generation === this.workspaceSkillsRefreshGeneration) {
                this.workspaceSkills = [];
                this.workspaceSkillsError = `User Skillを読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`;
            }
        } finally {
            if (generation === this.workspaceSkillsRefreshGeneration) {
                this.workspaceSkillsLoading = false;
                this.update();
            }
        }
    }

    protected parseWorkspaceSkill(id: string, uri: URI, rawContent: string): WorkspaceSkillDefinition {
        const content = rawContent.replace(/^\uFEFF/, '');
        const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!frontmatter) {
            return { id, name: id, description: '', uri: uri.toString(), error: 'frontmatterがありません。name、description、kindを定義してください。' };
        }
        const fields = new Map<string, string>();
        for (const line of frontmatter[1].split(/\r?\n/)) {
            const separator = line.indexOf(':');
            if (separator > 0) {
                fields.set(line.slice(0, separator).trim(), this.frontmatterValue(line.slice(separator + 1)));
            }
        }
        const name = fields.get('name');
        const description = fields.get('description');
        const kind = fields.get('kind');
        if (!name || !description || (kind !== 'agent' && kind !== 'results')) {
            return { id, name: name || id, description: description || '', uri: uri.toString(), error: 'frontmatterのname、description、kind（agent／results）を確認してください。' };
        }
        return { id, name, description, kind, uri: uri.toString() };
    }

    protected frontmatterValue(rawValue: string): string {
        const value = rawValue.trim();
        const quote = value[0];
        return value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote
            ? value.slice(1, -1)
            : value;
    }

    protected async createWorkspaceSkill(): Promise<void> {
        if (this.newSkillCreating) {
            return;
        }
        const id = this.newSkillId.trim();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
            this.newSkillError = 'Skill IDは小文字の英数字とハイフンで入力してください。';
            this.update();
            return;
        }
        const root = this.workspaceRoot()?.resource;
        if (!root) {
            this.newSkillError = 'Skillを作成するにはWorkspaceを開いてください。';
            this.update();
            return;
        }
        const skillDirectory = root.resolve(`.poiesis/skills/${id}`);
        const skillUri = skillDirectory.resolve('skill.md');
        this.newSkillCreating = true;
        this.newSkillError = undefined;
        this.update();
        try {
            if (await this.fileService.exists(skillUri)) {
                this.newSkillError = `「${id}」はすでに存在します。`;
                return;
            }
            await this.fileService.createFolder(skillDirectory);
            await this.fileService.create(skillUri, this.workspaceSkillTemplate(id, this.newSkillKind));
            await this.refreshWorkspaceSkills();
            await this.openWorkspaceSkill(skillUri.toString());
        } catch (error) {
            this.newSkillError = `Skillを作成できませんでした: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.newSkillCreating = false;
            this.update();
        }
    }

    protected workspaceSkillTemplate(id: string, kind: SkillBundleKind): string {
        return `---\nname: ${id}\ndescription: このSkillの目的を記述してください\nkind: ${kind}\n---\n\n# ${id}\n\nここにSkillの指示を記述してください。\n`;
    }

    protected async openWorkspaceSkill(rawUri: string): Promise<void> {
        this.closeCustomize(false);
        if (!this.codeMode) {
            this.ensureCodeFileIcons();
            this.codeMode = true;
            this.update();
            requestAnimationFrame(() => void this.ensureCodeTerminal());
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        } else {
            this.update();
        }
        try {
            await this.openDraggedCodeFile(rawUri);
        } catch (error) {
            this.customizeModalVisible = true;
            this.workspaceSkillsError = `skill.mdをCodeで開けませんでした: ${error instanceof Error ? error.message : String(error)}`;
            this.update();
        }
    }

    protected async openTheiaSettings(): Promise<void> {
        this.closeSettings();
        if (!this.codeMode) {
            this.ensureCodeFileIcons();
            this.codeMode = true;
            this.update();
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        await this.openCodeSettings();
    }

    protected uiFontScaleValue(): number {
        return this.uiFontScale === 'small' ? 0.92 : this.uiFontScale === 'large' ? 1.12 : 1;
    }

    protected setUiFontScale(scale: UiFontScale): void {
        this.uiFontScale = scale;
        this.persistPoiesisSettings();
        this.update();
    }

    protected setRoleCli(role: AiRole, cli: KnownCliId): void {
        const defaultModel = this.cliDetectionReport?.detections.find(detection => detection.id === cli)?.defaultModel ?? '';
        if (role === 'agent') {
            this.agentCli = cli;
            this.agentModel = defaultModel;
        } else {
            this.resultsCli = cli;
            this.resultsModel = defaultModel;
            this.resultsGenerationContext.providerId = cli;
            this.resultsGenerationContext.model = defaultModel;
        }
        this.customModelRoles.delete(role);
        this.persistPoiesisSettings();
        this.update();
    }

    protected roleModel(role: AiRole): string {
        return role === 'agent' ? this.agentModel : this.resultsModel;
    }

    protected setRoleModelChoice(role: AiRole, value: string): void {
        if (value === '__custom__') {
            this.customModelRoles.add(role);
            this.setRoleModel(role, '');
            return;
        }
        this.customModelRoles.delete(role);
        this.setRoleModel(role, value);
    }

    protected setRoleModel(role: AiRole, model: string): void {
        if (role === 'agent') {
            this.agentModel = model;
        } else {
            this.resultsModel = model;
            this.resultsGenerationContext.model = model.trim();
        }
        this.persistPoiesisSettings();
        this.update();
    }

    protected setAllowExternalResultsResources(allow: boolean): void {
        this.allowExternalResultsResources = allow;
        this.persistPoiesisSettings();
        this.update();
    }

    protected async refreshCliDetection(): Promise<void> {
        if (this.cliDetectionLoading) {
            return;
        }
        this.cliDetectionLoading = true;
        this.update();
        try {
            this.cliDetectionReport = await this.agentRuntimeServer.detectClis();
            let settingsChanged = false;
            for (const role of ['agent', 'results'] as const) {
                const selected = role === 'agent' ? this.agentCli : this.resultsCli;
                const currentModel = this.roleModel(role);
                const detection = this.cliDetectionReport.detections.find(item => item.id === selected);
                if (!currentModel && detection?.defaultModel) {
                    if (role === 'agent') {
                        this.agentModel = detection.defaultModel;
                    } else {
                        this.resultsModel = detection.defaultModel;
                        this.resultsGenerationContext.model = detection.defaultModel;
                    }
                    settingsChanged = true;
                }
            }
            if (settingsChanged) {
                this.persistPoiesisSettings();
            }
        } finally {
            this.cliDetectionLoading = false;
            this.update();
        }
    }

    protected async restorePoiesisSettings(): Promise<void> {
        try {
            const state = await this.storageService.getData<Partial<PersistedPoiesisSettings> | LegacyPoiesisSettings>(SETTINGS_STORAGE_KEY);
            if (state?.version === 1 || state?.version === 2 || state?.version === 3) {
                this.uiFontScale = state.uiFontScale === 'small' || state.uiFontScale === 'large'
                    ? state.uiFontScale
                    : 'standard';
                const legacyCli = state.version === 1 && isKnownCliId(state.preferredCli)
                    ? state.preferredCli
                    : DEFAULT_CLI_ID;
                this.agentCli = (state.version === 2 || state.version === 3) && isKnownCliId(state.agentCli)
                    ? state.agentCli
                    : legacyCli;
                this.resultsCli = (state.version === 2 || state.version === 3) && isKnownCliId(state.resultsCli)
                    ? state.resultsCli
                    : legacyCli;
                this.agentModel = state.version === 3 && typeof state.agentModel === 'string' ? state.agentModel : '';
                this.resultsModel = state.version === 3 && typeof state.resultsModel === 'string' ? state.resultsModel : '';
                this.allowExternalResultsResources = state.allowExternalResultsResources === true;
            }
        } catch (error) {
            console.warn('[Poiesis] Could not restore settings.', error);
        }
        this.resultsGenerationContext.providerId = this.resultsCli;
        this.resultsGenerationContext.model = this.resultsModel.trim();
        this.update();
    }

    protected persistPoiesisSettings(): void {
        void this.storageService.setData<PersistedPoiesisSettings>(SETTINGS_STORAGE_KEY, {
            version: 3,
            uiFontScale: this.uiFontScale,
            agentCli: this.agentCli,
            agentModel: this.agentModel,
            resultsCli: this.resultsCli,
            resultsModel: this.resultsModel,
            allowExternalResultsResources: this.allowExternalResultsResources
        });
    }

    protected resultsDocumentHtml(html: string): string {
        if (this.allowExternalResultsResources) {
            return html;
        }
        const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`;
        return /<head(?:\s[^>]*)?>/i.test(html)
            ? html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n  ${policy}`)
            : `${policy}\n${html}`;
    }

    protected async clearSavedSessionData(): Promise<void> {
        if (!this.clearDataConfirmation) {
            return;
        }
        for (const session of [...this.sessions]) {
            for (const [taskId, notice] of session.resultsNotices) {
                if (notice.status === 'sending') {
                    await this.resultsQuestionService.cancel(taskId);
                }
            }
            if (session.agentSession) {
                try {
                    await this.agentProvider.cancel(session.agentSession.id);
                } catch {
                    // The local process may already have ended; data removal still continues.
                }
            }
            this.taskService.remove(session.taskIds);
            this.resultsService.remove(session.taskIds);
        }
        this.sessions.splice(0, this.sessions.length);
        this.selectedSessionId = undefined;
        this.deleteSessionConfirmationId = undefined;
        this.clearDataConfirmation = false;
        await this.createSession();
    }

    protected onBeforeDetach(message: Message): void {
        this.railResizeCleanup?.dispose();
        this.railResizeCleanup = undefined;
        this.codeSidebarResizeCleanup?.dispose();
        this.codeSidebarResizeCleanup = undefined;
        this.codePanelResizeCleanup?.dispose();
        this.codePanelResizeCleanup = undefined;
        if (this.codeWidgetAttachmentFrame !== undefined) {
            cancelAnimationFrame(this.codeWidgetAttachmentFrame);
            this.codeWidgetAttachmentFrame = undefined;
        }
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

    protected findSessionForTask(task: ExecutionTask): WindowAgentSession | undefined {
        return this.sessions.find(session => session.id === task.sessionId)
            ?? this.findSessionByAgentId(task.sessionId);
    }

    protected selectSession(sessionId: string): void {
        const session = this.sessions.find(candidate => candidate.id === sessionId && !candidate.archived);
        if (!session) {
            return;
        }
        this.selectedSessionId = sessionId;
        session.unreadTaskCompletion = false;
        session.updatedAt = Date.now();
        this.openSessionMenuId = undefined;
        const currentWorkspaceUri = this.workspaceRoot()?.resource.toString();
        if (session.workspaceUri && !this.sameWorkspaceUri(session.workspaceUri, currentWorkspaceUri)) {
            this.persistWindowState();
            this.update();
            this.workspaceService.open(new URI(session.workspaceUri), { preserveWindow: true });
            return;
        }
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
            taskIds: [],
            resultsDrafts: new Map<string, string>(),
            resultsNotices: new Map<string, ResultsNotice>()
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
                workspaceUri: session.workspaceUri,
                providerId: this.agentCli,
                model: this.agentModel.trim() || undefined
            });
            this.providerPreparationErrors.delete(session.id);
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
            this.providerPreparationErrors.set(session.id, error instanceof Error ? error.message : String(error));
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
            const state = await this.loadGlobalWindowState();
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
                const restoredTasks = this.taskService.restore(Array.isArray(candidate.tasks) ? candidate.tasks : []);
                const taskIds = restoredTasks.map(task => task.id);
                this.resultsService.restore(
                    Array.isArray(candidate.resultsDocuments) ? candidate.resultsDocuments : [],
                    new Set(taskIds)
                );
                const taskById = new Map(restoredTasks.map(task => [task.id, task]));
                const restoredMessages = (Array.isArray(candidate.messages) ? candidate.messages.filter(message =>
                    message && typeof message.id === 'string'
                    && (message.role === 'user' || message.role === 'agent')
                    && typeof message.content === 'string'
                ).map(message => ({ ...message, complete: Boolean(message.complete) })) : []).map(message => {
                    const task = message.taskId ? taskById.get(message.taskId) : undefined;
                    if (message.complete || task?.status !== 'failed') {
                        return message;
                    }
                    return {
                        ...message,
                        content: task.failure?.summary ?? 'タスクの実行に失敗しました。',
                        complete: true,
                        error: true,
                        errorDetails: task.failure?.details
                    };
                });
                const latestTask = restoredTasks[restoredTasks.length - 1];
                const restored: WindowAgentSession = {
                    id: candidate.id,
                    createdAt,
                    updatedAt: Number(candidate.updatedAt) || createdAt,
                    workspaceUri: typeof candidate.workspaceUri === 'string'
                        ? this.canonicalWorkspaceUri(candidate.workspaceUri)
                        : this.workspaceRoot()?.resource.toString(),
                    branch: typeof candidate.branch === 'string' ? candidate.branch : this.currentGitBranch() ?? 'main',
                    runTarget: 'local',
                    title: candidate.title || NEW_SESSION_TITLE,
                    hasUserMessage: Boolean(candidate.hasUserMessage),
                    lastTaskStatus: latestTask?.status === 'completed'
                        || latestTask?.status === 'failed'
                        || latestTask?.status === 'cancelled'
                        ? latestTask.status
                        : candidate.lastTaskStatus === 'completed'
                        || candidate.lastTaskStatus === 'failed'
                        || candidate.lastTaskStatus === 'cancelled'
                        ? candidate.lastTaskStatus
                        : undefined,
                    unreadTaskCompletion: Boolean(candidate.unreadTaskCompletion),
                    pinned: Boolean(candidate.pinned),
                    archived: Boolean(candidate.archived),
                    activeTab: candidate.activeTab === 'results' ? 'results' : 'agent',
                    agentDraft: typeof candidate.agentDraft === 'string' ? candidate.agentDraft : '',
                    messages: restoredMessages,
                    taskIds,
                    selectedResultsTaskId: typeof candidate.selectedResultsTaskId === 'string'
                        ? candidate.selectedResultsTaskId
                        : undefined,
                    resultsDrafts: new Map(Array.isArray(candidate.resultsDrafts) ? candidate.resultsDrafts : []),
                    resultsNotices: new Map<string, ResultsNotice>()
                };
                return [restored];
            }));
            this.selectedSessionId = typeof state.selectedSessionId === 'string' ? state.selectedSessionId : undefined;
            this.railWidth = this.clampRailWidth(Number(state.railWidth) || DEFAULT_RAIL_WIDTH);
            this.railCollapsed = Boolean(state.railCollapsed);
            this.sessionSequence = this.sessions.length;
            return this.sessions.length > 0;
        } catch (error) {
            console.warn('[Poiesis] Could not restore Agent Window sessions.', error);
            return false;
        }
    }

    protected async loadGlobalWindowState(): Promise<Partial<PersistedAgentWindowState> | undefined> {
        const globalState = await this.globalStorageService.getData<Partial<PersistedAgentWindowState>>(GLOBAL_SESSION_STORAGE_KEY);
        const migrated = await this.globalStorageService.getData<boolean>(SESSION_MIGRATION_MARKER_KEY);
        if (migrated) {
            return globalState;
        }
        const legacyStates = await this.globalStorageService.getWorkspaceData<Partial<PersistedAgentWindowState>>(SESSION_STORAGE_KEY);
        const currentLegacyState = await this.storageService.getData<Partial<PersistedAgentWindowState>>(SESSION_STORAGE_KEY);
        if (currentLegacyState) {
            legacyStates.push(currentLegacyState);
        }
        const merged = this.mergePersistedWindowStates([globalState, ...legacyStates]);
        if (merged) {
            await this.globalStorageService.setData(GLOBAL_SESSION_STORAGE_KEY, merged);
        }
        await this.globalStorageService.setData(SESSION_MIGRATION_MARKER_KEY, true);
        return merged;
    }

    protected mergePersistedWindowStates(
        states: Array<Partial<PersistedAgentWindowState> | undefined>
    ): PersistedAgentWindowState | undefined {
        const valid = states.filter((state): state is Partial<PersistedAgentWindowState> =>
            state?.version === 1 && Array.isArray(state.sessions)
        );
        if (!valid.length) {
            return undefined;
        }
        const mergedSessions = new Map<string, PersistedAgentWindowState['sessions'][number]>();
        for (const state of valid) {
            for (const session of state.sessions ?? []) {
                if (!session || typeof session.id !== 'string') {
                    continue;
                }
                const existing = mergedSessions.get(session.id);
                if (!existing || Number(session.updatedAt) >= Number(existing.updatedAt)) {
                    mergedSessions.set(session.id, session);
                }
            }
        }
        const preferred = valid.find(state => typeof state.selectedSessionId === 'string') ?? valid[0];
        return {
            version: 1,
            selectedSessionId: preferred.selectedSessionId,
            railWidth: Number(preferred.railWidth) || DEFAULT_RAIL_WIDTH,
            railCollapsed: Boolean(preferred.railCollapsed),
            sessions: [...mergedSessions.values()]
        };
    }

    protected persistWindowState(): Promise<void> {
        try {
            const state: PersistedAgentWindowState = {
                version: 1,
                selectedSessionId: this.selectedSessionId,
                railWidth: this.railWidth,
                railCollapsed: this.railCollapsed,
                sessions: this.sessions.map(session => {
                    const tasks = this.persistedTasks(session);
                    const taskIds = new Set(tasks.map(task => task.id));
                    const resultsDocuments = this.resultsService.list(taskIds).map(document => ({
                        ...document,
                        html: document.html?.slice(0, MAX_PERSISTED_RESULTS_HTML_CHARS)
                    }));
                    const {
                        agentSession: _agentSession,
                        taskIds: _taskIds,
                        resultsDrafts,
                        resultsNotices: _resultsNotices,
                        ...persisted
                    } = session;
                    return {
                        ...persisted,
                        resultsDrafts: [...resultsDrafts.entries()],
                        tasks,
                        resultsDocuments
                    };
                })
            };
            this.windowStatePersistence = this.windowStatePersistence
                .catch(() => undefined)
                .then(() => this.globalStorageService.setData(GLOBAL_SESSION_STORAGE_KEY, state))
                .catch(error => {
                    console.warn('[Poiesis] Could not persist Agent Window sessions.', error);
                });
        } catch (error) {
            console.warn('[Poiesis] Could not persist Agent Window sessions.', error);
        }
        return this.windowStatePersistence;
    }

    protected titleForSession(message: string): string {
        const compact = message.replace(/\s+/g, ' ').trim();
        return compact.length > 46 ? `${compact.slice(0, 43)}…` : compact;
    }

    protected persistedTasks(session: WindowAgentSession): ExecutionTask[] {
        return session.taskIds
            .map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => Boolean(task))
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
            .slice(-MAX_PERSISTED_TASKS_PER_SESSION)
            .map(task => task.status === 'running' ? {
                ...task,
                status: 'failed',
                endedAt: new Date().toISOString(),
                failure: { summary: 'アプリ終了により中断されました' }
            } : task);
    }

    protected async initializeSessions(): Promise<void> {
        await this.workspaceService.roots;
        const restored = await this.restoreWindowState();
        const currentWorkspaceKey = this.workspaceGroupKey(this.workspaceRoot()?.resource.toString());
        this.expandedWorkspaceGroups.add(currentWorkspaceKey);
        if (!restored) {
            await this.createSession();
            return;
        }
        const activeSessions = this.filteredSessions(false);
        const currentWorkspaceUri = this.workspaceRoot()?.resource.toString();
        const selected = activeSessions.find(session =>
            session.id === this.selectedSessionId && this.sameWorkspaceUri(session.workspaceUri, currentWorkspaceUri)
        ) ?? activeSessions.find(session => this.sameWorkspaceUri(session.workspaceUri, currentWorkspaceUri));
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
        await this.sessionsInitialization;
        const session = this.selectedSession();
        const content = session?.agentDraft.trim() ?? '';
        if (!session || !session.workspaceUri || !content || this.runningTask(session)) {
            return;
        }
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
                'Agentを開始できませんでした。',
                this.providerPreparationErrors.get(session.id)
            );
            return;
        }
        if (!session.agentSession) {
            await this.recordPreSpawnFailure(session, content, 'Agentを開始できませんでした。');
            return;
        }
        try {
            await this.agentProvider.sendMessage(session.agentSession.id, {
                role: 'user',
                content,
                ownerSessionId: session.id
            });
        } catch (error) {
            await this.recordPreSpawnFailure(
                session,
                content,
                'Agentを開始できませんでした。',
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    protected async recordPreSpawnFailure(
        session: WindowAgentSession,
        request: string,
        summary: string,
        details?: string
    ): Promise<void> {
        const task = this.taskService.failBeforeStart(session.id, request, { summary, details });
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
        if (event.type === 'task-started') {
            session.messages.push({ id: `agent-${event.taskId}`, role: 'agent', content: '', complete: false, taskId: event.taskId });
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
    }

    protected updateAgentMessage(session: WindowAgentSession, taskId: string, update: (message: ChatMessage) => ChatMessage): void {
        const id = `agent-${taskId}`;
        session.messages = session.messages.map(message => message.id === id ? update(message) : message);
    }

    protected runningTask(session = this.selectedSession()): ExecutionTask | undefined {
        return session?.taskIds
            .map(taskId => this.taskService.get(taskId))
            .find(task => task?.status === 'running');
    }

    protected finishedTasks(session = this.selectedSession()): ExecutionTask[] {
        return session?.taskIds
            .map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => task !== undefined && task.status !== 'running')
            ?? [];
    }

    protected taskFinishedTime(task: ExecutionTask): string {
        const endedAt = task.endedAt ? new Date(task.endedAt) : undefined;
        if (!endedAt || Number.isNaN(endedAt.getTime())) {
            return '';
        }
        const hours = endedAt.getHours().toString().padStart(2, '0');
        const minutes = endedAt.getMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
    }

    protected toggleCodeMode(): void {
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
        const session = this.selectedSession();
        if (session) {
            session.activeTab = tab;
            this.persistWindowState();
        }
        this.update();
    }

    protected async newChat(): Promise<void> {
        await this.sessionsInitialization;
        this.detachCodeWidgets();
        this.codeMode = false;
        this.sessionSearchVisible = false;
        this.sessionSearchQuery = '';
        this.repositoryPickerVisible = false;
        this.repositoryPickerAnchor = undefined;
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

    protected setAgentDraft(sessionId: string | undefined, value: string): void {
        const session = this.selectedSession();
        if (!sessionId || session?.id !== sessionId) {
            return;
        }
        session.agentDraft = value;
        this.persistWindowState();
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

    protected async submitResultsQuestion(taskId: string, retryQuestion?: string): Promise<void> {
        const session = this.selectedSession();
        const task = this.taskService.get(taskId);
        const document = this.resultsService.get(taskId);
        const question = retryQuestion?.trim() || session?.resultsDrafts.get(taskId)?.trim();
        const currentNotice = session?.resultsNotices.get(taskId);
        if (!session
            || !session.workspaceUri
            || !task
            || task.status === 'running'
            || !this.finishedTasks(session).some(candidate => candidate.id === taskId)
            || document?.status !== 'ready'
            || !document.html
            || !question
            || question.length > 4_000
            || currentNotice?.status === 'sending') {
            return;
        }
        session.resultsDrafts.set(taskId, '');
        session.resultsNotices.set(taskId, { question, status: 'sending', text: '' });
        this.persistWindowState();
        this.update();
        try {
            const result = await this.resultsQuestionService.ask(question, {
                taskId,
                providerId: this.resultsCli,
                model: this.resultsModel.trim() || undefined,
                workspaceUri: session.workspaceUri,
                taskMetadata: {
                    title: task.title,
                    request: task.request,
                    status: task.status,
                    startedAt: task.startedAt,
                    endedAt: task.endedAt
                },
                changeSetSummary: task.changeSet?.diff
                    || task.changeSet?.error
                    || 'No changes were recorded.',
                resultsHtml: document.html
            });
            if (result.status === 'answered') {
                session.resultsNotices.set(taskId, { question, status: 'answered', text: result.answer });
            } else if (result.status === 'failed') {
                session.resultsNotices.set(taskId, { question, status: 'failed', text: result.error.message });
            } else {
                session.resultsDrafts.set(taskId, question);
                session.resultsNotices.delete(taskId);
            }
        } catch {
            session.resultsNotices.set(taskId, {
                question,
                status: 'failed',
                text: '回答を作成できませんでした。もう一度お試しください。'
            });
        }
        this.persistWindowState();
        this.update();
    }

    protected async retryResults(taskId: string): Promise<void> {
        await this.resultsService.retry(taskId);
    }

    protected async retryTask(taskId: string): Promise<void> {
        const task = this.taskService.get(taskId);
        const session = task ? this.sessions.find(candidate => candidate.taskIds.includes(task.id)) : undefined;
        if (!task || !session || this.runningTask(session)) {
            return;
        }
        this.detachCodeWidgets();
        this.codeMode = false;
        this.selectedSessionId = session.id;
        session.activeTab = 'agent';
        session.selectedResultsTaskId = undefined;
        session.agentDraft = task.request;
        this.persistWindowState();
        this.update();
        await this.sendAgentMessage();
    }
}
