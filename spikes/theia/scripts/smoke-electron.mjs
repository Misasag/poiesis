import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const runtimeDir = resolve(root, '.electron-runtime');
const userDataDir = resolve(runtimeDir, `user-data-${Date.now()}`);
const debugPort = Number(process.env.THEIA_ELECTRON_DEBUG_PORT ?? 9334);
const browserURL = `http://127.0.0.1:${debugPort}`;
const uiTimeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const windowDragOnly = process.env.POIESIS_WINDOW_DRAG_ONLY === '1';
const customizeWindowOnly = process.env.POIESIS_CUSTOMIZE_WINDOW_ONLY === '1';
const settingsWindowOnly = process.env.POIESIS_SETTINGS_WINDOW_ONLY === '1';
const modalWindowOnly = customizeWindowOnly || settingsWindowOnly;
const lightweightElectron = windowDragOnly || modalWindowOnly;
mkdirSync(runtimeDir, { recursive: true });
const emptyPluginsDir = resolve(runtimeDir, 'empty-plugins');
if (lightweightElectron) mkdirSync(emptyPluginsDir, { recursive: true });

const repositoryRoot = resolve(root, '..', '..');
const scmFixtureGitPath = 'docs/UX.md';
const scmFixturePath = resolve(repositoryRoot, scmFixtureGitPath);
const scmFixtureOriginal = readFileSync(scmFixturePath, 'utf8');
const scmFixtureMarker = '<!-- Poiesis SCM smoke change -->';
if (scmFixtureOriginal.includes(scmFixtureMarker)) {
    throw new Error('SCM smoke fixture still contains a marker from an interrupted test.');
}
const terminalFixturePath = resolve(runtimeDir, 'terminal-smoke.txt');
removeTerminalFixture();

