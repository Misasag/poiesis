import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import {
    assertHostExists,
    ensureRuntimeDirectories,
    hostArguments,
    hostEnvironment,
    hostExecutable,
    runtimeDir
} from './host-utils.mjs';

const debugPort = 9333;
const profileName = 'smoke-user-data';
const profileDir = resolve(runtimeDir, profileName);
const proofDir = resolve(runtimeDir, 'smoke-proof');
assertSafeRuntimePath(profileDir);
assertSafeRuntimePath(proofDir);
await Promise.all([
    rm(profileDir, { recursive: true, force: true }),
    rm(proofDir, { recursive: true, force: true })
]);
await mkdir(proofDir, { recursive: true });
const directories = await ensureRuntimeDirectories(profileName);

const child = spawn(hostExecutable, hostArguments({ ...directories, debugPort }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: hostEnvironment({
        LENS_CODE_OSS_SMOKE: '1',
        LENS_CODE_OSS_PROOF_DIR: proofDir
    })
});

let processOutput = '';
for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', chunk => {
        processOutput = `${processOutput}${chunk.toString()}`.slice(-30000);
    });
}

let browser;
try {
    await waitFor(async () => {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => undefined);
        return response?.ok;
    }, 60000, 'VSCodium DevTools endpoint');

    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` });
    const workbench = await waitForWorkbench(browser);
    const agentFrame = await waitForFrameWithSelector(browser, '#questionButton', 60000, 'Agent Window webview');
    const changesVisibleBeforeOpen = Boolean(await findFrameWithSelector(browser, '#codeTab'));

    const initialAgentButtonLabels = await agentFrame.$$eval('button', buttons => buttons.map(button => button.textContent?.trim()));
    const agentText = await agentFrame.$eval('body', body => body.innerText);
    if (initialAgentButtonLabels.length !== 1 || initialAgentButtonLabels[0] !== '質問' || agentText.includes('Semantic Diff')) {
        throw new Error(`Agent Window responsibility is invalid: ${JSON.stringify({ initialAgentButtonLabels, agentText })}`);
    }
    await agentFrame.click('#questionButton');
    await waitFor(async () => !(await agentFrame.$eval('#question', element => element.hidden)), 10000, 'question expansion');

    const activityBarEntryVisible = await workbench.evaluate(() =>
        [...document.querySelectorAll('[aria-label]')].some(element => element.getAttribute('aria-label')?.includes('IDE Changes'))
    );
    await workbench.bringToFront();
    await workbench.keyboard.down('Control');
    await workbench.keyboard.down('Shift');
    await workbench.keyboard.press('KeyP');
    await workbench.keyboard.up('Shift');
    await workbench.keyboard.up('Control');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
    await workbench.keyboard.type('Lens: Changes');
    await new Promise(resolveDelay => setTimeout(resolveDelay, 750));
    await workbench.keyboard.press('Enter');

    const changesFrame = await waitForFrameWithSelector(browser, '#codeTab', 30000, 'Changes Webview View');
    const changeSetId = await changesFrame.$eval('main', element => element.getAttribute('data-change-set-id'));
    const codeDiffVisible = await changesFrame.$eval('#codeDiff', element => !element.hidden);
    await changesFrame.click('#openCodeDiffButton');
    await waitFor(async () => {
        const status = await changesFrame.$eval('#status', element => element.textContent ?? '');
        return status.includes('既存 Diff Editor');
    }, 30000, 'native Code Diff');
    await waitFor(async () => workbench.evaluate(() =>
        [...document.querySelectorAll('.tab, .monaco-diff-editor')].some(element =>
            element.classList.contains('monaco-diff-editor') || element.textContent?.includes('Change Set: auth-service.ts')
        )
    ), 30000, 'Code-OSS Diff Editor DOM');
    const nativeDiffEditorVisible = await workbench.evaluate(() => Boolean(document.querySelector('.monaco-diff-editor')));

    await changesFrame.click('#semanticTab');
    await waitFor(async () => !(await changesFrame.$eval('#semanticDiff', element => element.hidden)), 10000, 'Semantic Diff representation');
    await changesFrame.click('#evidenceButton');
    await waitFor(async () => {
        const status = await changesFrame.$eval('#status', element => element.textContent ?? '');
        return status.includes('12 行目');
    }, 20000, 'evidence navigation result');

    const capabilityFile = resolve(proofDir, 'capabilities.json');
    const terminalProofFile = resolve(proofDir, 'terminal-proof.txt');
    await waitFor(() => existsSync(capabilityFile), 30000, 'capability proof');
    await waitFor(() => existsSync(terminalProofFile), 30000, 'terminal command proof');
    const capabilities = JSON.parse(await readFile(capabilityFile, 'utf8'));
    const terminalProof = (await readFile(terminalProofFile, 'utf8')).trim();

    const result = {
        host: 'VSCodium',
        changesVisibleBeforeOpen,
        activityBarEntryVisible,
        initialAgentButtonLabels,
        questionVisible: await agentFrame.$eval('#question', element => !element.hidden),
        changeSetId,
        codeDiffVisible,
        semanticDiffVisible: await changesFrame.$eval('#semanticDiff', element => !element.hidden),
        changesStatus: await changesFrame.$eval('#status', element => element.textContent?.trim()),
        nativeDiffEditorVisible,
        terminalProof,
        capabilities,
        workbench: await workbench.evaluate(() => {
            const allText = [...document.querySelectorAll('.tab, .pane-header, .activitybar, .part')]
                .map(element => element.textContent ?? '');
            return {
                title: document.title,
                repositoryVisible: document.title.toLowerCase().includes('lens'),
                editorTabVisible: allText.some(text => text.includes('auth-service.ts')),
                agentTabVisible: allText.some(text => text.includes('Agent Window')),
                changesSurfaceVisible: document.body.innerText.includes('IDE Changes') || document.body.innerText.includes('Changes'),
                diffTabVisible: allText.some(text => text.includes('Change Set: auth-service.ts')),
                terminalSurfaceVisible: document.body.innerText.includes('Lens Spike Terminal'),
                activeLineNumbers: [...document.querySelectorAll('.line-numbers.active-line-number')]
                    .map(element => element.textContent?.trim()).filter(Boolean)
            };
        })
    };

    if (result.changesVisibleBeforeOpen
        || result.initialAgentButtonLabels.length !== 1
        || result.changeSetId !== 'task-auth-redis-001'
        || !result.codeDiffVisible
        || !result.semanticDiffVisible
        || !result.nativeDiffEditorVisible
        || !result.changesStatus?.includes('12 行目')
        || !result.workbench.repositoryVisible
        || !result.workbench.editorTabVisible
        || !result.workbench.agentTabVisible
        || !result.workbench.activeLineNumbers.includes('12')) {
        throw new Error(`New Changes UX verification failed: ${JSON.stringify(result)}`);
    }
    if (!capabilities.terminalCreated || terminalProof !== 'LENS_TERMINAL_OK') {
        throw new Error(`Terminal verification failed: ${JSON.stringify({ capabilities, terminalProof })}`);
    }
    if (!capabilities.gitExtensionPresent || capabilities.gitRepositoryCount < 1
        || !capabilities.typescriptExtensionPresent || capabilities.typescriptHoverCount < 1) {
        throw new Error(`Built-in capability verification failed: ${JSON.stringify(capabilities)}`);
    }

    console.log(JSON.stringify(result, null, 2));
} catch (error) {
    console.error(error);
    if (processOutput) {
        console.error('--- VSCodium output ---');
        console.error(processOutput);
    }
    process.exitCode = 1;
} finally {
    browser?.disconnect();
    await stopProcessTree(child);
}

function assertSafeRuntimePath(target) {
    const normalizedRuntime = resolve(runtimeDir).toLowerCase();
    const normalizedTarget = resolve(target).toLowerCase();
    if (!normalizedTarget.startsWith(`${normalizedRuntime}\\`)) {
        throw new Error(`Refusing to clear path outside runtime directory: ${target}`);
    }
}

async function waitForWorkbench(connectedBrowser) {
    return waitFor(async () => {
        for (const page of await connectedBrowser.pages()) {
            if (await page.$('.monaco-workbench').catch(() => undefined)) {
                return page;
            }
        }
        return undefined;
    }, 60000, 'Code-OSS workbench');
}

async function findFrameWithSelector(connectedBrowser, selector) {
    for (const page of await connectedBrowser.pages()) {
        for (const frame of page.frames()) {
            if (await frame.$(selector).catch(() => undefined)) {
                return frame;
            }
        }
    }
    return undefined;
}

async function waitForFrameWithSelector(connectedBrowser, selector, timeout, label) {
    return waitFor(() => findFrameWithSelector(connectedBrowser, selector), timeout, label);
}

async function waitFor(check, timeout, label) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const value = await check();
            if (value) {
                return value;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }
    throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError}` : ''}`);
}

async function stopProcessTree(processHandle) {
    if (processHandle.exitCode !== null) {
        return;
    }
    processHandle.kill();
    const exited = await Promise.race([
        new Promise(resolvePromise => processHandle.once('exit', () => resolvePromise(true))),
        new Promise(resolvePromise => setTimeout(() => resolvePromise(false), 5000))
    ]);
    if (!exited && processHandle.pid) {
        spawnSync('taskkill.exe', ['/pid', String(processHandle.pid), '/t', '/f'], { windowsHide: true });
    }
}
