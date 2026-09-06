export type ConversationSearchSource = 'title' | 'message' | 'draft';

export interface ConversationSearchMessage {
    id: string;
    role: 'user' | 'agent';
    content: string;
}

export interface ConversationSearchSession {
    id: string;
    title: string;
    updatedAt: number;
    archived: boolean;
    hasUserMessage: boolean;
    agentDraft: string;
    messages: readonly ConversationSearchMessage[];
}

export interface ConversationSearchMatch {
    sessionId: string;
    source: ConversationSearchSource;
    messageId?: string;
    sourceLabel?: string;
    excerpt?: string;
}

export interface ConversationSearchResultSet {
    query: string;
    total: number;
    results: ConversationSearchMatch[];
}

export interface HighlightedTextPart {
    text: string;
    highlighted: boolean;
}

export interface PendingConversationReveal {
    version: 1;
    sessionId: string;
    workspaceUri: string;
    source: 'message' | 'draft';
    messageId?: string;
    query: string;
    createdAt: number;
}

export interface PendingConversationRevealStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface PendingConversationRevealContext {
    sessionId: string;
    workspaceUri: string;
}

export const MAX_CONVERSATION_SEARCH_RESULTS = 100;
export const MAX_RECENT_CONVERSATIONS = 20;
export const PENDING_CONVERSATION_REVEAL_KEY = 'poiesis.conversation-search.pending-reveal.v1';
export const PENDING_CONVERSATION_REVEAL_TTL_MS = 120_000;

const SEARCH_EXCERPT_LENGTH = 180;

function folded(value: string): string {
    return value.toLocaleLowerCase();
}

function matchIndex(value: string, query: string): number {
    return folded(value).indexOf(folded(query));
}

function searchableConversation(session: ConversationSearchSession): boolean {
    return session.hasUserMessage
        || Boolean(session.agentDraft.trim())
        || session.messages.some(message => Boolean(message.content.trim()));
}

function matchingExcerpt(value: string, query: string): string {
    const index = matchIndex(value, query);
    const radius = Math.max(0, Math.floor((SEARCH_EXCERPT_LENGTH - query.length) / 2));
    const start = Math.max(0, index - radius);
    const end = Math.min(value.length, index + query.length + radius);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < value.length ? '…' : '';
    return `${prefix}${value.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

function matchConversation(session: ConversationSearchSession, query: string): ConversationSearchMatch | undefined {
    if (query) {
        if (matchIndex(session.agentDraft, query) >= 0) {
            return {
                sessionId: session.id,
                source: 'draft',
                sourceLabel: '下書き',
                excerpt: matchingExcerpt(session.agentDraft, query)
            };
        }
        const message = [...session.messages].reverse().find(candidate => matchIndex(candidate.content, query) >= 0);
        if (message) {
            return {
                sessionId: session.id,
                source: 'message',
                messageId: message.id,
                sourceLabel: message.role === 'user' ? 'あなた' : 'Agent',
                excerpt: matchingExcerpt(message.content, query)
            };
        }
        if (matchIndex(session.title, query) >= 0) {
            return { sessionId: session.id, source: 'title' };
        }
        return undefined;
    }
    return { sessionId: session.id, source: 'title' };
}

export function searchConversations(
    sessions: readonly ConversationSearchSession[],
    rawQuery: string,
    limit?: number
): ConversationSearchResultSet {
    const query = rawQuery.trim();
    const matches = sessions
        .filter(searchableConversation)
        .map(session => ({ session, match: matchConversation(session, query) }))
        .filter((candidate): candidate is { session: ConversationSearchSession; match: ConversationSearchMatch } =>
            Boolean(candidate.match))
        .sort((left, right) => right.session.updatedAt - left.session.updatedAt
            || left.session.id.localeCompare(right.session.id));
    const resultLimit = Math.max(1, Math.floor(limit ?? (query
        ? MAX_CONVERSATION_SEARCH_RESULTS
        : MAX_RECENT_CONVERSATIONS)));
    return {
        query,
        total: matches.length,
        results: matches.slice(0, resultLimit).map(candidate => candidate.match)
    };
}

export function splitHighlightedText(value: string, rawQuery: string): HighlightedTextPart[] {
    const query = rawQuery.trim();
    if (!query) {
        return [{ text: value, highlighted: false }];
    }
    const parts: HighlightedTextPart[] = [];
    const foldedValue = folded(value);
    const foldedQuery = folded(query);
    let cursor = 0;
    let index = foldedValue.indexOf(foldedQuery);
    while (index >= 0) {
        if (index > cursor) {
            parts.push({ text: value.slice(cursor, index), highlighted: false });
        }
        parts.push({ text: value.slice(index, index + query.length), highlighted: true });
        cursor = index + query.length;
        index = foldedValue.indexOf(foldedQuery, cursor);
    }
    if (cursor < value.length) {
        parts.push({ text: value.slice(cursor), highlighted: false });
    }
    return parts.length ? parts : [{ text: value, highlighted: false }];
}

export function storePendingConversationReveal(
    storage: PendingConversationRevealStorage,
    reveal: Omit<PendingConversationReveal, 'version' | 'createdAt'>,
    now = Date.now()
): boolean {
    if (!validPendingRevealFields({ ...reveal, version: 1, createdAt: now })) {
        return false;
    }
    try {
        storage.setItem(PENDING_CONVERSATION_REVEAL_KEY, JSON.stringify({
            ...reveal,
            version: 1,
            createdAt: now
        }));
        return true;
    } catch {
        return false;
    }
}

export function takePendingConversationReveal(
    storage: PendingConversationRevealStorage,
    context: PendingConversationRevealContext,
    now = Date.now()
): PendingConversationReveal | undefined {
    let raw: string | null;
    try {
        raw = storage.getItem(PENDING_CONVERSATION_REVEAL_KEY);
        storage.removeItem(PENDING_CONVERSATION_REVEAL_KEY);
    } catch {
        return undefined;
    }
    if (!raw) {
        return undefined;
    }
    try {
        const candidate = JSON.parse(raw) as PendingConversationReveal;
        if (!validPendingRevealFields(candidate)
            || candidate.sessionId !== context.sessionId
            || candidate.workspaceUri !== context.workspaceUri
            || candidate.createdAt > now + 5_000
            || now - candidate.createdAt > PENDING_CONVERSATION_REVEAL_TTL_MS) {
            return undefined;
        }
        return candidate;
    } catch {
        return undefined;
    }
}

export function clearPendingConversationReveal(storage: PendingConversationRevealStorage): void {
    try {
        storage.removeItem(PENDING_CONVERSATION_REVEAL_KEY);
    } catch {
        // The transient reveal must never block ordinary navigation.
    }
}

function validPendingRevealFields(candidate: Partial<PendingConversationReveal>): candidate is PendingConversationReveal {
    return candidate.version === 1
        && typeof candidate.sessionId === 'string'
        && candidate.sessionId.length > 0
        && candidate.sessionId.length <= 512
        && typeof candidate.workspaceUri === 'string'
        && candidate.workspaceUri.length > 0
        && candidate.workspaceUri.length <= 4_096
        && (candidate.source === 'message' || candidate.source === 'draft')
        && (candidate.source === 'draft'
            || typeof candidate.messageId === 'string' && candidate.messageId.length > 0 && candidate.messageId.length <= 512)
        && typeof candidate.query === 'string'
        && candidate.query.trim().length > 0
        && candidate.query.length <= 500
        && typeof candidate.createdAt === 'number'
        && Number.isFinite(candidate.createdAt);
}
