import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const baseURL = process.env.THEIA_DESIGN_SHOTS_URL ?? 'http://127.0.0.1:3000';
const uiTimeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const outputDirectory = resolve(process.cwd(), '_codex', 'design-shots');

const browserCandidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const executablePath = browserCandidates.find(candidate => existsSync(candidate));
if (!executablePath) {
    throw new Error('Chrome or Edge was not found. Set CHROME_PATH to capture design shots.');
}

const shots = [
    { name: 'D1-A.png', variant: 'd1-a' },
    { name: 'D1-B.png', variant: 'd1-b' },
    { name: 'D2-A.png', variant: 'd2-a', openChanges: true },
    { name: 'D2-B.png', variant: 'd2-b', openChanges: true },
    { name: 'D3-A.png', variant: 'd3-a', openChanges: true },
    { name: 'D3-B.png', variant: 'd3-b', openChanges: true },
    { name: 'D4-A.png', variant: 'd4-a' },
    { name: 'D4-B.png', variant: 'd4-b' },
    { name: 'D5-A.png', variant: 'd5-a' },
    { name: 'D5-B.png', variant: 'd5-b', waitForToast: true },
    { name: 'D6-A.png', variant: 'd6-a' },
    { name: 'D6-B.png', variant: 'd6-b' },
    { name: 'D7-A.png', variant: 'd7-a', openChanges: true, expectedMode: 'code' },
    { name: 'D7-B.png', variant: 'd7-b', openChanges: true, expectedMode: 'semantic' },
    { name: 'semantic-card-closeup.png', variant: 'semantic-card-closeup', openChanges: true, expectedMode: 'semantic', closeup: true }
];

mkdirSync(outputDirectory, { recursive: true });

const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: {
        width: 1600,
        height: 900,
        deviceScaleFactor: 1
    },
    args: [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--force-color-profile=srgb',
        '--no-default-browser-check',
        '--no-first-run',
        '--no-sandbox'
    ]
});

const results = [];

try {
    for (const shot of shots) {
        const page = await browser.newPage();
        page.setDefaultTimeout(uiTimeout);
        await page.evaluateOnNewDocument(() => {
            window.localStorage.clear();
            window.localStorage.setItem('theme', 'dark');
        });

        const url = new URL(baseURL);
        url.searchParams.set('variant', shot.variant);
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: uiTimeout });
        await page.waitForSelector('#theia-app-shell.theia-ApplicationShell', { timeout: uiTimeout });
        await page.waitForSelector('.poiesis-agent-window__actions button', { timeout: uiTimeout });
        await page.waitForSelector('#status-bar-poiesis-changes', { timeout: uiTimeout });
        await page.waitForFunction(
            variant => document.documentElement.dataset.poiesisDesignVariant === variant,
            { timeout: uiTimeout },
            shot.variant
        );
        await page.waitForFunction(
            () => document.documentElement.dataset.poiesisDesignTheme === 'dark'
                && document.body.classList.contains('theia-dark')
                && !document.body.classList.contains('theia-light'),
            { timeout: uiTimeout }
        );
        await page.waitForFunction(
            () => [...document.querySelectorAll('.theia-preload')]
                .every(element => getComputedStyle(element).opacity === '0' || getComputedStyle(element).display === 'none'),
            { timeout: uiTimeout }
        );
        await page.waitForFunction(
            () => ![...document.querySelectorAll('[id^="status-bar-"]')]
                .some(element => element.textContent?.includes('Activating')),
            { timeout: uiTimeout }
        );

        await page.addStyleTag({ content: `
            *, *::before, *::after {
                animation-delay: 0s !important;
                animation-duration: 0s !important;
                caret-color: transparent !important;
                transition-delay: 0s !important;
                transition-duration: 0s !important;
            }
        ` });

        if (shot.openChanges) {
            await page.$eval('#status-bar-poiesis-changes', element => {
                if (!(element instanceof HTMLElement)) {
                    throw new Error('Changes status entry is not an HTML element');
                }
                element.click();
            });
            await page.waitForSelector('.poiesis-changes__content', { timeout: uiTimeout });
        }

        if (shot.waitForToast) {
            await page.waitForSelector(
                '.theia-notification-toasts.open .theia-notification-list-item',
                { visible: true, timeout: uiTimeout }
            );
        }

        await page.evaluate(keepDesignToast => {
            for (const notification of document.querySelectorAll('.theia-notification-list-item-container')) {
                const message = notification.querySelector('.theia-notification-message')?.textContent?.trim();
                if (keepDesignToast && message === 'Change Setを作成しました。') {
                    continue;
                }
                const close = notification.querySelector('.theia-notification-actions .codicon-close');
                if (close instanceof HTMLElement) {
                    close.click();
                }
            }
        }, shot.waitForToast === true);

        if (shot.expectedMode === 'code') {
            await page.waitForSelector('[aria-label="Code Diff representation"]', { timeout: uiTimeout });
        } else if (shot.expectedMode === 'semantic') {
            await page.waitForSelector('[aria-label="Semantic Diff representation"]', { timeout: uiTimeout });
        }

        await assertVariant(page, shot.variant);
        await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
        });
        await page.mouse.move(1599, 899);

        const path = resolve(outputDirectory, shot.name);
        let dimensions;
        let semanticDensity;
        if (shot.closeup) {
            const widget = await page.$('.poiesis-changes');
            const bounds = await widget?.boundingBox();
            if (!bounds) {
                throw new Error('Semantic Changes widget bounds were not available');
            }
            const clip = {
                x: Math.max(0, Math.floor(bounds.x - 8)),
                y: Math.max(0, Math.floor(bounds.y - 32)),
                width: Math.min(1600, Math.ceil(bounds.width + 16)),
                height: Math.min(900, Math.ceil(bounds.height + 40))
            };
            if (clip.x + clip.width > 1600) {
                clip.width = 1600 - clip.x;
            }
            if (clip.y + clip.height > 900) {
                clip.height = 900 - clip.y;
            }
            await page.screenshot({ path, type: 'png', clip, captureBeyondViewport: false });
            dimensions = { width: clip.width, height: clip.height };
            semanticDensity = await page.$eval('.poiesis-changes__content', element => ({
                clientHeight: element.clientHeight,
                scrollHeight: element.scrollHeight,
                visibleRatio: Number((element.clientHeight / element.scrollHeight).toFixed(2))
            }));
        } else {
            await page.screenshot({ path, type: 'png', fullPage: false, captureBeyondViewport: false });
            dimensions = { width: 1600, height: 900 };
        }

        results.push({
            file: shot.name,
            variant: shot.variant,
            dimensions,
            semanticDensity,
            theme: await page.evaluate(() => document.documentElement.dataset.poiesisDesignTheme)
        });
        await page.close();
    }
} finally {
    await browser.close();
}

