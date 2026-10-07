import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, context, write, writeJson, json, command } from '../bin/lib/util.mjs';
import { validateTask, mine, testCommands, selectSuites, taskSize, resuite, restoreEvaluator, benchRun } from '../bin/lib/bench.mjs';
import { withWorktree, dependencyCheck, normalizeLockfile, mainCheckout } from '../bin/lib/worktree.mjs';
import { append } from '../bin/lib/ledger.mjs';
import { seedLocalData } from './fixtures/local-data.mjs';

test('Tiny git benchmark validates fail-to-pass and cleans worktrees even on error', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-bench-')), ctx = context(root);
  t.after(async () => {
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === 10) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  });
  ctx.accountStatus = async () => ({ status: 'unavailable' });
  await git(root, ['init', '--quiet']);
  writeJson(path.join(root, 'package.json'), { scripts: { 'test:tiny': 'node scripts/test-tiny.mjs' } });
  write(path.join(root, '.gitignore'), '.harness/\n');
  write(path.join(root, 'agent-window/src/value.mjs'), 'export const value = 1;\n');
  write(path.join(root, 'scripts/test-tiny.mjs'), "import { value } from '../agent-window/src/value.mjs'; process.exit(value === 1 ? 0 : 1);\n");
  const commit = async message => { await git(root, ['add', '.']); await git(root, ['-c', 'user.name=Harness test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '-m', message]); return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim(); };
  const base = await commit('Base');
  write(path.join(root, 'agent-window/src/value.mjs'), 'export const value = 2;\n');
  write(path.join(root, 'scripts/test-tiny.mjs'), "import { value } from '../agent-window/src/value.mjs'; process.exit(value === 2 ? 0 : 1);\n");
  const fix = await commit('Return two');
  const task = { base_sha: base, fix_sha: fix, src_files: ['agent-window/src/value.mjs'], test_files: ['scripts/test-tiny.mjs'], test_cmds: ['npm run test:tiny'] };
  const result = await validateTask(ctx, task); assert.equal(result.valid, true); assert.equal(result.before[0].exit_code, 1); assert.equal(result.after[0].exit_code, 0);
  const bad = await validateTask(ctx, { ...task, src_files: [] }); assert.equal(bad.valid, false); assert.match(bad.reason, /still fail/);
  const mined = await mine(ctx, { limit: '1' }); assert.equal(mined.validated.length, 1);
  const stored = json(path.join(ctx.data, 'bench/tasks', mined.validated[0], 'task.json'));
  assert.deepEqual(stored.size, { files: 1, lines: 2 });
  assert.deepEqual(await taskSize(ctx, stored), { files: 1, lines: 2 });
  await assert.rejects(withWorktree(ctx, base, () => { throw new Error('intentional'); }), /intentional/);
  const worktrees = (await git(root, ['worktree', 'list', '--porcelain'])).stdout; assert.equal((worktrees.match(/^worktree /gm) ?? []).length, 1);
  writeJson(path.join(root, 'package-lock.json'), { lockfileVersion: 3 });
  await assert.rejects(dependencyCheck(ctx, base), /differs/);
});

async function fixture(t, scripts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-bench-')), ctx = context(root);
  t.after(async () => {
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === 10) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  });
  ctx.accountStatus = async () => ({ status: 'unavailable' });
  await git(root, ['init', '--quiet']);
  seedLocalData(ctx);
  write(path.join(root, '.gitignore'), '.harness/\nnode_modules/\nagent-window/lib/\n');
  writeJson(path.join(root, 'package.json'), { scripts, workspaces: ['agent-window'] });
  writeJson(path.join(root, 'agent-window/package.json'), { name: '@poiesis/test', scripts: { compile: 'tsc -p .' } });
  write(path.join(root, 'agent-window/src/value.mjs'), 'export const value = 1;\n');
  write(path.join(root, 'scripts/test-tiny.mjs'), "import assert from 'node:assert/strict'; import {value} from '../agent-window/src/value.mjs'; assert.equal(value, 1);\n");
  const commit = async message => {
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Harness test', '-c', 'user.email=test@localhost', 'commit', '--quiet', '--allow-empty', '-m', message]);
    return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  };
  return { root, ctx, commit };
}

