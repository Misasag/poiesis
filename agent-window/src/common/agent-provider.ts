import { Disposable } from '@theia/core/lib/common';
import { KnownCliId } from './agent-runtime-protocol';

export const AgentProvider = Symbol('AgentProvider');

export interface CreateSessionInput {
    workspaceUri?: string;
    providerId?: KnownCliId;
    model?: string;
}

export interface AgentSession {
    id: string;
    providerName: string;
    providerId?: KnownCliId;
    model?: string;
    workspaceUri?: string;
}

export interface AgentMessage {
    role: 'user';
    content: string;
    /** Stable app-session owner; provider session ids are intentionally ephemeral. */
    ownerSessionId: string;
    /** Application-owned manual grouping selected by the Agent composer. */
    requirementId: string;
}

export type AgentActivityKind = 'command' | 'file-change' | 'read' | 'reasoning' | 'message' | 'tool';
export type AgentActivityStatus = 'running' | 'completed' | 'failed';

export interface AgentActivity {
    id: string;
    kind: AgentActivityKind;
    title: string;
    detail?: string;
    status: AgentActivityStatus;
    startedAt: string;
    endedAt?: string;
}

export type AgentEvent =
    | { type: 'task-started'; sessionId: string; taskId: string }
    | { type: 'activity'; sessionId: string; taskId: string; activity: AgentActivity }
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
