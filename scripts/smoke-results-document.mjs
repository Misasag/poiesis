import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';

const URI = createRequire(import.meta.url)('@theia/core/lib/common/uri').default;

const mode = process.argv[2];
if (!['citation', 'fallback', 'detection'].includes(mode)) {
    throw new Error('Usage: node smoke-results-document.mjs citation|fallback|detection');
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
const screenshotDirectory = resolve(root, '_codex', 'round12-screenshots');
const standardScreenshotPath = resolve(screenshotDirectory, 'results-browser-1280x720-standard.png');
const largeScreenshotPath = resolve(screenshotDirectory, 'results-browser-1024x720-large.png');
const longCompletionReply = [
    'Fallback smoke completed.',
    'Detailed implementation notes remain in the Agent completion message.',
    'Verification command output remains available in the conversation.',
    'Additional explanation returned by the mock runtime exercises full-report rendering.'
].join('\n');
const nestedAiDocument = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <style>
    html, body { min-height: 100%; margin: 0; background: #f4f0e6; color: #28251f; }
    main.paper { min-height: 100vh; padding: 48px; background: #f4f0e6; }
    article.column { max-width: 1040px; margin: 0 auto; padding: 56px 48px 80px; }
    h2 { margin: 48px 0 16px; color: #201e1a; }
    p { color: #4a453b; }
  </style>
</head>
<body>
  <main class="paper">
    <article class="column">
      <h2 data-live-check-heading>Live check heading</h2>
      <p>Application-owned page margins remain compact.</p>
    </article>
  </main>
</body>
</html>`;
const denseHeaderSkills = ['implementation-harness', 'verification-recipe', 'results-evidence', 'results-structure'];
const denseHeaderTitle = '長い日本語の成果タイトルでも状態と生成情報と検証結果を同じヘッダーで確認できることを検証するタスク';
mkdirSync(workspace, { recursive: true });
mkdirSync(emptyPlugins, { recursive: true });
mkdirSync(screenshotDirectory, { recursive: true });
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
        POIESIS_SNAPSHOT_STORE_DIR: resolve(runDirectory, 'snapshot-store'),
        ...(mode === 'detection' ? {
            POIESIS_DISABLE_CLI_DETECTION: '1',
            POIESIS_CLI_DETECTION_TEST_DELAY_MS: '5000',
            POIESIS_CLI_DETECTION_TEST_FORCE_FOUND: 'claude',
            POIESIS_CLI_DETECTION_TEST_FAIL_CALLS: '3',
            POIESIS_AGENT_TEST_REPLY: 'Detection lifecycle smoke completed.',
            POIESIS_AGENT_TEST_DELAY_MS: '100'
        } : {
            POIESIS_AGENT_TEST_REPLY: longCompletionReply,
            POIESIS_AGENT_TEST_DELAY_MS: '3500',
            POIESIS_RESULTS_GENERATION_TEST_DELAY_MS: '1200',
            POIESIS_RESULTS_GENERATION_FORCE_FAILURE: '1'
        })
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
    if (mode === 'detection') {
        await installCliDetectionFixtureBeforeNavigation(page, workspace, uiUrl);
    }
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
    } else if (mode === 'fallback') {
        const responsiveResults = await smokeFallback(page, diagnostics);
        console.log(`RESULTS_FALLBACK_SMOKE_RESULT=${JSON.stringify({
            annotation: true,
            retry: true,
            diagnosticAttempts: diagnostics.length,
            completionSummary: true,
            fileStats: true,
            fixedHeader: true,
            generatedBeforeOpen: true,
            fullConversationReport: true,
            compactResultsCanvas: true,
            denseAiHeader: true,
            aiDocumentMargins: true,
            responsiveResults
        })}`);
    } else {
        const lifecycle = await smokeCliDetectionUi(page);
        console.log(`CLI_DETECTION_UI_SMOKE_RESULT=${JSON.stringify(lifecycle)}`);
    }
} catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${ascii(detail)}\nServer log (ASCII):\n${ascii(serverLog)}`);
} finally {
    if (browser) await browser.close().catch(() => undefined);
    stopProcessTree(serverProcess);
    rmSync(runDirectory, { recursive: true, force: true });
}

async function installCliDetectionFixtureBeforeNavigation(page, workspacePath, applicationUrl) {
    const now = new Date().toISOString();
    await page.evaluateOnNewDocument(fixture => {
        if (location.origin !== fixture.origin) return;
        const savedSettings = {
            version: 5,
            uiFontScale: 'standard',
            agentCli: 'claude',
            agentModel: '',
            agentEffort: '',
            resultsCli: 'grok',
            resultsModel: 'grok-4.5',
            resultsEffort: 'medium',
            effortByModel: {
                agent: { 'claude:': '' },
                results: { 'grok:grok-4.5': 'medium' }
            },
            allowExternalResultsResources: false,
            automaticRequirementClassification: true
        };
        localStorage.setItem(`theia:${location.pathname}:${fixture.settingsWorkspaceUri}:poiesis.settings.v1`, JSON.stringify(savedSettings));
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
                title: 'CLI detection lifecycle',
                hasUserMessage: false,
                lastTaskStatus: 'completed',
                pinned: false,
                archived: false,
                activeTab: 'agent',
                agentDraft: '',
                messages: [],
                selectedResultsTaskId: fixture.taskId,
                resultsDrafts: [],
                tasks: [{
                    id: fixture.taskId,
                    sessionId: fixture.sessionId,
                    title: 'Detection fixture result',
                    request: 'Keep a Results role control visible.',
                    status: 'completed',
                    startedAt: fixture.now,
                    endedAt: fixture.now,
                    baseline: { kind: 'workspace-snapshot', capturedAt: fixture.now },
                    changeSet: {
                        source: 'task-diff',
                        diff: 'diff --git a/citation-target.txt b/citation-target.txt\n+ready',
                        files: ['citation-target.txt'],
                        capturedAt: fixture.now
                    }
                }],
                resultsDocuments: [{
                    taskId: fixture.taskId,
                    status: 'ready',
                    generator: 'ai',
                    providerId: 'grok',
                    model: 'grok-4.5',
                    effort: 'medium',
                    html: '<!doctype html><html lang="ja"><body><main data-detection-fixture><h1>Detection fixture</h1></main></body></html>'
                }]
            }]
        }));
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
    }, {
        origin: new URL(applicationUrl).origin,
        workspaceUri: pathToFileURL(workspacePath).toString(),
        settingsWorkspaceUri: new URI(pathToFileURL(workspacePath).toString()).toString(),
        sessionId: 'cli-detection-lifecycle-session',
        taskId: 'cli-detection-lifecycle-seed-task',
        now
    });
}

