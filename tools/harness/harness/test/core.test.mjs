import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context, writeJson, PLUGIN, write, inside } from '../bin/lib/util.mjs';
import { append, ledger, outcome } from '../bin/lib/ledger.mjs';
import { budgetCheck, requireBudget } from '../bin/lib/budget.mjs';
import { scoreboard, decay, betaQuantile, route, promotion, tune } from '../bin/lib/route.mjs';
import { grounded, reconcile, validateVerdict, calibration } from '../bin/lib/judge.mjs';
import { sessionFacts, SESSION_KEY } from '../bin/lib/dogfood.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-core-')), ctx = context(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(ctx.data, 'budget/limits.json'), { metered: { monthly_usd: 5, daily_usd: 2, per_run_usd: 1, conservative_default_usd: 1 }, quota: { per_model_runs_per_day: { 'codex:gpt-6-luna': 1 } } });
  fs.mkdirSync(path.join(ctx.data, 'routing'), { recursive: true }); fs.copyFileSync(path.resolve(PLUGIN, '../../../.harness/routing/policy.json'), path.join(ctx.data, 'routing/policy.json'));
  return ctx;
}
function entry(model, runId, extra = {}) { return { run_id: runId, ts: new Date().toISOString(), role: 'worker', task_class: 'mechanical', model, cost_basis: 'metered', cost_usd_est: 0.8, wall_s: 10, ...extra }; }
test('Append-only ledger and latest explicit final outcome', t => {
  const ctx = fixture(t); append(ctx, entry('codex:gpt-6-luna', 'a')); outcome(ctx, 'a', 'fail'); outcome(ctx, 'a', 'pass');
  assert.equal(ledger(ctx).length, 3); const row = scoreboard(ctx).rows[0]; assert.equal(row.n, 1); assert.equal(row.alpha, 2); assert.equal(row.beta, 1);
  outcome(ctx, 'a', 'human'); assert.equal(scoreboard(ctx).rows.length, 0);
  assert.throws(() => outcome(ctx, 'missing', 'pass'), /not found/);
  fs.appendFileSync(path.join(ctx.data, 'ledger/runs.jsonl'), 'bad\n', 'utf8'); assert.throws(() => ledger(ctx), /Invalid ledger/);
});
test('Budget refuses daily/per-run metered overrun and quota count', t => {
  const ctx = fixture(t), metered = { id: 'm', costBasis: 'metered' }, quota = { id: 'codex:gpt-6-luna', costBasis: 'quota' };
  assert.equal(budgetCheck(ctx, metered).allowed, true); assert.equal(budgetCheck(ctx, metered, 1.01).allowed, false);
  append(ctx, entry('m', 'a')); append(ctx, entry('m', 'b'));
  assert.equal(budgetCheck(ctx, metered).allowed, false); assert.throws(() => requireBudget(ctx, metered), e => e.exitCode === 3);
  append(ctx, entry(quota.id, 'q', { cost_basis: 'quota', cost_usd_est: null })); assert.equal(budgetCheck(ctx, quota).allowed, false);
  assert.equal(budgetCheck(ctx, { id: 'other-quota', costBasis: 'quota' }).allowed, true);
});
test('Posterior decay and exact Beta quantile', t => {
  const ctx = fixture(t), now = new Date('2026-09-23T12:00:00Z');
  for (const [i, days] of [0, 15, 46].entries()) { append(ctx, entry('codex:gpt-6-luna', `r${i}`, { ts: new Date(now - days * 86400000).toISOString() })); outcome(ctx, `r${i}`, 'pass'); }
  const row = scoreboard(ctx, false, now).rows[0]; assert.equal(row.alpha, 2.75); assert.equal(row.beta, 1); assert.equal(row.n, 3);
  assert.equal(decay(new Date(now - 15 * 86400000), now), 0.5);
  assert.ok(Math.abs(betaQuantile(0.025, 1, 1) - 0.025) < 1e-10); assert.ok(Math.abs(betaQuantile(0.025, 11, 1) - 0.025 ** (1 / 11)) < 1e-10);
});
test('Routing exploration is deterministic and family exclusion is mandatory', t => {
  const ctx = fixture(t), o = { role: 'worker-mech', 'task-class': 'mechanical', ticket: 'T-200' };
  assert.deepEqual(route(ctx, o), route(ctx, o));
  assert.notEqual(route(ctx, { ...o, 'exclude-family': ['openai'] }).family, 'openai');
  assert.throws(() => route(ctx, { ...o, 'exclude-family': ['openai', 'xai', 'zhipu', 'deepseek', 'xiaomi'] }), /No eligible/);
  const choices = new Set(Array.from({ length: 100 }, (_, i) => route(ctx, { ...o, ticket: `T-${i}` }).exploring)); assert.equal(choices.size, 2);
});
test('Promotion requires evidence and a 95% lower bound for noninferiority', () => {
  const p = { min_n_for_promotion: 10, noninferiority_margin: 0.05 }, inc = { n: 20, p_pass: 0.8, mean_cost: 1 };
  assert.ok(promotion(inc, { n: 10, lower95: 0.81, mean_cost: 2 }, p));
  assert.ok(promotion(inc, { n: 10, lower95: 0.76, mean_cost: 0.7 }, p));
  assert.equal(promotion(inc, { n: 9, lower95: 0.9, mean_cost: 0.1 }, p), null);
  assert.equal(promotion(inc, { n: 10, lower95: 0.7, mean_cost: 0.1 }, p), null);
  assert.equal(promotion(inc, { n: 10, lower95: 0.76, mean_cost: null }, p), null);
});
test('Tune preview leaves policy unchanged; applying scopes promotions to task class', t => {
  const ctx = fixture(t), file = path.join(ctx.data, 'routing/policy.json'), original = fs.readFileSync(file, 'utf8');
  for (let i = 0; i < 25; i++) {
    append(ctx, entry('codex:gpt-6-luna', `i${i}`)); outcome(ctx, `i${i}`, i < 10 ? 'pass' : 'fail');
    append(ctx, entry('grok:default', `c${i}`)); outcome(ctx, `c${i}`, 'pass');
  }
  assert.equal(tune(ctx).proposals.length, 1); assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(tune(ctx, true).policy_version, JSON.parse(original).version + 1); const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(policy.roles['worker-mech'].incumbent, 'codex:gpt-6-luna'); assert.equal(policy.roles['worker-mech'].by_task_class.mechanical.incumbent, 'grok:default');
});
test('Judge obeys verification ground truth, uncertainty and swapped order', () => {
  const v = { verdict: 'pass', scores: { correctness: 4, regressions: 4, scope: 4, tests: 4 }, issues: [], confidence: 0.9 };
  assert.equal(grounded(v, { worker_exit_code: 0, verification: [{ exit_code: 1 }] }).verdict, 'fail');
  assert.equal(grounded(v, { worker_exit_code: 0, verification: [] }).verdict, 'uncertain');
  assert.equal(reconcile('A', 'B'), 'A'); assert.equal(reconcile('A', 'A'), 'tie');
  assert.throws(() => validateVerdict({ ...v, scores: { ...v.scores, tests: 5 } }), /score/);
});
test('Session facts select the actual session task, not another saved session', () => {
  const data = { format: 1, key: SESSION_KEY, present: true, value: { sessions: [
    { id: 'other', tasks: [{ id: 'wrong', sessionId: 'other', status: 'completed', startedAt: '2026-01-03' }] },
    { id: 's', tasks: [{ id: 'right', sessionId: 's', status: 'completed', startedAt: '2026-01-02', activities: [{}, {}], resultsDocument: { assertionAttempts: 2, generatedAt: 'now' } }] }
  ] } };
  const facts = sessionFacts(data, 's'); assert.equal(facts.task_id, 'right'); assert.equal(facts.activity_count, 2); assert.equal(facts.assertionAttempts, 2); assert.equal(facts.generatedAt, 'now');
});
