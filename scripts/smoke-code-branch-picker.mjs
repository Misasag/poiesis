import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 180_000);
const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const runDirectory = resolve(root, '.run', `code-branch-picker-${Date.now()}`);
const workspace = resolve(runDirectory, 'pomodoro-web-smoke');
const browserProfile = resolve(runDirectory, 'browser-profile');
const theiaConfig = resolve(runDirectory, 'theia-config');
const theiaCli = resolve(root, 'node_modules', '@theia', 'cli', 'bin', 'theia.js');
const plugins = resolve(root, 'plugins').replaceAll('\\', '/');
mkdirSync(workspace, { recursive: true });
writeFileSync(resolve(workspace, 'README.md'), '# Pomodoro web smoke\n', 'utf8');
runGit(['init', '--initial-branch=main']);
runGit(['config', 'user.name', 'Poiesis Smoke']);
runGit(['config', 'user.email', 'poiesis-smoke@example.invalid']);
runGit(['add', 'README.md']);
runGit(['commit', '--no-gpg-sign', '-m', 'test: initialize branch picker fixture']);
runGit(['branch', 'branch-smoke']);

const initialHead = gitHead();
assert(initialHead === 'main', `Expected the fixture to start on main, got ${initialHead}.`);

const port = await freePort();
const uiUrl = `http://127.0.0.1:${port}`;
const serverProcess = spawn(process.execPath, [
    theiaCli,
    'start',
    workspace,
    `--plugins=local-dir:${plugins}`,
    '--hostname', '127.0.0.1',
    '--port', String(port)
], {
    cwd: resolve(root, 'browser-app'),
    env: { ...process.env, THEIA_CONFIG_DIR: theiaConfig },
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
let smokeDebug = { initialHead };
for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream?.on('data', chunk => {
        serverLog = `${serverLog}${chunk.toString('utf8')}`.slice(-40_000);
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
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await clickText(page, '.poiesis-agent-window__code-control', 'Code');
    await page.waitForSelector('.poiesis-agent-window__code');
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-agent-window__code-status-scm')]
        .some(element => element.textContent?.trim() === 'main' && !(element instanceof HTMLButtonElement && element.disabled)),
    { timeout: 60_000 });

    const scmCommands = await page.$$eval('.poiesis-agent-window__code-status-scm', elements => elements.map(element => ({
        index: element.getAttribute('data-scm-status-index'),
        label: element.textContent?.trim(),
        title: element.getAttribute('title')
    })));
    await page.evaluate(() => {
        const branch = [...document.querySelectorAll('.poiesis-agent-window__code-status-scm')]
            .find(element => element.textContent?.trim() === 'main');
        if (!(branch instanceof HTMLButtonElement)) throw new Error('The main branch status command was not clickable.');
        branch.click();
    });

    await page.waitForFunction(() => {
        const widget = document.querySelector('#quick-input-container .quick-input-widget');
        if (!(widget instanceof HTMLElement)) return false;
        const bounds = widget.getBoundingClientRect();
        const style = getComputedStyle(widget);
        return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    await page.waitForSelector('#quick-input-container .quick-input-widget input');
    const quickPickHost = await page.$eval('#quick-input-container', element => element.parentElement?.tagName);
    await page.focus('#quick-input-container .quick-input-widget input');
    await page.keyboard.type('branch-smoke');
    await page.waitForFunction(branch => document.querySelector('#quick-input-container .quick-input-list')
        ?.textContent?.includes(branch), {}, 'branch-smoke');
    const quickPickText = await page.$eval('#quick-input-container .quick-input-list', element => element.textContent ?? '');
    const quickPickRows = await page.$$eval('#quick-input-container .monaco-list-row', elements => elements.map(element => ({
        text: element.textContent?.trim(),
        className: element.className,
        ariaLabel: element.getAttribute('aria-label')
    })));
    smokeDebug = { ...smokeDebug, scmCommands, quickPickHost, quickPickText, quickPickRows };
    const targetRows = await page.$$('#quick-input-container .monaco-list-row');
    let targetBounds;
    for (const row of targetRows) {
        if (await row.evaluate(element => element.getAttribute('aria-label')?.includes('branch-smoke') === true)) {
            targetBounds = await row.boundingBox();
            break;
        }
    }
    assert(targetBounds, `QuickPick row for branch-smoke was not found: ${JSON.stringify(quickPickRows)}`);
    await page.mouse.click(targetBounds.x + targetBounds.width / 2, targetBounds.y + targetBounds.height / 2);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    if (gitHead() !== 'branch-smoke') {
        await page.keyboard.press('Enter');
    }

    await waitUntil(() => gitHead() === 'branch-smoke', 30_000,
        'Git HEAD did not switch to branch-smoke after accepting the QuickPick item.');
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-agent-window__code-status-scm')]
        .some(element => element.textContent?.trim() === 'branch-smoke'));
    const displayedBranch = await page.$eval('.poiesis-agent-window__code-status-scm', element => element.textContent?.trim());
    const finalHead = gitHead();

    assert(quickPickHost === 'BODY', `Expected the QuickPick host below BODY, got ${quickPickHost}.`);
    assert(quickPickText.includes('branch-smoke'), `QuickPick did not contain branch-smoke: ${quickPickText}`);
    assert(finalHead === 'branch-smoke', `Expected HEAD branch-smoke, got ${finalHead}.`);
    assert(displayedBranch === 'branch-smoke', `Status bar did not follow HEAD: ${displayedBranch}`);
    console.log(`CODE_BRANCH_PICKER_SMOKE_RESULT=${JSON.stringify({
        fixture: 'pomodoro-web-smoke',
        branches: ['main', 'branch-smoke'],
        initialHead,
        scmCommands,
        quickPickHost,
        quickPickMatched: 'branch-smoke',
        finalHead,
        displayedBranch
    })}`);
} catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${ascii(detail)}\nSmoke debug (ASCII):\n${ascii(JSON.stringify(smokeDebug))}\nServer log (ASCII):\n${ascii(serverLog)}`);
} finally {
    if (browser) await browser.close().catch(() => undefined);
    stopProcessTree(serverProcess);
    rmSync(runDirectory, { recursive: true, force: true });
}

function runGit(args) {
    const result = spawnSync('git', args, {
        cwd: workspace,
        encoding: 'utf8',
        windowsHide: true,
        shell: false
    });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${result.status}): ${ascii(result.stderr || result.stdout)}`);
    }
    return result.stdout.trim();
}

function gitHead() {
    return runGit(['branch', '--show-current']);
}

async function clickText(page, selector, text) {
    await page.waitForFunction(({ currentSelector, currentText }) => [...document.querySelectorAll(currentSelector)]
        .some(element => element.textContent?.trim() === currentText), {}, { currentSelector: selector, currentText: text });
    await page.evaluate(({ currentSelector, currentText }) => {
        const element = [...document.querySelectorAll(currentSelector)]
            .find(candidate => candidate.textContent?.trim() === currentText);
        if (!(element instanceof HTMLElement)) throw new Error(`${currentText} was not clickable.`);
        element.click();
    }, { currentSelector: selector, currentText: text });
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

async function waitUntil(predicate, waitTimeout, message) {
    const deadline = Date.now() + waitTimeout;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    throw new Error(message);
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
    return String(value).replace(/[^\x20-\x7e\r\n\t]/g, character =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