test('Fix-added test scripts expand sequentially using base scripts without copying manifests', async t => {
  const {root, ctx, commit} = await fixture(t, { prepare: 'node scripts/prepare.mjs' });
  write(path.join(root, 'scripts/prepare.mjs'), "console.log('prepare');\n");
  const base = await commit('Base');
  writeJson(path.join(root, 'package.json'), { scripts: { 'test:tiny': 'npm run prepare && node scripts/test-tiny.mjs' } });
  write(path.join(root, 'agent-window/src/value.mjs'), 'export const value = 2;\n');
  write(path.join(root, 'scripts/test-tiny.mjs'), "import assert from 'node:assert/strict'; import {value} from '../agent-window/src/value.mjs'; assert.equal(value, 2);\n");
  const fix = await commit('Return two');
  const cmds = await testCommands(ctx, base, fix, ['scripts/test-tiny.mjs']);
  assert.deepEqual(cmds, ['node scripts/prepare.mjs', 'node scripts/test-tiny.mjs']);
  const mined = await mine(ctx, {limit: 1});
  assert.equal(mined.candidates, 1); assert.equal(mined.validated.length, 1);
  const task = json(path.join(ctx.data, 'bench/tasks', mined.validated[0], 'task.json'));
  assert.deepEqual(task.test_cmds, cmds); assert.deepEqual(task.validation.before.map(x => x.exit_code), [0, 1]);
  assert.ok(task.validation.after_wall_s > 0);
  assert.match(fs.readFileSync(path.join(root, task.validation.log), 'utf8'), /AssertionError/);
  assert.deepEqual(mined.suites.smoke, mined.validated); assert.deepEqual(mined.suites.regression, mined.validated);
});

test('Script allowlist checks nested scripts, cycles, lifecycle hooks and workspace compile', async t => {
  const {root, ctx, commit} = await fixture(t, {
    'test:existing': 'node scripts/test-tiny.mjs', helper: 'node scripts/prepare.mjs',
    unsafe: 'set "X=1" && node scripts/test-tiny.mjs', loop: 'npm run loop'
  });
  const base = await commit('Base');
  const check = async (value, pattern, scripts = {}) => {
    writeJson(path.join(root, 'package.json'), { scripts: { 'test:new': value, ...scripts } });
    const fix = await commit('Script');
    // Existing compatible base command takes precedence over fix changes.
    assert.deepEqual(await testCommands(ctx, base, fix, ['scripts/test-tiny.mjs']), ['node scripts/test-tiny.mjs']);
    if (pattern) await assert.rejects(testCommands(ctx, base, fix, ['scripts/test-new.mjs']), pattern);
    else return testCommands(ctx, base, fix, ['scripts/test-new.mjs']);
  };
  assert.deepEqual(await check('npm run compile --workspace=@poiesis/test && npm run helper && node scripts/test-new.mjs'), ['npm run compile --workspace=@poiesis/test', 'node scripts/prepare.mjs', 'node scripts/test-new.mjs']);
  assert.deepEqual(await check('npm run helper && node scripts/test-new.mjs && npm run helper'), ['node scripts/prepare.mjs', 'node scripts/test-new.mjs', 'node scripts/prepare.mjs']);
  for (const bad of ['set "X=1"', 'echo unsafe', 'node -e x', 'node scripts/../bad.mjs', 'node scripts/a.mjs | echo bad', 'node scripts/a.mjs; echo bad', 'node scripts/a.mjs > bad', 'node scripts/a.mjs & echo bad']) await check(`${bad} && node scripts/test-new.mjs`, /Unsafe|Unsupported/);
  await check('npm run unsafe && node scripts/test-new.mjs', /Unsafe/);
  await check('npm run missing && node scripts/test-new.mjs', /missing at base/);
  await check('npm run loop && node scripts/test-new.mjs', /Cyclic/);
  await check('node scripts/test-new.mjs', /Lifecycle/, { 'pretest:new': 'echo unsafe' });
  await check('npm run build --workspace=@poiesis/test && node scripts/test-new.mjs', /Only workspace compile/);
  writeJson(path.join(root, 'package.json'), {scripts: {}});
  writeJson(path.join(root, 'agent-window/package.json'), {name: '@poiesis/test', scripts: {compile: 'tsc -p . && echo unsafe'}});
  const unsafeBase = await commit('Unsafe compiler');
  writeJson(path.join(root, 'package.json'), {scripts: {'test:new': 'npm run compile --workspace=@poiesis/test && node scripts/test-new.mjs'}});
  const unsafeFix = await commit('Test');
  await assert.rejects(testCommands(ctx, unsafeBase, unsafeFix, ['scripts/test-new.mjs']), /Unsafe workspace/);
});

