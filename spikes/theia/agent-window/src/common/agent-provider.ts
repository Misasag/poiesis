import { Disposable } from '@theia/core/lib/common';

export const AgentProvider = Symbol('AgentProvider');

export interface CreateSessionInput {
    workspaceUri?: string;
}

export interface AgentSession {
    id: string;
    providerName: string;
    workspaceUri?: string;
}

export interface AgentMessage {
    role: 'user';
    content: string;
}

export type AgentEvent =
    | { type: 'task-started'; sessionId: string; taskId: string }
    | { type: 'message-delta'; sessionId: string; taskId: string; delta: string }
    | { type: 'message-completed'; sessionId: string; taskId: string }
    | { type: 'task-completed'; sessionId: string; taskId: string }
    | { type: 'task-failed'; sessionId: string; taskId: string; summary: string; details?: string }
    | { type: 'task-cancelled'; sessionId: string; taskId: string };

/** Exchangeable boundary used by Agent UI. */
export interface AgentProvider {
    createSession(input: CreateSessionInput): Promise<AgentSession>;
    sendMessage(sessionId: string, message: AgentMessage): Promise<void>;
    cancel(sessionId: string): Promise<void>;
    onEvent(listener: (event: AgentEvent) => void): Disposable;
}
