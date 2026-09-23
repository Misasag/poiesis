import path from 'node:path';
import { json, fail } from './util.mjs';
import { ledger } from './ledger.mjs';

export function chargedCost(r, fallback = 0.5) {
  if (r.cost_usd_actual != null) return r.cost_usd_actual;
  const estimate = r.cost_usd_est ?? r.budget_estimate_usd ?? fallback;
  // Partial statistics are a known-spend floor, never a complete actual cost.
  // Keep unknown scoring costs null when no positive partial or estimate exists.
  return Number.isFinite(r.cost_usd_actual_partial) && r.cost_usd_actual_partial > 0
    ? Math.max(r.cost_usd_actual_partial, estimate ?? 0) : estimate;
}

export function budgetStatus(ctx, now = new Date()) {
  const limits = json(path.join(ctx.data, 'budget/limits.json'));
  const today = now.toISOString().slice(0, 10), month = today.slice(0, 7);
  const runs = [...ledger(ctx).filter(r => !r.kind), ...ledger(ctx, 'gate')];
  const charge = r => chargedCost(r, limits.metered.conservative_default_usd);
  const sum = rs => rs.reduce((n, r) => n + charge(r), 0);
  return { limits, month_usd: sum(runs.filter(r => r.cost_basis === 'metered' && r.ts.startsWith(month))), day_usd: sum(runs.filter(r => r.cost_basis === 'metered' && r.ts.startsWith(today))), quota_today: runs.filter(r => r.cost_basis === 'quota' && r.ts.startsWith(today)), runs };
}
export function budgetCheck(ctx, p, estimate, now = new Date()) {
  const status = budgetStatus(ctx, now), { limits } = status;
  if (p.costBasis === 'quota') {
    const perModel = limits.quota?.per_model_runs_per_day?.[p.id];
    const count = status.quota_today.filter(r => r.model === p.id).length;
    const allowed = (perModel == null || count < perModel) && (limits.quota?.runs_per_day == null || status.quota_today.length < limits.quota.runs_per_day);
    return { allowed, estimate_usd: 0, cost_basis: 'quota', runs_today: count, reason: allowed ? 'Quota run cap allows run' : 'Quota daily run cap exhausted' };
  }
  const recent = status.runs.filter(r => r.model === p.id && Number.isFinite(chargedCost(r, null))).slice(-10);
  const expected = estimate === undefined ? (recent.length ? recent.reduce((n, r) => n + chargedCost(r, limits.metered.conservative_default_usd), 0) / recent.length : limits.metered.conservative_default_usd) : Number(estimate);
  if (!Number.isFinite(expected) || expected < 0) fail('Invalid budget estimate');
  const remaining = Math.min(limits.metered.monthly_usd - status.month_usd, limits.metered.daily_usd - status.day_usd, limits.metered.per_run_usd);
  const allowed = expected <= remaining;
  return { allowed, estimate_usd: expected, remaining_usd: remaining, cost_basis: 'metered', reason: allowed ? 'Within metered budget' : 'Estimated cost exceeds budget' };
}
export function requireBudget(ctx, p, estimate) {
  const check = budgetCheck(ctx, p, estimate);
  if (!check.allowed) fail(check.reason, 3);
  return check;
}
