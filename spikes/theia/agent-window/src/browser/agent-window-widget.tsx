import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { AgentEvent, AgentProvider, AgentSession } from '../common/agent-provider';
import { ResultsService } from './results-skill';
import { ExecutionTask, TaskService } from './task-service';
import { getDesignVariant } from './design-variant';

type AgentWindowTab = 'agent' | 'results';
type CodeRailTab = 'files' | 'source-control';

interface ChatMessage {
    id: string;
    role: 'user' | 'agent';
    content: string;
    complete: boolean;
}

@injectable()
export class AgentWindowWidget extends ReactWidget {
    static readonly ID = 'lens-agent-window';
    static readonly LABEL = 'Agent Window';

    protected activeTab: AgentWindowTab = 'agent';
    protected codeMode = false;
    protected codeRailTab: CodeRailTab = 'files';
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
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService
    ) {
        super();
    }

    @postConstruct()
    protected init(): void {
        getDesignVariant();
        this.id = AgentWindowWidget.ID;
        this.title.label = AgentWindowWidget.LABEL;
        this.title.caption = 'Lens の Agent と Results';
        this.title.iconClass = 'codicon codicon-hubot';
        this.title.closable = true;
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
                {this.renderRail()}
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
        if (this.codeMode) {
            return (
                <aside className='lens-agent-window__rail lens-agent-window__rail--code' aria-label='Code のサイドバー'>
                    <div className='lens-agent-window__code-rail-tabs' role='group' aria-label='Code の表示'>
                        <button
                            type='button'
                            className={this.codeRailTab === 'files' ? 'active' : ''}
                            aria-pressed={this.codeRailTab === 'files'}
                            onClick={() => this.selectCodeRailTab('files')}
                        >
                            Files
                        </button>
                        <button
                            type='button'
                            className={this.codeRailTab === 'source-control' ? 'active' : ''}
                            aria-pressed={this.codeRailTab === 'source-control'}
                            onClick={() => this.selectCodeRailTab('source-control')}
                        >
                            Source Control
                        </button>
                    </div>
                    {this.codeRailTab === 'files' ? (
                        <div className='lens-agent-window__tree' aria-label='ファイル一覧'>
                            <div className='lens-agent-window__tree-title'><span className='codicon codicon-chevron-down' /> lens</div>
                            <div className='lens-agent-window__tree-row'><span className='codicon codicon-folder-opened' /> spikes</div>
                            <div className='lens-agent-window__tree-row depth-1'><span className='codicon codicon-folder-opened' /> theia</div>
                            <div className='lens-agent-window__tree-row depth-2 active'><span className='codicon codicon-file-code' /> auth-service.ts</div>
                        </div>
                    ) : (
                        <div className='lens-agent-window__tree' aria-label='変更ファイル一覧'>
                            <div className='lens-agent-window__tree-title'>変更 <span>1</span></div>
                            <div className='lens-agent-window__tree-row active'>auth-service.ts <strong>M</strong></div>
                        </div>
                    )}
                    <div className='lens-agent-window__rail-footer'>
                        <span>{this.codeRailTab === 'files' ? 'Files' : 'Source Control'}</span>
                        <span className='codicon codicon-settings-gear' title='設定' aria-label='設定' />
                    </div>
                </aside>
            );
        }

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
                <div className='lens-agent-window__editor-tabs'>
                    <div className='active'><span className='codicon codicon-file-code' aria-hidden='true' /> auth-service.ts</div>
                </div>
                <div className='lens-agent-window__breadcrumbs'>spikes / theia / sample-src / auth-service.ts</div>
                <pre className='lens-agent-window__source' aria-label='auth-service.ts のコード'><code>{`export class AuthService {
  constructor(private readonly tokenStore: TokenStore) {}

  async rotateRefreshToken(userId: string): Promise<string> {
    const token = crypto.randomUUID();
    await this.tokenStore.save(userId, token);
    return token;
  }
}`}</code></pre>
            </section>
        );
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
        this.codeMode = !this.codeMode;
        this.update();
    }

    protected selectCodeRailTab(tab: CodeRailTab): void {
        this.codeRailTab = tab;
        this.update();
    }

    protected selectTab(tab: AgentWindowTab): void {
        this.activeTab = tab;
        this.update();
    }

    protected async newChat(): Promise<void> {
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
