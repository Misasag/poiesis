import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const runDirectory = resolve(root, '.run', `agent-workflow-${Date.now()}`);
const workspace = resolve(runDirectory, 'workspace');
const browserProfile = resolve(runDirectory, 'browser-profile');
const emptyPlugins = resolve(runDirectory, 'empty-plugins');
const theiaConfig = resolve(runDirectory, 'theia-config');
const theiaCli = resolve(root, 'node_modules', '@theia', 'cli', 'bin', 'theia.js');
for (const directory of [workspace, emptyPlugins]) mkdirSync(directory, { recursive: true });

const completedReply = [
    '# 実装結果',
    '',
    '依頼内容を確認し、会話の読みやすさを検証しました。',
    '',
    ...Array.from({ length: 28 }, (_, index) => `段落 ${index + 1}: 長い会話でも現在位置と最新位置を区別できることを確認するための本文です。`),
    '',
    '| 項目 | 状態 |',
    '| --- | --- |',
    '| 会話 | 読みやすい |',
    '| 入力 | 継続可能 |',
    '',
    '```ts',
    `const bounded = '${'long-code-segment-'.repeat(40)}';`,
    '```',
    '',
    '<!-- poiesis-outcome: conversation -->'
].join('\n');

const port = await freePort();
const uiUrl = `http://127.0.0.1:${port}`;
const serverProcess = spawn(process.execPath, [
    theiaCli,
    'start',
    workspace,
    `--plugins=local-dir:${emptyPlugins.replaceAll('\\', '/')}`,
    '--hostname', '127.0.0.1',
    '--port', String(port)
], {
    cwd: resolve(root, 'browser-app'),
    env: {
        ...process.env,
        THEIA_CONFIG_DIR: theiaConfig,
        POIESIS_CLI_DETECTION_TEST_FORCE_FOUND: 'codex',
        POIESIS_AGENT_TEST_REPLIES: JSON.stringify([completedReply, '停止前に完了してはいけません。']),
        POIESIS_AGENT_TEST_DELAY_MS: '10000',
        POIESIS_AGENT_TEST_ACTIVITIES: '1'
    },
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
});

let serverLog = '';
for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream?.on('data', chunk => {
        serverLog = `${serverLog}${chunk.toString('utf8')}`.slice(-30_000);
    });
}

