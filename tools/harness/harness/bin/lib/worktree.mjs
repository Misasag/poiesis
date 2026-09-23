import fs from 'node:fs';
import path from 'node:path';
import { git, inside, id, fail } from './util.mjs';

// Workspace metadata does not describe installed third-party dependencies.
export function normalizeLockfile(lock) {
  const { name, version, ...normalized } = lock;
  if (normalized.packages) normalized.packages = Object.fromEntries(Object.entries(normalized.packages).filter(([key, value]) =>
    key.startsWith('node_modules/') && !(key.startsWith('node_modules/@poiesis/') && value.link)));
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  return JSON.stringify(sort(normalized));
}
export async function mainCheckout(ctx) {
  const common = (await git(ctx.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
  return path.resolve(path.dirname(common));
}
export async function dependencyCheck(ctx, base) {
  const main = await mainCheckout(ctx);
  const lock = await git(ctx.root, ['show', `${base}:package-lock.json`], { allowFailure: true });
  const mainLock = path.join(main, 'package-lock.json');
  if (lock.exit_code && !fs.existsSync(mainLock)) return { main, dependencies: false };
  const parse = text => JSON.parse(text.replace(/^\uFEFF/, ''));
  if (lock.exit_code || !fs.existsSync(mainLock) || normalizeLockfile(parse(lock.stdout)) !== normalizeLockfile(parse(fs.readFileSync(mainLock, 'utf8')))) fail('package-lock.json differs from main checkout in normalized dependencies; dependency reuse skipped');
  if (!fs.existsSync(path.join(main, 'node_modules'))) fail('Main checkout node_modules is missing');
  return { main, dependencies: true };
}
export async function withWorktree(ctx, base, fn, options = {}) {
  const deps = await dependencyCheck(ctx, base);
  const dir = inside(path.join(ctx.data, 'worktrees'), id('wt'));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  let created = false, linked = false, gitPointer;
  try {
    await git(ctx.root, ['worktree', 'add', '--detach', dir, base]); created = true;
    if (options.isolated) {
      // The worker's local history contains only the starting snapshot, never
      // the gold commit, parent repository refs, remotes or worktree pointer.
      gitPointer = fs.readFileSync(path.join(dir, '.git'), 'utf8');
      fs.unlinkSync(path.join(dir, '.git'));
      await git(dir, ['init', '--quiet']);
      await git(dir, ['add', '.']);
      await git(dir, ['-c', 'user.name=Harness', '-c', 'user.email=harness@localhost', 'commit', '--quiet', '--allow-empty', '-m', 'Benchmark starting snapshot']);
    }
    if (deps.dependencies) { fs.symlinkSync(path.join(deps.main, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
    return await fn(dir);
  } finally {
    // Unlink the junction itself before git cleanup; never recurse into the
    // shared dependency target. git receives only our validated managed path.
    try {
      if (linked && fs.lstatSync(path.join(dir, 'node_modules'), { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(path.join(dir, 'node_modules'));
    } finally {
      if (gitPointer) {
        const localGit = inside(dir, '.git');
        if (fs.lstatSync(localGit, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(localGit);
        else fs.rmSync(localGit, { recursive: true, force: true });
        fs.writeFileSync(localGit, gitPointer, 'utf8');
      }
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
