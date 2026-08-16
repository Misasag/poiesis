import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const runtimeDir = resolve(root, '.electron-runtime');
const terminalProof = resolve(runtimeDir, 'terminal-proof.txt');
const userDataDir = resolve(runtimeDir, `user-data-${Date.now()}`);
const debugPort = Number(process.env.THEIA_ELECTRON_DEBUG_PORT ?? 9334);
const browserURL = `http://127.0.0.1:${debugPort}`;
mkdirSync(runtimeDir, { recursive: true });
rmSync(terminalProof, { force: true });

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
    const page = await findWorkbenchPage(browser, 120_000);
    page.setDefaultTimeout(30_000);
    await page.bringToFront();
    await page.evaluate(() => window.focus());

    const windowTitle = await page.title();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const changesVisibleBeforeOpen = Boolean(await page.$('.lens-changes'));
    const initialAgentButtonLabels = await page.$$eval(
        '.lens-agent-window__actions button',
        buttons => buttons.map(button => button.textContent?.trim())
    );
    if (initialAgentButtonLabels.length !== 1 || initialAgentButtonLabels[0] !== '質問') {
        throw new Error(`Agent Window responsibility is invalid: ${JSON.stringify(initialAgentButtonLabels)}`);
    }

    await clickButton(page, '.lens-agent-window', '質問');
    await page.waitForSelector('[aria-label="Mock follow-up question"]');

    await page.$eval('#status-bar-lens-changes', element => {
        if (!(element instanceof HTMLElement)) {
            throw new Error('IDE Changes status bar entry was not found');
        }
        element.click();
    });
    await page.waitForSelector('.lens-changes');
    const changeSetId = await page.$eval(
        '.lens-changes__content',
        element => element.getAttribute('data-change-set-id')
    );
    const codeDiffVisible = Boolean(await page.$('[aria-label="Code Diff representation"]'));
    await page.$eval('.lens-changes__open-diff', element => {
        if (!(element instanceof HTMLElement)) {
            throw new Error('Code Diff action was not found');
        }
        element.click();
    });
    await page.waitForSelector('.monaco-diff-editor');
    await page.waitForFunction(
        () => document.querySelector('.lens-changes__status')?.textContent?.includes('既存 Diff Editor')
    );

    await clickButton(page, '.lens-changes__tabs', 'Semantic Diff');
    await page.waitForSelector('[aria-label="Semantic Diff representation"]');
    await page.$eval('.lens-changes__evidence', element => {
        if (!(element instanceof HTMLElement)) {
            throw new Error('Evidence action was not found');
        }
        element.click();
    });
    await page.waitForFunction(
        () => document.querySelector('.lens-changes__status')?.textContent?.includes('12 行目')
    );
    await page.waitForFunction(
        () => [...document.querySelectorAll('.lm-TabBar-tabLabel')]
            .some(label => label.textContent?.trim() === 'auth-service.ts')
    );

    const evidenceResult = await page.evaluate(() => ({
        status: document.querySelector('.lens-changes__status')?.textContent?.trim(),
        activeLineNumbers: [...document.querySelectorAll('.monaco-editor .active-line-number')]
            .map(line => line.textContent?.trim()),
        cursorStatus: document.querySelector('#status-bar-editor-status-cursor-position')?.textContent?.trim()
    }));

    const terminalResult = await optionalCheck('Terminal', async () => {
        await pressChord(page, ['Control'], 'Backquote');
        await page.waitForFunction(
            () => [...document.querySelectorAll('.lm-TabBar-tabLabel')]
                .some(label => label.textContent?.trim().toLowerCase() === 'cmd'),
            { timeout: 10_000 }
        );
        await activateEditorTab(page, 'cmd');
        await page.waitForSelector('.xterm-helper-textarea', { timeout: 10_000 });
        const terminalInput = await page.$('.xterm-helper-textarea');
        await terminalInput.focus();
        await page.keyboard.type('echo LENS_ELECTRON_TERMINAL_OK> spikes\\theia\\.electron-runtime\\terminal-proof.txt');
        await page.keyboard.press('Enter');
        await waitFor(() => existsSync(terminalProof), 15_000, 'terminal proof file');
        return { verified: true, output: readFileSync(terminalProof, 'utf8').trim() };
    });

    const gitResult = await optionalCheck('Git', async () => {
        await page.waitForFunction(
            () => [...document.querySelectorAll('[id^="status-bar-scm"]')]
                .some(element => element.textContent?.trim()),
            { timeout: 30_000 }
        );
        const statusBarEntries = await page.$$eval(
            '[id^="status-bar-scm"]',
            elements => elements.map(element => element.textContent?.trim()).filter(Boolean)
        );
        return { verified: statusBarEntries.length > 0, statusBarEntries };
    });

    const lspResult = await optionalCheck('TypeScript hover', async () => {
        await activateEditorTab(page, 'auth-service.ts');
        await page.keyboard.press('Home');
        for (let index = 0; index < 8; index += 1) {
            await page.keyboard.press('ArrowRight');
        }
        await pressChord(page, ['Control'], 'KeyK');
        await pressChord(page, ['Control'], 'KeyI');
        await page.waitForSelector('.monaco-hover', { visible: true, timeout: 20_000 });
        const hoverText = await page.$eval('.monaco-hover', element => element.textContent?.trim());
        return { verified: Boolean(hoverText), hoverText };
    });

    const repositoryLabels = await page.$$eval(
        '.theia-TreeNodeSegment, .theia-TreeNodeSegmentGrow',
        elements => elements.map(element => element.textContent?.trim()).filter(Boolean).slice(0, 30)
    );
    const editorTabs = await page.$$eval(
        '.lm-TabBar-tabLabel',
        labels => labels.map(label => label.textContent?.trim()).filter(Boolean)
    );

    const result = {
        userAgent,
        windowTitle,
        repositoryLabels,
        changesVisibleBeforeOpen,
        initialAgentButtonLabels,
        questionVisible: Boolean(await page.$('[aria-label="Mock follow-up question"]')),
        changeSetId,
        codeDiffVisible,
        nativeDiffEditorVisible: Boolean(await page.$('.monaco-diff-editor')),
        semanticDiffVisible: Boolean(await page.$('[aria-label="Semantic Diff representation"]')),
        evidenceResult,
        editorTabs,
        terminalResult,
        gitResult,
        lspResult
    };
    console.log(`ELECTRON_SMOKE_RESULT=${JSON.stringify(result, null, 2)}`);

    if (changesVisibleBeforeOpen
        || changeSetId !== 'task-auth-redis-001'
        || !codeDiffVisible
        || !result.semanticDiffVisible
        || !result.nativeDiffEditorVisible
        || !evidenceResult.status?.includes('12 行目')
        || (!evidenceResult.activeLineNumbers.includes('12') && !evidenceResult.cursorStatus?.includes('Ln 12'))) {
        throw new Error(`Electron verification failed: ${JSON.stringify(result)}`);
    }
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