let browser;
try {
    await waitForServer(uiUrl, serverProcess, timeout);
    browser = await puppeteer.launch({
        executablePath,
        headless: true,
        userDataDir: browserProfile,
        defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        args: ['--disable-gpu', '--no-first-run', '--no-sandbox']
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    const browserErrors = [];
    const ignoredBrowserResources = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        const url = message.location().url;
        if (url === `${uiUrl}/favicon.ico` && message.text().includes('404 (Not Found)')) {
            ignoredBrowserResources.push(url);
            return;
        }
        browserErrors.push(`${message.text()} (${url ?? 'unknown source'})`);
    });

    await page.evaluateOnNewDocument(fixture => {
        if (localStorage.getItem('poiesis-agent-workflow-fixture') === '1') return;
        localStorage.setItem('poiesis-agent-workflow-fixture', '1');
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.global.v1', JSON.stringify(fixture));
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
    }, workflowFixture(pathToFileURL(workspace).toString()));
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);
    await settle(page);

    const empty = await page.evaluate(() => {
        const heading = document.querySelector('.poiesis-agent-window__new-agent-empty h1');
        const composer = document.querySelector('.poiesis-agent-window__composer');
        const rail = document.querySelector('.poiesis-agent-window__rail');
        const bounds = element => element instanceof HTMLElement ? element.getBoundingClientRect().toJSON() : undefined;
        return {
            heading: heading?.textContent?.trim(),
            headingBounds: bounds(heading),
            composerBounds: bounds(composer),
            composerText: composer?.textContent ?? '',
            railWidth: bounds(rail)?.width,
            helperCopyPresent: document.body.textContent?.includes('Repository と branch') === true,
            trophyPresent: Boolean(document.querySelector('.poiesis-agent-window__new-agent-empty > .codicon')),
            resultControl: document.querySelector('[aria-label="成果の関連付け"]')?.textContent?.trim()
        };
    });
    assert(empty.heading === '何を作りますか？' && !empty.helperCopyPresent && !empty.trophyPresent,
        `Empty state copy is not reduced: ${JSON.stringify(empty)}`);
    assert(empty.headingBounds && empty.composerBounds
        && empty.composerBounds.top - empty.headingBounds.bottom >= 0
        && empty.composerBounds.top - empty.headingBounds.bottom <= 32
        && empty.composerBounds.top < 470,
    `Heading and composer are not composed together: ${JSON.stringify(empty)}`);
    assert(empty.composerBounds.height >= 80 && empty.composerBounds.height <= 112,
        `Short composer height is outside the compact range: ${JSON.stringify(empty)}`);
    assert(Math.abs(empty.railWidth - 232) <= 1 && empty.resultControl === '成果',
        `Fresh navigation width or automatic Results control is wrong: ${JSON.stringify(empty)}`);

    await page.click('[aria-label="成果の関連付け"]');
    await page.waitForSelector('.poiesis-requirement-pill__popover [role="option"][data-value="new"]');
    await settle(page);
    await page.click('.poiesis-requirement-pill__popover [role="option"][data-value="new"]');
    await page.waitForFunction(() => document.querySelector('[aria-label="成果の関連付け"]')?.textContent?.includes('成果: 新規'));
    await page.click('[aria-label="成果の関連付け"]');
    await page.waitForSelector('.poiesis-requirement-pill__popover [role="option"][data-value="auto"]');
    await page.click('.poiesis-requirement-pill__popover [role="option"][data-value="auto"]');
    await page.waitForFunction(() => document.querySelector('[aria-label="成果の関連付け"]')?.textContent?.trim() === '成果');

    const firstRequest = '長い回答で会話レイアウトとスクロール追従を確認してください。';
    await fillComposer(page, firstRequest);
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.poiesis-agent-window__message-state[data-phase="running"]');
    await page.waitForSelector('[aria-label="実行を停止"]');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-activity__summary')?.getAttribute('aria-expanded') === 'false');
    const running = await page.evaluate(() => ({
        stateText: document.querySelector('.poiesis-agent-window__message-state')?.textContent?.trim(),
        historyRows: document.querySelectorAll('.poiesis-agent-activity__rows').length,
        emptyAnswerPlaceholders: document.querySelectorAll('.poiesis-agent-window__message[data-task-status="running"] .poiesis-markdown').length,
        taskBars: document.querySelectorAll('.poiesis-agent-window__task-state').length,
        stopText: document.querySelector('[aria-label="実行を停止"]')?.textContent?.trim(),
        textareaDisabled: document.querySelector('[aria-label="Agent へのメッセージ"]')?.disabled
    }));
    assert(running.stateText && /秒|s/.test(running.stateText) && running.historyRows === 0 && running.emptyAnswerPlaceholders === 0
        && running.taskBars === 0 && running.stopText === '停止' && running.textareaDisabled === false,
    `Running presentation is not coherent: ${JSON.stringify(running)}`);

    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__message-state'));
    await page.waitForFunction(reply => [...document.querySelectorAll('.poiesis-agent-window__message .poiesis-markdown')]
        .some(element => element.textContent?.includes(reply)), {}, '依頼内容を確認し');
    await settle(page);
    const completed = await page.evaluate(() => {
        const scroller = document.querySelector('.poiesis-agent-window__messages');
        const history = [...document.querySelectorAll('.poiesis-agent-activity__summary')].at(-1);
        return {
            historyText: history?.textContent?.trim(),
            historyExpanded: history?.getAttribute('aria-expanded'),
            nearBottom: scroller instanceof HTMLElement
                && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 40,
            completedDecoration: document.querySelector('.poiesis-agent-window__session-row.active .poiesis-agent-window__session-meta')?.textContent?.trim(),
            permanentLatest: Boolean(document.querySelector('.poiesis-agent-window__latest'))
        };
    });
    assert(completed.historyText?.includes('作業履歴') && completed.historyExpanded === 'false'
        && completed.nearBottom && !completed.completedDecoration && !completed.permanentLatest,
    `Completed hierarchy or follow behavior failed: ${JSON.stringify(completed)}`);

    await clickLast(page, '.poiesis-agent-activity__summary');
    await page.waitForSelector('.poiesis-agent-activity.expanded .poiesis-agent-activity__rows');
    await settle(page);
    assert(await page.$$eval('.poiesis-agent-activity.expanded .poiesis-agent-activity__row', rows => rows.length) >= 2,
        'Expanded activity history lost source rows.');
    await clickLast(page, '.poiesis-agent-activity__summary');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-activity.expanded'));

    const layouts = [];
    for (const size of [{ width: 1280, height: 720 }, { width: 1000, height: 720 }, { width: 820, height: 720 }]) {
        await page.setViewport({ ...size, deviceScaleFactor: 1 });
        await settle(page);
        layouts.push(await layoutSnapshot(page, `${size.width}x${size.height}`));
    }
    for (const layout of layouts) {
        assert(!layout.horizontalOverflow && Math.abs(layout.conversationWidth - layout.composerWidth) <= 2,
            `Conversation overflow or width mismatch at ${layout.label}: ${JSON.stringify(layout)}`);
        assert(layout.bodyFont >= 15 && layout.bodyLineHeight >= 24,
            `Conversation typography is too small at ${layout.label}: ${JSON.stringify(layout)}`);
    }
    assert(layouts[0].conversationWidth >= 760 && layouts[0].conversationWidth <= 785,
        `1280px conversation width is outside the reading target: ${JSON.stringify(layouts[0])}`);

    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await settle(page);
    const nextDraft = '実行中でも保持する次の下書きです。';
    await fillComposer(page, nextDraft);
    const userCountBeforeSecond = await page.$$eval('[aria-label="あなたのメッセージ"]', nodes => nodes.length);
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.poiesis-agent-window__message-state[data-phase="running"]');
    await fillComposer(page, nextDraft);
    const userCountWhileRunning = await page.$$eval('[aria-label="あなたのメッセージ"]', nodes => nodes.length);
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.press('Enter');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    const duplicateGuard = await page.evaluate(() => ({
        userCount: document.querySelectorAll('[aria-label="あなたのメッセージ"]').length,
        draft: document.querySelector('[aria-label="Agent へのメッセージ"]')?.value,
        editable: !document.querySelector('[aria-label="Agent へのメッセージ"]')?.disabled
    }));
    assert(userCountWhileRunning === userCountBeforeSecond + 1
        && duplicateGuard.userCount === userCountWhileRunning
        && duplicateGuard.draft === nextDraft && duplicateGuard.editable,
    `Running draft or duplicate-send guard failed: ${JSON.stringify({ userCountBeforeSecond, userCountWhileRunning, duplicateGuard })}`);

    await page.$eval('.poiesis-agent-window__messages', element => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForSelector('.poiesis-agent-window__latest');
    const historyTop = await page.$eval('.poiesis-agent-window__messages', element => element.scrollTop);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 900));
    const historyAfterActivity = await page.$eval('.poiesis-agent-window__messages', element => element.scrollTop);
    assert(Math.abs(historyAfterActivity - historyTop) <= 2,
        `Activity update moved a reader away from history: ${JSON.stringify({ historyTop, historyAfterActivity })}`);
    await page.click('.poiesis-agent-window__latest');
    await page.waitForFunction(() => {
        const element = document.querySelector('.poiesis-agent-window__messages');
        return element instanceof HTMLElement && element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
    });
    await page.click('[aria-label="実行を停止"]');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__message-state'));
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-agent-window__message')]
        .some(element => element.textContent?.includes('実行をキャンセルしました')));
    assert(await page.$eval('[aria-label="Agent へのメッセージ"]', element => element.value) === nextDraft,
        'Stopping the run discarded the next draft.');

    await page.$eval('[aria-label="Agent へのメッセージ"]', (element, value) => {
        element.value = value;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
        element.focus();
        element.setSelectionRange(4, 11, 'forward');
        element.dispatchEvent(new Event('select', { bubbles: true }));
    }, '選択位置を復元するための下書きです。');
    await page.click('[data-session-id="fixture-completed"] .poiesis-agent-window__session');
    await waitForActiveSession(page, 'fixture-completed');
    await settle(page);
    const openedAtLatest = await isNearBottom(page);
    assert(openedAtLatest, 'Opening an existing conversation did not start at its latest turn.');
    await page.$eval('.poiesis-agent-window__messages', element => {
        element.scrollTop = Math.min(180, Math.max(0, element.scrollHeight - element.clientHeight - 80));
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForSelector('.poiesis-agent-window__latest');
    const savedConversationTop = await page.$eval('.poiesis-agent-window__messages', element => element.scrollTop);
    await page.click('[data-session-id="fixture-error"] .poiesis-agent-window__session');
    await waitForActiveSession(page, 'fixture-error');
    await page.waitForSelector('.poiesis-agent-window__message-error[role="alert"]');
    assert(await page.$eval('.poiesis-agent-window__message-error', element => element.textContent.includes('接続に失敗しました')),
        'The deterministic error screen hid its real error.');
    await page.click('[data-session-id="fixture-completed"] .poiesis-agent-window__session');
    await waitForActiveSession(page, 'fixture-completed');
    await settle(page);
    const restoredConversationTop = await page.$eval('.poiesis-agent-window__messages', element => element.scrollTop);
    assert(Math.abs(restoredConversationTop - savedConversationTop) <= 3,
        `Conversation reading position was not restored: ${JSON.stringify({ savedConversationTop, restoredConversationTop })}`);

    await page.click('.poiesis-agent-window__rail-action[aria-label="検索"]');
    await page.waitForSelector('.poiesis-agent-window__session-search input');
    await page.type('.poiesis-agent-window__session-search input', '本文だけの検索語');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__session-row').length === 1);
    assert(await page.$eval('.poiesis-agent-window__session-row', element => element.getAttribute('data-session-id')) === 'fixture-completed',
        'Session search did not match message text.');
    await page.focus('.poiesis-agent-window__session-search input');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__session-search'));

    await page.click('[data-session-id="fixture-cancelled"] .poiesis-agent-window__session');
    await waitForActiveSession(page, 'fixture-cancelled');
    assert(await page.$eval('.poiesis-agent-window__message', element => element.textContent.includes('実行をキャンセルしました')),
        'The deterministic cancelled screen lost its stopped status.');
    await page.click('[data-session-id="fixture-empty"] .poiesis-agent-window__session');
    await waitForActiveSession(page, 'fixture-empty');
    await settle(page);
    const restoredSelection = await page.$eval('[aria-label="Agent へのメッセージ"]', element => ({
        value: element.value,
        start: element.selectionStart,
        end: element.selectionEnd,
        direction: element.selectionDirection
    }));
    assert(restoredSelection.value === '選択位置を復元するための下書きです。'
        && restoredSelection.start === 4 && restoredSelection.end === 11 && restoredSelection.direction === 'forward',
    `Composer draft selection was not restored: ${JSON.stringify(restoredSelection)}`);

    assert(browserErrors.length === 0, `Browser errors were reported: ${browserErrors.join(' | ')}`);
    console.log(`AGENT_WORKFLOW_SMOKE_RESULT=${JSON.stringify({
        emptyComposition: true,
        runningProgress: true,
        completedAnswer: true,
        activityDisclosure: true,
        stop: true,
        duplicateSendBlocked: true,
        searchMessageText: true,
        scrollFollow: true,
        scrollRestore: true,
        restoredSelection,
        horizontalOverflow: layouts.some(layout => layout.horizontalOverflow),
        ignoredBrowserResources,
        layouts
    })}`);
} catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(`${ascii(detail)}\nServer log (ASCII):\n${ascii(serverLog)}`);
} finally {
    if (browser) await browser.close().catch(() => undefined);
    stopProcessTree(serverProcess);
    rmSync(runDirectory, { recursive: true, force: true });
}

