import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context, ROOT, read, json, write, writeJson, redactor } from '../bin/lib/util.mjs';
import { catalog } from '../bin/lib/prices.mjs';
import { parser, invocation, piAgentDir, PI_THINKING_LEVELS } from '../bin/lib/adapters.mjs';
import { scoreboard, route, policy } from '../bin/lib/route.mjs';
import { append, ledger } from '../bin/lib/ledger.mjs';
import { detectQuota, nextLocalTime, openRouterReservation, recordQuota, quotaState, exhaustedQuota, quotaKey } from '../bin/lib/quota.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-v12-')), ctx = context(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const f of ['budget/limits.json', 'routing/policy.json']) writeJson(path.join(ctx.data, f), json(path.join(ROOT, '.harness', f)));
  return ctx;
}
const piLines = () => read(new URL('fixtures/pi.jsonl', import.meta.url)).trim().split('\n').map(JSON.parse);

test('pi fixture (recorded 2026-09-23 --mode json capture, redacted) sums assistant usage and generation ids', () => {
  const p = parser('pi');
  for (const e of piLines()) p.feed(e);
  // Real capture of the pinned z-ai/glm-5.3-flash hello.txt run: three assistant
  // messages; cacheRead is included in `in` at the uncached input price.
  assert.deepEqual(p.state.tokens, { in: 9001, cached_in: 4096, out: 168, reasoning: 0 });
  assert.equal(p.state.usage_available, true);
  assert.equal(p.state.stop_reason, 'stop');
  assert.equal(p.state.failed, false);
  assert.equal(p.state.session_id, 'pi-fixture-session');
  assert.deepEqual(p.state.generation_ids, ['gen-1790144438-MvkpotiZw4Xix8yUs71T', 'gen-1790144440-fx1rGWNguXe6YC679WYK', 'gen-1790144445-oUoQNLCWxLiwYjA5fOfn']);
  assert.match(p.state.final, /hello\.txt/);
  // pi's catalog-priced estimate equals our own price math on the same tokens.
  assert.ok(Math.abs(p.state.cost_reported_usd - 0.00102455) < 1e-9);
});

test('pi parser requires the last assistant stopReason stop and never trusts exit codes', () => {
  const p = parser('pi');
  p.feed({ type: 'session', id: 's1' });
  p.feed({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, stopReason: 'toolUse' } });
  p.feed({ type: 'message_end', message: { role: 'toolResult', content: [] } });
  assert.equal(p.state.failed, true); assert.equal(p.state.stop_reason, 'toolUse');
  p.feed({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } }, stopReason: 'stop', responseId: 'gen-error-free' } });
  assert.equal(p.state.failed, false); assert.equal(p.state.final, 'done'); assert.deepEqual(p.state.tokens, { in: 15, cached_in: 0, out: 3, reasoning: 0 });
  p.feed({ type: 'compaction_end', result: { usage: { input: 100, output: 0, cacheRead: 50, cacheWrite: 10, cost: { total: 0.002 } } } });
  assert.deepEqual(p.state.tokens, { in: 175, cached_in: 50, out: 3, reasoning: 0 });
  const error = parser('pi');
  error.feed({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '402: credits' } });
  assert.equal(error.state.failed, true); assert.equal(error.state.final, '');
});

