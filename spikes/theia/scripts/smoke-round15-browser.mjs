import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 300_000);
const uiUrl = process.env.THEIA_SMOKE_UI_URL ?? 'http://127.0.0.1:3000';
const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const root = resolve(process.cwd(), '..', '..');
const skillsRoot = resolve(root, '.poiesis', 'skills');
const agentSkillDirectory = resolve(skillsRoot, 'round15-agent-test');
const resultsSkillDirectory = resolve(skillsRoot, 'round15-results-test');
const invalidSkillDirectory = resolve(skillsRoot, 'round15-invalid-test');
const profile = resolve(process.cwd(), '.run', `round15-${Date.now()}`);
for (const directory of [agentSkillDirectory, resultsSkillDirectory, invalidSkillDirectory]) {
    if (existsSync(directory)) throw new Error(`Round 15 fixture already exists: ${directory}`);
}
mkdirSync(agentSkillDirectory, { recursive: true });
mkdirSync(resultsSkillDirectory, { recursive: true });
mkdirSync(invalidSkillDirectory, { recursive: true });
writeFileSync(resolve(agentSkillDirectory, 'skill.md'), `---
name: Round 15 Agent marker
description: 実行promptへの反映を検証します
kind: agent
---

作業完了後に返す最終回答の冒頭には、必ず文字列 \`[SKILL-OK]\` を付けてください。
`, 'utf8');
writeFileSync(resolve(resultsSkillDirectory, 'skill.md'), `---
name: Round 15 Results headings
description: Results生成guidanceへの反映を検証します
kind: results
---

成果文書に含めるすべての見出しテキストを、必ず「◇」から開始してください。少なくとも最上位のh1見出しへ反映してください。
`, 'utf8');
writeFileSync(resolve(invalidSkillDirectory, 'skill.md'), 'frontmatterのない検証用Skillです。\n', 'utf8');