function workflowFixture(workspaceUri) {
    const now = Date.now();
    const base = {
        workspaceUri,
        branch: 'main',
        runTarget: 'local',
        pinned: false,
        archived: false,
        activeTab: 'agent',
        agentDraft: '',
        resultsDrafts: []
    };
    const longMessages = Array.from({ length: 18 }, (_, index) => [
        { id: `history-user-${index}`, role: 'user', content: index === 0 ? '本文だけの検索語' : `履歴の依頼 ${index + 1}`, complete: true },
        { id: `history-agent-${index}`, role: 'agent', content: `履歴の回答 ${index + 1}\n\n読み返し位置を確認するための文章です。`, complete: true }
    ]).flat();
    longMessages.at(-1).activities = [
        { id: 'fixture-read', kind: 'read', title: '確認', detail: 'src/example.ts', status: 'completed', startedAt: new Date(now - 8_000).toISOString(), endedAt: new Date(now - 7_000).toISOString() },
        { id: 'fixture-command', kind: 'command', title: 'コマンド', detail: 'npm test', status: 'completed', startedAt: new Date(now - 6_000).toISOString(), endedAt: new Date(now - 5_000).toISOString() }
    ];
    return {
        version: 1,
        selectedSessionId: 'fixture-empty',
        railWidth: 232,
        railCollapsed: false,
        sessions: [{
            ...base,
            id: 'fixture-empty',
            createdAt: now,
            updatedAt: now,
            title: '新しい会話',
            hasUserMessage: false,
            messages: []
        }, {
            ...base,
            id: 'fixture-completed',
            createdAt: now - 40_000,
            updatedAt: now - 30_000,
            title: '完了した会話',
            hasUserMessage: true,
            lastTaskStatus: 'completed',
            messages: longMessages
        }, {
            ...base,
            id: 'fixture-error',
            createdAt: now - 80_000,
            updatedAt: now - 70_000,
            title: '失敗した会話',
            hasUserMessage: true,
            lastTaskStatus: 'failed',
            messages: [
                { id: 'error-user', role: 'user', content: '接続を確認してください。', complete: true },
                { id: 'error-agent', role: 'agent', content: '接続に失敗しました。', complete: true, error: true, errorDetails: 'テスト用の詳細エラー' }
            ]
        }, {
            ...base,
            id: 'fixture-cancelled',
            createdAt: now - 120_000,
            updatedAt: now - 110_000,
            title: '停止した会話',
            hasUserMessage: true,
            lastTaskStatus: 'cancelled',
            messages: [
                { id: 'cancel-user', role: 'user', content: '実行を停止してください。', complete: true },
                { id: 'cancel-agent', role: 'agent', content: '実行をキャンセルしました。', complete: true }
            ]
        }]
    };
}

