import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context, PLUGIN, ROOT, read, json, write, writeJson, redactor, resolveEnv, environmentValue, windowsEnvironment, registerSecret } from '../bin/lib/util.mjs';
import { catalog, provider } from '../bin/lib/prices.mjs';
import { parser, invocation } from '../bin/lib/adapters.mjs';
import { accountStatus, openRouterClient, generationCosts } from '../bin/lib/openrouter.mjs';
import { gate, decisionRequest, gateVerdict, acceptanceSection, sourceFirstPatch } from '../bin/lib/gate.mjs';
import { append, ledger, runDir } from '../bin/lib/ledger.mjs';
import { budgetStatus, budgetCheck, chargedCost } from '../bin/lib/budget.mjs';
import { route, policy, scoreboard } from '../bin/lib/route.mjs';
import { judge, calibration } from '../bin/lib/judge.mjs';
import { run } from '../bin/lib/run.mjs';

const jevResponse = () => json(new URL('fixtures/jev-response.json', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-v11-')), ctx = context(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  ctx.accountStatus = async () => ({ status: 'unavailable' });
  for (const f of ['budget/limits.json', 'routing/policy.json']) writeJson(path.join(ctx.data, f), json(path.join(ROOT, '.harness', f)));
  return ctx;
}
function worker(ctx, runId = 'fixture-worker', exit = 0) {
  const r = { run_id: runId, ts: '2026-09-23T00:00:00Z', model: 'codex:gpt-6-sol', family: 'openai', cost_basis: 'quota', cost_usd_est: null, role: 'worker', task_class: 'mechanical', exit_code: exit, cwd_rel: '.' };
  append(ctx, r); const dir = runDir(ctx, runId);
  write(path.join(dir, 'brief.md'), '# Goal\nSmall fixture\n## Acceptance\nCreate hello.txt containing hello and LF.\n## Constraints\nOnly hello.txt.');
  write(path.join(dir, 'diff.stat'), 'hello.txt | 1 +\n');
  write(path.join(dir, 'diff.patch'), 'diff --git a/hello.txt b/hello.txt\nnew file mode 100644\n--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+hello\n');
  return r;
}
function verify(ctx, runId, exit_code = 0, ts = '2026-09-23T00:01:00Z') { append(ctx, { kind: 'verify', run_id: runId, ts, cmd: 'node check.mjs', exit_code }); }

test('Environment lookup prefers process values and supports both registry string types safely', () => {
  let calls = 0;
  assert.equal(environmentValue('FIXTURE_ENV', { FIXTURE_ENV: 'process-fixture-value' }, () => { calls++; }), 'process-fixture-value');
  assert.equal(calls, 0);
  for (const type of ['REG_SZ', 'REG_EXPAND_SZ']) {
    const value = windowsEnvironment('FIXTURE_ENV', (file, args, opts) => {
      assert.equal(file, 'reg'); assert.deepEqual(args, ['query', 'HKCU\\Environment', '/v', 'FIXTURE_ENV']);
      assert.equal(opts.windowsHide, true); assert.equal(opts.shell, false); assert.equal(opts.encoding, 'utf8');
      return `HKEY_CURRENT_USER\\Environment\r\n    FIXTURE_ENV    ${type}    registry-fixture-value\r\n`;
    });
    assert.equal(value, 'registry-fixture-value');
  }
  assert.equal(windowsEnvironment('FIXTURE_ENV', () => { throw new Error('never expose registry stderr'); }), undefined);
  assert.equal(windowsEnvironment('FIXTURE_ENV', () => '    FIXTURE_ENV    REG_DWORD    123'), undefined);
  const env = resolveEnv({ env: { AUTH_TOKEN: '${ENV:FIXTURE_ENV}', ANTHROPIC_API_KEY: '' } }, {}, () => 'registry-reference-value');
  assert.equal(env.AUTH_TOKEN, 'registry-reference-value'); assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.throws(() => resolveEnv({ env: { AUTH_TOKEN: '${ENV:ABSENT}' } }, {}, () => undefined), /Missing/);
});

test('Resolved secrets redact through old/new redactors and error/result/ledger paths', async t => {
  const ctx = fixture(t), old = redactor({});
  resolveEnv({ env: { AUTH_TOKEN: '${ENV:SENSITIVE_FIXTURE}' } }, {}, () => 'late-registry-fixture-secret');
  assert.equal(old('late-registry-fixture-secret'), '[REDACTED]');
  assert.equal(redactor({})('late-registry-fixture-secret'), '[REDACTED]');
  append(ctx, { error: 'late-registry-fixture-secret', result: ['late-registry-fixture-secret'], api_key: 'arbitrary' });
  assert.ok(!read(path.join(ctx.data, 'ledger/runs.jsonl')).includes('late-registry-fixture-secret'));
  const status = await accountStatus({ request: async () => { throw new Error('late-registry-fixture-secret'); } });
  assert.equal(status.status, 'unavailable'); assert.equal(status.account.error, '[REDACTED]');
});

test('REG_EXPAND_SZ resolves process-first case-insensitive references and nested registry values', () => {
  const old = redactor({}), queries = [];
  const raw = 'expansion-fixture-prefix-%mIxEd_Process%-%Reg_CHAIn%';
  const values = {
    fixture_expand: { type: 'REG_EXPAND_SZ', value: raw },
    reg_chain: { type: 'REG_EXPAND_SZ', value: 'chain-fixture-%LeAf%' },
    leaf: { type: 'REG_SZ', value: 'registry-fixture-leaf' }
  };
  const execute = (file, args, opts) => {
    assert.equal(file, 'reg'); assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true);
    const key = args.at(-1).toLowerCase(); queries.push(key);
    const entry = values[key]; assert.ok(entry, 'Process references must not query the registry');
    return `    ${key.toUpperCase()}    ${entry.type}    ${entry.value}\r\n`;
  };
  const expanded = windowsEnvironment('FIXTURE_EXPAND', execute, { env: { Mixed_PROCESS: 'process-fixture-fragment' } });
  assert.equal(expanded, 'expansion-fixture-prefix-process-fixture-fragment-chain-fixture-registry-fixture-leaf');
  assert.deepEqual(queries, ['fixture_expand', 'reg_chain', 'leaf']);
  assert.equal(old(raw), '[REDACTED]'); assert.equal(old(expanded), '[REDACTED]');
  assert.equal(redactor({})(values.reg_chain.value), '[REDACTED]');
  if (process.platform === 'win32') {
    assert.equal(environmentValue('fixture_case', { FIXTURE_CASE: 'case-fixture-process' }, () => assert.fail('Process value must win')), 'case-fixture-process');
  }
});

