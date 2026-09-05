import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const runtimeDir = resolve(root, '.electron-runtime');
const userDataDir = resolve(runtimeDir, `user-data-${Date.now()}`);
const debugPort = Number(process.env.THEIA_ELECTRON_DEBUG_PORT ?? 9334);
const browserURL = `http://127.0.0.1:${debugPort}`;
const uiTimeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const round12ScreenshotDirectory = resolve(root, '_codex', 'round12-screenshots');
const round12StandardScreenshotPath = resolve(round12ScreenshotDirectory, 'results-electron-1280x720-standard.png');
const round12LargeScreenshotPath = resolve(round12ScreenshotDirectory, 'results-electron-1024x720-large.png');
const windowDragOnly = process.env.POIESIS_WINDOW_DRAG_ONLY === '1';
const customizeWindowOnly = process.env.POIESIS_CUSTOMIZE_WINDOW_ONLY === '1';
const settingsWindowOnly = process.env.POIESIS_SETTINGS_WINDOW_ONLY === '1';
const composerOnly = process.env.POIESIS_COMPOSER_ONLY === '1';
const taskFeedbackOnly = process.env.POIESIS_TASK_FEEDBACK_ONLY === '1';
const noChangeOnly = process.env.POIESIS_NO_CHANGE_ONLY === '1';
const modalWindowOnly = customizeWindowOnly || settingsWindowOnly || composerOnly;
const lightweightElectron = windowDragOnly || modalWindowOnly;
const interactionOnly = modalWindowOnly || taskFeedbackOnly || noChangeOnly;
mkdirSync(runtimeDir, { recursive: true });
if (taskFeedbackOnly) mkdirSync(round12ScreenshotDirectory, { recursive: true });
const emptyPluginsDir = resolve(runtimeDir, 'empty-plugins');
if (lightweightElectron) mkdirSync(emptyPluginsDir, { recursive: true });

const repositoryRoot = root;
const scmFixtureGitPath = 'docs/UX.md';
const scmFixturePath = resolve(repositoryRoot, scmFixtureGitPath);
const scmFixtureOriginal = readFileSync(scmFixturePath, 'utf8');
const scmFixtureMarker = '<!-- Poiesis SCM smoke change -->';
if (scmFixtureOriginal.includes(scmFixtureMarker)) {
    throw new Error('SCM smoke fixture still contains a marker from an interrupted test.');
}
const terminalFixturePath = resolve(runtimeDir, 'terminal-smoke.txt');
const agentTestFixturePath = resolve(repositoryRoot, 'round11-task-feedback-smoke.txt');
if ((taskFeedbackOnly || noChangeOnly) && existsSync(agentTestFixturePath)) throw new Error('Agent test fixture already exists.');
removeTerminalFixture();

