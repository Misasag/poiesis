import { Emitter } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
    AgentEvent,
    AgentMessage,
    AgentProvider,
    AgentSession,
    CreateSessionInput
} from '../common/agent-provider';
import { TaskService } from './task-service';

interface MockRun {
    taskId: string;
    timer?: ReturnType<typeof setTimeout>;
}

/** Chat-only provider. It never reads, writes, or executes within the workspace. */
@injectable()
export class MockAgentProvider implements AgentProvider {
    protected readonly sessions = new Map<string, AgentSession>();
    protected readonly runs = new Map<string, MockRun>();
    protected readonly eventEmitter = new Emitter<AgentEvent>();
    protected sequence = 0;

    constructor(@inject(TaskService) protected readonly taskService: TaskService) { }

    readonly onEvent = this.eventEmitter.event;

    async createSession(input: CreateSessionInput): Promise<AgentSession> {
        const session: AgentSession = {
            id: `mock-session-${Date.now()}-${++this.sequence}`,
            providerName: 'MockAgentProvider',
            workspaceUri: input.workspaceUri
        };
        this.sessions.set(session.id, session);
        return session;
    }

    async sendMessage(sessionId: string, message: AgentMessage): Promise<void> {
        if (!this.sessions.has(sessionId)) {
            throw new Error(`Unknown Agent session: ${sessionId}`);
        }
        if (this.runs.has(sessionId)) {
            throw new Error('A mock Task is already running for this session.');
        }

        const task = this.taskService.start(sessionId, message.content);
        const run: MockRun = { taskId: task.id };
        this.runs.set(sessionId, run);
        this.eventEmitter.fire({ type: 'task-started', sessionId, taskId: task.id });

        const chunks = [
            'Mock run started. ',
            'This provider does not inspect or edit workspace files. ',
            'The application will capture the Task change set and prepare Results.'
        ];
        let nextChunk = 0;

        const streamNext = async (): Promise<void> => {
            if (this.runs.get(sessionId) !== run) {
                return;
            }
            if (nextChunk < chunks.length) {
                this.eventEmitter.fire({
                    type: 'message-delta',
                    sessionId,
                    taskId: task.id,
                    delta: chunks[nextChunk++]
                });
                run.timer = setTimeout(() => void streamNext(), 260);
                return;
            }

            this.eventEmitter.fire({ type: 'message-completed', sessionId, taskId: task.id });
            await this.taskService.end(task.id);
            if (this.runs.get(sessionId) === run) {
                this.runs.delete(sessionId);
                this.eventEmitter.fire({ type: 'task-completed', sessionId, taskId: task.id });
            }
        };

        run.timer = setTimeout(() => void streamNext(), 140);
    }

    async cancel(sessionId: string): Promise<void> {
        const run = this.runs.get(sessionId);
        if (!run) {
            return;
        }
        if (run.timer) {
            clearTimeout(run.timer);
        }
        this.runs.delete(sessionId);
        await this.taskService.cancel(run.taskId);
        this.eventEmitter.fire({
            type: 'task-cancelled',
            sessionId,
            taskId: run.taskId
        });
    }
}