test('Dependency normalization ignores workspace metadata but preserves actual dependency changes', async t => {
  const {root, ctx, commit} = await fixture(t);
  const lock = {name: 'old', version: '1', lockfileVersion: 3, packages: {
    '': {name: 'old', version: '1'}, 'agent-window': {version: '1'},
    'node_modules/@poiesis/test': {resolved: 'agent-window', link: true},
    'node_modules/example': {version: '1', integrity: 'sha512-example'},
    'node_modules/@poiesis/published': {version: '1'}
  }};
  writeJson(path.join(root, 'package-lock.json'), lock); const base = await commit('Base');
  const updated = structuredClone(lock); updated.name = 'new'; updated.version = '2'; updated.packages[''].version = '2'; updated.packages['browser-app'] = {version: '3'};
  updated.packages['node_modules/@poiesis/test'].resolved = 'other-workspace';
  assert.equal(normalizeLockfile(lock), normalizeLockfile(updated));
  fs.mkdirSync(path.join(root, 'node_modules')); write(path.join(root, 'node_modules/marker'), 'preserve');
  writeJson(path.join(root, 'package-lock.json'), updated);
  await withWorktree(ctx, base, async cwd => {
    assert.equal(await mainCheckout(context(cwd)), root);
    assert.equal(fs.realpathSync(path.join(cwd, 'node_modules')), fs.realpathSync(path.join(root, 'node_modules')));
    assert.equal((await dependencyCheck(context(cwd), base)).dependencies, true);
  });
  await assert.rejects(withWorktree(ctx, base, () => {throw new Error('cleanup');}), /cleanup/);
  assert.equal(fs.readFileSync(path.join(root, 'node_modules/marker'), 'utf8'), 'preserve');
  updated.packages['node_modules/example'].version = '2'; writeJson(path.join(root, 'package-lock.json'), updated);
  await assert.rejects(dependencyCheck(ctx, base), /normalized dependencies/);
  updated.packages['node_modules/example'].version = '1'; updated.packages['node_modules/@poiesis/published'].version = '2';
  assert.notEqual(normalizeLockfile(lock), normalizeLockfile(updated));
});

test('Missing dependency or helper is rejected even if the fix could conceal it', async t => {
  const {root, ctx, commit} = await fixture(t); const base = await commit('Base');
  write(path.join(root, 'scripts/test-tiny.mjs'), "import './missing-helper.mjs';\n");
  const fix = await commit('Broken test setup');
  const result = await validateTask(ctx, {base_sha: base, fix_sha: fix, src_files: ['agent-window/src/value.mjs'], test_files: ['scripts/test-tiny.mjs'], test_cmds: ['node scripts/test-tiny.mjs']});
  assert.equal(result.valid, false); assert.match(result.reason, /Base setup failure.*missing dependency, helper or asset/); assert.equal(result.after, undefined);
});

test('Missing app exports and extensionless app modules are implementation failures', async t => {
  const {root, ctx, commit} = await fixture(t); const base = await commit('Base');
  write(path.join(root, 'scripts/test-tiny.mjs'), "import assert from 'node:assert/strict'; import {added} from '../agent-window/src/value.mjs'; assert.equal(added, 2);\n");
  write(path.join(root, 'agent-window/src/value.mjs'), 'export const value = 1; export const added = 2;\n');
  const fix = await commit('Add export');
  const task = {base_sha: base, fix_sha: fix, src_files: ['agent-window/src/value.mjs'], test_files: ['scripts/test-tiny.mjs'], test_cmds: ['node scripts/test-tiny.mjs']};
  const exported = await validateTask(ctx, task); assert.equal(exported.valid, true); assert.match(exported.before[0].stderr, /does not provide an export/);
  write(path.join(root, 'scripts/test-tiny.mjs'), "import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; const {value}=createRequire(import.meta.url)('../agent-window/src/added'); assert.equal(value, 2);\n");
  write(path.join(root, 'agent-window/src/added.js'), 'exports.value = 2;\n');
  const moduleFix = await commit('Add module');
  const added = await validateTask(ctx, {...task, fix_sha: moduleFix, src_files: ['agent-window/src/added.js']});
  assert.equal(added.valid, true); assert.match(added.before[0].stderr, /MODULE_NOT_FOUND/);
});

