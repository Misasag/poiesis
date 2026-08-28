import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const uiUrl = process.env.THEIA_SMOKE_UI_URL ?? 'http://127.0.0.1:3000';
const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run']
});

try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);
    await installFixture(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    const cdp = await page.createCDPSession();

    const composerSelector = '.poiesis-agent-window__composer textarea';
    await clearControl(page, composerSelector);
    const composerSequence = [];
    for (const text of ['あ', 'あ', 'あ']) {
        await commitIme(page, cdp, composerSelector, text);
        composerSequence.push(await controlValue(page, composerSelector));
    }
    await commitConvertedIme(page, cdp, composerSelector, 'かくてい', '確定');
    composerSequence.push(await controlValue(page, composerSelector));
    assert(JSON.stringify(composerSequence) === JSON.stringify(['あ', 'ああ', 'あああ', 'あああ確定']),
        `Agent composer duplicated an IME commit: ${JSON.stringify(composerSequence)}`);
    await cdp.send('Input.insertText', { text: '-ascii' });
    await commitIme(page, cdp, composerSelector, '混在');
    const mixedComposer = await controlValue(page, composerSelector);
    assert(mixedComposer === 'あああ確定-ascii混在', `Mixed composer input failed: ${mixedComposer}`);

    await page.click('.poiesis-agent-window__rail-action[title="Search"]');
    const searchSelector = '.poiesis-agent-window__session-search input';
    await clearControl(page, searchSelector);
    await commitIme(page, cdp, searchSelector, '会話');
    await cdp.send('Input.insertText', { text: '-search' });
    assert(await controlValue(page, searchSelector) === '会話-search', 'Session search was not IME-safe.');
    await page.keyboard.press('Escape');

    await page.click('.poiesis-agent-window__session-row.active .poiesis-agent-window__session-menu-trigger');
    await clickByText(page, '.poiesis-agent-window__session-menu button', '名前を変更');
    const renameSelector = '.poiesis-agent-window__session-rename';
    await page.waitForSelector(renameSelector);
    await clearControl(page, renameSelector);
    await commitIme(page, cdp, renameSelector, '名前');
    await commitIme(page, cdp, renameSelector, '変更');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__session-row.active .poiesis-agent-window__session-title')?.textContent === '名前変更');

    await page.click('#poiesis-results-tab');
    await page.waitForSelector('.poiesis-results__document');
    const resultsSelector = '.poiesis-results__composer input';
    await clearControl(page, resultsSelector);
    await commitIme(page, cdp, resultsSelector, '質問');
    await commitIme(page, cdp, resultsSelector, 'です');
    assert(await controlValue(page, resultsSelector) === '質問です', 'Results composer was not IME-safe.');

    await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal');
    const modelTrigger = '[aria-label="Agent の AI モデル"]';
    const modelEnabled = await page.$eval(modelTrigger, element => !element.disabled);
    assert(modelEnabled, 'Agent model picker is disabled in the live CLI environment.');
    await page.click(modelTrigger);
    await page.waitForSelector('.poiesis-select__listbox');
    await page.$eval('.poiesis-select__option[data-value="__custom__"]', element => element.click());
    const modelSelector = '[aria-label="Agent の AI カスタムモデルID"]';
    await page.waitForSelector(modelSelector);
    await clearControl(page, modelSelector);
    await commitIme(page, cdp, modelSelector, 'モデル');
    await cdp.send('Input.insertText', { text: '-id' });
    assert(await controlValue(page, modelSelector) === 'モデル-id', 'Custom model field was not IME-safe.');

    const toggleLayout = await toggleSettingsResourcePolicy(page);
    assert(toggleLayout.after.content.scrollTop === 0,
        `Settings toggle scrolled the application grid: ${JSON.stringify(toggleLayout)}`);
    for (const key of ['content', 'workspace', 'panelViewport', 'backdrop']) {
        assert(sameRect(toggleLayout.before[key], toggleLayout.after[key]),
            `Settings toggle shifted ${key}: ${JSON.stringify(toggleLayout)}`);
    }
    await page.keyboard.press('Escape');
    await page.click('#poiesis-agent-tab');
    await page.waitForSelector(composerSelector);

    await page.focus('.poiesis-agent-window__header');
    const composerUnfocused = await page.$eval('.poiesis-agent-window__composer', element => getComputedStyle(element).boxShadow);
    await page.click(composerSelector);
    const focusStyles = await page.evaluate(selector => {
        const input = document.querySelector(selector);
        const container = document.querySelector('.poiesis-agent-window__composer');
        if (!(input instanceof HTMLElement) || !(container instanceof HTMLElement)) return undefined;
        const textStyle = getComputedStyle(input);
        const containerStyle = getComputedStyle(container);
        return {
            textOutline: `${textStyle.outlineStyle} ${textStyle.outlineWidth}`,
            containerShadow: containerStyle.boxShadow,
            containerBorder: containerStyle.borderColor
        };
    }, composerSelector);
    await page.focus(composerSelector);
    await page.keyboard.press('Tab');
    const buttonFocus = await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return undefined;
        const style = getComputedStyle(active);
        return { className: active.className, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    assert(focusStyles && focusStyles.textOutline.startsWith('none ')
        && focusStyles.containerShadow !== composerUnfocused
        && buttonFocus?.outlineStyle === 'solid' && Number.parseFloat(buttonFocus.outlineWidth) >= 1,
    `Focus policy failed: ${JSON.stringify({ composerUnfocused, focusStyles, buttonFocus })}`);
    assert(await page.$$eval('.poiesis-agent-window__example-prompts', elements => elements.length) === 0,
        'Example prompt chips are still rendered.');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.click('#poiesis-agent-tab');
    const persistedComposer = await controlValue(page, composerSelector);
    assert(persistedComposer === mixedComposer, `IME-safe draft did not survive reload: ${persistedComposer}`);

    console.log(`ROUND14_BROWSER_SMOKE_RESULT=${JSON.stringify({
        composerSequence,
        mixedComposer,
        resultsComposer: '質問です',
        renamedSession: '名前変更',
        customModel: 'モデル-id',
        toggleLayout,
        focusStyles,
        persistedComposer
    }, null, 2)}`);
} finally {
    await browser.close();
}

async function waitForApp(page) {
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector('.poiesis-agent-window__composer textarea');
}

async function installFixture(page) {
    const installed = await page.evaluate(() => {
        const key = 'poiesis:global:poiesis.agent-window.sessions.global.v1';
        const current = JSON.parse(localStorage.getItem(key) ?? '{}');
        const workspaceUri = current.sessions?.find(session => typeof session.workspaceUri === 'string')?.workspaceUri;
        if (!workspaceUri) return false;
        const now = Date.now();
        const taskId = 'round14-results-task';
        localStorage.setItem(key, JSON.stringify({
            version: 1,
            selectedSessionId: 'round14-session',
            railWidth: 258,
            railCollapsed: false,
            sessions: [{
                id: 'round14-session', createdAt: now - 60_000, updatedAt: now, workspaceUri, branch: 'main', runTarget: 'local',
                title: 'Round 14 IME', hasUserMessage: true, lastTaskStatus: 'completed', pinned: false, archived: false,
                activeTab: 'agent', agentDraft: '', messages: [], selectedResultsTaskId: taskId, resultsDrafts: [],
                tasks: [{
                    id: taskId, sessionId: 'round14-runtime', title: 'IME Results fixture', request: 'IME test', status: 'completed',
                    startedAt: new Date(now - 30_000).toISOString(), endedAt: new Date(now - 20_000).toISOString(),
                    baseline: { kind: 'workspace-snapshot', capturedAt: new Date(now - 30_000).toISOString() },
                    changeSet: { source: 'empty', diff: '', files: [], capturedAt: new Date(now - 20_000).toISOString() }
                }],
                resultsDocuments: [{ taskId, status: 'ready', html: '<!doctype html><html><body><main><h1>IME fixture</h1></main></body></html>' }]
            }]
        }));
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
        return true;
    });
    assert(installed, 'Could not resolve the current workspace for the Round 14 fixture.');
}

async function clearControl(page, selector) {
    await page.focus(selector);
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.waitForFunction(currentSelector => document.querySelector(currentSelector)?.value === '', {}, selector);
}

async function commitIme(page, cdp, selector, text) {
    await page.$eval(selector, element => {
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
    });
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send('Input.insertText', { text });
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(resolveFrame)));
}

