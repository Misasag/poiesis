import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parser } from '../bin/lib/adapters.mjs';
import { price } from '../bin/lib/prices.mjs';
import { redactor, resolveEnv, ascii, splitCommand, command } from '../bin/lib/util.mjs';

for (const [adapter, expected] of [['codex', { in: 100, cached_in: 40, out: 20, reasoning: 5 }], ['claude', { in: 160, cached_in: 40, out: 20, reasoning: 0 }], ['grok', { in: 120, cached_in: 20, out: 10, reasoning: 0 }]]) {
  test(`${adapter} usage and final message fixture`, () => {
    const p = parser(adapter);
    for (const line of fs.readFileSync(new URL(`fixtures/${adapter}.jsonl`, import.meta.url), 'utf8').trim().split('\n')) p.feed(JSON.parse(line));
    assert.deepEqual(p.state.tokens, expected); assert.equal(p.state.final, 'done'); assert.ok(p.state.session_id); assert.equal(p.state.failed, false);
  });
}
test('Anthropic-compatible price ignores Claude list-price estimate', () => {
  const p = parser('anthropic-compat'); p.feed({ type: 'result', result: 'ok', usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 }, total_cost_usd: 999 });
  assert.equal(price(p.state.tokens, { inputPerMTok: 1, cachedInputPerMTok: 0.1, outputPerMTok: 2, currency: 'USD' }), 0.000144);
  assert.equal(price(p.state.tokens, null), null);
});
test('Secrets disappear from strings, keys, arrays, and nested logs; token counters remain', () => {
  const redact = redactor({ ZAI_API_KEY: 'private-value', AUTH_TOKEN: 'private-token' });
  const result = redact({ ANTHROPIC_AUTH_TOKEN: 'anything', api_key: 'not-in-env', text: 'prefix private-value private-token', tokens: { in: 12 }, cumulative_tokens: { in: 12 }, usage: { input_tokens: 12 }, children: ['private-token'] });
  assert.ok(!JSON.stringify(result).includes('private-')); assert.equal(result.ANTHROPIC_AUTH_TOKEN, '[REDACTED]'); assert.equal(result.api_key, '[REDACTED]'); assert.equal(result.usage.input_tokens, 12); assert.equal(result.cumulative_tokens.in, 12);
});
test('Environment references resolve only at spawn and relative npm cache stays outside cwd', () => {
  const p = { adapter: 'anthropic-compat', env: { ANTHROPIC_AUTH_TOKEN: '${ENV:EXAMPLE_KEY}', ANTHROPIC_BASE_URL: 'https://example.invalid' } };
  const env = resolveEnv(p, { EXAMPLE_KEY: 'hidden', npm_config_cache: '.npm-cache' });
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'hidden'); assert.match(env.npm_config_cache, /[\\/]\.harness[\\/]tmp[\\/]npm-cache$/);
  assert.throws(() => resolveEnv(p, {}), /Missing/); assert.throws(() => resolveEnv({ adapter: 'claude' }, { ANTHROPIC_BASE_URL: 'https://proxy.invalid' }), /endpoint/);
});
test('ASCII output and command quoting preserve JavaScript literals', async () => {
  assert.match(ascii('日本語'), /^\\u/);
  const cmd = `node -e "process.stdout.write('hello world')"`;
  assert.deepEqual(splitCommand(cmd), ['node', '-e', "process.stdout.write('hello world')"]);
  const r = await command(cmd, process.cwd()); assert.equal(r.exit_code, 0); assert.equal(r.stdout, 'hello world');
  assert.throws(() => splitCommand('node foo && node bar'), /operators/);
  await assert.rejects(command('cmd.exe /d /s /c echo bad', process.cwd()), /forbidden/);
});
test('Missing usage remains unknown and provider errors are failures', () => {
  const p = parser('grok'); p.feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }); assert.equal(p.state.usage_available, false);
  p.feed({ type: 'result', is_error: true }); assert.equal(p.state.failed, true);
});
