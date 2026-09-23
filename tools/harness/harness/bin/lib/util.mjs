import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const PLUGIN = path.resolve(ROOT, 'tools/harness/harness');
export const VERSION = '1.8.0';
export const read = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
export const json = p => JSON.parse(read(p));
export function write(p, value) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, value, 'utf8'); }
export const writeJson = (p, value) => write(p, JSON.stringify(value, null, 2) + '\n');
export const id = prefix => `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
export const ascii = value => String(value).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export function out(value) { process.stdout.write(ascii(typeof value === 'string' ? value : JSON.stringify(value)) + '\n'); }
export function fail(message, code = 1) { throw Object.assign(new Error(message), { exitCode: code }); }
export function inside(base, ...parts) {
  const resolved = path.resolve(base, ...parts);
  const rel = path.relative(path.resolve(base), resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('Unsafe path outside managed directory');
  return resolved;
}
export function safeId(value) { if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value ?? '')) fail('Invalid identifier'); return value; }
export function options(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { result._.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    if (['cmd', 'exclude-family'].includes(key)) (result[key] ??= []).push(value);
    else result[key] = value;
  }
  return result;
}
export function required(o, ...keys) { for (const key of keys) if (typeof o[key] !== 'string' || !o[key]) fail(`Required: --${key}`); }
export function positive(value, fallback) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n <= 0) fail('Expected a positive number');
  return n;
}
// Shared in-memory registry: a redactor created before registry lookup must also
// redact values resolved later, including top-level catch/result output.
const resolvedSecrets = new Set();
export function registerSecret(value) { if (value) resolvedSecrets.add(String(value)); return value; }
function processValue(env, name, insensitive = process.platform === 'win32') {
  const key = insensitive ? Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) : name;
  return key === undefined ? undefined : env[key];
}
export function windowsEnvironment(name, execute = execFileSync, { env = process.env, lookup } = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail('Invalid environment variable name');
  // An injected registry lookup returns { type, value }; a string is treated
  // as expandable. REG_SZ remains literal, even when referenced by another key.
  const registry = lookup ?? (key => {
    const output = execute('reg', ['query', 'HKCU\\Environment', '/v', key], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*(\S+)\s+(REG_(?:EXPAND_)?SZ)\s+(.*)$/.exec(line);
      if (match?.[1].toLowerCase() === key.toLowerCase()) return { type: match[2], value: match[3] };
    }
  });
  let references = 0;
  const checked = value => {
    registerSecret(value);
    if (typeof value !== 'string' || value.length > 32768) fail('Environment expansion unavailable');
    return value;
  };
  function resolve(key, stack, root = false) {
    const folded = key.toLowerCase();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || stack.has(folded) || stack.size >= 16 || ++references > 128) fail('Environment expansion unavailable');
    const next = new Set(stack).add(folded), inherited = root ? undefined : processValue(env, key, true);
    let entry = inherited === undefined ? registry(key) : { type: 'REG_EXPAND_SZ', value: inherited };
    if (typeof entry === 'string') entry = { type: 'REG_EXPAND_SZ', value: entry };
    if (!entry || !['REG_SZ', 'REG_EXPAND_SZ'].includes(entry.type)) fail('Environment expansion unavailable');
    const raw = checked(entry.value);
    if (entry.type === 'REG_SZ') return raw;
    // Resolve only references in this value, not percent text inserted from a
    // literal REG_SZ. Register each intermediate expansion before any failure.
    let expanded = '', offset = 0;
    for (const match of raw.matchAll(/%([^%]+)%/g)) {
      expanded = checked(expanded + raw.slice(offset, match.index) + resolve(match[1], next));
      offset = match.index + match[0].length;
    }
    return checked(expanded + raw.slice(offset));
  }
  try {
    return resolve(name, new Set(), true);
  } catch { /* Registry and expansion errors can contain values: never propagate them. */ }
  return undefined;
}
export function environmentValue(name, parent = process.env, lookup) {
  const value = processValue(parent, name) || (lookup ? lookup(name) : process.platform === 'win32' ? windowsEnvironment(name, execFileSync, { env: parent }) : undefined);
  return value ? registerSecret(value) : undefined;
}
export function redactor(env = process.env) {
  for (const [key, value] of Object.entries(env)) if (/KEY|TOKEN|SECRET/i.test(key)) registerSecret(value);
  return value => {
    const secrets = [...resolvedSecrets].sort((a, b) => b.length - a.length);
    const walk = v => {
      if (typeof v === 'string') { for (const secret of secrets) v = v.split(secret).join('[REDACTED]'); return v; }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /KEY|TOKEN|SECRET/i.test(k) && !/^(tokens|cumulative_tokens|token_count|input_tokens|output_tokens|cached_input_tokens|reasoning_output_tokens|cache_read_input_tokens|cache_creation_input_tokens|prompt_tokens|completion_tokens|total_tokens|inputTokens|outputTokens|cacheReadInputTokens|cacheCreationInputTokens|prompt_tokens_details|completion_tokens_details|cached_tokens|reasoning_tokens)$/i.test(k) ? '[REDACTED]' : walk(x)]));
      return v;
    };
    return walk(value);
  };
}
export function resolveEnv(provider, parent = process.env, lookup, ctx) {
  const env = { ...parent };
  for (const [key, value] of Object.entries(provider.env ?? {})) {
    env[key] = String(value).replace(/\$\{ENV:([^}]+)\}/g, (_, name) => {
      const resolved = environmentValue(name, parent, lookup);
      if (!resolved) fail(`Missing provider environment variable: ${name}`);
      return resolved;
    });
    if (env[key] === 'TBD') fail('Provider configuration is incomplete');
  }
  // Native Anthropic catalog entries must not silently use an inherited proxy.
  if (provider.adapter === 'claude' && (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_MODEL)) fail('Native Claude model cannot use inherited endpoint/model overrides; use anthropic-compat');
  delete env.CLAUDECODE;
  const cache = Object.entries(env).find(([key]) => key.toLowerCase() === 'npm_config_cache')?.[1];
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_cache') delete env[key];
  env.npm_config_cache = cache && path.isAbsolute(cache) ? cache : path.join(ctx?.data ?? path.join(ROOT, '.harness'), 'tmp/npm-cache');
  return env;
}
export function executable(name, extras = []) {
  const names = process.platform === 'win32' && !path.extname(name) ? [`${name}.exe`, name] : [name];
  for (const candidate of [...extras, ...(process.env.PATH ?? '').split(path.delimiter).flatMap(p => names.map(n => path.join(p.replace(/^"|"$/g, ''), n)))]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && !/\.(cmd|bat)$/i.test(candidate)) return candidate;
  }
  fail(`Executable unavailable: ${name}`);
}
export function npmCli() {
  for (const p of [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.join(process.env.APPDATA ?? '', 'npm/node_modules/npm/bin/npm-cli.js')]) if (fs.existsSync(p)) return p;
  fail('Cannot locate npm-cli.js; npm.cmd cannot be spawned with shell:false on Windows');
}
export async function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') spawnSync(executable('taskkill'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
  else child.kill('SIGKILL');
}
export function exec(file, args = [], opts = {}) {
  return new Promise(resolve => {
    const start = Date.now(); let stdout = '', stderr = '', timedOut = false, spawnError;
    const child = spawn(file, args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    opts.onSpawn?.(child);
    const timer = setTimeout(() => { timedOut = true; void killTree(child); }, opts.timeoutMs ?? 600_000);
    const interrupt = () => { timedOut = true; void killTree(child); };
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-(opts.maxOutput ?? 16_000_000)); opts.onStdout?.(data); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-100_000); opts.onStderr?.(data); });
    child.on('error', error => { spawnError = error.message; });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
    child.on('close', code => {
      clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      resolve({ stdout, stderr: spawnError ?? stderr, exit_code: timedOut ? 124 : (code ?? 1), wall_s: (Date.now() - start) / 1000 });
    });
  });
}
export async function git(cwd, args, opts = {}) {
  const r = await exec(executable('git'), args, { cwd, ...opts });
  if (r.exit_code && !opts.allowFailure) fail(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r;
}
// Windows/JSON-style double quotes; single quotes inside a double-quoted Node
// program are literal. Reject shell operators instead of silently invoking cmd.
export function splitCommand(command) {
  const args = []; let token = '', quote = '', active = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && command[i + 1] === '"') { token += '"'; i++; active = true; continue; }
    if (quote) { if (c === quote) quote = ''; else token += c; active = true; }
    else if (c === '"' || c === "'") { quote = c; active = true; }
    else if (/\s/.test(c)) { if (active) args.push(token); token = ''; active = false; }
    else if (/[|&;<>]/.test(c)) fail('Shell operators require an explicit powershell -NoProfile -Command command');
    else { token += c; active = true; }
  }
  if (quote) fail('Unclosed quote in acceptance command');
  if (active) args.push(token);
  if (!args.length) fail('Empty acceptance command');
  return args;
}
export async function command(commandText, cwd, opts = {}) {
  let [file, ...args] = splitCommand(commandText);
  if (/^cmd(?:\.exe)?$/i.test(path.basename(file))) fail('cmd.exe acceptance commands are forbidden');
  if (/^npm(?:\.cmd)?$/i.test(file)) { args.unshift(npmCli()); file = process.execPath; }
  else if (/^node(?:\.exe)?$/i.test(file)) file = process.execPath;
  else if (/^powershell(?:\.exe)?$/i.test(file)) { file = executable('powershell'); if (!args.some(x => /^-noprofile$/i.test(x))) fail('PowerShell requires -NoProfile'); }
  else if (!path.isAbsolute(file)) file = executable(file);
  if (/\.(cmd|bat)$/i.test(file)) fail('Batch shims are forbidden; resolve the real executable');
  return exec(file, args, { cwd, ...opts });
}
export function resolveProject({ cwd = process.cwd(), project, env = process.env } = {}) {
  const explicit = project ?? env.HX_PROJECT;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !explicit.trim()) fail('Expected a project directory');
    const root = path.resolve(cwd, explicit);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail('Project directory unavailable');
    return root;
  }
  try {
    const top = spawnSync(executable('git'), ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore']
    });
    return top.status === 0 && top.stdout.trim() ? path.resolve(top.stdout.trim()) : path.resolve(cwd);
  } catch { return path.resolve(cwd); }
}
export function context(root = ROOT, { sharedBudget = false } = {}) {
  return { root, data: path.join(root, '.harness'), plugin: PLUGIN,
    ...(sharedBudget ? { budgetBaseline: path.join(os.homedir(), '.poiesis', 'harness', 'openrouter-baseline.json') } : {}) };
}
export function initializeProject(ctx, { track = false } = {}) {
  if (ctx.root === ROOT) return;
  fs.mkdirSync(ctx.data, { recursive: true });
  const ignore = path.join(ctx.data, '.gitignore');
  if (track && fs.existsSync(ignore) && read(ignore) === '*\n') {
    let tracked = false;
    try {
      tracked = spawnSync(executable('git'), ['ls-files', '--error-unmatch', '--', '.harness/.gitignore'], {
        cwd: ctx.root, encoding: 'utf8', windowsHide: true, shell: false, stdio: 'ignore'
      }).status === 0;
    } catch { /* No Git metadata means there is no tracked ignore file. */ }
    if (!tracked) fs.unlinkSync(ignore);
  }
  else if (!track && !fs.existsSync(ignore)) write(ignore, '*\n');
}
export function configFile(ctx, relative) {
  const local = path.join(ctx.data, relative);
  return fs.existsSync(local) ? local : path.join(ctx.plugin, 'config', 'defaults', relative);
}