let browser;
try {
    browser = await puppeteer.launch({
        executablePath,
        headless: true,
        userDataDir: profile,
        protocolTimeout: timeout,
        defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        args: ['--disable-gpu', '--no-sandbox', '--no-first-run']
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);
    await selectFastRealProviders(page);

    await page.click('.poiesis-agent-window__rail-action[title="Customize"]');
    await page.waitForSelector('.poiesis-customize-view');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view')?.textContent?.includes('Round 15 Agent marker'));
    const customize = await page.evaluate(() => ({
        copy: document.querySelector('.poiesis-customize-view__section-copy')?.textContent?.trim(),
        invalidError: [...document.querySelectorAll('.poiesis-customize-view__skill-row')]
            .find(row => row.textContent?.includes('round15-invalid-test'))?.textContent?.includes('frontmatterがありません。'),
        switches: [...document.querySelectorAll('.poiesis-customize-view__skill-row')]
            .filter(row => row.textContent?.includes('Round 15'))
            .map(row => ({ label: row.textContent?.trim(), checked: row.querySelector('input[type="checkbox"]')?.checked }))
    }));
    assert(customize.copy?.includes('次のTaskから実装指示へ加わり'), 'Customize copy does not describe live Agent Skill behavior.');
    assert(customize.copy?.includes('fallback時はResults Skillの追加指示を使いません'), 'Template fallback boundary is not disclosed.');
    assert(customize.invalidError, 'Invalid skill.md did not show a row error.');
    assert(customize.switches.length === 2 && customize.switches.every(item => item.checked),
        `New skills were not enabled by default: ${JSON.stringify(customize.switches)}`);

    await clickText(page, '.poiesis-agent-window__rail-action', 'New Chat');
    const enabledRun = await runAgentTask(page, 'ファイルを変更せず、README.mdが存在するかだけを確認し、短い完了メッセージを返してください。');
    assert(enabledRun.lastMessage.startsWith('[SKILL-OK]'), `Enabled Agent Skill was not applied: ${enabledRun.lastMessage}`);

    await clickText(page, '.poiesis-agent-window__tabs button', 'Results');
    await page.waitForSelector('.poiesis-results__document');
    const resultsHeading = await waitForResultsHeading(page);
    assert(resultsHeading.startsWith('◇'), `Results Skill guidance was not applied to the h1: ${resultsHeading}`);

    await page.click('.poiesis-agent-window__rail-action[title="Customize"]');
    await page.waitForSelector('.poiesis-customize-view');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view')?.textContent?.includes('Round 15 Agent marker'));
    await setSkillEnabled(page, 'Round 15 Agent marker', false);
    const persistedEnablement = await page.evaluate(() => JSON.parse(
        localStorage.getItem('poiesis:global:poiesis.workspace-skills.enablement.v1') ?? '{}'
    ));
    const disabledEntry = Object.entries(persistedEnablement).find(([uri]) => uri.includes('round15-agent-test'));
    assert(disabledEntry?.[1] === false, `Disabled state was not persisted globally: ${JSON.stringify(persistedEnablement)}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.click('.poiesis-agent-window__rail-action[title="Customize"]');
    await page.waitForSelector('.poiesis-customize-view');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view')?.textContent?.includes('Round 15 Agent marker'));
    const restoredDisabled = await skillChecked(page, 'Round 15 Agent marker');
    assert(restoredDisabled === false, 'Agent Skill disabled state did not survive reload.');

    await clickText(page, '.poiesis-agent-window__rail-action', 'New Chat');
    const disabledRun = await runAgentTask(page, 'ファイルを変更せず、README.mdが存在するかだけを確認し、短い完了メッセージを返してください。');
    assert(!disabledRun.lastMessage.startsWith('[SKILL-OK]'), `Disabled Agent Skill still affected execution: ${disabledRun.lastMessage}`);

    await page.setViewport({ width: 1024, height: 600, deviceScaleFactor: 1 });
    await page.click('.poiesis-agent-window__rail-action[title="Customize"]');
    await page.waitForSelector('.poiesis-customize-view');
    const layout = await page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth;
        const clipped = [...document.querySelectorAll('.poiesis-agent-window__rail, .poiesis-customize-view, .poiesis-customize-view__skill-row')]
            .map(element => ({ className: element.className, rect: element.getBoundingClientRect().toJSON() }))
            .filter(item => item.rect.left < -0.5 || item.rect.right > viewportWidth + 0.5);
        return { viewportWidth, clipped };
    });
    assert(layout.clipped.length === 0, `Round 15 Customize layout clipped at 1024px: ${JSON.stringify(layout.clipped)}`);

    console.log(`ROUND15_BROWSER_SMOKE_RESULT=${JSON.stringify({
        customize,
        enabledRun,
        resultsHeading,
        persistedDisabled: disabledEntry?.[1],
        restoredDisabled,
        disabledRun,
        layout
    })}`);
} finally {
    if (browser) await browser.close().catch(() => undefined);
    for (const directory of [agentSkillDirectory, resultsSkillDirectory, invalidSkillDirectory]) {
        rmSync(directory, { recursive: true, force: true });
    }
    rmSync(profile, { recursive: true, force: true });
}

async function waitForApp(page) {
    await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector('.poiesis-agent-window__rail');
}

async function selectFastRealProviders(page) {
    await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal');
    for (const [role, provider, modelId] of [['agent', 'claude', 'haiku'], ['results', 'codex', '']]) {
        const radio = `input[name="poiesis-${role}-cli"][value="${provider}"]`;
        await page.waitForFunction(selector => !document.querySelector(selector)?.disabled, {}, radio);
        await page.$eval(radio, input => input.click());
        await page.waitForFunction(selector => document.querySelector(selector)?.checked, {}, radio);
        const model = `[aria-label="${role === 'agent' ? 'Agent' : 'Results'} の AI モデル"]`;
        await page.click(model);
        await page.waitForSelector('.poiesis-select__listbox');
        await page.$eval(`.poiesis-select__option[data-value="${modelId}"]`, option => option.click());
        await page.waitForFunction((selector, expected) => document.querySelector(selector)?.dataset.value === expected, {}, model, modelId);
    }
    await page.click('.poiesis-settings-modal__header button[aria-label="設定を閉じる"]');
    await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal'));
}

async function runAgentTask(page, prompt) {
    await page.waitForSelector('[aria-label="Agent へのメッセージ"]');
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.type(prompt, { delay: 1 });
    await page.waitForFunction(() => !document.querySelector('[aria-label="Agent へ送信"]')?.disabled);
    await page.click('[aria-label="Agent へ送信"]');
    await page.waitForSelector('.poiesis-agent-window__task-state');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__task-state'));
    const state = await page.evaluate(() => ({
        lastMessage: [...document.querySelectorAll('[aria-label="Agent のメッセージ"]')].at(-1)?.textContent?.trim() ?? '',
        error: document.querySelector('.poiesis-agent-window__message-error strong')?.textContent?.trim(),
        taskCount: document.querySelectorAll('[aria-label="Agent のメッセージ"]').length
    }));
    assert(!state.error, `Agent task failed: ${state.error}`);
    return state;
}

async function waitForResultsHeading(page) {
    await page.waitForFunction(() => document.querySelector('.poiesis-results__document')?.getAttribute('srcdoc')?.includes('<html'));
    const frame = page.frames().find(candidate => candidate !== page.mainFrame() && candidate.url() === 'about:srcdoc');
    if (!frame) throw new Error('Results iframe was not attached.');
    await frame.waitForSelector('h1');
    return frame.$eval('h1', element => element.textContent?.trim() ?? '');
}

async function setSkillEnabled(page, name, enabled) {
    const changed = await page.evaluate(({ name, enabled }) => {
        const row = [...document.querySelectorAll('.poiesis-customize-view__skill-row')]
            .find(candidate => candidate.textContent?.includes(name));
        const input = row?.querySelector('input[type="checkbox"]');
        if (!(input instanceof HTMLInputElement)) return false;
        if (input.checked !== enabled) input.click();
        return true;
    }, { name, enabled });
    assert(changed, `Skill switch was not found: ${name}`);
    await page.waitForFunction(({ name, enabled }) => {
        const row = [...document.querySelectorAll('.poiesis-customize-view__skill-row')]
            .find(candidate => candidate.textContent?.includes(name));
        return row?.querySelector('input[type="checkbox"]')?.checked === enabled;
    }, {}, { name, enabled });
}

async function skillChecked(page, name) {
    return page.evaluate(skillName => {
        const row = [...document.querySelectorAll('.poiesis-customize-view__skill-row')]
            .find(candidate => candidate.textContent?.includes(skillName));
        return row?.querySelector('input[type="checkbox"]')?.checked;
    }, name);
}

async function clickText(page, selector, text) {
    const clicked = await page.evaluate(({ selector, text }) => {
        const node = [...document.querySelectorAll(selector)].find(candidate => candidate.textContent?.trim() === text);
        if (!(node instanceof HTMLElement)) return false;
        node.click();
        return true;
    }, { selector, text });
    assert(clicked, `${text} was not found.`);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
