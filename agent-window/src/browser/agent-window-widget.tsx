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
import { AgentActivity, AgentActivityKind, AgentEvent, AgentProvider, AgentSession } from '../common/agent-provider';
import {
    AgentRuntimeServer,
    AiRole,
    CliDetectionReport,
    DEFAULT_CLI_ID,
    FolderBrowserResult,
    isKnownCliId,
    KnownCliId
} from '../common/agent-runtime-protocol';
import { formatRequirementExecutionEvidence, ResultsService } from './results-skill';
import {
    ExecutionTask,
    formatTaskEndedAtJst,
    summarizeTaskChangeSet,
    TaskChangeSet,
    TaskResultDocument,
    TaskResultsQuestion,
    TaskService,
    taskTitleForRequest
} from './task-service';
import { getDesignVariant } from './design-variant';
import { FolderExplorerService } from './folder-explorer-service';
import { ResultsQuestionService } from './results-question-service';
import { GlobalStorageService } from './global-storage-service';
import { ResultsGenerationContext } from './results-generation-context';
import { SkillBundleKind } from '../common/skill-bundle';
import {
    collectWorkspaceRichContentReferences,
    POIESIS_EXTERNAL_LINK_ATTRIBUTE,
    POIESIS_FILE_LINK_ATTRIBUTE,
    POIESIS_INLINE_IMAGE_ATTRIBUTE,
    renderSafeMarkdown
} from './safe-markdown';
import {
    PendingSkillProposal,
    WorkspaceSkillDefinition,
    WorkspaceSkillDiscoveryRoot,
    WorkspaceSkillPreview,
    WorkspaceSkillService,
    WorkspaceSkillSource
} from './workspace-skill-service';
import { diffTextLines } from './text-diff';
import { formatTaskElapsedTime, shouldSubmitComposer } from './composer-behavior';
import { POIESIS_FONT_MONO, POIESIS_FONT_SANS } from './typography';
import { formatExecutionEvidence } from './results-document-normalizer';
import { Requirement } from './requirement-model';
import { RequirementService } from './requirement-service';
import { RequirementClassificationService } from './requirement-classification-service';
const SETTINGS_STORAGE_KEY = 'poiesis.settings.v1';
const DEFAULT_RAIL_WIDTH = 258;
const MIN_RAIL_WIDTH = 196;
const MAX_RAIL_WIDTH = 420;
const DEFAULT_CODE_SIDEBAR_WIDTH = 260;
const MIN_CODE_SIDEBAR_WIDTH = 180;
const MAX_CODE_SIDEBAR_WIDTH = 520;
const DEFAULT_CODE_PANEL_HEIGHT = 190;
const MIN_CODE_PANEL_HEIGHT = 96;
const MAX_AGENT_ACTIVITIES_PER_MESSAGE = 300;

import { PoiesisSelect, PoiesisSelectOption } from './components/poiesis-select';
import { PoiesisTextArea, PoiesisTextInput } from './components/poiesis-inputs';
import { PoiesisComposer } from './components/poiesis-composer';
import { PoiesisResultsElapsed, PoiesisTaskElapsed } from './components/elapsed';
import { AgentWindowHost, AgentWindowPartBase } from './agent-window/agent-window-host';
import { AgentWindowTab, ChatMessage, ResultsNotice, SessionStore, WindowAgentSession } from './agent-window/session-store';
import { SettingsPart } from './agent-window/settings-part';
import { CustomizePart } from './agent-window/customize-part';
import { CodePart } from './agent-window/code-part';
import { ResultsPart } from './agent-window/results-part';
import { AgentPart } from './agent-window/agent-part';
import { HeaderPart } from './agent-window/header-part';
import { RailPart } from './agent-window/rail-part';

@injectable()
export class AgentWindowWidget extends ReactWidget implements AgentWindowHost {
    protected settingsPart!: SettingsPart;
    protected customizePart!: CustomizePart;
    protected codePart!: CodePart;
    protected resultsPart!: ResultsPart;
    protected agentPart!: AgentPart;
    protected headerPart!: HeaderPart;
    protected railPart!: RailPart;
    [name: string]: any;

