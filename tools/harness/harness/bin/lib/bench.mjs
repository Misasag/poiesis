import fs from 'node:fs';
import path from 'node:path';
import { git, command, read, json, write, writeJson, safeId, fail, positive, id } from './util.mjs';
import { withWorktree, applyFiles } from './worktree.mjs';
import { run } from './run.mjs';
import { verify } from './verify.mjs';
import { outcome } from './ledger.mjs';
import { judge } from './judge.mjs';

export async function validateTask(ctx, task) {
  return withWorktree(ctx, task.base_sha, async cwd => {
    await applyFiles(ctx, cwd, task.base_sha, task.fix_sha, task.test_files);
    const before = [];
    for (const cmd of task.test_cmds) before.push({ cmd, ...await command(cmd, cwd) });
    if (before.some(x => x.exit_code === 124)) return { valid: false, reason: 'Base test timed out', before };
    if (before.every(x => x.exit_code === 0)) return { valid: false, reason: 'Tests already pass at base', before };
    await applyFiles(ctx, cwd, task.base_sha, task.fix_sha, task.src_files);
    const after = [];
    for (const cmd of task.test_cmds) after.push({ cmd, ...await command(cmd, cwd) });
    const valid = after.every(x => x.exit_code === 0);
    return { valid, reason: valid ? 'Validated fail-to-pass' : 'Tests still fail with source changes', before, after };
  });
}
function classify(files) { return files.some(f => f.includes('/browser/')) ? 'app-frontend' : 'app-backend'; }
export async function mine(ctx, o = {}) {
  const limit = positive(o.limit, 5); if (!Number.isInteger(limit)) fail('Limit must be an integer');
  const range = o.since ? `${(await git(ctx.root, ['rev-parse', '--verify', o.since])).stdout.trim()}..HEAD` : 'HEAD';
  const commits = (await git(ctx.root, ['log', '--format=%H', '--no-merges', range])).stdout.trim().split('\n').filter(Boolean);
  const validated = [], rejected = []; let candidates = 0;
  for (const fix of commits) {
    const parent = await git(ctx.root, ['rev-parse', `${fix}^`], { allowFailure: true }); if (parent.exit_code) continue;
    const base = parent.stdout.trim();
    const files = (await git(ctx.root, ['diff', '--name-only', base, fix, '--'])).stdout.trim().split('\n');
    const src = files.filter(f => f.startsWith('agent-window/src/'));
    const tests = files.filter(f => /^scripts\/test-[^/]+\.mjs$/.test(f));
    if (!src.length || !tests.length) continue;
    if (candidates++ >= limit) break;
    const taskId = `git-${fix.slice(0, 12)}`;
    try {
      const pkg = JSON.parse((await git(ctx.root, ['show', `${base}:package.json`])).stdout);
      const cmds = [...new Set(tests.map(file => {
        const match = Object.entries(pkg.scripts ?? {}).find(([key, value]) => key.startsWith('test:') && value.includes(file));
        if (!match) fail(`No test script at base for ${file}`);
        return `npm run ${match[0]}`;
      }))];
      const task = { id: taskId, base_sha: base, fix_sha: fix, test_files: tests, test_cmds: cmds, src_files: src, class: classify(src), instruction_file: 'instruction.md', instruction_source: 'commit-message' };
      const result = await validateTask(ctx, task);
      if (!result.valid) { rejected.push({ id: taskId, reason: result.reason, exits: result.after?.map(x => x.exit_code) }); continue; }
      const dir = path.join(ctx.data, 'bench/tasks', taskId);
      const message = (await git(ctx.root, ['show', '-s', '--format=%B', fix])).stdout.trim();
      write(path.join(dir, 'instruction.md'), `# Task\n\n${message}\n\nImplement the behavior described above in the existing source. Relevant areas:\n${src.map(f => `- ${f}`).join('\n')}\n\nPreserve existing behavior and keep changes within scope. Do not edit tests or commit. Hidden acceptance runs these commands (expected exit 0):\n${cmds.map(c => `- ${c}`).join('\n')}\n\nInstruction source: commit-message. Source paths are derived from the diff; no solution code is included.\n`);
      task.validation = { ts: new Date().toISOString(), before: result.before.map(x => ({ cmd: x.cmd, exit_code: x.exit_code })), after: result.after.map(x => ({ cmd: x.cmd, exit_code: x.exit_code })) };
      writeJson(path.join(dir, 'task.json'), task); validated.push(taskId);
    } catch (e) { rejected.push({ id: taskId, reason: e.message }); }
  }
  return { candidates: Math.min(candidates, limit), validated, rejected };
}
export async function benchRun(ctx, o) {
  if (Boolean(o.suite) === Boolean(o.tasks) || typeof o.models !== 'string') fail('Specify --suite or --tasks, plus --models');
  const ids = o.tasks ? o.tasks.split(',') : read(path.join(ctx.data, 'bench/suites', `${safeId(o.suite)}.txt`)).split(/\r?\n/).map(s => s.split('#')[0].trim()).filter(Boolean);
  const models = o.models.split(','), repeats = positive(o.repeats, 1); if (!Number.isInteger(repeats)) fail('Repeats must be an integer');
  if (!ids.length || !models.length) fail('Empty bench selection');
  const results = [];
  for (const taskId of ids) {
    const taskDir = path.join(ctx.data, 'bench/tasks', safeId(taskId)), task = json(path.join(taskDir, 'task.json'));
    for (const model of models) for (let repeat = 0; repeat < repeats; repeat++) {
      const item = await withWorktree(ctx, task.base_sha, async cwd => {
        const r = await run(ctx, { model, cwd, brief: path.join(taskDir, safeId(task.instruction_file)), role: 'worker', ticket: task.id, 'task-class': task.class });
        let v, error;
        try {
          // Restore every hidden test to base before patching; a worker cannot
          // obtain a pass by editing or deleting the acceptance tests.
          for (const f of task.test_files) {
            const base = await git(ctx.root, ['show', `${task.base_sha}:${f}`], { allowFailure: true });
            if (!base.exit_code) write(path.join(cwd, f), base.stdout);
            else if (fs.existsSync(path.join(cwd, f))) fs.unlinkSync(path.join(cwd, f));
          }
          // Scripts and workspace manifests are part of the evaluator, too.
          // Restore existing helpers so a worker cannot replace an imported
          // assertion helper or an npm compile script with "exit 0".
          const frozen = (await git(ctx.root, ['ls-tree', '-r', '--name-only', task.base_sha])).stdout.split('\n').filter(f => f.startsWith('scripts/') || /(^|\/)package(?:-lock)?\.json$/.test(f));
          if (frozen.length) await git(cwd, ['restore', '--source', task.base_sha, '--', ...frozen]);
          await applyFiles(ctx, cwd, task.base_sha, task.fix_sha, task.test_files);
          v = await verify(ctx, { cwd, run: r.run_id, cmd: task.test_cmds });
        } catch (e) { error = e.message; }
        const result = !error && r.exit_code === 0 && v.exit_code === 0 ? 'pass' : 'fail';
        outcome(ctx, r.run_id, result, error ?? `Hidden tests; repeat ${repeat + 1}`);
        const j = o.judge === 'none' ? null : await judge(ctx, { 'worker-run': r.run_id, judge: o.judge ?? 'auto' });
        return { task: task.id, model, repeat: repeat + 1, run_id: r.run_id, result, judge: j?.verdict ?? null, error };
      });
      results.push(item);
    }
  }
  return { results, exit_code: results.every(r => r.result === 'pass') ? 0 : 1 };
}