async function smokeCliDetectionUi(page) {
    await page.waitForFunction(() => document.querySelector('[data-ai-role="agent"] [aria-label="Agent の AI とモデル"]')
        ?.getAttribute('data-value') === 'provider:claude:');
    const initialAgent = await roleControlSnapshot(page, 'agent');
    assert(initialAgent.text?.includes('Claude Code') && initialAgent.text.includes('検出中…')
        && !initialAgent.text.includes('未検出'),
    `Agent role control falsely reported missing during startup: ${JSON.stringify(initialAgent)}`);
    await openSettings(page);
    const initialPendingSettings = await settingsDetectionSnapshot(page);
    assertDetectionStatus(initialPendingSettings, 'pending', 'startup');
    await closeSettings(page);

    const firstPrompt = 'Wait for CLI detection before the first send.';
    await fillAgentComposer(page, firstPrompt);
    const beforeFirstSend = await agentSendSnapshot(page);
    const firstSendAt = Date.now();
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.press('Enter');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
    const firstDeferred = await agentSendSnapshot(page);
    assert(firstDeferred.userMessages === beforeFirstSend.userMessages + 1
        && firstDeferred.taskCount === beforeFirstSend.taskCount
        && !firstDeferred.taskRunning
        && firstDeferred.draft === '',
    `First send escaped the pending detection barrier: ${JSON.stringify({ beforeFirstSend, firstDeferred })}`);

    await page.waitForFunction(() => {
        const raw = localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1');
        const state = raw ? JSON.parse(raw) : undefined;
        const tasks = state?.sessions?.[0]?.tasks ?? [];
        return tasks.length === 2 && tasks.at(-1)?.status === 'completed';
    });
    const firstCompletedAt = Date.now();
    const firstCompleted = await lifecyclePersistedSnapshot(page);
    assert(firstCompleted.latestTask?.providerId === 'claude'
        && firstCompleted.latestTask?.model === 'fable',
    `First Task did not use the model completed by detection: ${JSON.stringify(firstCompleted)}`);
    assert(firstCompleted.settings?.agentCli === 'claude'
        && firstCompleted.settings?.agentModel === 'fable'
        && firstCompleted.settings?.resultsCli === 'grok'
        && firstCompleted.settings?.resultsModel === 'grok-4.5'
        && firstCompleted.settings?.resultsEffort === 'medium',
    `Saved role selections changed during detection completion: ${JSON.stringify(firstCompleted.settings)}`);

    await clickTab(page, 'Results');
    await page.waitForSelector('.poiesis-results__document');
    const readyResults = await roleControlSnapshot(page, 'results');
    assert(readyResults.text?.includes('Grok') && readyResults.text.includes('grok-4.5')
        && readyResults.text.includes('medium') && readyResults.text.includes('未検出'),
    `Results role control lost its saved completed-missing selection: ${JSON.stringify(readyResults)}`);
    await clickTab(page, 'Agent');

    await openSettings(page);
    const refreshPendingSettings = await settingsDetectionSnapshot(page);
    assertDetectionStatus(refreshPendingSettings, 'pending', 'refresh');
    await closeSettings(page);
    await clickTab(page, 'Results');
    const refreshPendingResults = await roleControlSnapshot(page, 'results');
    await clickTab(page, 'Agent');
    const refreshPendingAgent = await roleControlSnapshot(page, 'agent');
    assert(refreshPendingAgent.text?.includes('検出中…') && !refreshPendingAgent.text.includes('未検出')
        && refreshPendingResults.text?.includes('検出中…') && !refreshPendingResults.text.includes('未検出'),
    `Role controls reused stale availability during refresh: ${JSON.stringify({ refreshPendingAgent, refreshPendingResults })}`);
    await openSettings(page);
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-settings-modal__cli-status')]
        .some(node => node.textContent?.trim() === '検出に失敗'));
    const failedSettings = await settingsDetectionSnapshot(page);
    assertDetectionStatus(failedSettings, 'error', 'failed refresh');
    assert(failedSettings.agent.model === 'fable'
        && failedSettings.results.model === 'grok-4.5'
        && failedSettings.results.effort === 'medium',
    `Failed refresh changed saved model or effort values: ${JSON.stringify(failedSettings)}`);
    await closeSettings(page);

    const failedAgentRole = await roleControlSnapshot(page, 'agent');
    assert(failedAgentRole.text?.includes('検出に失敗'),
        `Agent role control did not expose the failed refresh: ${JSON.stringify(failedAgentRole)}`);
    const secondPrompt = 'Use a fresh runtime check after the failed rescan.';
    await fillAgentComposer(page, secondPrompt);
    const beforeErrorSend = await agentSendSnapshot(page);
    const errorSendAt = Date.now();
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.press('Enter');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
    const errorSendDeferred = await agentSendSnapshot(page);
    assert(errorSendDeferred.taskCount === beforeErrorSend.taskCount
        && !errorSendDeferred.taskRunning,
    `Send reused a stale provider session after detection failure: ${JSON.stringify({ beforeErrorSend, errorSendDeferred })}`);

    await page.waitForFunction(() => {
        const raw = localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1');
        const state = raw ? JSON.parse(raw) : undefined;
        return (state?.sessions?.[0]?.tasks?.length ?? 0) === 3;
    });
    const freshTaskStartedAt = Date.now();
    await page.waitForFunction(() => {
        const raw = localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1');
        const state = raw ? JSON.parse(raw) : undefined;
        return state?.sessions?.[0]?.tasks?.at(-1)?.status === 'completed';
    });
    const secondCompleted = await lifecyclePersistedSnapshot(page);
    assert(secondCompleted.latestTask?.providerId === 'claude'
        && secondCompleted.latestTask?.model === 'fable'
        && freshTaskStartedAt - errorSendAt >= 3_500,
    `Error-state send did not perform a delayed fresh runtime check: ${JSON.stringify({ secondCompleted, delay: freshTaskStartedAt - errorSendAt })}`);

    await openSettings(page);
    const retryPendingSettings = await settingsDetectionSnapshot(page);
    assertDetectionStatus(retryPendingSettings, 'pending', 'retry');
    await page.waitForFunction(() => {
        const agent = document.querySelector('input[name="poiesis-agent-cli"][value="claude"]')?.closest('.poiesis-settings-modal__cli-row');
        const results = document.querySelector('input[name="poiesis-results-cli"][value="grok"]')?.closest('.poiesis-settings-modal__cli-row');
        return agent?.querySelector('.poiesis-settings-modal__cli-status')?.textContent?.includes('検出済み')
            && results?.querySelector('.poiesis-settings-modal__cli-status')?.textContent?.trim() === '未検出';
    });
    const retryReadySettings = await settingsDetectionSnapshot(page);
    assertDetectionStatus(retryReadySettings, 'ready', 'retry completion');
    assert(retryReadySettings.agent.model === 'fable'
        && retryReadySettings.results.model === 'grok-4.5'
        && retryReadySettings.results.effort === 'medium',
    `Retry changed saved role selections: ${JSON.stringify(retryReadySettings)}`);
    await closeSettings(page);

    const finalAgent = await roleControlSnapshot(page, 'agent');
    await clickTab(page, 'Results');
    const finalResults = await roleControlSnapshot(page, 'results');
    assert(finalAgent.text?.includes('Claude') && finalAgent.text.includes('fable'),
        `Agent role control lost the completed default model: ${JSON.stringify(finalAgent)}`);
    assert(finalResults.text?.includes('Grok') && finalResults.text.includes('grok-4.5')
        && finalResults.text.includes('medium') && finalResults.text.includes('未検出'),
    `Results role control lost its saved unavailable selection: ${JSON.stringify(finalResults)}`);

    return {
        startup: { agent: initialAgent, settings: initialPendingSettings },
        firstSend: {
            deferred: true,
            elapsedMs: firstCompletedAt - firstSendAt,
            task: firstCompleted.latestTask
        },
        refresh: {
            pending: refreshPendingSettings,
            roleControls: { agent: refreshPendingAgent, results: refreshPendingResults },
            error: failedSettings
        },
        errorSend: {
            staleSessionRejected: true,
            freshDetectionDelayMs: freshTaskStartedAt - errorSendAt,
            task: secondCompleted.latestTask
        },
        retry: retryReadySettings,
        finalRoles: { agent: finalAgent, results: finalResults },
        savedSettings: secondCompleted.settings
    };
}

