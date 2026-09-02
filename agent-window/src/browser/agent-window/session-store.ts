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
    TaskEvent,
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
import { RequirementChangeEvent, RequirementService } from '../requirement-service';
import { RequirementClassificationService } from '../requirement-classification-service';
import { PoiesisSelect, PoiesisSelectOption } from '../components/poiesis-select';
import { PoiesisTextArea, PoiesisTextInput } from '../components/poiesis-inputs';
import { PoiesisComposer } from '../components/poiesis-composer';
import { PoiesisResultsElapsed, PoiesisTaskElapsed } from '../components/elapsed';
import { AgentWindowHost, AgentWindowPartBase } from './agent-window-host';

export type AgentWindowTab = 'agent' | 'results';

export const NEW_SESSION_TITLE = '新しい会話';

export const SESSION_STORAGE_KEY = 'poiesis.agent-window.sessions.v1';

export const GLOBAL_SESSION_STORAGE_KEY = 'poiesis.agent-window.sessions.global.v1';

export const SESSION_MIGRATION_MARKER_KEY = 'poiesis.agent-window.sessions.migrated.v1';

export const RESULTS_QA_PANEL_STORAGE_KEY = 'poiesis.results-qa-panel.sessions.v1';

export const MAX_PERSISTED_TASKS_PER_SESSION = 10;

export const MAX_PERSISTED_RESULTS_HTML_CHARS = 300_000;

export const DEFAULT_RAIL_WIDTH = 258;

export interface ChatMessage {
    id: string;
    role: 'user' | 'agent';
    content: string;
    complete: boolean;
    taskId?: string;
    error?: boolean;
    errorDetails?: string;
    activities?: AgentActivity[];
}

export interface ResultsNotice {
    question: string;
    status: 'sending' | 'answered' | 'failed';
    text: string;
    historyTimestamp?: string;
}

export interface WindowAgentSession {
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
    requirementDraft?: string | 'new';
    requirementDraftExplicit?: boolean;
    selectedResultsRequirementId?: string;
    selectedResultsTaskId?: string;
    readonly resultsDrafts: Map<string, string>;
    readonly resultsNotices: Map<string, ResultsNotice>;
    readonly resultsQaExpanded: Map<string, boolean>;
}

export interface PersistedAgentWindowState {
    version: 1;
    selectedSessionId?: string;
    railWidth: number;
    railCollapsed: boolean;
    sessions: Array<Omit<WindowAgentSession, 'agentSession' | 'taskIds' | 'resultsDrafts' | 'resultsNotices' | 'resultsQaExpanded'> & {
        resultsDrafts: Array<[string, string]>;
        tasks?: ExecutionTask[];
        resultsDocuments?: TaskResultDocument[];
    }>;
}

export interface PersistedResultsQaPanelState {
    version: 1;
    taskRailCollapsed?: boolean;
    sessions: Record<string, {
        selectedRequirementId?: string;
        selectedTaskId?: string;
        expandedTaskIds: string[];
    }>;
}

export class SessionStore extends AgentWindowPartBase {
    public readonly sessions: WindowAgentSession[] = [];

    public sessionsInitialized = false;

    public sessionsInitialization: Promise<void> = Promise.resolve();

    public windowStatePersistence: Promise<void> = Promise.resolve();

    public resultsQaPanelStatePersistence: Promise<void> = Promise.resolve();

    public resultsTaskRailCollapsed = false;

    public legacyErrorMessagesMigrated = false;

    public selectedSessionId?: string;

    public sessionSequence = 0;

    public readonly watchedScmProviders = new WeakSet<ScmProvider>();

    public readonly watchedScmHistoryProviders = new WeakSet<ScmHistoryProvider>();

    public selectedSession(): WindowAgentSession | undefined {
        return this.sessions.find(session => session.id === this.selectedSessionId);
    }

    public findSessionByAgentId(sessionId: string): WindowAgentSession | undefined {
        return this.sessions.find(session => session.agentSession?.id === sessionId);
    }

    public findSessionForTask(task: ExecutionTask): WindowAgentSession | undefined {
        return this.sessions.find(session => session.id === task.sessionId)
            ?? this.findSessionByAgentId(task.sessionId);
    }