const electronExecutable = resolve(root, 'node_modules/electron/dist/electron.exe');
const startProcess = spawn(electronExecutable, [
    resolve(root, 'electron-app'),
    '..',
    lightweightElectron
        ? `--plugins=local-dir:${emptyPluginsDir.replaceAll('\\', '/')}`
        : '--plugins=local-dir:../plugins',
    `--user-data-dir=${userDataDir}`,
    `--electronUserData=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox'
], {
    cwd: resolve(root, 'electron-app'),
    env: {
        ...process.env,
        THEIA_CONFIG_DIR: resolve(root, '.theia-config-electron'),
        ...(lightweightElectron ? { POIESIS_DISABLE_CLI_DETECTION: '1' } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Native drag regions need a real visible Win32 window; a hidden renderer
    // also stalls Theia's startup animationFrame before Poiesis is mounted.
    windowsHide: false
});

let startLog = '';
for (const stream of [startProcess.stdout, startProcess.stderr]) {
    stream?.on('data', chunk => {
        const text = chunk.toString();
        startLog = `${startLog}${text}`.slice(-40_000);
        process.stdout.write(text);
    });
}

let browser;
try {
    smokeRun: {
    writeFileSync(scmFixturePath, `${scmFixtureOriginal}\n${scmFixtureMarker}\n`, 'utf8');
    await waitForCdp(browserURL, startProcess, 120_000);
    browser = await puppeteer.connect({ browserURL, defaultViewport: null });
    const page = await findWorkbenchPage(browser, uiTimeout);
    const reactUnmountWarnings = [];
    page.on('console', message => {
        if (message.text().includes('Attempted to synchronously unmount a root')) {
            reactUnmountWarnings.push(message.text());
        }
    });
    await page.bringToFront();
    await page.evaluate(() => window.focus());
    page.setDefaultTimeout(uiTimeout);
    await page.bringToFront();
    await page.evaluate(() => window.focus());
    await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content', { timeout: uiTimeout });
    await page.waitForSelector('.poiesis-agent-window__agent', { timeout: uiTimeout });
    await page.waitForSelector('.poiesis-agent-window__rail', { timeout: uiTimeout });

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const windowTitle = await page.title();
    const initial = await page.evaluate(readPoiesisState);
    assert(userAgent.includes('Electron/'), `Expected Electron user agent, got ${userAgent}`);
    assert(initial.mode === 'agent', `Expected Agent mode, got ${initial.mode}`);
    assert(initial.agentComposerVisible, 'Agent Composer is missing in Electron');
    assert(initial.sessionRailVisible, 'Session rail is missing in Electron');
    assert(!initial.legacyChangesVisible, 'Removed Changes UI is still visible in Electron');

    const resizeChecks = [];
    const nativeWindowChecks = [];
    const nativeControlChecks = [];
    const aiPillChecks = [];
    moveElectronWindow(startProcess.pid, 1024, 600);
    resizeChecks.push(await assertElectronLayout(page, 'agent'));
    const minimumSizeCheck = assertNativeMinimumWindowSize(startProcess.pid);
    assert(minimumSizeCheck.width >= 1024 && minimumSizeCheck.height >= 600,
        `Electron allowed an OS resize below 1024x600: ${JSON.stringify(minimumSizeCheck)}`);
    moveElectronWindow(startProcess.pid, 1280, 720);
    resizeChecks.push(await assertElectronLayout(page, 'agent'));
    if (!interactionOnly) {
        nativeWindowChecks.push(await assertNativeWindowDrag(page, startProcess.pid,
            '.poiesis-agent-window__header', 'Agent header'));
        if (!windowDragOnly) {
            nativeWindowChecks.push(await assertNativeWindowDrag(page, startProcess.pid,
                '.poiesis-agent-window__rail-top', 'session rail top'));
        }
        nativeWindowChecks.push(await assertNativeHeaderDoubleClick(page, startProcess.pid));
        nativeWindowChecks.push(await assertNativeWindowDrag(page, startProcess.pid,
            '.poiesis-agent-window__header', 'Agent header after maximize and restore'));
    }
    if (windowDragOnly) {
        nativeControlChecks.push(await assertNativeWindowControl(page, startProcess.pid, 'minimize', 'initial'));
        nativeControlChecks.push(await assertNativeWindowControl(page, startProcess.pid, 'maximize', 'initial'));
        nativeControlChecks.push(await assertNativeWindowControl(page, startProcess.pid, 'restore', 'initial'));

        const titlePoint = await nativeElementPoint(page, '.poiesis-agent-window__context > strong');
        assert(titlePoint.appRegion === 'drag', `Title is not a native drag region: ${JSON.stringify(titlePoint)}`);
        nativeWindowChecks.push(await assertNativeWindowDragAtPoint(page, startProcess.pid, titlePoint, 'Agent title'));

        moveElectronWindow(startProcess.pid, 1100, 700);
        await assertElectronLayout(page, 'agent');
        aiPillChecks.push(await assertElectronAiPillPopover(page, 'after resize'));
        nativeControlChecks.push(await assertNativeWindowControl(page, startProcess.pid, 'minimize', 'after resize'));
        nativeControlChecks.push(await assertNativeWindowControl(page, startProcess.pid, 'maximize', 'after resize'));
        aiPillChecks.push(await assertElectronAiPillPopover(page, 'maximized'));
        nativeControlChecks.push(await assertNativeWindowControl(page, startProcess.pid, 'restore', 'after maximize/restore'));

        await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
        await page.waitForSelector('.poiesis-settings-modal');
        nativeControlChecks.push(await assertNativeWindowControl(page, startProcess.pid, 'minimize', 'settings open'));
        nativeControlChecks.push(await assertNativeWindowControl(page, startProcess.pid, 'maximize', 'settings open'));
        nativeControlChecks.push(await assertNativeWindowControl(page, startProcess.pid, 'restore', 'settings open'));
        assert(await page.$('.poiesis-settings-modal'), 'Settings modal disappeared during native window controls');

        nativeControlChecks.push(await assertNativeWindowControl(page, startProcess.pid, 'close', 'settings open'));
        await waitForProcessExit(startProcess, 10_000);
        console.log(`ELECTRON_WINDOW_CONTROL_SMOKE_RESULT=${JSON.stringify({
            userAgent,
            windowTitle,
            nativeWindowChecks,
            nativeControlChecks,
            aiPillChecks
        }, null, 2)}`);
        break smokeRun;
    }
    moveElectronWindow(startProcess.pid, 1024, 600);
    resizeChecks.push(await assertElectronLayout(page, 'agent'));
    moveElectronWindow(startProcess.pid, 1500, 850);
    resizeChecks.push(await assertElectronLayout(page, 'agent'));
    await page.click('.poiesis-window-controls__button[data-window-action="maximize"]');
    await page.waitForSelector('.poiesis-window-controls__button[data-window-action="restore"]');
    resizeChecks.push(await assertElectronLayout(page, 'agent'));
    await page.click('.poiesis-window-controls__button[data-window-action="restore"]');
    await page.waitForSelector('.poiesis-window-controls__button[data-window-action="maximize"]');
    resizeChecks.push(await assertElectronLayout(page, 'agent'));

    const minimumSurfaceChecks = {};
    if (taskFeedbackOnly) {
        await page.type('.poiesis-agent-window__composer textarea', 'Show elapsed task feedback.');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.poiesis-agent-window__message-state [role="timer"]');
        const initialElapsed = await page.$eval('.poiesis-agent-window__message-state [role="timer"]', node => node.textContent?.trim());
        await new Promise(resolveDelay => setTimeout(resolveDelay, 1_200));
        const updatedElapsed = await page.$eval('.poiesis-agent-window__message-state [role="timer"]', node => node.textContent?.trim());
        assert(initialElapsed?.includes('Agent を起動しています') || initialElapsed?.includes('応答を待っています'),
            `Initial live status is missing: ${initialElapsed}`);
        assert(updatedElapsed && updatedElapsed !== initialElapsed,
            `Elapsed feedback did not update every second: ${JSON.stringify({ initialElapsed, updatedElapsed })}`);
        await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-activity__row').length >= 3
            && !document.querySelector('.poiesis-agent-window__composer textarea')?.disabled);
        const runningActivityRows = await page.$$eval('.poiesis-agent-activity__row', nodes => nodes.length);
        const composerEnabledDuringRun = await page.$eval(
            '.poiesis-agent-window__composer textarea', input => !input.disabled
        );
        assert(runningActivityRows >= 3, `Agent activity rows are missing during the run: ${runningActivityRows}`);
        assert(composerEnabledDuringRun, 'Agent Composer textarea is disabled during the run');
        await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__message-state [role="timer"]')
            ?.textContent?.includes('成果を作成しています'));
        const finalizingStatus = await page.$eval(
            '.poiesis-agent-window__message-state [role="timer"]', node => node.textContent?.trim()
        );
        assert(finalizingStatus?.startsWith('成果を作成しています · ')
            && !finalizingStatus.includes('最終出力')
            && !finalizingStatus.includes('60秒以上出力がありません'),
        `Finalizing status is misleading: ${JSON.stringify(finalizingStatus)}`);
        assert(!await page.$('.poiesis-agent-window__message-state .poiesis-agent-window__diagnostics'),
            'Run diagnostics remained visible while Results were finalizing.');
        await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__message-state [role="timer"]'));
        await page.waitForSelector('.poiesis-agent-activity__summary');
        const activitySummary = await page.$eval('.poiesis-agent-activity__summary', node => node.textContent?.trim() ?? '');
        assert(activitySummary.includes('作業ログ') && activitySummary.includes('コマンド 1'),
            `Collapsed activity summary is incomplete: ${activitySummary}`);
        const completion = await page.$eval('[aria-label="Agent のメッセージ"]:last-of-type .poiesis-markdown',
            node => node.textContent?.trim() ?? '');
        assert(completion === process.env.POIESIS_AGENT_TEST_REPLY
            && !completion.includes('詳細は Results を確認してください')
            && !completion.includes('変更ファイル: なし'),
        `Agent completion was not preserved verbatim: ${JSON.stringify(completion)}`);
        assert(await page.$('.poiesis-agent-window__diffstat-chip'), 'Changed-file diffstat chip is missing.');
        await installRound12DenseResultsFixture(page);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
        await page.waitForSelector('.poiesis-results__document');

        await settleElectronWindowSize(page, startProcess.pid, 1280, 720);
        await waitForFinishedElectronResults(page);
        const resultsStandard = await assertElectronResultsHeader(page, '1280x720 standard', true);
        await page.screenshot({ path: round12StandardScreenshotPath });

        await setElectronUiFontScale(page, 'large');
        await settleElectronWindowSize(page, startProcess.pid, 1024, 720);
        await waitForFinishedElectronResults(page);
        const resultsLarge = await assertElectronResultsHeader(page, '1024x720 large', false);
        await page.screenshot({ path: round12LargeScreenshotPath });

        await page.click('.poiesis-window-controls__button[data-window-action="maximize"]');
        await page.waitForSelector('.poiesis-window-controls__button[data-window-action="restore"]');
        const resultsMaximized = await assertElectronResultsHeader(page, 'maximized large', true);
        await page.click('.poiesis-window-controls__button[data-window-action="restore"]');
        await page.waitForSelector('.poiesis-window-controls__button[data-window-action="maximize"]');
        const resultsRestored = await assertElectronResultsHeader(page, 'restored 1024x720 large', false);
        console.log(`ELECTRON_TASK_FEEDBACK_SMOKE_RESULT=${JSON.stringify({
            elapsedVisible: true,
            elapsedUpdated: true,
            finalizingStatus,
            runningActivityRows,
            composerEnabledDuringRun,
            activitySummaryVisible: true,
            resultsStandard,
            resultsLarge,
            resultsMaximized,
            resultsRestored,
            screenshots: [round12StandardScreenshotPath, round12LargeScreenshotPath]
        })}`);
        break smokeRun;
    }
    if (noChangeOnly) {
        await page.type('.poiesis-agent-window__composer textarea', 'Answer without changing files.');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.poiesis-agent-window__task-state');
        await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__task-state'));
        await page.waitForFunction(() => {
            const raw = localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1');
            const state = raw ? JSON.parse(raw) : undefined;
            return state?.sessions?.[0]?.tasks?.at(-1)?.status === 'completed';
        });
        const noChange = await page.evaluate(() => {
            const raw = localStorage.getItem('poiesis:global:poiesis.agent-window.sessions.global.v1');
            const state = raw ? JSON.parse(raw) : undefined;
            const task = state?.sessions?.[0]?.tasks?.at(-1);
            return {
                task,
                conversation: [...document.querySelectorAll('[aria-label="Agent のメッセージ"]')]
                    .at(-1)?.querySelector('.poiesis-markdown')?.textContent?.trim() ?? ''
            };
        });
        assert(noChange.task?.changeSet?.files?.length === 0 && !noChange.task?.changeSet?.diff,
            `No-change Task captured unexpected changes: ${JSON.stringify(noChange.task?.changeSet)}`);
        assert(!noChange.task?.resultsDocument, 'No-change Task received a Results document.');
        assert(noChange.conversation === process.env.POIESIS_AGENT_TEST_REPLY,
            `No-change reply was not preserved verbatim: ${JSON.stringify(noChange.conversation)}`);
        await page.click('#poiesis-results-tab');
        await page.waitForSelector('.poiesis-results');
        assert(await page.$$eval('.poiesis-results__requirement-card', nodes => nodes.length) === 0,
            'No-change Task created a Results requirement card.');
        assert(await page.$$eval('.poiesis-results__document', nodes => nodes.length) === 0,
            'No-change Task created a Results document frame.');
        console.log('ELECTRON_NO_CHANGE_SMOKE_RESULT={"requirementCards":0,"resultsDocuments":0}');
        break smokeRun;
    }
    if (settingsWindowOnly || composerOnly) {
        await page.type('.poiesis-agent-window__composer textarea',
            'Keep this deliberately long Electron smoke message inside the fluid conversation column at 1024 by 600.');
        const messageCountBeforeCompositionEnter = await page.$$eval('.poiesis-agent-window__user-message', nodes => nodes.length);
        const dispatchComposerEnter = async ({ isComposing, keyCode }) => {
            await page.$eval('.poiesis-agent-window__composer textarea', (input, eventInit) => {
                const event = new KeyboardEvent('keydown', {
                    key: 'Enter',
                    bubbles: true,
                    cancelable: true
                });
                Object.defineProperty(event, 'isComposing', { value: eventInit.isComposing });
                Object.defineProperty(event, 'keyCode', { value: eventInit.keyCode });
                input.dispatchEvent(event);
            }, { isComposing, keyCode });
            await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
        };
        await dispatchComposerEnter({ isComposing: true, keyCode: 13 });
        await dispatchComposerEnter({ isComposing: false, keyCode: 229 });
        assert(await page.$$eval('.poiesis-agent-window__user-message', nodes => nodes.length) === messageCountBeforeCompositionEnter,
            'IME confirmation Enter submitted the Agent Composer');
        await page.focus('.poiesis-agent-window__composer textarea');
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        assert((await page.$eval('.poiesis-agent-window__composer textarea', input => input.value)).endsWith('\n'),
            'Shift+Enter did not insert an Agent Composer newline');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__user-message').length === 1
            && document.querySelectorAll('.poiesis-agent-window__message').length >= 1
            && !document.querySelector('.poiesis-agent-window__message-state'));
        minimumSurfaceChecks.composerKeyboard = {
            enterSubmitted: true,
            shiftEnterInsertedNewline: true,
            composingEnterBlocked: true,
            keyCode229Blocked: true
        };
        if (composerOnly) {
            console.log(`ELECTRON_COMPOSER_SMOKE_RESULT=${JSON.stringify(minimumSurfaceChecks.composerKeyboard)}`);
            break smokeRun;
        }
        await settleElectronWindowSize(page, startProcess.pid, 1024, 600);
        minimumSurfaceChecks.agentWithMessages = await assertElectronLayout(page, 'agent');
        await page.click('#poiesis-results-tab');
        await page.waitForSelector('.poiesis-results');
        minimumSurfaceChecks.results = await assertElectronLayout(page, 'results');
        await page.click('#poiesis-agent-tab');
        await page.waitForSelector('.poiesis-agent-window__agent');
    }

    const headerInteractionChecks = [];
    if (windowDragOnly) {
        await page.type('.poiesis-agent-window__composer textarea', 'Window drag smoke conversation');
        await page.click('.poiesis-agent-window__send');
        await page.waitForSelector('.poiesis-agent-window__tabs');
        await page.click('#poiesis-results-tab');
        await page.waitForFunction(() => document.querySelector('#poiesis-results-tab')?.getAttribute('aria-selected') === 'true');
        await page.click('#poiesis-agent-tab');
        await page.waitForFunction(() => document.querySelector('#poiesis-agent-tab')?.getAttribute('aria-selected') === 'true');
        const tabRegions = await page.$$eval('.poiesis-agent-window__tabs [role="tab"]', tabs => tabs.map(tab => ({
            label: tab.textContent?.trim(),
            appRegion: getComputedStyle(tab).getPropertyValue('app-region')
                || getComputedStyle(tab).getPropertyValue('-webkit-app-region')
        })));
        assert(tabRegions.length === 2 && tabRegions.every(tab => tab.appRegion === 'no-drag'),
            `Agent/Results tabs are not interactive no-drag regions: ${JSON.stringify(tabRegions)}`);
        headerInteractionChecks.push({ label: 'Agent/Results tabs', clicked: true, tabRegions });
    }

    await clickByText(page, '.poiesis-agent-window__code-control', 'Code');
    await page.waitForSelector('.poiesis-agent-window__code', { timeout: uiTimeout });
    await page.waitForSelector('#files .theia-FileStatNode', { timeout: uiTimeout });
    await page.waitForFunction(() => Boolean(document.querySelector('.poiesis-agent-window__code-terminal-host > *')), {
        timeout: uiTimeout
    });

    const code = await page.evaluate(readPoiesisState);
    assert(code.mode === 'code', `Expected Code mode, got ${code.mode}`);
    assert(code.codeSidebarVisible, 'Code sidebar is missing in Electron');
    assert(code.codeEditorVisible, 'Code editor is missing in Electron');
    assert(code.codeActivityVisible, 'Code Activity Bar is missing in Electron');
    assert(code.codeTerminalVisible, 'Code terminal is missing in Electron');
    assert(code.codeStatusVisible, 'Code status bar is missing in Electron');
    assert(code.codeLuminoPanelCount === 0, 'Code reintroduced lm-Widget lm-Panel wrappers in Electron');
    assert(code.codeLuminoTabContainerCount === 0, 'Code reintroduced lm-TabBar-content-container in Electron');
    assert(!code.applicationShellVisible, 'Code mounted the Theia ApplicationShell in Electron');
    if (settingsWindowOnly) {
        await settleElectronWindowSize(page, startProcess.pid, 1024, 600);
        minimumSurfaceChecks.code = await assertElectronLayout(page, 'code');
    }
    if (!modalWindowOnly) {
        nativeWindowChecks.push(await assertNativeWindowDrag(page, startProcess.pid,
            '.poiesis-agent-window__code-header', 'Code header'));
    }
    if (lightweightElectron) {
        let binaryDialogCheck;
        if (settingsWindowOnly) {
            await expandExplorerDirectory(page, 'spikes');
            await expandExplorerDirectory(page, 'theia');
            await expandExplorerDirectory(page, 'electron-app');
            await expandExplorerDirectory(page, 'resources');
            await revealExplorerFile(page, 'poiesis.png', 'end');
            await clickExplorerFile(page, 'poiesis.png');
            await page.waitForSelector('.lm-Widget.dialogOverlay .dialogBlock');
            binaryDialogCheck = await page.evaluate(() => {
                const overlay = document.querySelector('.lm-Widget.dialogOverlay');
                const block = overlay?.querySelector('.dialogBlock');
                if (!(overlay instanceof HTMLElement) || !(block instanceof HTMLElement)) return undefined;
                const blockStyle = getComputedStyle(block);
                return {
                    title: overlay.querySelector('.dialogTitle')?.textContent?.trim(),
                    content: overlay.querySelector('.dialogContent')?.textContent?.trim(),
                    buttons: [...overlay.querySelectorAll('.dialogControl button')].map(button => button.textContent?.trim()),
                    background: blockStyle.backgroundColor,
                    borderRadius: blockStyle.borderRadius
                };
            });
            assert(binaryDialogCheck?.content.includes('このファイルはバイナリ、または未対応のエンコーディングです。開きますか？')
                && binaryDialogCheck.buttons.includes('開く') && binaryDialogCheck.buttons.includes('キャンセル')
                && binaryDialogCheck.background === 'rgb(29, 30, 28)' && binaryDialogCheck.borderRadius === '12px',
            `Binary-file dialog is not Poiesis-localized and themed: ${JSON.stringify(binaryDialogCheck)}`);
            await clickByText(page, '.lm-Widget.dialogOverlay .dialogControl button', 'キャンセル');
            await page.waitForFunction(() => !document.querySelector('.lm-Widget.dialogOverlay'));
        }
        await clickByText(page, '.poiesis-agent-window__code-control', 'Code');
        await page.waitForSelector('.poiesis-agent-window__agent');
        const surfaceSelector = settingsWindowOnly ? '.poiesis-settings-modal' : '.poiesis-customize-view';
        if (settingsWindowOnly) {
            await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
        } else {
            await page.click('.poiesis-agent-window__rail-action[title="カスタマイズ"]');
        }
        await page.waitForSelector(surfaceSelector);
        const settingsToggleCheck = settingsWindowOnly
            ? await assertSettingsToggleKeepsLayout(page)
            : undefined;
        if (customizeWindowOnly) {
            await clickByText(page, '.poiesis-customize-view__text-button', '新しいSkill');
            await page.click('[aria-label="新しいSkillの種類"]');
            await page.waitForSelector('.poiesis-select__listbox');
        }
        moveElectronWindow(startProcess.pid, 1024, 600);
        const modalWindowChecks = {
            resized: await assertElectronLayout(page, settingsWindowOnly ? 'agent' : 'customize', settingsWindowOnly)
        };
        if (customizeWindowOnly) {
            modalWindowChecks.dropdownResized = await assertPoiesisSelectUnclipped(page, 'Customize dropdown after resize');
        }
        await page.click('.poiesis-window-controls__button[data-window-action="maximize"]');
        await page.waitForSelector('.poiesis-window-controls__button[data-window-action="restore"]');
        modalWindowChecks.maximized = await assertElectronLayout(page, settingsWindowOnly ? 'agent' : 'customize', settingsWindowOnly);
        if (customizeWindowOnly) {
            await page.click('[aria-label="新しいSkillの種類"]');
            await page.waitForSelector('.poiesis-select__listbox');
            modalWindowChecks.dropdownMaximized = await assertPoiesisSelectUnclipped(page, 'Customize dropdown after maximize');
        }
        await page.click('.poiesis-window-controls__button[data-window-action="restore"]');
        await page.waitForSelector('.poiesis-window-controls__button[data-window-action="maximize"]');
        modalWindowChecks.restored = await assertElectronLayout(page, settingsWindowOnly ? 'agent' : 'customize', settingsWindowOnly);
        if (customizeWindowOnly) {
            await page.click('[aria-label="新しいSkillの種類"]');
            await page.waitForSelector('.poiesis-select__listbox');
            modalWindowChecks.dropdownRestored = await assertPoiesisSelectUnclipped(page, 'Customize dropdown after restore');
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !document.querySelector('.poiesis-select__listbox'));
            await page.click('.poiesis-agent-window__rail-action[title="カスタマイズ"]');
        } else {
            await page.keyboard.press('Escape');
        }
        await page.waitForFunction(selector => !document.querySelector(selector), {}, surfaceSelector);
        const serializedResult = JSON.stringify({
            userAgent,
            windowTitle,
            nativeWindowChecks,
            minimumSizeCheck,
            minimumSurfaceChecks,
            headerInteractionChecks,
            settingsToggleCheck,
            binaryDialogCheck,
            modal: settingsWindowOnly ? 'settings' : 'customize',
            modalWindowChecks,
            code
        }, null, 2);
        console.log(settingsWindowOnly
            ? `ELECTRON_SETTINGS_WINDOW_SMOKE_RESULT=${serializedResult}`
            : customizeWindowOnly
                ? `ELECTRON_CUSTOMIZE_WINDOW_SMOKE_RESULT=${serializedResult}`
                : `ELECTRON_WINDOW_DRAG_SMOKE_RESULT=${serializedResult}`);
        break smokeRun;
    }
    moveElectronWindow(startProcess.pid, 1024, 600);
    resizeChecks.push(await assertElectronLayout(page, 'code'));
    moveElectronWindow(startProcess.pid, 1500, 850);
    resizeChecks.push(await assertElectronLayout(page, 'code'));

    await page.waitForSelector('.poiesis-agent-window__code-terminal-host .xterm-helper-textarea', { timeout: uiTimeout });
    assert(await page.$('.poiesis-agent-window__code-terminal-select [aria-label="選択中の Terminal"]'),
        'Active Terminal selector is missing in Electron');
    const firstTerminalId = await page.$eval('.poiesis-agent-window__code-terminal-host > *', element => element.id);
    await page.focus('.poiesis-agent-window__code-terminal-host .xterm-helper-textarea');
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
    await page.keyboard.type(`echo poiesis-terminal-smoke>"${terminalFixturePath}"`);
    await page.keyboard.press('Enter');
    for (let attempt = 0; attempt < 100 && !existsSync(terminalFixturePath); attempt++) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    assert(existsSync(terminalFixturePath) && readFileSync(terminalFixturePath, 'utf8').trim() === 'poiesis-terminal-smoke',
        'Terminal command did not write its Electron output fixture');
    removeTerminalFixture();
    if (taskFeedbackOnly) removeAgentTestFixture();

    const terminalPanelHeight = await page.$eval('.poiesis-agent-window__code-panel', element => Math.round(element.getBoundingClientRect().height));
    await page.focus('.poiesis-agent-window__code-panel-resize');
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(height => Math.round(document.querySelector('.poiesis-agent-window__code-panel')?.getBoundingClientRect().height ?? 0) === height + 12,
        {}, terminalPanelHeight);
    await page.$eval('.poiesis-agent-window__code-panel-tabs button[aria-label="新しい Terminal"]', element => element.click());
    try {
        await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-terminal-select')?.dataset.optionCount === '2');
    } catch (error) {
        const terminalState = await page.evaluate(() => ({
            activeHostIds: [...document.querySelectorAll('.poiesis-agent-window__code-terminal-host > *')]
                .map(element => element.id),
            selectedId: document.querySelector('.poiesis-agent-window__code-terminal-select')?.dataset.value,
            optionCount: document.querySelector('.poiesis-agent-window__code-terminal-select')?.dataset.optionCount
        }));
        throw new Error(`New Terminal was not registered in Electron: ${JSON.stringify(terminalState)}`, { cause: error });
    }
    const secondTerminalId = await page.$eval('.poiesis-agent-window__code-terminal-host > *', element => element.id);
    assert(secondTerminalId && secondTerminalId !== firstTerminalId, 'New Terminal did not expose a distinct Electron terminal option');
    const activeTerminalId = await page.$eval('.poiesis-agent-window__code-terminal-host > *', element => element.id);
    if (activeTerminalId !== secondTerminalId) {
        await choosePoiesisSelect(page, '.poiesis-agent-window__code-terminal-select .poiesis-select__trigger', secondTerminalId);
    }
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, secondTerminalId);
    await choosePoiesisSelect(page, '.poiesis-agent-window__code-terminal-select .poiesis-select__trigger', firstTerminalId);
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);
    await page.$eval('.poiesis-agent-window__code-panel-tabs button[aria-label="パネルを閉じる"]', element => element.click());
    await page.waitForSelector('.poiesis-agent-window__code-status button[aria-label="パネルを切り替える"][aria-expanded="false"]');
    assert(!await page.$('.poiesis-agent-window__code-panel'), 'Close Panel must hide the Electron Terminal panel');
    await page.$eval('.poiesis-agent-window__code-status button[aria-label="パネルを切り替える"]', element => element.click());
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);
    await page.keyboard.down('Control');
    await page.keyboard.press('Backquote');
    await page.keyboard.up('Control');
    await page.waitForSelector('.poiesis-agent-window__code-status button[aria-label="パネルを切り替える"][aria-expanded="false"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('Backquote');
    await page.keyboard.up('Control');
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);
    await choosePoiesisSelect(page, '.poiesis-agent-window__code-terminal-select .poiesis-select__trigger', secondTerminalId);
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, secondTerminalId);
    await page.$eval('.poiesis-agent-window__code-panel-tabs button[aria-label="Terminal を終了"]', element => element.click());
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-select')?.dataset.optionCount === '1'
        && document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);

    while (await page.$('.poiesis-agent-window__code-editor-tab-close')) {
        const count = await page.$$eval('.poiesis-agent-window__code-editor-tab', tabs => tabs.length);
        await page.$eval('.poiesis-agent-window__code-editor-tab-close', element => element.click());
        await page.waitForFunction(previous => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length < previous, {}, count);
    }

    await page.$eval('.poiesis-agent-window__code-activity button[aria-label="Search"]', element => element.click());
    await page.waitForSelector('#search-input-field', { timeout: uiTimeout });
    await page.waitForFunction(() => document.activeElement?.id === 'search-input-field');
    for (const label of ['検索結果を更新', '検索結果をクリア', '検索結果をすべて折りたたむ']) {
        assert(await page.$(`.poiesis-agent-window__code-sidebar-actions button[aria-label="${label}"]`), `Search action is missing in Electron: ${label}`);
    }
    await page.$eval('.poiesis-agent-window__code-sidebar-actions button[aria-label="検索結果をクリア"]', element => element.click());
    await page.focus('#search-input-field');
    const codeSearchQuery = ['Source contract', 'validation passed.'].join(' ');
    await page.type('#search-input-field', codeSearchQuery);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#search-in-workspace .search-info')?.textContent?.includes('2 results in 2 files'));
    await page.$eval('.poiesis-agent-window__code-sidebar-actions button[aria-label="検索結果をクリア"]', element => element.click());
    await page.waitForFunction(() => document.querySelector('#search-input-field')?.value === ''
        && document.querySelectorAll('#search-in-workspace .theia-TreeNode').length === 0);

    await page.$eval('.poiesis-agent-window__code-activity button[aria-label="Source Control"]', element => element.click());
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Source Control');
    await page.waitForSelector('.poiesis-agent-window__code-sidebar-actions button[aria-label="Source Control を更新"]');
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-title[aria-expanded="true"]');
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-host #scm-history-graph-widget');
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-host .scm-history-graph-row svg');
    assert(!await page.$('.poiesis-agent-window__code .lm-Widget.lm-Panel'), 'Source Control Graph restored a Lumino panel in Electron');
    await page.$eval('.poiesis-agent-window__code-git-graph-title', element => element.click());
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-title[aria-expanded="false"]');
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-host[hidden]');
    await page.$eval('.poiesis-agent-window__code-git-graph-title', element => element.click());
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-host:not([hidden])');
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-host .scm-history-graph-row');
    await page.$eval('.poiesis-agent-window__code-sidebar-actions button[aria-label="Source Control を更新"]', element => element.click());
    await waitForScmAction(page, 'UX.md', 'Stage Changes');
    await hoverScmResource(page, 'UX.md');
    for (const action of ['Open File', 'Discard Changes', 'Stage Changes']) {
        assert(await scmActionExists(page, 'UX.md', action), `Source Control action is missing in Electron: ${action}`);
    }
    await executeScmAction(page, 'UX.md', 'Stage Changes', 'staged');
    await page.$eval('.poiesis-agent-window__code-sidebar-actions button[aria-label="Source Control を更新"]', element => element.click());
    await waitForScmAction(page, 'UX.md', 'Unstage Changes');
    await executeScmAction(page, 'UX.md', 'Unstage Changes', 'unstaged');
    await page.$eval('.poiesis-agent-window__code-sidebar-actions button[aria-label="Source Control を更新"]', element => element.click());
    await waitForScmAction(page, 'UX.md', 'Stage Changes');
    restoreScmFixture();

    await page.$eval('.poiesis-agent-window__code-activity button[aria-label="Extensions"]', element => element.click());
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Extensions');
    await page.waitForSelector('.poiesis-agent-window__code-sidebar-host > *', { timeout: uiTimeout });
    await page.waitForFunction(() => document.querySelector('#vsx-extensions-search-bar input')?.value === '@builtin');
    await page.waitForFunction(() => (document.getElementById('vsx-extensions:builtin')?.querySelectorAll('.theia-TreeNode').length ?? 0) > 0);
    assert(!await page.$('.poiesis-agent-window__customize-page'), 'Code Extensions opened Poiesis Customize in Electron');
    assert(reactUnmountWarnings.length === 0,
        `Code widget transitions synchronously unmounted a React root in Electron: ${reactUnmountWarnings.join('\n')}`);

    await page.$eval('.poiesis-agent-window__code-activity-footer button[aria-label="設定"]', element => element.click());
    await page.waitForSelector('.poiesis-settings-modal__backdrop', { timeout: uiTimeout });
    moveElectronWindow(startProcess.pid, 1024, 600);
    resizeChecks.push(await assertElectronLayout(page, 'code', true));
    moveElectronWindow(startProcess.pid, 1500, 850);
    resizeChecks.push(await assertElectronLayout(page, 'code', true));
    await page.$eval('.poiesis-settings-modal__header button[aria-label="設定を閉じる"]', element => element.click());
    await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal__backdrop'));

    await page.$eval('.poiesis-agent-window__code-activity button[aria-label="Explorer"]', element => element.click());
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Explorer');
    await page.waitForSelector('#files .theia-FileStatNode', { timeout: uiTimeout });
    await clickExplorerFile(page, '.gitignore');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length === 1
        && document.querySelector('.poiesis-agent-window__code-editor-tab.active.preview .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === '.gitignore');
    await page.waitForSelector('.poiesis-agent-window__code-editor-host .monaco-editor', { timeout: uiTimeout });

    await expandExplorerDirectory(page, 'docs');
    await revealExplorerFile(page, 'UX.md', 'end');
    await dragExplorerFileToTabs(page, 'UX.md');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length === 2
        && document.querySelector('.poiesis-agent-window__code-editor-tab.active:not(.preview) .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'UX.md');

    const editorTabs = await page.$$eval('.poiesis-agent-window__code-editor-tab', tabs => tabs.map(tab => ({
        name: tab.querySelector('.poiesis-agent-window__code-editor-tab-name')?.textContent?.trim(),
        active: tab.classList.contains('active'),
        preview: tab.dataset.preview === 'true'
    })));
    assert(editorTabs.some(tab => tab.name === '.gitignore' && tab.preview), 'Explorer click did not retain its preview tab');
    assert(editorTabs.some(tab => tab.name === 'UX.md' && tab.active && !tab.preview), 'Explorer drag did not create a pinned tab');

    const codeSaveFixtureBefore = readFileSync(scmFixturePath, 'utf8');
    await page.click('.poiesis-agent-window__code-editor-host .monaco-editor .view-lines');
    await page.keyboard.type('x');
    await page.waitForSelector('.poiesis-agent-window__code-editor-tab.active.dirty .poiesis-agent-window__code-editor-tab-dirty');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyS');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__code-editor-tab.active.dirty'));
    assert(readFileSync(scmFixturePath, 'utf8') !== codeSaveFixtureBefore, 'Ctrl+S did not write the Electron editor content');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyZ');
    await page.keyboard.up('Control');
    await page.waitForSelector('.poiesis-agent-window__code-editor-tab.active.dirty .poiesis-agent-window__code-editor-tab-dirty');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyS');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__code-editor-tab.active.dirty'));
    assert(readFileSync(scmFixturePath, 'utf8') === codeSaveFixtureBefore, 'Ctrl+S did not restore the Electron editor fixture');

    console.log(`ELECTRON_SMOKE_RESULT=${JSON.stringify({ userAgent, windowTitle, initial, minimumSizeCheck, nativeWindowChecks, resizeChecks, code, editorTabs }, null, 2)}`);
    }
} catch (error) {
    console.error(`Electron start log (tail):\n${startLog}`);
    throw error;
} finally {
    restoreScmFixture();
    removeTerminalFixture();
    removeAgentTestFixture();
    if (browser) {
        await browser.close().catch(error => console.warn(`CDP Browser.close failed: ${error}`));
    }
    stopProcessTree(startProcess.pid);
    await waitForCdpToStop(browserURL, 30_000).catch(error => console.warn(error.message));
    removeOwnedUserDataDir();
}

function restoreScmFixture() {
    spawnSync('git', ['reset', '--quiet', '--', scmFixtureGitPath], { cwd: repositoryRoot });
    writeFileSync(scmFixturePath, scmFixtureOriginal, 'utf8');
}

function removeTerminalFixture() {
    if (existsSync(terminalFixturePath)) {
        unlinkSync(terminalFixturePath);
    }
}

function removeAgentTestFixture() {
    if (existsSync(agentTestFixturePath)) {
        unlinkSync(agentTestFixturePath);
    }
}

function removeOwnedUserDataDir() {
    const ownedRoot = `${resolve(runtimeDir)}${sep}`;
    const target = resolve(userDataDir);
    if (!target.startsWith(ownedRoot)) {
        throw new Error(`Refusing to remove Electron user data outside ${runtimeDir}: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
}

async function waitForScmAction(page, label, action) {
    const deadline = Date.now() + uiTimeout;
    while (Date.now() < deadline) {
        try {
            await page.evaluate(fileLabel => {
                const row = [...document.querySelectorAll('#scm-resource-widget .theia-TreeNode:not(.theia-CompositeTreeNode)')]
                    .find(element => element.querySelector('.name')?.textContent?.trim() === fileLabel);
                row?.querySelector('.scmItem')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            }, label);
            const point = await scmResourcePoint(page, label);
            await page.mouse.move(0, 0);
            await page.mouse.move(point.x, point.y);
            if (await scmActionExists(page, label, action)) return;
        } catch {
            // The resource row can be replaced while Git refreshes or changes groups.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    const snapshot = await page.$$eval('#scm-resource-widget .theia-TreeNode', rows => rows.map(row => ({
        text: row.textContent?.trim(),
        composite: row.classList.contains('theia-CompositeTreeNode'),
        actions: [...row.querySelectorAll('[title]')].map(element => element.getAttribute('title'))
    })));
    const gitStatus = spawnSync('git', ['status', '--porcelain', '--', scmFixtureGitPath], {
        cwd: repositoryRoot,
        encoding: 'utf8'
    }).stdout.trim();
    throw new Error(`Timed out waiting for ${action} on ${label}; git=${JSON.stringify(gitStatus)}; scm=${JSON.stringify(snapshot)}`);
}

