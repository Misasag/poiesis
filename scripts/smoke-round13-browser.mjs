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

const repositoryRoot = process.cwd();
const existingDirectory = resolve(repositoryRoot, '.poiesis', 'skills', 'round13-existing-smoke');
const existingPath = resolve(existingDirectory, 'skill.md');
const createdDirectory = resolve(repositoryRoot, '.poiesis', 'skills', 'round13-created-smoke');
const createdPath = resolve(createdDirectory, 'SKILL.md');
const existingContent = '---\nname: Round 13 existing\ndescription: Inline editor smoke fixture\nkind: agent\n---\n\n# Round 13 existing\n';
for (const directory of [existingDirectory, createdDirectory]) {
    if (existsSync(directory)) throw new Error(`Smoke fixture already exists: ${directory}`);
}
mkdirSync(existingDirectory, { recursive: true });
writeFileSync(existingPath, existingContent, 'utf8');

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
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-customize-view__skill-row')]
        .some(row => row.textContent?.includes('Round 13 existing')));
    const inlineView = await page.evaluate(() => ({
        mode: document.querySelector('.poiesis-agent-window__content')?.dataset.mode,
        rail: Boolean(document.querySelector('.poiesis-agent-window__rail')),
        modal: Boolean(document.querySelector('.poiesis-customize-modal, .poiesis-customize-modal__backdrop')),
        active: document.querySelector('.poiesis-agent-window__rail-action[title="カスタマイズ"]')?.getAttribute('aria-current')
    }));
    assert(inlineView.mode === 'customize' && inlineView.rail && !inlineView.modal && inlineView.active === 'page',
        `Customize is not an active central view: ${JSON.stringify(inlineView)}`);

    await page.click('.poiesis-customize-view__generation-details > summary');
    const generationDisclosure = await page.$eval('.poiesis-customize-view__generation-details', element => ({
        text: element.textContent ?? '',
        meters: [...element.querySelectorAll('meter')].map(meter => ({ value: meter.value, max: meter.max }))
    }));
    assert(generationDisclosure.text.includes('AI Results')
        && generationDisclosure.text.includes('Bundled Results')
        && generationDisclosure.text.includes('自動的に使われる処理です。')
        && generationDisclosure.meters.length === 2
        && generationDisclosure.meters.every(meter => meter.max === 24_000),
    `Generation disclosure did not preserve built-in explanations and prompt meters: ${JSON.stringify(generationDisclosure)}`);

    await clickCard(page, 'Round 13 existing');
    await page.waitForSelector('.poiesis-customize-view__monaco .monaco-editor');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view__monaco .view-lines')
        ?.textContent?.replace(/\u00a0/g, ' ').includes('Round 13 existing'));

    // Keep Code's model reference alive while Customize opens and later discards the same URI.
    await page.click('.poiesis-customize-view__code-link');
    await page.waitForSelector('.poiesis-agent-window__code-editor-host .monaco-editor');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')
        ?.textContent?.trim().toLocaleLowerCase() === 'skill.md');
    await page.click('.poiesis-agent-window__code-control');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__code'));
    await page.click('.poiesis-agent-window__rail-action[title="カスタマイズ"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-customize-view__skill-row')]
        .some(row => row.textContent?.includes('Round 13 existing')));
    await clickCard(page, 'Round 13 existing');
    await page.waitForSelector('.poiesis-customize-view__monaco .monaco-editor');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view__monaco .view-lines')
        ?.textContent?.replace(/\u00a0/g, ' ').includes('Round 13 existing'));

    const cleanExternalContent = `${existingContent}\nClean external Round 13 update.\n`;
    writeFileSync(existingPath, cleanExternalContent, 'utf8');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view__monaco .view-lines')
        ?.textContent?.replace(/\u00a0/g, ' ').includes('Clean external Round 13 update.'));
    const monacoInstanceStable = await page.$eval('.poiesis-customize-view__monaco .monaco-editor', element => {
        element.dataset.round13Instance = 'existing';
        return document.querySelectorAll('.poiesis-customize-view__monaco .monaco-editor').length === 1;
    });
    assert(monacoInstanceStable, 'Customize created more than one Monaco editor for a Skill URI.');
    await page.click('.poiesis-customize-view__monaco .monaco-editor');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await page.keyboard.type('\nunsaved-round13');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view__save-status.active')?.textContent?.includes('未保存'));
    const dirtyExternalContent = `${cleanExternalContent}\nDirty external Round 13 update.\n`;
    writeFileSync(existingPath, dirtyExternalContent, 'utf8');
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
    const dirtyExternalState = await page.$eval('.poiesis-customize-view__monaco .view-lines', element =>
        (element.textContent ?? '').replace(/\u00a0/g, ' '));
    assert(dirtyExternalState.includes('unsaved-round13') && !dirtyExternalState.includes('Dirty external Round 13 update.'),
        'An external reload overwrote the dirty inline editor.');
    assert(await page.$eval('.poiesis-customize-view__monaco .monaco-editor', element => element.dataset.round13Instance === 'existing'),
        'React update replaced the inline Monaco DOM while editing.');
    await page.click('[aria-label="Skills一覧に戻る"]');
    await page.waitForSelector('.poiesis-customize-view__discard-confirm');
    await clickByText(page, '.poiesis-customize-view__discard-confirm button', '編集を続ける');
    assert(await page.$('.poiesis-customize-view__monaco .monaco-editor'), 'Continue editing closed the editor.');
    await page.click('[aria-label="Skills一覧に戻る"]');
    await clickByText(page, '.poiesis-customize-view__discard-confirm button', '破棄して閉じる');
    await page.waitForFunction(() => !document.querySelector('.poiesis-customize-view__detail'));
    assert(!await page.$('.poiesis-customize-view__monaco .monaco-editor'), 'Discard did not dispose the inline Monaco editor.');
    assert(!readFileSync(existingPath, 'utf8').includes('unsaved-round13'), 'Discard wrote the unsaved change to disk.');

    await clickCard(page, 'Round 13 existing');
    await page.waitForSelector('.poiesis-customize-view__monaco .monaco-editor');
    await page.waitForFunction(() => {
        const text = document.querySelector('.poiesis-customize-view__monaco .view-lines')?.textContent?.replace(/\u00a0/g, ' ') ?? '';
        return text.includes('Dirty external Round 13 update.') && !text.includes('unsaved-round13');
    });
    await page.click('.poiesis-customize-view__code-link');
    await page.waitForSelector('.poiesis-agent-window__code-editor-host .monaco-editor');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')
        ?.textContent?.trim().toLocaleLowerCase() === 'skill.md');
    const codeContentAfterDiscard = await page.$eval('.poiesis-agent-window__code-editor-host .view-lines', element =>
        (element.textContent ?? '').replace(/\u00a0/g, ' '));
    assert(codeContentAfterDiscard.includes('Dirty external Round 13 update.') && !codeContentAfterDiscard.includes('unsaved-round13'),
        'Code retained discarded inline Monaco content through a surviving model reference.');
    await page.click('.poiesis-agent-window__code-control');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__code'));
    await page.click('.poiesis-agent-window__rail-action[title="カスタマイズ"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-customize-view__skill-row')]
        .some(row => row.textContent?.includes('Round 13 existing')));

    await page.setViewport({ width: 1024, height: 600, deviceScaleFactor: 1 });
    await clickByText(page, '.poiesis-customize-view__primary-action', '新しいSkill');
    await page.type('[aria-label="新しいSkillの名前"]', 'round13-created-smoke');
    await page.focus('[aria-label="新しいSkillの役割"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.poiesis-select__listbox');
    const customizePopover = await bounds(page, '.poiesis-select__listbox');
    assertUnclipped(customizePopover, 1024, 600, 'Customize dropdown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[aria-label="新しいSkillの役割"]')?.dataset.value === 'results');
    await page.waitForFunction(() => document.querySelector('[aria-label="新しいSkillの役割"]') === document.activeElement);
    await clickByText(page, '.poiesis-customize-view__new-skill button', '作成して編集');
    await page.waitForSelector('.poiesis-customize-view__monaco .monaco-editor');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view__detail-heading > strong')?.textContent?.includes('round13-created-smoke'));
    assert(existsSync(createdPath) && readFileSync(createdPath, 'utf8').includes('kind: results'),
        'New Skill did not scaffold a results SKILL.md.');
    await page.click('.poiesis-customize-view__monaco .monaco-editor');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await page.keyboard.type('\nSaved inline by Round 13.\n');
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view__save-status:not(.active)')?.textContent?.includes('保存済み'));
    assert(readFileSync(createdPath, 'utf8').includes('Saved inline by Round 13.'), 'Ctrl+S did not persist SKILL.md.');

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
    const railCollapsed = await page.$eval('.poiesis-agent-window__rail', element => element.getAttribute('data-collapsed') === 'true');
    if (!railCollapsed) await page.click('.poiesis-agent-window__rail-toggle');
    await page.waitForSelector('.poiesis-agent-window__rail[data-collapsed="true"]');
    await page.click('.poiesis-agent-window__rail-action[title="カスタマイズ"]');
    await page.waitForSelector('.poiesis-customize-view');
    await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal');
    assert(!(await page.$eval('.poiesis-settings-modal', element => element.textContent ?? '')).includes('Skills'),
        'Settings still includes the Skills section.');
    await clickByText(page, '.poiesis-settings-modal__nav button', 'AI');
    await page.waitForFunction(() => {
        const trigger = document.querySelector('.poiesis-settings-modal .poiesis-model-picker__trigger');
        return trigger && !trigger.getAttribute('title')?.includes('確認中');
    });
    const modelTrigger = await page.waitForSelector('.poiesis-settings-modal .poiesis-model-picker__trigger:not(:disabled)');
    await modelTrigger.click();
    await page.waitForSelector('.poiesis-model-picker__popover');
    const settingsPopover = await bounds(page, '.poiesis-model-picker__popover');
    assertUnclipped(settingsPopover, 1024, 600, 'Settings dropdown');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.poiesis-model-picker__popover'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal'));
    assert(await page.$eval('body', () => document.querySelectorAll('select').length === 0), 'A native select remains in the rendered app.');

    await page.click('.poiesis-agent-window__code-control');
    await page.waitForSelector('.poiesis-agent-window__code');
    await page.setViewport({ width: 1500, height: 850, deviceScaleFactor: 1 });
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__content')?.getBoundingClientRect().width === innerWidth);
    assert(await page.$eval('body', () => document.querySelectorAll('select').length === 0), 'A native select remains in Code.');

    console.log(`ROUND13_BROWSER_SMOKE_RESULT=${JSON.stringify({
        inlineView,
        generationDisclosure,
        customizePopover,
        settingsPopover,
        customizeLayout,
        inlineSave: true,
        inlineDiscard: true,
        monacoLifecycle: true,
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
        const row = [...document.querySelectorAll('.poiesis-customize-view__skill-row, .poiesis-customize-view__proposal-row')]
            .find(candidate => candidate.textContent?.includes(label));
        const target = row?.querySelector('.poiesis-customize-view__row-target');
        if (!(target instanceof HTMLElement)) throw new Error(`Skill row not found: ${label}`);
        target.click();
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
