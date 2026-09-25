import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCliOutput, sumCliUsage, finishCliCall, CliStdoutBuffer } = require('../agent-window/lib/common/cli-usage.js');
const { captureCliCall } = require('../agent-window/lib/node/cli-call.js');
const { tasksForDurableSession, restoredDurableTaskCandidates } = require('../agent-window/lib/common/session-persistence.js');
const { cliUsageText, formatCliTokens, formatCliDuration, cliModelLabel, CLI_COST_TOOLTIP } = require('../agent-window/lib/browser/cli-usage-display.js');
const { CliUsageLine } = require('../agent-window/lib/browser/components/cli-usage.js');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const codex = [
    { type: 'item.completed', item: { type: 'agent_message', text: '途中の報告' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 4 } },
    { type: 'item.completed', item: { type: 'agent_message', text: '完了しました。\n日本語の最終回答です。' } },
    { type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 6 } }
].map(event => JSON.stringify(event)).join('\n');
const piEvents = [
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '途中' }], stopReason: 'toolUse', usage: { input: 100, output: 30, cacheRead: 10, cacheWrite: 2, cost: { total: 0.0003 } } } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '完了' }], stopReason: 'stop', usage: { input: 200, output: 40, cacheRead: 20, cacheWrite: 3, cost: { total: 0.0006 } } } },
    { type: 'agent_settled' }
].map(JSON.stringify).join('\n');
const pi = parseCliOutput('pi', piEvents);
assert.equal(pi.text, '完了');
assert.equal(pi.failed, undefined);
assert.equal(pi.usage.inputTokens, 300);
assert.equal(pi.usage.cachedInputTokens, 30);
assert.equal(pi.usage.cacheCreationInputTokens, 5);
assert.equal(pi.usage.outputTokens, 70);
assert.equal(pi.usage.costUsd, 0.0009);
assert.equal(pi.usage.costSource, 'cli-estimate');
const compactedPi = parseCliOutput('pi', piEvents.replace('{"type":"agent_settled"}',
    '{"type":"compaction_end","result":{"usage":{"input":4,"output":2,"cacheRead":1,"cost":{"total":0.0001}}}}\n{"type":"agent_settled"}'));