async function roleControlSnapshot(page, role) {
    const label = role === 'agent' ? 'Agent' : 'Results';
    const selector = `[data-ai-role="${role}"] [aria-label="${label} の AI とモデル"]`;
    await page.waitForSelector(selector);
    return page.$eval(selector, trigger => ({
        value: trigger.getAttribute('data-value'),
        text: trigger.textContent?.replace(/\s+/g, ' ').trim(),
        disabled: trigger.hasAttribute('disabled'),
        pagePath: location.pathname,
        storageKeys: Object.keys(localStorage).filter(key => key.includes('poiesis.settings')),
        storedSettings: localStorage.getItem(`theia:${location.pathname}:poiesis.settings.v1`)
    }));
}

async function settingsDetectionSnapshot(page) {
    return page.evaluate(() => {
        const role = (roleId, providerId, label) => {
            const input = document.querySelector(`input[name="poiesis-${roleId}-cli"][value="${providerId}"]`);
            const row = input?.closest('.poiesis-settings-modal__cli-row');
            return {
                provider: providerId,
                checked: Boolean(input?.checked),
                status: row?.querySelector('.poiesis-settings-modal__cli-status')?.textContent?.trim(),
                rowText: row?.textContent?.replace(/\s+/g, ' ').trim(),
                model: document.querySelector(`[aria-label="${label} の AI モデル"]`)?.getAttribute('data-value'),
                effort: document.querySelector(`[aria-label="${label} の AI effort"]`)?.getAttribute('data-value')
            };
        };
        return {
            statuses: [...document.querySelectorAll('.poiesis-settings-modal__cli-status')]
                .map(node => node.textContent?.trim()),
            agent: role('agent', 'claude', 'Agent'),
            results: role('results', 'grok', 'Results')
        };
    });
}