test('Thinking efforts map to pi --thinking levels and default omits the flag', () => {
  const model = catalog(context()).find(m => m.id === 'or:glm-5.3-flash');
  const call = (o = {}) => invocation(model, { cwd: '/fixture', promptFile: '/fixture/prompt.md', sessionDir: '/fixture/sessions', effort: 'default', ...o }, () => ({ file: 'fixture-cli', prefix: [] }));
  const fresh = call();
  assert.ok(!fresh.args.includes('--thinking'));
  assert.deepEqual(fresh.args.slice(0, 12), ['-p', '--mode', 'json', '--provider', 'openrouter', '--model', 'z-ai/glm-5.3-flash', '--session-dir', '/fixture/sessions', '--no-extensions', '--no-skills', '--no-prompt-templates']);
  assert.deepEqual(fresh.args.slice(-5), ['--tools', 'read,bash,edit,write', '--session-id', fresh.session_id, '@/fixture/prompt.md']);
  assert.equal(fresh.args.at(-3), '--session-id'); assert.match(fresh.session_id, /^[0-9a-f]{8}-/);
  const highArgs = call({ effort: 'high' }).args;
  assert.deepEqual(highArgs.slice(highArgs.indexOf('--thinking'), highArgs.indexOf('--thinking') + 2), ['--thinking', 'high']);
  for (const level of PI_THINKING_LEVELS) {
    const args = call({ effort: level }).args;
    assert.deepEqual(args.slice(args.indexOf('--thinking'), args.indexOf('--thinking') + 2), ['--thinking', level]);
  }
  assert.throws(() => call({ effort: 'ultra' }), /thinking/);
  // Read-only workers keep the inspection tools; judges run without tools.
  const readOnly = call({ sandbox: 'read-only', effort: 'default' });
  assert.equal(readOnly.args[readOnly.args.indexOf('--tools') + 1], 'read,grep,find,ls');
  const judge = call({ judge: true, effort: 'default' });
  assert.ok(judge.args.includes('--no-tools')); assert.ok(!judge.args.includes('--tools'));
  // Verified resume opens the recorded file by path inside the same session dir.
  const resume = call({ session_id: 'prior', sessionFile: '/fixture/prev/sessions/2026-prior.jsonl' });
  assert.equal(resume.session_id, 'prior');
  assert.deepEqual(resume.args.slice(resume.args.indexOf('--session'), resume.args.indexOf('--session') + 2), ['--session', '/fixture/prev/sessions/2026-prior.jsonl']);
});

test('Committed pi-agent template pins every OpenRouter worker with recorded host choices', () => {
  const models = catalog(context()), overrides = json(new URL('../config/pi-agent/models.json', import.meta.url)).providers.openrouter.modelOverrides;
  const settings = json(new URL('../config/pi-agent/settings.json', import.meta.url));
  assert.equal(settings.cacheWarming, 'off');
  const nativeLower = { 'moonshotai/kimi-k3': 'mxfp4', 'moonshotai/kimi-k2.7-code': 'int4' };
  const noQuantizationFilter = ['qwen/qwen3.8-max-0902', 'qwen/qwen3.8-flash', 'meta/muse-spark-1.3', 'google/gemini-3.8-flash', 'x-ai/grok-4.7'];
  for (const m of models.filter(m => m.id.startsWith('or:'))) {
    const entry = overrides[m.model];
    assert.ok(entry, `missing override for ${m.model}`);
    const routing = entry.compat.openRouterRouting;
    assert.equal(routing.allow_fallbacks, false); assert.equal(routing.require_parameters, true);
    assert.ok(routing.order?.length, `missing provider order for ${m.model}`);
    assert.ok(Number.isInteger(entry.maxTokens) && entry.maxTokens > 0, `missing maxTokens cap for ${m.model}`);
    if (nativeLower[m.model]) assert.deepEqual(routing.quantizations, [nativeLower[m.model], 'fp8', 'bf16']);
    else if (noQuantizationFilter.includes(m.model)) assert.equal(routing.quantizations, undefined, `unknown-quantization endpoint must not be filtered: ${m.model}`);
    else assert.deepEqual(routing.quantizations, ['fp8', 'bf16'], `fp8/bf16 floor expected for ${m.model}`);
    // data_collection deny only where the pinned host supports an opt-out.
    if (routing.data_collection) assert.equal(routing.data_collection, 'deny');
    if (m.model.startsWith('deepseek/')) assert.ok(!routing.data_collection && m.dataNotes.includes('declares training'));
    if (m.model.startsWith('qwen/') || m.model.startsWith('meta/')) assert.ok(!routing.data_collection);
  }
  // Every pin choice is recorded in the CLI notes with its endpoint quantization.
  const notes = read(new URL('../docs/cli-notes.md', import.meta.url));
  for (const m of models.filter(m => m.id.startsWith('or:'))) {
    for (const provider of json(new URL('../config/pi-agent/models.json', import.meta.url)).providers.openrouter.modelOverrides[m.model].compat.openRouterRouting.order)
      assert.ok(new RegExp(`\\|\\s*${m.model.replace(/\./g, '\\.')}\\s*\\|[^\\n]*${provider.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`).test(notes), `pin not documented: ${m.model} ${provider}`);
  }
  assert.ok(/require_parameters/.test(notes));
});

