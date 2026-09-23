import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adapterAvailability } from '../bin/lib/nested.mjs';
import { context, json, write, writeJson } from '../bin/lib/util.mjs';
import { seedLocalData } from './fixtures/local-data.mjs';
import { route, policy, scoreboard } from '../bin/lib/route.mjs';
import { run } from '../bin/lib/run.mjs';
import { ledger, outcome, runDir } from '../bin/lib/ledger.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-v18-')), ctx = context(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seedLocalData(ctx);
  const p = policy(ctx); p.explore_share = 0;
  p.roles['worker-mech'] = { incumbent: 'codex:gpt-6-luna', effort: 'medium', challengers: ['or:deepseek-v4.1-flash', 'or:glm-5.3-flash'] };
  writeJson(path.join(ctx.data, 'routing/policy.json'), p);
  return ctx;
}

test('Nested probe uses adapter homes, honors CODEX_HOME, cleans files, and skips homes outside an agent', () => {
  const writes = [], deletes = [], home = path.join(os.tmpdir(), 'nested-home');
  const env = { CODEX_THREAD_ID: 'thread', CODEX_HOME: path.join(home, 'custom-codex'), USERPROFILE: home, APPDATA: path.join(home, 'appdata') };
  const filesystem = {
    writeFileSync(file, _value, options) {
      assert.equal(options.flag, 'wx');
      writes.push(file);
      if (file.startsWith(env.CODEX_HOME) || file.startsWith(path.join(home, '.grok'))) throw new Error('access denied');
    },
    unlinkSync(file) { deletes.push(file); },
    existsSync(file) { return file.endsWith('pi-coding-agent/dist/bundle/cli.js') || file.endsWith('pi-coding-agent\\dist\\bundle\\cli.js'); }
  };
  const availability = adapterAvailability({ env, filesystem, home, nonce: () => 'test' });
  assert.equal(availability.codex.available, false);
  assert.match(availability.codex.reason, /nested sandbox cannot write the Codex home/);
  assert.equal(availability.claude.available, true);
  assert.equal(availability['anthropic-compat'].available, true);
  assert.equal(availability.grok.available, false);
  assert.equal(availability.pi.available, true);
  assert.equal(writes.filter(file => file.startsWith(path.join(home, '.claude'))).length, 2);
  assert.equal(deletes.length, 2);
  assert.equal(adapterAvailability({ env: { USERPROFILE: home }, filesystem, home }).codex.available, true);
  assert.equal(writes.length, 4, 'outside an agent, no home probes are added');
  assert.equal(adapterAvailability({ env: { CLAUDECODE: '1', USERPROFILE: home }, filesystem: { ...filesystem, existsSync: () => false }, home }).pi.available, false);
});

test('Route excludes inaccessible Codex adapter and chooses the first eligible fallback', t => {
  const ctx = fixture(t), options = { role: 'worker-mech', 'task-class': 'mechanical', ticket: 'T-001' };
  const available = { codex: { available: true }, pi: { available: true } };
  assert.equal(route(ctx, options, available).model, 'codex:gpt-6-luna');
  const nested = { ...available, codex: { available: false, reason: 'nested sandbox cannot write the Codex home' } };
  const result = route(ctx, options, nested);
  assert.equal(result.model, 'or:deepseek-v4.1-flash');
  assert.deepEqual(result.candidates.map(candidate => candidate.model), ['or:deepseek-v4.1-flash', 'or:glm-5.3-flash']);
  assert.deepEqual(result.skipped.unavailable_adapters, [{ model: 'codex:gpt-6-luna', reason: nested.codex.reason }]);
});

test('route --explain reports the nested exclusion and continues to pi', t => {
  const ctx = fixture(t), appdata = path.join(ctx.root, 'appdata');
  const piCli = path.join(appdata, 'npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  fs.mkdirSync(path.dirname(piCli), { recursive: true });
  write(piCli, '');
  const hx = fileURLToPath(new URL('../bin/hx.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [hx, 'route', '--project', ctx.root, '--role', 'worker-mech', '--task-class', 'mechanical', '--ticket', 'T-001', '--explain'], {
    cwd: ctx.root, env: { ...process.env, CODEX_THREAD_ID: 'nested', CODEX_HOME: path.join(ctx.root, 'missing-codex-home'), APPDATA: appdata },
    encoding: 'utf8', shell: false, windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /model=or:deepseek-v4\.1-flash/);
  assert.match(result.stdout, /excluded codex:gpt-6-luna: nested sandbox cannot write the Codex home/);
});

test('Explicit unavailable run records nested_sandbox without spawning or budget checks', async t => {
  const ctx = fixture(t), brief = path.join(ctx.data, 'brief.md'); write(brief, 'Acceptance: exit 0');
  const record = await run(ctx, { model: 'codex:gpt-6-luna', cwd: ctx.root, brief }, {
    adapterAvailability: () => ({ codex: { available: false, reason: 'nested sandbox cannot write the Codex home' } }),
    invocation: () => { throw new Error('must not invoke'); },
    exec: () => { throw new Error('must not spawn'); }
  });
  assert.equal(record.exit_code, 1);
  assert.equal(record.infra, 'nested_sandbox');
  assert.match(record.hint, /hx route or an or:\* model/);
  assert.equal(ledger(ctx)[0].infra, 'nested_sandbox');
  assert.equal(json(path.join(runDir(ctx, record.run_id), 'meta.json')).infra, 'nested_sandbox');
  outcome(ctx, record.run_id, 'fail');
  assert.deepEqual(scoreboard(ctx).rows, []);
});