test('REG_SZ keeps percent text literal, including when an expandable registry value references it', () => {
  const calls = [], values = {
    expandable: { type: 'REG_EXPAND_SZ', value: '%Literal%/%eMpTy%' },
    literal: { type: 'REG_SZ', value: 'literal-fixture-%NOT_DEFINED%' }
  };
  const lookup = key => { calls.push(key.toLowerCase()); return values[key.toLowerCase()]; };
  const execute = () => assert.fail('Injected lookup must avoid registry execution');
  const options = { env: { Empty: '' }, lookup };
  assert.equal(windowsEnvironment('Literal', execute, options), values.literal.value);
  assert.equal(windowsEnvironment('Expandable', execute, options), values.literal.value + '/');
  assert.deepEqual(calls, ['literal', 'expandable', 'literal']);
});

test('Registry expansion fails closed on cycles, missing references, depth and size limits without secret errors', () => {
  const execute = () => assert.fail('Fixture must never query the live registry');
  for (const values of [
    { fixture_root: 'cycle-fixture-secret-%FIXTURE_ROOT%' },
    { fixture_root: 'cycle-fixture-secret-%SECOND%', second: '%fixture_ROOT%' },
    { fixture_root: 'missing-fixture-secret-%ABSENT%' }
  ]) {
    const old = redactor({}); let calls = 0;
    const lookup = key => { calls++; return values[key.toLowerCase()]; };
    const resolve = key => windowsEnvironment(key, execute, { env: {}, lookup });
    assert.equal(resolve('FIXTURE_ROOT'), undefined); assert.ok(calls <= 2);
    assert.equal(old(values.fixture_root), '[REDACTED]');
    assert.throws(() => resolveEnv({ env: { AUTH_TOKEN: '${ENV:FIXTURE_ROOT}' } }, {}, resolve), error => error.message === 'Missing provider environment variable: FIXTURE_ROOT');
  }
  let calls = 0;
  const deep = windowsEnvironment('DEPTH_0', execute, { env: {}, lookup: key => { calls++; return `%DEPTH_${Number(key.split('_')[1]) + 1}%`; } });
  assert.equal(deep, undefined); assert.equal(calls, 16);
  const wide = windowsEnvironment('WIDE', execute, { env: { FRAGMENT: 'wide-fixture-fragment' }, lookup: () => '%FRAGMENT%'.repeat(129) });
  assert.equal(wide, undefined);
  const large = windowsEnvironment('LARGE', execute, { env: { FRAGMENT: 'large-fixture-fragment'.repeat(1000) }, lookup: () => '%FRAGMENT%%FRAGMENT%' });
  assert.equal(large, undefined);
  assert.equal(windowsEnvironment('ERROR', execute, { env: {}, lookup: () => { throw new Error('fixture-secret-error-from-lookup'); } }), undefined);
});