console.log(JSON.stringify({ executablePath, outputDirectory, shots: results }, null, 2));

async function assertVariant(page, variant) {
    const assertion = await page.evaluate(current => ({
        current,
        agentInMain: [...document.querySelectorAll('.lm-TabBar.theia-app-main .lm-TabBar-tabLabel')]
            .some(label => label.textContent?.trim() === 'Agent Window'),
        agentVisible: Boolean(document.querySelector('.poiesis-agent-window')),
        changesInMain: [...document.querySelectorAll('.lm-TabBar.theia-app-main .lm-TabBar-tabLabel')]
            .some(label => label.textContent?.trim() === 'IDE Changes'),
        changesVisible: Boolean(document.querySelector('.poiesis-changes')),
        codeVisible: Boolean(document.querySelector('[aria-label="Code Diff representation"]')),
        semanticVisible: Boolean(document.querySelector('[aria-label="Semantic Diff representation"]')),
        tabLabels: [...document.querySelectorAll('.poiesis-changes__tabs button')].map(button => button.textContent?.trim()),
        fileCountVisible: Boolean(document.querySelector('.poiesis-agent-window__file-count')),
        unresolvedVisible: Boolean(document.querySelector('.poiesis-agent-window__unresolved')),
        statusText: document.querySelector('#status-bar-poiesis-changes')?.textContent?.trim(),
        toastVisible: Boolean(document.querySelector('.theia-notification-toasts.open .theia-notification-list-item')),
        contextQuestionVisible: Boolean(document.querySelector('.poiesis-agent-window__question--context')),
        inlineQuestionVisible: Boolean(document.querySelector('.poiesis-agent-window__question--inline'))
    }), variant);

    const failures = [];
    if (!assertion.agentVisible) failures.push('Agent Window is missing');
    if (variant === 'd1-a' && assertion.agentInMain) failures.push('D1-A Agent Window is in main area');
    if (variant === 'd1-b' && !assertion.agentInMain) failures.push('D1-B Agent Window is not in main area');
    if (variant === 'd2-a' && assertion.changesInMain) failures.push('D2-A Changes is in main area');
    if (variant === 'd2-b' && !assertion.changesInMain) failures.push('D2-B Changes is not in main area');
    if (variant === 'd3-a' && !assertion.tabLabels.includes('並列表示')) failures.push('D3-A parallel action is missing');
    if (variant === 'd3-b' && !assertion.tabLabels.includes('Parallel')) failures.push('D3-B Parallel mode is missing');
    if (variant === 'd4-a' && !assertion.unresolvedVisible) failures.push('D4-A unresolved summary is missing');
    if (variant === 'd4-b' && !assertion.fileCountVisible) failures.push('D4-B file count is missing');
    if (variant === 'd5-a' && !assertion.statusText?.includes('Changes: 1')) failures.push('D5-A status count is missing');
    if (variant === 'd5-b' && !assertion.toastVisible) failures.push('D5-B toast is missing');
    if (variant === 'd6-a' && !assertion.contextQuestionVisible) failures.push('D6-A context chip is missing');
    if (variant === 'd6-b' && !assertion.inlineQuestionVisible) failures.push('D6-B inline question is missing');
    if (variant === 'd7-a' && !assertion.codeVisible) failures.push('D7-A Code Diff is not initially visible');
    if (variant === 'd7-b' && !assertion.semanticVisible) failures.push('D7-B Semantic Diff is not initially visible');
    if (variant === 'semantic-card-closeup' && !assertion.semanticVisible) failures.push('Semantic closeup is not visible');

    if (failures.length > 0) {
        throw new Error(`${variant} verification failed: ${failures.join('; ')}; ${JSON.stringify(assertion)}`);
    }
}
