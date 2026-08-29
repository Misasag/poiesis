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
const railWidths = [196, 252, 276, 420];
const windowSizes = [{ width: 1024, height: 600 }, { width: 1280, height: 720 }];
const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: profile,
    defaultViewport: { width: 1280, height: 720 },
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run']
});

try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await installResultsFixture(page);

    const matrix = [];
    for (const railWidth of railWidths) {
        await restoreRailWidth(page, railWidth);
        for (const size of windowSizes) {
            await clickText(page, '.poiesis-agent-window__tabs button', 'Agent');
            matrix.push(summarize(await resizeAndAssert(page, size, 'agent', railWidth)));

            await clickText(page, '.poiesis-agent-window__tabs button', 'Results');
            await page.waitForSelector('.poiesis-results__document');
            matrix.push(summarize(await resizeAndAssert(page, size, 'results', railWidth)));

            await clickText(page, '.poiesis-agent-window__code-control', 'Code');
            await page.waitForSelector('.poiesis-agent-window__code');
            matrix.push(summarize(await resizeAndAssert(page, size, 'code', railWidth)));
            await clickText(page, '.poiesis-agent-window__code-control', 'Code');
            await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__code'));
        }
    }

    await restoreRailWidth(page, 420);
    await clickText(page, '.poiesis-agent-window__tabs button', 'Agent');
    await page.setViewport({ width: 1024, height: 600 });
    const composer = await stressAgentComposer(page);
    console.log(`RESIZE_SMOKE_RESULT=${JSON.stringify({ matrix, composer }, null, 2)}`);
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
            railWidth: 276,
            railCollapsed: false,
            sessions: [{
                id: 'resize-smoke-session',
                createdAt: timestamp - 60_000,
                updatedAt: timestamp,
                workspaceUri,
                branch: 'main',
                runTarget: 'local',
                title: 'Restored-session-layout-regression-with-a-long-title-that-must-not-expand-the-workspace-column',
                hasUserMessage: true,
                lastTaskStatus: 'completed',
                pinned: false,
                archived: false,
                activeTab: 'results',
                agentDraft: '',
                messages: [
                    {
                        id: 'resize-user',
                        role: 'user',
                        content: 'Keep this deliberately long restored user message inside the fluid conversation column at every supported rail width and native window size.',
                        complete: true
                    },
                    {
                        id: 'resize-error',
                        role: 'agent',
                        content: 'Agent execution failed before the selected provider could start.',
                        complete: true,
                        error: true,
                        errorDetails: 'Usage: provider --workspace <path> --model <model>\nThe selected executable could not be started. This diagnostic must remain inside the current center column.'
                    }
                ],
                selectedResultsTaskId: taskId,
                resultsDrafts: [],
                tasks: [{
                    id: taskId,
                    sessionId: 'resize-runtime-session',
                    title: 'Restored result with a deliberately long title',
                    request: 'Verify that a restored result stays within the current workspace column.',
                    status: 'completed',
                    startedAt: new Date(timestamp - 30_000).toISOString(),
                    endedAt: new Date(timestamp - 20_000).toISOString(),
                    baseline: { kind: 'workspace-snapshot', capturedAt: new Date(timestamp - 30_000).toISOString() },
                    changeSet: { source: 'empty', diff: '', files: [], capturedAt: new Date(timestamp - 20_000).toISOString() }
                }],
                resultsDocuments: [{
                    taskId,
                    status: 'ready',
                    html: '<!doctype html><html lang="ja"><body><main><h1>Resize smoke</h1><p>Restored Results document.</p></main></body></html>'
                }]
            }]
        }));
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
    }, now);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
}

async function restoreRailWidth(page, railWidth) {
    await page.evaluate(width => {
        const key = 'poiesis:global:poiesis.agent-window.sessions.global.v1';
        const state = JSON.parse(localStorage.getItem(key) ?? '{}');
        state.railWidth = width;
        state.railCollapsed = false;
        localStorage.setItem(key, JSON.stringify(state));
    }, railWidth);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForFunction(width => {
        const rail = document.querySelector('.poiesis-agent-window__rail');
        return rail instanceof HTMLElement && Math.abs(rail.getBoundingClientRect().width - width) <= 1;
    }, {}, railWidth);
}

async function waitForApp(page) {
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector('.poiesis-results__document');
}