test('Catalog contains the 14 pinned OpenRouter workers on the pi adapter, the measured orc A/B sibling, and Jev gate', () => {
  const models = catalog(context()), workers = models.filter(m => m.id.startsWith('or:'));
  assert.equal(workers.length, 14);
  assert.ok(models.every(m => m.enabled && m.model !== 'TBD' && !m.model.includes('contributor')));
  // The orc sibling exists only where the Claude Code path was measured in v1.1.
  const compat = models.filter(m => m.id.startsWith('orc:'));
  assert.deepEqual(compat.map(m => m.model), ['z-ai/glm-5.3-flash']);
  assert.ok(compat.every(m => m.adapter === 'anthropic-compat'));
  for (const m of workers) {
    assert.equal(m.adapter, 'pi'); assert.equal(m.costBasis, 'metered');
    assert.deepEqual(m.efforts, ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(m.prices.source, 'https://openrouter.ai/api/v1/models'); assert.equal(m.prices.asOf, '2026-09-23');
    assert.deepEqual(m.env, { OPENROUTER_API_KEY: '${ENV:OPENROUTER_API_KEY}' });
    assert.ok(m.dataNotes.length > 20 && m.dataPolicy.length);
    assert.match(m.notes, /pi adapter/);
    const call = invocation(m, { cwd: '/fixture', effort: 'default', promptFile: '/fixture/prompt.md', sessionDir: '/fixture/sessions' }, () => ({ file: 'fixture-cli', prefix: [] }));
    assert.ok(!call.args.includes('--thinking'));
    assert.equal(call.args[call.args.indexOf('--session-dir') + 1], '/fixture/sessions');
    assert.equal(call.args.at(-1), '@/fixture/prompt.md');
  }
  const jev = provider(context(), 'jev'); assert.equal(jev.family, 'typesafe'); assert.equal(jev.adapter, 'decisions'); assert.equal(jev.prices.inputPerMTok, .042); assert.equal(jev.prices.outputPerMTok, 0);
  assert.equal(provider(context(), 'or:glm-5.3-flash').prices.cachedInputPerMTok, .05);
  for (const id of ['or:deepseek-v4.1-flash', 'or:kimi-k3', 'or:minimax-m3']) assert.ok(provider(context(), id).dataPolicy.includes('may-train'));
  assert.match(provider(context(), 'or:deepseek-v4.1-flash').dataNotes, /declares training/);
});

test('OpenRouter HTTP client uses exact endpoints and does not expose response error bodies', async () => {
  const seen = [], request = openRouterClient({ apiKey: 'fixture-http-secret', fetchImpl: async (url, opts) => {
    seen.push({ url, opts }); return { ok: true, json: async () => ({ data: { usage: 1, limit_remaining: 29, total_credits: 30, total_usage: 1 } }) };
  } });
  const status = await accountStatus({ request });
  assert.equal(status.status, 'available'); assert.equal(status.account.usage, 1); assert.equal(status.credits.total_credits, 30);
  assert.deepEqual(seen.map(s => s.url), ['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/credits']);
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer fixture-http-secret'); assert.equal(seen[0].opts.method, 'GET');
  const unavailable = await accountStatus({ env: {}, lookup: () => undefined, fetchImpl: () => assert.fail('Missing credentials must not fetch') });
  assert.equal(unavailable.status, 'unavailable');
  const failRequest = openRouterClient({ apiKey: 'fixture-http-secret', fetchImpl: async () => ({ ok: false, status: 401, json: () => assert.fail('Do not read sensitive error bodies') }) });
  await assert.rejects(failRequest('/v1/key'), /HTTP 401/);
});

test('Generation fixture deduplicates streamed IDs and retries lagged stats; Claude cost is ignored', async () => {
  const p = parser('anthropic-compat');
  for (const id of ['gen-one', 'gen-one', 'msg-native', 'gen-two']) p.feed({ type: 'assistant', message: { id, content: [] } });
  p.feed({ type: 'result', result: 'ok', total_cost_usd: 999 });
  assert.deepEqual(p.state.generation_ids, ['gen-one', 'gen-two']);
  const attempts = new Map(); let now = 0;
  const result = await generationCosts(p.state.generation_ids.concat('gen-one'), { now: () => now, sleep: async ms => { now += ms; }, request: async endpoint => {
    const id = new URL(`https://example.invalid${endpoint}`).searchParams.get('id');
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
    if (id === 'gen-two' && attempts.get(id) === 1) throw Object.assign(new Error('OpenRouter HTTP 404'), { status: 404 });
    return { data: { total_cost: id === 'gen-one' ? .01 : .02 } };
  } });
  assert.equal(result.cost_usd_actual, .03); assert.equal(result.generation_stats.complete, true); assert.equal(result.generation_stats.coverage, 1);
  assert.equal(attempts.get('gen-one'), 1); assert.equal(attempts.get('gen-two'), 2); assert.equal(result.generation_stats.diagnostics[1].errors.length, 1);
});

test('Interrupted compatibility streams preserve unknown placeholder usage and deduplicate later snapshots', () => {
  const p = parser('anthropic-compat');
  const event = (input, output) => ({ type: 'assistant', message: { id: 'gen-interrupted', content: [], usage: { input_tokens: input, output_tokens: output } } });
  p.feed(event(0, 0)); assert.equal(p.state.usage_available, false);
  p.feed(event(100, 10)); p.feed(event(100, 10)); p.feed(event(100, 20));
  assert.deepEqual(p.state.tokens, { in: 100, cached_in: 0, out: 20, reasoning: 0 });
  assert.equal(p.state.usage_available, true);
});

test('Missing/partial generation statistics never present a complete actual cost', async () => {
  let now = 0;
  const partial = await generationCosts(['gen-ok', 'gen-missing'], { maxWaitMs: 2000, now: () => now, sleep: async ms => { now += ms; }, request: async endpoint => endpoint.includes('gen-ok') ? { data: { total_cost: .01 } } : { data: { total_cost: null } } });
  assert.equal(partial.cost_usd_actual, null); assert.equal(partial.cost_usd_actual_partial, .01); assert.equal(partial.generation_stats.coverage, .5); assert.ok(partial.generation_stats.diagnostics[1].error); assert.ok(now <= 2000);
  const empty = await generationCosts([], { request: () => assert.fail('No IDs') }); assert.equal(empty.cost_usd_actual, null); assert.equal(empty.generation_stats.complete, false);
  const auth = await generationCosts(['gen-denied'], { request: async () => { throw Object.assign(new Error('OpenRouter HTTP 401'), { status: 401 }); } });
  assert.equal(auth.generation_stats.diagnostics[0].attempts, 1);
});

test('Generation collection caps distinct IDs at 200 and concurrency at four', async () => {
  let inFlight = 0, peak = 0, calls = 0;
  const result = await generationCosts(Array.from({ length: 205 }, (_, i) => `gen-${i}`), { request: async () => {
    calls++; peak = Math.max(peak, ++inFlight); await new Promise(resolve => setImmediate(resolve)); inFlight--; return { data: { total_cost: .001 } };
  } });
  assert.equal(calls, 200); assert.equal(peak, 4); assert.equal(result.cost_usd_actual, null); assert.equal(result.generation_stats.capped, true); assert.equal(result.generation_stats.expected, 205);
});

test('Budget counts gate usage, prefers actual, falls back on estimate, and keeps UTC boundaries', async t => {
  const ctx = fixture(t), now = new Date('2026-09-23T12:00:00Z');
  for (const r of [
    { run_id: 'actual', ts: '2026-09-23', cost_usd_actual: .1, cost_usd_est: .9 },
    { run_id: 'partial', ts: '2026-09-23', cost_usd_actual: null, cost_usd_actual_partial: .02, cost_usd_est: .3 },
    { run_id: 'fallback', ts: '2026-09-23', cost_usd_est: null, budget_estimate_usd: .5 },
    { run_id: 'yesterday', ts: '2026-09-22', cost_usd_est: .2 },
    { run_id: 'last-month', ts: '2026-08-31', cost_usd_actual: 20 }
  ]) append(ctx, { cost_basis: 'metered', model: 'or:glm-5.3-flash', ...r });
  append(ctx, { kind: 'gate', model: 'jev', ts: '2026-09-23', cost_basis: 'metered', cost_usd_actual: .001, cost_usd_est: .01, usage: { cost: .001 } }, 'gate');
  const b = budgetStatus(ctx, now); assert.ok(Math.abs(b.day_usd - .901) < 1e-10); assert.ok(Math.abs(b.month_usd - 1.101) < 1e-10);
  assert.equal(b.limits.metered.monthly_usd, 30); assert.equal(b.limits.metered.conservative_default_usd, .5);
  assert.equal((await budgetCheck(ctx, provider(ctx, 'or:glm-5.3-flash'), 1.01, now)).allowed, false);
});

test('Known partial spend controls budget boundaries, recent estimates and routing utility', async t => {
  const ctx = fixture(t), now = new Date('2026-09-23T12:00:00Z'), model = 'or:glm-5.3-flash';
  writeJson(path.join(ctx.data, 'budget/limits.json'), { metered: { monthly_usd: 1, daily_usd: 1, per_run_usd: 1, conservative_default_usd: .4 }, quota: null });
  const partial = { run_id: 'partial-boundary', ts: '2026-09-23T01:00:00Z', model, role: 'worker-mech', task_class: 'mechanical', cost_basis: 'metered', cost_usd_actual: null, cost_usd_actual_partial: .75, cost_usd_est: .125, wall_s: 4 };
  append(ctx, partial); append(ctx, { kind: 'outcome', run_id: partial.run_id, result: 'pass' });
  const status = budgetStatus(ctx, now); assert.equal(status.day_usd, .75); assert.equal(status.month_usd, .75);
  assert.equal((await budgetCheck(ctx, provider(ctx, model), .25, now)).allowed, true);
  assert.equal((await budgetCheck(ctx, provider(ctx, model), .250001, now)).allowed, false);
  const recent = (await budgetCheck(ctx, provider(ctx, model), undefined, now));
  assert.equal(recent.estimate_usd, .75); assert.equal(recent.allowed, false);
  assert.equal(scoreboard(ctx, false, now).rows[0].mean_cost, .75);
  const candidate = route(ctx, { role: 'worker-mech', 'task-class': 'mechanical' }).candidates.find(c => c.model === model), p = policy(ctx);
  assert.equal(candidate.utility, candidate.p_pass - p.lambda_cost * .75 - p.lambda_time * 4);
  assert.equal(partial.cost_usd_actual, null, 'A cost floor is not a complete actual cost');
  assert.equal(chargedCost({ ...partial, cost_usd_actual: .2 }), .2);
  assert.equal(chargedCost({ ...partial, cost_usd_actual: 0 }), 0);
});

test('Partial costs respect larger estimates and configured defaults without inventing free unknown usage', async t => {
  assert.equal(chargedCost({ cost_usd_actual_partial: .1, cost_usd_est: .3 }), .3);
  assert.equal(chargedCost({ cost_usd_actual_partial: .6, budget_estimate_usd: .4 }), .6);
  assert.equal(chargedCost({ cost_usd_actual_partial: .1, budget_estimate_usd: .4 }), .4);
  assert.equal(chargedCost({ cost_usd_actual_partial: .1 }), .5);
  assert.equal(chargedCost({ cost_usd_actual_partial: 0 }, null), null);
  assert.equal(chargedCost({}, null), null);
  const ctx = fixture(t), now = new Date('2026-09-23T12:00:00Z'), model = 'or:glm-5.3-flash';
  writeJson(path.join(ctx.data, 'budget/limits.json'), { metered: { monthly_usd: 2, daily_usd: 2, per_run_usd: 1, conservative_default_usd: .4 }, quota: null });
  append(ctx, { run_id: 'partial-default', ts: '2026-09-23T01:00:00Z', model, cost_basis: 'metered', cost_usd_actual: null, cost_usd_actual_partial: .1, cost_usd_est: null });
  assert.equal(budgetStatus(ctx, now).day_usd, .4);
  assert.equal((await budgetCheck(ctx, provider(ctx, model), undefined, now)).estimate_usd, .4);
});

test('Gate request extracts acceptance, orders source before large test diffs, and bounds Unicode bytes', () => {
  const brief = '# Goal\nDo not include this preamble\n## Acceptance\nCreate a source file.\n## Other\nUnrelated';
  assert.equal(acceptanceSection(brief), 'Create a source file.');
  assert.equal(acceptanceSection('Goal: fixture\nAcceptance (all expected exit 0): node check.mjs\nDeliver: patch'), 'node check.mjs');
  assert.equal(acceptanceSection('Acceptance (/goal):\n- node --test\nDeliver: patch'), '- node --test');
  const patch = 'diff --git a/test/a.test.mjs b/test/a.test.mjs\n+' + 'test\n'.repeat(10000) + 'diff --git a/src/app.mjs b/src/app.mjs\n+source change\n';
  assert.ok(sourceFirstPatch(patch).startsWith('diff --git a/src/'));
  const payload = decisionRequest({ brief: brief.replace('Create a source file.', '日本語'.repeat(10000)), stat: 's'.repeat(2000), patch, checks: Array.from({ length: 200 }, () => ({ cmd: 'node ' + 'a'.repeat(100), exit_code: 0 })) });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 24000); assert.equal(payload.questions.acceptance.type, 'choice');
  assert.deepEqual(Object.keys(payload.questions.acceptance.criteria), ['pass', 'fail', 'needs_review']);
  assert.equal(payload.questions.scope_creep.type, 'noul'); assert.equal(payload.questions.tests_touched_when_needed.type, 'noul');
});

