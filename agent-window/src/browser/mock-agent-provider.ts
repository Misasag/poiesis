import { Emitter } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import {
    AgentEvent,
    AgentMessage,
    AgentProvider,
    AgentSession,
    CreateSessionInput
} from '../common/agent-provider';

/** Chat-only provider. It never reads, writes, or executes within the workspace. */
@injectable()
export class MockAgentProvider implements AgentProvider {
    protected readonly sessions = new Map<string, AgentSession>();
    protected readonly eventEmitter = new Emitter<AgentEvent>();
    protected sequence = 0;

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
        const responseId = `mock-response-${Date.now()}-${++this.sequence}`;
        this.eventEmitter.fire({ type: 'task-started', sessionId, taskId: responseId });
        this.eventEmitter.fire({
            type: 'message-delta',
            sessionId,
            taskId: responseId,
            delta: `モック応答です。「${message.content.slice(0, 80)}」を受け取りました。CLIが未検出のため、Workspaceの読み取り・編集・実行は行っていません。`
        });
        this.eventEmitter.fire({ type: 'message-completed', sessionId, taskId: responseId });
    }

    async cancel(_sessionId: string): Promise<void> { }
}
