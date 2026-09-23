import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context, writeJson } from '../bin/lib/util.mjs';
import { append } from '../bin/lib/ledger.mjs';
import { costReport, formatCost } from '../bin/lib/cost.mjs';
import { listPrice, pricesFromModel, refreshPrices, LIST_SOURCE } from '../bin/lib/prices.mjs';
import { route } from '../bin/lib/route.mjs';
import { seedLocalData } from './fixtures/local-data.mjs';

const now = new Date('2026-09-23T12:00:00Z');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-v15-')), ctx = context(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seedLocalData(ctx);
  ctx.accountStatus = async () => ({ status: 'unavailable' });
  return ctx;
}

test('API-equivalent price uses uncached input, cached input and output; missing usage remains unknown', () => {
  const p = { list_prices: pricesFromModel({ pricing: { prompt: '0.000002', input_cache_read: '0.0000002', completion: '0.00001' } }, '2026-09-23') };
  assert.equal(p.list_prices.source, LIST_SOURCE);
  assert.equal(listPrice({ in: 1_000_000, cached_in: 250_000, out: 100_000 }, p), 2.55);
  assert.equal(listPrice(null, p), null);
  assert.equal(listPrice({ in: 0, cached_in: 1, out: 0 }, p), null);
});

test('Cost report aggregates measured runs, ignores unknown tokens, and shows break-even fees and same-class alternatives', async t => {
  const ctx = fixture(t), tokens = { in: 1_000_000, cached_in: 200_000, out: 100_000 };
  append(ctx, { run_id: 'quota-pass', ts: '2026-09-23T01:00:00Z', role: 'worker-design', task_class: 'app-frontend', model: 'codex:gpt-6-luna', adapter: 'codex', cost_basis: 'quota', tokens, wall_s: 20 });
  append(ctx, { run_id: 'quota-unknown', ts: '2026-09-23T02:00:00Z', role: 'worker-design', task_class: 'app-frontend', model: 'codex:gpt-6-luna', adapter: 'codex', cost_basis: 'quota', tokens: { in: 0, cached_in: 0, out: 0 }, wall_s: 10 });
  append(ctx, { run_id: 'paid-pass', ts: '2026-09-23T03:00:00Z', role: 'worker-design', task_class: 'app-frontend', model: 'or:glm-5.3-flash', adapter: 'pi', cost_basis: 'metered', cost_usd_actual: .25, cost_usd_est: .5, wall_s: 30 });
  append(ctx, { run_id: 'paid-estimate', ts: '2026-09-23T04:00:00Z', role: 'worker-design', task_class: 'app-frontend', model: 'or:glm-5.3-flash', adapter: 'pi', cost_basis: 'metered', cost_usd_est: .1, wall_s: 40 });
  append(ctx, { kind: 'outcome', run_id: 'quota-pass', result: 'pass', ts: '2026-09-23T05:00:00Z' });
  append(ctx, { kind: 'outcome', run_id: 'paid-pass', result: 'pass', ts: '2026-09-23T05:00:01Z' });
  append(ctx, { run_id: 'quota-block', ts: '2026-09-23T06:00:00Z', model: 'codex:gpt-6-luna', adapter: 'codex', cost_basis: 'quota', infra: 'quota_exhausted', quota_exhausted_until: '2026-09-23T08:00:00Z', tokens: null });
  const report = await costReport(ctx, {}, now), sub = report.subscriptions[0];
  assert.equal(sub.runs, 3); assert.equal(sub.unknown_token_runs, 2);
  assert.equal(sub.api_equivalent_usd, .132); assert.equal(sub.monthly_fee_usd, null);
  assert.equal(sub.break_even_fee_usd, .132); assert.equal(sub.quota_exhaustion_events, 1); assert.equal(sub.hours_blocked, 2);
  assert.equal(sub.cheapest_passing_alternatives[0].model, 'or:glm-5.3-flash');
  assert.equal(report.metered.find(r => r.model === 'or:glm-5.3-flash').spend_usd, .35);
  assert.equal(report.by_role_model.find(r => r.model === 'codex:gpt-6-luna').median_cost_per_pass_usd, .132);
  assert.match(formatCost(report), /break_even=\$0\.1320/);
});

test('Quota-first zeroes marginal utility cost and exhausted quota candidates are skipped', t => {
  const ctx = fixture(t);
  append(ctx, { run_id: 'costly-quota', ts: now.toISOString(), role: 'worker-design', task_class: 'app-frontend', model: 'codex:gpt-6-astra', cost_basis: 'quota', cost_usd_est: 100, wall_s: 10 });
  append(ctx, { kind: 'outcome', run_id: 'costly-quota', result: 'pass', ts: now.toISOString() });
  const selected = route(ctx, { role: 'worker-design', 'task-class': 'app-frontend', ticket: 'quota-first-fixture' });
  const candidate = selected.candidates.find(r => r.model === 'codex:gpt-6-astra');
  assert.equal(candidate.pricing_rule, 'quota_first: zero marginal cost');
  assert.equal(candidate.utility, candidate.p_pass - .0001 * 10);
  writeJson(path.join(ctx.data, 'budget/quota-state.json'), { openai: { seen_at: now.toISOString(), exhausted_until: '2026-09-23T13:00:00Z', source: 'test' } });
  const fallback = route(ctx, { role: 'worker-design', 'task-class': 'app-frontend', ticket: 'quota-first-fixture' });
  assert.equal(fallback.candidates.some(r => r.model.startsWith('codex:')), false);
  assert.ok(fallback.skipped.quota_exhausted.length > 0);
});

test('Blocked hours include an exhaustion interval carried into the month', async t => {
  const ctx = fixture(t);
  append(ctx, { run_id: 'prior-block', ts: '2026-08-31T23:00:00Z', adapter: 'codex', cost_basis: 'quota', infra: 'quota_exhausted' });
  writeJson(path.join(ctx.data, 'budget/quota-state.json'), { openai: {
    seen_at: '2026-08-31T23:00:05Z', exhausted_until: '2026-09-01T02:00:00Z', source: 'test' } });
  const sub = (await costReport(ctx, {}, now)).subscriptions[0];
  assert.equal(sub.quota_exhaustion_events, 0);
  assert.equal(sub.hours_blocked, 2);
});

test('Price refresh keeps catalog intact when network is unavailable', async t => {
  const ctx = fixture(t), before = fs.readFileSync(path.join(ctx.plugin, 'config/providers.json'), 'utf8');
  const result = await refreshPrices(ctx, async () => { throw new Error('offline'); });
  assert.equal(result.status, 'unavailable');
  assert.equal(fs.readFileSync(path.join(ctx.plugin, 'config/providers.json'), 'utf8'), before);
});
