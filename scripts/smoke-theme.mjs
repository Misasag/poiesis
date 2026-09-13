import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const repositoryRoot = resolve(import.meta.dirname, '..');
const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const browserExecutable = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!browserExecutable) {
    throw new Error('Chrome or Edge was not found. Set CHROME_PATH to run this smoke test.');
}

const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'poiesis-theme-smoke-'));
const configDirectory = resolve(temporaryRoot, 'theia-config');
const browserProfileOne = resolve(temporaryRoot, 'browser-one');
const browserProfileTwo = resolve(temporaryRoot, 'browser-two');
const serverLog = resolve(temporaryRoot, 'server.log');
const artifactDirectory = resolve(repositoryRoot, '.run', 'theme-smoke-artifacts');
const artifactStamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const lightScreenshot = resolve(artifactDirectory, `${artifactStamp}-light.png`);
const darkScreenshot = resolve(artifactDirectory, `${artifactStamp}-dark.png`);
mkdirSync(artifactDirectory, { recursive: true });

let browser;
let serverProcess;
let activePage;
const browserDiagnostics = [];

try {
    const port = await availablePort();
    const url = `http://127.0.0.1:${port}`;
    serverProcess = await startServer(port);
    browser = await launchBrowser(browserProfileOne);
    const page = await browser.newPage();
    activePage = page;
    page.on('console', message => browserDiagnostics.push(`console:${message.type()}: ${message.text()}`));
    page.on('pageerror', error => browserDiagnostics.push(`pageerror: ${error.stack ?? error.message}`));
    page.setDefaultTimeout(timeout);
    await installSessionFixture(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await waitForPoiesis(page);

    await assertMode(page, 'dark');
    await openSettings(page);
    await assertThemeControls(page);
    await chooseRadio(page, 'poiesis-ui-scale', 'large');

    await chooseTheme(page, 'light');
    const light = await readThemeState(page);
    assert(light.bodyTheme === 'theia-light', `Theia did not switch to light: ${JSON.stringify(light)}`);
    assert(luminance(light.chromeBackground) > 0.7, `Agent chrome is not light: ${JSON.stringify(light)}`);
    assert(luminance(light.settingsBackground) > 0.7, `Settings chrome is not light: ${JSON.stringify(light)}`);
    assert(luminance(light.theiaEditorBackground) > 0.7, `Theia editor tokens are not light: ${JSON.stringify(light)}`);
    await page.screenshot({ path: lightScreenshot, fullPage: true });
    await clickByText(page, '.poiesis-settings-modal__nav button', 'AI');
    await assertTextContrast(page, '.poiesis-settings-modal__cli-status', '.poiesis-settings-modal');
    await page.screenshot({ path: resolve(artifactDirectory, `${artifactStamp}-light-ai.png`), fullPage: true });
    await clickByText(page, '.poiesis-settings-modal__nav button', '表示');

    await chooseTheme(page, 'dark');
    const dark = await readThemeState(page);
    assert(dark.bodyTheme === 'theia-dark', `Theia did not switch to dark: ${JSON.stringify(dark)}`);
    assert(luminance(dark.chromeBackground) < 0.2, `Agent chrome is not dark: ${JSON.stringify(dark)}`);
    assert(luminance(dark.settingsBackground) < 0.2, `Settings chrome is not dark: ${JSON.stringify(dark)}`);
    assert(luminance(dark.theiaEditorBackground) < 0.2, `Theia editor tokens are not dark: ${JSON.stringify(dark)}`);
    await page.screenshot({ path: darkScreenshot, fullPage: true });

    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await chooseTheme(page, 'system');
    await assertMode(page, 'light', 'system');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await assertMode(page, 'dark', 'system');
    await chooseTheme(page, 'light');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await assertMode(page, 'light', 'light');

    const scaleBeforeReload = await page.$eval('input[name="poiesis-ui-scale"][value="large"]', input => input.checked);
    assert(scaleBeforeReload, 'Changing the theme reset the unrelated display-size preference');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForPoiesis(page);
    await assertMode(page, 'light', 'light');
    await openSettings(page);
    assert(await page.$eval('input[name="poiesis-ui-scale"][value="large"]', input => input.checked),
        'Reloading after a theme change lost the unrelated display-size preference');

    await page.setViewport({ width: 360, height: 640, deviceScaleFactor: 1 });
    const narrow = await page.$eval('.poiesis-settings-modal', element => {
        const bounds = element.getBoundingClientRect();
        const themeOptions = element.querySelector('.poiesis-settings-modal__theme-options')?.getBoundingClientRect();
        return {
            modal: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
            options: themeOptions && { left: themeOptions.left, right: themeOptions.right },
            viewport: { width: innerWidth, height: innerHeight },
            horizontalOverflow: element.scrollWidth - element.clientWidth
        };
    });
    assert(narrow.modal.left >= 0 && narrow.modal.right <= narrow.viewport.width
        && narrow.modal.top >= 0 && narrow.modal.bottom <= narrow.viewport.height,
    `Settings modal does not fit the narrow viewport: ${JSON.stringify(narrow)}`);
    assert(narrow.options && narrow.options.left >= narrow.modal.left && narrow.options.right <= narrow.modal.right,
        `Theme controls overflow the narrow Settings modal: ${JSON.stringify(narrow)}`);
    assert(narrow.horizontalOverflow <= 1, `Settings has horizontal overflow: ${JSON.stringify(narrow)}`);
    await page.screenshot({ path: resolve(artifactDirectory, `${artifactStamp}-light-narrow.png`), fullPage: true });

    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.click('[aria-label="設定を閉じる"]');
    await page.screenshot({ path: resolve(artifactDirectory, `${artifactStamp}-light-agent.png`), fullPage: true });
    await clickByText(page, '.poiesis-agent-window__tabs button', 'Results');
    await page.waitForSelector('.poiesis-results');
    assert(luminance(await backgroundOf(page, '.poiesis-results')) > 0.7, 'Results outer chrome did not follow light mode');
    await page.screenshot({ path: resolve(artifactDirectory, `${artifactStamp}-light-results.png`), fullPage: true });
    const iframeBackground = await page.$eval('.poiesis-results iframe', frame => getComputedStyle(frame).backgroundColor).catch(() => undefined);
    assert(iframeBackground === undefined || iframeBackground === 'rgba(0, 0, 0, 0)' || iframeBackground === 'rgb(255, 255, 255)',
        `Results iframe received an unexpected chrome recolor: ${iframeBackground}`);

    await page.click('.poiesis-agent-window__code-control');
    await page.waitForSelector('.poiesis-agent-window__code');
    assert(luminance(await backgroundOf(page, '.poiesis-agent-window__code')) > 0.7, 'Code shell did not follow light mode');
    await page.click('.poiesis-agent-window__code-status button[aria-label="パネルを切り替える"]');
    await page.waitForSelector('.poiesis-agent-window__code-terminal-host .xterm-helper-textarea');
    const terminalColors = await page.$eval('.poiesis-agent-window__code-terminal-host', element => ({
        background: getComputedStyle(element).getPropertyValue('--theia-terminal-background')
            || getComputedStyle(document.documentElement).getPropertyValue('--theia-terminal-background'),
        foreground: getComputedStyle(document.documentElement).getPropertyValue('--theia-terminal-foreground')
    }));
    assert(luminance(terminalColors.background) > 0.7, `Terminal tokens are not light: ${JSON.stringify(terminalColors)}`);
    await page.screenshot({ path: resolve(artifactDirectory, `${artifactStamp}-light-code.png`), fullPage: true });

    await page.click('.poiesis-agent-window__code-control');
    await page.click('[aria-label="カスタマイズ"]');
    await page.waitForSelector('.poiesis-customize-view');
    assert(luminance(await backgroundOf(page, '.poiesis-agent-window__content')) > 0.7, 'Customize chrome did not follow light mode');
    await assertTextContrast(page, '.poiesis-customize-view__section-copy, .poiesis-customize-view__skill-card p', '.poiesis-agent-window__content');
    await page.screenshot({ path: resolve(artifactDirectory, `${artifactStamp}-light-customize.png`), fullPage: true });

    await page.click('[aria-label="カスタマイズ"]');
    await clickByText(page, '.poiesis-agent-window__rail-action', '新しいチャット');
    await page.waitForSelector('.poiesis-agent-window__context-pill.primary');
    await page.click('.poiesis-agent-window__context-pill.primary');
    await page.waitForSelector('.poiesis-agent-window__repository-picker');
    assert(luminance(await backgroundOf(page, '.poiesis-agent-window__repository-picker')) > 0.7,
        'Repository picker did not follow light mode');
    await waitForPersistedTheme('light');

    await browser.close();
    browser = undefined;
    stopServer(serverProcess);
    serverProcess = undefined;
    serverProcess = await startServer(port);
    browser = await launchBrowser(browserProfileTwo);
    const freshPage = await browser.newPage();
    activePage = freshPage;
    freshPage.on('console', message => browserDiagnostics.push(`console:${message.type()}: ${message.text()}`));
    freshPage.on('pageerror', error => browserDiagnostics.push(`pageerror: ${error.stack ?? error.message}`));
    freshPage.setDefaultTimeout(timeout);
    await freshPage.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await waitForPoiesis(freshPage);
    await assertMode(freshPage, 'light', 'light');

    console.log(`THEME_SMOKE_RESULT=${JSON.stringify({
        serverSetup: `cd browser-app; ${process.execPath} ../node_modules/@theia/cli/bin/theia.js start .. --plugins=local-dir:../plugins --hostname 127.0.0.1 --port ${port}`,
        serverConfig: configDirectory,
        cleanup: `terminate spawned server PID and remove ${temporaryRoot}`,
        lightScreenshot,
        darkScreenshot,
        light,
        dark,
        narrow,
        terminalColors,
        persistence: 'verified after a server restart with a fresh browser profile'
    }, null, 2)}`);
} catch (error) {
    const log = existsSync(serverLog) ? readFileSync(serverLog, 'utf8').slice(-12_000) : 'Server log was not created.';
    const pageState = activePage && !activePage.isClosed()
        ? await activePage.evaluate(() => ({
            url: location.href,
            datasets: { ...document.documentElement.dataset },
            bodyClasses: [...document.body.classList],
            body: document.body.innerHTML.slice(0, 4_000)
        })).catch(() => undefined)
        : undefined;
    console.error(`${error?.stack ?? error}\n--- browser diagnostics ---\n${browserDiagnostics.join('\n')}\n`
        + `--- page state ---\n${JSON.stringify(pageState)}\n--- isolated server log ---\n${log}`);
    process.exitCode = 1;
} finally {
    if (browser) {
        await browser.close().catch(() => undefined);
    }
    if (serverProcess) {
        stopServer(serverProcess);
    }
    const resolvedTemporaryRoot = resolve(temporaryRoot);
    assert(basename(resolvedTemporaryRoot).startsWith('poiesis-theme-smoke-'), `Refusing unsafe cleanup: ${resolvedTemporaryRoot}`);
    rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
}

async function availablePort() {
    const server = createServer();
    await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    return address.port;
}

async function startServer(port) {
    const logDescriptor = openSync(serverLog, 'a');
    const cli = resolve(repositoryRoot, 'node_modules', '@theia', 'cli', 'bin', 'theia.js');
    const args = [
        cli,
        'start',
        '..',
        '--plugins=local-dir:../plugins',
        '--hostname', '127.0.0.1',
        '--port', String(port)
    ];
    const child = spawn(process.execPath, args, {
        cwd: resolve(repositoryRoot, 'browser-app'),
        env: { ...process.env, THEIA_CONFIG_DIR: configDirectory },
        stdio: ['ignore', logDescriptor, logDescriptor],
        windowsHide: true
    });
    closeSync(logDescriptor);
    child.once('error', error => console.error(`Isolated server process error: ${error.message}`));
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Isolated server exited with code ${child.exitCode}`);
        }
        try {
            const response = await fetch(url);
            if (response.ok) {
                return child;
            }
        } catch {
            // Server is still starting.
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
    }
    throw new Error(`Isolated server did not become ready at ${url}`);
}

function stopServer(child) {
    if (child.exitCode !== null) {
        return;
    }
    if (process.platform === 'win32') {
        const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
        });
        if (result.status !== 0 && child.exitCode === null) {
            throw new Error(`Failed to terminate isolated server PID ${child.pid}`);
        }
    } else {
        child.kill('SIGTERM');
    }
}

function launchBrowser(userDataDir) {
    return puppeteer.launch({
        executablePath: browserExecutable,
        headless: true,
        userDataDir,
        defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
        args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-default-browser-check', '--no-first-run', '--no-sandbox']
    });
}

async function installSessionFixture(page) {
    await page.evaluateOnNewDocument(() => {
        const now = Date.now();
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.global.v1', JSON.stringify({
            version: 1,
            selectedSessionId: 'theme-smoke-session',
            railWidth: 232,
            railCollapsed: false,
            sessions: [{
                id: 'theme-smoke-session',
                createdAt: now,
                updatedAt: now,
                title: 'Theme smoke',
                hasUserMessage: true,
                pinned: false,
                archived: false,
                activeTab: 'agent',
                agentDraft: '',
                messages: [
                    { id: 'theme-user', role: 'user', content: 'Theme smoke request', complete: true },
                    { id: 'theme-agent', role: 'agent', content: 'Theme smoke response', complete: true }
                ],
                resultsDrafts: []
            }]
        }));
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
    });
}

async function waitForPoiesis(page) {
    await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content');
    await page.waitForSelector('.poiesis-agent-window__rail, .poiesis-agent-window__code');
    await page.waitForFunction(() => document.documentElement.dataset.poiesisThemePreference !== undefined);
}

async function waitForPersistedTheme(expected) {
    const themeFile = resolve(configDirectory, 'poiesis', 'state-v1', 'poiesis.theme-preference.v1.json');
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (existsSync(themeFile)) {
            try {
                const envelope = JSON.parse(readFileSync(themeFile, 'utf8'));
                if (envelope?.format === 1 && envelope?.key === 'poiesis.theme-preference.v1'
                    && envelope?.value?.version === 1 && envelope?.value?.preference === expected) {
                    return;
                }
            } catch {
                // An atomic replacement can briefly make the file unavailable to this poll.
            }
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
    }
    throw new Error(`Theme preference ${expected} was not durably persisted to ${themeFile}`);
}

async function openSettings(page) {
    if (!await page.$('.poiesis-settings-modal')) {
        await page.click('[aria-label="設定"]');
    }
    await page.waitForSelector('.poiesis-settings-modal');
}

async function assertThemeControls(page) {
    const controls = await page.$$eval('input[name="poiesis-display-theme"]', inputs => inputs.map(input => ({
        type: input.type,
        value: input.value,
        label: input.closest('label')?.textContent?.trim()
    })));
    assert.deepEqual(controls, [
        { type: 'radio', value: 'light', label: 'ライト' },
        { type: 'radio', value: 'dark', label: 'ダーク' },
        { type: 'radio', value: 'system', label: 'システムに合わせる' }
    ]);
    await page.keyboard.press('Tab');
    await page.focus('input[name="poiesis-display-theme"][value="dark"]');
    const focus = await page.$eval('input[name="poiesis-display-theme"][value="dark"]', input => {
        const indicator = input.nextElementSibling;
        return {
            labeled: Boolean(input.closest('[role="radiogroup"][aria-label="表示テーマ"]')),
            focused: document.activeElement === input,
            outlineStyle: indicator && getComputedStyle(indicator).outlineStyle,
            outlineWidth: indicator && getComputedStyle(indicator).outlineWidth
        };
    });
    assert(focus.labeled && focus.focused && focus.outlineStyle === 'solid' && parseFloat(focus.outlineWidth) >= 2,
        `Theme radios are not accessibly labeled and visibly focused: ${JSON.stringify(focus)}`);
}

async function chooseRadio(page, name, value) {
    await page.$eval(`input[name="${name}"][value="${value}"]`, input => input.click());
    await page.waitForFunction((radioName, radioValue) => document.querySelector(`input[name="${radioName}"][value="${radioValue}"]`)?.checked,
        {}, name, value);
}

async function clickByText(page, selector, text) {
    const clicked = await page.$$eval(selector, (elements, expected) => {
        const element = elements.find(candidate => candidate.textContent?.trim() === expected);
        if (!(element instanceof HTMLElement)) {
            return false;
        }
        element.click();
        return true;
    }, text);
    assert(clicked, `Could not find ${text} in ${selector}`);
}

async function chooseTheme(page, preference) {
    await chooseRadio(page, 'poiesis-display-theme', preference);
    await page.waitForFunction(expected => document.documentElement.dataset.poiesisThemePreference === expected,
        {}, preference);
    const effective = preference === 'system'
        ? await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : preference;
    await assertMode(page, effective, preference);
}

async function assertMode(page, mode, preference = mode) {
    try {
        await page.waitForFunction((expectedMode, expectedPreference) => {
        const root = document.documentElement;
        return root.dataset.poiesisColorMode === expectedMode
            && root.dataset.poiesisThemePreference === expectedPreference
            && document.body.classList.contains(`theia-${expectedMode}`);
        }, {}, mode, preference);
    } catch (error) {
        const actual = await page.evaluate(() => ({ root: { ...document.documentElement.dataset }, bodyClass: document.body.className }));
        throw new Error(`Expected ${mode}/${preference}; actual ${JSON.stringify(actual)}`, { cause: error });
    }
}

async function readThemeState(page) {
    return page.$eval('.poiesis-settings-modal', settings => {
        const rootStyle = getComputedStyle(document.documentElement);
        const content = document.querySelector('.poiesis-agent-window__content');
        return {
            preference: document.documentElement.dataset.poiesisThemePreference,
            mode: document.documentElement.dataset.poiesisColorMode,
            designTheme: document.documentElement.dataset.poiesisDesignTheme,
            bodyTheme: [...document.body.classList].find(name => name === 'theia-light' || name === 'theia-dark'),
            chromeBackground: content && getComputedStyle(content).backgroundColor,
            settingsBackground: getComputedStyle(settings).backgroundColor,
            theiaEditorBackground: rootStyle.getPropertyValue('--theia-editor-background').trim()
        };
    });
}

function backgroundOf(page, selector) {
    return page.$eval(selector, element => getComputedStyle(element).backgroundColor);
}

async function assertTextContrast(page, selector, surfaceSelector) {
    const colors = await page.$$eval(selector, (elements, surface) => ({
        background: getComputedStyle(document.querySelector(surface)).backgroundColor,
        texts: elements.map(element => ({ color: getComputedStyle(element).color, text: element.textContent?.trim().slice(0, 60) }))
    }), surfaceSelector);
    assert(colors.texts.length > 0, `No text found for contrast check: ${selector}`);
    for (const text of colors.texts) {
        const foreground = luminance(text.color);
        const background = luminance(colors.background);
        const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        assert(ratio >= 4.5, `Low text contrast (${ratio.toFixed(2)}): ${text.text}`);
    }
}

function luminance(color) {
    const text = String(color).trim();
    const hex = /^#([\da-f]{6})$/i.exec(text);
    const values = hex
        ? hex[1].match(/../g).map(channel => parseInt(channel, 16))
        : text.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    assert(values?.length === 3, `Could not parse color: ${color}`);
    const channels = values.map(value => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
