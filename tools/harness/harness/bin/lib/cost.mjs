import path from 'node:path';
import { json, fail, configFile } from './util.mjs';
import { ledger } from './ledger.mjs';
import { catalog, listPrice } from './prices.mjs';
import { chargedCost, meteredBudgetStatus } from './budget.mjs';
import { quotaState } from './quota.mjs';
import { importLocalUsage } from './local-usage.mjs';

const amount = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const median = values => {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return (sorted[mid] + sorted[(sorted.length - 1) >> 1]) / 2;
};
const emptyTokens = () => ({ in: 0, cached_in: 0, out: 0 });
const addTokens = (to, from) => { for (const k of Object.keys(to)) to[k] += from[k]; };
const knownTokens = r => r.tokens && ['in', 'cached_in', 'out'].every(k => amount(r.tokens[k])) &&
  (Object.hasOwn(r, 'api_equivalent_usd') ? r.api_equivalent_usd !== null : r.tokens.in + r.tokens.out > 0);
const runValue = (r, p) => Object.hasOwn(r, 'api_equivalent_usd') ? r.api_equivalent_usd : knownTokens(r) ? listPrice(r.tokens, p) : null;
const overlapHours = (start, end, monthStart, monthEnd) => {
  const a = Date.parse(start), b = Date.parse(end);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.min(b, monthEnd) - Math.max(a, monthStart)) / 3600000 : null;
};
const roleOf = r => r.role === 'worker' ? (r.task_class === 'mechanical' ? 'worker-mech' : 'worker-design') : r.role;

