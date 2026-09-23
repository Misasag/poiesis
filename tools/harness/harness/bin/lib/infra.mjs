export const ROUTING_HINT = 'provider pinning left no endpoint; check config/pi-agent/models.json and the OpenRouter privacy settings';

// Only call with transport error fields, never assistant prose or tool output.
export function routingConfigError(value) {
  let payload = value;
  if (typeof value === 'string') {
    try { payload = JSON.parse(value.slice(value.indexOf('{'))); } catch { return null; }
  }
  const error = payload?.error ?? payload;
  const funnel = error?.metadata?.routing_funnel;
  if (Number(error?.code ?? error?.status) !== 404 || !/no endpoints/i.test(error?.message ?? '') || !Array.isArray(funnel)) return null;
  const step = error.metadata.failed_routing_step ?? funnel.find(s => s.endpoint_count === 0)?.step ?? 'unknown';
  return { infra: 'routing_config', routing_step: step, hint: ROUTING_HINT };
}