async function executeScmAction(page, label, action, expected) {
    const deadline = Date.now() + uiTimeout;
    while (Date.now() < deadline) {
        if (scmFixtureHasState(expected)) return;
        await waitForScmAction(page, label, action);
        if (!await clickScmAction(page, label, action)) continue;
        for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (scmFixtureHasState(expected)) return;
        }
    }
    const porcelain = spawnSync('git', ['status', '--porcelain=v1', '--', scmFixtureGitPath], {
        cwd: repositoryRoot,
        encoding: 'utf8'
    }).stdout.replace(/\r?\n$/, '');
    const cached = spawnSync('git', ['diff', '--cached', '--quiet', '--', scmFixtureGitPath], { cwd: repositoryRoot });
    const workingTree = spawnSync('git', ['diff', '--quiet', '--', scmFixtureGitPath], { cwd: repositoryRoot });
    throw new Error(`Timed out waiting for UX.md to become ${expected}; status=${JSON.stringify(porcelain)}; cached=${cached.status}; working=${workingTree.status}`);
}

function scmFixtureHasState(expected) {
    const cached = spawnSync('git', ['diff', '--cached', '--quiet', '--', scmFixtureGitPath], { cwd: repositoryRoot });
    const workingTree = spawnSync('git', ['diff', '--quiet', '--', scmFixtureGitPath], { cwd: repositoryRoot });
    return expected === 'staged'
        ? cached.status === 1 && workingTree.status === 0
        : cached.status === 0 && workingTree.status === 1;
}

