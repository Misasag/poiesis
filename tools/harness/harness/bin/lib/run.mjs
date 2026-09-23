import fs from 'node:fs';
import path from 'node:path';
import { read, json, write, writeJson, id, git, exec, killTree, redactor, resolveEnv, required, positive, fail, VERSION } from './util.mjs';
import { append, ledger, getRun, runDir } from './ledger.mjs';
import { provider, price, listPrice } from './prices.mjs';
import { requireBudget, meteredLimits } from './budget.mjs';
import { parser, invocation, piAgentDir } from './adapters.mjs';
import { costCapMonitor } from './costcap.mjs';
import { generationCosts, openRouterClient } from './openrouter.mjs';
import { policy, dataAllowed } from './route.mjs';
import { detectQuota, openRouterReservation, quotaKey, recordQuota } from './quota.mjs';
import { adapterAvailability } from './nested.mjs';

export async function captureDiff(cwd, base) {
  let patch = (await git(cwd, ['diff', '--binary', base, '--'])).stdout;
  let stat = (await git(cwd, ['diff', '--stat', base, '--'])).stdout;
  let nums = (await git(cwd, ['diff', '--numstat', base, '--'])).stdout;
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  for (const file of untracked) {
    if (!fs.statSync(path.join(cwd, file)).isFile()) continue;
    for (const [flag, add] of [['--binary', v => { patch += v; }], ['--stat', v => { stat += v; }], ['--numstat', v => { nums += v; }]]) {
      const r = await git(cwd, ['diff', '--no-index', flag, '--', '/dev/null', file], { allowFailure: true });
      if (r.exit_code > 1) fail(`Could not capture untracked diff: ${file}`);
      add(r.stdout);
    }
  }
  const rows = nums.trim().split('\n').filter(Boolean);
  return { patch, stat, diff: rows.reduce((s, row) => { const [a, r] = row.split('\t'); s.files++; s.added += Number(a) || 0; s.removed += Number(r) || 0; return s; }, { files: 0, added: 0, removed: 0 }) };
}
function guidance(cwd) {
  return ['AGENTS.md', 'CLAUDE.md'].filter(f => fs.existsSync(path.join(cwd, f))).map(f => `Repository guidance (${f}):\n${read(path.join(cwd, f))}`).join('\n\n');
}
export async function run(ctx, o, dependencies = {}) {
  required(o, 'model', 'cwd', 'brief');
  const p = provider(ctx, o.model), effort = o.effort ?? p.defaultEffort;
  if (p.adapter === 'decisions') fail('Decisions models must use hx gate');
  if (!dataAllowed(policy(ctx), p)) fail('Model forbidden by data policy');
  if (!p.efforts.includes(effort)) fail(`Unsupported effort for ${p.id}: ${effort}`);
  if (o.sandbox && !['write', 'read-only'].includes(o.sandbox)) fail('Sandbox must be write or read-only');
  const cwd = path.resolve(o.cwd), brief = read(path.resolve(o.brief));
  const prev = o.resume ? getRun(ctx, o.resume) : null;
  if (prev && (prev.model !== p.id || path.resolve(ctx.root, prev.cwd_rel) !== cwd || !prev.session_id)) fail('Resume requires the same model, cwd, and a stored session_id');
  // pi session files are named <timestamp>_<id>.jsonl; --session-id cannot
  // reopen them, so verified resume opens the recorded file path instead.
  const prevSessionFile = prev?.session_file_rel ? path.resolve(ctx.root, prev.session_file_rel) : null;
  if (prev && p.adapter === 'pi' && !prevSessionFile) fail('pi resume requires the stored session file');
  if (prev) { o = { ...o, role: o.role ?? prev.role, ticket: o.ticket ?? prev.ticket, 'task-class': o['task-class'] ?? prev.task_class }; }
  const availability = (dependencies.adapterAvailability ?? adapterAvailability)()[p.adapter];
  if (availability && !availability.available) {
    const runId = id(o.role === 'judge' ? 'judge' : 'run'), dir = runDir(ctx, runId);
    const hint = `${availability.reason}; use hx route or an or:* model`;
    const redact = redactor();
    const record = { run_id: runId, ts: new Date().toISOString(), role: o.role ?? 'worker', ticket: o.ticket ?? null,
      task_class: o['task-class'] ?? 'unclassified', model: p.id, family: p.family, adapter: p.adapter, effort,
      cwd_rel: path.relative(ctx.root, cwd).replaceAll('\\', '/'), base_sha: null, tokens: { input: 0, output: 0 },
      cost_usd_est: null, cost_basis: p.costBasis, wall_s: 0, exit_code: 1, session_id: null, session_file_rel: null,
      diff: { files: 0, added: 0, removed: 0 }, harness_ver: VERSION, infra: 'nested_sandbox', hint };
    write(path.join(dir, 'brief.md'), redact(brief));
    write(path.join(dir, 'final.md'), hint);
    writeJson(path.join(dir, 'meta.json'), redact(record));
    append(ctx, record, 'runs', redact);
    return record;
  }
  const env = dependencies.env ?? resolveEnv(p, process.env, undefined, ctx), redact = redactor(env);
  // Live spend cap: pi sums assistant usage.cost.total, anthropic-compat is
  // priced from the catalog tokens; quota runs have no live USD and ignore it.
  const capUsd = p.costBasis === 'metered' ? (o['max-usd'] === undefined ? meteredLimits(ctx).per_run_usd : positive(o['max-usd'])) : null;
  const budget = await requireBudget(ctx, p, o['estimate-usd'], capUsd);
  if (p.adapter === 'pi') env.PI_CODING_AGENT_DIR = piAgentDir(ctx);
  const head = await git(cwd, ['rev-parse', 'HEAD'], { allowFailure: true });
  // An isolated smoke repository need not create a synthetic commit.
  const base = head.exit_code ? (await git(cwd, ['hash-object', '-w', '-t', 'tree', '--stdin'], { input: '' })).stdout.trim() : head.stdout.trim();
  const runId = id(o.role === 'judge' ? 'judge' : 'run'), dir = runDir(ctx, runId), start = Date.now();
  const prompt = o.role === 'judge' ? brief : `${guidance(cwd)}\n\nYou are a terminal worker. Implement or inspect this brief directly; do not delegate to another implementation CLI or agent. Do not commit. Report verification exit codes.\n\n${brief}`;
  const sessionDir = p.adapter === 'pi' ? (prevSessionFile ? path.dirname(prevSessionFile) : path.join(dir, 'sessions')) : null;
  if (sessionDir) fs.mkdirSync(sessionDir, { recursive: true });
  write(path.join(dir, 'brief.md'), redact(brief));
  write(path.join(dir, 'prompt.md'), redact(prompt));
  const initial = await captureDiff(cwd, base);
  write(path.join(dir, 'initial.patch'), redact(initial.patch));
  if (o.schema) writeJson(path.join(dir, 'schema.json'), o.schema);
  write(path.join(dir, 'events.jsonl'), '');
  const parsed = parser(p.adapter); let pending = '', stderrPending = '', result, error = null;
  const cap = costCapMonitor(parsed, p.adapter, p.prices, capUsd);
  let killed = null, child = null;
  const event = line => {
    if (!line.trim()) return;
    let value; try { value = JSON.parse(line); } catch { value = { type: 'raw', text: line }; }
    const live = cap.feed(value);
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(redact(value)) + '\n', 'utf8');
    if (live.exceeded && !killed && child) { killed = 'cost_cap'; void killTree(child); }
  };
  let call;
  const runAttempt = async () => (dependencies.exec ?? exec)(call.file, call.args, { cwd, env, input: prompt, timeoutMs: positive(o['timeout-min'], 30) * 60_000,
    onSpawn(c) { child = c; },
    onStdout(data) { pending += data; let n; while ((n = pending.indexOf('\n')) >= 0) { event(pending.slice(0, n)); pending = pending.slice(n + 1); } },
    onStderr(data) { stderrPending += data; let n; while ((n = stderrPending.indexOf('\n')) >= 0) { fs.appendFileSync(path.join(dir, 'stderr.log'), redact(stderrPending.slice(0, n + 1)), 'utf8'); stderrPending = stderrPending.slice(n + 1); } }
  });
  try {
    call = (dependencies.invocation ?? invocation)(p, { cwd, effort, sandbox: o.sandbox, session_id: prev?.session_id, sessionFile: prevSessionFile, sessionDir, promptFile: path.join(dir, 'prompt.md'), schema: o.schema, schemaFile: o.schema ? path.join(dir, 'schema.json') : undefined, judge: o.role === 'judge' });
    // A new OpenRouter account can hit HTTP 402 from in-flight credit
    // reservation even with balance: retry with backoff before classifying.
    // Only failed attempts qualify; a successful run whose model-authored
    // text merely contains a status-like number must not re-run.
    result = await runAttempt();
    const failedAttempt = () => Boolean(result.exit_code) || parsed.state.failed || !parsed.state.final;
    for (let attempt = 1; attempt <= 2 && p.adapter === 'pi' && !killed && failedAttempt() && openRouterReservation([result.stdout, result.stderr]); attempt++) {
      await new Promise(resolve => setTimeout(resolve, attempt * 10_000));
      pending = ''; stderrPending = '';
      result = await runAttempt();
    }
    event(pending);
    // Grok's schema option implies JSON output, which may be pretty-printed.
    if (p.adapter === 'grok' && !parsed.state.final) { try { parsed.feed(JSON.parse(result.stdout)); } catch {} }
    if (stderrPending) fs.appendFileSync(path.join(dir, 'stderr.log'), redact(stderrPending), 'utf8');
  } catch (e) { error = redact(e.message); result = { exit_code: e.exitCode ?? 1 }; }
  const cumulative = { ...parsed.state.tokens };
  if (prev && ['claude', 'anthropic-compat'].includes(p.adapter)) {
    const previousMeta = json(path.join(runDir(ctx, prev.run_id), 'meta.json'));
    for (const k of Object.keys(parsed.state.tokens)) parsed.state.tokens[k] = Math.max(0, cumulative[k] - (previousMeta.cumulative_tokens?.[k] ?? prev.tokens[k]));
  }
  let captured = { patch: '', stat: '', diff: { files: 0, added: 0, removed: 0 } };
  try { captured = await captureDiff(cwd, base); } catch (e) { error = redact(e.message); result.exit_code ||= 1; }
  write(path.join(dir, 'diff.patch'), redact(captured.patch)); write(path.join(dir, 'diff.stat'), redact(captured.stat));
  write(path.join(dir, 'final.md'), redact(parsed.state.final));
  const recordSessionId = parsed.state.session_id ?? call?.session_id ?? null;
  let sessionFileRel = null;
  if (p.adapter === 'pi' && sessionDir && recordSessionId) {
    const stored = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).filter(f => f.endsWith(`_${recordSessionId}.jsonl`)).sort().at(-1) : null;
    sessionFileRel = stored ? path.relative(ctx.root, path.join(sessionDir, stored)).replaceAll('\\', '/') : prev?.session_file_rel ?? null;
  }
  const runFailed = Boolean(result.exit_code) || parsed.state.failed || !parsed.state.final;
  // Only CLI/transport error channels: stdout carries the agent's own text and
  // tool output, where words like "429" or "rate_limit" are ordinary content.
  const quota = runFailed ? detectQuota(p.adapter, [result.stderr, error, ...parsed.state.errors, p.adapter === 'claude' && parsed.state.failed ? parsed.state.final : ''], new Date()) : null;
  const key = quotaKey(p.adapter);
  if (quota && key) recordQuota(ctx, key, quota);
  const record = { run_id: runId, ts: new Date(start).toISOString(), role: o.role ?? 'worker', ticket: o.ticket ?? null, task_class: o['task-class'] ?? 'unclassified', model: p.id, family: p.family, adapter: p.adapter, effort, cwd_rel: path.relative(ctx.root, cwd).replaceAll('\\', '/'), base_sha: base, tokens: parsed.state.tokens, cost_usd_est: price(parsed.state.tokens, p.prices), cost_basis: p.costBasis, wall_s: (Date.now() - start) / 1000, exit_code: result.exit_code || (parsed.state.failed || !parsed.state.final ? 1 : 0), session_id: recordSessionId, session_file_rel: sessionFileRel, diff: captured.diff, harness_ver: VERSION };
  if (p.costBasis === 'quota') record.api_equivalent_usd = listPrice(parsed.state.usage_available ? parsed.state.tokens : null, p);
  if (quota && key) { record.infra = 'quota_exhausted'; record.quota_source = quota.source; record.quota_exhausted_until = quota.exhausted_until; }
  if (runFailed && parsed.state.routing_error) Object.assign(record, parsed.state.routing_error);
  // A cost-cap kill keeps the diff for review but marks the run as stopped.
  if (killed) record.killed = killed;
  const openRouterServed = ['pi', 'anthropic-compat'].includes(p.adapter) && p.model.includes('/');
  if (openRouterServed) {
    // Resume streams may replay assistant messages; do not bill an ID twice.
    const priorIds = new Set(ledger(ctx).filter(r => !r.kind && r.session_id === record.session_id).flatMap(r => r.generation_ids ?? []));
    record.generation_ids = parsed.state.generation_ids.filter(value => !priorIds.has(value));
    Object.assign(record, await (dependencies.generationCosts ?? generationCosts)(record.generation_ids, { request: openRouterClient({ apiKey: env.ANTHROPIC_AUTH_TOKEN ?? env.OPENROUTER_API_KEY }) }));
  }
  if (p.costBasis === 'metered' && !parsed.state.usage_available) { record.cost_usd_est = null; record.budget_estimate_usd = budget.estimate_usd; }
  writeJson(path.join(dir, 'meta.json'), redact({ ...record, cumulative_tokens: cumulative, usage_available: parsed.state.usage_available, pi_cost_estimate_usd: p.adapter === 'pi' ? parsed.state.cost_reported_usd : undefined, cost_cap_usd: capUsd ?? undefined, killed: killed ?? undefined, error, resume_run: prev?.run_id ?? null }));
  append(ctx, record, 'runs', redact);
  return record;
}
