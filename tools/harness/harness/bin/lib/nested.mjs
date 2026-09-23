import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const homes = {
  codex: { directory: '.codex', label: 'Codex' },
  claude: { directory: '.claude', label: 'Claude' },
  'anthropic-compat': { directory: '.claude', label: 'Claude' },
  grok: { directory: '.grok', label: 'Grok' }
};
let cached;

export function adapterAvailability({ env = process.env, filesystem = fs, home = os.homedir(), nonce = randomUUID } = {}) {
  const useCache = env === process.env && filesystem === fs && home === os.homedir() && nonce === randomUUID;
  if (useCache && cached) return cached;
  const nested = Boolean(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || env.CLAUDECODE);
  const result = {};
  for (const [adapter, { directory, label }] of Object.entries(homes)) {
    if (!nested) { result[adapter] = { available: true }; continue; }
    const target = adapter === 'codex' && env.CODEX_HOME
      ? env.CODEX_HOME : path.join(env.USERPROFILE || home, directory);
    const probe = path.join(target, `.hx-probe-${nonce()}`);
    let created = false;
    try {
      filesystem.writeFileSync(probe, '', { encoding: 'utf8', flag: 'wx' });
      created = true;
      filesystem.unlinkSync(probe);
      result[adapter] = { available: true };
    } catch {
      // If writing succeeded but removal failed, the adapter is unavailable.
      if (created) try { filesystem.unlinkSync(probe); } catch {}
      result[adapter] = { available: false, reason: `nested sandbox cannot write the ${label} home` };
    }
  }
  const piCli = path.join(env.APPDATA || home, 'npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  result.pi = !nested || filesystem.existsSync(piCli)
    ? { available: true } : { available: false, reason: 'pi npm CLI unavailable' };
  result.decisions = { available: true };
  if (useCache) cached = result;
  return result;
}