async function hoverScmResource(page, label) {
    const point = await scmResourcePoint(page, label);
    await page.evaluate(fileLabel => {
        const row = [...document.querySelectorAll('#scm-resource-widget .theia-TreeNode:not(.theia-CompositeTreeNode)')]
            .find(element => element.querySelector('.name')?.textContent?.trim() === fileLabel);
        row?.querySelector('.scmItem')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    }, label);
    await page.mouse.move(point.x, point.y);
    await waitForScmAction(page, label, 'Stage Changes');
}

async function scmResourcePoint(page, label) {
    return page.evaluate(fileLabel => {
        const row = [...document.querySelectorAll('#scm-resource-widget .theia-TreeNode:not(.theia-CompositeTreeNode)')]
            .find(element => element.querySelector('.name')?.textContent?.trim() === fileLabel);
        if (!(row instanceof HTMLElement)) throw new Error(`${fileLabel} was not found in Source Control`);
        row.scrollIntoView({ block: 'center' });
        const bounds = row.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    }, label);
}

async function scmActionExists(page, label, action) {
    return page.evaluate((fileLabel, actionTitle) => {
        const row = [...document.querySelectorAll('#scm-resource-widget .theia-TreeNode:not(.theia-CompositeTreeNode)')]
            .find(element => element.querySelector('.name')?.textContent?.trim() === fileLabel);
        return [...(row?.querySelectorAll('[title]') ?? [])].some(element => element.getAttribute('title') === actionTitle);
    }, label, action);
}

