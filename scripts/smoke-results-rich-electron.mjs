import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hashChangeSet } = require('../agent-window/lib/common/change-set-hash.js');
import { DURABLE_SESSION_KEY, DURABLE_SESSION_MIGRATION_KEY, writeDurableValue } from './poiesis-smoke-state.mjs';

const root = process.cwd();
const run = resolve(root, '.run', `rich-results-electron-${Date.now()}`);
const workspace = resolve(run, 'workspace');
const config = resolve(run, 'theia-config');
const shots = resolve(root, '_codex', 'results-rich');
for (const path of [workspace, shots, resolve(run, 'plugins')]) mkdirSync(path, { recursive: true });
writeFileSync(resolve(workspace, 'evidence.txt'), '画像の表示を確認\n図の安全性を確認\n', 'utf8');
const init = spawnSync('git', ['init', '--quiet'], { cwd: workspace, shell: false, windowsHide: true });
assert.equal(init.status, 0);
const now = new Date().toISOString();
const taskId = 'rich-results-sample';
const sessionId = 'rich-results-session';
const html = `<!doctype html><html lang="ja"><head><style>
section { margin-block: 20px; } figure { margin: 0; } img { max-height: 220px; object-fit: contain; object-position: left; }
</style></head><body><main>
<h2>作業画面</h2>
<p>ワークスペースの画像を成果文書に表示します。</p>
<img src="workspace-screen.png" alt="この試験で撮影した作業画面">
<p>作業画面の確認は未確認です。</p>
<details><summary>画像と図の記録</summary>
<svg viewBox="0 0 660 82" role="img" aria-label="画像を確認する流れ">
<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6" fill="var(--results-accent)"/></marker></defs>
<g fill="none" stroke="var(--results-accent)" stroke-width="2"><rect x="1" y="1" width="180" height="56" rx="8"/><rect x="231" y="1" width="180" height="56" rx="8"/><rect x="471" y="1" width="180" height="56" rx="8"/><path d="M182 29H224 M412 29H464" marker-end="url(#arrow)"/></g>
<g font-size="16" text-anchor="middle"><text x="91" y="36">画像を検証</text><text x="321" y="36">成果に表示</text><text x="561" y="36">クリックで拡大</text></g></svg>
<ol><li>画像を開き、Escで閉じます。</li><li>詳細パネルの画像も拡大します。</li></ol><pre>この画面の操作結果は試験完了時に記録します。</pre><a href="#" data-poiesis-citation="evidence.txt:1-2">確認内容の根拠</a></details>
</main></body></html>`;
const task = { id: taskId, sessionId, workspaceUri: pathToFileURL(workspace).href, title: '画像と図で成果を確認', request: '成果に図と画像を表示する',
    status: 'completed', startedAt: now, endedAt: now, baseline: { kind: 'workspace-snapshot', capturedAt: now },
    activities: [{ id: 'exploratory-search', kind: 'command', title: 'ファイルを探す', detail: '終了コード 1', status: 'failed', startedAt: now, endedAt: now }],
    changeSet: { source: 'task-diff', diff: 'diff --git a/evidence.txt b/evidence.txt\n+画像の表示を確認', files: ['evidence.txt'], capturedAt: now },
    hookEvidence: [{ hookId: '画面の確認', runId: 'sample', evidence: [{ label: '作業画面', status: 'unknown', detail: 'この試験で撮影した画像', image: 'workspace-screen.png' }] }],
    resultsDocument: { taskId, status: 'ready', generator: 'ai', html } };
task.changeSet.changeSetHash = await hashChangeSet(task.changeSet);
const hook = spawnSync(process.execPath, [resolve(root, 'scripts/fixtures/hook.mjs'), 'versioned-evidence'], {
    input: JSON.stringify({ taskId, runId: 'evidence-smoke', data: { changeSetHash: task.changeSet.changeSetHash } }),
    encoding: 'utf8', shell: false, windowsHide: true
});
assert.equal(hook.status, 0);
task.hookEvidence = [{ hookId: '画面の確認', runId: 'evidence-smoke', evidence: JSON.parse(hook.stdout).evidence }];
writeDurableValue(config, DURABLE_SESSION_KEY, { version: 1, selectedSessionId: sessionId, railWidth: 258, railCollapsed: false,
    sessions: [{ id: sessionId, createdAt: Date.now(), updatedAt: Date.now(), workspaceUri: task.workspaceUri, branch: 'main', runTarget: 'local',
        title: task.title, hasUserMessage: true, lastTaskStatus: 'completed', pinned: false, archived: false, activeTab: 'agent',
        agentDraft: '', messages: [{ id: 'sample-request', role: 'user', content: task.request, complete: true }], selectedResultsTaskId: taskId,
        resultsDrafts: [], tasks: [task], resultsDocuments: [task.resultsDocument] }] });
