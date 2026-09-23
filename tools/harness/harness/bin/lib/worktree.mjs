import fs from 'node:fs';
import path from 'node:path';
import { git, inside, id, fail } from './util.mjs';

export async function mainCheckout(ctx) {
  const common = (await git(ctx.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
  return path.dirname(common);
}
export async function dependencyCheck(ctx, base) {
  const main = await mainCheckout(ctx);
  const lock = await git(ctx.root, ['show', `${base}:package-lock.json`], { allowFailure: true });
  const mainLock = path.join(main, 'package-lock.json');
  if (lock.exit_code && !fs.existsSync(mainLock)) return { main, dependencies: false };
  if (lock.exit_code || !fs.existsSync(mainLock) || lock.stdout.replaceAll('\r\n', '\n') !== fs.readFileSync(mainLock, 'utf8').replaceAll('\r\n', '\n')) fail('package-lock.json differs from main checkout; dependency reuse skipped');
  if (!fs.existsSync(path.join(main, 'node_modules'))) fail('Main checkout node_modules is missing');
  return { main, dependencies: true };
}
export async function withWorktree(ctx, base, fn) {
  const deps = await dependencyCheck(ctx, base);
  const dir = inside(path.join(ctx.data, 'worktrees'), id('wt'));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  let created = false, linked = false;
  try {
    await git(ctx.root, ['worktree', 'add', '--detach', dir, base]); created = true;
    if (deps.dependencies) { fs.symlinkSync(path.join(deps.main, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
    return await fn(dir);
  } finally {
    // Unlink the junction itself before git cleanup; never recurse into the
    // shared dependency target. git receives only our validated managed path.
    try {
      if (linked && fs.existsSync(path.join(dir, 'node_modules'))) fs.unlinkSync(path.join(dir, 'node_modules'));
    } finally {
      if (created) await git(ctx.root, ['worktree', 'remove', '--force', dir]);
      else if (fs.existsSync(dir)) await git(ctx.root, ['worktree', 'remove', '--force', dir], { allowFailure: true });
    }
  }
}
export async function applyFiles(ctx, cwd, base, fix, files) {
  if (!files.length) return;
  const patch = (await git(ctx.root, ['diff', '--binary', base, fix, '--', ...files])).stdout;
  await git(cwd, ['apply', '--whitespace=nowarn', '-'], { input: patch });
}
