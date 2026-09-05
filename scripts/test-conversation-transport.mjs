import assert from 'node:assert/strict';
import {
    boundedAgentConversation,
    buildAgentExecutionPrompt,
    MAX_AGENT_CONTEXT_CHARS,
    MAX_AGENT_CONTEXT_TURNS
} from '../agent-window/lib/common/agent-prompt.js';

const history = [
    { role: 'user', content: '私の名前は花子です。以後この名前を使ってください。' },
    { role: 'assistant', content: '承知しました。' }
];
for (let index = 1; index <= 11; index++) {
    history.push({ role: 'user', content: `確認 ${index} です。` });
    history.push({ role: 'assistant', content: `回答 ${index} です。` });
}
history.push(
    { role: 'user', content: '訂正します。名前は太郎です。' },
    { role: 'assistant', content: '承知しました。訂正後の条件を使います。' }
);

const restoredHistory = JSON.parse(JSON.stringify(history));
const prompt = buildAgentExecutionPrompt('私の名前は何ですか。', restoredHistory);
assert(prompt.includes('私の名前は花子です'));
assert(prompt.includes('名前は太郎です'));
assert(prompt.indexOf('名前は太郎です') > prompt.indexOf('私の名前は花子です'));
assert(prompt.includes('## Current request\n私の名前は何ですか。'));
assert(prompt.includes('<!-- poiesis-outcome: result -->'));

const isolatedPrompt = buildAgentExecutionPrompt('私の名前は何ですか。', []);
assert(!isolatedPrompt.includes('花子'));
assert(!isolatedPrompt.includes('太郎'));

const oversized = Array.from({ length: MAX_AGENT_CONTEXT_TURNS + 8 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `turn-${index}-${'x'.repeat(1_000)}`
}));
const bounded = boundedAgentConversation(oversized);
assert(bounded.length <= MAX_AGENT_CONTEXT_TURNS);
assert(bounded.reduce((total, turn) => total + turn.content.length, 0) <= MAX_AGENT_CONTEXT_CHARS);
assert(bounded.at(-1)?.content.startsWith(`turn-${oversized.length - 1}-`), 'The latest correction must survive bounding.');

console.log('CONVERSATION_TRANSPORT_TEST={"actualPromptBuilder":true,"turnsAfterName":24,"isolated":true,"bounded":true}');
