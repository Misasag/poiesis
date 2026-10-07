import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hx = fileURLToPath(new URL('../bin/hx.mjs', import.meta.url));
const cli = (root, ...args) => spawnSync(process.execPath, [hx, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, shell: false });
const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: false });
const parse = result => JSON.parse(result.stdout);
const good = result => assert.equal(result.status, 0, result.stderr + result.stdout);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-poiesis-h-'));
  t.after(async () => {
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(root, { recursive: true, force: true }); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === 10) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  });
  good(git(root, 'init'));
  good(git(root, 'config', 'user.email', 'test@example.invalid'));
  good(git(root, 'config', 'user.name', 'Harness Test'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'target.txt'), 'initial\n', 'utf8');
  fs.writeFileSync(path.join(root, 'check.mjs'), "import fs from 'node:fs'; if (!fs.readFileSync('src/target.txt', 'utf8').trim()) process.exit(1);\n", 'utf8');
  good(git(root, 'add', '.'));
  good(git(root, 'commit', '-m', 'fixture'));
  fs.mkdirSync(path.join(root, '.harness', 'tmp'), { recursive: true });
  return root;
}

function setupIntent(root) {
  const draft = path.join(root, '.harness', 'tmp', 'intent.md');
  fs.writeFileSync(draft, '## 原依頼\nKeep the exact original request.\n\n## 目的\nMake the workflow verifiable.\n\n## 全体の制約\nStay in scope.\n\n## 用語\nTicket means work item.\n\n## 棄却した代替案\nNone.\n', 'utf8');
  good(cli(root, 'h', 'intent', 'write', '--file', draft));
  return draft;
}

function setupTicket(root, allowed = 'src') {
  const file = path.join(root, '.harness', 'tmp', 'criteria.json');
  fs.writeFileSync(file, JSON.stringify([
    { text: 'Target content passes its check', kind: '得意', check: 'node check.mjs' },
    { text: 'Human accepts the result', kind: '苦手', human: 'Does the result meet the request?' }
  ]), 'utf8');
  const created = cli(root, 'h', 'ticket', 'new', '--title', 'Small task', '--criteria-file', file, '--allowed-paths', allowed, '--json');
  good(created);
  return parse(created).id;
}

test('intent versioning and status packet preserve the original request and expose stale approval', t => {
  const root = fixture(t), draft = setupIntent(root);
  const initial = parse(cli(root, 'h', 'status', '--json'));
  assert.equal(initial.original_request, 'Keep the exact original request.');
  assert.equal(initial.intent.approved, false);
  const first = parse(cli(root, 'h', 'intent', 'approve', '--quote', 'Yes, that is my intent', '--json'));
  assert.equal(parse(cli(root, 'h', 'status', '--json')).intent.approved, true);
  good(cli(root, 'h', 'intent', 'write', '--file', draft));
  assert.equal(parse(cli(root, 'h', 'status', '--json')).intent.approved_version, first.approved_version);
  fs.appendFileSync(draft, '\nA clarified constraint.\n', 'utf8');
  good(cli(root, 'h', 'intent', 'write', '--file', draft));
  assert.equal(parse(cli(root, 'h', 'status', '--json')).intent.approved, false);
  good(cli(root, 'h', 'intent', 'approve', '--quote', 'Approved again'));
  fs.appendFileSync(path.join(root, '.harness', 'intent', 'root.md'), '\nManual edit.\n', 'utf8');
  const stale = parse(cli(root, 'h', 'status', '--json'));
  assert.equal(stale.intent.stale, true);
  assert.match(stale.packet, /approval is older than its body/);
  assert.ok(stale.packet.split('\n').length < 60);
});

