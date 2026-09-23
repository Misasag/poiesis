import path from 'node:path';
import { json, fail } from './util.mjs';
export const catalog = ctx => json(path.join(ctx.plugin, 'config/providers.json'));
export function provider(ctx, model) {
  const p = catalog(ctx).find(p => p.id === model);
  if (!p || !p.enabled) fail(`Unknown or disabled model: ${model}`);
  if (p.model === 'TBD') fail('Provider model is incomplete');
  if (p.costBasis === 'metered' && !p.prices) fail('Metered model requires researched prices');
  return p;
}
export function price(tokens, prices) {
  if (!prices) return null;
  for (const k of ['inputPerMTok', 'cachedInputPerMTok', 'outputPerMTok']) if (!Number.isFinite(prices[k]) || prices[k] < 0) fail('Invalid model prices');
  if (prices.currency !== 'USD') fail('Only USD prices are supported');
  // in includes cached input; reasoning is already included in out.
  return (Math.max(0, tokens.in - tokens.cached_in) * prices.inputPerMTok + tokens.cached_in * prices.cachedInputPerMTok + tokens.out * prices.outputPerMTok) / 1e6;
}
