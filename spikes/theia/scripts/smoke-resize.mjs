import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(existsSync);
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const url = process.env.THEIA_SMOKE_UI_URL ?? 'http://127.0.0.1:3000';
const profile = resolve(process.cwd(), '.run', `resize-smoke-${Date.now()}`);
const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: profile,
    defaultViewport: { width: 1462, height: 813 },
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run']
});

try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await installResultsFixture(page);

    await clickText(page, '.poiesis-agent-window__tabs button', 'Agent');
    const agent = [];
    for (const size of [{ width: 1100, height: 700 }, { width: 1500, height: 850 }]) {
        agent.push(await resizeAndAssert(page, size, 'agent'));
    }
    const composer = await stressAgentComposer(page);

    await clickText(page, '.poiesis-agent-window__tabs button', 'Results');
    await page.waitForSelector('.poiesis-results__document');
    const results = await resizeAndAssert(page, { width: 1100, height: 700 }, 'results');

    await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal__backdrop');
    const settings = await resizeAndAssert(page, { width: 1500, height: 850 }, 'results', true);
    await page.click('.poiesis-settings-modal__header button[aria-label="設定を閉じる"]');
    await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal__backdrop'));

    await clickText(page, '.poiesis-agent-window__code-control', 'Code');
    await page.waitForSelector('.poiesis-agent-window__code');
    const code = [];
    for (const size of [{ width: 1100, height: 700 }, { width: 1500, height: 850 }]) {
        code.push(await resizeAndAssert(page, size, 'code'));
    }

    console.log(`RESIZE_SMOKE_RESULT=${JSON.stringify({ agent, composer, results, settings, code }, null, 2)}`);
} finally {
    await browser.close();
}

async function installResultsFixture(page) {
    const now = Date.now();
    await page.evaluate(timestamp => {
        const key = 'poiesis:global:poiesis.agent-window.sessions.global.v1';
        const current = JSON.parse(localStorage.getItem(key) ?? '{}');
        const workspaceUri = current.sessions?.find(session => typeof session.workspaceUri === 'string')?.workspaceUri;
        if (!workspaceUri) throw new Error('The current workspace URI was not available for the resize fixture.');
        const taskId = 'resize-smoke-task';
        localStorage.setItem(key, JSON.stringify({
            version: 1,
            selectedSessionId: 'resize-smoke-session',
            railWidth: 258,
            railCollapsed: false,
            sessions: [{
                id: 'resize-smoke-session',
                createdAt: timestamp - 60_000,
                updatedAt: timestamp,
                workspaceUri,
                branch: 'main',
                runTarget: 'local',
                title: 'Resize smoke',
                hasUserMessage: true,
                lastTaskStatus: 'completed',
                pinned: false,
                archived: false,
                activeTab: 'results',
                agentDraft: '',
                messages: [{ id: 'resize-user', role: 'user', content: 'Resize smoke', complete: true }],
                selectedResultsTaskId: taskId,
                resultsDrafts: [],
                tasks: [{
                    id: taskId,
                    sessionId: 'resize-runtime-session',
                    title: 'Resize smoke',
                    request: 'Resize smoke',
                    status: 'completed',
                    startedAt: new Date(timestamp - 30_000).toISOString(),
                    endedAt: new Date(timestamp - 20_000).toISOString(),
                    baseline: { kind: 'workspace-snapshot', capturedAt: new Date(timestamp - 30_000).toISOString() },
                    changeSet: { source: 'empty', diff: '', files: [], capturedAt: new Date(timestamp - 20_000).toISOString() }
                }],
                resultsDocuments: [{
                    taskId,
                    status: 'ready',
                    html: '<!doctype html><html lang="ja"><body><main><h1>Resize smoke</h1></main></body></html>'
                }]
            }]
        }));
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
    }, now);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector('.poiesis-results__document');
}

