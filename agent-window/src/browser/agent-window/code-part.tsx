import * as React from '@theia/core/shared/react';
import * as ReactDOM from '@theia/core/shared/react-dom';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { FormatType, open, OpenerService, Saveable, SaveableService, SaveReason, StorageService, WidgetManager } from '@theia/core/lib/browser';
import { IconThemeService } from '@theia/core/lib/browser/icon-theme-service';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { CommandService, Disposable, DisposableCollection, MessageService } from '@theia/core/lib/common';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { SUPPORTED_ENCODINGS } from '@theia/core/lib/common/supported-encodings';
import URI from '@theia/core/lib/common/uri';
import { Message, MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { EditorManager, EditorWidget } from '@theia/editor/lib/browser';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import { PROBLEMS_WIDGET_ID } from '@theia/markers/lib/browser/problem/problem-widget';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
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

type CodeSidebarTab = 'files' | 'search' | 'git' | 'extensions';

interface CodeEditorStatus {
    encoding?: string;
    eol: 'LF' | 'CRLF';
    indentation: string;
}

const DEFAULT_CODE_SIDEBAR_WIDTH = 260;
const MIN_CODE_SIDEBAR_WIDTH = 180;
const MAX_CODE_SIDEBAR_WIDTH = 520;
const DEFAULT_CODE_PANEL_HEIGHT = 190;
const MIN_CODE_PANEL_HEIGHT = 96;

export class CodePart extends AgentWindowPart {
    static readonly FILES_WIDGET_FACTORY_ID = 'files';
    static readonly SEARCH_WIDGET_FACTORY_ID = 'search-in-workspace';
    static readonly GIT_WIDGET_FACTORY_ID = 'scm-view';
    static readonly GIT_GRAPH_WIDGET_FACTORY_ID = 'scm-history-graph-widget';
    static readonly EDITOR_WIDGET_FACTORY_ID = 'code-editor-opener';
    static readonly SETTINGS_WIDGET_FACTORY_ID = 'settings_widget';
    static readonly EXTENSIONS_WIDGET_FACTORY_ID = 'vsx-extensions-view-container';
    static readonly PROBLEMS_WIDGET_FACTORY_ID = PROBLEMS_WIDGET_ID;

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

    protected codeEditorStatus?: CodeEditorStatus;

    protected codeEditorStatusEditor?: MonacoEditor;

    protected codeEditorStatusListeners = new DisposableCollection();

    protected codeEditorStatusRefreshTimer?: number;

    protected codeStatusListenersInstalled = false;

    protected registeringCodeProblems = false;

    public installCodeStatusListeners(): void {
        if (this.codeStatusListenersInstalled) {
            return;
        }
        this.codeStatusListenersInstalled = true;
        const listeners = new DisposableCollection();
        listeners.push(this.problemManager.onDidChangeMarkers(() => this.update()));
        listeners.push(this.editorManager.onCurrentEditorChanged(() => this.bindCodeEditorStatus()));
        listeners.push(Disposable.create(() => {
            this.codeEditorStatusListeners.dispose();
            if (this.codeEditorStatusRefreshTimer !== undefined) {
                window.clearTimeout(this.codeEditorStatusRefreshTimer);
                this.codeEditorStatusRefreshTimer = undefined;
            }
        }));
        this.host.addDisposable(listeners);
        this.bindCodeEditorStatus();
    }

    public disposeCodeResources(): void {
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
    }

    public renderCode(): React.ReactNode {
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
                        <button type='button' title='設定' aria-label='設定' onClick={() => this.host.openSettings()}>
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
                                    {this.renderExplorerAction('new-file', '新しいファイル', FileNavigatorCommands.NEW_FILE_TOOLBAR.id)}
                                    {this.renderExplorerAction('new-folder', '新しいフォルダー', FileNavigatorCommands.NEW_FOLDER_TOOLBAR.id)}
                                    {this.renderExplorerAction('refresh', 'Explorer を更新', FileNavigatorCommands.REFRESH_NAVIGATOR.id)}
                                    {this.renderExplorerAction('collapse-all', 'フォルダーを折りたたむ', FileNavigatorCommands.COLLAPSE_ALL.id)}
                                </React.Fragment>
                            )}
                            {this.codeSidebarTab === 'search' && (
                                <React.Fragment>
                                    {this.renderSearchAction('refresh', '検索結果を更新', SearchInWorkspaceCommands.REFRESH_RESULTS.id)}
                                    {this.renderSearchAction('clear-all', '検索結果をクリア', SearchInWorkspaceCommands.CLEAR_ALL.id)}
                                    {this.renderSearchAction('collapse-all', '検索結果をすべて折りたたむ', SearchInWorkspaceCommands.COLLAPSE_ALL.id)}
                                </React.Fragment>
                            )}
                            {this.codeSidebarTab === 'git' && (
                                <button
                                    type='button'
                                    title='Source Control を更新'
                                    aria-label='Source Control を更新'
                                    onClick={() => void this.commandService.executeCommand('git.refresh')}
                                >
                                    <span className='codicon codicon-refresh' aria-hidden='true' />
                                </button>
                            )}
                            {this.codeSidebarTab === 'files' && (
                                <div className='poiesis-agent-window__code-explorer-more'>
                                    <button
                                        type='button'
                                        title='その他の操作'
                                        aria-label='その他の操作'
                                        aria-haspopup='menu'
                                        aria-expanded={this.host.state.explorerMoreVisible}
                                        onClick={() => {
                                            this.host.state.explorerMoreVisible = !this.host.state.explorerMoreVisible;
                                            this.update();
                                        }}
                                    >
                                        <span className='codicon codicon-ellipsis' aria-hidden='true' />
                                    </button>
                                    {this.host.state.explorerMoreVisible && this.renderExplorerMoreMenu()}
                                </div>
                            )}
                        </div>
                    </div>
                    {this.codeSidebarTab === 'files' && (
                        <div className='poiesis-agent-window__code-explorer-root'>
                            <span className='codicon codicon-chevron-down' aria-hidden='true' />
                            <strong>{this.host.sessions.workspaceFolderName()}</strong>
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
                                        title='閉じる'
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
                            <section className='poiesis-agent-window__code-panel' aria-label='下部パネル'>
                                <div
                                    className='poiesis-agent-window__code-panel-resize'
                                    role='separator'
                                    aria-label='Terminal パネルの高さを変更'
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
                                        <PoiesisSelect
                                            className='poiesis-agent-window__code-terminal-select'
                                            ariaLabel='選択中の Terminal'
                                            value={this.codeTerminalWidget.id}
                                            options={this.codeTerminalWidgets.map(terminal => ({
                                                value: terminal.id,
                                                label: this.codeTerminalLabel(terminal)
                                            }))}
                                            onChange={value => this.selectCodeTerminalById(value)}
                                        />
                                    )}
                                    <button type='button' title='新しい Terminal' aria-label='新しい Terminal' onClick={() => void this.createCodeTerminal()}>
                                        <span className='codicon codicon-add' aria-hidden='true' />
                                    </button>
                                    <button
                                        type='button'
                                        title='Terminal を終了'
                                        aria-label='Terminal を終了'
                                        disabled={!this.codeTerminalWidget}
                                        onClick={() => this.closeCodeTerminal()}
                                    >
                                        <span className='codicon codicon-trash' aria-hidden='true' />
                                    </button>
                                    <button type='button' title='パネルを閉じる' aria-label='パネルを閉じる' onClick={() => this.toggleCodePanel(false)}>
                                        <span className='codicon codicon-close' aria-hidden='true' />
                                    </button>
                                </div>
                                <div className='poiesis-agent-window__code-terminal-host' ref={this.setCodeTerminalHost} />
                            </section>
                        )}
                    </div>
                </main>
                <footer className='poiesis-agent-window__code-status' aria-label='ステータスバー'>
                    {this.renderCodeScmStatusCommands()}
                    {this.renderCodeProblemStatus()}
                    <span className='poiesis-agent-window__code-status-spacer' />
                    {this.renderCodeEditorStatus()}
                    <button
                        type='button'
                        className={this.codePanelVisible ? 'active' : ''}
                        title='パネルを切り替える'
                        aria-label='パネルを切り替える'
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

    protected renderCodeProblemStatus(): React.ReactNode {
        const { errors, warnings } = this.problemManager.getProblemStat();
        const label = `問題を表示: エラー ${errors}、警告 ${warnings}`;
        return (
            <button
                type='button'
                className='poiesis-agent-window__code-status-problems'
                title={label}
                aria-label={label}
                onClick={() => void this.openCodeProblems()}
            >
                <span className='codicon codicon-error' aria-hidden='true' />
                <span>{errors}</span>
                <span className='codicon codicon-warning' aria-hidden='true' />
                <span>{warnings}</span>
            </button>
        );
    }

    protected renderCodeEditorStatus(): React.ReactNode {
        const status = this.codeEditorStatus;
        if (!status) {
            return undefined;
        }
        return (
            <>
                {status.encoding && <span className='poiesis-agent-window__code-status-encoding'>{status.encoding}</span>}
                <span className='poiesis-agent-window__code-status-eol'>{status.eol}</span>
                <span className='poiesis-agent-window__code-status-indentation'>{status.indentation}</span>
            </>
        );
    }

    protected async openCodeProblems(): Promise<void> {
        const problems = await this.widgetManager.getOrCreateWidget(CodePart.PROBLEMS_WIDGET_FACTORY_ID);
        this.registeringCodeProblems = true;
        try {
            this.registerCodeWidget(CodePart.PROBLEMS_WIDGET_FACTORY_ID, problems, true);
        } finally {
            this.registeringCodeProblems = false;
        }
        this.selectCodeCenterWidget(problems);
    }

    protected activeCodeMonacoEditor(): MonacoEditor | undefined {
        const editorWidget = this.editorManager.currentEditor === this.activeCodeCenterWidget
            ? this.editorManager.currentEditor
            : this.activeCodeCenterWidget instanceof EditorWidget
                ? this.activeCodeCenterWidget
                : undefined;
        return editorWidget?.editor instanceof MonacoEditor ? editorWidget.editor : undefined;
    }

    protected bindCodeEditorStatus(): void {
        const editor = this.activeCodeMonacoEditor();
        if (editor === this.codeEditorStatusEditor) {
            this.refreshCodeEditorStatus();
            return;
        }
        this.codeEditorStatusListeners.dispose();
        this.codeEditorStatusListeners = new DisposableCollection();
        this.codeEditorStatusEditor = editor;
        if (editor) {
            const control = editor.getControl();
            this.codeEditorStatusListeners.push(control.onDidChangeModelOptions(() => this.scheduleCodeEditorStatusRefresh()));
            this.codeEditorStatusListeners.push(control.onDidChangeModelContent(() => this.scheduleCodeEditorStatusRefresh()));
            this.codeEditorStatusListeners.push(control.onDidChangeModel(() => this.bindCodeEditorStatus()));
            this.codeEditorStatusListeners.push(editor.onEncodingChanged(() => this.scheduleCodeEditorStatusRefresh()));
        }
        this.refreshCodeEditorStatus();
    }

    protected scheduleCodeEditorStatusRefresh(): void {
        if (this.codeEditorStatusRefreshTimer !== undefined) {
            window.clearTimeout(this.codeEditorStatusRefreshTimer);
        }
        this.codeEditorStatusRefreshTimer = window.setTimeout(() => {
            this.codeEditorStatusRefreshTimer = undefined;
            this.refreshCodeEditorStatus();
        }, 40);
    }

    protected refreshCodeEditorStatus(): void {
        const editor = this.activeCodeMonacoEditor();
        const model = editor ? editor.getControl().getModel() : undefined;
        let nextStatus: CodeEditorStatus | undefined;
        if (editor && model) {
            const options = model.getOptions();
            const encodingId = editor.document.getEncoding();
            nextStatus = {
                encoding: encodingId ? SUPPORTED_ENCODINGS[encodingId]?.labelShort ?? encodingId : undefined,
                eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
                indentation: `${options.insertSpaces ? 'スペース' : 'タブ'}: ${options.insertSpaces ? options.indentSize : options.tabSize}`
            };
        }
        if (this.sameCodeEditorStatus(this.codeEditorStatus, nextStatus)) {
            return;
        }
        this.codeEditorStatus = nextStatus;
        if (this.host.state.codeMode) {
            this.update();
        }
    }

    protected sameCodeEditorStatus(left: CodeEditorStatus | undefined, right: CodeEditorStatus | undefined): boolean {
        return left?.encoding === right?.encoding
            && left?.eol === right?.eol
            && left?.indentation === right?.indentation;
    }

    protected renderCodeScmStatusCommands(): React.ReactNode {
        const commands = this.scmService.statusBarCommands;
        if (commands.length === 0) {
            return <span><span className='codicon codicon-source-control' aria-hidden='true' /> {this.host.sessions.currentGitBranch() ?? 'main'}</span>;
        }
        return commands.map((command, index) => {
            const label = this.scmStatusCommandLabel(command.title);
            return (
                <button
                    key={`${command.command ?? 'scm-status'}-${index}`}
                    type='button'
                    className='poiesis-agent-window__code-status-scm'
                    data-scm-status-index={index}
                    title={command.tooltip ?? label}
                    aria-label={command.tooltip ?? label}
                    disabled={!command.command}
                    onClick={() => void this.executeScmStatusCommand(command)}
                >
                    {this.renderScmStatusCommandTitle(command.title)}
                </button>
            );
        });
    }

    protected renderScmStatusCommandTitle(title: string): React.ReactNode {
        const match = /^\$\(([^)]+)\)\s*(.*)$/.exec(title);
        if (!match) {
            return <span className='poiesis-agent-window__code-status-scm-label'>{title}</span>;
        }
        const [icon, modifier] = match[1].split('~', 2);
        const iconClass = `codicon codicon-${icon}${modifier ? ` codicon-modifier-${modifier}` : ''}`;
        return (
            <>
                <span className={iconClass} aria-hidden='true' />
                {match[2] && <span className='poiesis-agent-window__code-status-scm-label'>{match[2]}</span>}
            </>
        );
    }

    protected scmStatusCommandLabel(title: string): string {
        return title.replace(/\$\([^)]+\)\s*/g, '').trim() || 'Source Control の操作';
    }

    protected async executeScmStatusCommand(command: ScmCommand): Promise<void> {
        if (!command.command) {
            return;
        }
        try {
            await this.commandService.executeCommand(command.command, ...(command.arguments ?? []));
        } catch (error) {
            console.error('[Poiesis] Could not execute an SCM status bar command.', error);
            await this.messageService.error(`Source Control の操作に失敗しました: ${this.scmStatusCommandLabel(command.title)}`);
        }
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
                        <h2 id='poiesis-code-close-title'>{label} の変更を保存しますか？</h2>
                        <button
                            type='button'
                            title='キャンセル'
                            aria-label='キャンセル'
                            disabled={this.pendingCodeCenterCloseBusy}
                            onClick={() => this.cancelCodeCenterClose()}
                        >
                            <span className='codicon codicon-close' aria-hidden='true' />
                        </button>
                    </header>
                    <p>保存しない場合、変更内容は失われます。</p>
                    <footer>
                        <button
                            type='button'
                            disabled={this.pendingCodeCenterCloseBusy}
                            onClick={() => this.cancelCodeCenterClose()}
                        >
                            キャンセル
                        </button>
                        <button
                            type='button'
                            disabled={this.pendingCodeCenterCloseBusy}
                            onClick={() => void this.resolveCodeCenterClose(false)}
                        >
                            保存しない
                        </button>
                        <button
                            type='button'
                            className='primary'
                            autoFocus
                            disabled={this.pendingCodeCenterCloseBusy}
                            onClick={() => void this.resolveCodeCenterClose(true)}
                        >
                            保存
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

    public ensureCodeFileIcons(): void {
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
            <div className='poiesis-agent-window__code-explorer-menu' role='menu' aria-label='Explorer のその他の操作'>
                {this.renderExplorerMenuItem('隠しファイルを切り替える', FileNavigatorCommands.TOGGLE_HIDDEN_FILES.id)}
                {this.renderExplorerMenuItem('自動表示', FileNavigatorCommands.TOGGLE_AUTO_REVEAL.id)}
                <div className='poiesis-agent-window__code-explorer-menu-separator' role='separator' />
                {this.renderExplorerMenuItem('Explorer を更新', FileNavigatorCommands.REFRESH_NAVIGATOR.id)}
                {this.renderExplorerMenuItem('フォルダーを折りたたむ', FileNavigatorCommands.COLLAPSE_ALL.id)}
            </div>
        );
    }

    protected renderExplorerMenuItem(label: string, command: string): React.ReactNode {
        return (
            <button
                type='button'
                role='menuitem'
                onClick={() => {
                    this.host.state.explorerMoreVisible = false;
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
        if (factoryId === CodePart.FILES_WIDGET_FACTORY_ID) {
            changed = this.codeFilesWidget !== widget;
            this.codeFilesWidget = widget;
        } else if (factoryId === CodePart.SEARCH_WIDGET_FACTORY_ID) {
            changed = this.codeSearchWidget !== widget;
            this.codeSearchWidget = widget;
        } else if (factoryId === CodePart.GIT_WIDGET_FACTORY_ID) {
            changed = this.codeGitWidget !== widget;
            this.codeGitWidget = widget;
        } else if (factoryId === CodePart.GIT_GRAPH_WIDGET_FACTORY_ID) {
            changed = this.codeGitGraphWidget !== widget;
            this.codeGitGraphWidget = widget;
        } else if (factoryId === CodePart.EXTENSIONS_WIDGET_FACTORY_ID) {
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
            this.bindCodeEditorStatus();
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
            this.host.addDisposable(listeners);
            requestAnimationFrame(() => this.revealCodeCenterTab(widget));
        }
        if (changed && this.host.state.codeMode) {
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
            || factoryId.startsWith(CodePart.EDITOR_WIDGET_FACTORY_ID)
            || factoryId === CodePart.SETTINGS_WIDGET_FACTORY_ID
            || factoryId === CodePart.PROBLEMS_WIDGET_FACTORY_ID && this.registeringCodeProblems;
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
            if (this.host.isDisposed) {
                return;
            }
            this.syncCodeWidgetAttachments();
            if (this.host.state.codeMode && this.codePanelVisible && this.codeTerminalHost) {
                void this.ensureCodeTerminal();
            }
        });
    }

    protected syncCodeWidgetAttachments(): void {
        if (!this.host.state.codeMode) {
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

    public async ensureCodeTerminal(): Promise<void> {
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
        if (this.host.state.codeMode && this.codePanelVisible) {
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
        this.host.addDisposable(listeners);
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

    public detachCodeWidgets(): void {
        this.detachCodeWidget(this.activeCodeSidebarWidget());
        this.detachCodeWidget(this.codeGitGraphWidget);
        this.detachCodeWidget(this.activeCodeCenterWidget);
        this.detachCodeWidget(this.codeTerminalWidget);
    }

    protected selectCodeSidebarTab(tab: CodeSidebarTab): void {
        this.detachCodeWidget(this.activeCodeSidebarWidget());
        this.detachCodeWidget(this.codeGitGraphWidget);
        this.host.state.explorerMoreVisible = false;
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
            this.codeExtensionsWidget = await this.widgetManager.getOrCreateWidget(CodePart.EXTENSIONS_WIDGET_FACTORY_ID);
        }
        if (!this.codeExtensionsInitialized) {
            this.codeExtensionsInitialized = true;
            if (!this.extensionsSearchModel.query.trim()) {
                this.extensionsSearchModel.query = BUILTIN_QUERY;
            }
        }
        if (this.host.state.codeMode && this.codeSidebarTab === 'extensions') {
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
        this.bindCodeEditorStatus();
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

    public installCodeTabDropTarget(): void {
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
        this.host.addDisposable(Disposable.create(() => {
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

    public installCodeEditorSaveShortcut(): void {
        const onKeyDown = (event: KeyboardEvent): void => {
            const savePressed = (event.ctrlKey || event.metaKey)
                && !event.altKey
                && !event.shiftKey
                && (event.key.toLocaleLowerCase() === 's' || event.code === 'KeyS');
            const widget = this.host.state.codeMode ? this.activeCodeCenterWidget : undefined;
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
        this.host.addDisposable(Disposable.create(() => document.removeEventListener('keydown', onKeyDown, true)));
    }

    public installCodeTerminalShortcut(): void {
        const onKeyDown = (event: KeyboardEvent): void => {
            const togglePressed = (event.ctrlKey || event.metaKey)
                && !event.altKey
                && !event.shiftKey
                && (event.key === '`' || event.code === 'Backquote');
            if (!this.host.state.codeMode || !togglePressed) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            this.toggleCodePanel();
        };
        document.addEventListener('keydown', onKeyDown, true);
        this.host.addDisposable(Disposable.create(() => document.removeEventListener('keydown', onKeyDown, true)));
    }

    protected closeCodeCenterWidget(widget: Widget): void {
        if (widget.id === CodePart.SETTINGS_WIDGET_FACTORY_ID || widget.id === CodePart.PROBLEMS_WIDGET_FACTORY_ID) {
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
        this.bindCodeEditorStatus();
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
        if (widget.id === CodePart.SETTINGS_WIDGET_FACTORY_ID) {
            return 'Settings';
        }
        return widget.title.label || widget.title.caption || 'Editor';
    }

    public async openCodeSettings(): Promise<void> {
        const settings = await this.widgetManager.getOrCreateWidget(CodePart.SETTINGS_WIDGET_FACTORY_ID);
        this.registerCodeWidget(CodePart.SETTINGS_WIDGET_FACTORY_ID, settings);
        this.selectCodeCenterWidget(settings);
    }

    public async openCodeCitation(file: URI, startLine: number, endLine: number): Promise<void> {
        this.host.closeCustomize(false);
        if (!this.host.state.codeMode) {
            this.ensureCodeFileIcons();
            this.host.state.codeMode = true;
            this.update();
            requestAnimationFrame(() => void this.ensureCodeTerminal());
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
        const uriKey = file.toString();
        this.pendingPinnedEditorUris.add(uriKey);
        try {
            await this.editorManager.open(file, {
                mode: 'activate',
                selection: {
                    start: { line: startLine - 1, character: 0 },
                    end: { line: endLine - 1, character: 0 }
                }
            });
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

    public async openCodeFile(rawUri: string): Promise<void> {
        this.host.closeCustomize(false);
        if (!this.host.state.codeMode) {
            this.ensureCodeFileIcons();
            this.host.state.codeMode = true;
            this.update();
            requestAnimationFrame(() => void this.ensureCodeTerminal());
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        } else {
            this.update();
        }
        await this.openDraggedCodeFile(rawUri);
    }

    constructor(host: AgentWindowHost) {
        super(host);
    }
}