test('Suites pick the smallest tasks by changed lines with file-count ties and a middle third', () => {
  const task = (id, files, lines) => ({ id, size: { files, lines } });
  const tasks = [task('g', 2, 400), task('a', 2, 10), task('d', 1, 20), task('c', 1, 5), task('b', 1, 10), task('e', 1, 30), task('f', 1, 40)];
  assert.deepEqual(selectSuites(tasks), { smoke: ['c', 'b', 'a'], medium: ['e', 'f'], regression: ['c', 'b', 'a', 'd', 'e', 'f', 'g'] });
  // Tasks without a stored size sort last, never into smoke.
  assert.deepEqual(selectSuites([...tasks, { id: 'unsized' }]).smoke, ['c', 'b', 'a']);
  assert.deepEqual(selectSuites([task('only', 1, 1)]), { smoke: ['only'], medium: [], regression: ['only'] });
});

test('Isolated worker cannot read gold history and evaluator restores tracked and new scope deviations', async t => {
  const {root, ctx, commit} = await fixture(t); const base = await commit('Base');
  write(path.join(root, 'agent-window/src/value.mjs'), 'export const value = 2;\n'); const fix = await commit('Gold solution');
  await withWorktree(ctx, base, async cwd => {
    assert.notEqual((await git(cwd, ['rev-parse', '--git-common-dir'])).stdout.trim(), path.join(root, '.git'));
    assert.notEqual((await git(cwd, ['cat-file', '-e', fix], {allowFailure: true})).exit_code, 0);
    const baseline = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    write(path.join(cwd, 'scripts/test-tiny.mjs'), 'process.exit(0);\n');
    write(path.join(cwd, 'scripts/evil.mjs'), 'process.exit(0);\n');
    write(path.join(cwd, '.npmrc'), 'ignore-scripts=true\n');
    write(path.join(cwd, 'agent-window/src/value.mjs'), 'export const value = 2;\n');
    write(path.join(cwd, 'agent-window/lib/value.js'), 'stale build');
    write(path.join(cwd, 'agent-window/node_modules/evil/index.js'), 'exports.value = 2;');
    await git(cwd, ['add', 'scripts/evil.mjs']);
    const deviations = await restoreEvaluator(cwd, baseline);
    assert.deepEqual(deviations, ['.npmrc', 'agent-window/node_modules/evil/index.js', 'scripts/evil.mjs', 'scripts/test-tiny.mjs']);
    assert.match(fs.readFileSync(path.join(cwd, 'scripts/test-tiny.mjs'), 'utf8'), /assert.equal/);
    assert.equal(fs.existsSync(path.join(cwd, 'scripts/evil.mjs')), false);
    assert.equal(fs.existsSync(path.join(cwd, 'agent-window/lib/value.js')), false);
    assert.equal(fs.existsSync(path.join(cwd, 'agent-window/node_modules/evil/index.js')), false);
    assert.equal(fs.readFileSync(path.join(cwd, 'agent-window/src/value.mjs'), 'utf8'), 'export const value = 2;\n');
  }, {isolated: true});
  assert.equal((await git(root, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm).length, 1);
});

test('Bench suite runs command lists, records row IDs and fails test tampering without model calls', async t => {
  const {root, ctx, commit} = await fixture(t, {'test:tiny': 'node scripts/test-tiny.mjs'}); const base = await commit('Base');
  write(path.join(root, 'agent-window/src/value.mjs'), 'export const value = 2;\n');
  write(path.join(root, 'scripts/test-tiny.mjs'), "import assert from 'node:assert/strict'; import {value} from '../agent-window/src/value.mjs'; assert.equal(value, 2);\n");
  const fix = await commit('Return two'), taskId = 'offline-task';
  writeJson(path.join(ctx.data, 'bench/tasks', taskId, 'task.json'), {id: taskId, base_sha: base, fix_sha: fix, test_files: ['scripts/test-tiny.mjs'], test_cmds: ['node scripts/test-tiny.mjs', 'node scripts/test-tiny.mjs'], src_files: ['agent-window/src/value.mjs'], instruction_file: 'instruction.md'});
  write(path.join(ctx.data, 'bench/tasks', taskId, 'instruction.md'), 'Return two.');
  write(path.join(ctx.data, 'bench/suites/smoke.txt'), `${taskId}\n`);
  const outcomes = []; let calls = 0;
  const services = {
    async run(_ctx, opts) {
      calls++; assert.match(fs.readFileSync(path.join(opts.cwd, 'scripts/test-tiny.mjs'), 'utf8'), /value, 2/);
      assert.notEqual((await git(opts.cwd, ['cat-file', '-e', fix], {allowFailure: true})).exit_code, 0);
      write(path.join(opts.cwd, 'agent-window/src/value.mjs'), 'export const value = 2;\n');
      if (opts.model === 'codex:gpt-6-sol') write(path.join(opts.cwd, 'scripts/test-tiny.mjs'), 'process.exit(0);\n');
      return {run_id: `offline-${calls}`, exit_code: 0};
    },
    async verify(_ctx, opts) { const results = []; for (const cmd of opts.cmd) results.push(await command(cmd, opts.cwd)); assert.equal(results.length, 2); return {results, exit_code: results.some(r => r.exit_code) ? 1 : 0}; },
    outcome(_ctx, runId, result) { outcomes.push([runId, result]); },
    judge() { assert.fail('judge none must not call a judge'); }
  };
  const result = await benchRun(ctx, {suite: 'smoke', models: ' codex:gpt-6-luna , codex:gpt-6-sol ', repeats: '1', judge: 'none'}, services);
  assert.equal(result.exit_code, 1); assert.deepEqual(outcomes, [['offline-1', 'pass'], ['offline-2', 'fail']]);
  assert.deepEqual(result.results.map(r => r.run_id), ['offline-1', 'offline-2']);
  assert.deepEqual(result.results[1].scope_deviations, ['scripts/test-tiny.mjs']);
  assert.ok(fs.existsSync(path.join(ctx.data, 'bench/results/offline-1.json')));
});

test('Bench records quota-exhausted cells as skipped_quota, never as failures', async t => {
  const {root, ctx, commit} = await fixture(t, {'test:tiny': 'node scripts/test-tiny.mjs'}); const base = await commit('Base');
  write(path.join(root, 'agent-window/src/value.mjs'), 'export const value = 2;\n');
  write(path.join(root, 'scripts/test-tiny.mjs'), "import assert from 'node:assert/strict'; import {value} from '../agent-window/src/value.mjs'; assert.equal(value, 2);\n");
  const fix = await commit('Gold solution'), taskId = 'quota-task';
  writeJson(path.join(ctx.data, 'bench/tasks', taskId, 'task.json'), {id: taskId, base_sha: base, fix_sha: fix, test_files: ['scripts/test-tiny.mjs'], test_cmds: ['node scripts/test-tiny.mjs'], src_files: ['agent-window/src/value.mjs'], instruction_file: 'instruction.md'});
  write(path.join(ctx.data, 'bench/tasks', taskId, 'instruction.md'), 'Return two.');
  write(path.join(ctx.data, 'bench/suites/smoke.txt'), `${taskId}\n`);
  const outcomes = [];
  const services = {
    async run() { return {run_id: 'quota-cell', exit_code: 1, infra: 'quota_exhausted', quota_source: 'codex-usage-limit'}; },
    async verify() { assert.fail('A quota-exhausted worker must not run acceptance commands'); },
    outcome(_ctx, runId, result, note) { outcomes.push([runId, result, note]); },
    judge() { assert.fail('judge none must not call a judge'); }
  };
  const result = await benchRun(ctx, {suite: 'smoke', models: 'codex:gpt-6-luna', repeats: '1', judge: 'none'}, services);
  assert.deepEqual(outcomes, [['quota-cell', 'skipped_quota', 'Infrastructure: codex-usage-limit']]);
  assert.equal(result.results[0].result, 'skipped_quota');
  assert.deepEqual(result.summary, {pass: 0, fail: 0, timeout: 0, skipped_quota: 1, skipped_routing: 0, skipped_budget: 0});
  assert.equal(result.exit_code, 0);
});

test('Resuite rewrites suites from stored sizes and only adds the missing size', async t => {
  const {root, ctx, commit} = await fixture(t, {'test:tiny': 'node scripts/test-tiny.mjs'});
  for (let i = 0; i < 6; i++) write(path.join(root, `agent-window/src/part${i}.mjs`), 'export const x = 1;\n');
  let parent = await commit('Base');
  const tasks = [];
  for (const [i, lines] of [1, 9, 39, 99, 199, 399].entries()) {
    const file = `agent-window/src/part${i}.mjs`;
    write(path.join(root, file), `${'export const y = 2;\n'.repeat(lines)}`);
    const fix = await commit(`Part ${i}`);
    tasks.push({ id: `resuite-${i}`, base_sha: parent, fix_sha: fix, src_files: [file], test_files: ['scripts/test-tiny.mjs'], test_cmds: ['node scripts/test-tiny.mjs'] });
    parent = fix;
  }
  for (const task of tasks) writeJson(path.join(ctx.data, 'bench/tasks', task.id, 'task.json'), task);
  const result = await resuite(ctx);
  assert.equal(result.tasks, 6);
  assert.deepEqual(result.suites.smoke, ['resuite-0', 'resuite-1', 'resuite-2']);
  assert.deepEqual(result.suites.medium, ['resuite-4']);
  assert.deepEqual(result.suites.regression, tasks.map(x => x.id));
  assert.equal(read2(path.join(ctx.data, 'bench/suites/smoke.txt')), 'resuite-0\nresuite-1\nresuite-2\n');
  for (const [i, task] of tasks.entries()) {
    const stored = json(path.join(ctx.data, 'bench/tasks', task.id, 'task.json'));
    assert.deepEqual({ ...stored, size: undefined }, { ...task, size: undefined }, 'only size may be added');
    assert.deepEqual(stored.size, { files: 1, lines: linesOf(i) });
  }
  // A second pass is idempotent and keeps task.json untouched.
  const before = fs.readFileSync(path.join(ctx.data, 'bench/tasks/resuite-0/task.json'), 'utf8');
  assert.deepEqual((await resuite(ctx)).suites, result.suites);
  assert.equal(fs.readFileSync(path.join(ctx.data, 'bench/tasks/resuite-0/task.json'), 'utf8'), before);
  function linesOf(i) { return [2, 10, 40, 100, 200, 400][i]; }
  function read2(p) { return fs.readFileSync(p, 'utf8'); }
});

test('Parallel lanes run cells concurrently with atomic budget reservations', async t => {
  const {root, ctx, commit} = await fixture(t, {'test:tiny': 'node scripts/test-tiny.mjs'}); const base = await commit('Base');
  write(path.join(root, 'agent-window/src/value.mjs'), 'export const value = 2;\n');
  write(path.join(root, 'scripts/test-tiny.mjs'), "import assert from 'node:assert/strict'; import {value} from '../agent-window/src/value.mjs'; assert.equal(value, 2);\n");
  const fix = await commit('Gold solution'), taskId = 'parallel-task';
  writeJson(path.join(ctx.data, 'bench/tasks', taskId, 'task.json'), {id: taskId, base_sha: base, fix_sha: fix, test_files: ['scripts/test-tiny.mjs'], test_cmds: ['node scripts/test-tiny.mjs'], src_files: ['agent-window/src/value.mjs'], instruction_file: 'instruction.md'});
  write(path.join(ctx.data, 'bench/tasks', taskId, 'instruction.md'), 'Return two.');
  write(path.join(ctx.data, 'bench/suites/smoke.txt'), `${taskId}\n`);
  // Two metered reservations fit the daily cap; a third cell waits, then runs after a release.
  writeJson(path.join(ctx.data, 'budget/limits.json'), { metered: { monthly_usd: 30, daily_usd: 2.05, per_run_usd: 1, conservative_default_usd: 0.5 }, quota: null });
  let active = 0, peak = 0, calls = 0;
  const services = {
    async run(_ctx, opts) {
      const runNumber = ++calls; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 400));
      active--; write(path.join(opts.cwd, 'agent-window/src/value.mjs'), 'export const value = 2;\n');
      return { run_id: `par-${runNumber}`, exit_code: 0 };
    },
    async verify() { return { results: [{ cmd: 'node scripts/test-tiny.mjs', exit_code: 0, wall_s: 0.01 }], exit_code: 0 }; },
    outcome() {}, judge() { assert.fail('judge none must not call a judge'); }
  };
  const result = await benchRun(ctx, {suite: 'smoke', models: 'or:glm-5.3-flash', repeats: '3', judge: 'none', parallel: '3'}, services);
  assert.equal(peak, 2); assert.equal(calls, 3);
  assert.deepEqual(result.summary, { pass: 3, fail: 0, timeout: 0, skipped_quota: 0, skipped_routing: 0, skipped_budget: 0 });
  assert.equal(result.exit_code, 0);
  assert.deepEqual(result.results.map(r => r.result), ['pass', 'pass', 'pass']);
  assert.equal(result.results[2].error, null);
  await assert.rejects(benchRun(ctx, {suite: 'smoke', models: 'or:glm-5.3-flash', judge: 'none', parallel: '5'}, services), /between 1 and 4/);
  await assert.rejects(benchRun(ctx, {suite: 'smoke', models: 'or:glm-5.3-flash', judge: 'none', parallel: '0'}, services), /between 1 and 4/);
});

