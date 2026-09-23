import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context, ROOT, read, json, writeJson } from '../bin/lib/util.mjs';
import { parser } from '../bin/lib/adapters.mjs';
import { provider } from '../bin/lib/prices.mjs';
import { costCapMonitor } from '../bin/lib/costcap.mjs';
import { budgetCheck } from '../bin/lib/budget.mjs';
import { append, outcome } from '../bin/lib/ledger.mjs';
import { scoreboard } from '../bin/lib/route.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-v13-')), ctx = context(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(ctx.data, 'budget/limits.json'), json(path.join(ROOT, '.harness/budget/limits.json')));
  return ctx;
}
const lines = name => read(new URL(`fixtures/${name}`, import.meta.url)).trim().split('\n').map(JSON.parse);

test('Cost-cap accumulator sums pi assistant spend and decides the kill from fixture events', () => {
  const events = lines('pi.jsonl');
  const cap = costCapMonitor(parser('pi'), 'pi', null, 0.0005);
  let firstExceed = -1, last;
  events.forEach((e, i) => { last = cap.feed(e); if (last.exceeded && firstExceed < 0) firstExceed = i; });
  // The kill decision trips mid-stream, at the first assistant message that
  // crosses the cap, and the accumulator keeps summing after it.
  assert.ok(firstExceed >= 0);
  assert.ok(Math.abs(last.usd - 0.00102455) < 1e-9);
  assert.equal(last.exceeded, true);
  // A generous cap never trips on the same events; a null cap is disabled.
  const safe = costCapMonitor(parser('pi'), 'pi', null, 1);
  for (const e of events) last = safe.feed(e);
  assert.equal(last.exceeded, false);
  const off = costCapMonitor(parser('pi'), 'pi', null, null);
  assert.equal(off.cap_usd, null);
  for (const e of events) last = off.feed(e);
  assert.equal(last.exceeded, false);
});

test('Cost-cap accumulator prices anthropic-compat tokens live from the catalog', () => {
  const prices = { inputPerMTok: 1, cachedInputPerMTok: 0.1, outputPerMTok: 2, currency: 'USD' };
  const cap = costCapMonitor(parser('anthropic-compat'), 'anthropic-compat', prices, 0.0001);
  let last;
  for (const e of lines('claude.jsonl')) last = cap.feed(e);
  assert.ok(Math.abs(last.usd - 0.000164) < 1e-12);
  assert.equal(last.exceeded, true);
  const safe = costCapMonitor(parser('anthropic-compat'), 'anthropic-compat', prices, 0.001);
  for (const e of lines('claude.jsonl')) last = safe.feed(e);
  assert.equal(last.exceeded, false);
});

test('Budget check reserves the per-run cap, not only the historical mean', t => {
  const ctx = fixture(t), now = new Date('2026-09-23T12:00:00Z'), model = 'or:glm-5.3-flash';
  writeJson(path.join(ctx.data, 'budget/limits.json'), { metered: { monthly_usd: 30, daily_usd: 1, per_run_usd: 1, conservative_default_usd: 0.05 }, quota: null });
  append(ctx, { run_id: 'cheap', ts: '2026-09-23T01:00:00Z', model, role: 'worker', task_class: 'mechanical', cost_basis: 'metered', cost_usd_actual: 0.05, wall_s: 1 });
  const p = provider(ctx, model);
  // Without a cap the recent mean (0.05) fits the remaining daily budget.
  const mean = budgetCheck(ctx, p, undefined, now);
  assert.equal(mean.allowed, true); assert.equal(mean.estimate_usd, 0.05);
  // With the per-run cap the reservation is the cap, so it is refused.
  const capped = budgetCheck(ctx, p, undefined, now, { capUsd: 1 });
  assert.equal(capped.reservation_usd, 1); assert.equal(capped.allowed, false);
  // In-flight concurrent reservations reduce the remaining budget.
  assert.equal(budgetCheck(ctx, p, undefined, now, { capUsd: 0.5, reservedUsd: 0.5 }).allowed, false);
  assert.equal(budgetCheck(ctx, p, undefined, now, { capUsd: 0.3, reservedUsd: 0.5 }).allowed, true);
  assert.equal(budgetCheck(ctx, p, 0.01, now, { capUsd: 1 }).allowed, false);
});

test('Timeout outcomes count as fail for pass rate and are reported separately', t => {
  const ctx = fixture(t);
  const entry = (runId, wall_s) => append(ctx, { run_id: runId, ts: '2026-09-23T00:00:00Z', role: 'worker', task_class: 'mechanical', model: 'or:glm-5.3-flash', cost_basis: 'metered', cost_usd_est: 0.01, wall_s });
  entry('fast', 5); entry('slow', 1300);
  outcome(ctx, 'fast', 'pass'); outcome(ctx, 'slow', 'timeout', 'timeout: exceeded the 20 min wall cap before completing acceptance');
  const row = scoreboard(ctx).rows[0];
  assert.equal(row.n, 2); assert.equal(row.pass, 1); assert.equal(row.fail, 1); assert.equal(row.timeout, 1);
  assert.ok(row.beta > 1);
  // The bench infrastructure labels are valid ledger outcomes; bogus values fail.
  outcome(ctx, 'fast', 'skipped_quota', 'Infrastructure: openrouter-402');
  assert.equal(scoreboard(ctx).rows.filter(r => r.model === 'or:glm-5.3-flash').length, 1);
  assert.equal(scoreboard(ctx).rows[0].n, 1);
  assert.throws(() => outcome(ctx, 'fast', 'bogus'), /Outcome must be/);
});
