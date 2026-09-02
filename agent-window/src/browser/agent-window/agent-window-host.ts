import type * as React from '@theia/core/shared/react';
import type { OpenerService, SaveableService, StorageService, WidgetManager } from '@theia/core/lib/browser';
import type { IconThemeService } from '@theia/core/lib/browser/icon-theme-service';
import type { CommandService, Disposable, MessageService } from '@theia/core/lib/common';
import type URI from '@theia/core/lib/common/uri';
import type { Widget } from '@theia/core/shared/@lumino/widgets';
import type { EditorManager } from '@theia/editor/lib/browser';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { ScmService } from '@theia/scm/lib/browser/scm-service';
import type { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import type { VSXExtensionsSearchModel } from '@theia/vsx-registry/lib/browser/vsx-extensions-search-model';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import type { AgentActivity, AgentEvent, AgentProvider } from '../../common/agent-provider';
import type { AgentRuntimeServer, AiRole, CliDetectionReport, KnownCliId } from '../../common/agent-runtime-protocol';
import type { FolderExplorerService } from '../folder-explorer-service';
import type { GlobalStorageService } from '../global-storage-service';
import type { RequirementClassificationService } from '../requirement-classification-service';
import type { RequirementService } from '../requirement-service';
import type { ResultsGenerationContext } from '../results-generation-context';
import type { ResultsQuestionService } from '../results-question-service';
import type { ResultsService } from '../results-skill';
import type { ExecutionTask, TaskService } from '../task-service';
import type { WorkspaceSkillService } from '../workspace-skill-service';
import type { AgentWindowTab, SessionStore, WindowAgentSession } from './session-store';

export type UiFontScale = 'small' | 'standard' | 'large';

export interface AgentWindowPickerAnchor {
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
}

/** Mutable UI state shared by the widget and more than one composed part. */
export interface AgentWindowState {
    codeMode: boolean;
    customizeViewVisible: boolean;
    settingsModalVisible: boolean;
    shortcutsOverlayVisible: boolean;
    uiFontScale: UiFontScale;
    agentCli: KnownCliId;
    agentModel: string;
    resultsCli: KnownCliId;
    resultsModel: string;
    allowExternalResultsResources: boolean;
    automaticRequirementClassification: boolean;
    cliDetectionReport?: CliDetectionReport;
    deleteSessionConfirmationId?: string;
    railCollapsed: boolean;
    railWidth: number;
    openSessionMenuId?: string;
    renamingSessionId?: string;
    sessionSearchVisible: boolean;
    sessionSearchQuery: string;
    readonly expandedWorkspaceGroups: Set<string>;
    workspacePickerVisible: boolean;
    workspacePickerAnchor?: AgentWindowPickerAnchor;
    workspaceSearchQuery: string;
    repositoryPickerVisible: boolean;
    repositoryPickerAnchor?: AgentWindowPickerAnchor;
    repositorySearchQuery: string;
    folderExplorerVisible: boolean;
    creatingFolder: boolean;
    newFolderName: string;
    resultsTaskRailCollapsed: boolean;
    openResultsMenuKey?: string;
    resultsSkillNamesLoaded: boolean;
    explorerMoreVisible: boolean;
    workspaceSkillWatchRoots: URI[];
    readonly providerPreparationErrors: Map<string, string>;
}

/**
 * Typed boundary shared by the composed Agent Window parts. Parts never import
 * or retain references to one another; cross-part work is routed through here.
 */
export interface AgentWindowHost {
    readonly node: HTMLElement;
    readonly isDisposed: boolean;
    readonly state: AgentWindowState;
    readonly sessions: SessionStore;
    readonly agentProvider: AgentProvider;
    readonly taskService: TaskService;
    readonly resultsService: ResultsService;
    readonly requirementService: RequirementService;
    readonly requirementClassificationService: RequirementClassificationService;
    readonly workspaceService: WorkspaceService;
    readonly scmService: ScmService;
    readonly terminalService: TerminalService;
    readonly widgetManager: WidgetManager;
    readonly editorManager: EditorManager;
    readonly openerService: OpenerService;
    readonly fileService: FileService;
    readonly commandService: CommandService;
    readonly saveableService: SaveableService;
    readonly iconThemeService: IconThemeService;
    readonly extensionsSearchModel: VSXExtensionsSearchModel;
    readonly storageService: StorageService;
    readonly globalStorageService: GlobalStorageService;
    readonly folderExplorerService: FolderExplorerService;
    readonly agentRuntimeServer: AgentRuntimeServer;
    readonly resultsQuestionService: ResultsQuestionService;
    readonly resultsGenerationContext: ResultsGenerationContext;
    readonly workspaceSkillService: WorkspaceSkillService;
    readonly messageService: MessageService;

    // Widget-owned composition operations.
    update(): void;
    addDisposable(disposable: Disposable): void;
    toggleCodeMode(): void;
    selectTab(tab: AgentWindowTab): void;
    newChat(): Promise<void>;

    // HeaderPart-owned operations.
    renderHeader(): React.ReactNode;

    // SettingsPart-owned operations.
    renderSettingsModal(): React.ReactNode;
    renderShortcutsOverlay(): React.ReactNode;
    renderAiRolePill(role: AiRole, compact?: boolean): React.ReactNode;
    openSettings(): void;
    closeSettings(): void;
    openShortcutsOverlay(): void;
    closeShortcutsOverlay(): void;
    uiFontScaleValue(): number;
    refreshCliDetection(): Promise<void>;
    restorePoiesisSettings(): Promise<void>;

    // RailPart-owned operations.
    renderRail(): React.ReactNode;
    renderWorkspacePicker(): React.ReactNode;
    renderRepositoryPicker(session: WindowAgentSession): React.ReactNode;
    renderFolderExplorer(): React.ReactNode;
    refreshRecentWorkspaces(): Promise<void>;
    closeFolderExplorer(): void;
    repositoryLabel(workspaceUri: string | undefined): string;
    toggleRepositoryPicker(anchor: HTMLElement): void;
    sessionMeta(session: WindowAgentSession): string;
    beginDeleteSession(sessionId: string): void;
    cancelDeleteSession(): void;
    deleteSession(sessionId: string): Promise<void>;
    canonicalWorkspaceUri(workspaceUri: string | undefined): string | undefined;
    sameWorkspaceUri(left: string | undefined, right: string | undefined): boolean;
    workspaceGroupKey(workspaceUri: string | undefined): string;
    filteredSessions(archived: boolean): WindowAgentSession[];
    clampRailWidth(width: number): number;
    disposeRailResize(): void;

    // AgentPart-owned operations.
    renderAgent(session: WindowAgentSession | undefined, runningTask?: ExecutionTask): React.ReactNode;
    renderMarkdown(content: string, workspaceImageSources?: ReadonlyMap<string, string>, explicitWorkspaceUri?: string): React.ReactNode;
    sendAgentMessage(): Promise<void>;
    handleAgentEvent(event: AgentEvent): void;
    restoreAgentActivities(value: unknown): AgentActivity[] | undefined;
    disposeAgentRichContentForSession(sessionId: string): void;
    disposeAgentRichContent(): void;
    focusAgentComposer(): void;

    // ResultsPart-owned operations.
    renderResults(session: WindowAgentSession | undefined): React.ReactNode;
    handleResultsFrameMessage(event: MessageEvent): void;
    openResultsCitation(rawCitation: string): Promise<void>;
    selectResultsTask(taskId: string): void;
    selectResultsRequirement(requirementId: string): void;
    undoAutomaticRequirementSplit(taskId: string): void;
    retryTask(taskId: string): Promise<void>;
    ensureResultsSkillNames(): Promise<void>;

    // CustomizePart-owned operations.
    renderCustomizeView(): React.ReactNode;
    openCustomize(): void;
    closeCustomize(update?: boolean): void;
    handleCustomizeEscape(): void;
    installWorkspaceSkillSaveShortcut(): void;
    scheduleWorkspaceSkillsRefresh(): void;
    disposeWorkspaceSkillWatchers(): void;
    refreshWorkspaceSkills(): Promise<void>;

    // CodePart-owned operations.
    renderCode(): React.ReactNode;
    registerCodeWidget(factoryId: string, widget: Widget, pinned?: boolean): void;
    ensureCodeFileIcons(): void;
    ensureCodeTerminal(): Promise<void>;
    detachCodeWidgets(): void;
    installCodeEditorSaveShortcut(): void;
    installCodeTerminalShortcut(): void;
    installCodeTabDropTarget(): void;
    openCodeSettings(): Promise<void>;
    openCodeFile(rawUri: string): Promise<void>;
    openCodeCitation(file: URI, startLine: number, endLine: number): Promise<void>;
    disposeCodeResources(): void;
}

export abstract class AgentWindowPartBase {
    protected get node(): HTMLElement { return this.host.node; }
    protected get agentProvider(): AgentProvider { return this.host.agentProvider; }
    protected get taskService(): TaskService { return this.host.taskService; }
    protected get resultsService(): ResultsService { return this.host.resultsService; }
    protected get requirementService(): RequirementService { return this.host.requirementService; }
    protected get requirementClassificationService(): RequirementClassificationService {
        return this.host.requirementClassificationService;
    }
    protected get workspaceService(): WorkspaceService { return this.host.workspaceService; }
    protected get scmService(): ScmService { return this.host.scmService; }
    protected get terminalService(): TerminalService { return this.host.terminalService; }
    protected get widgetManager(): WidgetManager { return this.host.widgetManager; }
    protected get editorManager(): EditorManager { return this.host.editorManager; }
    protected get openerService(): OpenerService { return this.host.openerService; }
    protected get fileService(): FileService { return this.host.fileService; }
    protected get commandService(): CommandService { return this.host.commandService; }
    protected get saveableService(): SaveableService { return this.host.saveableService; }
    protected get iconThemeService(): IconThemeService { return this.host.iconThemeService; }
    protected get extensionsSearchModel(): VSXExtensionsSearchModel { return this.host.extensionsSearchModel; }
    protected get storageService(): StorageService { return this.host.storageService; }
    protected get globalStorageService(): GlobalStorageService { return this.host.globalStorageService; }
    protected get folderExplorerService(): FolderExplorerService { return this.host.folderExplorerService; }
    protected get agentRuntimeServer(): AgentRuntimeServer { return this.host.agentRuntimeServer; }
    protected get resultsQuestionService(): ResultsQuestionService { return this.host.resultsQuestionService; }
    protected get resultsGenerationContext(): ResultsGenerationContext { return this.host.resultsGenerationContext; }
    protected get workspaceSkillService(): WorkspaceSkillService { return this.host.workspaceSkillService; }
    protected get messageService(): MessageService { return this.host.messageService; }

    protected update(): void {
        this.host.update();
    }

    protected constructor(protected readonly host: AgentWindowHost) { }
}

export abstract class AgentWindowPart extends AgentWindowPartBase { }
