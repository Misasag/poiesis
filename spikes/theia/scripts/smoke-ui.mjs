import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const uiTimeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const browserCandidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const executablePath = browserCandidates.find(candidate => existsSync(candidate));
if (!executablePath) {
    throw new Error('Chrome or Edge was not found. Set CHROME_PATH to run this smoke test.');
}

const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    args: [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-default-browser-check',
        '--no-first-run',
        '--no-sandbox'
    ]
});

try {
    const page = await browser.newPage();
    page.setDefaultTimeout(uiTimeout);
    await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded', timeout: uiTimeout });
    await page.waitForSelector('#lens-window-host .lens-agent-window__content', { timeout: uiTimeout });
    await page.waitForSelector('.lens-agent-window__agent');
    await page.waitForSelector('.lens-agent-window__rail');

    const initial = await page.evaluate(readState);
    assert(initial.mode === 'agent', `Expected Agent mode, got ${initial.mode}`);
    assert(initial.activeSessionTab === 'Agent', `Expected Agent tab, got ${initial.activeSessionTab}`);
    assert(initial.agentComposerVisible, 'Agent Composer is missing');
    assert(initial.sessionRailVisible, 'Session rail is missing');
    assert(!initial.legacyChangesVisible, 'Historical Changes UI is still registered');
    assert(!initial.deferredContextControlVisible, 'Deferred context control is visible');
    assert(!initial.sessionRemoveVisible, 'Deferred Session removal is visible');

    const blankSessionCount = await page.$$eval('.lens-agent-window__session-row[data-session-archived="false"]', rows => rows.length);
    await click(page, '.lens-agent-window__rail-action', 'New Chat');
    await page.waitForFunction(expected =>
        document.querySelectorAll('.lens-agent-window__session-row[data-session-archived="false"]').length === expected
        && document.activeElement?.getAttribute('aria-label') === 'Agent へのメッセージ', {}, blankSessionCount);

    await page.evaluate(() => {
        const now = Date.now();
        const session = (id, title, updatedAt) => ({
            id,
            createdAt: updatedAt - 60_000,
            updatedAt,
            title,
            hasUserMessage: true,
            pinned: false,
            archived: false,
            activeTab: 'agent',
            agentDraft: '',
            messages: [{ id: `restored-${id}`, role: 'agent', content: `${title} restored`, complete: true }],
            resultsDrafts: []
        });
        const storageKey = Object.keys(localStorage).find(key => key.endsWith(':lens.agent-window.sessions.v1'))
            ?? `theia:${location.pathname}:lens.agent-window.sessions.v1`;
        localStorage.setItem(storageKey, JSON.stringify({
            version: 1,
            selectedSessionId: 'smoke-alpha',
            railWidth: 252,
            railCollapsed: false,
            sessions: [
                session('smoke-alpha', 'Alpha session', now - 1_000),
                session('smoke-beta', 'Beta session', now)
            ]
        }));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-session-id="smoke-alpha"]');
    await page.waitForSelector('[data-session-id="smoke-beta"]');

    await page.click('[data-session-id="smoke-beta"] .lens-agent-window__session-menu-trigger');
    await click(page, '.lens-agent-window__session-menu button', 'ピン留め');
    await page.waitForSelector('[data-session-id="smoke-beta"][data-session-pinned="true"]');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__session-section-label')?.textContent === 'Pinned');

    await page.click('[data-session-id="smoke-beta"] .lens-agent-window__session-menu-trigger');
    await click(page, '.lens-agent-window__session-menu button', '名前を変更');
    await page.waitForSelector('[data-session-id="smoke-beta"] .lens-agent-window__session-rename');
    await page.click('[data-session-id="smoke-beta"] .lens-agent-window__session-rename');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.type('[data-session-id="smoke-beta"] .lens-agent-window__session-rename', 'Pinned session');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-session-id="smoke-beta"] .lens-agent-window__session-title')?.textContent === 'Pinned session');

    const railWidthBefore = await page.$eval('.lens-agent-window__rail', element => element.getBoundingClientRect().width);
    await page.focus('.lens-agent-window__rail-resize-handle');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(width => document.querySelector('.lens-agent-window__rail')?.getBoundingClientRect().width === width + 12, {}, railWidthBefore);

    await page.click('[data-session-id="smoke-alpha"] .lens-agent-window__session-menu-trigger');
    await click(page, '.lens-agent-window__session-menu button', 'アーカイブ');
    await page.waitForSelector('.lens-agent-window__archived-toggle');
    await page.click('.lens-agent-window__archived-toggle');
    await page.waitForSelector('[data-session-id="smoke-alpha"][data-session-archived="true"]');
    await page.click('[data-session-id="smoke-alpha"] .lens-agent-window__session');
    await page.waitForSelector('[data-session-id="smoke-alpha"][data-session-archived="false"]');

    await page.click('[data-session-id="smoke-alpha"] .lens-agent-window__session-menu-trigger');
    await click(page, '.lens-agent-window__session-menu button', 'アーカイブ');
    await page.waitForSelector('[data-session-id="smoke-alpha"][data-session-archived="true"]');
    await page.click('[data-session-id="smoke-alpha"] .lens-agent-window__session-menu-trigger');
    page.once('dialog', dialog => void dialog.accept());
    await click(page, '.lens-agent-window__session-menu button', '完全に削除');
    await page.waitForFunction(() => !document.querySelector('[data-session-id="smoke-alpha"]'));

    const activeCountBeforeNewChat = await page.$$eval('.lens-agent-window__session-row[data-session-archived="false"]', rows => rows.length);
    await click(page, '.lens-agent-window__rail-action', 'New Chat');
    await page.waitForFunction(expected =>
        document.querySelectorAll('.lens-agent-window__session-row[data-session-archived="false"]').length === expected + 1
        && document.activeElement?.getAttribute('aria-label') === 'Agent へのメッセージ', {}, activeCountBeforeNewChat);

    const resizedRailWidth = await page.$eval('.lens-agent-window__rail', element => element.getBoundingClientRect().width);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-session-id="smoke-beta"][data-session-pinned="true"]');
    await page.waitForFunction(expectedWidth =>
        document.querySelector('.lens-agent-window__rail')?.getBoundingClientRect().width === expectedWidth
        && !document.querySelector('[data-session-id="smoke-alpha"]'), {}, resizedRailWidth);
    const sidebar = await page.evaluate(() => ({
        activeSessionCount: document.querySelectorAll('.lens-agent-window__session-row[data-session-archived="false"]').length,
        pinnedTitle: document.querySelector('[data-session-pinned="true"] .lens-agent-window__session-title')?.textContent,
        railWidth: document.querySelector('.lens-agent-window__rail')?.getBoundingClientRect().width,
        archivedCount: document.querySelectorAll('.lens-agent-window__session-row[data-session-archived="true"]').length
    }));

    await click(page, '.lens-agent-window__rail-action', 'Search');
    await page.waitForSelector('[aria-label="会話をタイトルで検索"]');
    await page.type('[aria-label="会話をタイトルで検索"]', '__no_matching_session__');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__session-empty')?.textContent?.includes('一致する会話'));

    await click(page, '.lens-agent-window__tabs button', 'Results');
    await page.waitForSelector('.lens-results');
    const results = await page.evaluate(readState);
    assert(results.mode === 'results', `Expected Results mode, got ${results.mode}`);
    assert(results.activeSessionTab === 'Results', `Expected Results tab, got ${results.activeSessionTab}`);
    assert(results.resultsComposerVisible, 'Results Composer is missing');
    assert(results.resultsEmptyVisible, 'Results empty state is missing');

    await click(page, '.lens-agent-window__code-control', 'Code');
    await page.waitForSelector('.lens-agent-window__code');
    const code = await page.evaluate(readState);
    assert(code.mode === 'code', `Expected Code mode, got ${code.mode}`);
    assert(!code.sessionRailVisible, 'Session rail must be hidden in Code mode');
    assert(code.codeSidebarVisible, 'Code sidebar is missing');
    assert(code.codeEditorVisible, 'Code editor host is missing');
    assert(code.sessionTabCount === 0, 'Agent / Results tabs must be hidden in Code mode');

    await click(page, '.lens-agent-window__code-sidebar-tabs button', 'Git');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-sidebar-tabs button[aria-selected="true"]')?.textContent?.trim() === 'Git');

    await click(page, '.lens-agent-window__code-control', 'Code');
    await page.waitForSelector('.lens-results');
    const returned = await page.evaluate(readState);
    assert(returned.mode === 'results', `Code must return to Results, got ${returned.mode}`);
    assert(returned.activeSessionTab === 'Results', 'Results selection was not preserved');

    const settingsButtonHitTarget = await page.$eval('.lens-agent-window__rail-footer button[aria-label="設定"]', element => {
        const bounds = element.getBoundingClientRect();
        const center = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        return center?.closest('button') === element;
    });
    assert(settingsButtonHitTarget, 'An overlay is intercepting the Settings control');
    await page.click('.lens-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.lens-agent-window__code');
    await page.waitForFunction(() => [...document.querySelectorAll('.lens-agent-window__code-editor-tabs button')]
        .some(button => button.textContent?.trim() === 'Settings'));
    const settings = await page.evaluate(readState);
    assert(settings.mode === 'code', 'Settings must open in Code mode');
    assert(settings.editorTabs.includes('Settings'), 'Theia Settings widget was not opened');

    console.log(JSON.stringify({
        executablePath,
        viewport: { width: 1280, height: 720 },
        sidebar,
        initial,
        results,
        code,
        returned,
        settings
    }, null, 2));
} finally {
    await browser.close();
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function click(page, selector, text) {
    await page.waitForFunction(({ selector: currentSelector, text: currentText }) =>
        [...document.querySelectorAll(currentSelector)]
            .some(element => element.textContent?.trim() === currentText), {}, { selector, text });
    await page.evaluate(({ selector: currentSelector, text: currentText }) => {
        const element = [...document.querySelectorAll(currentSelector)]
            .find(candidate => candidate.textContent?.trim() === currentText);
        if (!(element instanceof HTMLElement)) throw new Error(`${currentText} was not clickable`);
        element.click();
    }, { selector, text });
}

function readState() {
    const content = document.querySelector('.lens-agent-window__content');
    const activeSessionTab = document.querySelector('.lens-agent-window__tabs button.active')?.textContent?.trim();
    return {
        mode: content?.getAttribute('data-mode'),
        activeSessionTab,
        sessionTabCount: document.querySelectorAll('.lens-agent-window__tabs button').length,
        sessionRailVisible: Boolean(document.querySelector('.lens-agent-window__rail')),
        agentComposerVisible: Boolean(document.querySelector('[aria-label="Agent の入力欄"]')),
        resultsComposerVisible: Boolean(document.querySelector('[aria-label="Results の入力欄"]')),
        resultsEmptyVisible: Boolean(document.querySelector('.lens-results__empty')),
        codeSidebarVisible: Boolean(document.querySelector('.lens-agent-window__code-sidebar-host')),
        codeEditorVisible: Boolean(document.querySelector('.lens-agent-window__code-editor-host')),
        editorTabs: [...document.querySelectorAll('.lens-agent-window__code-editor-tabs button')]
            .map(button => button.textContent?.trim()),
        legacyChangesVisible: Boolean(document.querySelector('.lens-changes, #status-bar-lens-changes')),
        deferredContextControlVisible: Boolean(document.querySelector('[aria-label="コンテキストを追加"]')),
        sessionRemoveVisible: Boolean(document.querySelector('.lens-agent-window__session-remove'))
    };
}