test('Jev fixture maps confidence and scope strictly, with escalation for malformed evidence', () => {
  const r = jevResponse(); assert.equal(gateVerdict(r), 'pass');
  r.answers.scope_creep.noul = .3; assert.equal(gateVerdict(r), 'escalate');
  r.answers.acceptance.choice = 'fail'; assert.equal(gateVerdict(r), 'fail');
  r.answers.acceptance.confidence = .79; assert.equal(gateVerdict(r), 'escalate');
  r.answers.acceptance.choice = 'needs_review'; r.answers.acceptance.confidence = 1; assert.equal(gateVerdict(r), 'escalate');
  assert.equal(gateVerdict({}), 'escalate');
});

test('Gate fails deterministically without network for worker failure or any historical verify failure', async t => {
  const ctx = fixture(t);
  const a = worker(ctx, 'bad-worker', 1), b = worker(ctx, 'bad-check');
  verify(ctx, b.run_id, 1); verify(ctx, b.run_id, 0, '2026-09-23T00:02:00Z');
  for (const r of [a, b]) {
    const g = await gate(ctx, { 'worker-run': r.run_id }, { request: () => assert.fail('Deterministic failure must not spend') });
    assert.equal(g.verdict, 'fail'); assert.equal(g.mode, 'deterministic'); assert.equal(g.cost_usd_actual, 0);
  }
  assert.equal(ledger(ctx, 'gate').length, 2);
});

