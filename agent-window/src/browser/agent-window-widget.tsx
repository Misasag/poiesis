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
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
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
import { AgentWindowHost, AgentWindowState } from './agent-window/agent-window-host';
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
    public sessions!: SessionStore;

    public readonly state: AgentWindowState = {
        codeMode: false,
        customizeViewVisible: false,
        settingsModalVisible: false,
        shortcutsOverlayVisible: false,
        uiFontScale: 'standard',
        agentCli: DEFAULT_CLI_ID,
        agentModel: '',
        agentEffort: '',
        resultsCli: DEFAULT_CLI_ID,
        resultsModel: '',
        resultsEffort: '',
        effortByModel: { agent: {}, results: {} },
        allowExternalResultsResources: false,
        automaticRequirementClassification: true,
        cliDetectionPhase: 'pending',
        railCollapsed: false,
        railWidth: DEFAULT_RAIL_WIDTH,
        sessionSearchVisible: false,
        sessionSearchQuery: '',
        expandedWorkspaceGroups: new Set<string>(),
        workspacePickerVisible: false,
        workspaceSearchQuery: '',
        repositoryPickerVisible: false,
        repositorySearchQuery: '',
        folderExplorerVisible: false,
        creatingFolder: false,
        newFolderName: '',
        resultsTaskRailCollapsed: false,
        resultsSkillNamesLoaded: false,
        explorerMoreVisible: false,
        workspaceSkillWatchRoots: [],
        providerPreparationErrors: new Map<string, string>()
    };
    static readonly ID = 'poiesis-agent-window';
    static readonly FILES_WIDGET_FACTORY_ID = 'files';
    static readonly SEARCH_WIDGET_FACTORY_ID = 'search-in-workspace';
    static readonly GIT_WIDGET_FACTORY_ID = 'scm-view';
    static readonly GIT_GRAPH_WIDGET_FACTORY_ID = 'scm-history-graph-widget';
    static readonly EDITOR_WIDGET_FACTORY_ID = 'code-editor-opener';
    static readonly SETTINGS_WIDGET_FACTORY_ID = 'settings_widget';
    static readonly EXTENSIONS_WIDGET_FACTORY_ID = 'vsx-extensions-view-container';

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
        @inject(ProblemManager) public readonly problemManager: ProblemManager,
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

    public addDisposable(disposable: Disposable): void {
        this.toDispose.push(disposable);
    }

    // HeaderPart.
    public renderHeader(): React.ReactNode { return this.headerPart.renderHeader(); }

    // SettingsPart.
    public renderSettingsModal(): React.ReactNode { return this.settingsPart.renderSettingsModal(); }
    public renderShortcutsOverlay(): React.ReactNode { return this.settingsPart.renderShortcutsOverlay(); }
    public renderAiRolePill(role: AiRole, compact = false): React.ReactNode {
        return this.settingsPart.renderAiRolePill(role, compact);
    }
    public openSettings(): void { this.settingsPart.openSettings(); }
    public closeSettings(): void { this.settingsPart.closeSettings(); }
    public openShortcutsOverlay(): void { this.settingsPart.openShortcutsOverlay(); }
    public closeShortcutsOverlay(): void { this.settingsPart.closeShortcutsOverlay(); }
    public uiFontScaleValue(): number { return this.settingsPart.uiFontScaleValue(); }
    public refreshCliDetection(): Promise<void> { return this.settingsPart.refreshCliDetection(); }
    public waitForCurrentCliDetection(): Promise<void> { return this.settingsPart.waitForCurrentCliDetection(); }
    public restorePoiesisSettings(): Promise<void> { return this.settingsPart.restorePoiesisSettings(); }

    // RailPart.
    public renderRail(): React.ReactNode { return this.railPart.renderRail(); }
    public renderWorkspacePicker(): React.ReactNode { return this.railPart.renderWorkspacePicker(); }
    public renderRepositoryPicker(session: WindowAgentSession): React.ReactNode {
        return this.railPart.renderRepositoryPicker(session);
    }
    public renderFolderExplorer(): React.ReactNode { return this.railPart.renderFolderExplorer(); }
    public refreshRecentWorkspaces(): Promise<void> { return this.railPart.refreshRecentWorkspaces(); }
    public closeFolderExplorer(): void { this.railPart.closeFolderExplorer(); }
    public repositoryLabel(workspaceUri: string | undefined): string { return this.railPart.repositoryLabel(workspaceUri); }
    public toggleRepositoryPicker(anchor: HTMLElement): void { this.railPart.toggleRepositoryPicker(anchor); }
    public sessionMeta(session: WindowAgentSession): string { return this.railPart.sessionMeta(session); }
    public beginDeleteSession(sessionId: string): void { this.railPart.beginDeleteSession(sessionId); }
    public cancelDeleteSession(): void { this.railPart.cancelDeleteSession(); }
    public deleteSession(sessionId: string): Promise<void> { return this.railPart.deleteSession(sessionId); }
    public canonicalWorkspaceUri(workspaceUri: string | undefined): string | undefined {
        return this.railPart.canonicalWorkspaceUri(workspaceUri);
    }
    public sameWorkspaceUri(left: string | undefined, right: string | undefined): boolean {
        return this.railPart.sameWorkspaceUri(left, right);
    }
    public workspaceGroupKey(workspaceUri: string | undefined): string { return this.railPart.workspaceGroupKey(workspaceUri); }
    public filteredSessions(archived: boolean): WindowAgentSession[] { return this.railPart.filteredSessions(archived); }
    public clampRailWidth(width: number): number { return this.railPart.clampRailWidth(width); }
    public disposeRailResize(): void { this.railPart.disposeRailResize(); }

    // AgentPart.
    public renderAgent(session: WindowAgentSession | undefined, runningTask?: ExecutionTask): React.ReactNode {
        return this.agentPart.renderAgent(session, runningTask);
    }
    public renderMarkdown(
        content: string,
        workspaceImageSources?: ReadonlyMap<string, string>,
        explicitWorkspaceUri?: string
    ): React.ReactNode {
        return this.agentPart.renderMarkdown(content, workspaceImageSources, explicitWorkspaceUri);
    }
    public sendAgentMessage(): Promise<void> { return this.agentPart.sendAgentMessage(); }
    public handleAgentEvent(event: AgentEvent): void { this.agentPart.handleAgentEvent(event); }
    public restoreAgentActivities(value: unknown): AgentActivity[] | undefined {
        return this.agentPart.restoreAgentActivities(value);
    }
    public disposeAgentRichContentForSession(sessionId: string): void {
        this.agentPart.disposeAgentRichContentForSession(sessionId);
    }
    public disposeAgentRichContent(): void { this.agentPart.disposeAgentRichContent(); }
    public focusAgentComposer(): void { this.agentPart.focusAgentComposer(); }

    // ResultsPart.
    public renderResults(session: WindowAgentSession | undefined): React.ReactNode { return this.resultsPart.renderResults(session); }
    public handleResultsFrameMessage(event: MessageEvent): void { this.resultsPart.handleResultsFrameMessage(event); }
    public openResultsCitation(rawCitation: string): Promise<void> { return this.resultsPart.openResultsCitation(rawCitation); }
    public selectResultsTask(taskId: string): void { this.resultsPart.selectResultsTask(taskId); }
    public selectResultsRequirement(requirementId: string): void { this.resultsPart.selectResultsRequirement(requirementId); }
    public undoAutomaticRequirementSplit(taskId: string): void { this.resultsPart.undoAutomaticRequirementSplit(taskId); }
    public retryTask(taskId: string): Promise<void> { return this.resultsPart.retryTask(taskId); }
    public ensureResultsSkillNames(): Promise<void> { return this.resultsPart.ensureResultsSkillNames(); }

    // CustomizePart.
    public renderCustomizeView(): React.ReactNode { return this.customizePart.renderCustomizeView(); }
    public openCustomize(): void { this.customizePart.openCustomize(); }
    public closeCustomize(update = true): void { this.customizePart.closeCustomize(update); }
    public handleCustomizeEscape(): void { this.customizePart.handleCustomizeEscape(); }
    public installWorkspaceSkillSaveShortcut(): void { this.customizePart.installWorkspaceSkillSaveShortcut(); }
    public scheduleWorkspaceSkillsRefresh(): void { this.customizePart.scheduleWorkspaceSkillsRefresh(); }
    public disposeWorkspaceSkillWatchers(): void { this.customizePart.disposeWorkspaceSkillWatchers(); }
    public refreshWorkspaceSkills(): Promise<void> { return this.customizePart.refreshWorkspaceSkills(); }

    // CodePart.
    public renderCode(): React.ReactNode { return this.codePart.renderCode(); }
    public registerCodeWidget(factoryId: string, widget: Widget, pinned = false): void {
        this.codePart.registerCodeWidget(factoryId, widget, pinned);
    }
    public ensureCodeFileIcons(): void { this.codePart.ensureCodeFileIcons(); }
    public ensureCodeTerminal(): Promise<void> { return this.codePart.ensureCodeTerminal(); }
    public detachCodeWidgets(): void { this.codePart.detachCodeWidgets(); }
    public installCodeEditorSaveShortcut(): void { this.codePart.installCodeEditorSaveShortcut(); }
    public installCodeTerminalShortcut(): void { this.codePart.installCodeTerminalShortcut(); }
    public installCodeTabDropTarget(): void { this.codePart.installCodeTabDropTarget(); }
    public openCodeSettings(): Promise<void> { return this.codePart.openCodeSettings(); }
    public openCodeFile(rawUri: string): Promise<void> { return this.codePart.openCodeFile(rawUri); }
    public openCodeCitation(file: URI, startLine: number, endLine: number): Promise<void> {
        return this.codePart.openCodeCitation(file, startLine, endLine);
    }
    public disposeCodeResources(): void { this.codePart.disposeCodeResources(); }

    @postConstruct()
    protected init(): void {
        getDesignVariant();
        this.sessions = new SessionStore(this);
        this.settingsPart = new SettingsPart(this);
        this.customizePart = new CustomizePart(this);
        this.codePart = new CodePart(this);
        this.resultsPart = new ResultsPart(this);
        this.agentPart = new AgentPart(this);
        this.headerPart = new HeaderPart(this);
        this.railPart = new RailPart(this);
        this.id = AgentWindowWidget.ID;
        this.addClass('poiesis-agent-window');
        this.toDispose.push(Disposable.create(() => this.disposeAgentRichContent()));

        const closeSessionMenu = (event: PointerEvent): void => {
            if (this.state.openSessionMenuId && !(event.target as Element | null)?.closest('.poiesis-agent-window__session-actions')) {
                this.state.openSessionMenuId = undefined;
                this.update();
            }
            if (this.state.openResultsMenuKey && !(event.target as Element | null)?.closest('.poiesis-results__menu-host')) {
                this.state.openResultsMenuKey = undefined;
                this.update();
            }
            if (this.state.repositoryPickerVisible
                && !(event.target as Element | null)?.closest('.poiesis-agent-window__repository-picker, .poiesis-agent-window__context-pill.primary')) {
                this.state.repositoryPickerVisible = false;
                this.state.repositoryPickerAnchor = undefined;
                this.state.repositorySearchQuery = '';
                this.update();
            }
            if (this.state.workspacePickerVisible
                && !(event.target as Element | null)?.closest('.poiesis-agent-window__workspace-picker, .poiesis-agent-window__repository-open')) {
                this.state.workspacePickerVisible = false;
                this.state.workspacePickerAnchor = undefined;
                this.state.workspaceSearchQuery = '';
                this.update();
            }
            if (this.state.explorerMoreVisible
                && !(event.target as Element | null)?.closest('.poiesis-agent-window__code-explorer-more')) {
                this.state.explorerMoreVisible = false;
                this.update();
            }
        };
        document.addEventListener('pointerdown', closeSessionMenu);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('pointerdown', closeSessionMenu)));
        const closeOverlaysOnEscape = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') {
                return;
            }
            if (this.state.shortcutsOverlayVisible) {
                event.preventDefault();
                event.stopPropagation();
                this.closeShortcutsOverlay();
            } else if (this.state.folderExplorerVisible) {
                event.preventDefault();
                event.stopPropagation();
                if (this.state.creatingFolder) {
                    this.state.creatingFolder = false;
                    this.state.newFolderName = '';
                    this.update();
                } else {
                    this.closeFolderExplorer();
                }
            } else if (this.state.settingsModalVisible) {
                event.preventDefault();
                event.stopPropagation();
                this.closeSettings();
            } else if (document.querySelector('.poiesis-select__listbox')) {
                return;
            } else if (this.state.customizeViewVisible) {
                event.preventDefault();
                event.stopPropagation();
                this.handleCustomizeEscape();
            } else if (this.state.workspacePickerVisible || this.state.repositoryPickerVisible) {
                event.preventDefault();
                this.state.workspacePickerVisible = false;
                this.state.workspacePickerAnchor = undefined;
                this.state.repositoryPickerVisible = false;
                this.state.repositoryPickerAnchor = undefined;
                this.state.workspaceSearchQuery = '';
                this.state.repositorySearchQuery = '';
                this.update();
            } else if (this.state.explorerMoreVisible || this.state.openSessionMenuId) {
                event.preventDefault();
                this.state.explorerMoreVisible = false;
                this.state.openSessionMenuId = undefined;
                this.update();
            }
        };
        document.addEventListener('keydown', closeOverlaysOnEscape, true);
        this.toDispose.push(Disposable.create(() => document.removeEventListener('keydown', closeOverlaysOnEscape, true)));
        this.installWorkspaceSkillSaveShortcut();
        this.installCodeEditorSaveShortcut();
        this.installCodeTerminalShortcut();
        this.installCodeTabDropTarget();
        this.codePart.installCodeStatusListeners();
        const receiveResultsMessage = (event: MessageEvent): void => this.handleResultsFrameMessage(event);
        window.addEventListener('message', receiveResultsMessage);
        this.toDispose.push(Disposable.create(() => window.removeEventListener('message', receiveResultsMessage)));
        this.toDispose.push(this.fileService.onDidFilesChange(event => {
            if (!this.state.customizeViewVisible || !event.changes.some(change =>
                this.state.workspaceSkillWatchRoots.some((root: URI) => root.isEqualOrParent(change.resource, false)))) {
                return;
            }
            this.scheduleWorkspaceSkillsRefresh();
        }));
        this.toDispose.push(Disposable.create(() => this.disposeWorkspaceSkillWatchers()));

        this.toDispose.push(this.agentProvider.onEvent(event => this.handleAgentEvent(event)));
        this.toDispose.push(this.taskService.onDidChangeTask(event => this.sessions.handleTaskChange(event)));
        this.toDispose.push(this.taskService.onDidRecordSkillProposals(() => this.sessions.handleSkillProposalsChanged()));
        this.toDispose.push(this.resultsService.onDidChange(document => this.sessions.handleResultsDocumentChanged(document)));
        this.toDispose.push(this.requirementService.onDidChange(event => this.sessions.handleRequirementChange(event)));
        this.toDispose.push(this.requirementClassificationService.onDidClassify(task =>
            this.sessions.handleRequirementClassified(task)));
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => {
            void this.refreshRecentWorkspaces();
            if (this.state.customizeViewVisible) {
                void this.refreshWorkspaceSkills();
            }
            this.update();
        }));
        this.toDispose.push(this.workspaceService.onWorkspaceLocationChanged(() => {
            void this.refreshRecentWorkspaces();
            if (this.state.customizeViewVisible) {
                void this.refreshWorkspaceSkills();
            }
            this.update();
        }));
        this.toDispose.push(this.scmService.onDidAddRepository(repository => {
            this.sessions.watchScmProvider(repository.provider);
            this.update();
        }));
        this.toDispose.push(this.scmService.onDidRemoveRepository(() => this.update()));
        this.toDispose.push(this.scmService.onDidChangeSelectedRepository(() => this.update()));
        this.toDispose.push(this.scmService.onDidChangeStatusBarCommands(() => this.update()));
        for (const repository of this.scmService.repositories) {
            this.sessions.watchScmProvider(repository.provider);
        }

        this.sessions.sessionsInitialization = this.restorePoiesisSettings()
            .then(async () => {
                void this.refreshCliDetection();
                await this.sessions.initializeSessions();
            }).catch((error: unknown) => {
            console.error('[Poiesis] Could not initialize Agent Window sessions.', error);
        }).finally(() => {
            this.sessions.sessionsInitialized = true;
            this.update();
        });
        void this.refreshRecentWorkspaces();
        this.update();
    }

    protected render(): React.ReactNode {
        if (!this.sessions.sessionsInitialized) {
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
        const session = this.sessions.selectedSession();
        const activeTab = session?.activeTab ?? 'agent';
        const runningTask = this.sessions.runningTask(session);
        return (
            <div
                className='poiesis-agent-window__content'
                data-mode={this.state.codeMode ? 'code' : this.state.customizeViewVisible ? 'customize' : activeTab}
                data-rail-collapsed={this.state.railCollapsed ? 'true' : 'false'}
                style={{
                    '--poiesis-rail-width': `${this.state.railWidth}px`,
                    '--poiesis-ui-font-scale': this.uiFontScaleValue()
                } as React.CSSProperties}
            >
                {!this.state.codeMode && this.renderRail()}
                <main className='poiesis-agent-window__workspace'>
                    {this.renderHeader()}
                    <div className='poiesis-agent-window__viewport'>
                        {this.state.codeMode
                            ? this.renderCode()
                            : this.state.customizeViewVisible
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
                {this.state.workspacePickerVisible && this.state.workspacePickerAnchor && this.renderWorkspacePicker()}
                {this.state.repositoryPickerVisible && this.state.repositoryPickerAnchor && session && this.renderRepositoryPicker(session)}
                {this.state.folderExplorerVisible && this.renderFolderExplorer()}
                {this.state.settingsModalVisible && this.renderSettingsModal()}
                {this.state.shortcutsOverlayVisible && this.renderShortcutsOverlay()}
            </div>
        );
    }

    protected onBeforeDetach(message: Message): void {
        this.disposeRailResize();
        this.disposeCodeResources();
        super.onBeforeDetach(message);
    }

    public toggleCodeMode(): void {
        if (this.state.codeMode) {
            this.detachCodeWidgets();
            this.state.codeMode = false;
        } else {
            this.closeCustomize(false);
            this.ensureCodeFileIcons();
            this.state.codeMode = true;
            requestAnimationFrame(() => void this.ensureCodeTerminal());
        }
        this.update();
    }

    public selectTab(tab: AgentWindowTab): void {
        const session = this.sessions.selectedSession();
        if (session) {
            session.activeTab = tab;
            if (tab === 'results' && !this.sessions.resultsRequirements(session)
                .some(requirement => requirement.id === session.selectedResultsRequirementId)) {
                session.selectedResultsRequirementId = this.sessions.latestRequirement(session)?.id;
                session.selectedResultsTaskId = undefined;
                this.sessions.persistResultsQaPanelState();
            }
            this.sessions.persistWindowState();
        }
        this.update();
    }

    public async newChat(): Promise<void> {
        await this.sessions.sessionsInitialization;
        this.closeCustomize(false);
        this.detachCodeWidgets();
        this.state.codeMode = false;
        this.state.sessionSearchVisible = false;
        this.state.sessionSearchQuery = '';
        this.state.repositoryPickerVisible = false;
        this.state.repositoryPickerAnchor = undefined;
        this.state.repositorySearchQuery = '';
        const current = this.sessions.selectedSession();
        if (current && !current.archived && !current.hasUserMessage) {
            current.activeTab = 'agent';
            this.sessions.persistWindowState();
            this.update();
            requestAnimationFrame(() => this.focusAgentComposer());
            return;
        }
        const creation = this.sessions.createSession();
        requestAnimationFrame(() => this.focusAgentComposer());
        await creation;
        requestAnimationFrame(() => this.focusAgentComposer());
    }
}
