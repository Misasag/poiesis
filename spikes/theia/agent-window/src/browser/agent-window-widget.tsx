import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { WidgetManager } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Disposable } from '@theia/core/lib/common';
import { Message, MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Widget } from '@theia/core/shared/@lumino/widgets';
import { EditorWidget } from '@theia/editor/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { AgentEvent, AgentProvider, AgentSession } from '../common/agent-provider';
import { ResultsService } from './results-skill';
import { ExecutionTask, TaskService } from './task-service';
import { getDesignVariant } from './design-variant';

type AgentWindowTab = 'agent' | 'results';
type CodeSidebarTab = 'files' | 'git';

interface ChatMessage {
    id: string;
    role: 'user' | 'agent';
    content: string;
    complete: boolean;
}

@injectable()
export class AgentWindowWidget extends ReactWidget {
    static readonly ID = 'lens-agent-window';
    static readonly FILES_WIDGET_FACTORY_ID = 'files';
    static readonly GIT_WIDGET_FACTORY_ID = 'scm-view';
    static readonly EDITOR_WIDGET_FACTORY_ID = 'code-editor-opener';
    static readonly SETTINGS_WIDGET_FACTORY_ID = 'settings_widget';
    protected activeTab: AgentWindowTab = 'agent';
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
    protected session?: AgentSession;
    protected agentDraft = '';
    protected messages: ChatMessage[] = [{
        id: 'provider-ready',
        role: 'agent',
        content: '利用できるエージェントを準備しています…',
        complete: true
    }];
    protected selectedResultsTaskId?: string;
    protected readonly resultsDrafts = new Map<string, string>();
    protected readonly resultsNotices = new Map<string, string>();

    constructor(
        @inject(AgentProvider) protected readonly agentProvider: AgentProvider,
        @inject(TaskService) protected readonly taskService: TaskService,
        @inject(ResultsService) protected readonly resultsService: ResultsService,
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService,
        @inject(WidgetManager) protected readonly widgetManager: WidgetManager
    ) {
        super();
    }

    @postConstruct()
    protected init(): void {
        getDesignVariant();
        this.id = AgentWindowWidget.ID;
        this.addClass('lens-agent-window');

        this.toDispose.push(this.agentProvider.onEvent(event => this.handleAgentEvent(event)));
        this.toDispose.push(this.taskService.onDidChangeTask(event => {
            if ((event.type === 'ended' || event.type === 'cancelled') && !this.selectedResultsTaskId) {
                this.selectedResultsTaskId = event.task.id;
            }
            this.update();
        }));
        this.toDispose.push(this.resultsService.onDidChange(() => this.update()));

        void this.initializeSession();
        this.update();
    }

    protected render(): React.ReactNode {
        const runningTask = this.runningTask();
        return (
            <div className='lens-agent-window__content' data-mode={this.codeMode ? 'code' : this.activeTab}>
                {!this.codeMode && this.renderRail()}
                <main className='lens-agent-window__workspace'>
                    {this.renderHeader()}
                    <div className='lens-agent-window__viewport'>
                        {this.codeMode
                            ? this.renderCode()
                            : this.activeTab === 'agent'
                                ? this.renderAgent(runningTask)
                                : this.renderResults()}
                    </div>
                </main>
            </div>
        );
    }

    protected renderRail(): React.ReactNode {
        return (
            <aside className='lens-agent-window__rail' aria-label='セッションのサイドバー'>
                <div className='lens-agent-window__rail-top'>
                    <button type='button' className='lens-agent-window__rail-action' onClick={() => void this.newChat()}>
                        <span className='codicon codicon-comment-discussion' aria-hidden='true' />
                        <span>New Chat</span>
                    </button>
                </div>
                <div className='lens-agent-window__rail-heading'>ワークスペース</div>
                <div className='lens-agent-window__sessions'>
                    <div className='lens-agent-window__workspace-name'>
                        <span className='codicon codicon-chevron-down' aria-hidden='true' />
                        <span className='codicon codicon-folder-opened' aria-hidden='true' />
                        <strong>lens</strong>
                    </div>
                    <button type='button' className='lens-agent-window__session active' aria-current='true'>
                        <span>認証を Redis 方式へ変更</span>
                        <small>現在</small>
                    </button>
                </div>
                <div className='lens-agent-window__rail-footer'>
                    <span>Lens</span>
                    <span className='codicon codicon-settings-gear' title='設定' aria-label='設定' />
                </div>
            </aside>
        );
    }