test('Gate fixture POST and response persist usage.cost separately from estimate, without a network', async t => {
  const ctx = fixture(t), w = worker(ctx); verify(ctx, w.run_id);
  const request = openRouterClient({ apiKey: 'fixture-decision-secret', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/alpha/decisions'); assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body); assert.equal(body.model, 'typesafe/jev-1.13'); assert.equal(body.state.diff.stat, 'hello.txt | 1 +\n'); assert.match(body.state.verification, /node check.mjs/);
    return { ok: true, json: async () => jevResponse() };
  } });
  const g = await gate(ctx, { 'worker-run': w.run_id }, { request });
  assert.equal(g.verdict, 'pass'); assert.equal(g.cost_usd_actual, .00001995); assert.equal(g.usage.input_tokens, 475);
  assert.equal(ledger(ctx, 'gate')[0].usage.cost, .00001995); assert.ok(fs.existsSync(path.join(runDir(ctx, g.gate_id), 'response.json')));
  const skip = await judge(ctx, { 'worker-run': w.run_id, 'after-gate': true }, { run: () => assert.fail('Decisive gate skips judge') });
  assert.equal(skip.skipped, true); assert.equal(skip.verdict, 'pass');
  append(ctx, { ...g, gate_id: 'later-fail', verdict: 'fail' }, 'gate');
  assert.equal((await judge(ctx, { 'worker-run': w.run_id, 'after-gate': true })).verdict, 'fail');
});