async function clickScmAction(page, label, action) {
    return page.evaluate((fileLabel, actionTitle) => {
        const row = [...document.querySelectorAll('#scm-resource-widget .theia-TreeNode:not(.theia-CompositeTreeNode)')]
            .find(element => element.querySelector('.name')?.textContent?.trim() === fileLabel);
        const target = [...(row?.querySelectorAll('[title]') ?? [])]
            .find(element => element.getAttribute('title') === actionTitle);
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
    }, label, action);
}

async function installRound12DenseResultsFixture(page) {
    await page.evaluate(() => {
        const key = 'poiesis:global:poiesis.agent-window.sessions.global.v1';
        const raw = localStorage.getItem(key);
        const state = raw ? JSON.parse(raw) : undefined;
        const session = state?.sessions?.[0];
        const task = session?.tasks?.at(-1);
        if (!session || !task?.resultsDocument?.html) {
            throw new Error('Task feedback Results were unavailable for the Round 12 fixture.');
        }
        const title = '長い日本語の成果タイトルでも状態と生成情報と検証結果を同じヘッダーで確認できることを検証するタスク';
        const assertions = Array.from({ length: 7 }, (_, index) => ({
            text: `Dense header assertion ${index + 1}`,
            source: 'app',
            status: 'pass'
        }));
        task.title = title;
        task.appliedSkills = {
            agent: ['implementation-harness', 'verification-recipe', 'results-evidence', 'results-structure'],
            results: []
        };
        task.resultsDocument = {
            ...task.resultsDocument,
            status: 'ready',
            generator: 'ai',
            providerId: 'codex',
            fallbackReason: undefined,
            assertions,
            assertionAttempts: 1
        };
        const originalStartedAt = new Date(task.startedAt).getTime();
        const history = Array.from({ length: 9 }, (_, index) => {
            const sequence = index + 1;
            const timestamp = new Date(originalStartedAt - (10 - sequence) * 60_000).toISOString();
            const id = `${task.id}-history-${sequence}`;
            return {
                ...task,
                id,
                title: `${title} ${sequence}`,
                startedAt: timestamp,
                endedAt: timestamp,
                resultsDocument: { ...task.resultsDocument, taskId: id }
            };
        });
        session.tasks = [...history, task];
        session.activeTab = 'results';
        session.selectedResultsTaskId = task.id;
        localStorage.setItem(key, JSON.stringify(state));

        for (const storageKey of Object.keys(localStorage)) {
            if (!storageKey.includes('poiesis.requirements.sessions.v1')) continue;
            try {
                const stored = JSON.parse(localStorage.getItem(storageKey));
                for (const requirements of Object.values(stored?.sessions ?? {})) {
                    for (const requirement of Array.isArray(requirements) ? requirements : []) {
                        if (!requirement.taskIds?.includes(task.id)) continue;
                        requirement.title = title;
                        requirement.taskIds = session.tasks.map(candidate => candidate.id);
                        requirement.resultsDocument = {
                            ...(requirement.resultsDocument ?? task.resultsDocument),
                            status: 'ready',
                            generator: 'ai',
                            providerId: 'codex',
                            fallbackReason: undefined,
                            assertions,
                            assertionAttempts: 1
                        };
                    }
                }
                localStorage.setItem(storageKey, JSON.stringify(stored));
            } catch {
                // Ignore unrelated storage values that happen to share the suffix.
            }
        }
    });
}

async function setElectronUiFontScale(page, scale) {
    await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal');
    await page.$eval(`input[name="poiesis-ui-scale"][value="${scale}"]`, input => input.click());
    await page.click('.poiesis-settings-modal__header button[aria-label="設定を閉じる"]');
    await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal'));
}

async function waitForFinishedElectronResults(page) {
    await page.waitForFunction(() => {
        const preload = document.querySelector('.theia-preload');
        const preloadHidden = !preload || Number.parseFloat(getComputedStyle(preload).opacity) <= 0.01;
        return preloadHidden
            && !document.querySelector('.poiesis-results__generating')
            && Boolean(document.querySelector('.poiesis-results__document'));
    });
    const handle = await page.$('.poiesis-results__document');
    const frame = await handle?.contentFrame();
    if (!frame) throw new Error('Electron Results iframe was not attached.');
    await frame.waitForFunction(() => document.readyState === 'complete'
        && Boolean(document.body?.querySelector(':scope > :not(script):not(style)')));
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
}

async function assertElectronResultsHeader(page, label, singleRow) {
    const layout = await assertElectronLayout(page, 'results');
    const header = await page.evaluate(() => {
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
        const node = document.querySelector('.poiesis-results__fixed-header');
        const title = node?.querySelector('h1');
        const metaItems = [...node?.querySelectorAll('.poiesis-results__status, time, .poiesis-results__diffstat, .poiesis-results__badges > span') ?? []];
        const badgeNodes = [...node?.querySelectorAll('.poiesis-results__badges > span') ?? []];
        const rowCenter = item => {
            const bounds = item.getBoundingClientRect();
            return Math.round(bounds.top + bounds.height / 2);
        };
        return {
            viewport: { width: innerWidth, height: innerHeight },
            documentWidth: document.documentElement.scrollWidth,
            main: rect(document.querySelector('.poiesis-results__main')),
            canvas: rect(document.querySelector('.poiesis-results__canvas')),
            header: rect(node),
            title: rect(title),
            titleAttribute: title?.getAttribute('title'),
            metaItems: metaItems.map(rect),
            metaRows: new Set(metaItems.map(rowCenter)).size,
            headerRows: new Set([title, ...metaItems].filter(Boolean)
                .map(rowCenter)).size,
            badges: badgeNodes.map(item => item.textContent?.replace(/\s+/g, ' ').trim()),
            badgeTitles: badgeNodes.map(item => item.getAttribute('title')),
            timeTitle: node?.querySelector('time')?.getAttribute('title'),
            fontScale: getComputedStyle(document.querySelector('.poiesis-agent-window__content'))
                .getPropertyValue('--poiesis-ui-font-scale').trim()
        };
    });
    assert(header.documentWidth <= header.viewport.width && header.main.width >= 300,
        `${label} overflowed or collapsed the Results content column: ${JSON.stringify({ layout, header })}`);
    assert(header.title.width >= 80
        && header.metaItems.every(bounds => bounds.left >= header.header.left - 1 && bounds.right <= header.header.right + 1),
    `${label} clipped fixed-header content: ${JSON.stringify({ layout, header })}`);
    assert(header.titleAttribute?.startsWith('長い日本語の成果タイトル')
        && header.badges.includes('AI · Codex')
        && header.badges.includes('条件 7/7')
        && header.badges.includes('Skills 4')
        && header.badges.includes('タスク 10')
        && header.badgeTitles.includes('AI 生成 · Codex')
        && header.badgeTitles.includes('Skill 条件 7/7 合格')
        && header.badgeTitles.includes('タスク 10件')
        && header.timeTitle?.endsWith('JST'),
    `${label} lost accessible Results metadata: ${JSON.stringify(header)}`);
    if (singleRow) {
        assert(header.metaRows === 1 && header.header.height <= 44,
            `${label} did not keep all Results metadata in one row: ${JSON.stringify(header)}`);
    } else {
        assert(header.header.height <= 96 && header.headerRows <= 3,
            `${label} did not use the bounded responsive Results layout: ${JSON.stringify(header)}`);
    }
    return { ...header, layoutViewport: layout.viewport };
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function moveElectronWindow(pid, width, height) {
    if (process.platform !== 'win32') return;
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PoiesisNativeWindow {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool MoveWindow(IntPtr handle, int x, int y, int width, int height, bool repaint);
}
'@
$poiesisProcess = Get-Process -Id ${pid} -ErrorAction Stop
$poiesisDeadline = (Get-Date).AddSeconds(10)
while ($poiesisProcess.MainWindowHandle -eq 0 -and (Get-Date) -lt $poiesisDeadline) {
    Start-Sleep -Milliseconds 100
    $poiesisProcess.Refresh()
}
if ($poiesisProcess.MainWindowHandle -eq 0) { throw 'Poiesis main window handle was not found.' }
if (-not [PoiesisNativeWindow]::MoveWindow($poiesisProcess.MainWindowHandle, 40, 40, ${width}, ${height}, $true)) {
    throw 'MoveWindow failed.'
}
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.status !== 0) {
        throw new Error(`Could not resize the Electron window: ${result.stderr || result.stdout}`);
    }
}