async function commitConvertedIme(page, cdp, selector, composingText, committedText) {
    await page.$eval(selector, element => {
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
    });
    await cdp.send('Input.imeSetComposition', {
        text: composingText,
        selectionStart: composingText.length,
        selectionEnd: composingText.length
    });
    await cdp.send('Input.imeSetComposition', {
        text: committedText,
        selectionStart: committedText.length,
        selectionEnd: committedText.length
    });
    await cdp.send('Input.insertText', { text: committedText });
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(resolveFrame)));
}

async function controlValue(page, selector) {
    return page.$eval(selector, element => element.value);
}

async function clickByText(page, selector, text) {
    await page.waitForFunction(({ selector: query, text: label }) => [...document.querySelectorAll(query)]
        .some(element => element.textContent?.trim() === label), {}, { selector, text });
    await page.evaluate(({ selector: query, text: label }) => {
        const element = [...document.querySelectorAll(query)].find(candidate => candidate.textContent?.trim() === label);
        if (!(element instanceof HTMLElement)) throw new Error(`${label} was not clickable`);
        element.click();
    }, { selector, text });
}

async function toggleSettingsResourcePolicy(page) {
    const read = () => page.evaluate(() => {
        const rect = selector => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) return undefined;
            const bounds = element.getBoundingClientRect();
            return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, scrollTop: element.scrollTop };
        };
        return {
            content: rect('.poiesis-agent-window__content'),
            workspace: rect('.poiesis-agent-window__workspace'),
            panelViewport: rect('.poiesis-agent-window__viewport'),
            backdrop: rect('.poiesis-settings-modal__backdrop')
        };
    });
    const point = await page.evaluate(() => {
        const body = document.querySelector('.poiesis-settings-modal__body');
        const toggle = document.querySelector('.poiesis-agent-window__switch > span');
        if (!(body instanceof HTMLElement) || !(toggle instanceof HTMLElement)) throw new Error('Settings toggle is missing.');
        body.scrollTop = Math.max(0, toggle.offsetTop - body.clientHeight / 2);
        const bounds = toggle.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    });
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const before = await read();
    await page.mouse.click(point.x, point.y);
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    return { before, after: await read() };
}

function sameRect(left, right) {
    return left && right && ['left', 'top', 'width', 'height'].every(key => Math.abs(left[key] - right[key]) <= 1);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
