import type { OpenerService, SaveableService, StorageService, WidgetManager } from '@theia/core/lib/browser';
import type { IconThemeService } from '@theia/core/lib/browser/icon-theme-service';
import type { CommandService, DisposableCollection, MessageService } from '@theia/core/lib/common';
import type { EditorManager } from '@theia/editor/lib/browser';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { ScmService } from '@theia/scm/lib/browser/scm-service';
import type { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import type { VSXExtensionsSearchModel } from '@theia/vsx-registry/lib/browser/vsx-extensions-search-model';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import type { AgentProvider } from '../../common/agent-provider';
import type { AgentRuntimeServer } from '../../common/agent-runtime-protocol';
import type { FolderExplorerService } from '../folder-explorer-service';
import type { GlobalStorageService } from '../global-storage-service';
import type { RequirementClassificationService } from '../requirement-classification-service';
import type { RequirementService } from '../requirement-service';
import type { ResultsGenerationContext } from '../results-generation-context';
import type { ResultsQuestionService } from '../results-question-service';
import type { ResultsService } from '../results-skill';
import type { TaskService } from '../task-service';
import type { WorkspaceSkillService } from '../workspace-skill-service';
import type { SessionStore } from './session-store';

/**
 * The deliberately small boundary shared by the composed Agent Window parts.
 * Services and cross-part operations are resolved by the widget so parts never
 * import or retain references to one another.
 */
export interface AgentWindowHost {
    readonly node: HTMLElement;
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
    update(): void;
    resolveAgentWindowMember(name: PropertyKey): unknown;
    assignAgentWindowMember(name: PropertyKey, value: unknown): boolean;
}

export abstract class AgentWindowPartBase {
    [name: string]: any;

    protected get node(): HTMLElement { return this.host.node; }
    protected get toDispose(): DisposableCollection {
        return this.host.resolveAgentWindowMember('toDispose') as DisposableCollection;
    }
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

    protected constructor(protected readonly host: AgentWindowHost) {
        return new Proxy(this, {
            get: (target, name, receiver) => {
                if (name in target) {
                    return Reflect.get(target, name, receiver);
                }
                return host.resolveAgentWindowMember(name);
            },
            set: (target, name, value, receiver) => {
                if (name in target) {
                    return Reflect.set(target, name, value, receiver);
                }
                return host.assignAgentWindowMember(name, value);
            }
        });
    }
}

export abstract class AgentWindowPart extends AgentWindowPartBase {
    declare protected readonly sessions: SessionStore['sessions'];
    declare protected selectedSessionId: SessionStore['selectedSessionId'];
    declare protected readonly selectedSession: SessionStore['selectedSession'];
    declare protected readonly findSessionByAgentId: SessionStore['findSessionByAgentId'];
    declare protected readonly findSessionForTask: SessionStore['findSessionForTask'];
    declare protected readonly selectSession: SessionStore['selectSession'];
    declare protected readonly workspaceRoot: SessionStore['workspaceRoot'];
    declare protected readonly workspaceFolderName: SessionStore['workspaceFolderName'];
    declare protected readonly workspaceContextLabel: SessionStore['workspaceContextLabel'];
    declare protected readonly gitBranchForWorkspace: SessionStore['gitBranchForWorkspace'];
    declare protected readonly currentGitBranch: SessionStore['currentGitBranch'];
    declare protected readonly createSession: SessionStore['createSession'];
    declare protected readonly ensureProviderSession: SessionStore['ensureProviderSession'];
    declare protected readonly persistResultsQaPanelState: SessionStore['persistResultsQaPanelState'];
    declare protected readonly persistWindowState: SessionStore['persistWindowState'];
    declare protected readonly requirementsForSession: SessionStore['requirementsForSession'];
    declare protected readonly resultsRequirements: SessionStore['resultsRequirements'];
    declare protected readonly latestTaskForRequirement: SessionStore['latestTaskForRequirement'];
    declare protected readonly latestRequirement: SessionStore['latestRequirement'];
    declare protected readonly finishedTasksForRequirement: SessionStore['finishedTasksForRequirement'];
    declare protected readonly fallbackRequirementChangeSet: SessionStore['fallbackRequirementChangeSet'];
    declare protected readonly selectedResultsScopeKey: SessionStore['selectedResultsScopeKey'];
    declare protected readonly runningTask: SessionStore['runningTask'];
    declare protected readonly finishedTasks: SessionStore['finishedTasks'];
    declare protected readonly isResultsTask: SessionStore['isResultsTask'];
    declare protected readonly taskFinishedTime: SessionStore['taskFinishedTime'];
    declare protected readonly taskStatusLabel: SessionStore['taskStatusLabel'];
}