async function resizeAndAssert(page, size, mode, expectedRailWidth) {
    await page.setViewport(size);
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const snapshot = await page.evaluate(expectedMode => {
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
        const surfaceSelector = expectedMode === 'agent'
            ? '.poiesis-agent-window__agent, .poiesis-agent-window__agent *'
            : expectedMode === 'results'
                ? '.poiesis-results, .poiesis-results *'
                : [
                    '.poiesis-agent-window__header',
                    '.poiesis-agent-window__viewport',
                    '.poiesis-agent-window__code',
                    '.poiesis-agent-window__code-activity',
                    '.poiesis-agent-window__code-sidebar',
                    '.poiesis-agent-window__code-source-control',
                    '.poiesis-agent-window__code-editor',
                    '.poiesis-agent-window__code-editor-stack',
                    '.poiesis-agent-window__code-panel',
                    '.poiesis-agent-window__code-status'
                ].join(',');
        const clipped = [...document.querySelectorAll(surfaceSelector)]
            .filter(element => {
                if (!(element instanceof HTMLElement)) return false;
                const style = getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                const bounds = element.getBoundingClientRect();
                return bounds.width > 0 && (bounds.left < -1 || bounds.right > innerWidth + 1);
            })
            .map(element => ({
                selector: typeof element.className === 'string' ? element.className : element.tagName,
                left: Math.round(element.getBoundingClientRect().left),
                right: Math.round(element.getBoundingClientRect().right)
            }));
        const workspace = document.querySelector('.poiesis-agent-window__workspace');
        return {
            expectedMode,
            viewport: { width: innerWidth, height: innerHeight },
            content: rect('.poiesis-agent-window__content'),
            rail: rect('.poiesis-agent-window__rail'),
            workspace: rect('.poiesis-agent-window__workspace'),
            workspaceColumns: workspace instanceof HTMLElement ? getComputedStyle(workspace).gridTemplateColumns : undefined,
            header: rect('.poiesis-agent-window__header'),
            appViewport: rect('.poiesis-agent-window__viewport'),
            agent: rect('.poiesis-agent-window__agent'),
            results: rect('.poiesis-results'),
            code: rect('.poiesis-agent-window__code'),
            mode: document.querySelector('.poiesis-agent-window__content')?.getAttribute('data-mode'),
            clipped
        };
    }, mode);

    assert(snapshot.mode === mode, `Expected ${mode} mode after resize, got ${snapshot.mode}`);
    assert(snapshot.clipped.length === 0, `${mode} has horizontally clipped surfaces: ${JSON.stringify(snapshot)}`);
    assertRectFills(snapshot.content, snapshot.viewport, `${mode} content`);
    assert(snapshot.workspace && snapshot.header && snapshot.appViewport, `${mode} workspace structure is missing`);
    if (mode === 'code') {
        assert(!snapshot.rail, 'Code mode unexpectedly rendered the session rail');
        assertRectFills(snapshot.workspace, snapshot.viewport, 'Code workspace');
        assert(snapshot.code?.width === snapshot.appViewport.width && snapshot.code?.height === snapshot.appViewport.height,
            `Code surface did not fill its viewport: ${JSON.stringify(snapshot)}`);
    } else {
        assert(snapshot.rail && Math.abs(snapshot.rail.width - expectedRailWidth) <= 1,
            `${mode} rail width did not restore to ${expectedRailWidth}: ${JSON.stringify(snapshot)}`);
        assert(snapshot.rail.position !== 'absolute' && snapshot.workspace.position !== 'absolute',
            `${mode} rail/workspace escaped the grid: ${JSON.stringify(snapshot)}`);
        assert(snapshot.rail.x === 0 && snapshot.rail.right === snapshot.workspace.x,
            `${mode} rail and workspace are fragmented: ${JSON.stringify(snapshot)}`);
        assert(snapshot.workspace.width === snapshot.viewport.width - snapshot.rail.width,
            `${mode} workspace did not use window minus actual rail width: ${JSON.stringify(snapshot)}`);
        assert(snapshot.workspace.right === snapshot.viewport.width && snapshot.workspace.height === snapshot.viewport.height,
            `${mode} workspace does not fill the remaining window: ${JSON.stringify(snapshot)}`);
        assert(snapshot.header.x === snapshot.workspace.x && snapshot.header.width === snapshot.workspace.width && snapshot.header.y === 0,
            `${mode} header is detached: ${JSON.stringify(snapshot)}`);
        assert(snapshot.appViewport.x === snapshot.workspace.x && snapshot.appViewport.width === snapshot.workspace.width,
            `${mode} viewport escaped the workspace column: ${JSON.stringify(snapshot)}`);
    }
    return snapshot;
}

async function stressAgentComposer(page) {
    const selector = '.poiesis-agent-window__composer textarea';
    const expected = 'SCRATCH-DEMO.md: add one dated update-history line and do not change any other file.';
    await page.focus(selector);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await Promise.all([
        page.keyboard.type(expected, { delay: 1 }),
        (async () => {
            for (const size of [{ width: 1024, height: 600 }, { width: 1280, height: 720 }, { width: 1024, height: 600 }]) {
                await page.setViewport(size);
                await page.evaluate(() => window.dispatchEvent(new Event('resize')));
            }
        })()
    ]);
    const value = await page.$eval(selector, input => input.value);
    assert(value === expected, `Composer value was corrupted while resize renders interleaved with typing: ${JSON.stringify(value)}`);
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

function summarize(snapshot) {
    return {
        rail: snapshot.rail?.width ?? 0,
        window: `${snapshot.viewport.width}x${snapshot.viewport.height}`,
        mode: snapshot.expectedMode,
        workspace: snapshot.workspace?.width,
        workspaceColumns: snapshot.workspaceColumns,
        right: snapshot.workspace?.right,
        clipped: snapshot.clipped.length
    };
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
