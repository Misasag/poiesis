import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
import {
    DURABLE_REQUIREMENTS_KEY,
    DURABLE_SESSION_KEY,
    DURABLE_SESSION_MIGRATION_KEY,
    readDurableValue,
    updateDurableValue,
    waitForDurableValue,
    waitForDurableWritesToSettle,
    writeDurableValue
} from './poiesis-smoke-state.mjs';

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
    } else if (mode === 'citation') {
        seedCitationDurableState(workspace);
    }
    const diagnostics = [];
    page.on('console', message => {
        const text = message.text();
        if (text.includes('[Poiesis][Results diagnostics]')) diagnostics.push(text);
    });
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);

    if (mode === 'citation') {
        await smokeCitation(page);
        console.log('RESULTS_CITATION_SMOKE_RESULT={"mode":"code","file":"citation-target.txt","line":4}');
    } else if (mode === 'fallback') {
        const responsiveResults = await smokeFallback(page, diagnostics);
        console.log(`RESULTS_FALLBACK_SMOKE_RESULT=${JSON.stringify(responsiveResults)}`);
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
    const sessionId = 'cli-detection-lifecycle-session';
    const taskId = 'cli-detection-lifecycle-seed-task';
    writeSessionFixture({
        version: 1,
        selectedSessionId: sessionId,
        railWidth: 258,
        railCollapsed: false,
        sessions: [{
            id: sessionId,
            createdAt: Date.now() - 60_000,
            updatedAt: Date.now(),
            workspaceUri: pathToFileURL(workspacePath).toString(),
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
            selectedResultsTaskId: taskId,
            resultsDrafts: [],
            tasks: [{
                id: taskId,
                sessionId,
                title: 'Detection fixture result',
                request: 'Keep a Results role control visible.',
                status: 'completed',
                startedAt: now,
                endedAt: now,
                baseline: { kind: 'workspace-snapshot', capturedAt: now },
                changeSet: {
                    source: 'task-diff',
                    diff: 'diff --git a/citation-target.txt b/citation-target.txt\n+ready',
                    files: ['citation-target.txt'],
                    capturedAt: now
                }
            }],
            resultsDocuments: [{
                taskId,
                status: 'ready',
                generator: 'ai',
                providerId: 'grok',
                model: 'grok-4.5',
                effort: 'medium',
                html: '<!doctype html><html lang="ja"><body><main data-detection-fixture><h1>Detection fixture</h1></main></body></html>'
            }]
        }]
    });
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
    }, {
        origin: new URL(applicationUrl).origin,
        settingsWorkspaceUri: new URI(pathToFileURL(workspacePath).toString()).toString()
    });
}