writeDurableValue(config, DURABLE_SESSION_MIGRATION_KEY, true);
const port = await new Promise(resolvePort => {
    const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)); });
});
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
        catch { await new Promise(resolveDelay => setTimeout(resolveDelay, 500)); }
    }
    assert.ok(browser, 'Electron debugging endpoint did not start');
    let page;
    while (!page && Date.now() < deadline) {
        page = (await browser.pages()).find(candidate => /^(?:file|https?):/.test(candidate.url()));
        if (!page) await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
    }
    assert.ok(page, 'Electron page missing');
    page.setDefaultTimeout(120000);
    await page.bringToFront();
    await page.waitForSelector('#poiesis-results-tab');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__content--initializing')
        && (!document.querySelector('.theia-preload') || Number.parseFloat(getComputedStyle(document.querySelector('.theia-preload')).opacity) <= .01));
    await page.screenshot({ path: resolve(workspace, 'workspace-screen.png') });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#poiesis-results-tab');
    await page.click('#poiesis-results-tab');
    console.log('RICH_RESULTS: opened Results');
    const frameElement = await page.waitForSelector('.poiesis-results__document');
    const frame = await frameElement.contentFrame();
    await frame.waitForSelector('img[data-poiesis-image]');
    console.log('RICH_RESULTS: resolved image');
    assert.equal(await page.$('.poiesis-results__canvas .poiesis-results__verification'), null);
    await page.waitForSelector('.poiesis-results__answer-warning');
    assert.equal(await page.$eval('.poiesis-results__answer-warning', node => node.textContent.includes('詳細の確認記録を参照してください')), true);
    await page.click('.poiesis-results__details-trigger');
    const tableSelector = '#poiesis-results-details-panel .poiesis-results__verification';
    await page.waitForSelector(`${tableSelector} tbody tr[data-status="human"]`);
    assert.equal(await page.$$eval(`${tableSelector} tbody tr`, rows => rows.length), 4);
    for (const status of ['pass', 'fail', 'outdated', 'human']) {
        assert.equal(await page.$$eval(`${tableSelector} tbody tr[data-status="${status}"]`, rows => rows.length), 1);
    }
    assert.equal(await page.$$eval(`${tableSelector} tbody tr[data-status="unknown"]`, rows => rows.length), 0);
    assert.equal(await page.$eval(`${tableSelector} .poiesis-results__verification-heading`, node => node.textContent), '確認 4件中 1件成功・1件失敗・1件以前の結果・1件人間の判断待ち');
    assert.equal(await page.$eval(`${tableSelector} .poiesis-results__operation-summary`, node => node.textContent), '作業の記録: 1件の作業で操作 1件（うち失敗 1件）');
    assert.equal(await page.$eval('.poiesis-results__human-badge', node => node.textContent), '判断待ち 1件');
    await page.waitForSelector('.poiesis-results__answer-warning');
    await page.screenshot({ path: resolve(shots, 'results-evidence-table.png') });
    await page.click('[aria-label="詳細を閉じる"]');
    await frame.$eval('img', image => image.scrollIntoView());
    await frame.waitForFunction(() => { const img = document.querySelector('img'); return img?.complete && img.naturalWidth > 0; });
    assert.equal(await frame.$$eval('svg', nodes => nodes.length), 1);
    assert.equal(await frame.$eval('details', node => node.open), false);
    await frame.focus('summary'); await page.keyboard.press('Enter');
    assert.equal(await frame.$eval('details', node => node.open), true);
    await frame.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: resolve(shots, 'results-rich-electron.png') });
    await frame.click('img');
    await page.waitForSelector('.poiesis-results__image-viewer', { visible: true });
    await page.screenshot({ path: resolve(shots, 'results-image-viewer.png') });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.poiesis-results__image-viewer', { hidden: true });
    await frame.focus('img'); await page.keyboard.press('Enter');
    await page.waitForSelector('.poiesis-results__image-viewer', { visible: true });
    await page.click('[aria-label="画像を閉じる"]');
    await page.click('.poiesis-results__details-trigger');
    await page.waitForSelector('#poiesis-results-details-panel .poiesis-results__evidence-image img');
    await page.click('#poiesis-results-details-panel .poiesis-results__evidence-image');
    await page.waitForSelector('.poiesis-results__image-viewer', { visible: true });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.poiesis-results__image-viewer', { hidden: true });
    assert.equal(await page.$eval('#poiesis-results-details-panel .poiesis-results__evidence-image', node => node === document.activeElement), true);
    await page.click('[aria-label="詳細を閉じる"]');
    await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('input[name="poiesis-display-theme"][value="light"]');
    await page.$eval('input[name="poiesis-display-theme"][value="light"]', input => input.click());
    await page.click('[aria-label="設定を閉じる"]');
    const lightFrame = await (await page.$('.poiesis-results__document')).contentFrame();
    await lightFrame.waitForFunction(() => document.documentElement.dataset.theme === 'light' && document.body.clientWidth > 0);
    assert.equal(await lightFrame.$eval('svg', node => getComputedStyle(node).color), 'rgb(38, 39, 33)');
    await lightFrame.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: resolve(shots, 'results-rich-electron-light.png') });
    if (!await lightFrame.$eval('details', node => node.open)) { await lightFrame.click('summary'); }
    await lightFrame.click('[data-poiesis-citation]');
    await page.waitForSelector('.poiesis-agent-window__code-editor-tab.active');
    assert.equal(await page.evaluate(() => navigator.userAgent.includes('Electron/')), true);
    console.log(JSON.stringify({ resultsRichElectron: 'passed', screenshot: resolve(shots, 'results-rich-electron.png'),
        checks: ['workspace screenshot', 'inline SVG', 'keyboard details', 'click and keyboard viewer', 'Escape', 'hook thumbnail', 'focus restoration', 'light/dark theme', 'citation'] }));
} catch (error) { throw new Error(`${error.message}\n${log}`); }
finally {
    await browser?.disconnect();
    if (child.exitCode === null) spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
}
