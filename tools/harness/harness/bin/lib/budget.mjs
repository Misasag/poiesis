import fs from 'node:fs';
import path from 'node:path';
import { json, writeJson, fail, redactor, configFile } from './util.mjs';
import { ledger } from './ledger.mjs';
import { accountStatus } from './openrouter.mjs';

export function chargedCost(r, fallback = 0.5) {
  if (r.cost_usd_actual != null) return r.cost_usd_actual;
  const estimate = r.cost_usd_est ?? r.budget_estimate_usd ?? fallback;
  // Partial statistics are a known-spend floor, never a complete actual cost.
  // Keep unknown scoring costs null when no positive partial or estimate exists.
  return Number.isFinite(r.cost_usd_actual_partial) && r.cost_usd_actual_partial > 0
    ? Math.max(r.cost_usd_actual_partial, estimate ?? 0) : estimate;
}

export const limits = ctx => json(configFile(ctx, 'budget/limits.json'));
export const meteredLimits = ctx => limits(ctx).metered;

export function budgetStatus(ctx, now = new Date()) {
  const caps = limits(ctx);
  const today = now.toISOString().slice(0, 10), month = today.slice(0, 7);
  const runs = [...ledger(ctx).filter(r => !r.kind), ...ledger(ctx, 'gate')];
  const charge = r => chargedCost(r, caps.metered.conservative_default_usd);
  const sum = rs => rs.reduce((n, r) => n + charge(r), 0);
  return { limits: caps, month_usd: sum(runs.filter(r => r.cost_basis === 'metered' && r.ts.startsWith(month))), day_usd: sum(runs.filter(r => r.cost_basis === 'metered' && r.ts.startsWith(today))), quota_today: runs.filter(r => r.cost_basis === 'quota' && r.ts.startsWith(today)), runs };
}
const amount = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

// The key has no monthly reset. Serialize first observations across processes;
// a missing/corrupt/busy baseline conservatively charges total key usage.
function monthlyUsage(ctx, usage, now) {
  const file = ctx.budgetBaseline ?? path.join(ctx.data, 'budget/openrouter-baseline.json'), lock = `${file}.lock`;
  const month = now.toISOString().slice(0, 7);
  let fd;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(lock, 'wx');
    let saved;
    try { saved = json(file); } catch { saved = {}; }
    if (saved.month === month && amount(saved.usage) && usage >= saved.usage)
      return { month_usd: usage - saved.usage, baseline_usd: saved.usage, baseline_status: 'available' };
    // Do not replace this month's first observation, even if the key resets.
    if (saved.month !== month || !amount(saved.usage)) {
      writeJson(`${file}.tmp`, { month, usage, observed_at: now.toISOString() });
      fs.renameSync(`${file}.tmp`, file);
    }
    return { month_usd: usage, baseline_usd: null, baseline_status: 'missing; total usage used' };
  } catch {
    return { month_usd: usage, baseline_usd: null, baseline_status: 'unavailable; total usage used' };
  } finally {
    if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}

export async function meteredBudgetStatus(ctx, now = new Date()) {
  let openrouter;
  // Injectable account reader keeps deterministic tests completely offline.
  try { openrouter = await (ctx.accountStatus ?? accountStatus)(); }
  catch (error) { openrouter = { status: 'unavailable', error: redactor()(error.message) }; }
  const status = budgetStatus(ctx, now), account = openrouter.account, credits = openrouter.credits;
  const usage = account?.status === 'available' && amount(account.usage)
    ? monthlyUsage(ctx, account.usage, now) : { month_usd: null, baseline_usd: null, baseline_status: 'unavailable' };
  const ceilings = [];
  if (account?.status === 'available' && typeof account.limit_remaining === 'number' && Number.isFinite(account.limit_remaining))
    ceilings.push(account.limit_remaining);
  if (credits?.status === 'available' && amount(credits.total_credits) && amount(credits.total_usage))
    ceilings.push(credits.total_credits - credits.total_usage);
  const remaining = ceilings.length ? Math.max(0, Math.min(...ceilings)) : null;
  const month = Math.max(status.month_usd, usage.month_usd ?? 0);
  const monthlySource = usage.month_usd === null ? 'ledger (OpenRouter unavailable; fallback)' : usage.month_usd > status.month_usd ? 'openrouter' : 'ledger';
  const headroom = { monthly: status.limits.metered.monthly_usd - month, daily: status.limits.metered.daily_usd - status.day_usd, per_run: status.limits.metered.per_run_usd,
    ...(remaining === null ? {} : { openrouter_credit: remaining }) };
  const [binding, available] = Object.entries(headroom).sort((a, b) => a[1] - b[1])[0];
  return { ...status, ledger_month_usd: status.month_usd, month_usd: month, monthly_source: monthlySource,
    openrouter: { ...openrouter, ...usage, remaining_usd: remaining }, headroom_usd: headroom, binding, remaining_usd: available };
}

export async function budgetCheck(ctx, p, estimate, now = new Date(), { capUsd, reservedUsd = 0 } = {}) {
  const status = p.costBasis === 'quota' ? budgetStatus(ctx, now) : await meteredBudgetStatus(ctx, now), { limits } = status;
  if (p.costBasis === 'quota') {
    const perModel = limits.quota?.per_model_runs_per_day?.[p.id];
    const count = status.quota_today.filter(r => r.model === p.id).length;
    const allowed = (perModel == null || count < perModel) && (limits.quota?.runs_per_day == null || status.quota_today.length < limits.quota.runs_per_day);
    return { allowed, estimate_usd: 0, cost_basis: 'quota', runs_today: count, reason: allowed ? 'Quota run cap allows run' : 'Quota daily run cap exhausted' };
  }
  const recent = status.runs.filter(r => r.model === p.id && Number.isFinite(chargedCost(r, null))).slice(-10);
  const expected = estimate === undefined ? (recent.length ? recent.reduce((n, r) => n + chargedCost(r, limits.metered.conservative_default_usd), 0) / recent.length : limits.metered.conservative_default_usd) : Number(estimate);
  if (!Number.isFinite(expected) || expected < 0) fail('Invalid budget estimate');
  // A capped run can spend up to its --max-usd cap (default per_run_usd), so
  // the reservation compares the cap, not only the historical mean, and adds
  // in-flight reservations from concurrent bench lanes.
  const reservation = Math.max(expected, capUsd ?? 0);
  const headroom = Object.entries(status.headroom_usd).map(([key, value]) => [key, value - (key === 'per_run' ? 0 : reservedUsd)]);
  const [binding, remaining] = headroom.sort((a, b) => a[1] - b[1])[0];
  const allowed = reservation <= remaining;
  return { allowed, estimate_usd: expected, cap_usd: capUsd ?? null, reservation_usd: reservation, reserved_usd: reservedUsd, remaining_usd: remaining,
    remaining_without_reservations_usd: status.remaining_usd, blocked_by_reservations: !allowed && reservation <= status.remaining_usd,
    ledger_month_usd: status.ledger_month_usd, month_usd: status.month_usd, monthly_source: status.monthly_source, openrouter: status.openrouter, binding,
    cost_basis: 'metered', reason: allowed ? 'Within metered budget' : `Estimated cost exceeds budget (${binding})` };
}
export async function requireBudget(ctx, p, estimate, capUsd) {
  const check = await budgetCheck(ctx, p, estimate, undefined, { capUsd });
  if (!check.allowed) fail(check.reason, 3);
  return check;
}
