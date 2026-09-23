import fs from 'node:fs';
import path from 'node:path';
import { read, json, write, writeJson, id, git, exec, redactor, resolveEnv, required, positive, fail, VERSION } from './util.mjs';
import { append, ledger, getRun, runDir } from './ledger.mjs';
import { provider, price } from './prices.mjs';
import { requireBudget } from './budget.mjs';
import { parser, invocation } from './adapters.mjs';

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
export async function run(ctx, o) {
  required(o, 'model', 'cwd', 'brief');
  const p = provider(ctx, o.model), effort = o.effort ?? p.defaultEffort;
  if (!p.efforts.includes(effort)) fail(`Unsupported effort for ${p.id}: ${effort}`);
  if (o.sandbox && !['write', 'read-only'].includes(o.sandbox)) fail('Sandbox must be write or read-only');
  const cwd = path.resolve(o.cwd), brief = read(path.resolve(o.brief));
  const prev = o.resume ? getRun(ctx, o.resume) : null;
  if (prev && (prev.model !== p.id || path.resolve(ctx.root, prev.cwd_rel) !== cwd || !prev.session_id)) fail('Resume requires the same model, cwd, and a stored session_id');
  if (prev) { o = { ...o, role: o.role ?? prev.role, ticket: o.ticket ?? prev.ticket, 'task-class': o['task-class'] ?? prev.task_class }; }
  const env = resolveEnv(p), redact = redactor(env), budget = requireBudget(ctx, p, o['estimate-usd']);
  const base = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  const runId = id(o.role === 'judge' ? 'judge' : 'run'), dir = runDir(ctx, runId), start = Date.now();
  const prompt = o.role === 'judge' ? brief : `${guidance(cwd)}\n\nYou are a terminal worker. Implement or inspect this brief directly; do not delegate to another implementation CLI or agent. Do not commit. Report verification exit codes.\n\n${brief}`;
  write(path.join(dir, 'brief.md'), redact(brief));
  write(path.join(dir, 'prompt.md'), redact(prompt));
  const initial = await captureDiff(cwd, base);
  write(path.join(dir, 'initial.patch'), redact(initial.patch));
  if (o.schema) writeJson(path.join(dir, 'schema.json'), o.schema);
  write(path.join(dir, 'events.jsonl'), '');
  const parsed = parser(p.adapter); let pending = '', stderrPending = '', result, error = null;
  const event = line => {
    if (!line.trim()) return;
    let value; try { value = JSON.parse(line); } catch { value = { type: 'raw', text: line }; }
    parsed.feed(value); fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(redact(value)) + '\n', 'utf8');
  };
  let call;
  try {
    call = invocation(p, { cwd, effort, sandbox: o.sandbox, session_id: prev?.session_id, promptFile: path.join(dir, 'prompt.md'), schema: o.schema, schemaFile: o.schema ? path.join(dir, 'schema.json') : undefined, judge: o.role === 'judge' });
    result = await exec(call.file, call.args, { cwd, env, input: prompt, timeoutMs: positive(o['timeout-min'], 30) * 60_000,
      onStdout(data) { pending += data; let n; while ((n = pending.indexOf('\n')) >= 0) { event(pending.slice(0, n)); pending = pending.slice(n + 1); } },
      onStderr(data) { stderrPending += data; let n; while ((n = stderrPending.indexOf('\n')) >= 0) { fs.appendFileSync(path.join(dir, 'stderr.log'), redact(stderrPending.slice(0, n + 1)), 'utf8'); stderrPending = stderrPending.slice(n + 1); } }
    });
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
  const record = { run_id: runId, ts: new Date(start).toISOString(), role: o.role ?? 'worker', ticket: o.ticket ?? null, task_class: o['task-class'] ?? 'unclassified', model: p.id, family: p.family, adapter: p.adapter, effort, cwd_rel: path.relative(ctx.root, cwd).replaceAll('\\', '/'), base_sha: base, tokens: parsed.state.tokens, cost_usd_est: price(parsed.state.tokens, p.prices), cost_basis: p.costBasis, wall_s: (Date.now() - start) / 1000, exit_code: result.exit_code || (parsed.state.failed || !parsed.state.final ? 1 : 0), session_id: parsed.state.session_id ?? call?.session_id ?? null, diff: captured.diff, harness_ver: VERSION };
  if (p.costBasis === 'metered' && !parsed.state.usage_available) { record.cost_usd_est = null; record.budget_estimate_usd = budget.estimate_usd; }
  writeJson(path.join(dir, 'meta.json'), redact({ ...record, cumulative_tokens: cumulative, usage_available: parsed.state.usage_available, error, resume_run: prev?.run_id ?? null }));
  append(ctx, record, 'runs', redact);
  return record;
}