assert.equal(compactedPi.usage.inputTokens, 304);
assert.equal(compactedPi.usage.costUsd, 0.001);
assert.equal(parseCliOutput('pi', piEvents.replace('"stop"', '"error"')).failed, true);
assert.equal(parseCliOutput('pi', piEvents.replace('{"type":"agent_settled"}', '')).failed, true);
// pi streams one message_update per token delta with a fixed envelope; the buffer drops them so a long
// Japanese document stays far below the callers' output limits, whatever the chunk boundaries are.
const piReply = '<!doctype html><html><body><p>' + '回数を表示します。'.repeat(2400) + '</p></body></html>';
const piDelta = delta => JSON.stringify({ type: 'message_update', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta } });
const piStream = [
    JSON.stringify({ type: 'agent_start' }),
    ...Array.from({ length: Math.ceil(piReply.length / 3) }, (_, index) => piDelta(piReply.slice(index * 3, index * 3 + 3))),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: piReply }], stopReason: 'stop', usage: { input: 10, output: 5 } } }),
    JSON.stringify({ type: 'agent_settled' })
].join('\n') + '\n';
assert.ok(piStream.length > 1_120_000, 'the raw pi stream exceeds the Results output limit');
for (const size of [1, 7, 4096, piStream.length]) {
    const buffer = new CliStdoutBuffer('pi');
    for (let offset = 0; offset < piStream.length; offset += size) { buffer.append(piStream.slice(offset, offset + size)); }
    assert.ok(buffer.length < piReply.length * 2, `pi buffer keeps only the events the parser reads (chunk ${size})`);
    assert.equal(buffer.toString().includes('message_update'), false);
    const buffered = parseCliOutput('pi', buffer.toString());
    assert.equal(buffered.text, piReply);
    assert.equal(buffered.failed, undefined);
}
const unterminated = new CliStdoutBuffer('pi');
unterminated.append(piEvents);
assert.equal(unterminated.toString(), piEvents, 'a final line without a newline is kept');
const codexBuffer = new CliStdoutBuffer('codex');
codexBuffer.append(codex.slice(0, 10));
codexBuffer.append(codex.slice(10));
assert.equal(codexBuffer.toString(), codex, 'other CLIs keep stdout unchanged');
const parsed = parseCliOutput('codex', codex);
assert.equal(parsed.text, '完了しました。\n日本語の最終回答です。');
assert.deepEqual(parsed.usage, { inputTokens: 300, cachedInputTokens: 180, outputTokens: 30, reasoningOutputTokens: 10 });
const claudeResult = JSON.parse(readFileSync(new URL('./fixtures/claude-stream-events.jsonl', import.meta.url), 'utf8').trim().split(/\r?\n/).at(-1));
claudeResult.result = '日本語の回答です。';
const claude = parseCliOutput('claude', JSON.stringify(claudeResult, null, 2));
assert.equal(claude.text, '日本語の回答です。');
assert.equal(claude.usage.inputTokens, 58 + 42636 + 11885);
assert.equal(claude.usage.cachedInputTokens, 42636);
assert.equal(claude.usage.cacheCreationInputTokens, 11885);
assert.equal(claude.usage.outputTokens, 124);
assert.equal(claude.usage.costUsd, 0.255139);
assert.equal(claude.usage.costSource, 'cli-estimate');
assert.equal(claude.usage.modelUsage['claude-fable-5-1'].costUsd, 0.255139);
for (const [provider, output] of [['grok', '回答'], ['codex', '{"type":"turn.completed"}'], ['claude', '{"type":"result","result":"回答"}']]) {
    assert.equal(parseCliOutput(provider, output).usage, undefined);
}
assert.equal(sumCliUsage([undefined, undefined]), undefined);
const oneShotUsages = [0, 60, 90, 0].map((cached, index) => parseCliOutput('codex', JSON.stringify({
    type: 'turn.completed', usage: { input_tokens: 100 * (index + 1), cached_input_tokens: cached, output_tokens: 10 }
})).usage);
assert.equal(sumCliUsage(oneShotUsages).cachedInputTokens, 150, 'Cache usage must include generation, judges and regeneration.');
assert.equal(cliUsageText(sumCliUsage(oneShotUsages)), '入力 1k トークン（キャッシュ 15%） · 出力 40');
const zeroCache = sumCliUsage([oneShotUsages[0], oneShotUsages[3]]);
assert.equal(zeroCache.cachedInputTokens, 0);
assert(cliUsageText(zeroCache).includes('キャッシュ 0%'), 'A CLI-reported zero cache value remains visible.');
assert.equal(parseCliOutput('claude', '{broken').text, '');
assert.equal(parseCliOutput('codex', '{"type":"turn.failed"}').failed, true);
assert.equal(parseCliOutput('claude', '{"type":"result","is_error":true}').failed, true);
const record = finishCliCall({ purpose: 'agent', providerId: 'codex', startedAt: '2026-09-23T00:00:00Z' }, parsed.usage, 0, new Date('2026-09-23T00:00:02Z'));
assert.equal(record.durationMs, 2000);
assert.equal(record.exitCode, 0);
const failed = await captureCliCall({ providerId: 'claude' }, 'results-generation', async call => {
    call.parse(JSON.stringify(claudeResult));
    call.exitCode = 1;
    return { status: 'failed' };
});
assert.equal(failed.call.exitCode, 1);
assert.equal(failed.call.usage.costUsd, 0.255139);
assert.equal(failed.call.model, 'claude-fable-5-1');
assert.equal(cliUsageText(undefined), '');
assert.equal(formatCliTokens(1_200_000), '1.2M');
assert.equal(formatCliTokens(18_000), '18k');
assert.equal(formatCliDuration(232_000), '3分52秒');
assert.equal(cliModelLabel('gpt-6-astra'), 'GPT-6-Astra');
assert.equal(cliModelLabel(undefined, 'codex'), 'Codex（モデルはCLI設定）');
assert.equal(cliUsageText({ inputTokens: 1_200_000, cachedInputTokens: 1_104_000, outputTokens: 18_000 }),
    '入力 1.2M トークン（キャッシュ 92%） · 出力 18k');
assert.equal(renderToStaticMarkup(React.createElement(CliUsageLine, {})), '');
assert(!renderToStaticMarkup(React.createElement(CliUsageLine, { usage: parsed.usage })).includes('推定'));
assert(renderToStaticMarkup(React.createElement(CliUsageLine, { usage: pi.usage })).includes('推定 $0.0009'));
const costHtml = renderToStaticMarkup(React.createElement(CliUsageLine, { usage: { costUsd: 0.42 }, partial: true }));
assert(costHtml.includes('推定 $0.42') && costHtml.includes(CLI_COST_TOOLTIP) && costHtml.includes('記録分'));

const legacy = { id: 'saved-task', sessionId: 'session', title: '保存', request: '保存してください。', status: 'completed', startedAt: record.startedAt };
const withUsage = { ...legacy, usage: parsed.usage, cliCalls: [record], resultsDocument: {
    taskId: legacy.id, status: 'ready', html: '<html></html>', calls: [failed.call]
} };
const roundTrip = task => restoredDurableTaskCandidates(JSON.parse(JSON.stringify(tasksForDurableSession([task]))))[0];
assert.deepEqual(roundTrip(withUsage), JSON.parse(JSON.stringify(withUsage)));
assert.equal(roundTrip(legacy).usage, undefined, 'Old sessions must load without a usage migration.');
console.log('CLI_USAGE_TEST=passed');