    protected readonly agentWindowParts: AgentWindowPartBase[] = [];
    protected sessionStore!: SessionStore;
    declare protected readonly sessions: SessionStore['sessions'];
    declare protected sessionsInitialized: SessionStore['sessionsInitialized'];
    declare protected sessionsInitialization: SessionStore['sessionsInitialization'];
    declare protected windowStatePersistence: SessionStore['windowStatePersistence'];
    declare protected resultsQaPanelStatePersistence: SessionStore['resultsQaPanelStatePersistence'];
    declare protected resultsTaskRailCollapsed: SessionStore['resultsTaskRailCollapsed'];
    declare protected legacyErrorMessagesMigrated: SessionStore['legacyErrorMessagesMigrated'];
    declare protected selectedSessionId: SessionStore['selectedSessionId'];
    declare protected sessionSequence: SessionStore['sessionSequence'];
    declare protected readonly watchedScmProviders: SessionStore['watchedScmProviders'];
    declare protected readonly watchedScmHistoryProviders: SessionStore['watchedScmHistoryProviders'];
    declare protected readonly selectedSession: SessionStore['selectedSession'];
    declare protected readonly findSessionByAgentId: SessionStore['findSessionByAgentId'];
    declare protected readonly findSessionForTask: SessionStore['findSessionForTask'];
    declare protected readonly selectSession: SessionStore['selectSession'];
    declare protected readonly workspaceRoot: SessionStore['workspaceRoot'];
    declare protected readonly workspaceFolderName: SessionStore['workspaceFolderName'];
    declare protected readonly workspaceContextLabel: SessionStore['workspaceContextLabel'];
    declare protected readonly gitBranchForWorkspace: SessionStore['gitBranchForWorkspace'];
    declare protected readonly currentGitBranch: SessionStore['currentGitBranch'];
    declare protected readonly watchScmProvider: SessionStore['watchScmProvider'];
    declare protected readonly watchScmHistoryProvider: SessionStore['watchScmHistoryProvider'];
    declare protected readonly createSession: SessionStore['createSession'];
    declare protected readonly ensureProviderSession: SessionStore['ensureProviderSession'];
    declare protected readonly restoreWindowState: SessionStore['restoreWindowState'];
    declare protected readonly migrateLegacyCliErrorMessage: SessionStore['migrateLegacyCliErrorMessage'];
    declare protected readonly loadGlobalWindowState: SessionStore['loadGlobalWindowState'];
    declare protected readonly mergePersistedWindowStates: SessionStore['mergePersistedWindowStates'];
    declare protected readonly restoreResultsQaPanelState: SessionStore['restoreResultsQaPanelState'];
    declare protected readonly persistResultsQaPanelState: SessionStore['persistResultsQaPanelState'];
    declare protected readonly persistWindowState: SessionStore['persistWindowState'];
    declare protected readonly titleForSession: SessionStore['titleForSession'];
    declare protected readonly requirementsForSession: SessionStore['requirementsForSession'];
    declare protected readonly resultsRequirements: SessionStore['resultsRequirements'];
    declare protected readonly latestTaskForRequirement: SessionStore['latestTaskForRequirement'];
    declare protected readonly latestRequirement: SessionStore['latestRequirement'];
    declare protected readonly finishedTasksForRequirement: SessionStore['finishedTasksForRequirement'];
    declare protected readonly fallbackRequirementChangeSet: SessionStore['fallbackRequirementChangeSet'];
    declare protected readonly selectedResultsScopeKey: SessionStore['selectedResultsScopeKey'];
    declare protected readonly persistedTasks: SessionStore['persistedTasks'];
    declare protected readonly initializeSessions: SessionStore['initializeSessions'];
    declare protected readonly runningTask: SessionStore['runningTask'];
    declare protected readonly finishedTasks: SessionStore['finishedTasks'];
    declare protected readonly isResultsTask: SessionStore['isResultsTask'];
    declare protected readonly taskFinishedTime: SessionStore['taskFinishedTime'];
    declare protected readonly taskStatusLabel: SessionStore['taskStatusLabel'];
    static readonly ID = 'poiesis-agent-window';
    static readonly FILES_WIDGET_FACTORY_ID = 'files';
    static readonly SEARCH_WIDGET_FACTORY_ID = 'search-in-workspace';
    static readonly GIT_WIDGET_FACTORY_ID = 'scm-view';
    static readonly GIT_GRAPH_WIDGET_FACTORY_ID = 'scm-history-graph-widget';
    static readonly EDITOR_WIDGET_FACTORY_ID = 'code-editor-opener';
    static readonly SETTINGS_WIDGET_FACTORY_ID = 'settings_widget';
    static readonly EXTENSIONS_WIDGET_FACTORY_ID = 'vsx-extensions-view-container';
    protected codeMode = false;

