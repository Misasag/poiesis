import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const mode = process.argv[2];
if (!['citation', 'fallback'].includes(mode)) {
    throw new Error('Usage: node smoke-results-document.mjs citation|fallback');
}

const root = process.cwd();
const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const runDirectory = resolve(root, '.run', `results-${mode}-${Date.now()}`);
const workspace = resolve(runDirectory, 'workspace');
const browserProfile = resolve(runDirectory, 'browser-profile');
const emptyPlugins = resolve(runDirectory, 'empty-plugins');
const theiaConfig = resolve(runDirectory, 'theia-config');
const theiaCli = resolve(root, 'node_modules', '@theia', 'cli', 'bin', 'theia.js');
const longCompletionReply = [
    'Fallback smoke completed.',
    'Detailed implementation notes that must stay out of the Agent completion message.',
    'Verification command output that belongs in Results instead of the conversation.',
    'Additional explanation returned by the mock runtime to exercise UI-side enforcement.'
].join('\n');
mkdirSync(workspace, { recursive: true });
mkdirSync(emptyPlugins, { recursive: true });
writeFileSync(resolve(workspace, 'citation-target.txt'), 'one\ntwo\nthree\nfour\nfive\n', 'utf8');
const git = spawnSync('git', ['init', '--quiet'], { cwd: workspace, windowsHide: true, shell: false, encoding: 'utf8' });
if (git.status !== 0) throw new Error(`git init failed: ${ascii(git.stderr ?? '')}`);

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
        POIESIS_AGENT_TEST_REPLY: longCompletionReply,
        POIESIS_AGENT_TEST_DELAY_MS: '3500',
        POIESIS_RESULTS_GENERATION_TEST_DELAY_MS: '1200',
        POIESIS_RESULTS_GENERATION_FORCE_FAILURE: '1'
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
    const diagnostics = [];
    page.on('console', message => {
        const text = message.text();
        if (text.includes('[Poiesis][Results diagnostics]')) diagnostics.push(text);
    });
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);

    if (mode === 'citation') {
        await smokeCitation(page, workspace);
        console.log('RESULTS_CITATION_SMOKE_RESULT={"mode":"code","file":"citation-target.txt","line":4}');
    } else {
        await smokeFallback(page, diagnostics);
        console.log(`RESULTS_FALLBACK_SMOKE_RESULT=${JSON.stringify({
            annotation: true,
            retry: true,
            diagnosticAttempts: diagnostics.length,
            completionSummary: true,
            fileStats: true,
            fixedHeader: true,
            generatedBeforeOpen: true,
            shortConversationReport: true
        })}`);
    }
} catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${ascii(detail)}\nServer log (ASCII):\n${ascii(serverLog)}`);
} finally {
    if (browser) await browser.close().catch(() => undefined);
    stopProcessTree(serverProcess);
    rmSync(runDirectory, { recursive: true, force: true });
}

async function smokeCitation(page, workspacePath) {
    const now = new Date().toISOString();
    const sessionId = 'results-citation-smoke-session';
    const taskId = 'results-citation-smoke-task';
    await page.evaluate(fixture => {
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.global.v1', JSON.stringify({
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
                title: 'Citation smoke',
                hasUserMessage: true,
                lastTaskStatus: 'completed',
                unreadTaskCompletion: false,
                pinned: false,
                archived: false,
                activeTab: 'results',
                agentDraft: '',
                messages: [{ id: 'seed-user', role: 'user', content: 'Open the citation.', complete: true }],
                selectedResultsTaskId: fixture.taskId,
                resultsDrafts: [],
                tasks: [{
                    id: fixture.taskId,
                    sessionId: fixture.sessionId,
                    title: 'Citation smoke',
                    request: 'Open the citation.',
                    status: 'completed',
                    startedAt: fixture.now,
                    endedAt: fixture.now,
                    completionSummary: 'Citation ready.',
                    baseline: { kind: 'workspace-snapshot', capturedAt: fixture.now },
                    changeSet: {
                        source: 'task-diff',
                        diff: 'diff --git a/citation-target.txt b/citation-target.txt\n+four',
                        files: ['citation-target.txt'],
                        capturedAt: fixture.now
                    }
                }],
                resultsDocuments: [{
                    taskId: fixture.taskId,
                    status: 'ready',
                    generator: 'ai',
                    html: '<!doctype html><html><head><title>Citation</title></head><body><a href="#" data-poiesis-citation="citation-target.txt:4">citation-target.txt:4</a></body></html>'
                }]
            }]
        }));
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
    }, {
        workspaceUri: pathToFileURL(workspacePath).toString(),
        sessionId,
        taskId,
        now
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForSelector('.poiesis-results__document');
    const frame = await resultsFrame(page);
    await frame.waitForSelector('[data-poiesis-citation="citation-target.txt:4"]');
    await frame.click('[data-poiesis-citation="citation-target.txt:4"]');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__content')?.getAttribute('data-mode') === 'code');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'citation-target.txt');
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-agent-window__code-editor-host .line-numbers.active-line-number')]
        .some(line => line.textContent?.trim() === '4'));
}

async function smokeFallback(page, diagnostics) {
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.type('Create fallback-new.html for the fallback smoke.', { delay: 1 });
    await page.waitForFunction(() => !document.querySelector('[aria-label="Agent へ送信"]')?.disabled);
    await page.click('[aria-label="Agent へ送信"]');
    await page.waitForSelector('.poiesis-agent-window__task-state');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1000));
    writeFileSync(resolve(workspace, 'fallback-new.html'), '<!doctype html>\n<title>Fallback smoke</title>\n', 'utf8');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__task-state'));
    await page.waitForFunction(() => {
        const raw = localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1');
        const state = raw ? JSON.parse(raw) : undefined;
        const task = state?.sessions?.[0]?.tasks?.at(-1);
        return task?.status === 'completed' && task.resultsDocument?.status === 'ready';
    });
    const beforeOpen = await page.evaluate(() => {
        const raw = localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1');
        const state = raw ? JSON.parse(raw) : undefined;
        const task = state?.sessions?.[0]?.tasks?.at(-1);
        const agentMessages = [...document.querySelectorAll('[aria-label="Agent のメッセージ"]')];
        return {
            activeResults: document.querySelector('#poiesis-results-tab')?.getAttribute('aria-selected') === 'true',
            iframeCount: document.querySelectorAll('.poiesis-results__document').length,
            task,
            // Application-owned rich-content cards sit below the completion
            // markdown and are not part of the Agent's 1-2 line report.
            conversation: agentMessages.at(-1)?.querySelector('.poiesis-markdown')?.textContent?.trim() ?? ''
        };
    });
    assert(!beforeOpen.activeResults && beforeOpen.iframeCount === 0,
        `Results opened before the explicit tab action: ${JSON.stringify(beforeOpen)}`);
    assert(beforeOpen.task?.resultsDocument?.status === 'ready',
        `The completed document was not stored on its Task before Results opened: ${JSON.stringify(beforeOpen)}`);
    assert(beforeOpen.task?.resultsDocument?.generator === 'fallback'
        && beforeOpen.task.resultsDocument.fallbackReason === 'generation-failed'
        && typeof beforeOpen.task.resultsDocument.generatedAt === 'string'
        && Number.isFinite(beforeOpen.task.resultsDocument.durationMs),
    `Results generation metadata was not persisted: ${JSON.stringify(beforeOpen.task?.resultsDocument)}`);
    const conversationLines = beforeOpen.conversation.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    assert(conversationLines.length <= 2
        && beforeOpen.conversation.includes('fallback-new.html')
        && beforeOpen.conversation.includes('詳細は Results を確認してください。')
        && !beforeOpen.conversation.includes('Detailed implementation notes'),
    `The Agent completion report was not shortened by the Application: ${JSON.stringify(beforeOpen.conversation)}`);
    await page.click('#poiesis-results-tab');
    await page.waitForSelector('.poiesis-results__document');
    const fixedHeader = await page.evaluate(() => {
        const header = document.querySelector('.poiesis-results__fixed-header');
        const taskTitle = document.querySelector('.poiesis-results__task-select.active > span')?.textContent?.trim();
        return {
            title: header?.querySelector('[data-task-title]')?.textContent?.trim(),
            taskTitle,
            status: header?.querySelector('.poiesis-results__status')?.textContent?.trim(),
            time: header?.querySelector('time')?.textContent?.trim(),
            diffstat: header?.querySelector('.poiesis-results__diffstat')?.textContent?.replace(/\s+/g, ' ').trim(),
            badges: header?.querySelector('.poiesis-results__badges')?.textContent?.replace(/\s+/g, ' ').trim()
        };
    });
    assert(fixedHeader.title === fixedHeader.taskTitle,
        `The fixed header title differs from the Task card: ${JSON.stringify(fixedHeader)}`);
    assert(fixedHeader.status === '完了' && fixedHeader.time === formatJst(beforeOpen.task.endedAt)
        && fixedHeader.diffstat?.includes('1ファイル')
        && fixedHeader.diffstat.includes('+2')
        && fixedHeader.diffstat.includes('−0')
        && fixedHeader.badges === 'テンプレート表示 · AI 生成に失敗',
    `The fixed Results metadata is incomplete: ${JSON.stringify(fixedHeader)}`);
    let frame = await resultsFrame(page);
    await frame.waitForSelector('[data-poiesis-action="retry-ai-results"]');
    const fallback = await frame.evaluate(() => ({
        text: document.body.textContent ?? '',
        citations: document.querySelectorAll('a[data-poiesis-citation]').length,
        rawError: (document.body.textContent ?? '').includes('テスト用失敗'),
        baseStyle: Boolean(document.head.querySelector('style[data-poiesis-base]'))
    }));
    assert(fallback.text.includes('AI 生成に失敗したため簡易表示'), `Fallback annotation is missing: ${JSON.stringify(fallback)}`);
    assert(fallback.text.includes('Fallback smoke completed.'), `Completion summary is missing: ${JSON.stringify(fallback)}`);
    assert(fallback.text.includes('fallback-new.html') && fallback.text.includes('追加')
        && fallback.text.includes('+2') && fallback.citations === 1,
        `Fallback file statistics are incomplete: ${JSON.stringify(fallback)}`);
    assert(!fallback.rawError, 'The internal generation error leaked into the fallback document.');
    assert(fallback.baseStyle, 'The Application-owned Results base style was not injected.');
    await page.waitForFunction(() => document.querySelector('.poiesis-results__document') !== null);
    const attemptsBefore = diagnostics.length;
    await frame.click('[data-poiesis-action="retry-ai-results"]');
    const deadline = Date.now() + timeout;
    while (diagnostics.length <= attemptsBefore && Date.now() < deadline) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    assert(diagnostics.length > attemptsBefore, 'The fallback retry button did not start another AI generation attempt.');
    await page.waitForSelector('.poiesis-results__document');
    frame = await resultsFrame(page);
    await frame.waitForSelector('[data-poiesis-action="retry-ai-results"]');
}

async function resultsFrame(page) {
    await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(frame => frame.classList.contains('poiesis-results__document')));
    const handle = await page.$('.poiesis-results__document');
    const frame = await handle?.contentFrame();
    if (!frame) throw new Error('Results iframe was not attached.');
    return frame;
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

function formatJst(value) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: 'Asia/Tokyo'
    }).formatToParts(new Date(value));
    const part = type => parts.find(candidate => candidate.type === type)?.value ?? '';
    return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')} JST`;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
