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
mkdirSync(runtimeDir, { recursive: true });

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
    '--plugins=local-dir:../plugins',
    `--user-data-dir=${userDataDir}`,
    `--electronUserData=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox'
], {
    cwd: resolve(root, 'electron-app'),
    env: {
        ...process.env,
        THEIA_CONFIG_DIR: resolve(root, '.theia-config-electron')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
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

    await page.waitForSelector('.poiesis-agent-window__code-terminal-host .xterm-helper-textarea', { timeout: uiTimeout });
    assert(await page.$('.poiesis-agent-window__code-terminal-select[aria-label="Active Terminal"]'),
        'Active Terminal selector is missing in Electron');
    const firstTerminalId = await page.$eval('.poiesis-agent-window__code-terminal-host > *', element => element.id);
    await page.click('.poiesis-agent-window__code-terminal-host .xterm-screen');
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
    await page.click('.poiesis-agent-window__code-panel-tabs button[aria-label="New Terminal"]');
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id !== id
        && document.querySelectorAll('.poiesis-agent-window__code-terminal-select option').length === 2, {}, firstTerminalId);
    const secondTerminalId = await page.$eval('.poiesis-agent-window__code-terminal-host > *', element => element.id);
    await page.select('.poiesis-agent-window__code-terminal-select', firstTerminalId);
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);
    await page.click('.poiesis-agent-window__code-panel-tabs button[aria-label="Close Panel"]');
    await page.waitForSelector('.poiesis-agent-window__code-status button[aria-label="Toggle Panel"][aria-expanded="false"]');
    assert(!await page.$('.poiesis-agent-window__code-panel'), 'Close Panel must hide the Electron Terminal panel');
    await page.click('.poiesis-agent-window__code-status button[aria-label="Toggle Panel"]');
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
    await page.click('.poiesis-agent-window__code-panel-tabs button[aria-label="Kill Terminal"]');
    await page.waitForFunction(id => document.querySelectorAll('.poiesis-agent-window__code-terminal-select option').length === 1
        && document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);

    while (await page.$('.poiesis-agent-window__code-editor-tab-close')) {
        const count = await page.$$eval('.poiesis-agent-window__code-editor-tab', tabs => tabs.length);
        await page.click('.poiesis-agent-window__code-editor-tab-close');
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

    await page.click('.poiesis-agent-window__code-activity button[aria-label="Source Control"]');
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
    await page.click('.poiesis-agent-window__code-sidebar-actions button[aria-label="Refresh Source Control"]');
    await waitForScmAction(page, 'UX.md', 'Stage Changes');
    await hoverScmResource(page, 'UX.md');
    for (const action of ['Open File', 'Discard Changes', 'Stage Changes']) {
        assert(await scmActionExists(page, 'UX.md', action), `Source Control action is missing in Electron: ${action}`);
    }
    await executeScmAction(page, 'UX.md', 'Stage Changes', 'staged');
    await page.click('.poiesis-agent-window__code-sidebar-actions button[aria-label="Refresh Source Control"]');
    await waitForScmAction(page, 'UX.md', 'Unstage Changes');
    await executeScmAction(page, 'UX.md', 'Unstage Changes', 'unstaged');
    await page.click('.poiesis-agent-window__code-sidebar-actions button[aria-label="Refresh Source Control"]');
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

    await page.$eval('.poiesis-agent-window__code-activity-footer button[aria-label="Settings"]', element => element.click());
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'Settings');
    await page.waitForSelector('.poiesis-agent-window__code-editor-host #settings_widget', { timeout: uiTimeout });
    assert(await page.$('.poiesis-agent-window__code'), 'Code Settings left Code mode in Electron');
    await page.$eval('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-close', element => element.click());
    await page.waitForFunction(() => ![...document.querySelectorAll('.poiesis-agent-window__code-editor-tab-name')]
        .some(element => element.textContent?.trim() === 'Settings'));

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

    console.log(`ELECTRON_SMOKE_RESULT=${JSON.stringify({ userAgent, windowTitle, initial, code, editorTabs }, null, 2)}`);
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