async function settleElectronWindowSize(page, pid, width, height) {
    moveElectronWindow(pid, width, height);
    await delay(350);
    const settled = await page.evaluate(({ expectedWidth, expectedHeight }) =>
        innerWidth === expectedWidth && innerHeight === expectedHeight, {
        expectedWidth: width,
        expectedHeight: height
    });
    if (!settled) moveElectronWindow(pid, width, height);
    await page.waitForFunction(({ expectedWidth, expectedHeight }) =>
        innerWidth === expectedWidth && innerHeight === expectedHeight, {}, {
        expectedWidth: width,
        expectedHeight: height
    });
}

function assertNativeMinimumWindowSize(pid) {
    if (process.platform !== 'win32') return { width: 1024, height: 600, skipped: true };
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PoiesisNativeMinimumWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@
$poiesisProcess = Get-Process -Id ${pid} -ErrorAction Stop
$poiesisProcess.Refresh()
$windowHandle = $poiesisProcess.MainWindowHandle
if ($windowHandle -eq 0) { throw 'Poiesis main window handle was not found.' }
$before = New-Object PoiesisNativeMinimumWindow+RECT
if (-not [PoiesisNativeMinimumWindow]::GetWindowRect($windowHandle, [ref]$before)) { throw 'GetWindowRect failed.' }
[void][PoiesisNativeMinimumWindow]::SetForegroundWindow($windowHandle)
[void][PoiesisNativeMinimumWindow]::SetCursorPos($before.Right - 2, $before.Bottom - 2)
Start-Sleep -Milliseconds 100
[PoiesisNativeMinimumWindow]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
for ($step = 1; $step -le 8; $step++) {
    [void][PoiesisNativeMinimumWindow]::SetCursorPos($before.Right - 2 - (40 * $step), $before.Bottom - 2 - (24 * $step))
    Start-Sleep -Milliseconds 25
}
[PoiesisNativeMinimumWindow]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 250
$after = New-Object PoiesisNativeMinimumWindow+RECT
if (-not [PoiesisNativeMinimumWindow]::GetWindowRect($windowHandle, [ref]$after)) { throw 'GetWindowRect failed after resize.' }
[pscustomobject]@{
    requestedWidth=($before.Right - $before.Left - 320)
    requestedHeight=($before.Bottom - $before.Top - 192)
    width=($after.Right - $after.Left)
    height=($after.Bottom - $after.Top)
} | ConvertTo-Json -Compress
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.status !== 0) {
        throw new Error(`Could not verify the Electron minimum window size: ${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

async function assertNativeWindowDrag(page, pid, selector, label) {
    const point = await findNativeDragPoint(page, selector);
    return assertNativeWindowDragAtPoint(page, pid, point, label);
}

async function assertElectronAiPillPopover(page, phase) {
    const trigger = '[data-ai-role="agent"] [aria-label="Agent の AI とモデル"]';
    await page.click(trigger);
    await page.waitForSelector('.poiesis-ai-role-pill__popover');
    const snapshot = await page.$eval('.poiesis-ai-role-pill__popover', (popover, currentPhase) => {
        const bounds = popover.getBoundingClientRect();
        const pill = document.querySelector('[data-ai-role="agent"]')?.getBoundingClientRect();
        return {
            phase: currentPhase,
            warning: document.querySelector('[data-ai-role="agent"]')?.classList.contains('warning'),
            viewport: { width: innerWidth, height: innerHeight },
            popover: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
            pill: pill && { left: pill.left, top: pill.top, right: pill.right, bottom: pill.bottom }
        };
    }, phase);
    assert(snapshot.popover.left >= 0 && snapshot.popover.top >= 0
        && snapshot.popover.right <= snapshot.viewport.width && snapshot.popover.bottom <= snapshot.viewport.height,
    `Electron Agent AI popover clipped ${phase}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.pill && snapshot.pill.left >= 0 && snapshot.pill.right <= snapshot.viewport.width,
        `Electron Agent AI pill clipped ${phase}: ${JSON.stringify(snapshot)}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.poiesis-ai-role-pill__popover'));
    return snapshot;
}

async function assertNativeWindowDragAtPoint(page, pid, point, label) {
    const result = sendNativeWindowInput(pid, point, 'drag');
    assert(result.hitHandle === result.windowHandle,
        `${label} Win32 input hit another window: ${JSON.stringify(result)}`);
    assert(Math.abs(result.deltaX) > 20 || Math.abs(result.deltaY) > 20,
        `${label} did not move from an OS-level drag: ${JSON.stringify(result)}`);
    await delay(250);
    return { label, point, delta: [result.deltaX, result.deltaY] };
}

async function nativeElementPoint(page, selector) {
    return page.$eval(selector, (element, currentSelector) => {
        if (!(element instanceof HTMLElement)) throw new Error(`${currentSelector} is not an HTML element`);
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
            target: element.id || element.className || element.tagName,
            appRegion: style.getPropertyValue('app-region') || style.getPropertyValue('-webkit-app-region')
        };
    }, selector);
}

async function assertNativeWindowControl(page, pid, action, phase) {
    const selectorAction = action === 'restore' ? 'restore' : action;
    const point = await nativeElementPoint(page,
        `.poiesis-window-controls__button[data-window-action="${selectorAction}"]`);
    assert(point.appRegion === 'no-drag',
        `${action} button is not a no-drag region: ${JSON.stringify(point)}`);
    const result = sendNativeWindowControlInput(pid, point, action);
    assert(result.hitHandle === result.windowHandle,
        `${phase} ${action} click hit another window: ${JSON.stringify(result)}`);
    if (action === 'minimize') {
        assert(result.iconicAfterClick && result.restoredAfterCheck,
            `${phase} minimize was swallowed by a drag region: ${JSON.stringify(result)}`);
        await page.bringToFront();
        await page.evaluate(() => window.focus());
    } else if (action === 'maximize') {
        assert(result.zoomedAfterClick && result.boundsChanged,
            `${phase} maximize was swallowed by a drag region: ${JSON.stringify(result)}`);
        await page.waitForSelector('.poiesis-window-controls__button[data-window-action="restore"]');
    } else if (action === 'restore') {
        assert(!result.zoomedAfterClick && result.boundsChanged,
            `${phase} restore was swallowed by a drag region: ${JSON.stringify(result)}`);
        await page.waitForSelector('.poiesis-window-controls__button[data-window-action="maximize"]');
    }
    return { phase, action, point, ...result };
}

async function assertNativeHeaderDoubleClick(page, pid) {
    const selector = '.poiesis-agent-window__header';
    const maximizePoint = await findNativeDragPoint(page, selector);
    const maximizeResult = sendNativeWindowInput(pid, maximizePoint, 'double-click');
    assert(maximizeResult.hitHandle === maximizeResult.windowHandle,
        `Header double-click hit another window: ${JSON.stringify(maximizeResult)}`);
    await page.waitForSelector('.poiesis-window-controls__button[data-window-action="restore"]');
    assert(await page.evaluate(() => window.electronTheiaCore.isMaximized()),
        'OS-level header double-click did not maximize the Electron window');

    const restorePoint = await findNativeDragPoint(page, selector);
    const restoreResult = sendNativeWindowInput(pid, restorePoint, 'double-click');
    assert(restoreResult.hitHandle === restoreResult.windowHandle,
        `Header restore double-click hit another window: ${JSON.stringify(restoreResult)}`);
    await page.waitForSelector('.poiesis-window-controls__button[data-window-action="maximize"]');
    await page.waitForFunction(() => !window.electronTheiaCore.isMaximized());
    return { label: 'header double-click', maximized: true, restored: true };
}

async function findNativeDragPoint(page, selector) {
    return page.$eval(selector, (root, currentSelector) => {
        if (!(root instanceof HTMLElement)) throw new Error(`${currentSelector} is not an HTML element`);
        const interactive = 'button, select, input, textarea, [role="tab"], a, [contenteditable="true"], .poiesis-window-controls';
        const bounds = root.getBoundingClientRect();
        const candidates = [];
        for (let y = bounds.top + 6; y < bounds.bottom - 4; y += 8) {
            for (let x = bounds.left + 6; x < bounds.right - 6; x += 12) {
                const target = document.elementFromPoint(x, y);
                if (!(target instanceof HTMLElement) || !root.contains(target) || target.closest(interactive)) continue;
                const style = getComputedStyle(target);
                const appRegion = style.getPropertyValue('app-region') || style.getPropertyValue('-webkit-app-region');
                if (appRegion !== 'drag') continue;
                candidates.push({
                    x,
                    y,
                    target: target.id || target.className || target.tagName,
                    distance: Math.abs(x - (bounds.left + bounds.width / 2)) + Math.abs(y - (bounds.top + bounds.height / 2))
                });
            }
        }
        candidates.sort((left, right) => left.distance - right.distance);
        const candidate = candidates[0];
        if (!candidate) throw new Error(`No non-interactive drag point was found in ${currentSelector}`);
        return {
            x: candidate.x,
            y: candidate.y,
            target: String(candidate.target),
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
            appRegion: getComputedStyle(root).getPropertyValue('app-region')
                || getComputedStyle(root).getPropertyValue('-webkit-app-region')
        };
    }, selector);
}

function sendNativeWindowControlInput(pid, point, action) {
    if (process.platform !== 'win32') {
        return {
            windowHandle: 1,
            hitHandle: 1,
            iconicAfterClick: action === 'minimize',
            restoredAfterCheck: true,
            zoomedAfterClick: action === 'maximize',
            boundsChanged: action === 'maximize' || action === 'restore'
        };
    }
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PoiesisNativeControlInput {
    public delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
}
'@
$targetPid = ${pid}
$windowHandle = [IntPtr]::Zero
[PoiesisNativeControlInput]::EnumWindows({
    param($handle, $parameter)
    $candidatePid = 0
    [void][PoiesisNativeControlInput]::GetWindowThreadProcessId($handle, [ref]$candidatePid)
    if ($candidatePid -eq $targetPid -and [PoiesisNativeControlInput]::IsWindowVisible($handle)) {
        $script:windowHandle = $handle
        return $false
    }
    return $true
}, [IntPtr]::Zero) | Out-Null
if ($windowHandle -eq [IntPtr]::Zero) { throw 'Poiesis main window handle was not found.' }
$before = New-Object PoiesisNativeControlInput+RECT
[void][PoiesisNativeControlInput]::GetWindowRect($windowHandle, [ref]$before)
$startX = $before.Left + [Math]::Round(${point.x} * ($before.Right - $before.Left) / ${point.viewportWidth})
$startY = $before.Top + [Math]::Round(${point.y} * ($before.Bottom - $before.Top) / ${point.viewportHeight})
[void][PoiesisNativeControlInput]::BringWindowToTop($windowHandle)
[void][PoiesisNativeControlInput]::SetForegroundWindow($windowHandle)
Start-Sleep -Milliseconds 160
[void][PoiesisNativeControlInput]::SetCursorPos($startX, $startY)
Start-Sleep -Milliseconds 100
$point = New-Object PoiesisNativeControlInput+POINT
$point.X = $startX
$point.Y = $startY
$hitHandle = [PoiesisNativeControlInput]::GetAncestor([PoiesisNativeControlInput]::WindowFromPoint($point), 2)
[PoiesisNativeControlInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[PoiesisNativeControlInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 500
$iconicAfterClick = [PoiesisNativeControlInput]::IsIconic($windowHandle)
$zoomedAfterClick = [PoiesisNativeControlInput]::IsZoomed($windowHandle)
$restoredAfterCheck = $false
if ('${action}' -eq 'minimize' -and $iconicAfterClick) {
    [void][PoiesisNativeControlInput]::ShowWindow($windowHandle, 9)
    Start-Sleep -Milliseconds 350
    $restoredAfterCheck = -not [PoiesisNativeControlInput]::IsIconic($windowHandle)
}
$after = New-Object PoiesisNativeControlInput+RECT
[void][PoiesisNativeControlInput]::GetWindowRect($windowHandle, [ref]$after)
$boundsChanged = $before.Left -ne $after.Left -or $before.Top -ne $after.Top -or $before.Right -ne $after.Right -or $before.Bottom -ne $after.Bottom
[pscustomobject]@{
    windowHandle=$windowHandle.ToInt64()
    hitHandle=$hitHandle.ToInt64()
    iconicAfterClick=$iconicAfterClick
    restoredAfterCheck=$restoredAfterCheck
    zoomedAfterClick=$zoomedAfterClick
    boundsChanged=$boundsChanged
} | ConvertTo-Json -Compress
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.status !== 0) {
        throw new Error(`Could not click Electron ${action} control: ${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

function sendNativeWindowInput(pid, point, mode) {
    if (process.platform !== 'win32') {
        return { windowHandle: 1, hitHandle: 1, deltaX: 48, deltaY: 36 };
    }
    const shouldDrag = mode === 'drag';
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PoiesisNativeInput {
    public delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr handle, int x, int y, int width, int height, bool repaint);
}
'@
$targetPid = ${pid}
$windowHandle = [IntPtr]::Zero
[PoiesisNativeInput]::EnumWindows({
    param($handle, $parameter)
    $candidatePid = 0
    [void][PoiesisNativeInput]::GetWindowThreadProcessId($handle, [ref]$candidatePid)
    if ($candidatePid -eq $targetPid -and [PoiesisNativeInput]::IsWindowVisible($handle)) {
        $script:windowHandle = $handle
        return $false
    }
    return $true
}, [IntPtr]::Zero) | Out-Null
if ($windowHandle -eq [IntPtr]::Zero) { throw 'Poiesis main window handle was not found.' }
$before = New-Object PoiesisNativeInput+RECT
[void][PoiesisNativeInput]::GetWindowRect($windowHandle, [ref]$before)
$beforeLeft = [int]$before.Left
$beforeTop = [int]$before.Top
$beforeRight = [int]$before.Right
$beforeBottom = [int]$before.Bottom
$startX = $beforeLeft + [Math]::Round(${point.x} * ($beforeRight - $beforeLeft) / ${point.viewportWidth})
$startY = $beforeTop + [Math]::Round(${point.y} * ($beforeBottom - $beforeTop) / ${point.viewportHeight})
[void][PoiesisNativeInput]::SetWindowPos($windowHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002)
[void][PoiesisNativeInput]::BringWindowToTop($windowHandle)
[void][PoiesisNativeInput]::SetForegroundWindow($windowHandle)
Start-Sleep -Milliseconds 160
[void][PoiesisNativeInput]::SetCursorPos($startX, $startY)
Start-Sleep -Milliseconds 100
$point = New-Object PoiesisNativeInput+POINT
$point.X = $startX
$point.Y = $startY
$hitHandle = [PoiesisNativeInput]::GetAncestor([PoiesisNativeInput]::WindowFromPoint($point), 2)
${shouldDrag ? `
[PoiesisNativeInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
for ($step = 1; $step -le 12; $step++) {
    [void][PoiesisNativeInput]::SetCursorPos($startX + [Math]::Round(96 * $step / 12), $startY + [Math]::Round(72 * $step / 12))
    Start-Sleep -Milliseconds 25
}
[PoiesisNativeInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
` : `
for ($click = 0; $click -lt 2; $click++) {
    [PoiesisNativeInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [PoiesisNativeInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
}
`}
Start-Sleep -Milliseconds 220
$after = New-Object PoiesisNativeInput+RECT
[void][PoiesisNativeInput]::GetWindowRect($windowHandle, [ref]$after)
$deltaX = [int]$after.Left - $beforeLeft
$deltaY = [int]$after.Top - $beforeTop
${shouldDrag ? '[void][PoiesisNativeInput]::MoveWindow($windowHandle, $beforeLeft, $beforeTop, $beforeRight - $beforeLeft, $beforeBottom - $beforeTop, $true)' : ''}
[void][PoiesisNativeInput]::SetWindowPos($windowHandle, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002)
[pscustomobject]@{ windowHandle=$windowHandle.ToInt64(); hitHandle=$hitHandle.ToInt64(); deltaX=$deltaX; deltaY=$deltaY } | ConvertTo-Json -Compress
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.status !== 0) {
        throw new Error(`Could not send ${mode} to the Electron window: ${result.stderr || result.stdout}`);
    }
    const serialized = result.stdout.trim().split(/\r?\n/).at(-1);
    return JSON.parse(serialized);
}

async function assertElectronLayout(page, expectedMode, expectSettings = false) {
    await delay(350);
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const snapshot = await page.evaluate((mode, settingsOpen) => {
        const rect = selector => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) return undefined;
            const bounds = element.getBoundingClientRect();
            return {
                x: Math.round(bounds.x),
                y: Math.round(bounds.y),
                width: Math.round(bounds.width),
                height: Math.round(bounds.height),
                right: Math.round(bounds.right),
                position: getComputedStyle(element).position
            };
        };
        const surfaceSelector = mode === 'agent'
            ? '.poiesis-agent-window__agent, .poiesis-agent-window__agent *'
            : mode === 'results'
                ? '.poiesis-results, .poiesis-results *'
                : mode === 'customize'
                    ? '.poiesis-customize-view, .poiesis-customize-view *'
                : [
                    '.poiesis-agent-window__header',
                    '.poiesis-agent-window__viewport',
                    '.poiesis-agent-window__code',
                    '.poiesis-agent-window__code-activity',
                    '.poiesis-agent-window__code-sidebar',
                    '.poiesis-agent-window__code-editor',
                    '.poiesis-agent-window__code-editor-stack',
                    '.poiesis-agent-window__code-panel',
                    '.poiesis-agent-window__code-status'
                ].join(',');
        const clipped = [...document.querySelectorAll(surfaceSelector)]
            .filter(element => {
                if (!(element instanceof HTMLElement)) return false;
                const style = getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                const bounds = element.getBoundingClientRect();
                return bounds.width > 0 && (bounds.left < -1 || bounds.right > innerWidth + 1);
            })
            .map(element => ({
                selector: element.className,
                left: Math.round(element.getBoundingClientRect().left),
                right: Math.round(element.getBoundingClientRect().right)
            }));
        return {
            expectedMode: mode,
            viewport: { width: innerWidth, height: innerHeight },
            mode: document.querySelector('.poiesis-agent-window__content')?.getAttribute('data-mode'),
            content: rect('.poiesis-agent-window__content'),
            rail: rect('.poiesis-agent-window__rail'),
            workspace: rect('.poiesis-agent-window__workspace'),
            header: rect('.poiesis-agent-window__header'),
            appViewport: rect('.poiesis-agent-window__viewport'),
            customize: rect('.poiesis-customize-view'),
            code: rect('.poiesis-agent-window__code'),
            settingsBackdrop: settingsOpen ? rect('.poiesis-settings-modal__backdrop') : undefined,
            settingsModal: settingsOpen ? rect('.poiesis-settings-modal') : undefined,
            clipped
        };
    }, expectedMode, expectSettings);
    assert(snapshot.mode === expectedMode, `Electron resize changed ${expectedMode} mode to ${snapshot.mode}`);
    assert(snapshot.clipped.length === 0,
        `Electron ${expectedMode} has horizontally clipped surfaces: ${JSON.stringify(snapshot)}`);
    assert(snapshot.content?.x === 0 && snapshot.content?.y === 0
        && snapshot.content?.width === snapshot.viewport.width && snapshot.content?.height === snapshot.viewport.height,
    `Electron content did not fill the resized window: ${JSON.stringify(snapshot)}`);
    if (expectedMode === 'code') {
        assert(!snapshot.rail && snapshot.workspace?.width === snapshot.viewport.width
            && snapshot.code?.width === snapshot.appViewport?.width && snapshot.code?.height === snapshot.appViewport?.height,
        `Electron Code layout fragmented after resize: ${JSON.stringify(snapshot)}`);
    } else {
        assert(snapshot.rail?.width >= 52 && snapshot.rail?.position !== 'absolute'
            && snapshot.workspace?.position !== 'absolute' && snapshot.rail?.right === snapshot.workspace?.x
            && snapshot.workspace?.right === snapshot.viewport.width
            && snapshot.header?.x === snapshot.workspace?.x && snapshot.header?.width === snapshot.workspace?.width,
        `Electron ${expectedMode} layout fragmented after resize: ${JSON.stringify(snapshot)}`);
        if (expectedMode === 'customize') {
            assert(snapshot.customize?.x === snapshot.appViewport?.x
                && snapshot.customize?.width === snapshot.appViewport?.width
                && snapshot.customize?.height === snapshot.appViewport?.height,
            `Electron Customize did not fill the central viewport: ${JSON.stringify(snapshot)}`);
        }
    }
    if (expectSettings) {
        assert(snapshot.settingsBackdrop?.x === 0 && snapshot.settingsBackdrop?.y === 0
            && snapshot.settingsBackdrop?.width === snapshot.viewport.width && snapshot.settingsBackdrop?.height === snapshot.viewport.height
            && snapshot.settingsModal?.width > 0 && snapshot.settingsModal?.height > 0
            && snapshot.settingsModal?.x >= 0 && snapshot.settingsModal?.y >= 0
            && snapshot.settingsModal?.right <= snapshot.viewport.width
            && snapshot.settingsModal?.y + snapshot.settingsModal?.height <= snapshot.viewport.height,
        `Electron Settings layout fragmented after resize: ${JSON.stringify(snapshot)}`);
    }
    return snapshot;
}

