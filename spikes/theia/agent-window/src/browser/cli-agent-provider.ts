import { Emitter } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
    AgentEvent,
    AgentMessage,
    AgentProvider,
    AgentSession,
    CreateSessionInput
} from '../common/agent-provider';
import {
    AgentRuntimeServer,
    CodexExecutionEvent
} from '../common/agent-runtime-protocol';
import { AgentRuntimeClientImpl } from './agent-runtime-client';
import { MockAgentProvider } from './mock-agent-provider';
import { TaskService } from './task-service';

interface CodexSession extends AgentSession {
    workspacePath?: string;
}

interface CodexRun {
    sessionId: string;
    taskId: string;
    executionId: string;
    hasOutput: boolean;
    state: 'starting' | 'running' | 'completing' | 'cancelling';
}

/** Uses detected Codex for implementation Tasks and falls back to the existing mock. */
@injectable()
export class CliAgentProvider implements AgentProvider {
    protected readonly sessions = new Map<string, CodexSession>();
    protected readonly runs = new Map<string, CodexRun>();
    protected readonly eventEmitter = new Emitter<AgentEvent>();
    protected sequence = 0;

    readonly onEvent = this.eventEmitter.event;

    constructor(
        @inject(AgentRuntimeServer) protected readonly runtimeServer: AgentRuntimeServer,
        @inject(AgentRuntimeClientImpl) protected readonly runtimeClient: AgentRuntimeClientImpl,
        @inject(MockAgentProvider) protected readonly mockProvider: MockAgentProvider,
        @inject(TaskService) protected readonly taskService: TaskService
    ) {
        this.mockProvider.onEvent(event => this.eventEmitter.fire(event));
        this.runtimeClient.onCodexEvent(event => this.handleCodexEvent(event));
    }

    async createSession(input: CreateSessionInput): Promise<AgentSession> {
        try {
            const report = await this.runtimeServer.detectClis();
            const codex = report.detections.find(item => item.id === 'codex');
            if (codex?.status === 'found' && codex.path) {
                const session: CodexSession = {
                    id: `codex-session-${Date.now()}-${++this.sequence}`,
                    providerName: 'Codex',
                    workspaceUri: input.workspaceUri,
                    workspacePath: input.workspaceUri ? new URI(input.workspaceUri).path.fsPath() : undefined
                };
                this.sessions.set(session.id, session);
                return session;
            }
        } catch (error) {
            console.warn('[Lens] Codex detection failed; using MockAgentProvider.', error);
        }
        return this.mockProvider.createSession(input);
    }

    async sendMessage(sessionId: string, message: AgentMessage): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return this.mockProvider.sendMessage(sessionId, message);
        }
        if (this.runs.has(sessionId)) {
            throw new Error('A Codex Task is already running for this session.');
        }

        const task = this.taskService.start(sessionId, message.content);
        const run: CodexRun = {
            sessionId,
            taskId: task.id,
            executionId: task.id,
            hasOutput: false,
            state: 'starting'
        };
        this.runs.set(sessionId, run);
        this.eventEmitter.fire({ type: 'task-started', sessionId, taskId: task.id });

        await this.taskService.whenBaselineCaptured(task.id);
        if (this.runs.get(sessionId) !== run || run.state === 'cancelling') {
            return;
        }

        run.state = 'running';
        try {
            await this.runtimeServer.runCodex({
                executionId: run.executionId,
                workspacePath: session.workspacePath,
                prompt: this.implementerPrompt(message.content)
            });
        } catch (error) {
            await this.failRun(run, `Codex could not start: ${this.errorMessage(error)}`);
        }
    }

    async cancel(sessionId: string): Promise<void> {
        if (!this.sessions.has(sessionId)) {
            return this.mockProvider.cancel(sessionId);
        }
        const run = this.runs.get(sessionId);
        if (!run || run.state === 'cancelling' || run.state === 'completing') {
            return;
        }

        run.state = 'cancelling';
        try {
            await this.runtimeServer.cancelCodex(run.executionId);
        } finally {
            if (this.runs.get(sessionId) === run) {
                this.runs.delete(sessionId);
                await this.taskService.cancel(run.taskId);
                this.eventEmitter.fire({
                    type: 'task-cancelled',
                    sessionId,
                    taskId: run.taskId
                });
            }
        }
    }

    protected handleCodexEvent(event: CodexExecutionEvent): void {
        const run = [...this.runs.values()].find(candidate => candidate.executionId === event.executionId);
        if (!run || run.state === 'cancelling' || run.state === 'completing') {
            return;
        }
        if (event.type === 'output') {
            run.hasOutput = true;
            this.eventEmitter.fire({
                type: 'message-delta',
                sessionId: run.sessionId,
                taskId: run.taskId,
                delta: event.delta
            });
            return;
        }
        void this.completeRun(run, event);
    }

    protected async completeRun(
        run: CodexRun,
        event: Extract<CodexExecutionEvent, { type: 'exit' }>
    ): Promise<void> {
        if (this.runs.get(run.sessionId) !== run || run.state === 'completing' || run.state === 'cancelling') {
            return;
        }
        run.state = 'completing';

        const exitDescription = event.signal
            ? `Codex exited after signal ${event.signal}.`
            : event.code === 0
                ? 'Codex completed.'
                : `Codex exited with code ${event.code ?? 'unknown'}.`;
        if (!run.hasOutput || event.code !== 0 || event.signal) {
            this.eventEmitter.fire({
                type: 'message-delta',
                sessionId: run.sessionId,
                taskId: run.taskId,
                delta: `${run.hasOutput ? '\n' : ''}${exitDescription}`
            });
        }
        this.eventEmitter.fire({
            type: 'message-completed',
            sessionId: run.sessionId,
            taskId: run.taskId
        });
        const successful = event.code === 0 && !event.signal;
        this.runs.delete(run.sessionId);
        if (successful) {
            await this.taskService.end(run.taskId);
        } else {
            await this.taskService.fail(run.taskId);
        }
        this.eventEmitter.fire({
            type: successful ? 'task-completed' : 'task-failed',
            sessionId: run.sessionId,
            taskId: run.taskId
        });
    }

    protected async failRun(run: CodexRun, message: string): Promise<void> {
        if (this.runs.get(run.sessionId) !== run) {
            return;
        }
        this.eventEmitter.fire({
            type: 'message-delta',
            sessionId: run.sessionId,
            taskId: run.taskId,
            delta: message
        });
        this.eventEmitter.fire({
            type: 'message-completed',
            sessionId: run.sessionId,
            taskId: run.taskId
        });
        this.runs.delete(run.sessionId);
        await this.taskService.fail(run.taskId);
        this.eventEmitter.fire({
            type: 'task-failed',
            sessionId: run.sessionId,
            taskId: run.taskId
        });
    }

    protected implementerPrompt(request: string): string {
        return `You are the Lens implementer. Only edit files in this directory. Do not leave it. Do not git commit or push.\n\n${request}`;
    }

    protected errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