test('Missing checks, missing usage, or network errors escalate without fabricated actual cost', async t => {
  const ctx = fixture(t), w = worker(ctx);
  const noChecks = await gate(ctx, { 'worker-run': w.run_id }, { request: async () => jevResponse() }); assert.equal(noChecks.verdict, 'escalate');
  verify(ctx, w.run_id);
  const noUsage = await gate(ctx, { 'worker-run': w.run_id }, { request: async () => ({ answers: {} }) });
  assert.equal(noUsage.cost_usd_actual, null); assert.equal(noUsage.verdict, 'escalate');
  registerSecret('fixture-gate-error-secret');
  const err = await gate(ctx, { 'worker-run': w.run_id }, { request: async () => { throw new Error('fixture-gate-error-secret'); } });
  assert.equal(err.verdict, 'escalate'); assert.equal(err.error, '[REDACTED]'); assert.equal(err.cost_usd_actual, null);
  await assert.rejects(gate(ctx, { 'worker-run': w.run_id, threshold: 1.01 }), /threshold/);
});

test('Escalated gate invokes independent-family judge; pairwise excludes every candidate', async t => {
  const ctx = fixture(t), w = worker(ctx); verify(ctx, w.run_id);
  append(ctx, { worker_run: w.run_id, gate_id: 'escalated', verdict: 'escalate' }, 'gate');
  let called = 0;
  const result = await judge(ctx, { 'worker-run': w.run_id, 'after-gate': true }, { run: async (c, o) => {
    called++; assert.equal(o.model, 'claude:opus'); assert.equal(o.sandbox, 'read-only');
    const j = worker(c, 'fixture-judge');
    write(path.join(runDir(c, j.run_id), 'final.md'), JSON.stringify({ verdict: 'pass', scores: { correctness: 4, regressions: 4, scope: 4, tests: 4 }, confidence: .9, issues: [] }));
    return j;
  } });
  assert.equal(called, 1); assert.equal(result.verdict, 'pass');
  const second = { ...w, run_id: 'claude-candidate', family: 'anthropic', model: 'claude:opus' }; append(ctx, second);
  await assert.rejects(judge(ctx, { 'worker-run': w.run_id, vs: second.run_id, judge: 'claude:opus' }), /every candidate/);
  await assert.rejects(judge(ctx, { 'worker-run': w.run_id, vs: second.run_id, judge: 'codex:gpt-6-sol' }), /every candidate/);
});

