import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { id, read, write, writeJson, git, killTree, fail, redactor } from './util.mjs';
import { mainCheckout } from './worktree.mjs';
import { append } from './ledger.mjs';
import { provider } from './prices.mjs';
import { requireBudget } from './budget.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function waitFor(fn, ms, label) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 500)); }
  fail(`Timed out waiting for ${label}`);
}
export function sessionFacts(value, sessionId) {
  const found = [];
  function visit(v) {
    if (!v || typeof v !== 'object') return;
    if (v.sessionId === sessionId && v.startedAt && v.status) found.push(v);
    for (const child of Object.values(v)) if (child && typeof child === 'object') visit(child);
  }
  visit(value);
  const task = found.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  if (!task) return null;
  const result = { task_id: task.id, status: task.status, startedAt: task.startedAt, endedAt: task.endedAt ?? null, activity_count: null, assertionAttempts: null, generatedAt: null };
  function facts(v) {
    if (!v || typeof v !== 'object') return;
    for (const [key, child] of Object.entries(v)) {
      if ((key === 'activities' || key === 'activity') && Array.isArray(child)) result.activity_count = child.length;
      if (key === 'assertionAttempts' && typeof child === 'number') result.assertionAttempts = child;
      if (key === 'generatedAt') result.generatedAt = child;
      if (child && typeof child === 'object') facts(child);
    }
  }
  facts(task); return result;
}
function savedFacts(directory, sessionId) {
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { const v = savedFacts(file, sessionId); if (v) return v; }
    else if (entry.name.endsWith('.json')) { try { const v = sessionFacts(JSON.parse(read(file)), sessionId); if (v) return { ...v, file }; } catch {} }
  }
  return null;
}
export async function dogfood(ctx, o) {
  const stamp = id('dogfood'), directory = path.join(ctx.data, 'dogfood', stamp), tmp = path.join(ctx.data, 'tmp', stamp);
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });
  const redact = redactor(), main = await mainCheckout(ctx), p = provider(ctx, o.model?.includes(':') ? o.model : `codex:${o.model ?? 'gpt-6-luna'}`);
  if (p.adapter !== 'codex') fail('Dogfood requires a Codex catalog model'); requireBudget(ctx, p);
  const source = path.resolve(o.workspace ?? path.join(os.homedir(), 'github/pomodoro-web'));
  const workspace = path.join(ctx.data, 'tmp', `dogfood-ws-${stamp}`), userData = path.join(tmp, 'user-data'), config = path.join(tmp, 'theia-config');
  const report = { kind: 'dogfood', ts: new Date().toISOString(), model: p.id, workspace, timings: {}, screenshots: [], console_errors: [], session: null, exit_code: 1 };
  let child, browser, output = '';
  try {
    const electron = path.join(main, 'node_modules/electron/dist/electron.exe');
    const app = path.join(main, 'electron-app');
    if (!fs.existsSync(electron) || !fs.existsSync(path.join(app, 'lib')) || !fs.existsSync(path.join(app, 'src-gen'))) fail('Existing main-checkout build:electron output is required; dogfood never builds');
    const require = createRequire(path.join(main, 'package.json'));
    const puppeteer = require('puppeteer-core');
    await git(ctx.root, ['clone', '--local', '--', source, workspace]);
    if (fs.existsSync(path.join(source, '.poiesis'))) fs.cpSync(path.join(source, '.poiesis'), path.join(workspace, '.poiesis'), { recursive: true, dereference: false });
    fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(config, { recursive: true });
    const port = await freePort(), url = `http://127.0.0.1:${port}`;
    report.port = port;
    child = spawn(electron, [app, workspace, '--plugins=local-dir:../plugins', `--user-data-dir=${userData}`, `--electronUserData=${userData}`, `--remote-debugging-port=${port}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], { cwd: app, env: { ...process.env, THEIA_CONFIG_DIR: config, POIESIS_SNAPSHOT_STORE_DIR: path.join(tmp, 'snapshots') }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    report.pid = child.pid;
    child.on('error', e => { output += e.message; });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-100_000); });
    await waitFor(async () => { if (child.exitCode !== null) fail('Electron exited before CDP was ready'); try { return (await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 120_000, 'CDP');
    browser = await puppeteer.connect({ browserURL: url, defaultViewport: null });
    const page = await waitFor(async () => { for (const page of await browser.pages()) if (await page.$('.poiesis-agent-window__composer textarea')) return page; return null; }, 120_000, 'composer');
    page.on('console', msg => { if (msg.type() === 'error') report.console_errors.push(redact(msg.text())); });
    page.on('pageerror', e => report.console_errors.push(redact(e.message)));
    page.setDefaultTimeout(120_000);
    await page.click('.poiesis-agent-window__composer-footer .poiesis-model-picker__trigger');
    const selector = `.poiesis-model-picker__option[data-provider="codex"][data-model="${p.model}"]`;
    await page.waitForSelector(selector); await page.click(selector);
    const prompt = o['prompt-file'] ? read(path.resolve(o['prompt-file'])) : 'Add a concise keyboard shortcuts help section to the Pomodoro page. Preserve the existing design and verify the changed behavior.';
    write(path.join(directory, 'prompt.md'), redact(prompt));
    await page.type('.poiesis-agent-window__composer textarea', prompt);
    report.timings.task_start = new Date().toISOString();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.poiesis-agent-window__session-row.active[data-session-state="running"]');
    const sessionId = await page.$eval('.poiesis-agent-window__session-row.active', n => n.getAttribute('data-session-id'));
    await page.waitForFunction(() => { const row = document.querySelector('.poiesis-agent-window__session-row.active'); return row && row.getAttribute('data-session-state') !== 'running'; }, { timeout: 30 * 60_000, polling: 500 });
    report.timings.task_end = new Date().toISOString();
    report.rail_status = await page.$eval('.poiesis-agent-window__session-row.active', n => n.getAttribute('data-session-state'));
    if (['failed', 'cancelled'].includes(report.rail_status)) fail(`Task ended with rail status ${report.rail_status}`);
    await page.click('#poiesis-results-tab');
    await page.waitForSelector('.poiesis-results__document', { timeout: 10 * 60_000 });
    await page.waitForFunction(() => !document.querySelector('.poiesis-results__generating'), { timeout: 10 * 60_000 });
    report.timings.results_ready = new Date().toISOString();
    const cdp = await page.createCDPSession();
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1280, height: 720 } });
    await page.setViewport({ width: 1280, height: 720 });
    await page.screenshot({ path: path.join(directory, '1280x720.png') }); report.screenshots.push('1280x720.png');
    await page.setViewport(null);
    await page.click('.poiesis-window-controls__button[data-window-action="maximize"]');
    await page.waitForSelector('.poiesis-window-controls__button[data-window-action="restore"]');
    await page.screenshot({ path: path.join(directory, 'maximized.png') }); report.screenshots.push('maximized.png');
    report.session = await waitFor(() => { const s = savedFacts(config, sessionId); return s?.generatedAt ? s : null; }, 30_000, 'persisted session document');
    report.session.session_id = sessionId;
    report.timings.task_wall_s = (Date.parse(report.timings.task_end) - Date.parse(report.timings.task_start)) / 1000;
    report.timings.results_after_task_s = (Date.parse(report.timings.results_ready) - Date.parse(report.timings.task_end)) / 1000;
    report.exit_code = 0;
  } catch (e) { report.error = redact(e.message); }
  finally {
    if (browser) await browser.disconnect();
    await killTree(child);
    write(path.join(directory, 'electron.log'), redact(output));
    writeJson(path.join(directory, 'report.json'), redact(report));
    write(path.join(directory, 'report.md'), `# Dogfood ${stamp}\n\nExit: ${report.exit_code}\n\n${report.error ?? 'Completed'}\n\n\`\`\`json\n${JSON.stringify(redact(report), null, 2)}\n\`\`\`\n`);
    append(ctx, { ...report, report_rel: path.relative(ctx.root, path.join(directory, 'report.json')).replaceAll('\\', '/') });
  }
  return { ...report, directory };
}
