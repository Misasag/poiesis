// Manual acceptance smoke: node tools/harness/harness/test/accept-poiesis-h.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hx = fileURLToPath(new URL('../bin/hx.mjs', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-h-accept-'));

function run(file, args) {
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: false });
  if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} exit=${result.status}: ${result.stderr}${result.stdout}`);
  return result.stdout.trim();
}

async function cleanup() {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe temp cleanup path');
  for (let attempt = 0; ; attempt++) {
    try { fs.rmSync(root, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY'].includes(error.code) || attempt === 10) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

try {
  run('git', ['init', '--quiet']);
  run('git', ['config', 'user.name', 'Harness Acceptance']);
  run('git', ['config', 'user.email', 'accept@example.invalid']);
  fs.writeFileSync(path.join(root, 'README.md'), 'sample\n', 'utf8');
  fs.writeFileSync(path.join(root, 'check.mjs'), 'process.exit(0);\n', 'utf8');
  run('git', ['add', 'README.md', 'check.mjs']);
  run('git', ['commit', '--quiet', '-m', 'fixture']);
  const draftDir = path.join(root, '.harness', 'tmp');
  fs.mkdirSync(draftDir, { recursive: true });
  const draft = path.join(draftDir, 'intent.md'), criteria = path.join(draftDir, 'criteria.json');
  fs.writeFileSync(draft, '## 原依頼\nImplement a checked sample workflow.\n\n## 目的\nShow recorded checks.\n\n## 全体の制約\nStay in scope.\n\n## 用語\nNone.\n\n## 棄却した代替案\nNone.\n', 'utf8');
  fs.writeFileSync(criteria, JSON.stringify([
    { text: 'Check exits successfully', kind: '得意', check: 'node check.mjs' },
    { text: 'Human confirms result', kind: '苦手', human: 'Does this meet the request?' }
  ]), 'utf8');
  run(process.execPath, [hx, 'h', 'intent', 'write', '--file', draft]);
  console.log('hx h intent write exit=0');
  run(process.execPath, [hx, 'h', 'intent', 'approve', '--quote', 'Approved for this sample']);
  console.log('hx h intent approve exit=0');
  const { id } = JSON.parse(run(process.execPath, [hx, 'h', 'ticket', 'new', '--title', 'Sample workflow', '--criteria-file', criteria, '--allowed-paths', 'README.md', '--json']));
  console.log(`hx h ticket new exit=0 id=${id}`);
  run(process.execPath, [hx, 'h', 'check', id]);
  console.log('hx h check exit=0');
  console.log('STATUS PACKET:');
  console.log(run(process.execPath, [hx, 'h', 'status']));
  console.log('hx h status exit=0');
  run(process.execPath, [hx, 'poiesis', 'install', '--workspace', root, '--dry-run']);
  console.log('hx poiesis install --workspace --dry-run exit=0');
} finally {
  await cleanup();
}
