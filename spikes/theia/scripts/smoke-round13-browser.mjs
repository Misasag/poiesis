import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const repositoryRoot = resolve(process.cwd(), '..', '..');
const existingDirectory = resolve(repositoryRoot, '.poiesis', 'skills', 'round13-existing-smoke');
const existingPath = resolve(existingDirectory, 'skill.md');
const createdDirectory = resolve(repositoryRoot, '.poiesis', 'skills', 'round13-created-smoke');
const createdPath = resolve(createdDirectory, 'skill.md');
for (const directory of [existingDirectory, createdDirectory]) {
    if (existsSync(directory)) throw new Error(`Smoke fixture already exists: ${directory}`);
}
mkdirSync(existingDirectory, { recursive: true });
writeFileSync(existingPath, '---\nname: Round 13 existing\ndescription: Inline editor smoke fixture\nkind: agent\n---\n\n# Round 13 existing\n', 'utf8');

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
    await page.waitForSelector('.poiesis-agent-window__rail-action[title="カスタマイズ"]');
    const previousMode = await page.$eval('.poiesis-agent-window__content', element => element.dataset.mode);
    await page.click('.poiesis-agent-window__rail-action[title="カスタマイズ"]');
    await page.waitForSelector('.poiesis-customize-view');
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-customize-view__skill-card')]
        .some(card => card.textContent?.includes('Round 13 existing')));
    const inlineView = await page.evaluate(() => ({
        mode: document.querySelector('.poiesis-agent-window__content')?.dataset.mode,
        rail: Boolean(document.querySelector('.poiesis-agent-window__rail')),
        modal: Boolean(document.querySelector('.poiesis-customize-modal, .poiesis-customize-modal__backdrop')),
        active: document.querySelector('.poiesis-agent-window__rail-action[title="カスタマイズ"]')?.getAttribute('aria-current')
    }));
    assert(inlineView.mode === 'customize' && inlineView.rail && !inlineView.modal && inlineView.active === 'page',
        `Customize is not an active central view: ${JSON.stringify(inlineView)}`);

    await clickCard(page, 'Bundled Results');
    await page.waitForSelector('.poiesis-customize-view__builtin-preview');
    assert((await page.$eval('.poiesis-customize-view__builtin-preview', element => element.textContent ?? '')).includes('読み取り専用'),
        'Built-in skill did not show a read-only preview.');

    await clickCard(page, 'Round 13 existing');
    await page.waitForSelector('.poiesis-customize-view__editor-input');
    assert((await page.$eval('.poiesis-customize-view__editor-input', element => element.value)).includes('# Round 13 existing'),
        'Existing skill content was not loaded into the inline editor.');
    await page.focus('.poiesis-customize-view__editor-input');
    await page.keyboard.press('End');
    await page.keyboard.type('\nunsaved-round13');
    await clickByText(page, '.poiesis-customize-view__editor footer button', '閉じる');
    await page.waitForSelector('.poiesis-customize-view__discard-confirm');
    await clickByText(page, '.poiesis-customize-view__discard-confirm button', '編集を続ける');
    assert(await page.$('.poiesis-customize-view__editor-input'), 'Continue editing closed the editor.');
    await clickByText(page, '.poiesis-customize-view__editor footer button', '閉じる');
    await clickByText(page, '.poiesis-customize-view__discard-confirm button', '破棄して閉じる');
    await page.waitForFunction(() => !document.querySelector('.poiesis-customize-view__editor'));
    assert(!readFileSync(existingPath, 'utf8').includes('unsaved-round13'), 'Discard wrote the unsaved change to disk.');

    await page.setViewport({ width: 1024, height: 600, deviceScaleFactor: 1 });
    await clickByText(page, '.poiesis-customize-view__text-button', '新しいSkill');
    await page.type('[aria-label="新しいSkill ID"]', 'round13-created-smoke');
    await page.focus('[aria-label="新しいSkillの種類"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.poiesis-select__listbox');
    const customizePopover = await bounds(page, '.poiesis-select__listbox');
    assertUnclipped(customizePopover, 1024, 600, 'Customize dropdown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[aria-label="新しいSkillの種類"]')?.dataset.value === 'results');
    await page.waitForFunction(() => document.querySelector('[aria-label="新しいSkillの種類"]') === document.activeElement);
    await clickByText(page, '.poiesis-customize-view__new-skill button', '作成して開く');
    await page.waitForSelector('.poiesis-customize-view__editor-input');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view__editor header small')?.textContent?.includes('round13-created-smoke'));
    assert(existsSync(createdPath) && readFileSync(createdPath, 'utf8').includes('kind: results'),
        'New Skill did not scaffold a results skill.md.');
    await page.$eval('.poiesis-customize-view__editor-input', element => {
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
    });
    await page.keyboard.type('\nSaved inline by Round 13.\n');
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view__dirty:not(.active)')?.textContent?.includes('保存済み'));
    assert(readFileSync(createdPath, 'utf8').includes('Saved inline by Round 13.'), 'Ctrl+S did not persist skill.md.');

    const customizeLayout = await page.evaluate(() => {
        const view = document.querySelector('.poiesis-customize-view')?.getBoundingClientRect();
        const rail = document.querySelector('.poiesis-agent-window__rail')?.getBoundingClientRect();
        return view && rail ? { view: compact(view), rail: compact(rail), mode: document.querySelector('.poiesis-agent-window__content')?.dataset.mode } : undefined;
        function compact(rect) { return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width }; }
    });
    assert(customizeLayout?.mode === 'customize' && customizeLayout.rail.width > 0
        && customizeLayout.view.left >= customizeLayout.rail.right
        && customizeLayout.view.right <= 1024 && customizeLayout.view.bottom <= 600,
    `Customize clipped at 1024x600: ${JSON.stringify(customizeLayout)}`);

    await page.click('.poiesis-agent-window__rail-action[title="カスタマイズ"]');
    await page.waitForFunction(mode => document.querySelector('.poiesis-agent-window__content')?.dataset.mode === mode, {}, previousMode);
    await page.click('.poiesis-agent-window__rail-toggle');
    await page.waitForSelector('.poiesis-agent-window__rail[data-collapsed="true"]');
    await page.click('.poiesis-agent-window__rail-action[title="カスタマイズ"]');
    await page.waitForSelector('.poiesis-customize-view');
    await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal');
    assert(!(await page.$eval('.poiesis-settings-modal', element => element.textContent ?? '')).includes('Skills'),
        'Settings still includes the Skills section.');
    const modelTrigger = await page.waitForSelector('.poiesis-settings-modal [role="combobox"]:not(:disabled)');
    await modelTrigger.click();
    await page.waitForSelector('.poiesis-select__listbox');
    const settingsPopover = await bounds(page, '.poiesis-select__listbox');
    assertUnclipped(settingsPopover, 1024, 600, 'Settings dropdown');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.poiesis-select__listbox'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal'));
    assert(await page.$eval('body', () => document.querySelectorAll('select').length === 0), 'A native select remains in the rendered app.');

    await page.click('.poiesis-agent-window__rail-action[title="カスタマイズ"]');
    await page.waitForSelector('.poiesis-customize-view');
    await clickByText(page, '.poiesis-agent-window__customize-header-actions button', 'Code');
    await page.waitForSelector('.poiesis-agent-window__code');
    await page.setViewport({ width: 1500, height: 850, deviceScaleFactor: 1 });
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__content')?.getBoundingClientRect().width === innerWidth);
    assert(await page.$eval('body', () => document.querySelectorAll('select').length === 0), 'A native select remains in Code.');

    console.log(`ROUND13_BROWSER_SMOKE_RESULT=${JSON.stringify({
        inlineView,
        customizePopover,
        settingsPopover,
        customizeLayout,
        inlineSave: true,
        inlineDiscard: true,
        nativeSelectCount: 0,
        codeMode: true
    })}`);
} finally {
    await browser.close();
    for (const directory of [existingDirectory, createdDirectory]) {
        if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
    }
}

async function clickCard(page, text) {
    await page.evaluate(label => {
        const card = [...document.querySelectorAll('.poiesis-customize-view__skill-card')]
            .find(candidate => candidate.textContent?.includes(label));
        if (!(card instanceof HTMLElement)) throw new Error(`Skill card not found: ${label}`);
        card.click();
    }, text);
}

async function clickByText(page, selector, text) {
    await page.evaluate(({ selector: currentSelector, text: currentText }) => {
        const target = [...document.querySelectorAll(currentSelector)]
            .find(candidate => candidate.textContent?.trim() === currentText);
        if (!(target instanceof HTMLElement)) throw new Error(`Control not found: ${currentText}`);
        target.click();
    }, { selector, text });
}

async function bounds(page, selector) {
    return page.$eval(selector, element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
}

function assertUnclipped(rect, width, height, label) {
    assert(rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height,
        `${label} clipped: ${JSON.stringify(rect)}`);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