    public selectSession(sessionId: string): void {
        const session = this.sessions.find(candidate => candidate.id === sessionId && !candidate.archived);
        if (!session) {
            return;
        }
        this.closeCustomize(false);
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

    public workspaceRoot() {
        return this.workspaceService.tryGetRoots()[0]
            ?? (this.workspaceService.workspace?.isDirectory ? this.workspaceService.workspace : undefined);
    }

    public workspaceFolderName(): string {
        return this.workspaceRoot()?.resource.path.base || 'ワークスペースなし';
    }

    public workspaceContextLabel(session = this.selectedSession()): string {
        const workspace = session?.workspaceUri ? this.repositoryLabel(session.workspaceUri) : this.workspaceFolderName();
        const branch = session?.branch ?? this.gitBranchForWorkspace(session?.workspaceUri) ?? this.currentGitBranch();
        return branch ? `${workspace} / ${branch}` : workspace;
    }

    public gitBranchForWorkspace(workspaceUri: string | undefined): string | undefined {
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

    public currentGitBranch(): string | undefined {
        const root = this.workspaceRoot();
        return this.gitBranchForWorkspace(root?.resource.toString());
    }

    public watchScmProvider(provider: ScmProvider): void {
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

    public watchScmHistoryProvider(historyProvider: ScmHistoryProvider | undefined): void {
        if (!historyProvider || this.watchedScmHistoryProviders.has(historyProvider)) {
            return;
        }
        this.watchedScmHistoryProviders.add(historyProvider);
        this.toDispose.push(historyProvider.onDidChangeCurrentHistoryItemRefs(() => this.update()));
    }

    public async createSession(): Promise<void> {
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
            requirementDraftExplicit: false,
            resultsDrafts: new Map<string, string>(),
            resultsNotices: new Map<string, ResultsNotice>(),
            resultsQaExpanded: new Map<string, boolean>()
        };
        this.sessions.push(session);
        this.selectedSessionId = session.id;
        this.openSessionMenuId = undefined;
        this.persistWindowState();
        this.persistResultsQaPanelState();
        this.update();
    }

    public async ensureProviderSession(
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

    public async restoreWindowState(): Promise<boolean> {
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
                const resultsTaskIds = new Set(restoredTasks
                    .filter(task => this.isResultsTask(task))
                    .map(task => task.id));
                const embeddedResultsDocuments = restoredTasks.flatMap(task =>
                    task.resultsDocument ? [task.resultsDocument] : []
                );
                this.resultsService.restore(
                    [
                        ...(Array.isArray(candidate.resultsDocuments) ? candidate.resultsDocuments : []),
                        ...embeddedResultsDocuments
                    ],
                    resultsTaskIds
                );
                const taskById = new Map(restoredTasks.map(task => [task.id, task]));
                const restoredMessages = (Array.isArray(candidate.messages) ? candidate.messages.filter(message =>
                    message && typeof message.id === 'string'
                    && (message.role === 'user' || message.role === 'agent')
                    && typeof message.content === 'string'
                ).map(message => this.migrateLegacyCliErrorMessage({
                    ...message,
                    complete: Boolean(message.complete),
                    activities: this.restoreAgentActivities(message.activities)
                })) : []).map(message => {
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
                    requirementDraft: candidate.requirementDraft === 'new' || typeof candidate.requirementDraft === 'string'
                        ? candidate.requirementDraft
                        : undefined,
                    requirementDraftExplicit: candidate.requirementDraftExplicit === true,
                    selectedResultsRequirementId: typeof candidate.selectedResultsRequirementId === 'string'
                        ? candidate.selectedResultsRequirementId
                        : undefined,
                    selectedResultsTaskId: typeof candidate.selectedResultsTaskId === 'string'
                        && resultsTaskIds.has(candidate.selectedResultsTaskId)
                        ? candidate.selectedResultsTaskId
                        : undefined,
                    resultsDrafts: new Map(Array.isArray(candidate.resultsDrafts) ? candidate.resultsDrafts : []),
                    resultsNotices: new Map<string, ResultsNotice>(),
                    resultsQaExpanded: new Map<string, boolean>()
                };
                return [restored];
            }));
            await this.requirementService.restore(this.taskService.list());
            for (const session of this.sessions) {
                const selectedTask = session.selectedResultsTaskId
                    ? this.taskService.get(session.selectedResultsTaskId)
                    : undefined;
                const availableIds = new Set(this.requirementsForSession(session).map(requirement => requirement.id));
                session.selectedResultsRequirementId = selectedTask?.requirementId
                    ?? (session.selectedResultsRequirementId && availableIds.has(session.selectedResultsRequirementId)
                        ? session.selectedResultsRequirementId
                        : this.latestRequirement(session)?.id);
                if (session.requirementDraft !== 'new'
                    && session.requirementDraft
                    && !availableIds.has(session.requirementDraft)) {
                    session.requirementDraft = undefined;
                }
            }
            await this.resultsService.restoreRequirements();
            this.selectedSessionId = typeof state.selectedSessionId === 'string' ? state.selectedSessionId : undefined;
            this.railWidth = this.clampRailWidth(Number(state.railWidth) || DEFAULT_RAIL_WIDTH);
            this.railCollapsed = Boolean(state.railCollapsed);
            this.sessionSequence = this.sessions.length;
            if (this.legacyErrorMessagesMigrated) {
                await this.persistWindowState();
            }
            return this.sessions.length > 0;
        } catch (error) {
            console.warn('[Poiesis] Could not restore Agent Window sessions.', error);
            return false;
        }
    }