async function resizeAndAssert(page, size, mode, settingsOpen = false) {
    await page.setViewport(size);
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const snapshot = await page.evaluate((expectedMode, expectSettings) => {
        const rect = selector => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) return undefined;
            const bounds = element.getBoundingClientRect();
            return {
                x: Math.round(bounds.x),
                y: Math.round(bounds.y),
                width: Math.round(bounds.width),
                height: Math.round(bounds.height),
                right: Math.round(bounds.right),
                bottom: Math.round(bounds.bottom),
                position: getComputedStyle(element).position
            };
        };
        return {
            expectedMode,
            viewport: { width: innerWidth, height: innerHeight },
            content: rect('.poiesis-agent-window__content'),
            rail: rect('.poiesis-agent-window__rail'),
            workspace: rect('.poiesis-agent-window__workspace'),
            header: rect('.poiesis-agent-window__header'),
            appViewport: rect('.poiesis-agent-window__viewport'),
            code: rect('.poiesis-agent-window__code'),
            settingsBackdrop: expectSettings ? rect('.poiesis-settings-modal__backdrop') : undefined,
            settingsModal: expectSettings ? rect('.poiesis-settings-modal') : undefined,
            mode: document.querySelector('.poiesis-agent-window__content')?.getAttribute('data-mode')
        };
    }, mode, settingsOpen);

    assert(snapshot.mode === mode, `Expected ${mode} mode after resize, got ${snapshot.mode}`);
    assertRectFills(snapshot.content, snapshot.viewport, `${mode} content`);
    assert(snapshot.workspace && snapshot.header && snapshot.appViewport, `${mode} workspace structure is missing`);
    if (mode === 'code') {
        assert(!snapshot.rail, 'Code mode unexpectedly rendered the session rail');
        assertRectFills(snapshot.workspace, snapshot.viewport, 'Code workspace');
        assert(snapshot.code?.width === snapshot.appViewport.width && snapshot.code?.height === snapshot.appViewport.height,
            `Code surface did not fill its viewport: ${JSON.stringify(snapshot)}`);
    } else {
        assert(snapshot.rail && snapshot.rail.width >= 52, `${mode} rail collapsed to zero: ${JSON.stringify(snapshot)}`);
        assert(snapshot.rail.position !== 'absolute' && snapshot.workspace.position !== 'absolute',
            `${mode} rail/workspace escaped the grid: ${JSON.stringify(snapshot)}`);
        assert(snapshot.rail.x === 0 && snapshot.rail.right === snapshot.workspace.x,
            `${mode} rail and workspace are fragmented: ${JSON.stringify(snapshot)}`);
        assert(snapshot.workspace.right === snapshot.viewport.width && snapshot.workspace.height === snapshot.viewport.height,
            `${mode} workspace does not fill the remaining window: ${JSON.stringify(snapshot)}`);
        assert(snapshot.header.x === snapshot.workspace.x && snapshot.header.width === snapshot.workspace.width && snapshot.header.y === 0,
            `${mode} header is detached: ${JSON.stringify(snapshot)}`);
    }
    if (settingsOpen) {
        assertRectFills(snapshot.settingsBackdrop, snapshot.viewport, 'Settings backdrop');
        assert(snapshot.settingsModal?.width > 0 && snapshot.settingsModal?.height > 0
            && snapshot.settingsModal.x >= 0 && snapshot.settingsModal.y >= 0
            && snapshot.settingsModal.right <= snapshot.viewport.width && snapshot.settingsModal.bottom <= snapshot.viewport.height,
        `Settings modal overflowed after resize: ${JSON.stringify(snapshot)}`);
    }
    return snapshot;
}

async function stressAgentComposer(page) {
    const selector = '[aria-label="Agent へのメッセージ"]';
    const expected = 'SCRATCH-DEMO.md の末尾に「更新履歴」という見出しと、今日の日付の1行を追加してください。他のファイルは変更しないでください。';
    await page.focus(selector);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await Promise.all([
        page.keyboard.type(expected, { delay: 1 }),
        (async () => {
            for (const size of [{ width: 1100, height: 700 }, { width: 1500, height: 850 }, { width: 1100, height: 700 }]) {
                await page.setViewport(size);
                await page.evaluate(() => window.dispatchEvent(new Event('resize')));
            }
        })()
    ]);
    const value = await page.$eval(selector, input => input.value);
    assert(value === expected, `Composer value was corrupted while resize renders interleaved with CDP typing: ${JSON.stringify(value)}`);
    await page.waitForFunction(expectedDraft => {
        const state = JSON.parse(localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1') ?? '{}');
        return state.sessions?.find(session => session.id === state.selectedSessionId)?.agentDraft === expectedDraft;
    }, {}, expected);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(selector);
    const restored = await page.$eval(selector, input => input.value);
    assert(restored === expected, `Persisted composer draft was corrupted: ${JSON.stringify(restored)}`);
    return { length: expected.length, valueMatches: value === expected, restoredMatches: restored === expected };
}

function assertRectFills(rect, viewport, label) {
    assert(rect?.x === 0 && rect?.y === 0 && rect?.width === viewport.width && rect?.height === viewport.height,
        `${label} did not fill the window: ${JSON.stringify({ rect, viewport })}`);
}

async function clickText(page, selector, text) {
    await page.waitForFunction(({ currentSelector, currentText }) => [...document.querySelectorAll(currentSelector)]
        .some(element => element.textContent?.trim() === currentText), {}, { currentSelector: selector, currentText: text });
    await page.evaluate(({ currentSelector, currentText }) => {
        const element = [...document.querySelectorAll(currentSelector)].find(candidate => candidate.textContent?.trim() === currentText);
        if (!(element instanceof HTMLElement)) throw new Error(`${currentText} was not clickable.`);
        element.click();
    }, { currentSelector: selector, currentText: text });
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