async function fillComposer(page, value) {
    await page.$eval('[aria-label="Agent へのメッセージ"]', (element, next) => {
        element.value = next;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
    }, value);
    await page.waitForFunction(expected => document.querySelector('[aria-label="Agent へのメッセージ"]')?.value === expected, {}, value);
}

async function clickLast(page, selector) {
    const elements = await page.$$(selector);
    const element = elements.at(-1);
    if (!element) throw new Error(`No element matched ${selector}.`);
    await element.click();
}

async function waitForActiveSession(page, sessionId) {
    await page.waitForFunction(id => document.querySelector(`.poiesis-agent-window__session-row.active[data-session-id="${id}"]`), {}, sessionId);
}

async function isNearBottom(page) {
    return page.$eval('.poiesis-agent-window__messages', element => element.scrollHeight - element.scrollTop - element.clientHeight <= 40);
}

async function layoutSnapshot(page, label) {
    return page.evaluate(currentLabel => {
        const content = document.querySelector('.poiesis-agent-window__content');
        const messages = document.querySelector('.poiesis-agent-window__messages');
        const inner = document.querySelector('.poiesis-agent-window__messages-inner');
        const composer = document.querySelector('.poiesis-agent-window__composer');
        const body = document.querySelector('.poiesis-agent-window__message .poiesis-markdown');
        const code = document.querySelector('.poiesis-markdown pre');
        const rect = element => element instanceof HTMLElement ? element.getBoundingClientRect() : undefined;
        const innerRect = rect(inner);
        const composerRect = rect(composer);
        const bodyStyle = body instanceof HTMLElement ? getComputedStyle(body) : undefined;
        return {
            label: currentLabel,
            conversationWidth: Math.round(innerRect?.width ?? 0),
            composerWidth: Math.round(composerRect?.width ?? 0),
            bodyFont: Number.parseFloat(bodyStyle?.fontSize ?? '0'),
            bodyLineHeight: Number.parseFloat(bodyStyle?.lineHeight ?? '0'),
            horizontalOverflow: !(content instanceof HTMLElement && messages instanceof HTMLElement && code instanceof HTMLElement)
                || content.scrollWidth > content.clientWidth + 1
                || messages.scrollWidth > messages.clientWidth + 1
                || (composerRect?.right ?? innerWidth + 1) > innerWidth + 1
                || (composerRect?.left ?? -1) < -1
                || code.getBoundingClientRect().right > (innerRect?.right ?? 0) + 1
        };
    }, label);
}

async function settle(page) {
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    await new Promise(resolveDelay => setTimeout(resolveDelay, 190));
}

async function freePort() {
    return new Promise((resolvePort, rejectPort) => {
        const probe = createServer();
        probe.once('error', rejectPort);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            const selected = typeof address === 'object' && address ? address.port : undefined;
            probe.close(error => error || selected === undefined ? rejectPort(error ?? new Error('No free port.')) : resolvePort(selected));
        });
    });
}

async function waitForServer(url, child, waitTimeout) {
    const deadline = Date.now() + waitTimeout;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Theia exited with code ${child.exitCode}.`);
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // The server is still starting.
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
    }
    throw new Error('Timed out waiting for the Theia browser application.');
}

async function waitForApp(page) {
    await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
}

function stopProcessTree(child) {
    if (child.exitCode !== null || child.pid === undefined) return;
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.kill();
    if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            shell: false,
            stdio: 'ignore'
        });
    }
    child.unref();
}

function ascii(value) {
    return value.replace(/[^\x20-\x7E\r\n\t]/g, '?');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
