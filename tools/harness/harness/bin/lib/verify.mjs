import path from 'node:path';
import fs from 'node:fs';
import { command, id, redactor, writeJson, required, fail, json, write } from './util.mjs';
import { append, ledger, runDir, getRun } from './ledger.mjs';

export async function verify(ctx, o) {
  required(o, 'cwd');
  if (!o.cmd?.length || o.cmd.some(x => typeof x !== 'string')) fail('At least one --cmd is required');
  const cwd = path.resolve(o.cwd), redact = redactor();
  const target = o.run ? getRun(ctx, o.run) : ledger(ctx).filter(r => !r.kind && r.role !== 'judge' && path.resolve(ctx.root, r.cwd_rel) === cwd).at(-1);
  if (target && path.resolve(ctx.root, target.cwd_rel) !== cwd) fail('Verification cwd differs from target run');
  const runId = target?.run_id ?? id('verify'), results = [];
  for (const cmd of o.cmd) {
    let r;
    try { r = await command(cmd, cwd); } catch (e) { r = { exit_code: 1, wall_s: 0, stdout: '', stderr: e.message }; }
    const entry = redact({ cmd, exit_code: r.exit_code, wall_s: r.wall_s, tail: (r.stdout + r.stderr).slice(-6000) });
    results.push(entry);
    append(ctx, { kind: 'verify', run_id: runId, ts: new Date().toISOString(), cwd_rel: path.relative(ctx.root, cwd).replaceAll('\\', '/'), ...entry });
  }
  const file = path.join(runDir(ctx, runId), 'verify.json');
  const old = fs.existsSync(file) ? json(file) : [];
  writeJson(file, [...old, ...results]);
  return { run_id: runId, results, exit_code: results.some(r => r.exit_code !== 0) ? 1 : 0 };
}
