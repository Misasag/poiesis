import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const repositoryRoot = resolve(root, '..', '..');
const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const runDirectory = resolve(root, '.run', `results-question-${Date.now()}`);
const browserProfile = resolve(runDirectory, 'browser-profile');
const emptyPlugins = resolve(runDirectory, 'empty-plugins');
const theiaConfig = resolve(runDirectory, 'theia-config');
const theiaCli = resolve(root, 'node_modules', '@theia', 'cli', 'bin', 'theia.js');
const storageKey = 'poiesis.results-question.sessions.v1';
const sessionStorageKey = 'poiesis:global:poiesis.agent-window.sessions.global.v1';
const migrationStorageKey = 'poiesis:global:poiesis.agent-window.sessions.migrated.v1';
const mockAnswer = 'MOCK_RESULTS_ANSWER: docs/UX.md';
const question = 'Which file changed?';
const taskId = 'results-question-smoke-task';
const sessionId = 'results-question-smoke-session';
const resultsHtml = '<!doctype html><html lang="en"><body><h1>Stored result document</h1><p>docs/UX.md changed.</p></body></html>';

mkdirSync(emptyPlugins, { recursive: true });
const port = await freePort();
const uiUrl = `http://127.0.0.1:${port}`;
const serverProcess = spawn(process.execPath, [
    theiaCli,
    'start',
    '../../..',
    `--plugins=local-dir:${emptyPlugins.replaceAll('\\', '/')}`,
    '--hostname', '127.0.0.1',
    '--port', String(port)
], {
    cwd: resolve(root, 'browser-app'),
    env: {
        ...process.env,
        THEIA_CONFIG_DIR: theiaConfig,
        POIESIS_DISABLE_CLI_DETECTION: '1',
        POIESIS_RESULTS_QUESTION_MOCK_REPLY: mockAnswer,
        POIESIS_RESULTS_QUESTION_MOCK_DELAY_MS: '350'
    },
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream?.on('data', chunk => {
        serverLog = `${serverLog}${chunk.toString()}`.slice(-30_000);
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
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);

    const now = new Date().toISOString();
    await page.evaluate(fixture => {
        localStorage.setItem(fixture.sessionStorageKey, JSON.stringify({
            version: 1,
            selectedSessionId: fixture.sessionId,
            railWidth: 258,
            railCollapsed: false,
            sessions: [{
                id: fixture.sessionId,
                createdAt: Date.now() - 60_000,
                updatedAt: Date.now(),
                workspaceUri: fixture.workspaceUri,
                branch: 'main',
                runTarget: 'local',
                title: 'Results question smoke',
                hasUserMessage: true,
                lastTaskStatus: 'completed',
                unreadTaskCompletion: false,
                pinned: false,
                archived: false,
                activeTab: 'results',
                agentDraft: '',
                messages: [{ id: 'seed-user', role: 'user', content: 'Create the stored result.', complete: true }],
                selectedResultsTaskId: fixture.taskId,
                resultsDrafts: [],
                tasks: [{
                    id: fixture.taskId,
                    sessionId: fixture.sessionId,
                    title: 'Stored result task',
                    request: 'Update docs/UX.md',
                    status: 'completed',
                    startedAt: fixture.now,
                    endedAt: fixture.now,
                    baseline: { kind: 'workspace-snapshot', capturedAt: fixture.now },
                    changeSet: {
                        source: 'task-diff',
                        diff: 'diff --git a/docs/UX.md b/docs/UX.md\n+Results question smoke',
                        files: ['docs/UX.md'],
                        capturedAt: fixture.now
                    }
                }],
                resultsDocuments: [{ taskId: fixture.taskId, status: 'ready', html: fixture.resultsHtml }]
            }]
        }));
        localStorage.setItem(fixture.migrationStorageKey, 'true');
    }, {
        sessionStorageKey,
        migrationStorageKey,
        sessionId,
        taskId,
        workspaceUri: pathToFileURL(repositoryRoot).toString(),
        now,
        resultsHtml
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForSelector('.poiesis-results__document');
    const documentBefore = await page.$eval('.poiesis-results__document', frame => frame.getAttribute('srcdoc'));

    await page.type('[aria-label="表示中の成果について質問"]', question);
    await page.click('[aria-label="Results 内へ送信"]');
    await page.waitForSelector('.poiesis-results__answer.sending', { visible: true });
    const sending = await page.evaluate(() => ({
        visible: Boolean(document.querySelector('.poiesis-results__answer.sending')),
        sendDisabled: document.querySelector('[aria-label="Results 内へ送信"]')?.disabled === true,
        composerDisabled: document.querySelector('[aria-label="表示中の成果について質問"]')?.disabled === true
    }));
    assert(sending.visible && sending.sendDisabled && sending.composerDisabled,
        `Sending state was incomplete: ${JSON.stringify(sending)}`);

    await page.waitForSelector('.poiesis-results__qa-entry:not(.failed)');
    await page.waitForFunction(expected => document.querySelector('.poiesis-results__qa-entry:not(.failed)')?.textContent?.includes(expected), {}, mockAnswer);
    await page.waitForSelector('.poiesis-results__answer.answered', { visible: true });
    const answerNoticeVisible = await page.$eval('.poiesis-results__answer.answered', (notice, expected) =>
        notice.textContent?.includes(expected) === true, mockAnswer);
    assert(answerNoticeVisible, 'The completed answer was not visible next to the Results Composer.');
    await page.waitForFunction((key, expectedSession, expectedTask, expectedAnswer) => {
        const storageEntry = Object.keys(localStorage).find(candidate => candidate.endsWith(`:${key}`));
        if (!storageEntry) return false;
        const state = JSON.parse(localStorage.getItem(storageEntry) ?? '{}');
        return state.sessions?.[expectedSession]?.[expectedTask]?.[0]?.answer === expectedAnswer;
    }, {}, storageKey, sessionId, taskId, mockAnswer);

    const persisted = await page.evaluate((key, expectedSession, expectedTask) => {
        const storageEntry = Object.keys(localStorage).find(candidate => candidate.endsWith(`:${key}`));
        const state = storageEntry ? JSON.parse(localStorage.getItem(storageEntry) ?? '{}') : {};
        return {
            storageEntry,
            history: state.sessions?.[expectedSession]?.[expectedTask] ?? []
        };
    }, storageKey, sessionId, taskId);
    assert(persisted.storageEntry?.startsWith('theia:'), `History did not use Theia StorageService: ${persisted.storageEntry}`);
    assert(persisted.history.length === 1, `Unexpected persisted history: ${JSON.stringify(persisted.history)}`);

    await page.evaluate((key, expectedTask) => {
        const state = JSON.parse(localStorage.getItem(key) ?? '{}');
        for (const session of state.sessions ?? []) {
            for (const task of session.tasks ?? []) {
                if (task.id === expectedTask) delete task.resultsQuestions;
            }
        }
        localStorage.setItem(key, JSON.stringify(state));
    }, sessionStorageKey, taskId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForSelector('.poiesis-results__qa-entry:not(.failed)');
    const restored = await page.evaluate(expectedAnswer => ({
        count: document.querySelectorAll('.poiesis-results__qa-entry:not(.failed)').length,
        answerVisible: document.querySelector('.poiesis-results__qa-entry:not(.failed)')?.textContent?.includes(expectedAnswer) === true,
        documentHtml: document.querySelector('.poiesis-results__document')?.getAttribute('srcdoc')
    }), mockAnswer);
    assert(restored.count === 1 && restored.answerVisible, `History was not restored: ${JSON.stringify(restored)}`);
    assert(documentBefore === restored.documentHtml
        && restored.documentHtml?.includes('<h1>Stored result document</h1>'),
    'Results Skill HTML was modified by the question flow.');

    await page.click('#poiesis-agent-tab');
    await page.waitForSelector('.poiesis-agent-window__agent');
    const agentIsolation = await page.evaluate((expectedQuestion, expectedAnswer) => {
        const text = document.querySelector('.poiesis-agent-window__messages')?.textContent ?? '';
        return {
            messageCount: document.querySelectorAll('[aria-label="あなたのメッセージ"], [aria-label="Agent のメッセージ"]').length,
            containsQuestion: text.includes(expectedQuestion),
            containsAnswer: text.includes(expectedAnswer)
        };
    }, question, mockAnswer);
    assert(agentIsolation.messageCount === 1 && !agentIsolation.containsQuestion && !agentIsolation.containsAnswer,
        `Results thread leaked into Agent conversation: ${JSON.stringify(agentIsolation)}`);

    console.log(`RESULTS_QUESTION_SMOKE_RESULT=${JSON.stringify({
        provider: 'mock',
        sendingVisible: sending.visible,
        answerVisible: answerNoticeVisible,
        theiaStorage: true,
        restoredQuestions: restored.count,
        agentMessageCount: agentIsolation.messageCount,
        skillHtmlUnchanged: true
    })}`);
} catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\nServer log (ASCII):\n${ascii(serverLog)}`);
} finally {
    if (browser) await browser.close().catch(() => undefined);
    stopProcessTree(serverProcess);
    rmSync(runDirectory, { recursive: true, force: true });
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
