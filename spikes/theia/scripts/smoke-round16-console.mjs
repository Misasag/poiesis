import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 360_000);
const uiUrl = process.env.THEIA_SMOKE_UI_URL ?? 'http://127.0.0.1:3000';
const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const runDirectory = resolve(process.cwd(), '.run', `round16-console-${Date.now()}`);
const profile = resolve(runDirectory, 'browser-profile');
const watcherScript = resolve(process.cwd(), 'scripts', 'watch-visible-console-windows.ps1');
const providerSettings = [
    { id: 'codex', model: 'gpt-5.6-luna' },
    { id: 'claude', model: 'haiku' },
    { id: 'grok', model: '' }
];
mkdirSync(runDirectory, { recursive: true });

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

    const results = [];
    for (const provider of providerSettings) {
        const watcher = await startWatcher(provider.id);
        try {
            await selectRoleProvider(page, 'agent', provider.id, provider.model);
            await selectRoleProvider(page, 'results', provider.id, provider.model);
            await closeSettings(page);
            await clickText(page, '.poiesis-agent-window__rail-action', 'New Chat');
            const prompt = `ファイルを変更せず、追加のコマンドも実行せず、「${provider.id} の非表示起動確認が完了しました」と短く返してください。`;
            const agent = await runAgentTask(page, prompt);
            await clickText(page, '.poiesis-agent-window__tabs button', 'Results');
            await page.waitForSelector('.poiesis-results__document');
            await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
            const observations = await watcher.stop();
            assert(observations.length === 0,
                `${provider.id} exposed console windows: ${JSON.stringify(observations)}`);
            results.push({
                provider: provider.id,
                model: provider.model || 'CLI default',
                pollMilliseconds: 100,
                visibleConsoleWindows: observations.length,
                finalMessage: agent.lastMessage
            });
        } catch (error) {
            const observations = await watcher.stop();
            throw new Error(`${provider.id} watcher run failed with ${observations.length} visible console window(s): ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    console.log(`ROUND16_CONSOLE_SMOKE_RESULT=${JSON.stringify(results, null, 2)}`);
} finally {
    if (browser) await browser.close().catch(() => undefined);
    rmSync(runDirectory, { recursive: true, force: true });
}

async function startWatcher(providerId) {
    const outputPath = resolve(runDirectory, `${providerId}-windows.jsonl`);
    const stopPath = resolve(runDirectory, `${providerId}-watcher.stop`);
    const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', watcherScript,
        '-OutputPath', outputPath,
        '-StopPath', stopPath,
        '-PollMilliseconds', '100'
    ], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let stopped = false;
    child.stdout.on('data', chunk => output += chunk.toString());
    child.stderr.on('data', chunk => output += chunk.toString());
    await waitUntil(() => output.includes('ROUND16_WATCHER_READY'), 30_000,
        () => `Watcher failed to start for ${providerId}: ${output}`);
    return {
        async stop() {
            if (!stopped) {
                stopped = true;
                writeFileSync(stopPath, 'stop', 'utf8');
                await waitUntil(() => child.exitCode !== null, 10_000,
                    () => `Watcher did not stop for ${providerId}: ${output}`).catch(() => child.kill());
            }
            if (!existsSync(outputPath)) return [];
            return readFileSync(outputPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        }
    };
}

async function selectRoleProvider(page, role, providerId, modelId) {
    if (!await page.$('.poiesis-settings-modal')) {
        await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
        await page.waitForSelector('.poiesis-settings-modal');
    }
    const radio = `input[name="poiesis-${role}-cli"][value="${providerId}"]`;
    await page.waitForFunction(selector => !document.querySelector(selector)?.disabled, {}, radio);
    await page.$eval(radio, input => input.click());
    await page.waitForFunction(selector => document.querySelector(selector)?.checked, {}, radio);
    const modelSelector = `[aria-label="${role === 'agent' ? 'Agent' : 'Results'} の AI モデル"]`;
    await page.click(modelSelector);
    await page.waitForSelector('.poiesis-select__listbox');
    await page.$eval(`.poiesis-select__option[data-value="${modelId}"]`, option => option.click());
    await page.waitForFunction((selector, expected) => document.querySelector(selector)?.dataset.value === expected,
        {}, modelSelector, modelId);
}

async function closeSettings(page) {
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
        error: document.querySelector('.poiesis-agent-window__message-error strong')?.textContent?.trim()
    }));
    assert(!state.error, `Agent task failed: ${state.error}`);
    return state;
}

async function waitForApp(page) {
    await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector('.poiesis-agent-window__rail');
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

async function waitUntil(predicate, waitTimeout, errorMessage) {
    const deadline = Date.now() + waitTimeout;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
    }
    throw new Error(errorMessage());
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
