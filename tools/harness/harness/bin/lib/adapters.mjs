import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { executable, fail } from './util.mjs';

export const emptyTokens = () => ({ in: 0, cached_in: 0, out: 0, reasoning: 0 });
function usage(u = {}, claude = false) {
  const cached = u.cached_input_tokens ?? u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const input = u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0;
  return { in: input + (claude ? cached + (u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0) : 0), cached_in: cached, out: u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0, reasoning: u.reasoning_output_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0 };
}
const texts = content => (Array.isArray(content) ? content.filter(x => x.type === 'text').map(x => x.text).join('\n') : typeof content === 'string' ? content : '');
export function parser(adapter) {
  const state = { tokens: emptyTokens(), session_id: null, final: '', structured: null, failed: false, usage_available: false };
  const seenMessages = new Set();
  function feed(e) {
    state.session_id = e.thread_id ?? e.session_id ?? e.sessionId ?? state.session_id;
    if (adapter === 'codex') {
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') state.final = e.item.text ?? '';
      if (e.type === 'turn.completed' && e.usage) { const u = usage(e.usage); for (const k of Object.keys(u)) state.tokens[k] += u[k]; state.usage_available = true; }
      if (['turn.failed', 'error'].includes(e.type)) state.failed = true;
    } else {
      if (e.type === 'assistant') {
        const t = texts(e.message?.content ?? e.content); if (t) state.final = t;
        // Grok streaming-messages-json follows the Messages wire format. Synthetic
        // fixtures cover this shape; unknown fields never imply invented usage.
        if (adapter === 'grok' && e.message?.usage && !seenMessages.has(e.message.id)) {
          seenMessages.add(e.message.id); const u = usage(e.message.usage, true);
          for (const k of Object.keys(u)) state.tokens[k] += u[k]; state.usage_available = true;
        }
      }
      if (e.type === 'result' || (adapter === 'grok' && e.result !== undefined)) {
        if (e.result !== undefined) state.final = typeof e.result === 'string' ? e.result : JSON.stringify(e.result);
        state.structured = e.structured_output ?? null;
        if (state.structured) state.final = JSON.stringify(state.structured);
        if (e.modelUsage && Object.keys(e.modelUsage).length) {
          state.tokens = emptyTokens();
          for (const value of Object.values(e.modelUsage)) { const u = usage(value, true); for (const k of Object.keys(u)) state.tokens[k] += u[k]; }
          state.usage_available = true;
        } else if (e.usage) { state.tokens = usage(e.usage, true); state.usage_available = true; }
        state.failed ||= Boolean(e.is_error) || Boolean(e.subtype && !['success'].includes(e.subtype));
      }
      if (adapter === 'grok' && e.type === 'message') { const t = texts(e.content); if (t) state.final = t; if (e.usage) { state.tokens = usage(e.usage, true); state.usage_available = true; } }
      if (adapter === 'grok' && !e.type && (e.verdict || e.winner || e.structured_output)) { state.structured = e.structured_output ?? e; state.final = JSON.stringify(state.structured); }
    }
    return state;
  }
  return { state, feed };
}
export function cliPath(adapter) {
  const npm = path.join(process.env.APPDATA ?? os.homedir(), 'npm/node_modules');
  if (adapter === 'codex') {
    const script = path.join(npm, '@openai/codex/bin/codex.js');
    if (!fs.existsSync(script)) fail('Codex npm CLI not found');
    return { file: process.execPath, prefix: [script] };
  }
  if (adapter === 'claude' || adapter === 'anthropic-compat') return { file: executable('claude', [path.join(npm, '@anthropic-ai/claude-code/bin/claude.exe'), path.join(os.homedir(), '.local/bin/claude.exe')]), prefix: [] };
  if (adapter === 'grok') return { file: executable('grok', [path.join(os.homedir(), '.grok/bin/grok.exe')]), prefix: [] };
  fail('Unsupported adapter');
}
export function invocation(p, o) {
  const { file, prefix } = cliPath(p.adapter), readOnly = o.sandbox === 'read-only';
  let args, session = o.session_id;
  if (p.adapter === 'codex') {
    args = ['--ask-for-approval', 'never', '--sandbox', readOnly ? 'read-only' : 'danger-full-access', '-C', o.cwd, 'exec'];
    if (session) args.push('resume', session);
    args.push('--ignore-user-config', '--json', '-o', os.devNull, '-m', p.model, '-c', `model_reasoning_effort=${o.effort}`);
    if (o.schemaFile) args.push('--output-schema', o.schemaFile);
    args.push('-');
  } else if (p.adapter === 'claude' || p.adapter === 'anthropic-compat') {
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', p.model, '--effort', o.effort, '--permission-mode', readOnly ? 'plan' : 'auto', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', ''];
    // Neither safe-mode nor bare auto-loads CLAUDE.md in 2.1.280. The runner
    // explicitly supplies repository guidance on stdin. No owner plugins/hooks.
    if (readOnly) args.push('--tools', o.judge ? '' : 'Read,Grep,Glob');
    if (o.schema) args.push('--json-schema', JSON.stringify(o.schema));
    if (session) args.push('--resume', session); else { session = randomUUID(); args.push('--session-id', session); }
  } else {
    args = ['--prompt-file', o.promptFile, '--cwd', o.cwd, '--output-format', 'streaming-messages-json', '--permission-mode', readOnly ? 'plan' : 'acceptEdits', '--no-subagents'];
    if (p.model !== 'default') args.push('--model', p.model);
    if (o.effort !== 'default') args.push('--reasoning-effort', o.effort);
    if (readOnly && o.judge) args.push('--tools', '');
    if (o.schema) args.push('--json-schema', JSON.stringify(o.schema));
    if (session) args.push('--resume', session); else { session = randomUUID(); args.push('--session-id', session); }
  }
  return { file, args: [...prefix, ...args], session_id: session };
}
