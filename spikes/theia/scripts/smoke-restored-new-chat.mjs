import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = resolve(process.cwd(), '..', '..');
const fixture = resolve(root, 'docs', 'UX.md');
const original = readFileSync(fixture, 'utf8');
const marker = '<!-- Poiesis restored New Chat smoke -->';
if (original.includes(marker)) throw new Error('Restored New Chat fixture contains a marker from an interrupted run.');
const browserPath = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
    .filter(Boolean).find(existsSync);
if (!browserPath) throw new Error('Chrome or Edge was not found.');
const profile = resolve(process.cwd(), '.run', `restored-new-chat-${Date.now()}`);
const url = process.env.THEIA_SMOKE_UI_URL ?? 'http://127.0.0.1:3000';
const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 240_000);
const expectPreSpawnFailure = process.env.POIESIS_EXPECT_PRESPAWN_FAILURE === '1';
const provider = process.env.POIESIS_SMOKE_PROVIDER === 'claude' ? 'claude' : 'codex';
let browser;

try {
    browser = await puppeteer.launch({
        executablePath: browserPath,
        headless: true,
        userDataDir: profile,
        protocolTimeout: 300_000,
        defaultViewport: { width: 1500, height: 850 },
        args: ['--no-sandbox', '--disable-gpu', '--no-first-run']
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    const now = Date.now();
    await page.evaluate(timestamp => {
        const currentState = JSON.parse(localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1') ?? '{}');
        const workspaceUri = currentState.sessions?.find(session => typeof session.workspaceUri === 'string')?.workspaceUri;
        if (!workspaceUri) throw new Error('The current workspace URI was not persisted before the restored-state fixture was installed.');
        const taskId = 'restored-new-chat-seed-task';
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.global.v1', JSON.stringify({
            version: 1,
            selectedSessionId: 'restored-new-chat-seed-session',
            railWidth: 258,
            railCollapsed: false,
            sessions: [{
                id: 'restored-new-chat-seed-session',
                createdAt: timestamp - 60_000,
                updatedAt: timestamp - 1_000,
                workspaceUri,
                branch: 'main',
                runTarget: 'local',
                title: '復元済みセッション',
                hasUserMessage: true,
                lastTaskStatus: 'completed',
                pinned: false,
                archived: false,
                activeTab: 'results',
                agentDraft: '',
                messages: [{ id: 'restored-user', role: 'user', content: '復元用の完了タスク', complete: true }],
                selectedResultsTaskId: taskId,
                resultsDrafts: [],
                tasks: [{
                    id: taskId,
                    sessionId: 'retired-provider-session',
                    title: '復元用の完了タスク',
                    request: '復元用の完了タスク',
                    status: 'completed',
                    startedAt: new Date(timestamp - 30_000).toISOString(),
                    endedAt: new Date(timestamp - 20_000).toISOString(),
                    baseline: { kind: 'workspace-snapshot', capturedAt: new Date(timestamp - 30_000).toISOString() },
                    changeSet: { source: 'empty', diff: '', files: [], capturedAt: new Date(timestamp - 20_000).toISOString() }
                }],
                resultsDocuments: [{
                    taskId,
                    status: 'ready',
                    html: '<!doctype html><html lang="ja"><body><h1>復元済みResults</h1></body></html>'
                }]
            }]
        }));
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
    }, now);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector('.poiesis-results__document');
    if (provider === 'claude') {
        await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
        await page.waitForSelector('.poiesis-settings-modal');
        for (const role of ['agent', 'results']) {
            const selector = `input[name="poiesis-${role}-cli"][value="claude"]`;
            await page.waitForFunction(currentSelector => !document.querySelector(currentSelector)?.disabled, {}, selector);
            await page.$eval(selector, input => input.click());
            await page.waitForFunction(currentSelector => document.querySelector(currentSelector)?.checked, {}, selector);
        }
        await page.click('.poiesis-settings-modal__header button[aria-label="設定を閉じる"]');
        await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal'));
    }
    await clickText(page, '.poiesis-agent-window__tabs button', 'Agent');
    await clickText(page, '.poiesis-agent-window__rail-action', 'New Chat');
    await page.waitForSelector('.poiesis-agent-window__new-agent-empty');

    const prompt = `docs/UX.md の末尾に ${marker} を1行追加してください。このファイル以外は変更せず、コミットしないでください。`;
    await fill(page, prompt);
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await page.waitForSelector('.poiesis-agent-window__task-state');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__task-state'));

    const agentState = await page.evaluate(() => ({
        title: document.querySelector('.poiesis-agent-window__context > strong')?.textContent?.trim(),
        error: document.querySelector('.poiesis-agent-window__message-error strong')?.textContent?.trim(),
        errorDetails: document.querySelector('.poiesis-agent-window__message-error details pre')?.textContent?.trim(),
        messageCount: document.querySelectorAll('[aria-label="Agent のメッセージ"]').length,
        storedTitles: (() => {
            const state = JSON.parse(localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1') ?? '{}');
            return state.sessions?.map(session => session.title) ?? [];
        })()
    }));
    assert(agentState.title?.startsWith('docs/UX.md の末尾に'), 'New Chat did not become a named user session.');
    assert(agentState.storedTitles.includes(agentState.title), 'First user message was not flushed to global storage.');

    if (!expectPreSpawnFailure) {
        await fill(page, 'キャンセル動作の確認です。ファイルを変更せず、作業を始めてください。');
        await page.focus('[aria-label="Agent へのメッセージ"]');
        await page.keyboard.down('Control');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Control');
        await page.waitForSelector('.poiesis-agent-window__task-state');
        await new Promise(resolve => setTimeout(resolve, 750));
        await clickText(page, '.poiesis-agent-window__task-state button', 'キャンセル');
        await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__task-state'));
    }

    await clickText(page, '.poiesis-agent-window__tabs button', 'Results');
    const expectedTaskCount = expectPreSpawnFailure ? 1 : 2;
    await page.waitForFunction(count => document.querySelectorAll('.poiesis-results__task-list button').length === count, {}, expectedTaskCount);
    const taskLabels = await page.$$eval('.poiesis-results__task-list button', nodes => nodes.map(node => node.textContent?.trim()));
    const taskLabel = taskLabels.find(label => expectPreSpawnFailure ? label?.includes('失敗') : label?.includes('完了'));
    if (expectPreSpawnFailure) {
        assert(agentState.error === 'Codex を開始できませんでした。', `Designed pre-spawn error is missing: ${agentState.error}`);
        assert(agentState.errorDetails?.includes('Agent pre-spawn failure requested by test hook.'), 'Raw pre-spawn details are missing from the disclosure.');
        assert(taskLabel?.includes('失敗'), `Pre-spawn failure task is missing: ${taskLabel}`);
        assert(readFileSync(fixture, 'utf8') === original, 'Pre-spawn failure changed the workspace fixture.');
    } else {
        assert(!agentState.error, `Real provider task failed: ${agentState.error}`);
        assert(taskLabel?.includes('完了'), `Completed task is missing: ${taskLabel}`);
        assert(taskLabels.some(label => label?.includes('キャンセル')), `Cancelled task is missing: ${taskLabels.join(' | ')}`);
        assert(readFileSync(fixture, 'utf8').includes(marker), 'Selected provider did not edit the fixture.');
        await page.evaluate(() => {
            const completed = [...document.querySelectorAll('.poiesis-results__task-list button')]
                .find(node => node.textContent?.includes('完了'));
            if (!(completed instanceof HTMLElement)) throw new Error('The completed task tab was not found.');
            completed.click();
        });
        await page.waitForSelector('.poiesis-results__document');

        await page.type('[aria-label="表示中の成果について質問"]', 'この成果で変更したファイル名だけを答えてください。');
        await page.click('[aria-label="Results 内へ送信"]');
        await page.waitForSelector('.poiesis-results__answer.sending');
        await page.waitForFunction(() => Boolean(document.querySelector('.poiesis-results__answer:not(.sending)')));
        const answer = await page.$eval('.poiesis-results__answer', node => ({
            className: node.className,
            text: node.textContent?.trim()
        }));
        assert(!answer.className.includes('failed'), `Results question failed: ${answer.text}`);

        await clickText(page, '.poiesis-agent-window__code-control', 'Code');
        await page.waitForSelector('.poiesis-agent-window__code');
        await page.click('[aria-label="Source Control"]');
        await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-sidebar')?.textContent?.includes('UX.md'));
        await clickText(page, '.poiesis-agent-window__code-control', 'Code');
        await page.waitForSelector('.poiesis-results__document');
        assert(await page.$('.poiesis-results__answer:not(.sending)'), 'Results answer was lost after returning from Code.');
        await clickText(page, '.poiesis-agent-window__tabs button', 'Agent');
        const messageCountAfterResultsQuestion = await page.$$eval('[aria-label="Agent のメッセージ"]', nodes => nodes.length);
        assert(messageCountAfterResultsQuestion === agentState.messageCount + 1,
            'Results question leaked into Agent conversation or the cancelled run was not retained.');
        await clickText(page, '.poiesis-agent-window__tabs button', 'Results');
        await page.waitForSelector('.poiesis-results__document');
        assert(await page.$('.poiesis-results__answer:not(.sending)'), 'Results answer was lost after Agent/Results switching.');
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.poiesis-agent-window__session-title');
    const restored = await page.evaluate(expectedTitle => ({
        titles: [...document.querySelectorAll('.poiesis-agent-window__session-title')].map(node => node.textContent?.trim()),
        taskLabel: document.querySelector('.poiesis-results__task-list button[aria-selected="true"]')?.textContent?.trim()
            ?? document.querySelector('.poiesis-results__task-list button')?.textContent?.trim()
    }), agentState.title);
    assert(restored.titles.includes(agentState.title), 'New Chat session disappeared after reload.');
    assert(expectPreSpawnFailure ? restored.taskLabel?.includes('失敗') : restored.taskLabel?.includes('完了'),
        `Task state disappeared after reload: ${restored.taskLabel}`);
    console.log(`RESTORED_NEW_CHAT_SMOKE_RESULT=${JSON.stringify({ provider, expectPreSpawnFailure, agentState, taskLabel, restored }, null, 2)}`);
} finally {
    if (browser) await browser.close().catch(() => undefined);
    writeFileSync(fixture, original, 'utf8');
}

async function fill(page, value) {
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(value, { delay: 1 });
    await page.waitForFunction(() => !document.querySelector('[aria-label="Agent へ送信"]')?.disabled);
}

async function clickText(page, selector, text) {
    await page.evaluate(({ selector, text }) => {
        const node = [...document.querySelectorAll(selector)].find(candidate => candidate.textContent?.trim() === text);
        if (!(node instanceof HTMLElement)) throw new Error(`${text} was not found.`);
        node.click();
    }, { selector, text });
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
