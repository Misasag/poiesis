import fs from 'node:fs';
import path from 'node:path';
import { read, redactor, safeId, inside, fail } from './util.mjs';

export function append(ctx, value, name = 'runs', redact = redactor()) {
  const file = path.join(ctx.data, 'ledger', `${safeId(name)}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(redact(value)) + '\n', 'utf8');
}
export function ledger(ctx, name = 'runs') {
  const file = path.join(ctx.data, 'ledger', `${safeId(name)}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return read(file).split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { fail(`Invalid ledger ${name} line ${index + 1}; repair explicitly before continuing`); }
  });
}
export const runDir = (ctx, runId) => inside(path.join(ctx.data, 'runs'), safeId(runId));
export function getRun(ctx, runId) {
  const r = ledger(ctx).find(r => r.run_id === runId && !r.kind);
  if (!r) fail(`Run not found: ${runId}`);
  return r;
}
export function outcome(ctx, runId, result, note = '') {
  getRun(ctx, runId);
  // timeout and skipped_quota are bench labels: timeout counts as fail for
  // pass rate (reported separately by the scoreboard); skipped_quota is
  // infrastructure and never model evidence.
  if (!['pass', 'fail', 'human', 'timeout', 'skipped_quota'].includes(result)) fail('Outcome must be pass, fail, human, timeout, or skipped_quota');
  const value = { kind: 'outcome', run_id: runId, ts: new Date().toISOString(), result, note };
  append(ctx, value); return value;
}
