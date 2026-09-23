import path from 'node:path';
import { createHash } from 'node:crypto';
import { json, writeJson, write, fail } from './util.mjs';
import { ledger } from './ledger.mjs';
import { catalog } from './prices.mjs';

export const policy = ctx => json(path.join(ctx.data, 'routing/policy.json'));
export function decay(ts, now = new Date()) {
  const days = Math.max(0, (now - new Date(ts)) / 86400000);
  return days < 15 ? 1 : days < 46 ? 0.5 : 0.25;
}
// Lanczos log-gamma + continued fraction gives actual Beta quantiles, including
// highly skewed small samples, rather than a normal approximation near 0 or 1.
function logGamma(z) {
  const c = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  z--; let x = 0.9999999999998099;
  c.forEach((v, i) => { x += v / (z + i + 1); });
  const t = z + c.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function fraction(a, b, x) {
  const tiny = 1e-30; let c = 1, d = 1 - (a + b) * x / (a + 1); if (Math.abs(d) < tiny) d = tiny; d = 1 / d; let h = d;
  for (let m = 1; m < 300; m++) {
    let aa = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny; c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny; d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny; c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny; d = 1 / d; const delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < 1e-12) break;
  }
  return h;
}
function betaCdf(x, a, b) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? bt * fraction(a, b, x) / a : 1 - bt * fraction(b, a, 1 - x) / b;
}
export function betaQuantile(prob, a, b) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 65; i++) { const mid = (lo + hi) / 2; if (betaCdf(mid, a, b) < prob) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
export function scoreboard(ctx, persist = false, now = new Date()) {
  const lines = ledger(ctx), outcomes = new Map(), rows = new Map();
  for (const r of lines) if (r.kind === 'outcome') outcomes.set(r.run_id, r.result);
  for (const r of lines) {
    const result = outcomes.get(r.run_id);
    if (r.kind || !['pass', 'fail'].includes(result)) continue;
    const role = r.role === 'worker' ? (r.task_class === 'mechanical' ? 'worker-mech' : 'worker-design') : r.role;
    const key = `${role}|${r.task_class}|${r.model}`;
    const row = rows.get(key) ?? { role, task_class: r.task_class, model: r.model, alpha: 1, beta: 1, n: 0, costs: [], times: [], pass: 0, fail: 0 };
    row[result === 'pass' ? 'alpha' : 'beta'] += decay(r.ts, now); row[result]++; row.n++;
    if (r.cost_usd_est !== null && Number.isFinite(r.cost_usd_est)) row.costs.push(r.cost_usd_est);
    if (Number.isFinite(r.wall_s)) row.times.push(r.wall_s);
    rows.set(key, row);
  }
  const result = { generated_at: now.toISOString(), rows: [...rows.values()].map(r => {
    const times = r.times.sort((a, b) => a - b), mid = Math.floor(times.length / 2);
    const { costs, ...rest } = r; delete rest.times;
    return { ...rest, p_pass: r.alpha / (r.alpha + r.beta), lower95: betaQuantile(0.025, r.alpha, r.beta), mean_cost: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null, mean_wall_s: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0, p50_wall_s: times.length ? (times[mid] + times[(times.length - 1) >> 1]) / 2 : 0 };
  }) };
  if (persist) writeJson(path.join(ctx.data, 'routing/scoreboard.json'), result);
  return result;
}
export const seeded = seed => createHash('sha256').update(String(seed)).digest().readUInt32BE(0) / 2 ** 32;
export function route(ctx, o) {
  const p = policy(ctx), role = p.roles[o.role];
  if (!role) fail(`Unknown role: ${o.role}`);
  if (role.fixed) return { model: role.incumbent, informational: true, reason: 'Fixed orchestrator session' };
  const rule = { ...role, ...(role.by_task_class?.[o['task-class']] ?? {}) };
  const excluded = o['exclude-family'] ?? [], models = catalog(ctx), scores = scoreboard(ctx).rows;
  const candidates = [...new Set([rule.incumbent, ...(rule.challengers ?? []), rule.fallback].filter(Boolean))].map(id => models.find(m => m.id === id)).filter(m => m?.enabled && !excluded.includes(m.family));
  if (!candidates.length) fail('No eligible model after family exclusion');
  const ranked = candidates.map(m => {
    const score = scores.find(s => s.role === o.role && s.task_class === (o['task-class'] ?? 'unclassified') && s.model === m.id);
    const meanCost = score?.mean_cost ?? (m.costBasis === 'quota' ? 0 : 1);
    return { model: m.id, family: m.family, p_pass: score?.p_pass ?? 0.5, utility: (score?.p_pass ?? 0.5) - p.lambda_cost * meanCost - p.lambda_time * (score?.mean_wall_s ?? 0), n: score?.n ?? 0 };
  });
  const seed = o.ticket ?? `${o.role}:${o['task-class'] ?? 'unclassified'}`;
  const challengers = ranked.filter(m => (rule.challengers ?? []).includes(m.model));
  const exploring = challengers.length > 0 && seeded(seed) < p.explore_share;
  const chosen = exploring ? challengers[Math.floor(seeded(seed + ':pick') * challengers.length)] : [...ranked].sort((a, b) => b.utility - a.utility)[0];
  return { ...chosen, effort: chosen.model === rule.incumbent ? rule.effort : models.find(m => m.id === chosen.model)?.defaultEffort, exploring, seed, policy_version: p.version, candidates: ranked };
}
export function promotion(inc, challenger, p) {
  if (!inc || !challenger || inc.n < p.min_n_for_promotion || challenger.n < p.min_n_for_promotion) return null;
  if (challenger.lower95 >= inc.p_pass) return '95% lower bound exceeds incumbent mean';
  if (challenger.lower95 >= inc.p_pass - p.noninferiority_margin && inc.mean_cost > 0 && challenger.mean_cost !== null && challenger.mean_cost <= inc.mean_cost * 0.7) return 'Non-inferior lower bound and at least 30% cheaper';
  return null;
}
export function tune(ctx, apply = false) {
  const p = policy(ctx), scores = scoreboard(ctx).rows, proposals = [];
  for (const [role, r] of Object.entries(p.roles)) {
    if (r.fixed) continue;
    for (const cls of p.task_classes) {
      const rule = { ...r, ...(r.by_task_class?.[cls] ?? {}) }, inc = scores.find(s => s.role === role && s.task_class === cls && s.model === rule.incumbent);
      const choices = (rule.challengers ?? []).map(model => scores.find(s => s.role === role && s.task_class === cls && s.model === model)).filter(Boolean).sort((a, b) => b.lower95 - a.lower95);
      for (const challenger of choices) {
        const reason = promotion(inc, challenger, p); if (!reason) continue;
        proposals.push({ role, task_class: cls, from: rule.incumbent, to: challenger.model, reason });
        if (apply) {
          r.by_task_class ??= {};
          r.by_task_class[cls] = { incumbent: challenger.model, effort: catalog(ctx).find(m => m.id === challenger.model).defaultEffort, challengers: [...new Set([rule.incumbent, ...rule.challengers.filter(m => m !== challenger.model)])] };
        }
        break;
      }
    }
  }
  const file = path.join(ctx.data, 'routing/proposals', `${new Date().toISOString().slice(0, 10)}.md`);
  write(file, `# Routing proposals\n\nPolicy version: ${p.version}\nApplied: ${apply}\n\n${proposals.map(x => `- ${x.role} / ${x.task_class}: ${x.from} -> ${x.to}; ${x.reason}`).join('\n') || 'No promotions meet the evidence threshold.'}\n`);
  if (apply && proposals.length) { p.version++; writeJson(path.join(ctx.data, 'routing/policy.json'), p); }
  return { proposals, applied: apply, policy_version: p.version, file };
}
