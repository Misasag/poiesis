import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const url = process.env.THEIA_SMOKE_UI_URL ?? 'http://127.0.0.1:3000';
const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: resolve(process.cwd(), '.run', `round20-${Date.now()}`),
    defaultViewport: { width: 1024, height: 600, deviceScaleFactor: 1 },
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run']
});

try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const trigger = '[data-ai-role="agent"] [aria-label="Agent の AI とモデル"]';
    await page.waitForSelector(`${trigger}:not([data-value=""])`);
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('未検出'), {}, trigger);
    await page.click(trigger);
    await page.waitForSelector('.poiesis-ai-role-pill__popover');
    const warning = await page.evaluate(selector => {
        const pill = document.querySelector('[data-ai-role="agent"]');
        const control = document.querySelector(selector);
        const popover = document.querySelector('.poiesis-ai-role-pill__popover');
        if (!(pill instanceof HTMLElement) || !(control instanceof HTMLElement) || !(popover instanceof HTMLElement)) {
            throw new Error('Agent AI warning pill did not render.');
        }
        const bounds = popover.getBoundingClientRect();
        return {
            text: control.textContent?.trim(),
            warning: pill.classList.contains('warning'),
            disabledOptions: [...popover.querySelectorAll('[role="option"]')]
                .filter(option => option.getAttribute('aria-disabled') === 'true').length,
            enabledOptions: [...popover.querySelectorAll('[role="option"]')]
                .filter(option => option.getAttribute('aria-disabled') !== 'true').length,
            groups: [...popover.querySelectorAll('.poiesis-select__group')].map(group => group.textContent?.trim()),
            bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
            viewport: { width: innerWidth, height: innerHeight }
        };
    }, trigger);
    assert(warning.warning && warning.text?.includes('未検出'), `Missing CLI warning is not honest: ${JSON.stringify(warning)}`);
    assert(warning.disabledOptions === 4 && warning.enabledOptions === 0,
        `Missing CLIs became actionable: ${JSON.stringify(warning)}`);
    assert(warning.bounds.left >= 0 && warning.bounds.top >= 0
        && warning.bounds.right <= warning.viewport.width && warning.bounds.bottom <= warning.viewport.height,
    `Warning popover clipped at 1024x600: ${JSON.stringify(warning)}`);
    console.log(`ROUND20_WARNING_SMOKE_RESULT=${JSON.stringify(warning, null, 2)}`);
} finally {
    await browser.close();
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