test('piAgentDir regenerates the runtime copy from the committed template', t => {
  const ctx = fixture(t);
  const dir = piAgentDir(ctx);
  assert.equal(dir, path.join(ctx.data, 'pi-agent'));
  assert.deepEqual(json(path.join(dir, 'settings.json')), json(path.join(ctx.plugin, 'config/pi-agent/settings.json')));
  assert.deepEqual(json(path.join(dir, 'models.json')), json(path.join(ctx.plugin, 'config/pi-agent/models.json')));
  write(path.join(dir, 'settings.json'), '{"cacheWarming": "tampered"}');
  assert.equal(json(piAgentDir(ctx) + '/settings.json').cacheWarming, 'off');
  assert.ok(read(path.join(ROOT, '.gitignore')).includes('.harness/pi-agent/'));
  assert.ok(read(path.join(ROOT, '.gitignore')).includes('.harness/budget/quota-state.json'));
});

test('Quota parsers classify fixture stderr per adapter and never leak unknown text', () => {
  const codexLimit = "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:06 PM.";
  const now = new Date('2026-09-23T18:00:00');
  const signal = detectQuota('codex', [codexLimit], now);
  assert.equal(signal.source, 'codex-usage-limit');
  assert.equal(signal.exhausted_until, nextLocalTime(codexLimit, now));
  // 7:06 PM local on the same day for an 18:00 observation; past times roll to tomorrow.
  assert.equal(signal.exhausted_until.startsWith('2026-09-23T19:06:00'), true);
  assert.equal(nextLocalTime('try again at 7:06 PM', new Date('2026-09-23T20:00:00')).startsWith('2026-09-24T19:06:00'), true);
  assert.equal(detectQuota('codex', ['ERROR: something else']), null);
  const claude = detectQuota('claude', ['Your usage limit has been reached. Your limit resets at 11:00 PM (Asia/Tokyo).'], new Date('2026-09-23T18:00:00'));
  assert.equal(claude.source, 'claude-usage-limit'); assert.ok(claude.exhausted_until.startsWith('2026-09-23T23:00:00'));
  assert.equal(detectQuota('claude', ['rate_limit exceeded']).source, 'claude-usage-limit');
  assert.equal(detectQuota('claude', ['ordinary stderr noise']), null);
  // OpenRouter 402 appears as HTTP status or provider error payloads.
  assert.equal(detectQuota('pi', ['OpenRouter HTTP 402']).source, 'openrouter-402');
  assert.equal(detectQuota('pi', ['"errorMessage":"402: {\\"message\\":\\"insufficient credits\\"}"}']).source, 'openrouter-402');
  assert.equal(openRouterReservation(['{"code":402}']), true);
  assert.equal(detectQuota('pi', ['HTTP 404']), null);
  assert.equal(detectQuota('anthropic-compat', ['HTTP 429']).source, 'openrouter-429');
  assert.equal(detectQuota('pi', ['ok']), null);
  assert.equal(detectQuota('grok', ['usage limit']), null);
  // A plain 402-shaped success must not match; lookalikes stay reservations.
  assert.equal(openRouterReservation(['HTTP 4020']), false);
  assert.equal(openRouterReservation(['status: 402']), false);
});