function assertDetectionStatus(snapshot, phase, label) {
    assert(snapshot.agent.checked && snapshot.results.checked,
        `${label} did not preserve selected providers: ${JSON.stringify(snapshot)}`);
    if (phase === 'pending') {
        assert(snapshot.statuses.length === 8
            && snapshot.statuses.every(status => status === '検出中…')
            && !snapshot.statuses.includes('未検出'),
        `${label} exposed false missing statuses while pending: ${JSON.stringify(snapshot)}`);
    } else if (phase === 'error') {
        assert(snapshot.statuses.length === 8
            && snapshot.statuses.every(status => status === '検出に失敗')
            && !snapshot.statuses.includes('未検出'),
        `${label} reused a stale report after failure: ${JSON.stringify(snapshot)}`);
    } else {
        assert(snapshot.agent.status?.includes('検出済み') && snapshot.results.status === '未検出',
            `${label} did not distinguish found from completed missing: ${JSON.stringify(snapshot)}`);
    }
}

async function agentSendSnapshot(page) {
    return page.evaluate(() => {
        const raw = localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1');
        const state = raw ? JSON.parse(raw) : undefined;
        return {
            userMessages: document.querySelectorAll('[aria-label="あなたのメッセージ"]').length,
            taskCount: state?.sessions?.[0]?.tasks?.length ?? 0,
            taskRunning: Boolean(document.querySelector('.poiesis-agent-window__task-state')),
            draft: document.querySelector('[aria-label="Agent へのメッセージ"]')?.value ?? ''
        };
    });
}

async function lifecyclePersistedSnapshot(page) {
    return page.evaluate(() => {
        const sessionRaw = localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1');
        const settingsKey = Object.keys(localStorage).find(key => key.startsWith('theia:') && key.endsWith(':poiesis.settings.v1'));
        const settingsRaw = settingsKey ? localStorage.getItem(settingsKey) : undefined;
        const sessionState = sessionRaw ? JSON.parse(sessionRaw) : undefined;
        return {
            latestTask: sessionState?.sessions?.[0]?.tasks?.at(-1),
            settings: settingsRaw ? JSON.parse(settingsRaw) : undefined
        };
    });
}

async function fillAgentComposer(page, value) {
    const selector = '[aria-label="Agent へのメッセージ"]';
    await page.focus(selector);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(value);
    await page.waitForFunction(() => !document.querySelector('[aria-label="Agent へ送信"]')?.disabled);
}

async function clickTab(page, label) {
    await page.evaluate(tabLabel => {
        const tab = [...document.querySelectorAll('.poiesis-agent-window__tabs button')]
            .find(node => node.textContent?.trim() === tabLabel);
        if (!(tab instanceof HTMLElement)) throw new Error(`${tabLabel} tab was not found.`);
        tab.click();
    }, label);
}

async function openSettings(page) {
    await page.$eval('.poiesis-agent-window__rail-footer button[aria-label="設定"]', button => button.click());
    await page.waitForSelector('.poiesis-settings-modal');
}