test('ticket confirmation requires current machine evidence and human judgment; scope detects drift', t => {
  const root = fixture(t);
  setupIntent(root);
  good(cli(root, 'h', 'intent', 'approve', '--quote', 'Approved'));
  const id = setupTicket(root);
  const before = cli(root, 'h', 'ticket', 'state', id, '確定', '--reason', 'Trying too early');
  assert.notEqual(before.status, 0);
  assert.match(before.stdout, /criterion 1 is/);
  good(cli(root, 'h', 'ticket', 'state', id, '実行中', '--reason', 'Start'));
  fs.writeFileSync(path.join(root, 'src', 'target.txt'), 'ready\n', 'utf8');
  const check = cli(root, 'h', 'check', id, '--json');
  good(check);
  assert.equal(parse(check).results[0].exit_code, 0);
  const evidenceFile = path.join(root, '.harness', 'evidence', `${id}.jsonl`);
  assert.equal(JSON.parse(fs.readFileSync(evidenceFile, 'utf8').trim()).criterion, 1);
  const noHuman = cli(root, 'h', 'ticket', 'state', id, '確定', '--reason', 'No human yet');
  assert.notEqual(noHuman.status, 0);
  assert.match(noHuman.stdout, /criterion 2 is/);
  good(cli(root, 'h', 'ticket', 'approve', id, '--criterion', '2', '--quote', 'This is right'));
  fs.writeFileSync(path.join(root, 'src', 'target.txt'), 'changed again\n', 'utf8');
  const stale = parse(cli(root, 'h', 'status', '--json'));
  const item = stale.active_tickets.find(x => x.id === id);
  assert.deepEqual(item.unmet.map(x => x.status), ['古い', '古い']);
  good(cli(root, 'h', 'check', id));
  good(cli(root, 'h', 'ticket', 'approve', id, '--criterion', '2', '--quote', 'Still right'));
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside\n', 'utf8');
  const scoped = parse(cli(root, 'h', 'scope', id, '--json'));
  assert.deepEqual(scoped.outside, ['outside.txt']);
  const outOfScope = cli(root, 'h', 'ticket', 'state', id, '確定', '--reason', 'Outside');
  assert.notEqual(outOfScope.status, 0);
  fs.unlinkSync(path.join(root, 'outside.txt'));
  good(cli(root, 'h', 'ticket', 'state', id, '確定', '--reason', 'All criteria satisfied'));
  const confirmed = parse(cli(root, 'h', 'ticket', 'list', '--json')).tickets.find(x => x.id === id);
  assert.equal(confirmed.state, '確定');
});

test('journal is append-only and workspace install/uninstall owns only two skills', t => {
  const root = fixture(t);
  setupIntent(root);
  const id = setupTicket(root);
  good(cli(root, 'h', 'journal', id, 'Tried the local check', '--kind', 'tried'));
  good(cli(root, 'h', 'journal', id, 'Kept the simple route', '--kind', 'decided'));
  const journal = fs.readFileSync(path.join(root, '.harness', 'journal', `${id}.md`), 'utf8');
  assert.match(journal, /tried: Tried the local check/);
  assert.match(journal, /decided: Kept the simple route/);
  const preview = cli(root, 'poiesis', 'install', '--workspace', root, '--dry-run', '--json');
  good(preview);
  assert.deepEqual(parse(preview).skills, ['harness-core', 'harness-results']);
  assert.ok(!fs.existsSync(path.join(root, '.poiesis')));
  good(cli(root, 'poiesis', 'install', '--workspace', root));
  const dest = path.join(root, '.poiesis', 'skills');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest, '.hx-installed.json'), 'utf8')).skills, ['harness-core', 'harness-results']);
  assert.match(fs.readFileSync(path.join(dest, 'harness-core', 'SKILL.md'), 'utf8'), /h status/);
  fs.writeFileSync(path.join(dest, 'harness-results', 'owner.txt'), 'keep', 'utf8');
  good(cli(root, 'poiesis', 'uninstall', '--workspace', root));
  assert.ok(!fs.existsSync(path.join(dest, 'harness-core')));
  assert.ok(fs.existsSync(path.join(dest, 'harness-results', 'owner.txt')));
});