async function waitForCdp(url, process, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (process.exitCode !== null) {
            throw new Error(`Electron exited before CDP was ready: ${process.exitCode}`);
        }
        try {
            const response = await fetch(`${url}/json/version`);
            if (response.ok) {
                return;
            }
        } catch {
            // Electron is still starting.
        }
        await delay(500);
    }
    throw new Error(`CDP did not become ready at ${url}`);
}

async function findWorkbenchPage(browser, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        for (const page of await browser.pages()) {
            try {
                if (await page.$('.lens-agent-window')) {
                    return page;
                }
            } catch {
                // A splash page may disappear while targets are inspected.
            }
        }
        await delay(500);
    }
    throw new Error('Theia Electron workbench page was not found');
}

async function clickButton(page, rootSelector, label) {
    await page.evaluate(({ rootSelector: rootSelectorValue, label: labelValue }) => {
        const button = [...document.querySelectorAll(`${rootSelectorValue} button`)]
            .find(candidate => candidate.textContent?.trim() === labelValue);
        if (!(button instanceof HTMLElement)) {
            throw new Error(`${labelValue} button was not found in ${rootSelectorValue}`);
        }
        button.click();
    }, { rootSelector, label });
}

async function pressChord(page, modifiers, key) {
    await page.bringToFront();
    await page.evaluate(() => window.focus());
    for (const modifier of modifiers) {
        await page.keyboard.down(modifier);
    }
    await page.keyboard.press(key);
    for (const modifier of [...modifiers].reverse()) {
        await page.keyboard.up(modifier);
    }
    await delay(500);
}

async function activateEditorTab(page, label) {
    await page.evaluate(labelValue => {
        const tab = [...document.querySelectorAll('.lm-TabBar-tab')]
            .find(candidate => candidate.querySelector('.lm-TabBar-tabLabel')?.textContent?.trim() === labelValue);
        if (!(tab instanceof HTMLElement)) {
            throw new Error(`${labelValue} editor tab was not found`);
        }
        tab.click();
    }, label);
    await delay(500);
}

async function waitFor(predicate, timeout, label) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await delay(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

async function optionalCheck(label, check) {
    try {
        return await check();
    } catch (error) {
        return {
            verified: false,
            error: `${label}: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

function stopProcessTree(pid) {
    if (!pid) {
        return;
    }
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
