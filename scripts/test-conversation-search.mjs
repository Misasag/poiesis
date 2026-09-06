import assert from 'node:assert/strict';

const {
    MAX_CONVERSATION_SEARCH_RESULTS,
    PENDING_CONVERSATION_REVEAL_TTL_MS,
    searchConversations,
    splitHighlightedText,
    storePendingConversationReveal,
    takePendingConversationReveal
} = await import('../agent-window/lib/browser/agent-window/conversation-search.js');

const sessions = [
    {
        id: 'older-title', title: '認証フローを修正', updatedAt: 100, archived: false, hasUserMessage: true,
        agentDraft: '', messages: [{ id: 'm1', role: 'user', content: 'ログイン画面を直してください' }]
    },
    {
        id: 'newer-message', title: '決済画面', updatedAt: 300, archived: false, hasUserMessage: true,
        agentDraft: '', messages: [{ id: 'm2', role: 'agent', content: '認証トークンの検証を追加しました' }]
    },
    {
        id: 'draft', title: '新しい会話', updatedAt: 200, archived: false, hasUserMessage: false,
        agentDraft: '認証エラーを調査する', messages: []
    },
    {
        id: 'archived', title: '古い会話', updatedAt: 400, archived: true, hasUserMessage: true,
        agentDraft: '保存途中の本文', messages: [{ id: 'm3', role: 'user', content: '<img onerror="fail"> 認証の記録' }]
    },
    {
        id: 'empty', title: '新しい会話', updatedAt: 999, archived: false, hasUserMessage: false,
        agentDraft: '   ', messages: []
    }
];

const matches = searchConversations(sessions, '認証');
assert.deepEqual(matches.results.map(result => result.sessionId), [
    'archived', 'newer-message', 'draft', 'older-title'
], 'Matches must be ordered by actual activity time across active, draft, and archived conversations');
assert.equal(matches.results.find(result => result.sessionId === 'draft')?.source, 'draft');
assert.equal(matches.results.find(result => result.sessionId === 'newer-message')?.messageId, 'm2');
assert.match(matches.results[0].excerpt, /<img onerror="fail">/,
    'Snippets must remain plain text so the React renderer, rather than generated HTML, escapes them');

const highlighted = splitHighlightedText('<script>認証</script>', '認証');
assert.deepEqual(highlighted, [
    { text: '<script>', highlighted: false },
    { text: '認証', highlighted: true },
    { text: '</script>', highlighted: false }
]);

const recent = searchConversations(sessions, '', 10);
assert.deepEqual(recent.results.map(result => result.sessionId), [
    'archived', 'newer-message', 'draft', 'older-title'
], 'Empty searches must show recent stored conversations and omit empty placeholders');

const archivedDraft = searchConversations(sessions, '保存途中');
assert.deepEqual(archivedDraft.results, [{
    sessionId: 'archived',
    source: 'draft',
    sourceLabel: '下書き',
    excerpt: '保存途中の本文'
}], 'Saved drafts in archived conversations must remain searchable');

const many = Array.from({ length: MAX_CONVERSATION_SEARCH_RESULTS + 5 }, (_, index) => ({
    id: `session-${index}`,
    title: `Needle ${index}`,
    updatedAt: index,
    archived: false,
    hasUserMessage: true,
    agentDraft: '',
    messages: []
}));
const bounded = searchConversations(many, 'needle');
assert.equal(bounded.total, MAX_CONVERSATION_SEARCH_RESULTS + 5);
assert.equal(bounded.results.length, MAX_CONVERSATION_SEARCH_RESULTS);

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
    };
}

const now = 1_000_000;
const storage = memoryStorage();
const reveal = {
    sessionId: 'foreign-session',
    workspaceUri: 'file:///foreign',
    source: 'message',
    messageId: 'message-0',
    query: 'unique target'
};
assert.equal(storePendingConversationReveal(storage, reveal, now), true);
assert.equal(takePendingConversationReveal(storage, {
    sessionId: reveal.sessionId,
    workspaceUri: 'file:///another-workspace'
}, now), undefined, 'A reveal must only be consumed in its exact workspace');
assert.equal(takePendingConversationReveal(storage, {
    sessionId: reveal.sessionId,
    workspaceUri: reveal.workspaceUri
}, now), undefined, 'A mismatched reveal must be discarded rather than applied after later navigation');

assert.equal(storePendingConversationReveal(storage, reveal, now), true);
assert.deepEqual(takePendingConversationReveal(storage, {
    sessionId: reveal.sessionId,
    workspaceUri: reveal.workspaceUri
}, now), { ...reveal, version: 1, createdAt: now });
assert.equal(takePendingConversationReveal(storage, {
    sessionId: reveal.sessionId,
    workspaceUri: reveal.workspaceUri
}, now), undefined, 'A matching reveal must be one-shot');

assert.equal(storePendingConversationReveal(storage, {
    sessionId: 'draft-session',
    workspaceUri: 'file:///foreign',
    source: 'draft',
    query: '下書き一致'
}, now), true, 'Draft reveals do not require a message id');
assert.equal(takePendingConversationReveal(storage, {
    sessionId: 'draft-session',
    workspaceUri: 'file:///foreign'
}, now + PENDING_CONVERSATION_REVEAL_TTL_MS + 1), undefined, 'Expired reveals must not survive later navigation');

console.log('Conversation search tests passed.');