export async function costReport(ctx, o = {}, now = new Date()) {
  const month = o.month ?? now.toISOString().slice(0, 7);
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('Expected --month YYYY-MM');
  const monthStart = Date.parse(`${month}-01T00:00:00Z`), monthEnd = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1);
  const all = ledger(ctx), runs = all.filter(r => !r.kind && r.ts?.startsWith(month)),
    outcomes = new Map(all.filter(r => r.kind === 'outcome').map(r => [r.run_id, r.result]));
  const models = new Map(catalog(ctx).map(p => [p.id, p]));
  const subscriptions = json(configFile(ctx, 'budget/subscriptions.json')).map(s => {
    const included = runs.filter(r => r.cost_basis === 'quota' && s.covers.includes(r.adapter));
    const tokens = emptyTokens(); let value = 0, valuedRuns = 0, unknownRuns = 0;
    for (const r of included) {
      if (knownTokens(r)) addTokens(tokens, r.tokens); else unknownRuns++;
      const v = runValue(r, models.get(r.model));
      if (amount(v)) { value += v; valuedRuns++; }
    }
    const events = all.filter(r => !r.kind && r.infra === 'quota_exhausted' && s.covers.includes(r.adapter) &&
      Date.parse(r.ts) < monthEnd && (!r.quota_exhausted_until || Date.parse(r.quota_exhausted_until) > monthStart))
      .map(r => ({ start: r.ts, end: r.quota_exhausted_until ?? null }));
    for (const [key, state] of Object.entries(quotaState(ctx))) {
      if (!s.covers.some(adapter => ({ codex: 'openai', claude: 'anthropic', grok: 'grok' })[adapter] === key)) continue;
      if (!(Date.parse(state.seen_at) < monthEnd && (!state.exhausted_until || Date.parse(state.exhausted_until) > monthStart))) continue;
      const matching = events.find(e => Math.abs(Date.parse(e.start) - Date.parse(state.seen_at)) < 60000);
      if (matching) { matching.end ??= state.exhausted_until; continue; }
      events.push({ start: state.seen_at, end: state.exhausted_until });
    }
    const hours = events.map(e => overlapHours(e.start, e.end, monthStart, monthEnd));
    const fee = s.monthly_fee_usd;
    return { id: s.id, label: s.label ?? s.id, covers: s.covers, runs: included.length, tokens,
      api_equivalent_usd: value, valued_runs: valuedRuns, unknown_token_runs: unknownRuns,
      monthly_fee_usd: amount(fee) ? fee : null, value_fee_ratio: amount(fee) && fee > 0 ? value / fee : null,
      break_even_fee_usd: amount(fee) ? null : value, quota_exhaustion_events: events.filter(e => e.start.startsWith(month)).length,
      hours_blocked: hours.every(amount) ? hours.reduce((a, b) => a + b, 0) : null,
      hours_blocked_known: hours.filter(amount).reduce((a, b) => a + b, 0), unknown_block_events: hours.filter(v => v === null).length,
      what_if_metered_usd: value, what_if_note: s.covers.includes('grok') ? 'Grok default uses Grok Build public list price as a proxy' : null };
  });
  const meteredRows = [...runs, ...ledger(ctx, 'gate').filter(r => r.ts?.startsWith(month))].filter(r => r.cost_basis === 'metered');
  const metered = new Map();
  for (const r of meteredRows) {
    const row = metered.get(r.model) ?? { model: r.model, runs: 0, spend_usd: 0, actual_runs: 0, estimated_runs: 0 };
    row.runs++; row.spend_usd += chargedCost(r); if (r.cost_usd_actual != null) row.actual_runs++; else row.estimated_runs++;
    metered.set(r.model, row);
  }
  const classes = new Map();
  for (const r of runs) {
    if (r.infra) continue;
    const key = `${roleOf(r)}|${r.task_class}|${r.model}`;
    const row = classes.get(key) ?? { role: roleOf(r), task_class: r.task_class, model: r.model, runs: 0, pass: 0, fail: 0, times: [], passCosts: [] };
    row.runs++;
    if (amount(r.wall_s)) row.times.push(r.wall_s);
    const result = outcomes.get(r.run_id);
    if (result === 'pass') {
      row.pass++;
      const cost = r.cost_basis === 'quota' ? runValue(r, models.get(r.model)) : chargedCost(r, null);
      if (amount(cost)) row.passCosts.push(cost);
    } else if (result === 'fail' || result === 'timeout') row.fail++;
    classes.set(key, row);
  }
  const byRoleModel = [...classes.values()].map(({ times, passCosts, ...r }) => ({ ...r,
    pass_rate: r.pass + r.fail ? r.pass / (r.pass + r.fail) : null,
    median_wall_s: median(times), median_cost_per_pass_usd: median(passCosts) }));
  for (const s of subscriptions) {
    const own = byRoleModel.filter(r => s.covers.includes(models.get(r.model)?.adapter) && r.pass > 0);
    s.cheapest_passing_alternatives = [...new Set(own.map(r => `${r.role}|${r.task_class}`))].map(key => {
      const [role, task_class] = key.split('|');
      const other = byRoleModel.filter(r => r.role === role && r.task_class === task_class && r.pass > 0 && models.get(r.model)?.costBasis === 'metered' &&
        !s.covers.includes(models.get(r.model)?.adapter) && amount(r.median_cost_per_pass_usd))
        .sort((a, b) => a.median_cost_per_pass_usd - b.median_cost_per_pass_usd)[0];
      return { role, task_class, model: other?.model ?? null, median_cost_per_pass_usd: other?.median_cost_per_pass_usd ?? null };
    });
  }
  const local = o.local ? await importLocalUsage(ctx, { home: ctx.localUsageHome, days: o.days === undefined ? 30 : Number(o.days), now }) : null;
  if (local) for (const s of subscriptions) {
    const usage = s.covers.includes('codex') ? local.codex : s.covers.includes('claude') ? local.claude : null;
    if (!usage) continue;
    s.local_usage = { ...usage, value_fee_ratio: s.monthly_fee_usd > 0 ? usage.api_equivalent_usd / (s.monthly_fee_usd * local.days / 30) : null };
  }
  const current = month === now.toISOString().slice(0, 7) ? await meteredBudgetStatus(ctx, now) : null;
  return { month, local, subscriptions, metered: [...metered.values()].sort((a, b) => a.model.localeCompare(b.model)),
    openrouter: current ? { month_usd: current.openrouter.month_usd, monthly_source: current.monthly_source,
      status: current.openrouter.status, account_usage_total_usd: current.openrouter.account?.usage ?? null } : null,
    by_role_model: byRoleModel.sort((a, b) => `${a.role}|${a.task_class}|${a.model}`.localeCompare(`${b.role}|${b.task_class}|${b.model}`)) };
}