test('Wall-cap timeouts are labeled distinctly from wrong-answer failures', async t => {
  const {root, ctx, commit} = await fixture(t, {'test:tiny': 'node scripts/test-tiny.mjs'}); const base = await commit('Base');
  write(path.join(root, 'agent-window/src/value.mjs'), 'export const value = 2;\n');
  write(path.join(root, 'scripts/test-tiny.mjs'), "import assert from 'node:assert/strict'; import {value} from '../agent-window/src/value.mjs'; assert.equal(value, 2);\n");
  const fix = await commit('Gold solution'), taskId = 'timeout-task';
  writeJson(path.join(ctx.data, 'bench/tasks', taskId, 'task.json'), {id: taskId, base_sha: base, fix_sha: fix, test_files: ['scripts/test-tiny.mjs'], test_cmds: ['node scripts/test-tiny.mjs'], src_files: ['agent-window/src/value.mjs'], instruction_file: 'instruction.md'});
  write(path.join(ctx.data, 'bench/tasks', taskId, 'instruction.md'), 'Return two.');
  write(path.join(ctx.data, 'bench/suites/smoke.txt'), `${taskId}\n`);
  const outcomes = []; let seenTimeout;
  const services = {
    async run(_ctx, opts) { seenTimeout = opts['timeout-min']; write(path.join(opts.cwd, 'agent-window/src/value.mjs'), 'export const value = 2;\n'); return { run_id: 'timeout-cell', exit_code: 124 }; },
    async verify() { return { results: [], exit_code: 1 }; },
    outcome(_ctx, runId, result, note) { outcomes.push([runId, result, note]); },
    judge() { assert.fail('judge none must not call a judge'); }
  };
  const result = await benchRun(ctx, {suite: 'smoke', models: 'codex:gpt-6-luna', repeats: '1', judge: 'none', 'timeout-min': '7'}, services);
  assert.equal(seenTimeout, 7);
  assert.equal(result.results[0].result, 'timeout');
  assert.deepEqual(outcomes, [['timeout-cell', 'timeout', 'timeout: exceeded the 7 min wall cap before completing acceptance']]);
  assert.deepEqual(result.summary, { pass: 0, fail: 0, timeout: 1, skipped_quota: 0, skipped_routing: 0, skipped_budget: 0 });
  assert.equal(result.exit_code, 1);
});