test('Routing auto selects highest utility in allowed families, excludes may-train, and prices actual', async t => {
  const ctx = fixture(t);
  for (let i = 0; i < 20; i++) {
    append(ctx, { run_id: `judge-${i}`, ts: new Date().toISOString(), role: 'judge', task_class: 'mechanical', model: 'or:glm-5.3', cost_usd_actual: .001, cost_usd_est: 5, wall_s: 1 });
    append(ctx, { kind: 'outcome', run_id: `judge-${i}`, result: 'pass' });
  }
  assert.ok(Math.abs(scoreboard(ctx).rows[0].mean_cost - .001) < 1e-12);
  const routed = route(ctx, { role: 'judge', 'task-class': 'mechanical', 'exclude-family': ['openai', 'anthropic'] });
  assert.equal(routed.model, 'or:glm-5.3'); assert.equal(routed.exploring, false);
  const p = policy(ctx); p.data_policy.allow_may_train = false; writeJson(path.join(ctx.data, 'routing/policy.json'), p);
  assert.throws(() => route(ctx, { role: 'judge', 'exclude-family': ['openai', 'anthropic', 'zhipu'] }), /No eligible/);
  const models = route(ctx, { role: 'worker-mech' }).candidates.map(m => m.model); assert.ok(!models.includes('or:deepseek-v4.1-flash')); assert.ok(models.includes('or:mimo-v2.6-pro'));
  const brief = path.join(ctx.root, 'brief.md'); write(brief, 'Fixture');
  await assert.rejects(run(ctx, { model: 'or:kimi-k3', cwd: ctx.root, brief }), /data policy/);
});

test('Calibration includes gate agreement with deterministic and LLM verdicts', t => {
  const ctx = fixture(t), w = worker(ctx); verify(ctx, w.run_id);
  append(ctx, { kind: 'gate', gate_id: 'g1', ts: '2026-09-23T01:00:00Z', worker_run: w.run_id, verdict: 'pass' }, 'gate');
  append(ctx, { kind: 'gate', gate_id: 'g2', ts: '2026-09-23T01:01:00Z', worker_run: w.run_id, verdict: 'escalate' }, 'gate');
  append(ctx, { kind: 'judge', mode: 'single', worker_runs: [w.run_id], ts: '2026-09-23T02:00:00Z', verdict: 'fail' }, 'judge');
  const c = calibration(ctx); assert.equal(c.gate.deterministic.agree, 1); assert.equal(c.gate.deterministic.uncertain, 1); assert.equal(c.gate.llm.agree, 0); assert.equal(c.gate.llm.mismatches.length, 1);
});