async function closeSettings(page) {
    await page.$eval('.poiesis-settings-modal__header button[aria-label="設定を閉じる"]', button => button.click());
    await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal'));
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
                    html: '<!doctype html><html><head><title>Citation</title></head><body><h2 style="font-family: Georgia, serif">根拠</h2><a href="#" data-poiesis-citation="citation-target.txt:4">citation-target.txt:4</a></body></html>',
                    assertions: [
                        { text: '変更ファイルがある場合、本文に根拠引用がある', source: 'app', status: 'pass' },
                        { text: '本文に見出し（h2〜h4）がある', source: 'app', status: 'pass' },
                        { text: '空の見出しがない', source: 'app', status: 'pass' }
                    ],
                    assertionAttempts: 1
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
    const assertionState = await page.evaluate(taskId => {
        const raw = localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1');
        const state = raw ? JSON.parse(raw) : undefined;
        const session = state?.sessions?.find(candidate => (candidate.tasks ?? []).some(task => task.id === taskId));
        const task = session?.tasks?.find(candidate => candidate.id === taskId);
        const resultDocument = task?.resultsDocument ?? session?.resultsDocuments?.find(candidate => candidate.taskId === taskId);
        return {
            badge: document.querySelector('.poiesis-results__assertion-badge')?.textContent?.replace(/\s+/g, ' ').trim(),
            badgeAriaLabel: document.querySelector('.poiesis-results__assertion-badge')?.getAttribute('aria-label'),
            assertions: resultDocument?.assertions,
            attempts: resultDocument?.assertionAttempts
        };
    }, taskId);
    assert(assertionState.badge === '条件 3/3'
        && assertionState.badgeAriaLabel === 'Skill 条件 3/3 合格'
        && assertionState.assertions?.length === 3
        && assertionState.assertions.every(result => result.source === 'app' && result.status === 'pass')
        && assertionState.attempts === 1,
    `AI assertion results were not persisted and rendered: ${JSON.stringify(assertionState)}`);
    const frame = await resultsFrame(page);
    await frame.waitForSelector('[data-poiesis-citation="citation-target.txt:4"]');
    const typography = await frame.evaluate(() => ({
        bodyFontFamily: getComputedStyle(document.body).fontFamily,
        headingFontFamily: getComputedStyle(document.querySelector('h2')).fontFamily
    }));
    assert(typography.bodyFontFamily.trim().startsWith('Inter')
        && typography.headingFontFamily.trim().startsWith('Inter'),
    `The Application sans stack did not override the AI document serif style: ${JSON.stringify(typography)}`);
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
    assert(beforeOpen.conversation === longCompletionReply
        && !beforeOpen.conversation.includes('詳細は Results を確認してください')
        && !beforeOpen.conversation.includes('変更ファイル: なし'),
    `The Agent completion report was not preserved verbatim: ${JSON.stringify(beforeOpen.conversation)}`);
    await page.click('#poiesis-results-tab');
    await page.waitForSelector('.poiesis-results__document');
    const fixedHeader = await page.evaluate(() => {
        const header = document.querySelector('.poiesis-results__fixed-header');
        const taskTitle = document.querySelector('.poiesis-results__requirement-card.active .poiesis-results__requirement-select > span')?.textContent?.trim();
        return {
            title: header?.querySelector('h1')?.textContent?.trim(),
            taskTitle,
            status: header?.querySelector('.poiesis-results__status')?.textContent?.trim(),
            time: header?.querySelector('time')?.textContent?.trim(),
            timeTitle: header?.querySelector('time')?.getAttribute('title'),
            diffstat: header?.querySelector('.poiesis-results__diffstat')?.textContent?.replace(/\s+/g, ' ').trim(),
            badges: header?.querySelector('.poiesis-results__badges')?.textContent?.replace(/\s+/g, ' ').trim(),
            badgeTitles: [...header?.querySelectorAll('.poiesis-results__badges > span') ?? []]
                .map(node => node.getAttribute('title'))
        };
    });
    assert(fixedHeader.title === fixedHeader.taskTitle,
        `The fixed header title differs from the Task card: ${JSON.stringify(fixedHeader)}`);
    assert(fixedHeader.status === '完了' && fixedHeader.time === formatCompactJst(beforeOpen.task.endedAt)
        && fixedHeader.timeTitle === formatJst(beforeOpen.task.endedAt)
        && fixedHeader.diffstat?.includes('1ファイル')
        && fixedHeader.diffstat.includes('+2')
        && fixedHeader.diffstat.includes('−0')
        && fixedHeader.badges?.includes('テンプレート · 生成失敗')
        && !fixedHeader.badges.includes('条件')
        && fixedHeader.badges.includes('タスク 1')
        && fixedHeader.badgeTitles.includes('テンプレート表示 · AI 生成に失敗')
        && fixedHeader.badgeTitles.includes('タスク 1件'),
    `The fixed Results metadata is incomplete: ${JSON.stringify(fixedHeader)}`);
    const canvasLayout = await page.evaluate(() => {
        const bounds = selector => {
            const element = document.querySelector(selector);
            if (!element) return undefined;
            const rect = element.getBoundingClientRect();
            return { top: rect.top, width: rect.width, height: rect.height };
        };
        return {
            panel: bounds('#poiesis-results-panel'),
            canvas: bounds('.poiesis-results__canvas'),
            header: bounds('.poiesis-results__fixed-header'),
            frame: bounds('.poiesis-results__document')
        };
    });
    assert(canvasLayout.header?.height <= 52,
        `The Results fixed header is taller than 52px at 1280x720: ${JSON.stringify(canvasLayout)}`);
    assert(canvasLayout.frame && canvasLayout.panel && canvasLayout.frame.top - canvasLayout.panel.top <= 70,
        `The Results document starts too far below the panel top: ${JSON.stringify(canvasLayout)}`);
    assert(canvasLayout.frame && canvasLayout.canvas && canvasLayout.frame.width >= canvasLayout.canvas.width - 2,
        `The Results document does not use the canvas width: ${JSON.stringify(canvasLayout)}`);
    let frame = await resultsFrame(page);
    await frame.waitForSelector('[data-poiesis-action="retry-ai-results"]');
    const fallback = await frame.evaluate(() => {
        const baseStyle = document.head.querySelector('style[data-poiesis-base]');
        return {
            text: document.body.textContent ?? '',
            citations: document.querySelectorAll('a[data-poiesis-citation]').length,
            rawError: (document.body.textContent ?? '').includes('テスト用失敗'),
            baseStyle: Boolean(baseStyle),
            baseStyleText: baseStyle?.textContent ?? '',
            bodyFontFamily: getComputedStyle(document.body).fontFamily,
            cardPaddingTop: parseFloat(getComputedStyle(document.querySelector('.paper article')).paddingTop)
        };
    });
    assert(fallback.text.includes('AI 生成に失敗したため簡易表示'), `Fallback annotation is missing: ${JSON.stringify(fallback)}`);
    assert(fallback.text.includes('Fallback smoke completed.'), `Completion summary is missing: ${JSON.stringify(fallback)}`);
    assert(fallback.text.includes('fallback-new.html') && fallback.text.includes('追加')
        && fallback.text.includes('+2') && fallback.citations === 1,
        `Fallback file statistics are incomplete: ${JSON.stringify(fallback)}`);
    assert(!fallback.rawError, 'The internal generation error leaked into the fallback document.');
    assert(fallback.baseStyle, 'The Application-owned Results base style was not injected.');
    assert(fallback.baseStyleText.includes('font-family: inherit !important'),
        `The Application-owned Results typography override was not injected: ${JSON.stringify(fallback)}`);
    assert(fallback.bodyFontFamily.trim().startsWith('Inter'),
        `The fallback document did not compute the Application sans stack: ${JSON.stringify(fallback)}`);
    assert(fallback.cardPaddingTop >= 16,
        `The bundled template card lost its own top padding: ${JSON.stringify(fallback)}`);
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
    await page.waitForFunction(() => {
        const raw = localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1');
        const state = raw ? JSON.parse(raw) : undefined;
        return state?.sessions?.[0]?.tasks?.at(-1)?.resultsDocument?.status === 'ready';
    });
    await page.evaluate(fixture => {
        const key = 'poiesis:global:poiesis.agent-window.sessions.global.v1';
        const raw = localStorage.getItem(key);
        const state = raw ? JSON.parse(raw) : undefined;
        const session = state?.sessions?.[0];
        const task = session?.tasks?.at(-1);
        if (!session || !task) throw new Error('Fallback Task state was not available for the dense header fixture.');
        task.title = fixture.title;
        task.appliedSkills = { agent: fixture.skills, results: [] };
        task.resultsDocument = {
            ...task.resultsDocument,
            status: 'ready',
            generator: 'ai',
            providerId: 'codex',
            fallbackReason: undefined,
            html: fixture.html,
            assertions: Array.from({ length: 7 }, (_, index) => ({
                text: `Dense header assertion ${index + 1}`,
                source: 'app',
                status: 'pass'
            })),
            assertionAttempts: 1
        };
        const originalStartedAt = new Date(task.startedAt).getTime();
        const history = Array.from({ length: 9 }, (_, index) => {
            const sequence = index + 1;
            const startedAt = new Date(originalStartedAt - (10 - sequence) * 60_000).toISOString();
            return {
                ...task,
                id: `${task.id}-history-${sequence}`,
                title: `${fixture.title} ${sequence}`,
                startedAt,
                endedAt: startedAt,
                resultsDocument: {
                    ...task.resultsDocument,
                    taskId: `${task.id}-history-${sequence}`
                }
            };
        });
        session.tasks = [...history, task];
        session.selectedResultsTaskId = task.id;
        session.activeTab = 'results';
        localStorage.setItem(key, JSON.stringify(state));
        for (const storageKey of Object.keys(localStorage)) {
            if (!storageKey.includes('poiesis.requirements.sessions.v1')) continue;
            try {
                const stored = JSON.parse(localStorage.getItem(storageKey));
                for (const requirements of Object.values(stored?.sessions ?? {})) {
                    for (const requirement of Array.isArray(requirements) ? requirements : []) {
                        if (requirement.taskIds?.includes(task.id)) {
                            requirement.title = fixture.title;
                            requirement.taskIds = session.tasks.map(candidate => candidate.id);
                        }
                    }
                }
                localStorage.setItem(storageKey, JSON.stringify(stored));
            } catch {
                // Ignore unrelated storage values that happen to share the suffix.
            }
        }
    }, { html: nestedAiDocument, skills: denseHeaderSkills, title: denseHeaderTitle });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForSelector('.poiesis-results__document');
    await waitForFinishedResultsContent(page, '[data-live-check-heading]');
    const denseHeader = await page.evaluate(expectedTitle => {
        const header = document.querySelector('.poiesis-results__fixed-header');
        const badgeNodes = [...header?.querySelectorAll('.poiesis-results__badges > span') ?? []];
        const skillsBadge = badgeNodes.find(node => node.textContent?.trim().startsWith('Skills '));
        const rowCenters = [...header?.querySelectorAll('.poiesis-results__status, time, .poiesis-results__diffstat, .poiesis-results__badges > span') ?? []]
            .map(node => {
                const bounds = node.getBoundingClientRect();
                return Math.round(bounds.top + bounds.height / 2);
            });
        const title = header?.querySelector('h1');
        return {
            height: header?.getBoundingClientRect().height,
            title: title?.textContent?.trim(),
            titleAttribute: title?.getAttribute('title'),
            titleWidth: title?.getBoundingClientRect().width,
            badges: badgeNodes.map(node => node.textContent?.replace(/\s+/g, ' ').trim()),
            badgeTitles: badgeNodes.map(node => node.getAttribute('title')),
            skillsTitle: skillsBadge?.getAttribute('title'),
            skillsAriaLabel: skillsBadge?.getAttribute('aria-label'),
            metadataRows: new Set(rowCenters).size,
            matchesExpectedTitle: title?.textContent?.trim() === expectedTitle
        };
    }, denseHeaderTitle);
    assert(denseHeader.height <= 40 && denseHeader.metadataRows === 1 && denseHeader.titleWidth >= 120,
        `The dense AI Results header is not one compact row at 1280x720: ${JSON.stringify(denseHeader)}`);
    assert(denseHeader.matchesExpectedTitle && denseHeader.titleAttribute === denseHeaderTitle
        && denseHeader.badges.includes('AI · Codex')
        && denseHeader.badges.includes('条件 7/7')
        && denseHeader.badges.includes('Skills 4')
        && denseHeader.badges.includes('タスク 10')
        && denseHeader.badgeTitles.includes('AI 生成 · Codex')
        && denseHeader.badgeTitles.includes('Skill 条件 7/7 合格')
        && denseHeader.badgeTitles.includes('タスク 10件')
        && denseHeader.skillsTitle?.startsWith('適用 Skills: ')
        && denseHeader.skillsAriaLabel === denseHeader.skillsTitle,
    `The compact Results badges are incomplete: ${JSON.stringify(denseHeader)}`);
    const standardLayout = await measureResultsLayout(page);
    assertResultsLayout(standardLayout, { label: '1280x720 standard', singleRow: true });
    await page.screenshot({ path: standardScreenshotPath });

    await setUiFontScale(page, 'large');
    await page.setViewport({ width: 1024, height: 720, deviceScaleFactor: 1 });
    const aiFrame = await waitForFinishedResultsContent(page, '[data-live-check-heading]');
    const largeLayout = await measureResultsLayout(page);
    assertResultsLayout(largeLayout, { label: '1024x720 large', singleRow: false });
    assert(largeLayout.header.height <= 92 && largeLayout.headerRows <= 3,
        `The deliberate narrow Results header layout grew unexpectedly: ${JSON.stringify(largeLayout)}`);
    await page.screenshot({ path: largeScreenshotPath });
    const aiLayout = await aiFrame.evaluate(() => {
        const outer = document.querySelector('body > main');
        const inner = document.querySelector('body > main > article');
        const heading = document.querySelector('[data-live-check-heading]');
        const outerStyle = getComputedStyle(outer);
        const innerStyle = getComputedStyle(inner);
        const headingStyle = getComputedStyle(heading);
        return {
            outerPaddingTop: parseFloat(outerStyle.paddingTop),
            outerPaddingInline: parseFloat(outerStyle.paddingLeft),
            outerMaxWidth: outerStyle.maxWidth,
            outerMarginInline: outerStyle.marginLeft,
            innerPaddingTop: parseFloat(innerStyle.paddingTop),
            innerPaddingInline: parseFloat(innerStyle.paddingLeft),
            innerMaxWidth: innerStyle.maxWidth,
            innerMarginInline: innerStyle.marginLeft,
            headingMarginTop: parseFloat(headingStyle.marginTop),
            headingTop: heading.getBoundingClientRect().top
        };
    });
    assert(aiLayout.outerPaddingTop <= 20 && aiLayout.outerPaddingInline <= 28
        && aiLayout.outerMaxWidth === 'none' && aiLayout.outerMarginInline === '0px'
        && aiLayout.innerPaddingTop === 0 && aiLayout.innerPaddingInline === 0
        && aiLayout.innerMaxWidth === 'none' && aiLayout.innerMarginInline === '0px'
        && aiLayout.headingMarginTop === 0 && aiLayout.headingTop <= 22,
    `The Application-owned AI document margins were not enforced: ${JSON.stringify(aiLayout)}`);
    return {
        standard: standardLayout,
        large: largeLayout,
        screenshots: [standardScreenshotPath, largeScreenshotPath]
    };
}

