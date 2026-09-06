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
    const trigger = '[data-ai-role="agent"] [aria-label="Agent のモデル"]';
    await page.waitForSelector(trigger);
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('未検出'), {}, trigger);
    await page.click(trigger);
    await page.waitForSelector('.poiesis-settings-modal');
    const warning = await page.evaluate(selector => {
        const pill = document.querySelector('[data-ai-role="agent"]');
        const control = document.querySelector(selector);
        const settings = document.querySelector('.poiesis-settings-modal');
        if (!(pill instanceof HTMLElement) || !(control instanceof HTMLElement) || !(settings instanceof HTMLElement)) {
            throw new Error('Agent AI settings route did not render.');
        }
        const bounds = settings.getBoundingClientRect();
        return {
            text: control.textContent?.trim(),
            warning: pill.classList.contains('warning'),
            disabledProviders: [...settings.querySelectorAll('.poiesis-settings-modal__cli-row input')]
                .filter(input => input.disabled).length,
            enabledProviders: [...settings.querySelectorAll('.poiesis-settings-modal__cli-row input')]
                .filter(input => !input.disabled).length,
            actionableCopy: settings.textContent?.includes('CLIを準備してログイン後、AI情報を更新してください。'),
            pickerOpen: Boolean(document.querySelector('.poiesis-model-picker__popover')),
            bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
            viewport: { width: innerWidth, height: innerHeight }
        };
    }, trigger);
    assert(warning.warning && warning.text?.includes('未検出'), `Missing CLI warning is not honest: ${JSON.stringify(warning)}`);
    assert(warning.disabledProviders === 8 && warning.enabledProviders === 0 && warning.actionableCopy,
        `Missing CLIs became actionable: ${JSON.stringify(warning)}`);
    assert(!warning.pickerOpen, `An unavailable provider opened an empty model picker: ${JSON.stringify(warning)}`);
    assert(warning.bounds.left >= 0 && warning.bounds.top >= 0
        && warning.bounds.right <= warning.viewport.width && warning.bounds.bottom <= warning.viewport.height,
    `AI Settings route clipped at 1024x600: ${JSON.stringify(warning)}`);
    console.log(`ROUND20_WARNING_SMOKE_RESULT=${JSON.stringify(warning, null, 2)}`);
} finally {
    await browser.close();
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
