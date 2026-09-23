import { price } from './prices.mjs';

// Live per-run spend accumulator behind hx run --max-usd. pi reports a
// catalog-priced usage.cost.total on every assistant message (and compaction);
// anthropic-compat streams tokens that are priced live from the committed
// catalog. Quota adapters (codex/claude/grok) have no live USD signal, so the
// caller passes a null cap and the monitor never decides to kill.
export function costCapMonitor(parsed, adapter, prices, capUsd) {
  const liveUsd = () => adapter === 'pi' ? parsed.state.cost_reported_usd : (price(parsed.state.tokens, prices) ?? 0);
  return {
    cap_usd: capUsd ?? null,
    feed(event) {
      parsed.feed(event);
      const usd = liveUsd();
      return { usd, exceeded: capUsd != null && Number.isFinite(usd) && usd > capUsd };
    }
  };
}
