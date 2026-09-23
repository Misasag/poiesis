import fs from 'node:fs';
import path from 'node:path';
import { git, command, read, json, write, writeJson, safeId, fail, positive, id, redactor } from './util.mjs';
import { withWorktree, applyFiles } from './worktree.mjs';
import { run } from './run.mjs';
import { verify } from './verify.mjs';
import { outcome } from './ledger.mjs';
import { judge } from './judge.mjs';
import { provider } from './prices.mjs';
import { budgetCheck, meteredLimits } from './budget.mjs';

function parts(value) {
  if (typeof value !== 'string' || !value.trim()) fail('Empty benchmark script');
  const commands = value.split('&&').map(s => s.trim());
  if (commands.some(s => !s || /[|&;<>`$%()\r\n"'\\]/.test(s))) fail(`Unsafe benchmark script: ${value}`);
  return commands;
}
const nodeScript = /^node (scripts\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.mjs)(?: [a-zA-Z0-9_./:=@-]+)*$/;
const npmScript = /^npm run ([a-zA-Z0-9_:-]+)(?: --workspace=([a-zA-Z0-9_@/.-]+))?$/;
const unique = values => [...new Set(values)];
const parse = text => JSON.parse(text.replace(/^\uFEFF/, ''));
async function packageAt(ctx, sha, file = 'package.json') { return parse((await git(ctx.root, ['show', `${sha}:${file}`])).stdout); }

// Expand scripts before execution. Fix-added scripts may reference only base
// scripts; never install the fix's package.json in the acceptance environment.
export async function testCommands(ctx, base, fix, tests) {
  const basePkg = await packageAt(ctx, base), fixPkg = await packageAt(ctx, fix);
  const workspacePkgs = new Map();
  async function workspace(name) {
    if (!workspacePkgs.size) {
      const files = (await git(ctx.root, ['ls-tree', '-r', '--name-only', base])).stdout.split('\n').filter(f => /\/package\.json$/.test(f));
      for (const file of files) { const pkg = await packageAt(ctx, base, file); if (pkg.name) workspacePkgs.set(pkg.name, pkg); }
    }
    if (!workspacePkgs.has(name)) fail(`Workspace missing at base: ${name}`);
    return workspacePkgs.get(name);
  }
  function noHooks(pkg, key) {
    for (const hook of [`pre${key}`, `post${key}`]) if (pkg.scripts?.[hook]) fail(`Lifecycle script is not allowed in benchmark: ${hook}`);
  }
  async function expand(value, chain = []) {
    const result = [];
    for (const cmd of parts(value)) {
      if (nodeScript.test(cmd)) { result.push(cmd); continue; }
      const match = cmd.match(npmScript);
      if (!match) fail(`Unsupported benchmark command: ${cmd}`);
      const [, key, name] = match;
      if (name) {
        if (key !== 'compile') fail(`Only workspace compile is allowed: ${cmd}`);
        const pkg = await workspace(name); noHooks(pkg, key);
        // The only non-node leaf is the workspace's local TypeScript compiler.
        if (!/^tsc(?: -p (?:\.|[a-zA-Z0-9_./-]+))?$/.test(pkg.scripts?.compile ?? '')) fail(`Unsafe workspace compile script: ${name}`);
        result.push(cmd); continue;
      }
      if (!basePkg.scripts?.[key]) fail(`Nested script missing at base: ${key}`);
      if (chain.includes(key)) fail(`Cyclic benchmark script: ${[...chain, key].join(' -> ')}`);
      noHooks(basePkg, key);
      result.push(...await expand(basePkg.scripts[key], [...chain, key]));
    }
    return result;
  }
  const result = [], selected = new Set();
  for (const file of tests) {
    const references = pkg => Object.entries(pkg.scripts ?? {}).filter(([key, value]) => key.startsWith('test:') && typeof value === 'string' && value.split(/\s+/).includes(file));
    const baseMatch = references(basePkg)[0], fixMatch = references(fixPkg)[0], match = baseMatch ?? fixMatch;
    if (!match) fail(`No test script at base or fix for ${file}`);
    if (selected.has(match[0])) continue;
    selected.add(match[0]);
    noHooks(baseMatch ? basePkg : fixPkg, match[0]);
    result.push(...await expand(match[1], [match[0]]));
  }
  // Preserve order and repeated steps inside a script. Only selecting the
  // same npm script for several changed tests is deduplicated.
  return result;
}

function benchmarkEnv(ctx) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_config_cache'));
  return { ...env, npm_config_cache: path.join(ctx.data, 'bench/npm-cache'), npm_config_update_notifier: 'false', npm_config_logs_max: '0' };
}
async function withBenchmarkEnv(ctx, fn) {
  const keys = ['npm_config_cache', 'npm_config_update_notifier', 'npm_config_logs_max'];
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.includes(key.toLowerCase())));
  const env = benchmarkEnv(ctx);
  for (const key of Object.keys(saved)) delete process.env[key];
  for (const key of keys) process.env[key] = env[key];
  try { return await fn(); }
  finally { for (const key of keys) delete process.env[key]; Object.assign(process.env, saved); }
}
async function commands(ctx, cmds, cwd) {
  const results = [];
  for (const cmd of cmds) {
    const result = { cmd, ...await command(cmd, cwd, {env: benchmarkEnv(ctx)}) }; results.push(result);
    // Do not test stale/absent build output after a failed build.
    if (result.exit_code && cmd.startsWith('npm run compile ')) break;
  }
  return results;
}
function setupFailure(entry, task) {
  if (entry.exit_code === 124) return 'test timed out';
  if (entry.cmd.startsWith('npm run compile ')) return 'workspace compile failed';
  const output = `${entry.stdout}\n${entry.stderr}`.replaceAll('\\', '/');
  const changedModule = missing => missing && task.src_files.some(f => {
    const built = f.replace('/src/', '/lib/').replace(/\.tsx?$/, '.js');
    return missing.endsWith(`/${built}`) || missing.endsWith(`/${built.replace(/\.js$/, '')}`) || missing.endsWith(`/${f}`) || missing.endsWith(`/${f.replace(/\.[cm]?js$/, '')}`);
  });
  if (/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|ENOENT/.test(output)) {
    // A new app module is a missing implementation. Missing dependencies,
    // test helpers and unrelated assets are preparation errors.
    const missing = output.match(/Cannot find (?:module|package) ['"]([^'"]+)['"]/i)?.[1];
    if (!changedModule(missing)) return `missing dependency, helper or asset${missing ? `: ${missing}` : ''}`;
  }
  const missingExport = /Named export|does not provide an export named/.test(output) && changedModule(output.match(/requested module ['"]([^'"]+)['"]/i)?.[1]);
  if (/Missing script:|not recognized as an internal|spawn .+ ENOENT|EACCES|EPERM/.test(output) || (/SyntaxError:/.test(output) && !missingExport)) return 'test environment or syntax failure';
  return null;
}
export async function validateTask(ctx, task) {
  if (!task.test_cmds?.length) fail('Task has no test commands');
  return withWorktree(ctx, task.base_sha, async cwd => {
    await applyFiles(ctx, cwd, task.base_sha, task.fix_sha, task.test_files);
    const before = await commands(ctx, task.test_cmds, cwd), failed = before.filter(x => x.exit_code !== 0);
    if (!failed.length) return { valid: false, reason: 'Tests already pass at base', before };
    const setup = failed.map(entry => ({ entry, reason: setupFailure(entry, task) })).find(x => x.reason);
    if (setup) return { valid: false, reason: `Base setup failure (${setup.entry.cmd}, exit ${setup.entry.exit_code}): ${setup.reason}`, before };
    await applyFiles(ctx, cwd, task.base_sha, task.fix_sha, task.src_files);
    // Incremental tsc leaves outputs of deleted sources behind. A fix must
    // pass from a clean build, not from the base's stale emitted JavaScript.
    await git(cwd, ['clean', '-ffdx', '--', 'agent-window/lib/']);
    const after = await commands(ctx, task.test_cmds, cwd);
    const valid = after.length === task.test_cmds.length && after.every(x => x.exit_code === 0), failure = after.find(x => x.exit_code !== 0);
    return { valid, reason: valid ? 'Validated fail-to-pass' : `Tests still fail with source changes (${failure?.cmd}, exit ${failure?.exit_code})`, before, after };
  });
}
function classify(files) { return files.some(f => f.includes('/browser/')) ? 'app-frontend' : 'app-backend'; }
const seconds = entries => Number((entries ?? []).reduce((sum, x) => sum + x.wall_s, 0).toFixed(3));
const area = task => task.test_files.map(f => path.basename(f).replace(/^test-/, '').split('-')[0]).sort()[0];
// Difficulty proxy: source lines changed (added+removed) across src_files and
// the number of touched source files. Binary rows count as zero lines.
export async function taskSize(ctx, task) {
  const nums = (await git(ctx.root, ['diff', '--numstat', task.base_sha, task.fix_sha, '--', ...task.src_files])).stdout;
  const lines = nums.trim().split('\n').filter(Boolean).reduce((sum, row) => {
    const [added, removed] = row.split('\t');
    return sum + (Number(added) || 0) + (Number(removed) || 0);
  }, 0);
  return { files: task.src_files.length, lines };
}
export function selectSuites(tasks) {
  const size = t => t.size ?? { files: Infinity, lines: Infinity };
  const sorted = [...tasks].sort((a, b) => size(a).lines - size(b).lines || size(a).files - size(b).files || a.id.localeCompare(b.id));
  // Smoke is the three smallest validated tasks by changed lines (ties break
  // on file count); medium is the middle third of the remaining tasks.
  const smoke = sorted.slice(0, Math.min(3, sorted.length)).map(t => t.id);
  const rest = sorted.slice(smoke.length).map(t => t.id), third = Math.floor(rest.length / 3);
  return { smoke, medium: rest.slice(third, rest.length - third), regression: sorted.map(t => t.id) };
}
export async function mine(ctx, o = {}) {
  const started = Date.now(), miningId = id('mine'), logDir = path.join(ctx.data, 'bench/validation', miningId), redact = redactor();
  const limit = positive(o.limit, 5); if (!Number.isInteger(limit)) fail('Limit must be an integer');
  const range = o.since ? `${(await git(ctx.root, ['rev-parse', '--verify', o.since])).stdout.trim()}..HEAD` : 'HEAD';
  const commits = (await git(ctx.root, ['log', '--format=%H', '--no-merges', range])).stdout.trim().split('\n').filter(Boolean);
  const validated = [], rejected = [], acceptedTasks = []; let candidates = 0;
  for (const fix of commits) {
    const parent = await git(ctx.root, ['rev-parse', `${fix}^`], { allowFailure: true }); if (parent.exit_code) continue;
    const base = parent.stdout.trim();
    const files = (await git(ctx.root, ['diff', '--name-only', base, fix, '--'])).stdout.trim().split('\n');
    const src = files.filter(f => f.startsWith('agent-window/src/')), tests = files.filter(f => /^scripts\/test-[^/]+\.mjs$/.test(f));
    if (!src.length || !tests.length) continue;
    if (candidates >= limit) break; candidates++;
    const taskId = `git-${fix.slice(0, 12)}`, logFile = path.join(logDir, `${taskId}.json`), candidateStarted = Date.now();
    let task, result;
    try {
      const present = new Set((await git(ctx.root, ['ls-tree', '-r', '--name-only', fix])).stdout.split('\n'));
      const testFiles = tests.filter(f => present.has(f));
      if (!testFiles.length) fail('All changed tests are deleted at fix');
      const cmds = await testCommands(ctx, base, fix, testFiles);
      task = { id: taskId, base_sha: base, fix_sha: fix, test_files: testFiles, test_cmds: cmds, src_files: src, class: classify(src), instruction_file: 'instruction.md', instruction_source: 'commit-message' };
      result = await validateTask(ctx, task);
      if (result.valid) {
        const dir = path.join(ctx.data, 'bench/tasks', taskId), message = (await git(ctx.root, ['show', '-s', '--format=%B', fix])).stdout.trim();
        write(path.join(dir, 'instruction.md'), `# Task\n\n${message}\n\nImplement the behavior described above in the existing source. Relevant areas:\n${src.map(f => `- ${f}`).join('\n')}\n\nOnly edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):\n${cmds.map(c => `- ${c}`).join('\n')}\n\nInstruction source: commit-message. Source paths are derived from the diff; no solution code is included.\n`);
        const summary = entries => entries.map(({ cmd, exit_code, wall_s }) => ({ cmd, exit_code, wall_s }));
        task.area = area(task);
        task.size = await taskSize(ctx, task);
        task.validation = { ts: new Date().toISOString(), before: summary(result.before), after: summary(result.after), before_wall_s: seconds(result.before), after_wall_s: seconds(result.after), log: path.relative(ctx.root, logFile).replaceAll('\\', '/') };
        writeJson(path.join(dir, 'task.json'), task); validated.push(taskId); acceptedTasks.push(task);
      }
    } catch (e) { result = { valid: false, reason: e.message }; }
    writeJson(logFile, redact({ id: taskId, base_sha: base, fix_sha: fix, task, ...result, wall_s: (Date.now() - candidateStarted) / 1000 }));
    if (!result.valid) rejected.push({ id: taskId, reason: result.reason, before_exits: result.before?.map(x => x.exit_code), after_exits: result.after?.map(x => x.exit_code), log: path.relative(ctx.root, logFile).replaceAll('\\', '/') });
  }
  const suites = selectSuites(acceptedTasks);
  for (const [name, ids] of Object.entries(suites)) write(path.join(ctx.data, 'bench/suites', `${name}.txt`), ids.join('\n') + (ids.length ? '\n' : ''));
  const reportPath = path.join(logDir, 'report.json');
  const report = { candidates, validated, rejected, suites, timings: acceptedTasks.map(t => ({ id: t.id, area: t.area, size: t.size, before_s: t.validation.before_wall_s, after_s: t.validation.after_wall_s })), wall_s: (Date.now() - started) / 1000, report: path.relative(ctx.root, reportPath).replaceAll('\\', '/') };
  writeJson(reportPath, redact(report)); writeJson(path.join(ctx.data, 'bench/latest-mine.json'), redact(report));
  return report;
}