    constructor(
        @inject(AgentProvider) public readonly agentProvider: AgentProvider,
        @inject(TaskService) public readonly taskService: TaskService,
        @inject(ResultsService) public readonly resultsService: ResultsService,
        @inject(RequirementService) public readonly requirementService: RequirementService,
        @inject(RequirementClassificationService) public readonly requirementClassificationService: RequirementClassificationService,
        @inject(WorkspaceService) public readonly workspaceService: WorkspaceService,
        @inject(ScmService) public readonly scmService: ScmService,
        @inject(TerminalService) public readonly terminalService: TerminalService,
        @inject(WidgetManager) public readonly widgetManager: WidgetManager,
        @inject(EditorManager) public readonly editorManager: EditorManager,
        @inject(OpenerService) public readonly openerService: OpenerService,
        @inject(FileService) public readonly fileService: FileService,
        @inject(CommandService) public readonly commandService: CommandService,
        @inject(SaveableService) public readonly saveableService: SaveableService,
        @inject(IconThemeService) public readonly iconThemeService: IconThemeService,
        @inject(VSXExtensionsSearchModel) public readonly extensionsSearchModel: VSXExtensionsSearchModel,
        @inject(StorageService) public readonly storageService: StorageService,
        @inject(GlobalStorageService) public readonly globalStorageService: GlobalStorageService,
        @inject(FolderExplorerService) public readonly folderExplorerService: FolderExplorerService,
        @inject(AgentRuntimeServer) public readonly agentRuntimeServer: AgentRuntimeServer,
        @inject(ResultsQuestionService) public readonly resultsQuestionService: ResultsQuestionService,
        @inject(ResultsGenerationContext) public readonly resultsGenerationContext: ResultsGenerationContext,
        @inject(WorkspaceSkillService) public readonly workspaceSkillService: WorkspaceSkillService,
        @inject(MessageService) public readonly messageService: MessageService
    ) {
        super();
    }

    protected registerAgentWindowPart<T extends AgentWindowPartBase>(part: T): T {
        this.agentWindowParts.push(part);
        for (const name of Reflect.ownKeys(part)) {
            if (name === 'host' || name in this) {
                continue;
            }
            Object.defineProperty(this, name, {
                configurable: true,
                get: () => Reflect.get(part, name, part),
                set: value => { Reflect.set(part, name, value, part); }
            });
        }
        let prototype = Object.getPrototypeOf(part);
        while (prototype && prototype !== AgentWindowPartBase.prototype) {
            for (const name of Reflect.ownKeys(prototype)) {
                if (name === 'constructor' || name in this) {
                    continue;
                }
                Object.defineProperty(this, name, {
                    configurable: true,
                    get: () => {
                        const value = Reflect.get(part, name, part);
                        return typeof value === 'function' ? (value as Function).bind(part) : value;
                    }
                });
            }
            prototype = Object.getPrototypeOf(prototype);
        }
        return part;
    }

    public resolveAgentWindowMember(name: PropertyKey): unknown {
        if (name in this) {
            const value = Reflect.get(this, name, this);
            return typeof value === 'function' ? (value as Function).bind(this) : value;
        }
        for (const part of this.agentWindowParts) {
            if (name in part) {
                const value = Reflect.get(part, name, part);
                return typeof value === 'function' ? value.bind(part) : value;
            }
        }
        return undefined;
    }

    public assignAgentWindowMember(name: PropertyKey, value: unknown): boolean {
        if (Object.prototype.hasOwnProperty.call(this, name)) {
            return Reflect.set(this, name, value, this);
        }
        for (const part of this.agentWindowParts) {
            if (Object.prototype.hasOwnProperty.call(part, name)) {
                return Reflect.set(part, name, value, part);
            }
        }
        return false;
    }