test('Queued reservations re-check actual spend, release after throws, and honor max-usd', { timeout: 30000 }, async t => {
  const { root, ctx, commit } = await fixture(t); const base = await commit('Base');
  write(path.join(root, 'scripts/test-tiny.mjs'), "import { value } from '../agent-window/src/value.mjs'; process.exit(value === 1 ? 0 : 1);\n");
  const fix = await commit('Acceptance fixture');
  writeJson(path.join(ctx.data, 'bench/tasks/queued/task.json'), { id: 'queued', base_sha: base, fix_sha: fix, test_files: ['scripts/test-tiny.mjs'], test_cmds: ['node scripts/test-tiny.mjs'], src_files: ['agent-window/src/value.mjs'], instruction_file: 'instruction.md' });
  write(path.join(ctx.data, 'bench/tasks/queued/instruction.md'), 'Return one.');
  writeJson(path.join(ctx.data, 'budget/limits.json'), { metered: { monthly_usd: 30, daily_usd: .5, per_run_usd: 1, conservative_default_usd: .05 } });
  const opts = { tasks: 'queued', models: 'or:glm-5.3-flash', repeats: '2', parallel: '2', judge: 'none', 'max-usd': '.4' };
  let calls = 0, active = 0, peak = 0, mode = 'throw';
  const services = {
    async run(_ctx, o) {
      const number = ++calls; active++; peak = Math.max(peak, active);
      assert.equal(o['max-usd'], '.4');
      await new Promise(resolve => setTimeout(resolve, 50)); active--;
      if (mode === 'throw' && number === 1) throw new Error('fixture worker failed');
      if (mode === 'spend') append(ctx, { ts: new Date().toISOString(), model: 'or:glm-5.3-flash', cost_basis: 'metered', cost_usd_actual: .4 });
      return { run_id: `queued-${number}`, exit_code: 0 };
    },
    async verify() { return { exit_code: 0, results: [] }; }, outcome() {}, judge() { assert.fail('No judge requested'); }
  };
  await assert.rejects(benchRun(ctx, opts, services), /fixture worker failed/);
  assert.equal(calls, 2, 'waiting cell wakes after a worker exception'); assert.equal(peak, 1);
  calls = 0; mode = 'spend';
  const result = await benchRun(ctx, opts, services);
  assert.equal(calls, 1); assert.equal(result.summary.pass, 1); assert.equal(result.summary.skipped_budget, 1);
  assert.equal(result.results[1].result, 'skipped_budget'); assert.match(result.results[1].error, /budget/);
  calls = 0;
  const exhausted = await benchRun(ctx, opts, services);
  assert.equal(calls, 0); assert.equal(exhausted.summary.skipped_budget, 2, 'no reservations and no budget skips immediately');
});