// Rewrite suites from stored task.json files without re-validating. The only
// permitted task.json change is adding the computed size when absent.
export async function resuite(ctx) {
  const dir = path.join(ctx.data, 'bench/tasks'), tasks = [];
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name, 'task.json');
    if (!fs.existsSync(file)) continue;
    const task = json(file);
    if (!task.size) { task.size = await taskSize(ctx, task); writeJson(file, task); }
    tasks.push(task);
  }
  const suites = selectSuites(tasks);
  for (const [name, ids] of Object.entries(suites)) write(path.join(ctx.data, 'bench/suites', `${name}.txt`), ids.join('\n') + (ids.length ? '\n' : ''));
  return { tasks: tasks.length, sizes: Object.fromEntries(tasks.map(t => [t.id, t.size])), suites };
}

// Record violations before restoring tests and other evaluator inputs.
export async function restoreEvaluator(cwd, baseline) {
  const tracked = (await git(cwd, ['diff', '--name-only', '-z', baseline, '--'])).stdout.split('\0').filter(Boolean);
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  const ignored = (await git(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout.split('\0').filter(f =>
    f && f !== 'node_modules' && !f.startsWith('node_modules/') && !f.startsWith('agent-window/lib/'));
  const allowed = f => f.startsWith('agent-window/src/') && !fs.lstatSync(path.join(cwd, f), { throwIfNoEntry: false })?.isSymbolicLink();
  const deviations = unique([...tracked, ...untracked, ...ignored]).filter(f => !allowed(f)).sort();
  const frozen = (await git(cwd, ['ls-tree', '-r', '--name-only', baseline])).stdout.split('\n').filter(f => f && !f.startsWith('agent-window/src/'));
  if (frozen.length) await git(cwd, ['restore', '--source', baseline, '--staged', '--worktree', '--', ...frozen]);
  await git(cwd, ['reset', '--quiet', baseline, '--', '.']);
  // Remove generated build output and added helpers. git clean unlinks symlinks
  // without following targets; the shared dependency junction is excluded.
  await git(cwd, ['clean', '-ffdx', '-e', '/node_modules/', '-e', '/agent-window/src/']);
  return deviations;
}
function parallelLanes(value) {
  const n = value === undefined ? 1 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 4) fail('Parallel must be an integer between 1 and 4');
  return n;
}
export async function benchRun(ctx, o, services = { run, verify, outcome, judge }) {
  if (Boolean(o.suite) === Boolean(o.tasks) || typeof o.models !== 'string') fail('Specify --suite or --tasks, plus --models');
  const ids = unique(o.tasks ? o.tasks.split(',').map(s => s.trim()).filter(Boolean) : read(path.join(ctx.data, 'bench/suites', `${safeId(o.suite)}.txt`)).split(/\r?\n/).map(s => s.split('#')[0].trim()).filter(Boolean));
  const models = unique(o.models.split(',').map(s => s.trim()).filter(Boolean)), repeats = positive(o.repeats, 1); if (!Number.isInteger(repeats)) fail('Repeats must be an integer');
  if (!ids.length || !models.length) fail('Empty bench selection');
  const parallel = parallelLanes(o.parallel), timeoutMin = positive(o['timeout-min'], 20);
  const cells = [];
  for (const taskId of ids) {
    const taskDir = path.join(ctx.data, 'bench/tasks', safeId(taskId)), task = json(path.join(taskDir, 'task.json'));
    if (!task.test_cmds?.length) fail(`Task has no test commands: ${taskId}`);
    for (const model of models) for (let repeat = 0; repeat < repeats; repeat++) cells.push({ task, taskDir, model, repeat });
  }
  // Budget check+reserve is atomic per cell: concurrent lanes add in-flight
  // reservations before any worker starts, and release them once the actual
  // cost is recorded in the ledger. Ledger appends stay one JSON line each.
  let reservedUsd = 0, chain = Promise.resolve();
  const waiters = new Set();
  const critical = task => { const next = chain.then(task); chain = next.then(() => {}, () => {}); return next; };
  const reserveBudget = async model => {
    const p = provider(ctx, model);
    // --max-usd lowers the per-cell cap (and therefore the reservation) for cheap models.
    const capUsd = p.costBasis === 'metered' ? (o['max-usd'] === undefined ? meteredLimits(ctx).per_run_usd : positive(o['max-usd'])) : null;
    for (;;) {
      const gate = await critical(async () => {
        const check = await budgetCheck(ctx, p, undefined, undefined, { capUsd, reservedUsd });
        if (!check.allowed) {
          // Subscribe while holding the same lock as release, then wait outside
          // it. No lost wakeups, polling, or lock held by a waiting cell.
          if (check.blocked_by_reservations) return { wait: new Promise(resolve => waiters.add(resolve)) };
          return { allowed: false, reason: check.reason };
        }
        const reservation = check.reservation_usd ?? check.estimate_usd ?? 0;
        reservedUsd += reservation;
        return { allowed: true, reservation };
      });
      if (!gate.wait) return gate;
      await gate.wait;
    }
  };
  const runCell = async cell => {
    const gate = await reserveBudget(cell.model);
    if (!gate.allowed) {
      // A budget refusal is infrastructure, not model evidence.
      const row = { task: cell.task.id, model: cell.model, repeat: cell.repeat + 1, run_id: null, result: 'skipped_budget', judge: null, scope_deviations: [], verification: [], error: gate.reason };
      writeJson(path.join(ctx.data, 'bench/results', `budget-${id('cell')}.json`), redactor()(row));
      return row;
    }
    try {
      return await withWorktree(ctx, cell.task.base_sha, async cwd => {
        await applyFiles(ctx, cwd, cell.task.base_sha, cell.task.fix_sha, cell.task.test_files);
        await git(cwd, ['add', '--', ...cell.task.test_files]);
        await git(cwd, ['-c', 'user.name=Harness', '-c', 'user.email=harness@localhost', 'commit', '--quiet', '--allow-empty', '-m', 'Benchmark acceptance fixtures']);
        const baseline = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
        const r = await services.run(ctx, { model: cell.model, cwd, brief: path.join(cell.taskDir, safeId(cell.task.instruction_file)), role: 'worker', ticket: cell.task.id, 'task-class': cell.task.class, 'timeout-min': timeoutMin, ...(o['max-usd'] === undefined ? {} : { 'max-usd': o['max-usd'] }) });
        let v, error, deviations = [];
        try { if (!r.infra) { deviations = await restoreEvaluator(cwd, baseline); v = await services.verify(ctx, { cwd, run: r.run_id, cmd: cell.task.test_cmds }); } }
        catch (e) { error = e.message; }
        if (deviations.length) error = `Source-only scope violated: ${deviations.join(', ')}${error ? `; ${error}` : ''}`;
        // Quota exhaustion is infrastructure, not a model failure: the cell
        // is recorded as skipped and never counts as fail. A wall-clock
        // timeout is a speed failure, recorded distinctly from wrong answers.
        const result = r.infra === 'routing_config' ? 'skipped_routing' : r.infra === 'quota_exhausted' ? 'skipped_quota' : r.exit_code === 124 ? 'timeout' : !error && r.exit_code === 0 && v?.exit_code === 0 ? 'pass' : 'fail';
        services.outcome(ctx, r.run_id, result, r.infra ? `Infrastructure: ${r.routing_step ?? r.quota_source}` : result === 'timeout' ? `timeout: exceeded the ${timeoutMin} min wall cap before completing acceptance` : error ?? `Acceptance tests; repeat ${cell.repeat + 1}`);
        const j = o.judge === 'none' || r.infra ? null : await services.judge(ctx, { 'worker-run': r.run_id, judge: o.judge ?? 'auto' });
        const row = { task: cell.task.id, model: cell.model, repeat: cell.repeat + 1, run_id: r.run_id, result, ...(r.infra ? { infra: r.infra, routing_step: r.routing_step } : {}), judge: j?.verdict ?? null, scope_deviations: deviations, verification: v?.results ?? [], error: error ?? null };
        writeJson(path.join(ctx.data, 'bench/results', `${safeId(r.run_id)}.json`), redactor()(row));
        return row;
      }, { isolated: true });
    } finally {
      await critical(() => {
        reservedUsd = Math.max(0, reservedUsd - (gate.reservation ?? 0));
        for (const wake of waiters) wake();
        waiters.clear();
      });
    }
  };
  const results = await withBenchmarkEnv(ctx, async () => {
    const rows = new Array(cells.length);
    let cursor = 0;
    const lane = async () => { for (;;) { const i = cursor++; if (i >= cells.length) return; rows[i] = await runCell(cells[i]); } };
    const completed = await Promise.allSettled(Array.from({ length: parallel }, lane));
    const failure = completed.find(r => r.status === 'rejected');
    if (failure) throw failure.reason;
    return rows;
  });
  const count = value => results.filter(r => r.result === value).length;
  return { results, summary: { pass: count('pass'), fail: count('fail'), timeout: count('timeout'), skipped_quota: count('skipped_quota'), skipped_routing: count('skipped_routing'), skipped_budget: count('skipped_budget') }, exit_code: results.some(r => r.result === 'fail' || r.result === 'timeout') ? 1 : 0 };
}
