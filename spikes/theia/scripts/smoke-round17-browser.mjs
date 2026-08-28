import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 360_000);
const uiUrl = process.env.THEIA_SMOKE_UI_URL ?? 'http://127.0.0.1:3000';
const realAgent = process.env.POIESIS_ROUND17_REAL_AGENT === '1';
const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const profile = resolve(process.cwd(), '.run', `round17-${Date.now()}`);

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
    await selectProviders(page);

    const codexRolloutsBefore = codexRolloutFiles();
    const noChangeRun = await runAgentTask(page,
        '1+1の答えだけを短く返してください。ファイルは一切変更しないでください。');
    await clickText(page, '.poiesis-agent-window__tabs button', 'Results');
    await page.waitForSelector('.poiesis-results__state.no-change');
    await page.waitForFunction(() => document.querySelector('.poiesis-results__state.no-change')?.textContent
        ?.includes('このタスクにファイル変更はありません。会話の返答は Agent タブにあります。'));
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_500));
    const noChange = await page.evaluate(() => ({
        railText: document.querySelector('.poiesis-results__task-row.no-change small')?.textContent?.trim(),
        iframeCount: document.querySelectorAll('.poiesis-results__document').length,
        composerCount: document.querySelectorAll('.poiesis-results__composer').length,
        questionNote: document.querySelector('.poiesis-results__no-change-question-note')?.textContent?.trim(),
        documentState: document.querySelector('.poiesis-results__state.no-change')?.textContent?.trim()
    }));
    assert(noChange.railText?.includes('完了') && noChange.railText.includes('変更なし'),
        `No-change rail entry is not compact and honest: ${JSON.stringify(noChange)}`);
    assert(noChange.iframeCount === 0, 'A Results document was rendered for an empty Change Set.');
    assert(noChange.composerCount === 0, 'The Results composer remained visible for an empty Change Set.');
    assert(noChange.questionNote?.includes('成果文書があるタスク'), 'The no-change question boundary was not explained.');
    const codexRolloutsAfter = codexRolloutFiles();
    const newCodexRollouts = [...codexRolloutsAfter].filter(path => !codexRolloutsBefore.has(path));
    const expectedCodexRollouts = realAgent ? 1 : 0;
    assert(newCodexRollouts.length === expectedCodexRollouts,
        `Expected ${expectedCodexRollouts} Agent rollout(s) and no Results-AI rollout for the empty Change Set: ${JSON.stringify(newCodexRollouts)}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForSelector('.poiesis-results__state.no-change');
    const restoredNoChange = await page.evaluate(() => ({
        taskCount: document.querySelectorAll('.poiesis-results__task-row').length,
        iframeCount: document.querySelectorAll('.poiesis-results__document').length,
        state: document.querySelector('.poiesis-results__state.no-change')?.textContent?.trim()
    }));
    assert(restoredNoChange.taskCount === 1 && restoredNoChange.iframeCount === 0,
        `No-change metadata did not restore without HTML: ${JSON.stringify(restoredNoChange)}`);

    const seededDocument = await page.evaluate(() => {
        const storageKey = 'poiesis:global:poiesis.agent-window.sessions.global.v1';
        const state = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
        const session = state?.sessions?.find(candidate => candidate.id === state.selectedSessionId);
        if (!session) return false;
        const timestamp = new Date().toISOString();
        const taskId = 'round17-document-task';
        session.tasks = [...session.tasks ?? [], {
            id: taskId,
            sessionId: session.id,
            title: 'Round 17 file change verification',
            request: 'ROUND17-SMOKE.mdを更新する',
            status: 'completed',
            startedAt: timestamp,
            endedAt: timestamp,
            baseline: { kind: 'workspace-snapshot', capturedAt: timestamp },
            changeSet: {
                source: 'task-diff',
                diff: 'diff --git a/ROUND17-SMOKE.md b/ROUND17-SMOKE.md\n+Round 17 file change verification',
                files: ['ROUND17-SMOKE.md'],
                capturedAt: timestamp
            },
            resultsQuestions: [{
                question: '何を変更しましたか？',
                answer: 'ROUND17-SMOKE.mdを更新しました。',
                timestamp
            }]
        }];
        session.resultsDocuments = [...session.resultsDocuments ?? [], {
            taskId,
            status: 'ready',
            html: '<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><main><h1>Round 17 file change verification</h1><p>変更のあるタスクの成果文書です。</p></main></body></html>'
        }];
        session.selectedResultsTaskId = taskId;
        session.activeTab = 'results';
        localStorage.setItem(storageKey, JSON.stringify(state));
        return true;
    });
    assert(seededDocument, 'Could not seed the document-bearing persistence fixture.');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForSelector('.poiesis-results__document');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-results__task-row').length === 2);

    await page.setViewport({ width: 1024, height: 600, deviceScaleFactor: 1 });
    const resized = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const clipped = [...document.querySelectorAll('.poiesis-agent-window__rail, .poiesis-results, .poiesis-results__main, .poiesis-results__task-switcher')]
            .map(element => ({ className: element.className, rect: element.getBoundingClientRect().toJSON() }))
            .filter(item => item.rect.left < -0.5 || item.rect.right > width + 0.5);
        return { width, clipped };
    });
    assert(resized.clipped.length === 0, `Results clipped at 1024x600: ${JSON.stringify(resized.clipped)}`);
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

    const selectedDelete = '.poiesis-results__task-row:has(.poiesis-results__task-select[aria-selected="true"]) .poiesis-results__task-delete';
    await page.click(selectedDelete);
    await page.waitForSelector('.poiesis-results__task-delete-confirm');
    await page.click('.poiesis-results__task-delete-confirm button.danger');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-results__task-row').length === 1);
    await page.waitForSelector('.poiesis-results__state.no-change');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForSelector('.poiesis-results__state.no-change');
    const afterDocumentDeleteReload = await page.evaluate(() => ({
        taskCount: document.querySelectorAll('.poiesis-results__task-row').length,
        iframeCount: document.querySelectorAll('.poiesis-results__document').length
    }));
    assert(afterDocumentDeleteReload.taskCount === 1 && afterDocumentDeleteReload.iframeCount === 0,
        `Document-bearing task deletion did not persist: ${JSON.stringify(afterDocumentDeleteReload)}`);

    await page.click('.poiesis-results__task-delete');
    await page.waitForSelector('.poiesis-results__task-delete-confirm');
    await page.click('.poiesis-results__task-delete-confirm button.danger');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-results__task-row').length === 0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    const afterNoChangeDeleteReload = await page.evaluate(() => ({
        taskCount: document.querySelectorAll('.poiesis-results__task-row').length,
        emptyText: document.querySelector('.poiesis-results__empty')?.textContent?.trim()
    }));
    assert(afterNoChangeDeleteReload.taskCount === 0
        && afterNoChangeDeleteReload.emptyText?.includes('Agent でタスクを完了すると'),
        `No-change task deletion did not persist: ${JSON.stringify(afterNoChangeDeleteReload)}`);

    console.log(`ROUND17_BROWSER_SMOKE_RESULT=${JSON.stringify({
        noChangeRun,
        noChange,
        realAgent,
        noChangeCodexRollouts: newCodexRollouts.length,
        restoredNoChange,
        seededDocument,
        resized,
        afterDocumentDeleteReload,
        afterNoChangeDeleteReload
    })}`);
} finally {
    if (browser) await browser.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true });
}

function codexRolloutFiles() {
    const root = resolve(homedir(), '.codex', 'sessions');
    const files = new Set();
    const visit = directory => {
        if (!existsSync(directory)) return;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = resolve(directory, entry.name);
            if (entry.isDirectory()) visit(path);
            else files.add(path);
        }
    };
    visit(root);
    return files;
}

async function waitForApp(page) {
    await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector('.poiesis-agent-window__rail');
}

async function selectProviders(page) {
    await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal');
    for (const [role, provider, modelId] of [['agent', 'codex', 'gpt-5.6-luna'], ['results', 'codex', '']]) {
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
    const result = await page.evaluate(() => ({
        lastMessage: [...document.querySelectorAll('[aria-label="Agent のメッセージ"]')].at(-1)?.textContent?.trim() ?? '',
        error: document.querySelector('.poiesis-agent-window__message-error strong')?.textContent?.trim()
    }));
    assert(!result.error, `Agent task failed: ${result.error}`);
    return result;
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