async function setUiFontScale(page, scale) {
    await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal');
    await page.$eval(`input[name="poiesis-ui-scale"][value="${scale}"]`, input => input.click());
    await page.click('.poiesis-settings-modal__header button[aria-label="設定を閉じる"]');
    await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal'));
}

async function measureResultsLayout(page) {
    return page.evaluate(() => {
        const rect = element => {
            const bounds = element.getBoundingClientRect();
            return {
                left: Math.round(bounds.left),
                top: Math.round(bounds.top),
                right: Math.round(bounds.right),
                bottom: Math.round(bounds.bottom),
                width: Math.round(bounds.width),
                height: Math.round(bounds.height)
            };
        };
        const header = document.querySelector('.poiesis-results__fixed-header');
        const title = header?.querySelector('h1');
        const metaItems = [...header?.querySelectorAll('.poiesis-results__status, time, .poiesis-results__diffstat, .poiesis-results__badges > span') ?? []];
        const rowCenter = node => {
            const bounds = node.getBoundingClientRect();
            return Math.round(bounds.top + bounds.height / 2);
        };
        const metaRows = new Set(metaItems.map(rowCenter)).size;
        const headerRows = new Set([title, ...metaItems].filter(Boolean)
            .map(rowCenter)).size;
        return {
            viewport: { width: innerWidth, height: innerHeight },
            documentWidth: document.documentElement.scrollWidth,
            rail: rect(document.querySelector('.poiesis-agent-window__rail')),
            main: rect(document.querySelector('.poiesis-results__main')),
            taskRail: rect(document.querySelector('.poiesis-results__task-switcher')),
            canvas: rect(document.querySelector('.poiesis-results__canvas')),
            header: rect(header),
            frame: rect(document.querySelector('.poiesis-results__document')),
            title: rect(title),
            metaItems: metaItems.map(rect),
            metaRows,
            headerRows
        };
    });
}