async function smokeCliDetectionUi(page) {
    await page.waitForFunction(() => {
        const picker = document.querySelector('[data-ai-role="agent"]');
        return picker?.dataset.provider === 'claude' && picker?.dataset.model === '';
    });
    const initialAgent = await roleControlSnapshot(page, 'agent');
    assert(initialAgent.text?.includes('確認中')
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

    await waitForDurableValue(theiaConfig, DURABLE_SESSION_KEY, state => {
        const tasks = state?.sessions?.[0]?.tasks ?? [];
        return tasks.length === 2 && tasks.at(-1)?.status === 'completed';
    }, timeout);
    const firstCompletedAt = Date.now();
    const firstCompleted = await lifecyclePersistedSnapshot(page);
    assert(firstCompleted.latestTask?.providerId === 'claude'
        && !firstCompleted.latestTask?.model,
    `First Task did not preserve the CLI-configured default model: ${JSON.stringify(firstCompleted)}`);
    assert(firstCompleted.settings?.agentCli === 'claude'
        && firstCompleted.settings?.agentModel === ''
        && firstCompleted.settings?.resultsCli === 'grok'
        && firstCompleted.settings?.resultsModel === 'grok-4.5'
        && firstCompleted.settings?.resultsEffort === 'medium',
    `Saved role selections changed during detection completion: ${JSON.stringify(firstCompleted.settings)}`);

    await clickTab(page, 'Results');
    await page.waitForSelector('.poiesis-results__document');
    const readyResults = await roleControlSnapshot(page, 'results');
    assert(readyResults.text?.includes('Grok') && readyResults.text.includes('grok-4.5')
        && readyResults.text.includes('標準') && readyResults.text.includes('未検出'),
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
    assert(refreshPendingAgent.text?.includes('確認中') && !refreshPendingAgent.text.includes('未検出')
        && refreshPendingResults.text?.includes('確認中') && !refreshPendingResults.text.includes('未検出'),
    `Role controls reused stale availability during refresh: ${JSON.stringify({ refreshPendingAgent, refreshPendingResults })}`);
    await openSettings(page);
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-settings-modal__cli-status')]
        .some(node => node.textContent?.trim() === '検出に失敗'));
    const failedSettings = await settingsDetectionSnapshot(page);
    assertDetectionStatus(failedSettings, 'error', 'failed refresh');
    assert(failedSettings.agent.model === ''
        && failedSettings.results.model === 'grok-4.5'
        && failedSettings.results.effort === 'medium',
    `Failed refresh changed saved model or effort values: ${JSON.stringify(failedSettings)}`);
    await closeSettings(page);

    const failedAgentRole = await roleControlSnapshot(page, 'agent');
    assert(failedAgentRole.text?.includes('検出失敗'),
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

    await waitForDurableValue(theiaConfig, DURABLE_SESSION_KEY, state => {
        return (state?.sessions?.[0]?.tasks?.length ?? 0) === 3;
    }, timeout);
    const freshTaskStartedAt = Date.now();
    await waitForDurableValue(theiaConfig, DURABLE_SESSION_KEY, state => {
        return state?.sessions?.[0]?.tasks?.at(-1)?.status === 'completed';
    }, timeout);
    const secondCompleted = await lifecyclePersistedSnapshot(page);
    assert(secondCompleted.latestTask?.providerId === 'claude'
        && !secondCompleted.latestTask?.model
        && freshTaskStartedAt - errorSendAt >= 3_500,
    `Error-state send did not perform a delayed fresh runtime check: ${JSON.stringify({ secondCompleted, delay: freshTaskStartedAt - errorSendAt })}`);

    await openSettings(page);
    const retryPendingSettings = await settingsDetectionSnapshot(page);
    assertDetectionStatus(retryPendingSettings, 'pending', 'retry');
    await page.waitForFunction(() => {
        const agent = document.querySelector('input[name="poiesis-agent-cli"][value="claude"]')?.closest('.poiesis-settings-modal__cli-row');
        const results = document.querySelector('input[name="poiesis-results-cli"][value="grok"]')?.closest('.poiesis-settings-modal__cli-row');
        return agent?.querySelector('.poiesis-settings-modal__cli-status')?.textContent?.includes('利用できます')
            && results?.querySelector('.poiesis-settings-modal__cli-status')?.textContent?.trim() === '未検出';
    });
    const retryReadySettings = await settingsDetectionSnapshot(page);
    assertDetectionStatus(retryReadySettings, 'ready', 'retry completion');
    assert(retryReadySettings.agent.model === ''
        && retryReadySettings.results.model === 'grok-4.5'
        && retryReadySettings.results.effort === 'medium',
    `Retry changed saved role selections: ${JSON.stringify(retryReadySettings)}`);
    await closeSettings(page);

    const finalAgent = await roleControlSnapshot(page, 'agent');
    await clickTab(page, 'Results');
    const finalResults = await roleControlSnapshot(page, 'results');
    assert(finalAgent.text?.includes('Claude') && finalAgent.text.includes('既定'),
        `Agent role control lost the completed default model: ${JSON.stringify(finalAgent)}`);
    assert(finalResults.text?.includes('Grok') && finalResults.text.includes('grok-4.5')
        && finalResults.text.includes('標準') && finalResults.text.includes('未検出'),
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
    const selector = `[data-ai-role="${role}"] [aria-label="${label} のモデル"]`;
    await page.waitForSelector(selector);
    return page.$eval(`[data-ai-role="${role}"]`, picker => ({
        value: `provider:${picker.dataset.provider}:${encodeURIComponent(picker.dataset.model ?? '')}`,
        text: picker.textContent?.replace(/\s+/g, ' ').trim(),
        disabled: picker.querySelector('button')?.hasAttribute('disabled'),
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
                model: document.querySelector(`.poiesis-settings-modal [data-ai-role="${roleId}"]`)?.dataset.model,
                effort: document.querySelector(`.poiesis-settings-modal [data-ai-role="${roleId}"] [aria-label="${label}の処理の深さ"]`)?.dataset.value
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
        assert(snapshot.agent.status?.includes('利用できます') && snapshot.results.status === '未検出',
            `${label} did not distinguish found from completed missing: ${JSON.stringify(snapshot)}`);
    }
}

async function agentSendSnapshot(page) {
    const state = readDurableValue(theiaConfig, DURABLE_SESSION_KEY);
    const ui = await page.evaluate(() => ({
        userMessages: document.querySelectorAll('[aria-label="あなたのメッセージ"]').length,
        taskRunning: Boolean(document.querySelector('.poiesis-agent-window__message-state')),
        draft: document.querySelector('[aria-label="Agent へのメッセージ"]')?.value ?? ''
    }));
    return {
        ...ui,
        taskCount: state?.sessions?.[0]?.tasks?.length ?? 0
    };
}

async function lifecyclePersistedSnapshot(page) {
    const sessionState = readDurableValue(theiaConfig, DURABLE_SESSION_KEY);
    const settings = await page.evaluate(() => {
        const settingsKey = Object.keys(localStorage).find(key => key.startsWith('theia:') && key.endsWith(':poiesis.settings.v1'));
        const settingsRaw = settingsKey ? localStorage.getItem(settingsKey) : undefined;
        return settingsRaw ? JSON.parse(settingsRaw) : undefined;
    });
    return {
        latestTask: sessionState?.sessions?.[0]?.tasks?.at(-1),
        settings
    };
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

function seedCitationDurableState(workspacePath) {
    const now = new Date().toISOString();
    const sessionId = 'results-citation-smoke-session';
    const taskId = 'results-citation-smoke-task';
    writeSessionFixture({
        version: 1,
        selectedSessionId: sessionId,
        railWidth: 258,
        railCollapsed: false,
        sessions: [{
            id: sessionId,
            createdAt: Date.now() - 60_000,
            updatedAt: Date.now(),
            workspaceUri: pathToFileURL(workspacePath).toString(),
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
            selectedResultsTaskId: taskId,
            resultsDrafts: [],
            tasks: [{
                id: taskId,
                sessionId,
                title: 'Citation smoke',
                request: 'Open the citation.',
                status: 'completed',
                startedAt: now,
                endedAt: now,
                completionSummary: 'Citation ready.',
                baseline: { kind: 'workspace-snapshot', capturedAt: now },
                changeSet: {
                    source: 'task-diff',
                    diff: 'diff --git a/citation-target.txt b/citation-target.txt\n+four',
                    files: ['citation-target.txt'],
                    capturedAt: now
                }
            }],
            resultsDocuments: [{
                taskId,
                status: 'ready',
                generator: 'ai',
                html: `<!doctype html><html><head><title>Citation</title><style>body {font-family:var(--results-font-sans)}</style></head><body><h2 style="font-family: Georgia, serif">引用先</h2><p>引用先を開けるようにしました。</p><a href="#" id="fixture-citation">citation-target.txt:4</a><script>document.getElementById('fixture-citation').addEventListener('click', event => { event.preventDefault(); window.parent.postMessage({type:'poiesis:open-citation',citation:'citation-target.txt:4'}, '*'); });</script></body></html>`,
                assertions: [
                    { text: '変更ファイルがある場合、本文に根拠引用がある', source: 'skill', status: 'pass' },
                    { text: '空の見出しがない', source: 'skill', status: 'pass' }
                ],
                assertionAttempts: 1
            }]
        }]
    });
}

async function smokeCitation(page) {
    const taskId = 'results-citation-smoke-task';
    await page.waitForSelector('.poiesis-results__document');
    assert(await page.$eval('.poiesis-results__document', frame => frame.srcdoc.includes('Content-Security-Policy')),
        'Results must start with external resources disabled');
    for (const allow of [true, false]) {
        await openSettings(page);
        await page.$$eval('.poiesis-settings-modal__nav button', buttons => buttons.find(button => button.textContent.trim() === 'Results').click());
        const setting = '[aria-label="成果文書の外部リソースを読み込む"]';
        await page.waitForSelector(setting);
        assert(await page.$eval(setting, input => input.checked) === !allow, 'The external-resource toggle must reflect the current setting');
        await page.evaluate(() => { window.resultsFrameBeforeToggle = document.querySelector('.poiesis-results__document'); });
        await page.$eval(setting, input => input.click());
        await page.waitForFunction(allow => {
            const frame = document.querySelector('.poiesis-results__document');
            return frame && frame !== window.resultsFrameBeforeToggle
                && frame.srcdoc.includes('Content-Security-Policy') === !allow;
        }, {}, allow);
        assert(await page.$eval(setting, input => input.checked) === allow, 'The external-resource toggle must retain the new setting');
        await closeSettings(page);
    }
    console.log('RESULTS_EXTERNAL_RESOURCES_SMOKE_RESULT={"default":false,"toggle":true,"frameRemount":true}');
    const persisted = await waitForDurableValue(theiaConfig, DURABLE_SESSION_KEY, state => {
        const session = state?.sessions?.find(candidate => (candidate.tasks ?? []).some(task => task.id === taskId));
        const task = session?.tasks?.find(candidate => candidate.id === taskId);
        const resultDocument = task?.resultsDocument ?? session?.resultsDocuments?.find(candidate => candidate.taskId === taskId);
        return Array.isArray(resultDocument?.assertions) && resultDocument.assertions.length === 2;
    }, timeout);
    const session = persisted?.sessions?.find(candidate => (candidate.tasks ?? []).some(task => task.id === taskId));
    const task = session?.tasks?.find(candidate => candidate.id === taskId);
    const resultDocument = task?.resultsDocument ?? session?.resultsDocuments?.find(candidate => candidate.taskId === taskId);
    await page.click('.poiesis-results__details-trigger');
    await page.waitForSelector('#poiesis-results-details-panel', { visible: true });
    const assertionUi = await page.evaluate(() => ({
        summary: [...document.querySelectorAll('.poiesis-results__details-list > div')]
            .find(row => row.querySelector('dt')?.textContent?.trim() === '成果の生成条件')
            ?.querySelector('dd')?.textContent?.trim(),
        conditions: [...document.querySelectorAll('.poiesis-results__assertion-list[aria-label="成果の生成条件"] li')]
            .map(row => ({ text: row.querySelector('p')?.textContent?.trim(), status: row.getAttribute('data-status') }))
    }));
    const assertionState = {
        ...assertionUi,
        assertions: resultDocument?.assertions,
        attempts: resultDocument?.assertionAttempts
    };
    // The seeded document carries two user-skill conditions.
    assert(assertionState.summary === '2/2 通過'
        && assertionState.conditions.length === 2
        && assertionState.conditions.every((condition, index) => condition.status === 'pass'
            && condition.text === assertionState.assertions[index]?.text)
        && assertionState.assertions?.length === 2
        && assertionState.assertions.every(result => result.source === 'skill' && result.status === 'pass')
        && assertionState.attempts === 1,
    `AI assertion results were not persisted and rendered: ${JSON.stringify(assertionState)}`);
    await page.click('[aria-label="詳細を閉じる"]');
    await page.waitForFunction(() => !document.querySelector('#poiesis-results-details-panel'));
    const frame = await resultsFrame(page);
    await frame.waitForSelector('#fixture-citation');
    const typography = await frame.evaluate(() => ({
        bodyFontFamily: getComputedStyle(document.body).fontFamily,
        headingFontFamily: getComputedStyle(document.querySelector('h2')).fontFamily
    }));
    assert(typography.bodyFontFamily.trim().startsWith('Inter')
        && typography.headingFontFamily.trim().startsWith('Georgia'),
    `The skill typography must survive while theme font variables are available: ${JSON.stringify(typography)}`);
    await frame.click('#fixture-citation');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__content')?.getAttribute('data-mode') === 'code');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'citation-target.txt');
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-agent-window__code-editor-host .line-numbers.active-line-number')]
        .some(line => line.textContent?.trim() === '4'));
}

async function smokeFallback(page, diagnostics) {
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.type('Create fallback-new.html for the results failure smoke.', { delay: 1 });
    await page.waitForFunction(() => !document.querySelector('[aria-label="Agent へ送信"]')?.disabled);
    await page.click('[aria-label="Agent へ送信"]');
    await page.waitForSelector('.poiesis-agent-window__message-state');
    await new Promise(done => setTimeout(done, 1000));
    writeFileSync(resolve(workspace, 'fallback-new.html'), '<!doctype html>\n<title>Failure smoke</title>\n', 'utf8');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__message-state'));
    const persisted = await waitForDurableValue(theiaConfig, DURABLE_SESSION_KEY, state => {
        const task = state?.sessions?.[0]?.tasks?.at(-1);
        return task?.status === 'completed' && task.resultsDocument?.status === 'failed';
    }, timeout);
    const task = persisted.sessions[0].tasks.at(-1);
    assert(!task.resultsDocument.html, 'A generation failure must never create a substitute document.');
    assert(task.resultsDocument.error.includes('テスト用失敗'), 'The failure reason must be persisted.');
    const conversation = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Agent のメッセージ"]')].at(-1)?.querySelector('.poiesis-markdown')?.textContent?.trim());
    assert(conversation === longCompletionReply, 'The completed Agent report must survive a failed Results generation.');
    await page.click('#poiesis-results-tab');
    await page.waitForSelector('.poiesis-results__state.error');
    assert(await page.$('.poiesis-results__document') === null, 'Failed generation must show app chrome, without an iframe.');
    const message = await page.$eval('.poiesis-results__state.error', node => node.textContent);
    assert(message.includes(task.resultsDocument.error) && message.includes('作り直す'), 'The app must show the reason and a working retry control.');
    assert(await page.$('.poiesis-results__fixed-header'), 'The fixed header must remain visible after failure.');
    await page.click('.poiesis-results__details-trigger');
    await page.waitForSelector('#poiesis-results-details-panel');
    assert(await page.$eval('.poiesis-results__verification', node => node.querySelectorAll('tbody tr').length > 0), 'Verification rows must remain in Details.');
    await page.click('[aria-label="詳細を閉じる"]');
    const before = task.resultsDocument.generatedAt;
    await page.$eval('.poiesis-results__state.error button', button => button.click());
    await page.waitForSelector('.poiesis-results__generating');
    await waitForDurableValue(theiaConfig, DURABLE_SESSION_KEY, state => {
        const result = state?.sessions?.[0]?.tasks?.at(-1)?.resultsDocument;
        return result?.status === 'failed' && result.generatedAt !== before;
    }, timeout);
    await page.waitForSelector('.poiesis-results__state.error');
    assert(await page.$('.poiesis-results__document') === null, 'Retry failure must not introduce a template.');
    const contrast = await page.evaluate(() => {
        const luminance = color => {
            const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
                const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const background = luminance(getComputedStyle(document.querySelector('.poiesis-results__canvas')).backgroundColor);
        return ['strong', 'p', 'button'].map(selector => {
            const foreground = luminance(getComputedStyle(document.querySelector('.poiesis-results__state.error ' + selector)).color);
            return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
        });
    });
    assert(contrast.every(ratio => ratio >= 4.5), 'Failure text must remain readable: ' + contrast.join(', '));
    await page.screenshot({ path: standardScreenshotPath });
    await page.setViewport({ width: 1024, height: 720 });
    await page.screenshot({ path: largeScreenshotPath });
    return { reason: true, retry: true, verification: true, contrast, screenshots: [standardScreenshotPath, largeScreenshotPath] };
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
        const actions = [...header?.querySelectorAll('.poiesis-results__toolbar-actions button') ?? []];
        return {
            viewport: { width: innerWidth, height: innerHeight },
            documentWidth: document.documentElement.scrollWidth,
            rail: rect(document.querySelector('.poiesis-agent-window__rail')),
            main: rect(document.querySelector('.poiesis-results__main')),
            canvas: rect(document.querySelector('.poiesis-results__canvas')),
            header: rect(header),
            frame: rect(document.querySelector('.poiesis-results__document')),
            hasCanvasVerification: Boolean(document.querySelector('.poiesis-results__canvas .poiesis-results__verification')),
            answerWarning: document.querySelector('.poiesis-results__answer-warning') ? rect(document.querySelector('.poiesis-results__answer-warning')) : { height: 0 },
            title: rect(title),
            actions: actions.map(rect),
            permanentTaskRail: Boolean(document.querySelector('.poiesis-results__task-switcher')),
            permanentComposer: Boolean(document.querySelector('.poiesis-results__composer'))
        };
    });
}

function assertResultsLayout(layout, { label, minimumFrameHeight }) {
    assert(layout.documentWidth <= layout.viewport.width,
        `${label} introduced horizontal page overflow: ${JSON.stringify(layout)}`);
    assert(layout.rail.width >= 196 && layout.main.width >= 300 && !layout.permanentTaskRail && !layout.permanentComposer,
        `${label} did not preserve the normal Results reading state: ${JSON.stringify(layout)}`);
    assert(layout.main.width === layout.canvas.width && layout.frame.width >= layout.canvas.width - 2,
        `${label} did not preserve the Results document width: ${JSON.stringify(layout)}`);
    assert(layout.title.width >= 80
        && layout.actions.length === 3
        && layout.actions.every(bounds => bounds.left >= layout.header.left - 1 && bounds.right <= layout.header.right + 1)
        && layout.title.right <= layout.actions[0].left - 4,
    `${label} clipped document-toolbar content: ${JSON.stringify(layout)}`);
    assert(!layout.hasCanvasVerification && layout.answerWarning.height <= 100,
        `${label} must keep verification in Details and any warning compact: ${JSON.stringify(layout)}`);
    assert(layout.frame.height >= 220 && layout.frame.height + layout.answerWarning.height >= minimumFrameHeight,
        `${label} did not preserve enough document reading height: ${JSON.stringify(layout)}`);
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

function writeSessionFixture(state) {
    writeDurableValue(theiaConfig, DURABLE_SESSION_KEY, state);
    writeDurableValue(theiaConfig, DURABLE_SESSION_MIGRATION_KEY, true);
}

async function replaceDurableFixtures(page, mutate) {
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    await waitForDurableWritesToSettle(theiaConfig, timeout);
    mutate();
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);
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
