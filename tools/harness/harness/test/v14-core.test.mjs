import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context, ROOT, read, json, write, writeJson, git } from '../bin/lib/util.mjs';
import { budgetCheck, meteredBudgetStatus } from '../bin/lib/budget.mjs';
import { accountStatus } from '../bin/lib/openrouter.mjs';
import { parser } from '../bin/lib/adapters.mjs';
import { routingConfigError, ROUTING_HINT } from '../bin/lib/infra.mjs';
import { run } from '../bin/lib/run.mjs';
import { append, ledger, outcome, runDir } from '../bin/lib/ledger.mjs';
import { scoreboard, tune } from '../bin/lib/route.mjs';

const now = new Date('2026-09-23T12:00:00Z'), metered = { id: 'metered', costBasis: 'metered' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-v14-')), ctx = context(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(ctx.data, 'budget/limits.json'), { metered: { monthly_usd: 30, daily_usd: 5, per_run_usd: 1, conservative_default_usd: .5 } });
  writeJson(path.join(ctx.data, 'routing/policy.json'), json(path.join(ROOT, '.harness/routing/policy.json')));
  ctx.accountStatus = async () => ({ status: 'unavailable' });
  return ctx;
}
const account = (usage, remaining = 100, credits = 100) => ({ status: 'available', account: { status: 'available', usage, limit_remaining: remaining }, credits: { status: 'available', total_credits: credits + usage, total_usage: usage } });
const baseline = (ctx, month, usage) => writeJson(path.join(ctx.data, 'budget/openrouter-baseline.json'), { month, usage });

test('Metered check uses larger ledger/account month, persists the first UTC observation, and rolls months', async t => {
  const ctx = fixture(t), file = path.join(ctx.data, 'budget/openrouter-baseline.json');
  let usage = 11.45;
  ctx.accountStatus = async () => account(usage);
  append(ctx, { ts: now.toISOString(), model: 'metered', cost_basis: 'metered', cost_usd_actual: 2.34 });
  const first = await budgetCheck(ctx, metered, .5, now);
  assert.equal(first.ledger_month_usd, 2.34); assert.equal(first.month_usd, 11.45); assert.equal(first.monthly_source, 'openrouter');
  assert.equal(json(file).usage, 11.45); assert.equal(json(file).month, '2026-09');
  usage = 12.45;
  const next = await meteredBudgetStatus(ctx, now);
  assert.equal(next.openrouter.month_usd, 1); assert.equal(next.month_usd, 2.34); assert.equal(next.monthly_source, 'ledger');
  assert.equal(json(file).usage, 11.45, 'never move the first observation');
  usage = 42;
  assert.equal((await budgetCheck(ctx, metered, .5, now)).allowed, false);
  const october = new Date('2026-10-01T00:00:00Z');
  const rolled = await meteredBudgetStatus(ctx, october);
  assert.equal(rolled.month_usd, 42, 'missing new-month baseline uses total for this check');
  assert.equal(json(file).month, '2026-10'); assert.equal(json(file).usage, 42);
  usage = 43;
  assert.equal((await meteredBudgetStatus(ctx, october)).openrouter.month_usd, 1);
});

test('OpenRouter key and account credits are hard ceilings, including partial responses and zero credit', async t => {
  const ctx = fixture(t); baseline(ctx, '2026-09', 10);
  for (const [key, credit, expected] of [[.2, 100, .2], [100, .25, .25], [0, 100, 0], [100, 0, 0], [-1, 100, 0]]) {
    ctx.accountStatus = async () => account(10, key, credit);
    const check = await budgetCheck(ctx, metered, .5, now);
    assert.equal(check.allowed, false); assert.equal(check.remaining_usd, expected); assert.equal(check.binding, 'openrouter_credit');
    assert.equal(check.blocked_by_reservations, false);
  }
  ctx.accountStatus = () => accountStatus({ request: async endpoint => {
    if (endpoint.endsWith('/key')) throw new Error('offline key');
    return { data: { total_credits: 10, total_usage: 9.75 } };
  } });
  const partial = await budgetCheck(ctx, metered, .5, now);
  assert.equal(partial.allowed, false); assert.equal(partial.remaining_usd, .25);
  assert.match(partial.monthly_source, /fallback/); assert.equal(partial.openrouter.status, 'partial');
  ctx.accountStatus = async () => ({ ...account(10, .5), credits: { status: 'unavailable' } });
  assert.equal((await budgetCheck(ctx, metered, .5, now)).allowed, true);
});