async function assertPoiesisSelectUnclipped(page, label) {
    const snapshot = await page.$eval('.poiesis-select__listbox', element => {
        const bounds = element.getBoundingClientRect();
        const trigger = document.querySelector('[aria-label="新しいSkillの種類"]')?.getBoundingClientRect();
        return {
            viewport: { width: innerWidth, height: innerHeight },
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
            width: bounds.width,
            height: bounds.height,
            inlineStyle: element.getAttribute('style'),
            trigger: trigger ? { left: trigger.left, top: trigger.top, right: trigger.right, bottom: trigger.bottom } : undefined
        };
    });
    assert(snapshot.left >= 0 && snapshot.top >= 0
        && snapshot.right <= snapshot.viewport.width && snapshot.bottom <= snapshot.viewport.height,
    `${label} clipped: ${JSON.stringify(snapshot)}`);
    return snapshot;
}

async function assertSettingsToggleKeepsLayout(page) {
    const snapshot = () => page.evaluate(() => {
        const read = selector => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) return undefined;
            const rect = element.getBoundingClientRect();
            return {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
                scrollLeft: element.scrollLeft,
                scrollTop: element.scrollTop
            };
        };
        return {
            viewport: { width: innerWidth, height: innerHeight },
            widget: read('.poiesis-agent-window'),
            content: read('.poiesis-agent-window__content'),
            workspace: read('.poiesis-agent-window__workspace'),
            panelViewport: read('.poiesis-agent-window__viewport'),
            backdrop: read('.poiesis-settings-modal__backdrop'),
            modal: read('.poiesis-settings-modal')
        };
    });
    const switchPoint = await page.evaluate(() => {
        const body = document.querySelector('.poiesis-settings-modal__body');
        const toggle = document.querySelector('.poiesis-agent-window__switch > span');
        if (!(body instanceof HTMLElement) || !(toggle instanceof HTMLElement)) {
            throw new Error('Results resource switch is missing');
        }
        body.scrollTop = Math.max(0, toggle.offsetTop - body.clientHeight / 2);
        const rect = toggle.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const before = await snapshot();
    await page.mouse.click(switchPoint.x, switchPoint.y);
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const after = await snapshot();
    for (const key of ['widget', 'content', 'workspace', 'panelViewport', 'backdrop']) {
        const oldRect = before[key];
        const newRect = after[key];
        assert(oldRect && newRect
            && Math.abs(oldRect.width - newRect.width) <= 1
            && Math.abs(oldRect.height - newRect.height) <= 1
            && Math.abs(oldRect.left - newRect.left) <= 1
            && Math.abs(oldRect.top - newRect.top) <= 1,
        `Settings toggle shifted ${key}: ${JSON.stringify({ before, after })}`);
    }
    assert(after.content.bottom <= after.viewport.height + 1 && after.workspace.bottom <= after.viewport.height + 1,
        `Settings toggle clipped the application: ${JSON.stringify({ before, after })}`);
    return { before, after };
}

function readPoiesisState() {
    const content = document.querySelector('.poiesis-agent-window__content');
    return {
        mode: content?.getAttribute('data-mode'),
        sessionRailVisible: Boolean(document.querySelector('.poiesis-agent-window__rail')),
        agentComposerVisible: Boolean(document.querySelector('.poiesis-agent-window__composer textarea')),
        codeSidebarVisible: Boolean(document.querySelector('.poiesis-agent-window__code-sidebar-host')),
        codeEditorVisible: Boolean(document.querySelector('.poiesis-agent-window__code-editor-host')),
        codeActivityVisible: Boolean(document.querySelector('.poiesis-agent-window__code-activity')),
        codeTerminalVisible: Boolean(document.querySelector('.poiesis-agent-window__code-terminal-host > *')),
        codeStatusVisible: Boolean(document.querySelector('.poiesis-agent-window__code-status')),
        codeLuminoPanelCount: document.querySelectorAll('.poiesis-agent-window__code .lm-Widget.lm-Panel').length,
        codeLuminoTabContainerCount: document.querySelectorAll('.poiesis-agent-window__code .lm-TabBar-content-container').length,
        applicationShellVisible: Boolean(document.querySelector('.poiesis-agent-window__code #theia-app-shell')),
        legacyChangesVisible: Boolean(document.querySelector('.poiesis-changes, #status-bar-poiesis-changes'))
    };
}

async function clickByText(page, selector, text) {
    await page.waitForFunction(({ selector: currentSelector, text: currentText }) =>
        [...document.querySelectorAll(currentSelector)]
            .some(element => element.textContent?.trim() === currentText), {}, { selector, text });
    await page.evaluate(({ selector: currentSelector, text: currentText }) => {
        const element = [...document.querySelectorAll(currentSelector)]
            .find(candidate => candidate.textContent?.trim() === currentText);
        if (!(element instanceof HTMLElement)) throw new Error(`${currentText} was not clickable`);
        element.click();
    }, { selector, text });
}

async function choosePoiesisSelect(page, triggerSelector, value) {
    await page.click(triggerSelector);
    await page.waitForSelector('.poiesis-select__listbox');
    const selected = await page.evaluate(nextValue => {
        const option = [...document.querySelectorAll('.poiesis-select__option')]
            .find(candidate => candidate.dataset.value === nextValue);
        if (!(option instanceof HTMLElement)) return false;
        option.click();
        return true;
    }, value);
    assert(selected, `Poiesis select option was not found in Electron: ${value}`);
    await page.waitForFunction((selector, nextValue) => document.querySelector(selector)?.dataset.value === nextValue,
        {}, triggerSelector, value);
}

async function expandExplorerDirectory(page, label) {
    await page.evaluate(() => {
        const files = document.getElementById('files');
        if (!files) return;
        for (const element of [files, ...files.querySelectorAll('*')]) {
            if (element instanceof HTMLElement && element.scrollHeight > element.clientHeight) {
                element.scrollTo({ top: 0 });
            }
        }
    });
    await page.waitForFunction(directoryLabel => [...document.querySelectorAll('#files .theia-FileStatNode')]
        .some(element => element.getAttribute('title')?.endsWith(directoryLabel)), {}, label);
    await page.evaluate(directoryLabel => {
        const directory = [...document.querySelectorAll('#files .theia-FileStatNode')]
            .find(element => element.getAttribute('title')?.endsWith(directoryLabel));
        directory?.querySelector('.theia-ExpansionToggle.theia-mod-collapsed')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    }, label);
}

async function revealExplorerFile(page, label, align = 'start') {
    const deadline = Date.now() + uiTimeout;
    while (Date.now() < deadline) {
        if (await page.evaluate(fileLabel => [...document.querySelectorAll('#files .theia-FileStatNode')]
            .some(element => element.getAttribute('title')?.endsWith(fileLabel)), label)) return;
        await page.evaluate(edge => {
            const files = document.getElementById('files');
            if (!files) return;
            for (const element of [files, ...files.querySelectorAll('*')]) {
                if (element instanceof HTMLElement && element.scrollHeight > element.clientHeight) {
                    element.scrollTo({ top: edge === 'end' ? element.scrollHeight : 0 });
                }
            }
        }, align);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`${label} was not revealed in Explorer`);
}

async function clickExplorerFile(page, label) {
    await page.evaluate(fileLabel => {
        const file = [...document.querySelectorAll('#files .theia-FileStatNode')]
            .find(element => element.getAttribute('title')?.endsWith(fileLabel));
        if (!(file instanceof HTMLElement)) throw new Error(`${fileLabel} was not found in Explorer`);
        file.scrollIntoView({ block: 'center' });
        file.click();
    }, label);
}

async function dragExplorerFileToTabs(page, label) {
    const points = await page.evaluate(fileLabel => {
        const file = [...document.querySelectorAll('#files .theia-FileStatNode')]
            .find(element => element.getAttribute('title')?.endsWith(fileLabel));
        const tabs = document.querySelector('.poiesis-agent-window__code-editor-tabs');
        if (!(file instanceof HTMLElement) || !(tabs instanceof HTMLElement)) {
            throw new Error(`Could not drag ${fileLabel} to the editor tabs`);
        }
        file.scrollIntoView({ block: 'center' });
        const source = file.getBoundingClientRect();
        const target = tabs.getBoundingClientRect();
        return {
            source: { x: source.left + source.width / 2, y: source.top + source.height / 2 },
            target: { x: target.right - 24, y: target.top + target.height / 2 }
        };
    }, label);
    await page.mouse.move(points.source.x, points.source.y);
    await page.mouse.down();
    await page.mouse.move(points.source.x + 12, points.source.y, { steps: 4 });
    await page.mouse.move(points.target.x, points.target.y, { steps: 16 });
    assert(await page.$eval('.poiesis-agent-window__code-editor-tabs', tabs => tabs.classList.contains('drop-target')),
        `${label} drag did not enter the tab drop target in Electron`);
    await page.mouse.up();
}

async function waitForProcessExit(process, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (process.exitCode !== null) return;
        await delay(100);
    }
    throw new Error(`Electron did not exit after the native close click (pid ${process.pid})`);
}