    public migrateLegacyCliErrorMessage(message: ChatMessage): ChatMessage {
        if (message.role !== 'agent' || message.error || !message.complete) {
            return message;
        }
        const content = message.content.trim();
        const hasRawCliEvidence = /(?:^|\n)\s*(?:error|usage):|\b(?:codex|claude|grok|gemini)\b[^\n]{0,160}(?:exited with code|終了コード)|(?:unknown|unexpected|invalid)\s+(?:argument|option)/i.test(content);
        const hasExplicitFailure = /実行に失敗しました。?\s*$/u.test(content)
            || /(?:^|\n)\s*usage:\s*\S+/im.test(content)
            || /\b(?:codex|claude|grok|gemini)\b[^\n]{0,160}(?:exited with code|終了コード)/i.test(content);
        if (!hasRawCliEvidence || !hasExplicitFailure) {
            return message;
        }
        this.legacyErrorMessagesMigrated = true;
        const optionFailure = /(?:argument|option)|--[a-z][\w-]*/i.test(content);
        return {
            ...message,
            content: optionFailure
                ? 'Agent CLI の起動オプションに問題があり、実行に失敗しました。'
                : 'Agent CLI が異常終了し、実行に失敗しました。',
            error: true,
            errorDetails: content
        };
    }

    public async loadGlobalWindowState(): Promise<Partial<PersistedAgentWindowState> | undefined> {
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

    public mergePersistedWindowStates(
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

    public async restoreResultsQaPanelState(): Promise<void> {
        try {
            const state = await this.storageService.getData<Partial<PersistedResultsQaPanelState>>(
                RESULTS_QA_PANEL_STORAGE_KEY,
                {}
            );
            if (state?.version !== 1 || !state.sessions || typeof state.sessions !== 'object') {
                return;
            }
            this.resultsTaskRailCollapsed = state.taskRailCollapsed === true;
            for (const session of this.sessions) {
                const persisted = state.sessions[session.id];
                if (!persisted) {
                    continue;
                }
                const resultsTaskIds = new Set(this.finishedTasks(session).map(task => task.id));
                const requirementIds = new Set(this.resultsRequirements(session).map(requirement => requirement.id));
                const validScopeKeys = new Set([
                    ...resultsTaskIds,
                    ...[...requirementIds].map(requirementId => `requirement:${requirementId}`)
                ]);
                if (typeof persisted.selectedRequirementId === 'string'
                    && requirementIds.has(persisted.selectedRequirementId)) {
                    session.selectedResultsRequirementId = persisted.selectedRequirementId;
                }
                if (typeof persisted.selectedTaskId === 'string' && resultsTaskIds.has(persisted.selectedTaskId)) {
                    session.selectedResultsTaskId = persisted.selectedTaskId;
                    session.selectedResultsRequirementId = this.taskService.get(persisted.selectedTaskId)?.requirementId;
                }
                session.resultsQaExpanded.clear();
                if (Array.isArray(persisted.expandedTaskIds)) {
                    for (const scopeKey of persisted.expandedTaskIds) {
                        if (typeof scopeKey === 'string' && validScopeKeys.has(scopeKey)) {
                            session.resultsQaExpanded.set(scopeKey, true);
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('[Poiesis] Could not restore Results Q&A panel state.', error);
        }
    }

    public persistResultsQaPanelState(): Promise<void> {
        try {
            const state: PersistedResultsQaPanelState = {
                version: 1,
                taskRailCollapsed: this.resultsTaskRailCollapsed,
                sessions: Object.fromEntries(this.sessions.map(session => {
                    const resultsTaskIds = new Set(this.finishedTasks(session).map(task => task.id));
                    const validScopeKeys = new Set([
                        ...resultsTaskIds,
                        ...this.resultsRequirements(session).map(requirement => `requirement:${requirement.id}`)
                    ]);
                    return [session.id, {
                        selectedRequirementId: session.selectedResultsRequirementId,
                        selectedTaskId: session.selectedResultsTaskId && resultsTaskIds.has(session.selectedResultsTaskId)
                            ? session.selectedResultsTaskId
                            : undefined,
                        expandedTaskIds: [...session.resultsQaExpanded]
                            .filter(([scopeKey, expanded]) => expanded && validScopeKeys.has(scopeKey))
                            .map(([scopeKey]) => scopeKey)
                    }];
                }))
            };
            this.resultsQaPanelStatePersistence = this.resultsQaPanelStatePersistence
                .catch(() => undefined)
                .then(() => this.storageService.setData(RESULTS_QA_PANEL_STORAGE_KEY, state))
                .catch(error => {
                    console.warn('[Poiesis] Could not persist Results Q&A panel state.', error);
                });
        } catch (error) {
            console.warn('[Poiesis] Could not persist Results Q&A panel state.', error);
        }
        return this.resultsQaPanelStatePersistence;
    }

    public persistWindowState(): Promise<void> {
        try {
            const state: PersistedAgentWindowState = {
                version: 1,
                selectedSessionId: this.selectedSessionId,
                railWidth: this.railWidth,
                railCollapsed: this.railCollapsed,
                sessions: this.sessions.map(session => {
                    const tasks = this.persistedTasks(session);
                    const {
                        agentSession: _agentSession,
                        taskIds: _taskIds,
                        resultsDrafts,
                        resultsNotices: _resultsNotices,
                        resultsQaExpanded: _resultsQaExpanded,
                        ...persisted
                    } = session;
                    return {
                        ...persisted,
                        resultsDrafts: [...resultsDrafts.entries()],
                        tasks
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

    public titleForSession(message: string): string {
        return taskTitleForRequest(message);
    }

    public requirementsForSession(session: WindowAgentSession | undefined): Requirement[] {
        if (!session) {
            return [];
        }
        return this.requirementService.listForSession(session.id).sort((left, right) => {
            const leftTime = this.latestTaskForRequirement(left)?.startedAt ?? left.updatedAt;
            const rightTime = this.latestTaskForRequirement(right)?.startedAt ?? right.updatedAt;
            return rightTime.localeCompare(leftTime);
        });
    }

    public resultsRequirements(session: WindowAgentSession | undefined): Requirement[] {
        return this.requirementsForSession(session).filter(requirement => requirement.taskIds
            .some(taskId => {
                const task = this.taskService.get(taskId);
                return task && task.status !== 'running';
            }));
    }

    public latestTaskForRequirement(requirement: Requirement): ExecutionTask | undefined {
        return requirement.taskIds.map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => Boolean(task))
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
            .at(-1);
    }

    public latestRequirement(session: WindowAgentSession | undefined): Requirement | undefined {
        return this.resultsRequirements(session)[0];
    }

    public finishedTasksForRequirement(requirement: Requirement): ExecutionTask[] {
        return requirement.taskIds.map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => Boolean(task && task.status !== 'running'))
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    }

    public fallbackRequirementChangeSet(requirement: Requirement): TaskChangeSet {
        const tasks = this.finishedTasksForRequirement(requirement);
        const files = [...new Set(tasks.flatMap(task => task.changeSet?.files ?? []))].sort();
        const diff = tasks.map(task => task.changeSet?.diff ?? '').filter(Boolean).join('\n');
        return {
            source: diff ? 'task-diff' : 'empty',
            diff,
            files,
            capturedAt: tasks.at(-1)?.changeSet?.capturedAt ?? new Date().toISOString()
        };
    }

    public selectedResultsScopeKey(session: WindowAgentSession | undefined): string | undefined {
        if (!session?.selectedResultsRequirementId) {
            return undefined;
        }
        return session.selectedResultsTaskId
            ?? `requirement:${session.selectedResultsRequirementId}`;
    }

    public persistedTasks(session: WindowAgentSession): ExecutionTask[] {
        return session.taskIds
            .map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => Boolean(task))
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
            .slice(-MAX_PERSISTED_TASKS_PER_SESSION)
            .map(task => {
                const persistedTask: ExecutionTask = task.status === 'running' ? {
                    ...task,
                    status: 'failed',
                    endedAt: new Date().toISOString(),
                    failure: { summary: 'アプリ終了により中断されました' }
                } : task;
                return persistedTask.resultsDocument ? {
                    ...persistedTask,
                    resultsDocument: {
                        ...persistedTask.resultsDocument,
                        html: persistedTask.resultsDocument.html?.slice(0, MAX_PERSISTED_RESULTS_HTML_CHARS)
                    }
                } : persistedTask;
            });
    }

    public async initializeSessions(): Promise<void> {
        await this.workspaceService.roots;
        const restored = await this.restoreWindowState();
        await this.restoreResultsQaPanelState();
        const currentWorkspaceKey = this.workspaceGroupKey(this.workspaceRoot()?.resource.toString());
        this.expandedWorkspaceGroups.add(currentWorkspaceKey);
        if (!restored) {
            await this.requirementService.restore(this.taskService.list());
            await this.createSession();
            return;
        }
        const activeSessions: WindowAgentSession[] = this.filteredSessions(false);
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

    public runningTask(session = this.selectedSession()): ExecutionTask | undefined {
        return session?.taskIds
            .map(taskId => this.taskService.get(taskId))
            .find(task => task?.status === 'running' || task && this.taskService.isFinalizing(task.id));
    }

    public finishedTasks(session = this.selectedSession()): ExecutionTask[] {
        return session?.taskIds
            .map(taskId => this.taskService.get(taskId))
            .filter((task): task is ExecutionTask => task !== undefined && this.isResultsTask(task))
            ?? [];
    }

    public isResultsTask(task: ExecutionTask): boolean {
        return task.status !== 'running';
    }

    public taskFinishedTime(task: ExecutionTask): string {
        const endedAt = task.endedAt ? new Date(task.endedAt) : undefined;
        if (!endedAt || Number.isNaN(endedAt.getTime())) {
            return '';
        }
        return `${new Intl.DateTimeFormat('ja-JP', {
            hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo'
        }).format(endedAt)} JST`;
    }

    public taskStatusLabel(task: ExecutionTask): string {
        return task.status === 'running'
            ? '実行中'
            : task.status === 'completed'
                ? '完了'
                : task.status === 'failed' ? '失敗' : 'キャンセル';
    }

    public handleTaskChange(event: TaskEvent): void {
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
        const shouldSelectResultsTask = event.type === 'ended'
            || event.type === 'failed'
            || event.type === 'cancelled';
        if (shouldSelectResultsTask && session) {
            session.selectedResultsRequirementId = event.task.requirementId;
            session.selectedResultsTaskId = undefined;
            this.persistResultsQaPanelState();
            this.resultsSkillNamesLoaded = false;
            void this.ensureResultsSkillNames();
        }
        this.persistWindowState();
        this.update();
    }

    public handleSkillProposalsChanged(): void {
        void this.persistWindowState();
        this.update();
    }

    public handleResultsDocumentChanged(document: TaskResultDocument): void {
        if (!this.taskService.isFinalizing(document.taskId)) {
            this.persistWindowState();
        }
        this.update();
    }

    public handleRequirementChange(event: RequirementChangeEvent): void {
        if (event.type !== 'document-changed' && event.type !== 'questions-changed') {
            for (const session of this.sessions) {
                if (session.selectedResultsRequirementId
                    && !this.requirementService.get(session.selectedResultsRequirementId)) {
                    session.selectedResultsRequirementId = this.latestRequirement(session)?.id;
                    session.selectedResultsTaskId = undefined;
                }
            }
            void this.persistWindowState();
        }
        this.update();
    }

    public handleRequirementClassified(task: ExecutionTask): void {
        const session = this.findSessionForTask(task);
        if (session
            && !session.requirementDraftExplicit
            && this.requirementService.currentRequirementId(session.id) === task.requirementId) {
            session.requirementDraft = task.requirementId;
        }
        void this.persistWindowState();
        this.update();
    }

    constructor(host: AgentWindowHost) {
        super(host);
    }
}
