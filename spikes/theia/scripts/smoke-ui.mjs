import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const uiTimeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);

const browserCandidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const executablePath = browserCandidates.find(candidate => existsSync(candidate));
if (!executablePath) {
    throw new Error('Chrome or Edge was not found. Set CHROME_PATH to run this optional smoke test.');
}

const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: resolve('.chrome-profile'),
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
    await page.waitForSelector('.lens-agent-window__actions button', { timeout: uiTimeout });
    await page.waitForSelector('#status-bar-lens-changes', { timeout: uiTimeout });

    const changesVisibleBeforeOpen = Boolean(await page.$('.lens-changes'));
    const initialAgentButtonLabels = await page.$$eval(
        '.lens-agent-window__actions button',
        buttons => buttons.map(button => button.textContent?.trim())
    );
    if (initialAgentButtonLabels.length !== 1 || initialAgentButtonLabels[0] !== '質問') {
        throw new Error(`Agent Window responsibility is invalid: ${JSON.stringify(initialAgentButtonLabels)}`);
    }

    await clickButton(page, '.lens-agent-window', '質問');
    await page.waitForSelector('[aria-label="Mock follow-up question"]', { timeout: uiTimeout });

    await clickSelector(page, '#status-bar-lens-changes', 'IDE Changes status bar entry');
    await page.waitForSelector('.lens-changes__content', { timeout: uiTimeout });
    await page.waitForSelector('[aria-label="Code Diff representation"]', { timeout: uiTimeout });

    const changeSetId = await page.$eval('.lens-changes__content', element => element.getAttribute('data-change-set-id'));
    const codeDiffVisible = Boolean(await page.$('[aria-label="Code Diff representation"]'));
    await clickSelector(page, '.lens-changes__open-diff', 'Code Diff action');
    await page.waitForFunction(
        () => [...document.querySelectorAll('.lm-TabBar-tabLabel')].some(label => label.textContent?.includes('Change Set: auth-service.ts')),
        { timeout: uiTimeout }
    );
    await page.waitForSelector('.monaco-diff-editor', { timeout: uiTimeout });
    await page.waitForFunction(
        () => document.querySelector('.lens-changes__status')?.textContent?.includes('既存 Diff Editor'),
        { timeout: uiTimeout }
    );

    await clickButton(page, '.lens-changes__tabs', 'Semantic Diff');
    await page.waitForSelector('[aria-label="Semantic Diff representation"]', { timeout: uiTimeout });
    await clickSelector(page, '.lens-changes__evidence', 'Evidence action');
    await page.waitForFunction(
        () => document.querySelector('.lens-changes__status')?.textContent?.includes('12 行目'),
        { timeout: uiTimeout }
    );

    const result = await page.evaluate(() => ({
        agentWindowVisible: Boolean(document.querySelector('.lens-agent-window')),
        agentButtonLabels: [...document.querySelectorAll('.lens-agent-window__actions button')].map(button => button.textContent?.trim()),
        questionVisible: Boolean(document.querySelector('[aria-label="Mock follow-up question"]')),
        changesVisible: Boolean(document.querySelector('.lens-changes')),
        changeSetId: document.querySelector('.lens-changes__content')?.getAttribute('data-change-set-id'),
        codeDiffVisible: Boolean(document.querySelector('[aria-label="Code Diff representation"]')),
        semanticDiffVisible: Boolean(document.querySelector('[aria-label="Semantic Diff representation"]')),
        evidenceStatus: document.querySelector('.lens-changes__status')?.textContent?.trim(),
        diffEditorVisible: Boolean(document.querySelector('.monaco-diff-editor')),
        currentTabs: [...document.querySelectorAll('.lm-TabBar-tab.lm-mod-current .lm-TabBar-tabLabel')]
            .map(label => label.textContent?.trim()),
        cursorStatus: document.querySelector('#status-bar-editor-status-cursor-position')?.textContent?.trim(),
        editorTabs: [...document.querySelectorAll('.lm-TabBar-tabLabel')].map(label => label.textContent?.trim()),
        activeLineNumbers: [...document.querySelectorAll('.monaco-editor .active-line-number')].map(line => line.textContent?.trim())
    }));

    console.log(JSON.stringify({
        executablePath,
        changesVisibleBeforeOpen,
        initialAgentButtonLabels,
        initialCodeDiffVisible: codeDiffVisible,
        initialChangeSetId: changeSetId,
        ...result
    }, null, 2));

    if (changesVisibleBeforeOpen
        || changeSetId !== 'task-auth-redis-001'
        || !codeDiffVisible
        || !result.semanticDiffVisible
        || !result.diffEditorVisible
        || !result.evidenceStatus?.includes('12 行目')
        || !result.editorTabs.includes('auth-service.ts')
        || (!result.activeLineNumbers.includes('12') && !result.cursorStatus?.includes('Ln 12'))) {
        throw new Error(`New Changes UX verification failed: ${JSON.stringify(result)}`);
    }
} finally {
    await browser.close();
}

async function clickButton(page, rootSelector, label) {
    await page.waitForFunction(
        ({ rootSelector: root, label: text }) =>
            [...document.querySelectorAll(`${root} button`)]
                .some(candidate => candidate.textContent?.trim() === text),
        { timeout: uiTimeout },
        { rootSelector, label }
    );
    await page.evaluate(({ rootSelector: root, label: text }) => {
        const button = [...document.querySelectorAll(`${root} button`)]
            .find(candidate => candidate.textContent?.trim() === text);
        if (!(button instanceof HTMLElement)) {
            throw new Error(`${text} button was not found in ${root}`);
        }
        button.click();
    }, { rootSelector, label });
}

async function clickSelector(page, selector, label) {
    await page.waitForSelector(selector, { timeout: uiTimeout });
    await page.$eval(selector, (element, labelValue) => {
        if (!(element instanceof HTMLElement)) {
            throw new Error(`${labelValue} was not an HTML element`);
        }
        element.click();
    }, label);
}