    @postConstruct()
    protected init(): void {
        getDesignVariant();
        this.sessionStore = this.registerAgentWindowPart(new SessionStore(this));
        this.settingsPart = this.registerAgentWindowPart(new SettingsPart(this));
        this.customizePart = this.registerAgentWindowPart(new CustomizePart(this));
        this.codePart = this.registerAgentWindowPart(new CodePart(this));
        this.resultsPart = this.registerAgentWindowPart(new ResultsPart(this));
        this.agentPart = this.registerAgentWindowPart(new AgentPart(this));
        this.headerPart = this.registerAgentWindowPart(new HeaderPart(this));
        this.railPart = this.registerAgentWindowPart(new RailPart(this));
        this.id = AgentWindowWidget.ID;
        this.addClass('poiesis-agent-window');
        this.toDispose.push(Disposable.create(() => {
            for (const content of this.agentRichContent.values()) {
                this.revokeAgentImageSources(content.imageSources);
            }
            this.agentRichContent.clear();
            this.agentRichContentPending.clear();
        }));

        const closeSessionMenu = (event: PointerEvent): void => {
            if (this.openSessionMenuId && !(event.target as Element | null)?.closest('.poiesis-agent-window__session-actions')) {
                this.openSessionMenuId = undefined;
                this.update();
            }
            if (this.openResultsMenuKey && !(event.target as Element | null)?.closest('.poiesis-results__menu-host')) {
                this.openResultsMenuKey = undefined;
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
            if (this.shortcutsOverlayVisible) {
                event.preventDefault();
                event.stopPropagation();
                this.closeShortcutsOverlay();
            } else if (this.folderExplorerVisible) {
                event.preventDefault();
                event.stopPropagation();
                if (this.creatingFolder) {
                    this.creatingFolder = false;
                    this.newFolderName = '';
                    this.update();
                } else {
                    this.closeFolderExplorer();
                }
            } else if (this.settingsModalVisible) {
                event.preventDefault();
                event.stopPropagation();
                this.closeSettings();
            } else if (document.querySelector('.poiesis-select__listbox')) {
                return;
            } else if (this.customizeViewVisible) {
                event.preventDefault();
                event.stopPropagation();
                this.handleCustomizeEscape();
            } else if (this.workspacePickerVisible || this.repositoryPickerVisible) {
                event.preventDefault();
                this.workspacePickerVisible = false;
                this.workspacePickerAnchor = undefined;
                this.repositoryPickerVisible = false;
                this.repositoryPickerAnchor = undefined;
                this.workspaceSearchQuery = '';
                this.repositorySearchQuery = '';
                this.update();
            } else if (this.explorerMoreVisible || this.openSessionMenuId) {
                event.preventDefault();
                this.explorerMoreVisible = false;
                this.openSessionMenuId = undefined;
                this.update();
            }
        };
        document.addEventListener('keydown', closeOverlaysOnEscape, true);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('keydown', closeOverlaysOnEscape, true)));
        this.installWorkspaceSkillSaveShortcut();
        this.installCodeEditorSaveShortcut();
        this.installCodeTerminalShortcut();
        this.installCodeTabDropTarget();
        const receiveResultsMessage = (event: MessageEvent): void => this.handleResultsFrameMessage(event);
        window.addEventListener('message', receiveResultsMessage);
        this.toDispose.push(Disposable.create(() => window.removeEventListener('message', receiveResultsMessage)));
        this.toDispose.push(this.fileService.onDidFilesChange(event => {
            if (!this.customizeViewVisible || !event.changes.some(change =>
                this.workspaceSkillWatchRoots.some((root: URI) => root.isEqualOrParent(change.resource, false)))) {
                return;
            }
            this.scheduleWorkspaceSkillsRefresh();
        }));
        this.toDispose.push(Disposable.create(() => this.disposeWorkspaceSkillWatchers()));

        this.toDispose.push(this.agentProvider.onEvent(event => this.handleAgentEvent(event)));
        this.toDispose.push(this.taskService.onDidChangeTask(event => this.sessionStore.handleTaskChange(event)));
        this.toDispose.push(this.taskService.onDidRecordSkillProposals(() => this.sessionStore.handleSkillProposalsChanged()));
        this.toDispose.push(this.resultsService.onDidChange(document => this.sessionStore.handleResultsDocumentChanged(document)));
        this.toDispose.push(this.requirementService.onDidChange(event => this.sessionStore.handleRequirementChange(event)));
        this.toDispose.push(this.requirementClassificationService.onDidClassify(task =>
            this.sessionStore.handleRequirementClassified(task)));
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => {
            void this.refreshRecentWorkspaces();
            if (this.customizeViewVisible) {
                void this.refreshWorkspaceSkills();
            }
            this.update();
        }));
        this.toDispose.push(this.workspaceService.onWorkspaceLocationChanged(() => {
            void this.refreshRecentWorkspaces();
            if (this.customizeViewVisible) {
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
            .then(() => this.initializeSessions()).catch((error: unknown) => {
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
                data-mode={this.codeMode ? 'code' : this.customizeViewVisible ? 'customize' : activeTab}
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
                            : this.customizeViewVisible
                                ? this.renderCustomizeView()
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
                {this.shortcutsOverlayVisible && this.renderShortcutsOverlay()}
            </div>
        );
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

    protected toggleCodeMode(): void {
        if (this.codeMode) {
            this.detachCodeWidgets();
            this.codeMode = false;
        } else {
            this.closeCustomize(false);
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
            if (tab === 'results' && !this.resultsRequirements(session)
                .some(requirement => requirement.id === session.selectedResultsRequirementId)) {
                session.selectedResultsRequirementId = this.latestRequirement(session)?.id;
                session.selectedResultsTaskId = undefined;
                this.persistResultsQaPanelState();
            }
            this.persistWindowState();
        }
        this.update();
    }

    protected async newChat(): Promise<void> {
        await this.sessionsInitialization;
        this.closeCustomize(false);
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
}