async function waitForCdp(url, process, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (process.exitCode !== null) throw new Error(`Electron exited before CDP was ready: ${process.exitCode}`);
        try {
            const response = await fetch(`${url}/json/version`);
            if (response.ok) return;
        } catch {
            // Electron is still starting.
        }
        await delay(500);
    }
    throw new Error(`CDP did not become ready at ${url}`);
}

async function findWorkbenchPage(browser, timeout) {
    const deadline = Date.now() + timeout;
    let observations = [];
    while (Date.now() < deadline) {
        const pages = await browser.pages();
        observations = await Promise.all(pages.map(async page => {
            try {
                return {
                    url: page.url(),
                    title: await page.title(),
                    hasPoiesisHost: Boolean(await page.$('#poiesis-window-host')),
                    hasPoiesisWindow: Boolean(await page.$('.poiesis-agent-window'))
                };
            } catch {
                return { url: page.url(), unavailable: true };
            }
        }));
        const workbenchIndex = observations.findIndex(observation => observation.hasPoiesisHost || observation.hasPoiesisWindow);
        if (workbenchIndex >= 0) return pages[workbenchIndex];
        await delay(500);
    }
    const targets = browser.targets().map(target => ({ type: target.type(), url: target.url() }));
    throw new Error(`Theia Electron workbench page was not found: ${JSON.stringify({ observations, targets })}`);
}

function stopProcessTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
        startProcess.kill('SIGTERM');
    }
}

async function waitForCdpToStop(url, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            await fetch(`${url}/json/version`);
        } catch {
            return;
        }
        await delay(250);
    }
    throw new Error(`Electron CDP endpoint remained active at ${url}`);
}

function delay(milliseconds) {
    return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
