import path from 'node:path';
import { json, fail, writeJson } from './util.mjs';
export const catalog = ctx => json(path.join(ctx.plugin, 'config/providers.json'));
export const LIST_SOURCE = 'https://openrouter.ai/api/v1/models';
export const quotaModelIds = {
  'codex:gpt-6-astra': 'openai/gpt-6-astra', 'codex:gpt-6-sol': 'openai/gpt-6-sol',
  'codex:gpt-6-luna': 'openai/gpt-6-luna', 'codex:gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'claude:fable': 'anthropic/claude-fable-5.1', 'claude:opus': 'anthropic/claude-opus-5.5',
  'claude:sonnet': 'anthropic/claude-sonnet-5', 'claude:haiku': 'anthropic/claude-haiku-4.5',
  'grok:default': 'x-ai/grok-build-0.1'
};
export function provider(ctx, model) {
  const p = catalog(ctx).find(p => p.id === model);
  if (!p || !p.enabled) fail(`Unknown or disabled model: ${model}`);
  if (p.model === 'TBD') fail('Provider model is incomplete');
  if (p.costBasis === 'metered' && !p.prices) fail('Metered model requires researched prices');
  return p;
}
export function price(tokens, prices) {
  if (!prices || !tokens || !['in', 'cached_in', 'out'].every(k => Number.isFinite(tokens[k]) && tokens[k] >= 0) || tokens.cached_in > tokens.in) return null;
  for (const k of ['inputPerMTok', 'cachedInputPerMTok', 'outputPerMTok']) if (!Number.isFinite(prices[k]) || prices[k] < 0) fail('Invalid model prices');
  if (prices.currency !== 'USD') fail('Only USD prices are supported');
  // in includes cached input; reasoning is already included in out.
  return (Math.max(0, tokens.in - tokens.cached_in) * prices.inputPerMTok + tokens.cached_in * prices.cachedInputPerMTok + tokens.out * prices.outputPerMTok) / 1e6;
}
export function listPrice(tokens, p) { return price(tokens, p?.list_prices); }
export function pricesFromModel(m, asOf) {
  const fields = [m?.pricing?.prompt, m?.pricing?.input_cache_read, m?.pricing?.completion].map(Number);
  if (fields.some(n => !Number.isFinite(n) || n < 0)) return null;
  const perMillion = n => Number((n * 1e6).toPrecision(12));
  return { inputPerMTok: perMillion(fields[0]), cachedInputPerMTok: perMillion(fields[1]),
    outputPerMTok: perMillion(fields[2]), currency: 'USD', source: LIST_SOURCE, asOf };
}
export async function refreshPrices(ctx, fetcher = fetch, now = new Date()) {
  try {
    const response = await fetcher(LIST_SOURCE, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('OpenRouter model list unavailable');
    const models = new Map((await response.json()).data.map(m => [m.id, m]));
    const file = path.join(ctx.plugin, 'config/providers.json'), entries = catalog(ctx), updated = [], missing = [];
    for (const entry of entries) {
      const id = entry.costBasis === 'quota' ? quotaModelIds[entry.id] : entry.model;
      const current = models.get(id), prices = current && pricesFromModel(current, now.toISOString().slice(0, 10));
      if (!prices) { missing.push(entry.id); continue; }
      if (entry.costBasis === 'quota') entry.list_prices = prices;
      else entry.prices = prices;
      updated.push(entry.id);
    }
    if (updated.length) writeJson(file, entries);
    return { status: 'available', updated, missing };
  } catch { return { status: 'unavailable', updated: [], reason: 'OpenRouter model list unavailable; existing prices retained' }; }
}