test('Quota state file persists infrastructure events and route falls back to the next candidate', t => {
  const ctx = fixture(t);
  assert.equal(quotaKey('codex'), 'openai'); assert.equal(quotaKey('pi'), 'openrouter'); assert.equal(quotaKey('grok'), null);
  recordQuota(ctx, 'openai', { source: 'codex-usage-limit', exhausted_until: '2099-01-01T00:00:00+09:00' });
  const state = quotaState(ctx);
  assert.equal(state.openai.source, 'codex-usage-limit'); assert.ok(state.openai.seen_at);
  const exhausted = exhaustedQuota(ctx);
  assert.ok(exhausted.openai); assert.equal(Object.keys(exhausted).length, 1);
  // Route skips exhausted models and explains the skip.
  const routed = route(ctx, { role: 'worker-mech', 'task-class': 'mechanical' });
  assert.notEqual(routed.model, 'codex:gpt-6-luna');
  assert.ok(routed.skipped.quota_exhausted.some(s => s.model === 'codex:gpt-6-luna' && s.quota === 'openai'));
  assert.ok(routed.candidates.every(c => !c.model.startsWith('codex:')));
  // A lapsed exhaustion no longer blocks.
  writeJson(path.join(ctx.data, 'budget/quota-state.json'), { openai: { exhausted_until: '2000-01-01T00:00:00Z', source: 'codex-usage-limit', seen_at: '2000-01-01T00:00:00Z' } });
  assert.equal(route(ctx, { role: 'worker-mech', 'task-class': 'mechanical' }).skipped.quota_exhausted.length, 0);
  // Exhausting every candidate family fails with the reason instead of a silent pick.
  recordQuota(ctx, 'anthropic', { source: 'claude-usage-limit' });
  recordQuota(ctx, 'openrouter', { source: 'openrouter-402' });
  assert.throws(() => route(ctx, { role: 'judge', 'exclude-family': ['openai'], 'task-class': 'mechanical' }), /Quota exhausted/);
});

test('Scoreboard and tune exclude quota-infra runs from pass/fail statistics', t => {
  const ctx = fixture(t);
  const base = { ts: '2026-09-23T00:00:00Z', role: 'worker-mech', task_class: 'mechanical', model: 'or:glm-5.3-flash', cost_basis: 'metered', cost_usd_est: 0.01, wall_s: 1 };
  append(ctx, { ...base, run_id: 'quota-run', infra: 'quota_exhausted', exit_code: 1 });
  append(ctx, { kind: 'outcome', run_id: 'quota-run', result: 'fail' });
  append(ctx, { ...base, run_id: 'good-run', exit_code: 0 });
  append(ctx, { kind: 'outcome', run_id: 'good-run', result: 'pass' });
  const rows = scoreboard(ctx).rows.filter(r => r.model === 'or:glm-5.3-flash');
  assert.equal(rows.length, 1); assert.equal(rows[0].n, 1); assert.equal(rows[0].pass, 1); assert.equal(rows[0].fail, 0);
  assert.equal(policy(ctx).version, json(path.join(ROOT, '.harness/routing/policy.json')).version);
});

test('run ledger rows carry adapter pi with pinned-runtime cost reconciliation fields', () => {
  // Static contract check without spawning: the v1.1 reconciliation branch
  // must serve the pi adapter through OPENROUTER_API_KEY as well.
  const source = read(new URL('../bin/lib/run.mjs', import.meta.url));
  assert.ok(source.includes("['pi', 'anthropic-compat'].includes(p.adapter)"));
  assert.ok(source.includes('env.ANTHROPIC_AUTH_TOKEN ?? env.OPENROUTER_API_KEY'));
  assert.ok(source.includes("env.PI_CODING_AGENT_DIR = piAgentDir(ctx)"));
  assert.ok(source.includes("record.infra = 'quota_exhausted'"));
  assert.ok(read(new URL('../bin/lib/bench.mjs', import.meta.url)).includes("'skipped_quota'"));
});
