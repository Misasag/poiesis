import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { catalog, listPrice } from './prices.mjs';

const million = 1_000_000;
const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : 0;
const validTime = value => { const n = Date.parse(value); return Number.isFinite(n) ? n : null; };
const blank = () => ({ input: 0, cached_input: 0, cache_creation_input: 0, output: 0, api_equivalent_usd: 0, unpriced_tokens: 0, unpriced_models: [] });

// The catalog is the source for pinned models. These historical CLI model IDs
// also occur in local sessions but are not selectable harness providers.
const historical = {
  'gpt-5.6-sol': [2, .2, 10], 'gpt-5.6-terra': [1, .1, 5],
  'gpt-5.6-luna': [.1, .01, .5], 'gpt-5.5': [1.25, .125, 10],
  'claude-opus-5': [5, .5, 25], 'claude-haiku-4-5': [1, .1, 5]
};
const cacheWrites = { 'claude-opus-5-5': 5, 'claude-opus-5': 6.25, 'claude-fable-5-1': 12.5, 'claude-sonnet-5': 3.75, 'claude-haiku-4-5': 1.25 };
function matching(model, prices) {
  if (typeof model !== 'string') return null;
  const key = [...prices.keys()].sort((a, b) => b.length - a.length).find(id => model === id || model.startsWith(`${id}-`));
  return key ? { key, prices: prices.get(key) } : null;
}
function addUsage(row, model, usage, prices, claude = false) {
  const input = nonnegative(usage.input_tokens), cached = nonnegative(claude ? usage.cache_read_input_tokens : usage.cached_input_tokens);
  const created = claude ? nonnegative(usage.cache_creation_input_tokens) : 0;
  const output = nonnegative(usage.output_tokens);
  row.input += input; row.cached_input += cached; row.cache_creation_input += created; row.output += output;
  const found = matching(model, prices);
  if (!found) { row.unpriced_tokens += input + cached + created + output; row.unpriced_models.push(model ?? '(unknown)'); return; }
  const p = found.prices;
  const value = claude
    ? (input * p.inputPerMTok + cached * p.cachedInputPerMTok + created * (cacheWrites[found.key] ?? p.inputPerMTok) + output * p.outputPerMTok) / million
    : listPrice({ in: input, cached_in: Math.min(cached, input), out: output }, { list_prices: p });
  if (value === null) { row.unpriced_tokens += input + cached + created + output; row.unpriced_models.push(model ?? '(unknown)'); }
  else row.api_equivalent_usd += value;
}
async function* filesUnder(dir, accept) {
  let entries;
  try { entries = await fs.promises.opendir(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for await (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(file, accept);
    else if (entry.isFile() && accept(entry.name)) yield file;
  }
}
async function linesOf(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  return lines;
}
function hourlyReset(seconds) { return new Date(Math.floor(seconds / 3600) * 3600000).toISOString(); }
export async function importLocalUsage(ctx, { home = os.homedir(), days = 30, now = new Date() } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('Expected --days integer from 1 to 366');
  const since = now.getTime() - days * 86400000;
  const prices = new Map(catalog(ctx).filter(p => p.list_prices).map(p => [p.model, p.list_prices]));
  const quotaPrices = new Map(catalog(ctx).filter(p => p.list_prices).map(p => [p.id, p.list_prices]));
  for (const [model, id] of Object.entries({
    'claude-opus-5-5': 'claude:opus', 'claude-fable-5-1': 'claude:fable',
    'claude-sonnet-5': 'claude:sonnet', 'claude-haiku-4-5': 'claude:haiku'
  })) if (quotaPrices.has(id)) prices.set(model, quotaPrices.get(id));
  for (const [id, [inputPerMTok, cachedInputPerMTok, outputPerMTok]] of Object.entries(historical))
    if (!prices.has(id)) prices.set(id, { inputPerMTok, cachedInputPerMTok, outputPerMTok, currency: 'USD' });
  const codex = blank(), claude = blank(), windows = new Map(), seen = new Set();
  let codexFiles = 0, claudeFiles = 0;
  for await (const file of filesUnder(path.join(home, '.codex', 'sessions'), name => /^rollout-.*\.jsonl$/.test(name))) {
    if ((await fs.promises.stat(file)).mtimeMs < since) continue;
    codexFiles++; let model;
    for await (const line of await linesOf(file)) {
      if (!line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'turn_context') { model = event.payload?.model ?? model; continue; }
      if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
      const time = validTime(event.timestamp);
      if (time === null || time < since || time > now.getTime()) continue;
      const rate = event.payload.rate_limits, primary = rate?.primary;
      if (primary?.window_minutes === 10080 && Number.isFinite(primary.resets_at) && Number.isFinite(primary.used_percent)) {
        const key = hourlyReset(primary.resets_at), previous = windows.get(key);
        if (!previous || primary.used_percent > previous.peak_used_percent)
          windows.set(key, { resets_at_hour: key, peak_used_percent: primary.used_percent, plan_type: rate.plan_type ?? null });
      }
      if (event.payload.info?.last_token_usage) addUsage(codex, model, event.payload.info.last_token_usage, prices);
    }
  }
  for await (const file of filesUnder(path.join(home, '.claude', 'projects'), name => name.endsWith('.jsonl'))) {
    if ((await fs.promises.stat(file)).mtimeMs < since) continue;
    claudeFiles++;
    for await (const line of await linesOf(file)) {
      if (!line.includes('"usage"') || !line.includes('"model"')) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      const message = event.message, time = validTime(event.timestamp);
      if (!message?.usage || !message.model || message.model === '<synthetic>' || time === null || time < since || time > now.getTime()) continue;
      const id = message.id ?? event.uuid;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      addUsage(claude, message.model, message.usage, prices, true);
    }
  }
  for (const row of [codex, claude]) row.unpriced_models = [...new Set(row.unpriced_models)].sort();
  const weekly_windows = [...windows.values()].sort((a, b) => a.resets_at_hour.localeCompare(b.resets_at_hour));
  const plan_type = weekly_windows.findLast(w => w.plan_type)?.plan_type ?? null;
  const matchingWeeks = weekly_windows.filter(w => w.plan_type === plan_type);
  const exceeded = matchingWeeks.filter(w => w.peak_used_percent > 25).length;
  const peak = matchingWeeks.reduce((best, w) => !best || w.peak_used_percent > best.peak_used_percent ? w : best, null);
  return { days, since: new Date(since).toISOString(), until: now.toISOString(), codex: { ...codex, files: codexFiles }, claude: { ...claude, files: claudeFiles },
    weekly_windows, plan_fit: { peak_used_percent: peak?.peak_used_percent ?? null, plan_type,
      quarter_capacity_exceeded_weeks: exceeded, observed_weeks: matchingWeeks.length } };
}
