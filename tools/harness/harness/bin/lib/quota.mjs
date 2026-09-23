import fs from 'node:fs';
import path from 'node:path';
import { json, writeJson, fail } from './util.mjs';

// Quota exhaustion is an infrastructure event, never a model failure. Parsers
// below take fixture strings per adapter; the state file is runtime state.
const statePath = ctx => path.join(ctx.data, 'budget/quota-state.json');
export function quotaState(ctx) { return fs.existsSync(statePath(ctx)) ? json(statePath(ctx)) : {}; }
export function recordQuota(ctx, key, signal, now = new Date()) {
  if (!signal?.source) fail('Quota record requires a detection source');
  const state = quotaState(ctx);
  state[key] = { exhausted_until: signal.exhausted_until ?? null, source: signal.source, seen_at: now.toISOString() };
  writeJson(statePath(ctx), state);
  return state[key];
}
// A null exhausted_until means "until the state is edited"; no auto-recovery.
export function exhaustedQuota(ctx, now = new Date()) {
  const active = {};
  for (const [key, entry] of Object.entries(quotaState(ctx)))
    if (entry.exhausted_until == null || new Date(entry.exhausted_until) > now) active[key] = entry;
  return active;
}
// Codex shares one ChatGPT login; native Claude one Anthropic plan; pi and the
// anthropic-compat adapter both spend from the OpenRouter key's credits.
export const quotaKey = adapter => ({ codex: 'openai', claude: 'anthropic', pi: 'openrouter', 'anthropic-compat': 'openrouter' })[adapter] ?? null;

// "7:06 PM" -> the next occurrence of that local wall-clock time.
export function nextLocalTime(text, now = new Date()) {
  const match = /(?:resets?\s+(?:at|around)|try again at)\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text) ?? /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text);
  if (!match) return null;
  const hour = (Number(match[1]) % 12) + (/PM/i.test(match[3]) ? 12 : 0), minute = Number(match[2]);
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
  const offset = -candidate.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-', pad = n => String(Math.abs(n)).padStart(2, '0');
  return `${candidate.getFullYear()}-${pad(candidate.getMonth() + 1)}-${pad(candidate.getDate())}T${pad(candidate.getHours())}:${pad(candidate.getMinutes())}:${pad(candidate.getSeconds())}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

const statusPattern = code => new RegExp(`(?:HTTP[ _]?${code}\\b|"code"\\s*:\\s*${code}\\b|"status"\\s*:\\s*${code}\\b|(^|[^0-9])${code}\\s*[:\\-])`, 'm');
export const openRouterReservation = texts => statusPattern(402).test(texts.join('\n'));
export const openRouterRateLimit = texts => statusPattern(429).test(texts.join('\n'));

// Returns { source, exhausted_until } or null. Order matters: adapter-specific
// wording first, then generic OpenRouter statuses for OpenRouter-served runs.
export function detectQuota(adapter, texts, now = new Date()) {
  const text = texts.filter(Boolean).join('\n');
  if (!text) return null;
  if (adapter === 'codex') {
    if (/you'?ve hit your usage limit/i.test(text)) return { source: 'codex-usage-limit', exhausted_until: nextLocalTime(text, now) };
    return null;
  }
  if (adapter === 'claude') {
    if (/usage limit reached|you'?ve hit your (?:usage|rate) limit|out of extra usage/i.test(text)) return { source: 'claude-usage-limit', exhausted_until: nextLocalTime(text, now) };
    return null;
  }
  if (adapter === 'pi' || adapter === 'anthropic-compat') {
    // A persistent 402 after backoff retries is exhausted credits; 429 is a
    // transient provider rate limit that still blocks the whole account key.
    if (openRouterReservation(texts)) return { source: 'openrouter-402', exhausted_until: null };
    // 429 is transient: back off for ten minutes instead of blocking the key.
    if (openRouterRateLimit(texts)) return { source: 'openrouter-429', exhausted_until: new Date(now.getTime() + 10 * 60_000).toISOString() };
    return null;
  }
  return null;
}
