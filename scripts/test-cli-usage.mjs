import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCliOutput, sumCliUsage, finishCliCall } = require('../agent-window/lib/common/cli-usage.js');
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