const usd = value => value === null ? '?' : `$${value.toFixed(4)}`;
const fmt = value => value === null ? '?' : String(value);
export function formatCost(report) {
  const lines = [`Cost ${report.month} (UTC)`, 'Subscriptions:'];
  for (const s of report.subscriptions) {
    lines.push(`${s.label}: runs=${s.runs} tokens=${s.tokens.in}/${s.tokens.cached_in}/${s.tokens.out} (in/cached/out) value=${usd(s.api_equivalent_usd)} fee=${usd(s.monthly_fee_usd)} ratio=${s.value_fee_ratio === null ? '?' : s.value_fee_ratio.toFixed(2)} break_even=${usd(s.break_even_fee_usd)} unknown_tokens=${s.unknown_token_runs} quota_events=${s.quota_exhaustion_events} blocked_h=${fmt(s.hours_blocked)}${s.unknown_block_events ? ` unknown_block_events=${s.unknown_block_events}` : ''}`);
    lines.push(`  what_if OpenRouter=${usd(s.what_if_metered_usd)}; cheapest passing: ${s.cheapest_passing_alternatives.map(a => `${a.role}/${a.task_class}=${a.model ?? 'unknown'}(${usd(a.median_cost_per_pass_usd)}/pass)`).join(', ') || 'no comparable measured pass'}${s.what_if_note ? `; ${s.what_if_note}` : ''}`);
    if (s.local_usage) {
      const u = s.local_usage;
      lines.push(`  local ${report.local.days}d: files=${u.files} tokens=${u.input}/${u.cached_input}/${u.cache_creation_input}/${u.output} (in/cache_read/cache_write/out) API-equivalent=${usd(u.api_equivalent_usd)} value/fee=${u.value_fee_ratio === null ? '?' : u.value_fee_ratio.toFixed(2)} unpriced_tokens=${u.unpriced_tokens}${u.unpriced_models.length ? ` unpriced_models=${u.unpriced_models.join(',')}` : ''}`);
    }
  }
  if (report.local) {
    lines.push('ChatGPT weekly windows (UTC reset hour, peak usage, plan):');
    for (const w of report.local.weekly_windows) lines.push(`  ${w.resets_at_hour}: ${w.peak_used_percent.toFixed(1)}% ${w.plan_type ?? 'unknown'}`);
    if (!report.local.weekly_windows.length) lines.push('  none');
    const p = report.local.plan_fit;
    lines.push(`  peak weekly usage on ${p.plan_type ?? 'unknown'} = ${p.peak_used_percent === null ? '?' : p.peak_used_percent.toFixed(1)}%; a plan with 1/4 of the capacity would have been exceeded in ${p.quarter_capacity_exceeded_weeks} of ${p.observed_weeks} weeks`);
  }
  lines.push('Metered spend (actual preferred; estimates otherwise):');
  for (const m of report.metered) lines.push(`  ${m.model}: runs=${m.runs} spend=${usd(m.spend_usd)} actual=${m.actual_runs} estimated=${m.estimated_runs}`);
  if (!report.metered.length) lines.push('  none');
  lines.push(`OpenRouter account: ${report.openrouter ? `status=${report.openrouter.status} month=${usd(report.openrouter.month_usd)} total=${usd(report.openrouter.account_usage_total_usd)} source=${report.openrouter.monthly_source}` : 'historical account usage unavailable'}`);
  lines.push('Role / task class / model (runs, pass rate, median wall, median cost per pass):');
  for (const r of report.by_role_model) lines.push(`  ${r.role}/${r.task_class}/${r.model}: ${r.runs}, ${r.pass_rate === null ? '?' : (r.pass_rate * 100).toFixed(1) + '%'}, ${r.median_wall_s === null ? '?' : r.median_wall_s.toFixed(1) + 's'}, ${usd(r.median_cost_per_pass_usd)}`);
  if (!report.by_role_model.length) lines.push('  none');
  return lines.join('\n');
}
