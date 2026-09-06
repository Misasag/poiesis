import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 240_000);
const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const runDirectory = resolve(root, '.run', `results-continuity-${Date.now()}`);
const workspace = resolve(runDirectory, 'workspace');
const browserProfile = resolve(runDirectory, 'browser-profile');
const theiaConfig = resolve(runDirectory, 'theia-config');
const theiaCli = resolve(root, 'node_modules', '@theia', 'cli', 'bin', 'theia.js');
const plugins = resolve(root, 'plugins').replaceAll('\\', '/');
mkdirSync(workspace, { recursive: true });
writeFileSync(resolve(workspace, 'README.md'), '# Results continuity smoke\n', 'utf8');
runGit(['init', '--initial-branch=main']);
runGit(['config', 'user.name', 'Poiesis Smoke']);
runGit(['config', 'user.email', 'poiesis-smoke@example.invalid']);
runGit(['add', 'README.md']);
runGit(['commit', '--no-gpg-sign', '-m', 'test: initialize Results continuity fixture']);

const requests = [
    '私の表示名は花子です。ソフトウェア設計とは何か一般的に説明してください。',
    '私の表示名を踏まえ、タスクリストの具体的な設計を提案してください。',
    '表示名を太郎に訂正します。この訂正を覚えてください。',
    '前回のタスクリスト設計を更新し、空状態の操作を追加してください。'
];
const replies = [
    'ソフトウェア設計は、要件を満たすために構造や責務、データの流れを整理する活動です。\n<!-- poiesis-outcome: conversation -->',
    '太郎ではなく現在の表示名である花子向けの設計案です。未完了と完了を分け、各グループ内の順序を保ち、再読み込み後も状態を復元し、空の場合は簡潔な説明を表示します。\n<!-- poiesis-outcome: result -->',
    '承知しました。以後の表示名は太郎として扱います。\n<!-- poiesis-outcome: conversation -->',
    '太郎向けの前の設計案を更新しました。空状態には説明に加えて、最初のタスクを作成する操作を配置します。これは実装ではなく設計の更新です。\n<!-- poiesis-outcome: result -->'
];
const visibleReplies = replies.map(reply => reply.replace(/\n<!-- poiesis-outcome: [^>]+-->/, ''));
const expectedPrompts = [
    [requests[0]],
    [requests[0], visibleReplies[0], requests[1]],
    [requests[1], visibleReplies[1], requests[2]],
    [requests[0], '花子', requests[2], '太郎', requests[3]]
];
const deterministicResultsHtml = '<!doctype html><html lang="ja"><body><main><h1>タスクリスト設計</h1><p>決定済み応答を使った実アプリ検証です。</p></main></body></html>';

