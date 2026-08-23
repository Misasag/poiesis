import { mkdirSync } from 'node:fs';
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
    await waitForCdp(browserURL, startProcess, 120_000);
    browser = await puppeteer.connect({ browserURL, defaultViewport: null });
    const page = await findWorkbenchPage(browser, uiTimeout);
    page.setDefaultTimeout(uiTimeout);
    await page.bringToFront();
    await page.evaluate(() => window.focus());
    await page.waitForSelector('#lens-window-host .lens-agent-window__content', { timeout: uiTimeout });
    await page.waitForSelector('.lens-agent-window__agent', { timeout: uiTimeout });
    await page.waitForSelector('.lens-agent-window__rail', { timeout: uiTimeout });

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const windowTitle = await page.title();
    const initial = await page.evaluate(readLensState);
    assert(userAgent.includes('Electron/'), `Expected Electron user agent, got ${userAgent}`);
    assert(initial.mode === 'agent', `Expected Agent mode, got ${initial.mode}`);
    assert(initial.agentComposerVisible, 'Agent Composer is missing in Electron');
    assert(initial.sessionRailVisible, 'Session rail is missing in Electron');
    assert(!initial.legacyChangesVisible, 'Removed Changes UI is still visible in Electron');

    await clickByText(page, '.lens-agent-window__code-control', 'Code');
    await page.waitForSelector('.lens-agent-window__code', { timeout: uiTimeout });
    await page.waitForSelector('#files .theia-FileStatNode', { timeout: uiTimeout });
    await page.waitForFunction(() => Boolean(document.querySelector('.lens-agent-window__code-terminal-host > *')), {
        timeout: uiTimeout
    });

    const code = await page.evaluate(readLensState);
    assert(code.mode === 'code', `Expected Code mode, got ${code.mode}`);
    assert(code.codeSidebarVisible, 'Code sidebar is missing in Electron');
    assert(code.codeEditorVisible, 'Code editor is missing in Electron');
    assert(code.codeActivityVisible, 'Code Activity Bar is missing in Electron');
    assert(code.codeTerminalVisible, 'Code terminal is missing in Electron');
    assert(code.codeStatusVisible, 'Code status bar is missing in Electron');
    assert(code.codeLuminoPanelCount === 0, 'Code reintroduced lm-Widget lm-Panel wrappers in Electron');
    assert(code.codeLuminoTabContainerCount === 0, 'Code reintroduced lm-TabBar-content-container in Electron');
    assert(!code.applicationShellVisible, 'Code mounted the Theia ApplicationShell in Electron');

    while (await page.$('.lens-agent-window__code-editor-tab-close')) {
        const count = await page.$$eval('.lens-agent-window__code-editor-tab', tabs => tabs.length);
        await page.click('.lens-agent-window__code-editor-tab-close');
        await page.waitForFunction(previous => document.querySelectorAll('.lens-agent-window__code-editor-tab').length < previous, {}, count);
    }

    await page.click('.lens-agent-window__code-activity button[aria-label="Extensions"]');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Extensions');
    await page.waitForSelector('.lens-agent-window__code-sidebar-host > *', { timeout: uiTimeout });
    await page.waitForFunction(() => document.querySelector('#vsx-extensions-search-bar input')?.value === '@builtin');
    await page.waitForFunction(() => (document.getElementById('vsx-extensions:builtin')?.querySelectorAll('.theia-TreeNode').length ?? 0) > 0);
    assert(!await page.$('.lens-agent-window__customize-page'), 'Code Extensions opened Lens Customize in Electron');

    await page.click('.lens-agent-window__code-activity-footer button[aria-label="Settings"]');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === 'Settings');
    await page.waitForSelector('.lens-agent-window__code-editor-host #settings_widget', { timeout: uiTimeout });
    assert(await page.$('.lens-agent-window__code'), 'Code Settings left Code mode in Electron');
    await page.click('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-close');
    await page.waitForFunction(() => ![...document.querySelectorAll('.lens-agent-window__code-editor-tab-name')]
        .some(element => element.textContent?.trim() === 'Settings'));

    await page.click('.lens-agent-window__code-activity button[aria-label="Explorer"]');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Explorer');
    await page.waitForSelector('#files .theia-FileStatNode', { timeout: uiTimeout });
    await clickExplorerFile(page, '.gitignore');
    await page.waitForFunction(() => document.querySelectorAll('.lens-agent-window__code-editor-tab').length === 1
        && document.querySelector('.lens-agent-window__code-editor-tab.active.preview .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === '.gitignore');
    await page.waitForSelector('.lens-agent-window__code-editor-host .monaco-editor', { timeout: uiTimeout });

    await page.evaluate(() => {
        const docs = [...document.querySelectorAll('#files .theia-FileStatNode')]
            .find(element => element.textContent?.trim() === 'docs');
        docs?.querySelector('.theia-ExpansionToggle')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#files .theia-FileStatNode')]
        .some(element => element.textContent?.trim() === 'UX.md'));
    await dragExplorerFileToTabs(page, 'UX.md');
    await page.waitForFunction(() => document.querySelectorAll('.lens-agent-window__code-editor-tab').length === 2
        && document.querySelector('.lens-agent-window__code-editor-tab.active:not(.preview) .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === 'UX.md');

    const editorTabs = await page.$$eval('.lens-agent-window__code-editor-tab', tabs => tabs.map(tab => ({
        name: tab.querySelector('.lens-agent-window__code-editor-tab-name')?.textContent?.trim(),
        active: tab.classList.contains('active'),
        preview: tab.dataset.preview === 'true'
    })));
    assert(editorTabs.some(tab => tab.name === '.gitignore' && tab.preview), 'Explorer click did not retain its preview tab');
    assert(editorTabs.some(tab => tab.name === 'UX.md' && tab.active && !tab.preview), 'Explorer drag did not create a pinned tab');

    console.log(`ELECTRON_SMOKE_RESULT=${JSON.stringify({ userAgent, windowTitle, initial, code, editorTabs }, null, 2)}`);
} catch (error) {
    console.error(`Electron start log (tail):\n${startLog}`);
    throw error;
} finally {
    if (browser) {
        await browser.close().catch(error => console.warn(`CDP Browser.close failed: ${error}`));
    }
    stopProcessTree(startProcess.pid);
    await waitForCdpToStop(browserURL, 30_000).catch(error => console.warn(error.message));
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function readLensState() {
    const content = document.querySelector('.lens-agent-window__content');
    return {
        mode: content?.getAttribute('data-mode'),
        sessionRailVisible: Boolean(document.querySelector('.lens-agent-window__rail')),
        agentComposerVisible: Boolean(document.querySelector('.lens-agent-window__composer textarea')),
        codeSidebarVisible: Boolean(document.querySelector('.lens-agent-window__code-sidebar-host')),
        codeEditorVisible: Boolean(document.querySelector('.lens-agent-window__code-editor-host')),
        codeActivityVisible: Boolean(document.querySelector('.lens-agent-window__code-activity')),
        codeTerminalVisible: Boolean(document.querySelector('.lens-agent-window__code-terminal-host > *')),
        codeStatusVisible: Boolean(document.querySelector('.lens-agent-window__code-status')),
        codeLuminoPanelCount: document.querySelectorAll('.lens-agent-window__code .lm-Widget.lm-Panel').length,
        codeLuminoTabContainerCount: document.querySelectorAll('.lens-agent-window__code .lm-TabBar-content-container').length,
        applicationShellVisible: Boolean(document.querySelector('.lens-agent-window__code #theia-app-shell')),
        legacyChangesVisible: Boolean(document.querySelector('.lens-changes, #status-bar-lens-changes'))
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

async function clickExplorerFile(page, label) {
    const point = await page.evaluate(fileLabel => {
        const file = [...document.querySelectorAll('#files .theia-FileStatNode')]
            .find(element => element.textContent?.trim() === fileLabel);
        if (!(file instanceof HTMLElement)) throw new Error(`${fileLabel} was not found in Explorer`);
        file.scrollIntoView({ block: 'center' });
        const bounds = file.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    }, label);
    await page.mouse.click(point.x, point.y);
}

async function dragExplorerFileToTabs(page, label) {
    const points = await page.evaluate(fileLabel => {
        const file = [...document.querySelectorAll('#files .theia-FileStatNode')]
            .find(element => element.textContent?.trim() === fileLabel);
        const tabs = document.querySelector('.lens-agent-window__code-editor-tabs');
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
    assert(await page.$eval('.lens-agent-window__code-editor-tabs', tabs => tabs.classList.contains('drop-target')),
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
                    hasLensHost: Boolean(await page.$('#lens-window-host')),
                    hasLensWindow: Boolean(await page.$('.lens-agent-window'))
                };
            } catch {
                return { url: page.url(), unavailable: true };
            }
        }));
        const workbenchIndex = observations.findIndex(observation => observation.hasLensHost || observation.hasLensWindow);
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