test('Network failure falls back explicitly to ledger; quota checks never fetch or create baselines', async t => {
  const ctx = fixture(t); let calls = 0;
  ctx.accountStatus = async () => { calls++; throw new Error('fixture offline'); };
  append(ctx, { ts: now.toISOString(), cost_basis: 'metered', cost_usd_actual: 4.75 });
  const check = await budgetCheck(ctx, metered, .5, now);
  assert.equal(check.allowed, false); assert.equal(check.month_usd, 4.75); assert.equal(check.binding, 'daily');
  assert.match(check.monthly_source, /OpenRouter unavailable; fallback/);
  assert.equal(check.openrouter.status, 'unavailable'); assert.equal(check.openrouter.remaining_usd, null);
  assert.equal((await budgetCheck(ctx, { id: 'quota', costBasis: 'quota' }, undefined, now)).allowed, true);
  assert.equal(calls, 1); assert.equal(fs.existsSync(path.join(ctx.data, 'budget/openrouter-baseline.json')), false);
});

test('Baseline corruption, contention, and a decreased counter conservatively use total usage', async t => {
  const ctx = fixture(t), file = path.join(ctx.data, 'budget/openrouter-baseline.json');
  ctx.accountStatus = async () => account(12);
  write(file, 'broken'); assert.equal((await meteredBudgetStatus(ctx, now)).openrouter.month_usd, 12);
  baseline(ctx, '2026-09', 15);
  assert.equal((await meteredBudgetStatus(ctx, now)).openrouter.month_usd, 12); assert.equal(json(file).usage, 15);
  write(`${file}.lock`, '');
  assert.equal((await meteredBudgetStatus(ctx, now)).openrouter.month_usd, 12);
  assert.equal(fs.existsSync(`${file}.lock`), true, 'never remove another process lock');
});

const routingPayload = { message: 'No endpoints found. Every candidate endpoint was removed during routing.', code: 404,
  metadata: { routing_funnel: [{ step: 'Initial Endpoints', endpoint_count: 2 }, { step: 'Filter by Guardrails', endpoint_count: 1 }, { step: 'Filter by Fallback', endpoint_count: 0 }], failed_routing_step: 'Filter by Fallback' } };
const routingMessage = () => `404: ${JSON.stringify(routingPayload)}`;
const errorEvent = () => ({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: routingMessage(), content: [] } });

test('pi routing errors preserve the failing step without classifying prose, tools or ordinary 404s', () => {
  const p = parser('pi'); p.feed(errorEvent());
  assert.equal(p.state.failed, true); assert.equal(p.state.routing_error.infra, 'routing_config');
  assert.equal(p.state.routing_error.routing_step, 'Filter by Fallback');
  const fallback = structuredClone(routingPayload); delete fallback.metadata.failed_routing_step;
  assert.equal(routingConfigError(fallback).routing_step, 'Filter by Fallback');
  for (const event of [
    { type: 'tool_execution_end', result: routingPayload },
    { type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: routingMessage() }] } },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: routingMessage() }] } }
  ]) { const ordinary = parser('pi'); ordinary.feed(event); assert.equal(ordinary.state.routing_error, null); }
  assert.equal(routingConfigError('404: missing file'), null);
  assert.equal(routingConfigError({ ...routingPayload, code: 402 }), null);
  assert.equal(routingConfigError({ ...routingPayload, metadata: {} }), null);
  p.feed({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Recovered' }] } });
  assert.equal(p.state.failed, false); assert.equal(p.state.routing_error, null);
});

test('Fake pi run records routing infrastructure and hint in its returned output, ledger and meta; scores/tune ignore it', async t => {
  const ctx = fixture(t);
  await git(ctx.root, ['init', '--quiet']);
  const brief = path.join(ctx.data, 'brief.md'); write(brief, 'Acceptance: exit 0');
  const record = await run(ctx, { model: 'or:glm-5.3-flash', cwd: ctx.root, brief }, {
    env: { OPENROUTER_API_KEY: 'fixture-routing-secret' },
    invocation: () => ({ file: 'fake-pi', args: [] }),
    exec: async (_file, _args, options) => { options.onStdout(JSON.stringify(errorEvent()) + '\n'); return { exit_code: 0, stdout: '', stderr: '' }; },
    generationCosts: async ids => { assert.deepEqual(ids, []); return { cost_usd_actual: 0 }; }
  });
  assert.equal(record.exit_code, 1); assert.equal(record.infra, 'routing_config');
  assert.equal(record.routing_step, 'Filter by Fallback'); assert.equal(record.hint, ROUTING_HINT);
  assert.equal(ledger(ctx)[0].infra, 'routing_config');
  assert.equal(json(path.join(runDir(ctx, record.run_id), 'meta.json')).routing_step, 'Filter by Fallback');
  assert.equal(read(path.join(ctx.data, 'ledger/runs.jsonl')).includes('fixture-routing-secret'), false);
  outcome(ctx, record.run_id, 'fail'); // Even an accidental fail outcome cannot pollute statistics.
  assert.deepEqual(scoreboard(ctx).rows, []); assert.deepEqual(tune(ctx).proposals, []);
  outcome(ctx, record.run_id, 'skipped_routing');
  assert.deepEqual(scoreboard(ctx).rows, []);
});