const electronExecutable = resolve(root, 'node_modules/electron/dist/electron.exe');
const startProcess = spawn(electronExecutable, [
    resolve(root, 'electron-app'),
    '../../..',
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
    moveElectronWindow(startProcess.pid, 1280, 720);
    resizeChecks.push(await assertElectronLayout(page, 'agent'));
    if (!modalWindowOnly) {
        nativeWindowChecks.push(await assertNativeWindowDrag(page, startProcess.pid,
            '.poiesis-agent-window__header', 'Agent header'));
        nativeWindowChecks.push(await assertNativeWindowDrag(page, startProcess.pid,
            '.poiesis-agent-window__rail-top', 'session rail top'));
        nativeWindowChecks.push(await assertNativeHeaderDoubleClick(page, startProcess.pid));
        nativeWindowChecks.push(await assertNativeWindowDrag(page, startProcess.pid,
            '.poiesis-agent-window__header', 'Agent header after maximize and restore'));
    }
    moveElectronWindow(startProcess.pid, 1100, 700);
    resizeChecks.push(await assertElectronLayout(page, 'agent'));
    moveElectronWindow(startProcess.pid, 1500, 850);
    resizeChecks.push(await assertElectronLayout(page, 'agent'));
    await page.click('.poiesis-window-controls__button[data-window-action="maximize"]');
    await page.waitForSelector('.poiesis-window-controls__button[data-window-action="restore"]');
    resizeChecks.push(await assertElectronLayout(page, 'agent'));
    await page.click('.poiesis-window-controls__button[data-window-action="restore"]');
    await page.waitForSelector('.poiesis-window-controls__button[data-window-action="maximize"]');
    resizeChecks.push(await assertElectronLayout(page, 'agent'));

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
    if (!modalWindowOnly) {
        nativeWindowChecks.push(await assertNativeWindowDrag(page, startProcess.pid,
            '.poiesis-agent-window__code-header', 'Code header'));
    }
    if (lightweightElectron) {
        await clickByText(page, '.poiesis-agent-window__code-control', 'Code');
        await page.waitForSelector('.poiesis-agent-window__agent');
        const modalSelector = settingsWindowOnly ? '.poiesis-settings-modal:not(.poiesis-customize-modal)' : '.poiesis-customize-modal';
        if (settingsWindowOnly) {
            await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
        } else {
            await page.click('.poiesis-agent-window__rail-action[title="Customize"]');
        }
        await page.waitForSelector(modalSelector);
        moveElectronWindow(startProcess.pid, 1100, 700);
        const modalWindowChecks = {
            resized: await assertElectronLayout(page, 'agent', true)
        };
        await page.click('.poiesis-window-controls__button[data-window-action="maximize"]');
        await page.waitForSelector('.poiesis-window-controls__button[data-window-action="restore"]');
        modalWindowChecks.maximized = await assertElectronLayout(page, 'agent', true);
        await page.click('.poiesis-window-controls__button[data-window-action="restore"]');
        await page.waitForSelector('.poiesis-window-controls__button[data-window-action="maximize"]');
        modalWindowChecks.restored = await assertElectronLayout(page, 'agent', true);
        await page.keyboard.press('Escape');
        await page.waitForFunction(selector => !document.querySelector(selector), {}, modalSelector);
        const serializedResult = JSON.stringify({
            userAgent,
            windowTitle,
            nativeWindowChecks,
            headerInteractionChecks,
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
    moveElectronWindow(startProcess.pid, 1100, 700);
    resizeChecks.push(await assertElectronLayout(page, 'code'));
    moveElectronWindow(startProcess.pid, 1500, 850);
    resizeChecks.push(await assertElectronLayout(page, 'code'));

    await page.waitForSelector('.poiesis-agent-window__code-terminal-host .xterm-helper-textarea', { timeout: uiTimeout });
    assert(await page.$('.poiesis-agent-window__code-terminal-select[aria-label="Active Terminal"]'),
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

    const terminalPanelHeight = await page.$eval('.poiesis-agent-window__code-panel', element => Math.round(element.getBoundingClientRect().height));
    await page.focus('.poiesis-agent-window__code-panel-resize');
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(height => Math.round(document.querySelector('.poiesis-agent-window__code-panel')?.getBoundingClientRect().height ?? 0) === height + 12,
        {}, terminalPanelHeight);
    await page.$eval('.poiesis-agent-window__code-panel-tabs button[aria-label="New Terminal"]', element => element.click());
    try {
        await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__code-terminal-select option').length === 2);
    } catch (error) {
        const terminalState = await page.evaluate(() => ({
            activeHostIds: [...document.querySelectorAll('.poiesis-agent-window__code-terminal-host > *')]
                .map(element => element.id),
            selectedId: document.querySelector('.poiesis-agent-window__code-terminal-select')?.value,
            options: [...document.querySelectorAll('.poiesis-agent-window__code-terminal-select option')]
                .map(option => ({ value: option.value, label: option.textContent?.trim() }))
        }));
        throw new Error(`New Terminal was not registered in Electron: ${JSON.stringify(terminalState)}`, { cause: error });
    }
    const secondTerminalId = await page.$$eval('.poiesis-agent-window__code-terminal-select option',
        (options, id) => options.map(option => option.value).find(value => value !== id), firstTerminalId);
    assert(secondTerminalId, 'New Terminal did not expose a distinct Electron terminal option');
    const activeTerminalId = await page.$eval('.poiesis-agent-window__code-terminal-host > *', element => element.id);
    if (activeTerminalId !== secondTerminalId) {
        await page.select('.poiesis-agent-window__code-terminal-select', secondTerminalId);
    }
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, secondTerminalId);
    await page.select('.poiesis-agent-window__code-terminal-select', firstTerminalId);
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);
    await page.$eval('.poiesis-agent-window__code-panel-tabs button[aria-label="Close Panel"]', element => element.click());
    await page.waitForSelector('.poiesis-agent-window__code-status button[aria-label="Toggle Panel"][aria-expanded="false"]');
    assert(!await page.$('.poiesis-agent-window__code-panel'), 'Close Panel must hide the Electron Terminal panel');
    await page.$eval('.poiesis-agent-window__code-status button[aria-label="Toggle Panel"]', element => element.click());
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);
    await page.keyboard.down('Control');
    await page.keyboard.press('Backquote');
    await page.keyboard.up('Control');
    await page.waitForSelector('.poiesis-agent-window__code-status button[aria-label="Toggle Panel"][aria-expanded="false"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('Backquote');
    await page.keyboard.up('Control');
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);
    await page.select('.poiesis-agent-window__code-terminal-select', secondTerminalId);
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, secondTerminalId);
    await page.$eval('.poiesis-agent-window__code-panel-tabs button[aria-label="Kill Terminal"]', element => element.click());
    await page.waitForFunction(id => document.querySelectorAll('.poiesis-agent-window__code-terminal-select option').length === 1
        && document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);

    while (await page.$('.poiesis-agent-window__code-editor-tab-close')) {
        const count = await page.$$eval('.poiesis-agent-window__code-editor-tab', tabs => tabs.length);
        await page.$eval('.poiesis-agent-window__code-editor-tab-close', element => element.click());
        await page.waitForFunction(previous => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length < previous, {}, count);
    }

    await page.$eval('.poiesis-agent-window__code-activity button[aria-label="Search"]', element => element.click());
    await page.waitForSelector('#search-input-field', { timeout: uiTimeout });
    await page.waitForFunction(() => document.activeElement?.id === 'search-input-field');
    for (const label of ['Refresh Search Results', 'Clear Search Results', 'Collapse All Search Results']) {
        assert(await page.$(`.poiesis-agent-window__code-sidebar-actions button[aria-label="${label}"]`), `Search action is missing in Electron: ${label}`);
    }
    await page.$eval('.poiesis-agent-window__code-sidebar-actions button[aria-label="Clear Search Results"]', element => element.click());
    await page.focus('#search-input-field');
    const codeSearchQuery = ['Source contract', 'validation passed.'].join(' ');
    await page.type('#search-input-field', codeSearchQuery);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#search-in-workspace .search-info')?.textContent?.includes('2 results in 2 files'));
    await page.$eval('.poiesis-agent-window__code-sidebar-actions button[aria-label="Clear Search Results"]', element => element.click());
    await page.waitForFunction(() => document.querySelector('#search-input-field')?.value === ''
        && document.querySelectorAll('#search-in-workspace .theia-TreeNode').length === 0);

    await page.$eval('.poiesis-agent-window__code-activity button[aria-label="Source Control"]', element => element.click());
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Source Control');
    await page.waitForSelector('.poiesis-agent-window__code-sidebar-actions button[aria-label="Refresh Source Control"]');
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
    await page.$eval('.poiesis-agent-window__code-sidebar-actions button[aria-label="Refresh Source Control"]', element => element.click());
    await waitForScmAction(page, 'UX.md', 'Stage Changes');
    await hoverScmResource(page, 'UX.md');
    for (const action of ['Open File', 'Discard Changes', 'Stage Changes']) {
        assert(await scmActionExists(page, 'UX.md', action), `Source Control action is missing in Electron: ${action}`);
    }
    await executeScmAction(page, 'UX.md', 'Stage Changes', 'staged');
    await page.$eval('.poiesis-agent-window__code-sidebar-actions button[aria-label="Refresh Source Control"]', element => element.click());
    await waitForScmAction(page, 'UX.md', 'Unstage Changes');
    await executeScmAction(page, 'UX.md', 'Unstage Changes', 'unstaged');
    await page.$eval('.poiesis-agent-window__code-sidebar-actions button[aria-label="Refresh Source Control"]', element => element.click());
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
    moveElectronWindow(startProcess.pid, 1100, 700);
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

    console.log(`ELECTRON_SMOKE_RESULT=${JSON.stringify({ userAgent, windowTitle, initial, nativeWindowChecks, resizeChecks, code, editorTabs }, null, 2)}`);
    }
} catch (error) {
    console.error(`Electron start log (tail):\n${startLog}`);
    throw error;
} finally {
    restoreScmFixture();
    removeTerminalFixture();
    if (browser) {
        await browser.close().catch(error => console.warn(`CDP Browser.close failed: ${error}`));
    }
    stopProcessTree(startProcess.pid);
    await waitForCdpToStop(browserURL, 30_000).catch(error => console.warn(error.message));
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

async function assertNativeWindowDrag(page, pid, selector, label) {
    const point = await findNativeDragPoint(page, selector);
    const result = sendNativeWindowInput(pid, point, 'drag');
    assert(result.hitHandle === result.windowHandle,
        `${label} Win32 input hit another window: ${JSON.stringify(result)}`);
    assert(Math.abs(result.deltaX) > 20 || Math.abs(result.deltaY) > 20,
        `${label} did not move from an OS-level drag: ${JSON.stringify(result)}`);
    await delay(250);
    return { label, point, delta: [result.deltaX, result.deltaY] };
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
        return {
            expectedMode: mode,
            viewport: { width: innerWidth, height: innerHeight },
            mode: document.querySelector('.poiesis-agent-window__content')?.getAttribute('data-mode'),
            content: rect('.poiesis-agent-window__content'),
            rail: rect('.poiesis-agent-window__rail'),
            workspace: rect('.poiesis-agent-window__workspace'),
            header: rect('.poiesis-agent-window__header'),
            appViewport: rect('.poiesis-agent-window__viewport'),
            code: rect('.poiesis-agent-window__code'),
            settingsBackdrop: settingsOpen ? rect('.poiesis-settings-modal__backdrop') : undefined,
            settingsModal: settingsOpen ? rect('.poiesis-settings-modal') : undefined
        };
    }, expectedMode, expectSettings);
    assert(snapshot.mode === expectedMode, `Electron resize changed ${expectedMode} mode to ${snapshot.mode}`);
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
