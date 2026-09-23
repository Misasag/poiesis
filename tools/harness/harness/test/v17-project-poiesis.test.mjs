import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, context, resolveProject, configFile, read } from '../bin/lib/util.mjs';
import { policy } from '../bin/lib/route.mjs';
import { limits, budgetCheck } from '../bin/lib/budget.mjs';

const hx = fileURLToPath(new URL('../bin/hx.mjs', import.meta.url));
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });
const cli = (cwd, args, env = process.env) => spawnSync(process.execPath, [hx, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, shell: false });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-v17-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('project resolution honors explicit, environment, git top level, and cwd', t => {
  const base = fixture(t), project = path.join(base, 'project'), other = path.join(base, 'other'), nested = path.join(project, 'nested');
  for (const dir of [project, other, nested]) fs.mkdirSync(dir, { recursive: true });
  assert.equal(git(project, 'init').status, 0);
  assert.equal(resolveProject({ cwd: nested, env: {} }), project);
  assert.equal(resolveProject({ cwd: nested, env: { HX_PROJECT: other } }), other);
  assert.equal(resolveProject({ cwd: nested, project, env: { HX_PROJECT: other } }), project);
  assert.equal(resolveProject({ cwd: other, env: {} }), other);
  assert.equal(resolveProject({ cwd: ROOT, env: {} }), ROOT);
  const owner = cli(ROOT, ['status', '--json']);
  assert.equal(owner.status, 0, owner.stderr + owner.stdout);
  assert.equal(JSON.parse(owner.stdout).policy_version, policy(context(ROOT)).version);
  const selected = cli(nested, ['status', '--project', other], { ...process.env, HX_PROJECT: project });
  assert.equal(selected.status, 0, selected.stderr + selected.stdout);
  assert.ok(fs.existsSync(path.join(other, '.harness/.gitignore')));
  assert.ok(!fs.existsSync(path.join(project, '.harness')));
});

test('foreign project uses defaults without copying or modifying owner configuration', t => {
  const root = fixture(t), ctx = context(root), files = [
    '.harness/routing/policy.json', '.harness/budget/limits.json', '.harness/budget/subscriptions.json'
  ];
  const before = files.map(file => read(path.join(ROOT, file)));
  assert.equal(policy(ctx).version, JSON.parse(before[0]).version);
  assert.equal(limits(ctx).metered.monthly_usd, 30);
  assert.deepEqual(JSON.parse(read(configFile(ctx, 'budget/subscriptions.json'))), JSON.parse(before[2]));
  assert.ok(!fs.existsSync(ctx.data));
  assert.deepEqual(files.map(file => read(path.join(ROOT, file))), before);
  const status = cli(root, ['status']);
  assert.equal(status.status, 0, status.stderr + status.stdout);
  assert.deepEqual(fs.readdirSync(ctx.data), ['.gitignore']);
  assert.equal(read(path.join(ctx.data, '.gitignore')), '*\n');
  assert.deepEqual(files.map(file => read(path.join(ROOT, file))), before);
});

test('tracking opt-in leaves foreign project harness files visible', t => {
  const root = fixture(t);
  assert.equal(git(root, 'init').status, 0);
  const result = cli(root, ['status', '--track']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(fs.existsSync(path.join(root, '.harness')));
  assert.ok(!fs.existsSync(path.join(root, '.harness/.gitignore')));
  assert.equal(cli(root, ['status']).status, 0);
  assert.ok(fs.existsSync(path.join(root, '.harness/.gitignore')));
  assert.equal(cli(root, ['status', '--track']).status, 0);
  assert.ok(!fs.existsSync(path.join(root, '.harness/.gitignore')));
});

test('metered checks share one OpenRouter monthly baseline across projects', async t => {
  const base = fixture(t), baseline = path.join(base, 'shared', 'openrouter-baseline.json');
  const first = context(path.join(base, 'one')), second = context(path.join(base, 'two'));
  first.budgetBaseline = baseline; second.budgetBaseline = baseline;
  let usage = 10;
  const accountStatus = async () => ({ status: 'available', account: { status: 'available', usage, limit_remaining: 100 }, credits: { status: 'available', total_credits: 200, total_usage: usage } });
  first.accountStatus = accountStatus; second.accountStatus = accountStatus;
  const now = new Date('2026-09-23T12:00:00Z'), model = { id: 'metered', costBasis: 'metered' };
  assert.equal((await budgetCheck(first, model, .1, now)).allowed, true);
  usage = 40;
  const check = await budgetCheck(second, model, .1, now);
  assert.equal(check.allowed, false);
  assert.equal(check.month_usd, 30);
  assert.equal(JSON.parse(read(baseline)).usage, 10);
});

test('install preview, render, and uninstall only managed skill files', t => {
  const base = fixture(t), dest = path.join(base, 'skills');
  const preview = cli(base, ['poiesis', 'install', '--dest', dest, '--dry-run']);
  assert.equal(preview.status, 0, preview.stderr + preview.stdout);
  assert.ok(!fs.existsSync(dest));
  const install = cli(base, ['poiesis', 'install', '--dest', dest]);
  assert.equal(install.status, 0, install.stderr + install.stdout);
  const ids = ['harness-delegate', 'harness-results', 'harness-verify'];
  assert.deepEqual(JSON.parse(read(path.join(dest, '.hx-installed.json'))).skills, ids);
  for (const id of ids) {
    const skill = read(path.join(dest, id, 'SKILL.md'));
    assert.match(skill, new RegExp(`name: ${id}`));
    assert.ok(!skill.includes('{{HX_COMMAND}}'));
    assert.ok(skill.split('\n').length <= 80);
  }
  assert.match(read(path.join(dest, 'harness-delegate', 'SKILL.md')), /node "[^"]+hx\.mjs"/);
  fs.writeFileSync(path.join(dest, 'harness-verify', 'owner.txt'), 'keep', 'utf8');
  const uninstall = cli(base, ['poiesis', 'uninstall', '--dest', dest]);
  assert.equal(uninstall.status, 0, uninstall.stderr + uninstall.stdout);
  assert.ok(!fs.existsSync(path.join(dest, '.hx-installed.json')));
  assert.ok(!fs.existsSync(path.join(dest, 'harness-delegate')));
  assert.ok(fs.existsSync(path.join(dest, 'harness-verify', 'owner.txt')));
});