const port = await freePort();
const uiUrl = `http://127.0.0.1:${port}`;
const serverProcess = spawn(process.execPath, [
    theiaCli,
    'start',
    workspace,
    `--plugins=local-dir:${plugins}`,
    '--hostname', '127.0.0.1',
    '--port', String(port)
], {
    cwd: resolve(root, 'browser-app'),
    env: {
        ...process.env,
        THEIA_CONFIG_DIR: theiaConfig,
        POIESIS_CLI_DETECTION_TEST_FORCE_FOUND: 'codex',
        POIESIS_AGENT_TEST_REPLIES: JSON.stringify(replies),
        POIESIS_AGENT_TEST_EXPECT_PROMPTS: JSON.stringify(expectedPrompts),
        POIESIS_AGENT_TEST_DELAY_MS: '50',
        POIESIS_RESULTS_GENERATION_TEST_HTML: deterministicResultsHtml
    },
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream?.on('data', chunk => {
        serverLog = `${serverLog}${chunk.toString('utf8')}`.slice(-60_000);
    });
}

let browser;
try {
    await waitForServer(uiUrl, serverProcess, timeout);
    browser = await puppeteer.launch({
        executablePath,
        headless: true,
        userDataDir: browserProfile,
        defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
        args: ['--disable-gpu', '--no-first-run', '--no-sandbox']
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector('.poiesis-agent-window__composer textarea');

    await sendAndWait(page, requests[0], visibleReplies[0]);
    const originalSessionId = await activeSessionId(page);
    assert(!await page.evaluate(() => [...document.querySelectorAll('button')]
        .some(button => button.textContent?.includes('Results で確認'))),
    'The removed repetitive Results action returned after an ordinary question.');
    await selectTab(page, 'Results');
    assert.equal(await page.$$eval('.poiesis-results__requirement-card', cards => cards.length), 0,
        'An ordinary explanation created a Result.');

    await selectTab(page, 'Agent');
    await sendAndWait(page, requests[1], visibleReplies[1]);
    await selectTab(page, 'Results');
    await page.click('.poiesis-results__outcome-trigger');
    await page.waitForSelector('.poiesis-results__requirement-card');
    assert.equal(await page.$$eval('.poiesis-results__requirement-card', cards => cards.length), 1,
        'A concrete no-file design did not create one Result.');

    await selectTab(page, 'Agent');
    await sendAndWait(page, requests[2], visibleReplies[2]);
    await selectTab(page, 'Results');
    assert.equal(await page.$$eval('.poiesis-results__requirement-card', cards => cards.length), 1,
        'An ordinary correction duplicated the existing Result.');

    await selectTab(page, 'Agent');
    await sendAndWait(page, requests[3], visibleReplies[3]);
    await selectTab(page, 'Results');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-results__requirement-card').length === 1);
    const expand = await page.$('.poiesis-results__requirement-expand');
    if (expand) await expand.click();
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-results__history-row').length === 2);
    assert.equal(await page.$$eval('.poiesis-results__requirement-card', cards => cards.length), 1,
        'A same-outcome refinement created an extra Result.');

    await selectTab(page, 'Agent');
    await clickText(page, '.poiesis-agent-window__rail-action', '新しいチャット');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__context > strong')
        ?.textContent?.trim() === '新しいチャット');
    const draft = Array.from({ length: 18 }, (_, index) => `未送信の下書き ${index + 1}`).join('\n');
    const composer = '.poiesis-agent-window__composer textarea';
    await page.$eval(composer, (textarea, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(textarea, value);
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }, draft);
    await page.waitForFunction(value => document.querySelector('.poiesis-agent-window__composer textarea')?.value === value, {}, draft);
    await page.waitForFunction(previous => document.querySelector('.poiesis-agent-window__session-row.active')?.getAttribute('data-session-id') !== previous,
        {}, originalSessionId);
    const draftSessionId = await activeSessionId(page);
    const expectedSelection = { start: 8, end: 16, direction: 'forward' };
    await page.$eval(composer, (textarea, selection) => {
        textarea.setSelectionRange(selection.start, selection.end, selection.direction);
        textarea.dispatchEvent(new Event('select', { bubbles: true }));
        textarea.scrollTop = 42;
        textarea.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, expectedSelection);
    await page.click(`[data-session-id="${originalSessionId}"] .poiesis-agent-window__session`);
    assert(await page.$(`[data-session-id="${draftSessionId}"]`), 'The unsent draft disappeared from the conversation rail.');

    const sessionFile = resolve(theiaConfig, 'poiesis', 'state-v1', 'poiesis.agent-window.sessions.global.v1.json');
    const requirementFile = resolve(theiaConfig, 'poiesis', 'state-v1', 'poiesis.requirements.sessions.v1.json');
    await waitForFile(sessionFile, envelope => envelope.value?.sessions?.some(session =>
        session.id === draftSessionId && session.agentDraft === draft));
    await waitForFile(requirementFile, envelope => Object.values(envelope.value?.sessions ?? {})
        .flat().some(requirement => requirement.sessionId === originalSessionId && requirement.taskIds?.length === 4));

    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await page.waitForSelector(`[data-session-id="${draftSessionId}"]`);
    await page.click(`[data-session-id="${draftSessionId}"] .poiesis-agent-window__session`);
    await page.waitForFunction(value => document.querySelector('.poiesis-agent-window__composer textarea')?.value === value, {}, draft);
    await page.waitForFunction(selection => {
        const textarea = document.querySelector('.poiesis-agent-window__composer textarea');
        return textarea?.selectionStart === selection.start
            && textarea.selectionEnd === selection.end
            && textarea.scrollTop > 0;
    }, {}, expectedSelection);
    const restoredDraft = await page.$eval(composer, textarea => ({
        value: textarea.value,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
        selectionDirection: textarea.selectionDirection,
        scrollTop: textarea.scrollTop
    }));
    assert.equal(restoredDraft.value, draft);
    assert.equal(restoredDraft.selectionStart, expectedSelection.start);
    assert.equal(restoredDraft.selectionEnd, expectedSelection.end);
    assert(restoredDraft.scrollTop > 0, `Draft scroll was not restored: ${JSON.stringify(restoredDraft)}`);

    await page.click(`[data-session-id="${originalSessionId}"] .poiesis-agent-window__session`);
    await selectTab(page, 'Results');
    await page.click('.poiesis-results__outcome-trigger');
    assert.equal(await page.$$eval('.poiesis-results__requirement-card', cards => cards.length), 1,
        'The Result was not restored after reload.');

    const durableSessions = (await waitForFile(sessionFile, envelope =>
        envelope.value?.sessions?.some(session => session.id === originalSessionId && session.tasks?.length === 4))).value.sessions;
    const originalSession = durableSessions.find(session => session.id === originalSessionId);
    assert(originalSession, 'The original conversation was not durably stored.');
    assert.deepEqual(originalSession.tasks.map(task => task.outcomeKind),
        ['conversation', 'result', 'conversation', 'result'],
        'Provider and TaskService did not preserve the expected outcome decisions.');
    const durableRequirements = Object.values((await waitForFile(requirementFile, envelope =>
        Object.values(envelope.value?.sessions ?? {}).flat().some(requirement => requirement.sessionId === originalSessionId))).value.sessions).flat()
        .filter(requirement => requirement.sessionId === originalSessionId);
    assert.equal(durableRequirements.length, 1, 'The same-outcome refinement was not retained in one Requirement.');
    assert.equal(durableRequirements[0].taskIds.length, 4,
        'The durable Requirement did not retain the full conversation-linked task history.');

    console.log(`RESULTS_CONTINUITY_SMOKE=${JSON.stringify({
        deterministicProvider: true,
        transportedPromptAssertions: 4,
        outcomes: originalSession.tasks.map(task => task.outcomeKind),
        requirementCount: durableRequirements.length,
        draftRestored: true,
        storageRoot: resolve(theiaConfig, 'poiesis', 'state-v1')
    })}`);
} catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nServer log:\n${serverLog}`);
} finally {
    await browser?.close().catch(() => undefined);
    stopProcessTree(serverProcess.pid);
}

async function sendAndWait(page, request, expectedReply) {
    const before = await page.$$eval('[aria-label="Agent のメッセージ"]', messages => messages.length);
    await page.type('.poiesis-agent-window__composer textarea', request);
    await page.keyboard.press('Enter');
    await page.waitForFunction(({ count, reply }) => {
        const messages = [...document.querySelectorAll('[aria-label="Agent のメッセージ"]')];
        const last = messages.at(-1)?.querySelector('.poiesis-markdown')?.textContent?.trim();
        return messages.length > count && last === reply
            && !document.querySelector('.poiesis-agent-window__message-state [role="timer"]');
    }, {}, { count: before, reply: expectedReply });
    const text = await page.$eval('[aria-label="Agent のメッセージ"]:last-of-type .poiesis-markdown',
        element => element.textContent?.trim() ?? '');
    assert(!text.includes('poiesis-outcome'), 'Outcome metadata leaked into the conversation.');
    assert(!text.includes('詳細は Results を確認してください'), 'Removed Results guidance returned in a provider reply.');
}

async function selectTab(page, label) {
    await clickText(page, '.poiesis-agent-window__tabs button', label);
    await page.waitForFunction(expected => document.querySelector('.poiesis-agent-window__tabs button[aria-selected="true"]')
        ?.textContent?.trim() === expected, {}, label);
}

async function clickText(page, selector, text) {
    const clicked = await page.$$eval(selector, (elements, expected) => {
        const target = elements.find(element => element.textContent?.trim() === expected);
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
    }, text);
    assert(clicked, `Could not click ${JSON.stringify(text)} in ${selector}.`);
}

async function activeSessionId(page) {
    return page.$eval('.poiesis-agent-window__session-row.active', element => {
        const id = element.getAttribute('data-session-id');
        if (!id) throw new Error('The active conversation has no session id.');
        return id;
    });
}

function readEnvelope(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

async function waitForFile(path, predicate) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            const envelope = readEnvelope(path);
            if (predicate(envelope)) return envelope;
        } catch {
            // The atomic durable write may not have completed yet.
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Timed out waiting for durable state: ${path}`);
}

async function freePort() {
    return new Promise((resolvePort, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const portNumber = typeof address === 'object' && address ? address.port : undefined;
            server.close(error => error ? reject(error) : resolvePort(portNumber));
        });
    });
}

async function waitForServer(url, processHandle, waitMs) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        if (processHandle.exitCode !== null) throw new Error(`Theia exited with code ${processHandle.exitCode}.`);
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // Startup is still in progress.
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
    throw new Error(`Timed out waiting for ${url}.`);
}

function runGit(args) {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

function stopProcessTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
    }
}
