import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, json, read, writeJson, write } from './util.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../poiesis-skills');
const hx = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../hx.mjs');
const skillIds = fs.readdirSync(source, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

function destination(value) {
  if (value === undefined) return path.join(os.homedir(), '.poiesis', 'skills');
  if (typeof value !== 'string' || !value.trim()) fail('Expected --dest directory');
  return path.resolve(value);
}
function manifest(dest) { return path.join(dest, '.hx-installed.json'); }
function installed(dest) {
  if (!fs.existsSync(manifest(dest))) return [];
  const ids = json(manifest(dest)).skills;
  if (!Array.isArray(ids) || ids.some(id => !skillIds.includes(id))) fail('Invalid Poiesis skill manifest');
  return ids;
}
function skillFile(dest, id) { return path.join(dest, id, 'SKILL.md'); }
function rendered(id) {
  const command = `node "${hx}"`;
  return read(path.join(source, id, 'SKILL.md')).replaceAll('{{HX_COMMAND}}', command);
}

export async function poiesis(o) {
  const action = o._[0], dest = destination(o.dest);
  if (!['install', 'uninstall'].includes(action) || o._.length !== 1) fail('Usage: hx poiesis install|uninstall [--dest dir] [--dry-run]');
  const owned = installed(dest);
  if (action === 'install') {
    for (const id of skillIds) if (fs.existsSync(path.join(dest, id)) && !owned.includes(id)) fail(`Skill directory already exists: ${id}`);
    if (!o['dry-run']) {
      for (const id of skillIds) write(skillFile(dest, id), rendered(id));
      writeJson(manifest(dest), { version: 1, skills: skillIds });
    }
    return { action, dry_run: Boolean(o['dry-run']), destination: dest, skills: skillIds, command: `node "${hx}"` };
  }
  if (!o['dry-run']) {
    for (const id of owned) {
      const file = skillFile(dest, id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      try { fs.rmdirSync(path.join(dest, id)); } catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error; }
    }
    if (fs.existsSync(manifest(dest))) fs.unlinkSync(manifest(dest));
  }
  return { action, dry_run: Boolean(o['dry-run']), destination: dest, skills: owned };
}
