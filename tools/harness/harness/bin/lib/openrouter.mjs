import { environmentValue, registerSecret, redactor, fail } from './util.mjs';

const BASE = 'https://openrouter.ai/api';
const validCost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function openRouterClient({ fetchImpl = fetch, env = process.env, lookup, apiKey, timeoutMs = 8000 } = {}) {
  const secret = registerSecret(apiKey ?? environmentValue('OPENROUTER_API_KEY', env, lookup));
  return async (endpoint, { body, timeout = timeoutMs } = {}) => {
    if (!secret) fail('OpenRouter credential unavailable');
    const response = await fetchImpl(`${BASE}${endpoint}`, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeout))),
      headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw Object.assign(new Error(`OpenRouter HTTP ${response.status}`), { status: response.status });
    return response.json();
  };
}

export async function accountStatus(options = {}) {
  const request = options.request ?? openRouterClient(options), clean = redactor();
  const values = await Promise.allSettled(['/v1/key', '/v1/credits'].map(endpoint => request(endpoint)));
  const fields = [['usage', 'limit', 'limit_remaining', 'limit_reset', 'is_free_tier'], ['total_credits', 'total_usage']];
  const results = values.map((r, i) => r.status === 'fulfilled' && r.value?.data && fields[i].some(k => k in r.value.data)
    ? { status: 'available', ...Object.fromEntries(fields[i].filter(k => k in r.value.data).map(k => [k, r.value.data[k]])) }
    : { status: 'unavailable', error: clean(r.status === 'rejected' ? r.reason.message : 'OpenRouter response missing account fields') });
  const count = results.filter(r => r.status === 'available').length;
  return clean({ status: count === 2 ? 'available' : count ? 'partial' : 'unavailable', account: results[0], credits: results[1] });
}

// Generation statistics can lag the stream. Bound the entire collection, not
// each ID, to 30 seconds; never label a partial sum as complete actual cost.
export async function generationCosts(ids, options = {}) {
  const request = options.request ?? openRouterClient(options), now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const unique = [...new Set(ids.filter(x => typeof x === 'string' && x.startsWith('gen-')))];
  const selected = unique.slice(0, 200), deadline = now() + Math.min(options.maxWaitMs ?? 30_000, 30_000);
  const diagnostics = [], clean = redactor(); let cursor = 0;
  async function worker() {
    while (cursor < selected.length) {
      const generation_id = selected[cursor++], errors = []; let cost = null, attempts = 0;
      while (now() < deadline && attempts < 8) {
        attempts++;
        try {
          const result = await request(`/v1/generation?id=${encodeURIComponent(generation_id)}`, { timeout: Math.min(5000, deadline - now()) });
          if (!validCost(result?.data?.total_cost)) throw new Error('Generation data.total_cost unavailable');
          cost = result.data.total_cost; break;
        } catch (e) {
          errors.push(clean(e.message));
          if (e.status && ![404, 408, 429, 500, 502, 503, 504].includes(e.status)) break;
          const delay = Math.min(500 * 2 ** (attempts - 1), 5000, Math.max(0, deadline - now()));
          if (delay) await sleep(delay);
        }
      }
      diagnostics.push({ generation_id, cost_usd: cost, attempts, errors, ...(cost === null ? { error: errors.at(-1) ?? 'Generation collection deadline exceeded' } : {}) });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, worker));
  diagnostics.sort((a, b) => selected.indexOf(a.generation_id) - selected.indexOf(b.generation_id));
  const received = diagnostics.filter(d => d.cost_usd !== null), sum = received.reduce((n, d) => n + d.cost_usd, 0);
  const complete = unique.length > 0 && received.length === unique.length;
  return { cost_usd_actual: complete ? sum : null, cost_usd_actual_partial: sum,
    generation_stats: { complete, expected: unique.length, queried: selected.length, received: received.length, capped: unique.length > 200, coverage: unique.length ? received.length / unique.length : 0, source: 'data.total_cost', diagnostics } };
}