test('Routing infrastructure skips verification and paid judging without a failing bench score', async t => {
  const { root, ctx, commit } = await fixture(t); const base = await commit('Base');
  write(path.join(root, 'scripts/test-tiny.mjs'), "import { value } from '../agent-window/src/value.mjs'; process.exit(value === 1 ? 0 : 1);\n");
  const fix = await commit('Acceptance fixture');
  writeJson(path.join(ctx.data, 'bench/tasks/routing/task.json'), { id: 'routing', base_sha: base, fix_sha: fix, test_files: ['scripts/test-tiny.mjs'], test_cmds: ['node scripts/test-tiny.mjs'], src_files: ['agent-window/src/value.mjs'], instruction_file: 'instruction.md' });
  write(path.join(ctx.data, 'bench/tasks/routing/instruction.md'), 'Return one.');
  const outcomes = [];
  const result = await benchRun(ctx, { tasks: 'routing', models: 'or:glm-5.3-flash', judge: 'auto' }, {
    async run() { return { run_id: 'routing-cell', exit_code: 1, infra: 'routing_config', routing_step: 'Filter by Guardrails' }; },
    verify() { assert.fail('Infrastructure must skip verification'); },
    judge() { assert.fail('Infrastructure must skip paid judging'); },
    outcome(_ctx, id, value, note) { outcomes.push([id, value, note]); }
  });
  assert.equal(result.exit_code, 0); assert.equal(result.summary.skipped_routing, 1); assert.equal(result.summary.fail, 0);
  assert.deepEqual(outcomes, [['routing-cell', 'skipped_routing', 'Infrastructure: Filter by Guardrails']]);
  assert.equal(result.results[0].routing_step, 'Filter by Guardrails');
  assert.deepEqual(result.results[0].verification, []); assert.equal(result.results[0].judge, null);
});