    protected renderHeader(): React.ReactNode {
        return (
            <header className='lens-agent-window__header'>
                <div className='lens-agent-window__context'>
                    <div className='lens-agent-window__context-scope'>
                        <small>lens / main</small>
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
                    <strong>{this.codeMode ? 'Code' : '認証を Redis 方式へ変更'}</strong>
                </div>
                {!this.codeMode && (
                    <nav className='lens-agent-window__tabs' aria-label='Agent と Results の切り替え'>
                        <button
                            type='button'
                            className={this.activeTab === 'agent' ? 'active' : ''}
                            aria-current={this.activeTab === 'agent' ? 'page' : undefined}
                            onClick={() => this.selectTab('agent')}
                        >
                            Agent
                        </button>
                        <span className='lens-agent-window__tab-divider' aria-hidden='true'>|</span>
                        <button
                            type='button'
                            className={this.activeTab === 'results' ? 'active' : ''}
                            aria-current={this.activeTab === 'results' ? 'page' : undefined}
                            onClick={() => this.selectTab('results')}
                        >
                            Results
                        </button>
                    </nav>
                )}
            </header>
        );
    }

    protected renderAgent(runningTask?: ExecutionTask): React.ReactNode {
        return (
            <section className='lens-agent-window__agent' aria-label='Agent の会話'>
                <div className='lens-agent-window__messages' aria-live='polite'>
                    <div className='lens-agent-window__messages-inner'>
                        {this.messages.map(message => (
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
                        value={this.agentDraft}
                        placeholder='次の変更内容や質問を入力…'
                        aria-label='Agent へのメッセージ'
                        rows={2}
                        disabled={!this.session || Boolean(runningTask)}
                        onChange={event => this.setAgentDraft(event.currentTarget.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                                event.preventDefault();
                                void this.sendAgentMessage();
                            }
                        }}
                    />
                    <div className='lens-agent-window__composer-footer'>
                        <div className='lens-agent-window__composer-tools' aria-label='コンテキスト設定'>
                            <button type='button' aria-label='コンテキストを追加'>＋</button>
                            <span>@ コンテキスト</span>
                            <span>自動</span>
                        </div>
                        <button
                            className='lens-agent-window__send'
                            type='button'
                            aria-label='Agent へ送信'
                            disabled={!this.session || Boolean(runningTask) || !this.agentDraft.trim()}
                            onClick={() => void this.sendAgentMessage()}
                        >
                            <span className='codicon codicon-arrow-up' aria-hidden='true' />
                        </button>
                    </div>
                </section>
            </section>
        );
    }

    protected renderResults(): React.ReactNode {
        const finishedTasks = [...this.finishedTasks()].reverse();
        const selectedTask = finishedTasks.find(task => task.id === this.selectedResultsTaskId)
            ?? finishedTasks[0];
        const document = selectedTask ? this.resultsService.get(selectedTask.id) : undefined;
        const draft = selectedTask ? this.resultsDrafts.get(selectedTask.id) ?? '' : '';
        const notice = selectedTask ? this.resultsNotices.get(selectedTask.id) : undefined;

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
                                <small>{index === 0 ? '最新 · ' : ''}{task.status === 'cancelled' ? 'キャンセル' : '完了'}</small>
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
                        <button type='button' title='設定' aria-label='設定' onClick={() => void this.openCodeSettings()}>
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

    protected onBeforeDetach(message: Message): void {
        this.codeSidebarResizeObserver?.disconnect();
        this.codeEditorResizeObserver?.disconnect();
        this.detachCodeWidgets();
        super.onBeforeDetach(message);
    }

    protected async initializeSession(): Promise<void> {
        const root = this.workspaceService.tryGetRoots()[0]
            ?? (this.workspaceService.workspace?.isDirectory ? this.workspaceService.workspace : undefined);
        this.session = await this.agentProvider.createSession({ workspaceUri: root?.resource.toString() });
        this.messages = [{
            id: 'provider-ready',
            role: 'agent',
            content: '準備ができました。変更したい内容を入力してください。',
            complete: true
        }];
        this.update();
    }

    protected async sendAgentMessage(): Promise<void> {
        const content = this.agentDraft.trim();
        if (!this.session || !content || this.runningTask()) {
            return;
        }
        this.agentDraft = '';
        this.messages.push({ id: `user-${Date.now()}`, role: 'user', content, complete: true });
        this.update();
        try {
            await this.agentProvider.sendMessage(this.session.id, { role: 'user', content });
        } catch (error) {
            this.messages.push({
                id: `error-${Date.now()}`,
                role: 'agent',
                content: `エージェントとの通信でエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`,
                complete: true
            });
            this.update();
        }
    }

    protected async cancelRun(): Promise<void> {
        if (this.session) {
            await this.agentProvider.cancel(this.session.id);
        }
    }

    protected handleAgentEvent(event: AgentEvent): void {
        if (this.session && event.sessionId !== this.session.id) {
            return;
        }
        if (event.type === 'task-started') {
            this.messages.push({ id: `agent-${event.taskId}`, role: 'agent', content: '', complete: false });
        } else if (event.type === 'message-delta') {
            this.updateAgentMessage(event.taskId, message => ({ ...message, content: message.content + event.delta }));
        } else if (event.type === 'message-completed') {
            this.updateAgentMessage(event.taskId, message => ({ ...message, complete: true }));
        } else if (event.type === 'task-cancelled') {
            this.updateAgentMessage(event.taskId, message => ({
                ...message,
                content: `${message.content} 実行をキャンセルしました。`.trim(),
                complete: true
            }));
        }
        this.update();
    }

    protected updateAgentMessage(taskId: string, update: (message: ChatMessage) => ChatMessage): void {
        const id = `agent-${taskId}`;
        this.messages = this.messages.map(message => message.id === id ? update(message) : message);
    }

    protected runningTask(): ExecutionTask | undefined {
        return this.taskService.list(this.session?.id).find(task => task.status === 'running');
    }

    protected finishedTasks(): ExecutionTask[] {
        return this.taskService.list(this.session?.id).filter(task => task.status !== 'running');
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
        this.activeTab = tab;
        this.update();
    }

    protected async newChat(): Promise<void> {
        this.detachCodeWidgets();
        this.codeMode = false;
        this.activeTab = 'agent';
        this.agentDraft = '';
        this.selectedResultsTaskId = undefined;
        this.messages = [{
            id: `new-chat-${Date.now()}`,
            role: 'agent',
            content: '新しい会話を準備しています…',
            complete: true
        }];
        this.update();

        const root = this.workspaceService.tryGetRoots()[0]
            ?? (this.workspaceService.workspace?.isDirectory ? this.workspaceService.workspace : undefined);
        this.session = await this.agentProvider.createSession({ workspaceUri: root?.resource.toString() });
        this.messages = [{
            id: `new-chat-ready-${Date.now()}`,
            role: 'agent',
            content: '新しい会話です。変更したい内容を入力してください。',
            complete: true
        }];
        this.update();
    }

    protected setAgentDraft(value: string): void {
        this.agentDraft = value;
        this.update();
    }

    protected selectResultsTask(taskId: string): void {
        this.selectedResultsTaskId = taskId;
        this.update();
    }

    protected setResultsDraft(taskId: string, value: string): void {
        this.resultsDrafts.set(taskId, value);
        this.resultsNotices.delete(taskId);
        this.update();
    }

    protected async submitResultsQuestion(taskId: string): Promise<void> {
        const question = this.resultsDrafts.get(taskId)?.trim();
        if (!question) {
            return;
        }
        this.resultsDrafts.set(taskId, '');
        this.resultsNotices.set(taskId, 'この質問は Results 内だけに保存され、Agent の会話やタスクには送信されません。');
        this.update();
    }
}
