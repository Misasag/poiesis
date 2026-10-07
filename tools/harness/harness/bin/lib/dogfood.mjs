import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { id, read, write, writeJson, git, killTree, fail, redactor } from './util.mjs';
import { mainCheckout } from './worktree.mjs';
import { append } from './ledger.mjs';
import { provider } from './prices.mjs';
import { requireBudget } from './budget.mjs';

export const SESSION_KEY = 'poiesis.agent-window.sessions.global.v1';
export const REQUIREMENTS_KEY = 'poiesis.requirements.sessions.v1';
const COMPOSER = '.poiesis-agent-window__composer textarea';
const ROW = '.poiesis-agent-window__session-row.active';
const DOCUMENT = '.poiesis-results__document';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
export async function waitFor(fn, ms, label) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 500)); }
  fail(`Timed out waiting for ${label}`);
}
function durableValue(envelope, key) {
  return envelope?.format === 1 && envelope.key === key && envelope.present === true ? envelope.value : null;
}
// Match the durable contracts; recursive key-name searches can mix Tasks,
// messages and aggregate Results documents and silently report false metrics.
export function sessionFacts(envelope, sessionId, requirementsEnvelope, taskId) {
  const session = durableValue(envelope, SESSION_KEY)?.sessions?.find(candidate => candidate.id === sessionId);
  const tasks = session?.tasks?.filter(task => task.sessionId === sessionId && (!taskId || task.id === taskId));
  const task = tasks?.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  if (!task) return null;
  const requirements = durableValue(requirementsEnvelope, REQUIREMENTS_KEY)?.sessions?.[sessionId];
  const requirement = requirements?.find(candidate => candidate.id === task.requirementId
    && candidate.sessionId === sessionId && candidate.taskIds?.includes(task.id));
  let document = task.resultsDocument, documentSource = 'task.resultsDocument';
  if (!document) { document = session.resultsDocuments?.find(candidate => candidate.taskId === task.id); documentSource = 'session.resultsDocuments'; }
  if (!document) { document = requirement?.resultsDocument; documentSource = 'requirement.resultsDocument'; }
  return {
    session_id: sessionId, task_id: task.id, requirement_id: task.requirementId,
    status: task.status, startedAt: task.startedAt, endedAt: task.endedAt ?? null,
    provider: task.providerId ?? null, model: task.model ?? null, workspace_uri: task.workspaceUri ?? null,
    activity_count: Array.isArray(task.activities) ? task.activities.length : null,
    activity_count_source: Array.isArray(task.activities) ? 'persisted task.activities.length' : 'not recorded',
    assertionAttempts: document?.assertionAttempts ?? null, generatedAt: document?.generatedAt ?? null,
    document_status: document?.status ?? null, document_source: document ? documentSource : null,
    document_task_id: document?.taskId ?? null, generator: document?.generator ?? null,
    results_model: document?.model ?? null, fallback_reason: document?.fallbackReason ?? null,
    update_error: document?.updateError ?? null, html_sha256: document?.html ? sha256(document.html) : null,
    failure: task.failure?.summary ?? null
  };
}
function savedFacts(config, sessionId, taskId) {
  const root = path.join(config, 'poiesis', 'state-v1');
  const file = path.join(root, `${encodeURIComponent(SESSION_KEY)}.json`);
  const requirementFile = path.join(root, `${encodeURIComponent(REQUIREMENTS_KEY)}.json`);
  const load = candidate => fs.existsSync(candidate) ? JSON.parse(read(candidate)) : null;
  const facts = sessionFacts(load(file), sessionId, load(requirementFile), taskId);
  return facts ? { ...facts, file, requirements_file: requirementFile } : null;
}
export async function resolveAppRoot(ctx, override) {
  if (override !== undefined && (typeof override !== 'string' || !override.trim())) fail('--app-root requires a directory');
  return override === undefined ? mainCheckout(ctx) : path.resolve(override);
}
// A transparent observer at the real RPC boundary: forward unchanged requests
// and responses, and retain only timing/status metadata, never prompt content.
async function observeGeneration(page) {
  await page.evaluate(() => {
    const container = window.theia.container;
    const binding = [...container._bindingDictionary._map.keys()].find(key => typeof key === 'function' && key.name === 'AiResultsSkill');
    if (!binding) throw new Error('AiResultsSkill unavailable; cannot measure generation attempts');
    const skill = container.get(binding), original = skill.generationServer, events = [];
    window.__hxDogfoodGeneration = events;
    skill.generationServer = {
      cancel: (...args) => original.cancel(...args),
      generate: async request => {
        const event = { task_id: request.taskId, started_at: new Date().toISOString(), provider: request.providerId,
          model: request.model ?? null, assertion_retry: Boolean(request.assertionRetryGuidance) };
        events.push(event);
        try { const result = await original.generate(request); event.status = result.status; event.error_code = result.error?.code ?? null; return result; }
        catch (error) { event.status = 'threw'; throw error; }
        finally { event.ended_at = new Date().toISOString(); }
      }
    };
  });
}
async function selectModel(page, role, model) {
  const picker = `.poiesis-model-picker[data-ai-role="${role}"]`;
  const trigger = `${picker} .poiesis-model-picker__trigger`;
  const option = `.poiesis-model-picker__popover[data-ai-role="${role}"] .poiesis-model-picker__option[data-provider="codex"][data-model=${JSON.stringify(model)}]`;
  await page.waitForSelector(trigger, { visible: true });
  // Opening settings refreshes detection and may remount the picker. Scrolling
  // it into view can also close its portal. Reopen only while it is closed.
  await waitFor(async () => {
    if (await page.$(option)) return true;
    if (await page.$eval(trigger, element => element.getAttribute('aria-expanded') !== 'true')) await page.$eval(trigger, element => element.click());
    return false;
  }, 30_000, `${role} model options`);
  await page.$eval(option, element => element.click());
  await page.waitForFunction(({ picker, model }) => {
    const element = document.querySelector(picker);
    return element?.getAttribute('data-provider') === 'codex' && element.getAttribute('data-model') === model;
  }, {}, { picker, model });
}
export async function renderedDocument(page) {
  const frame = await page.$(DOCUMENT);
  const content = frame && await frame.contentFrame();
  return content && content.evaluate(() => Boolean(document.body?.innerText.trim()) && document.readyState === 'complete');
}
export async function renderedText(page) {
  const element = await page.$(DOCUMENT), frame = await element.contentFrame();
  return frame.evaluate(() => {
    const body = document.body.cloneNode(true);
    for (const element of body.querySelectorAll('script, style')) element.remove();
    return body.textContent.replace(/\s+/g, ' ').trim();
  });
}
async function liveTask(page, sessionId, taskId) {
  return page.evaluate(({ sessionId, taskId }) => {
    const container = window.theia.container;
    const binding = [...container._bindingDictionary._map.keys()].find(key => typeof key === 'function' && key.name === 'AgentWindowWidget');
    const task = container.get(binding).taskService.list(sessionId).filter(candidate => !taskId || candidate.id === taskId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return task ? { id: task.id, status: task.status, startedAt: task.startedAt, endedAt: task.endedAt,
      model: task.model, provider: task.providerId, failure: task.failure?.summary, outcome: task.outcomeKind,
      completion: task.completionSummary, changed_files: task.changeSet?.files, change_diff: task.changeSet?.diff } : null;
  }, { sessionId, taskId });
}
export async function captureScreenshots(page, directory) {
  const control = action => `.poiesis-window-controls__button[data-window-action="${action}"]`;
  if (await page.$(control('restore'))) await page.$eval(control('restore'), element => element.click());
  await page.setViewport({ width: 1280, height: 720 });
  await page.screenshot({ path: path.join(directory, '1280x720.png') });
  await page.setViewport(null);
  // Electron exposes its own maximize control, but not Chromium's experimental
  // Browser.getWindowForTarget/Browser.setWindowBounds CDP methods.
  await page.waitForSelector(control('maximize'), { visible: true });
  await page.$eval(control('maximize'), element => element.click());
  await page.waitForSelector(control('restore'), { visible: true });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(directory, 'maximized.png') });
  return ['1280x720.png', 'maximized.png'];
}
export async function dogfood(ctx, o) {
  const stamp = id('dogfood'), directory = path.join(ctx.data, 'dogfood', stamp), tmp = path.join(ctx.data, 'tmp', stamp);
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });
  const redact = redactor(), workspace = path.join(tmp, 'workspace'), userData = path.join(tmp, 'user-data'), config = path.join(tmp, 'theia-config');
  const report = { kind: 'dogfood', ts: new Date().toISOString(), workspace, user_data_dir: userData, theia_config_dir: config,
    timings: {}, screenshots: [], console_errors: [], console_error_count: null, generation_attempts: null,
    activity_count: null, session: null, persistence: null, exit_code: 1 };
  let child, browser, page, output = '', authCopy, generationObserved = false;
  try {
    const main = await resolveAppRoot(ctx, o['app-root']); report.app_root = main;
    const p = provider(ctx, o.model?.includes(':') ? o.model : `codex:${o.model ?? 'gpt-6-luna'}`);
    if (p.adapter !== 'codex' || p.costBasis !== 'quota') fail('Dogfood requires a quota Codex catalog model');
    await requireBudget(ctx, p); report.model = p.id; report.cost_basis = p.costBasis;
    const source = path.resolve(o.workspace ?? path.join(os.homedir(), 'github/pomodoro-web')); report.source_workspace = source;
    const app = path.join(main, 'electron-app'), require = createRequire(path.join(app, 'package.json'));
    const electron = require('electron'), puppeteer = require('puppeteer-core');
    if (!fs.existsSync(electron) || !fs.existsSync(path.join(app, 'lib/backend/electron-main.js')) || !fs.existsSync(path.join(app, 'src-gen'))) fail('Existing app-root build:electron output is required; dogfood never builds');
    await git(ctx.root, ['clone', '--local', '--no-hardlinks', '--', source, workspace]);
    // Include current uncommitted app/skills without sharing the source .git.
    fs.cpSync(source, workspace, { recursive: true, dereference: false, filter: candidate => {
      const relative = path.relative(source, candidate);
      return !relative.split(path.sep).some(part => ['.git', 'node_modules', '.harness'].includes(part)) && !fs.lstatSync(candidate).isSymbolicLink();
    } });
    report.workspace_copy = 'local clone without hardlinks plus current source files; excludes .git, node_modules, .harness and symlinks';
    report.source_head = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
    for (const dir of [userData, config]) fs.mkdirSync(dir, { recursive: true });
    // Isolate owner MCP/config and all Codex runtime writes. Only quota auth and
    // the model cache are copied; the temporary auth copy is removed on exit.
    const codexHome = path.join(tmp, 'codex-home'); fs.mkdirSync(codexHome, { recursive: true });
    const ownerCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    for (const name of ['auth.json', 'models_cache.json']) {
      const from = path.join(ownerCodexHome, name);
      if (fs.existsSync(from)) { const to = path.join(codexHome, name); fs.copyFileSync(from, to); if (name === 'auth.json') authCopy = to; }
    }
    // The fresh home has no administrator-provisioned sandbox state. Without
    // an explicit Windows implementation, exec can downgrade to read-only.
    // Use the documented restricted-token fallback, retaining workspace-write
    // for Agent and read-only for Results as specified by the app's CLI args.
    write(path.join(codexHome, 'config.toml'), 'approval_policy = "never"\n[windows]\nsandbox = "unelevated"\n');
    report.codex_isolation = { home: codexHome, windows_sandbox: 'unelevated', owner_config_loaded: false,
      reference: 'https://learn.chatgpt.com/docs/windows/windows-sandbox' };
    const env = { ...process.env, CODEX_HOME: codexHome, THEIA_CONFIG_DIR: config,
      POIESIS_SNAPSHOT_STORE_DIR: path.join(tmp, 'snapshots'), npm_config_cache: path.join(tmp, 'npm-cache') };
    for (const key of Object.keys(env)) if (/^POIESIS_.*(?:TEST|FORCE|MOCK)/i.test(key) || /^(?:OPENAI_API_KEY|OPENAI_BASE_URL|OPENROUTER_.*|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
    const port = await freePort(), url = `http://127.0.0.1:${port}`; report.port = port;
    child = spawn(electron, [app, workspace, '--plugins=local-dir:../plugins', `--user-data-dir=${userData}`, `--electronUserData=${userData}`, `--remote-debugging-port=${port}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
      { cwd: app, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    report.pid = child.pid; child.on('error', error => { output += error.message; });
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', data => { output = (output + data).slice(-100_000); }); }
    await waitFor(async () => {
      if (child.exitCode !== null) fail('Electron exited before CDP was ready');
      try { return (await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, 120_000, 'CDP');
    browser = await puppeteer.connect({ browserURL: url, defaultViewport: null });
    page = await waitFor(async () => (await browser.pages()).find(candidate => candidate.url() !== 'about:blank' && !candidate.url().startsWith('devtools:')), 120_000, 'app page');
    report.console_observation = { start: new Date().toISOString(), source: 'Puppeteer console.error and pageerror on app page, including Results frames and reload; pre-attachment startup excluded' };
    page.on('console', message => { if (message.type() === 'error') report.console_errors.push(redact(message.text())); });
    page.on('pageerror', error => report.console_errors.push(redact(error.message)));
    page.setDefaultTimeout(120_000);
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector(COMPOSER, { visible: true });
    const actualWorkspace = await page.evaluate(() => {
      const container = window.theia.container;
      const binding = [...container._bindingDictionary._map.keys()].find(key => typeof key === 'function' && key.name === 'AgentWindowWidget');
      return container.get(binding).sessions.workspaceRoot()?.resource.toString();
    });
    if (!actualWorkspace || path.resolve(fileURLToPath(actualWorkspace)).toLowerCase() !== workspace.toLowerCase()) fail('App did not open the isolated workspace');
    await selectModel(page, 'agent', p.model);
    await page.$eval('[aria-label="\u8a2d\u5b9a"]', element => element.click());
    await page.waitForSelector('.poiesis-settings-modal');
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.poiesis-settings-modal__nav button')].find(element => element.textContent.trim() === 'AI');
      if (!button) throw new Error('AI settings category not found'); button.click();
    });
    await selectModel(page, 'results', p.model);
    await page.$eval('.poiesis-settings-modal [aria-label="\u8a2d\u5b9a\u3092\u9589\u3058\u308b"]', element => element.click());
    await page.waitForSelector('.poiesis-settings-modal', { hidden: true });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await observeGeneration(page); generationObserved = true;
    report.generation_attempts_source = 'Transparent AiResultsSkill.generationServer.generate observer installed before submission: real RPC calls including retries/failures, excluding assertion judge calls. Persisted assertionAttempts is reported separately.';
    const prompt = o['prompt-file'] ? read(path.resolve(o['prompt-file'])) : 'In index.html, add aria-label="\u30bf\u30a4\u30de\u30fc\u3092\u958b\u59cb" to the existing start button id="toggle". Make only this attribute change, verify it with Node, and do not commit.';
    write(path.join(directory, 'prompt.md'), redact(prompt));
    // React's controlled textarea must receive an input event. Avoid keystrokes
    // racing the settings dialog's deferred focus restoration.
    await page.$eval(COMPOSER, (element, value) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, prompt);
    await page.waitForFunction(({ selector, prompt }) => document.querySelector(selector)?.value === prompt, {}, { selector: COMPOSER, prompt });
    await page.waitForFunction(() => !document.querySelector('[aria-label="Agent \u3078\u9001\u4fe1"]')?.disabled);
    report.timings.submitted_at = new Date().toISOString();
    await page.$eval('[aria-label="Agent \u3078\u9001\u4fe1"]', element => element.click());
    const sessionId = await waitFor(() => page.$eval(ROW, element => element.getAttribute('data-session-id')).catch(() => null), 30_000, 'active session');
    report.session_id = sessionId;
    // tasksForDurableSession stores running tasks as interrupted for crash
    // recovery. Only the live TaskService can tell us when execution finishes.
    const task = await waitFor(() => liveTask(page, sessionId), 120_000, 'live Task'); report.task_id = task.id;
    report.timings.task_source = 'live TaskService startedAt/endedAt; durable running snapshots are intentionally stored as interrupted';
    const finished = await waitFor(async () => {
      const current = await liveTask(page, sessionId, task.id);
      return current?.status !== 'running' && current?.endedAt ? current : null;
    }, 30 * 60_000, 'Task completion');
    report.timings.task_start = finished.startedAt; report.timings.task_end = finished.endedAt;
    report.timings.task_wall_s = seconds(finished.startedAt, finished.endedAt);
    report.task_outcome = finished;
    report.session = savedFacts(config, sessionId, task.id);
    if (finished.status !== 'completed') fail(`Task ${finished.status}: ${finished.failure ?? 'no failure summary'}`);
    if (finished.model !== p.model || finished.provider !== 'codex') fail('Persisted Task used an unexpected model/provider');
    if (['conversation', 'no-change'].includes(finished.outcome) || !finished.changed_files?.length) fail(`Task produced no changed files: ${finished.completion ?? finished.outcome}`);
    await page.click('#poiesis-results-tab');
    report.session = await waitFor(async () => {
      if (page.isClosed() || child.exitCode !== null) fail('Electron stopped while waiting for Results');
      const current = savedFacts(config, sessionId, task.id);
      if (current?.document_status === 'failed') fail('Persisted Results generation failed');
      return current?.status === 'completed' && current.document_status === 'ready' && current.html_sha256 && await renderedDocument(page) ? current : null;
    }, 10 * 60_000, 'persisted ready Results and rendered document');
    report.timings.results_ready = new Date().toISOString();
    report.timings.results_ready_wall_s = seconds(report.timings.submitted_at, report.timings.results_ready);
    report.timings.results_after_task_s = seconds(finished.endedAt, report.timings.results_ready);
    report.activity_count = report.session.activity_count;
    report.generation_events = await page.evaluate(() => window.__hxDogfoodGeneration);
    report.generation_attempts = report.generation_events.length;
    if (report.activity_count === null) fail('Task activities were not persisted; count is unknown');
    if (!report.generation_attempts || report.generation_events.some(event => event.model !== p.model || event.provider !== 'codex' || !event.ended_at)) fail('Generation observation missing, unfinished, or used an unexpected model');
    // Fallback is an observable app outcome, not a successful AI document.
    // Keep generator/fallback_reason and the measured RPC attempts in the
    // report, while accepting the app's actual ready/persisted Results state.
    if (report.session.results_model !== p.model) fail('Results used an unexpected model');
    report.screenshots = await captureScreenshots(page, directory);
    const before = report.session, textBefore = await renderedText(page);
    const srcdoc = await page.$eval(DOCUMENT, element => element.getAttribute('srcdoc'));
    generationObserved = false; await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector(`${ROW}[data-session-id=${JSON.stringify(sessionId)}]`);
    await page.click('#poiesis-results-tab'); await waitFor(() => renderedDocument(page), 120_000, 'restored Results');
    const after = savedFacts(config, sessionId, task.id), restoredSrcdoc = await page.$eval(DOCUMENT, element => element.getAttribute('srcdoc'));
    const textAfter = await renderedText(page);
    report.persistence = { verified: false, reloaded: true, html_sha256: after?.html_sha256,
      rendered_text_before_sha256: sha256(textBefore), rendered_text_after_sha256: sha256(textAfter),
      srcdoc_before_sha256: sha256(srcdoc), srcdoc_after_sha256: sha256(restoredSrcdoc),
      srcdoc_identical: srcdoc === restoredSrcdoc };
    // srcdoc includes app-owned presentation wrappers. Verify the exact saved
    // document and its displayed content; record wrapper differences separately.
    if (before.html_sha256 !== after?.html_sha256 || before.activity_count !== after?.activity_count || textBefore !== textAfter) fail('Reload did not preserve Results and Task activities');
    Object.assign(report.persistence, { verified: true, activity_count: after.activity_count, assertionAttempts: after.assertionAttempts });
    report.workspace_diff = finished.change_diff;
    report.exit_code = 0;
  } catch (error) {
    report.error = redact(error.message);
    if (page && !page.isClosed()) {
      if (generationObserved) report.generation_events = await page.evaluate(() => window.__hxDogfoodGeneration).catch(() => null);
      report.generation_attempts = report.generation_events?.length ?? report.generation_attempts;
      await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
      write(path.join(directory, 'failure-dom.txt'), redact(await page.evaluate(() => document.body.innerText).catch(() => 'Page unavailable')));
    }
  } finally {
    if (report.console_observation) { report.console_observation.end = new Date().toISOString(); report.console_error_count = report.console_errors.length; }
    if (browser) await browser.disconnect().catch(() => {});
    await killTree(child);
    if (authCopy) fs.rmSync(authCopy, { force: true });
    if (report.persistence?.verified) {
      const stopped = savedFacts(config, report.session_id, report.task_id);
      report.persistence.verified_after_process_stop = stopped?.html_sha256 === report.persistence.html_sha256;
      if (!report.persistence.verified_after_process_stop) { report.exit_code = 1; report.error = 'Persisted Results changed at shutdown'; }
    }
    write(path.join(directory, 'electron.log'), redact(output));
    writeJson(path.join(directory, 'report.json'), redact(report));
    write(path.join(directory, 'report.md'), `# Dogfood ${stamp}\n\nExit: ${report.exit_code}\n\n${report.error ?? 'Completed'}\n\n` + '```json\n' + JSON.stringify(redact(report), null, 2) + '\n```\n');
    append(ctx, { ...report, report_rel: path.relative(ctx.root, path.join(directory, 'report.json')).replaceAll('\\', '/') });
  }
  return { ...report, directory };
}