function assertResultsLayout(layout, { label, singleRow }) {
    assert(layout.documentWidth <= layout.viewport.width,
        `${label} introduced horizontal page overflow: ${JSON.stringify(layout)}`);
    assert(layout.rail.width >= 196 && layout.taskRail.width >= 190 && layout.main.width >= 300,
        `${label} collapsed an application-owned content column or side rail: ${JSON.stringify(layout)}`);
    assert(layout.frame.width >= layout.canvas.width - 2,
        `${label} did not preserve the Results document width: ${JSON.stringify(layout)}`);
    assert(layout.title.width >= 80
        && layout.metaItems.every(bounds => bounds.left >= layout.header.left - 1 && bounds.right <= layout.header.right + 1),
    `${label} clipped fixed-header content: ${JSON.stringify(layout)}`);
    if (singleRow) {
        assert(layout.metaRows === 1 && layout.header.height <= 40,
            `${label} did not keep all metadata in one compact row: ${JSON.stringify(layout)}`);
    }
}

async function resultsFrame(page) {
    await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(frame => frame.classList.contains('poiesis-results__document')));
    const handle = await page.$('.poiesis-results__document');
    const frame = await handle?.contentFrame();
    if (!frame) throw new Error('Results iframe was not attached.');
    return frame;
}

async function waitForFinishedResultsContent(page, contentSelector) {
    await page.waitForFunction(() => {
        const preload = document.querySelector('.theia-preload');
        const preloadHidden = !preload || Number.parseFloat(getComputedStyle(preload).opacity) <= 0.01;
        return preloadHidden
            && !document.querySelector('.poiesis-results__generating')
            && Boolean(document.querySelector('.poiesis-results__document'));
    });
    const frame = await resultsFrame(page);
    await frame.waitForSelector(contentSelector);
    await frame.waitForFunction(selector => {
        const content = document.querySelector(selector);
        return document.readyState === 'complete'
            && Boolean(content?.getBoundingClientRect().height);
    }, {}, contentSelector);
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
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

function formatCompactJst(value) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        month: 'numeric', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
        timeZone: 'Asia/Tokyo'
    }).formatToParts(new Date(value));
    const part = type => parts.find(candidate => candidate.type === type)?.value ?? '';
    return `${Number(part('month'))}/${Number(part('day'))} ${part('hour')}:${part('minute')}`;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
