import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const fixture = resolve(root, 'scripts/fixtures/results-skill');
export const skill = resolve(root, 'agent-window/skills/poiesis-results');
export const runFolder = resolve(root, 'out/results-skill-work');

export function command(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: options.cwd ?? root, encoding: 'utf8', windowsHide: true,
    shell: false, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

export function appInput(workspace = fixture, diff = readFileSync(resolve(fixture, 'diff.patch'), 'utf8')) {
  return {
    schema: 'poiesis-results-input/1', workspace, skillDir: skill,
    task: { title: '今日の作業回数', request: 'タイマー画面に、今日の作業回数を大きく表示してください。',
      status: 'completed', endedAt: '2026-09-26T00:00:00Z', completionSummary: '作業回数を表示しました。',
      implementerReport: '', failureSummary: '' },
    requirement: null,
    changedFiles: [{ path: 'index.html', status: 'modified', additions: 0, deletions: 0 },
      { path: 'README.md', status: 'modified', additions: 0, deletions: 0 },
      { path: 'tests/daily-count.test.cjs', status: 'added', additions: 164, deletions: 0 }],
    changeCaptureError: null, diff, executionEvidence: '',
    verification: { rows: [], counts: { pass: 0, fail: 0, unknown: 0, outdated: 0, human: 0 },
      total: 0, humanCount: 0, summary: '', operationSummary: '' },
    hookMaterial: '', images: [], userGuidance: '', retry: null
  };
}

export function writeCase(input, draft = readFileSync(resolve(fixture, 'draft.json'), 'utf8')) {
  mkdirSync(runFolder, { recursive: true });
  writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(input, null, 2), 'utf8');
  writeFileSync(resolve(runFolder, 'draft.json'), draft, 'utf8');
}

export function prepare() {
  const result = command(process.execPath, [resolve(skill, 'scripts/prepare.mjs')], { cwd: runFolder });
  return { status: result.status, body: JSON.parse(result.stdout.trim()) };
}

export function render() {
  const result = command(process.execPath, [resolve(skill, 'scripts/render.mjs')], { cwd: runFolder });
  return { status: result.status, body: JSON.parse(result.stdout.trim()) };
}

export function copyFixtureDraft() {
  copyFileSync(resolve(fixture, 'draft.json'), resolve(runFolder, 'draft.json'));
}
