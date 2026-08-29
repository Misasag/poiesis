import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const executablePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const runDirectory = resolve(root, '.run', `agent-rich-content-${Date.now()}`);
const workspace = resolve(runDirectory, 'workspace');
const previewDirectory = resolve(workspace, 'site');
const previewAssets = resolve(previewDirectory, 'assets');
const browserProfile = resolve(runDirectory, 'browser-profile');
const emptyPlugins = resolve(runDirectory, 'empty-plugins');
const theiaConfig = resolve(runDirectory, 'theia-config');
const theiaCli = resolve(root, 'node_modules', '@theia', 'cli', 'bin', 'theia.js');
mkdirSync(workspace, { recursive: true });
mkdirSync(previewAssets, { recursive: true });
mkdirSync(emptyPlugins, { recursive: true });

const workspaceSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><rect width="240" height="120" fill="#c28b60"/><circle cx="60" cy="60" r="32" fill="#20211f"/><text x="108" y="68" font-size="20" fill="#20211f">workspace</text></svg>';
const bareSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="90"><rect width="180" height="90" fill="#6577a0"/><text x="25" y="53" font-size="20" fill="white">bare path</text></svg>';
const previewLogoSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48"><rect width="96" height="48" fill="#b85c3b"/><text x="18" y="31" font-size="18" fill="white">logo</text></svg>';
const previewBackgroundSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="#8ba88e"/></svg>';
const outsideSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/></svg>';
const previewCss = [
    '@import url("https://example.com/preview-blocked-import.css");',
    '#styled-by-relative-css { color: rgb(17, 34, 51); background-image: url("./css-background.svg"); }',
    '#external-css-resource { background-image: url("https://example.com/preview-blocked-background.svg"); }'
].join('\n');
const previewHtml = [
    '<!doctype html><html><head><title>Workspace preview</title>',
    '<link rel="stylesheet" href="assets/preview.css">',
    '<link rel="stylesheet" href="../../outside.css">',
    '<link rel="stylesheet" href="https://example.com/preview-blocked.css">',
    '</head><body data-preview-source="workspace-file">',
    '<h1 id="workspace-file-marker">Workspace file HTML</h1>',
    '<div id="styled-by-relative-css">Relative stylesheet marker</div>',
    '<div id="external-css-resource">Blocked CSS resource marker</div>',
    '<img id="relative-preview-image" src="assets/logo.svg" alt="relative preview image">',
    '<img id="parent-preview-image" src="../workspace-image.svg" alt="workspace parent image">',
    '<img id="outside-preview-image" src="../../outside-image.svg" alt="outside image">',
    '<img id="external-preview-image" src="https://example.com/preview-blocked.svg" alt="external image">',
    '<script>document.documentElement.dataset.inlineScript = "ran";</script>',
    '</body></html>'
].join('');
const secondaryHtml = '<!doctype html><html><body><main id="secondary-file-marker">Secondary workspace file</main></body></html>';
writeFileSync(resolve(workspace, 'workspace-image.svg'), workspaceSvg, 'utf8');
writeFileSync(resolve(workspace, 'bare-image.svg'), bareSvg, 'utf8');
writeFileSync(resolve(workspace, 'broken.svg'), 'not an svg image', 'utf8');
writeFileSync(resolve(previewAssets, 'logo.svg'), previewLogoSvg, 'utf8');
writeFileSync(resolve(previewAssets, 'css-background.svg'), previewBackgroundSvg, 'utf8');
writeFileSync(resolve(previewAssets, 'preview.css'), previewCss, 'utf8');
writeFileSync(resolve(runDirectory, 'outside-image.svg'), outsideSvg, 'utf8');
writeFileSync(resolve(runDirectory, 'outside.css'), 'body { outline: 20px solid red; }', 'utf8');
writeFileSync(resolve(previewDirectory, 'preview.html'), previewHtml, 'utf8');
writeFileSync(resolve(workspace, 'secondary.htm'), secondaryHtml, 'utf8');

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
    env: { ...process.env, THEIA_CONFIG_DIR: theiaConfig },
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
for (const stream of [serverProcess.stdout, serverProcess.stderr]) {
    stream?.on('data', chunk => {
        serverLog = `${serverLog}${chunk.toString('utf8')}`.slice(-30_000);
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
    const browserErrors = [];
    const forbiddenPreviewRequests = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', message => {
        if (message.type() === 'error') browserErrors.push(message.text());
    });
    page.on('request', request => {
        if (request.url().includes('preview-blocked') || request.url().includes('outside-image.svg')) {
            forbiddenPreviewRequests.push(request.url());
        }
    });
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout });
    await waitForApp(page);
    await installFixture(page, workspace);

    try {
        await page.waitForFunction(() => {
            const image = document.querySelector('.poiesis-markdown img[alt="workspace image"]');
            return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
                && document.querySelectorAll('.poiesis-agent-html-preview').length === 2;
        }, { timeout: 20_000 });
    } catch {
        const state = await page.evaluate(() => ({
            messageText: document.querySelector('.poiesis-agent-window__message')?.textContent,
            markdownHtml: document.querySelector('.poiesis-agent-window__message .poiesis-markdown')?.innerHTML,
            imageCount: document.querySelectorAll('.poiesis-agent-window__message img').length,
            previewCount: document.querySelectorAll('.poiesis-agent-html-preview').length
        }));
        throw new Error(`Rich content did not become ready: ${JSON.stringify({ state, browserErrors })}`);
    }
    await page.waitForSelector('.poiesis-markdown a[title$="broken.svg"] code');

    const initial = await page.evaluate(() => {
        const markdown = document.querySelector('.poiesis-agent-window__message .poiesis-markdown');
        const image = markdown?.querySelector('img[alt="workspace image"]');
        const bareImage = markdown?.querySelector('img[alt="bare-image.svg"]');
        const external = markdown?.querySelector('a[data-poiesis-external-uri="https://example.com/external.png"]');
        const previews = [...document.querySelectorAll('.poiesis-agent-html-preview')];
        const frame = document.querySelector('.poiesis-agent-html-preview__frame');
        return {
            imageLoaded: image instanceof HTMLImageElement && image.naturalWidth > 0,
            imageSource: image?.getAttribute('src'),
            imageFileUri: image?.closest('a')?.getAttribute('data-poiesis-file-uri'),
            bareImageLoaded: bareImage instanceof HTMLImageElement && bareImage.naturalWidth > 0,
            externalLink: external?.getAttribute('data-poiesis-external-uri'),
            externalImageCount: markdown?.querySelectorAll('img[src^="http"], img[src^="data:"]').length ?? -1,
            brokenFallback: Boolean(markdown?.querySelector('a[title$="broken.svg"] code')),
            rawHtmlElementCount: markdown?.querySelectorAll('#llm-raw-html, article').length ?? -1,
            rawHtmlStayedText: markdown?.textContent?.includes('<article id="llm-raw-html">') === true,
            previewCount: previews.length,
            expandedCount: previews.filter(card => card.classList.contains('expanded')).length,
            collapsedCount: previews.filter(card => card.classList.contains('collapsed')).length,
            iframeCount: document.querySelectorAll('.poiesis-agent-html-preview__frame').length,
            iframeSandbox: frame?.getAttribute('sandbox'),
            iframeSource: frame?.getAttribute('srcdoc'),
            sameOriginEnabled: frame?.getAttribute('sandbox')?.split(/\s+/).includes('allow-same-origin') === true
        };
    });
    assert(initial.imageLoaded && initial.imageSource?.startsWith('blob:') && initial.imageFileUri,
        `Workspace markdown image did not load: ${JSON.stringify(initial)}`);
    assert(initial.bareImageLoaded, `Standalone bare workspace image did not load: ${JSON.stringify(initial)}`);
    assert(initial.externalLink === 'https://example.com/external.png' && initial.externalImageCount === 0,
        `External image escaped the file boundary: ${JSON.stringify(initial)}`);
    assert(initial.brokenFallback && initial.rawHtmlElementCount === 0 && initial.rawHtmlStayedText,
        `Image fallback or raw HTML escaping failed: ${JSON.stringify(initial)}`);
    assert(initial.previewCount === 2 && initial.expandedCount === 1 && initial.collapsedCount === 1
        && initial.iframeCount === 1 && initial.iframeSandbox === 'allow-scripts'
        && !initial.sameOriginEnabled
        && initial.iframeSource?.includes('workspace-file-marker')
        && initial.iframeSource?.includes("default-src 'none'")
        && initial.iframeSource?.includes('data-poiesis-preview-asset="preview.css"')
        && !initial.iframeSource?.includes('preview-blocked')
        && !initial.iframeSource?.includes('../../outside'),
    `HTML preview card boundary failed: ${JSON.stringify(initial)}`);

    let frame = await previewFrame(page, 0);
    await frame.waitForSelector('#workspace-file-marker');
    await frame.waitForFunction(() => {
        const image = document.querySelector('#relative-preview-image');
        const parentImage = document.querySelector('#parent-preview-image');
        const styled = document.querySelector('#styled-by-relative-css');
        return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
            && parentImage instanceof HTMLImageElement && parentImage.complete && parentImage.naturalWidth > 0
            && styled instanceof HTMLElement && getComputedStyle(styled).color === 'rgb(17, 34, 51)';
    });
    const frameState = await frame.evaluate(() => ({
        source: document.body.dataset.previewSource,
        script: document.documentElement.dataset.inlineScript,
        marker: document.querySelector('#workspace-file-marker')?.textContent,
        relativeImageLoaded: document.querySelector('#relative-preview-image')?.naturalWidth > 0,
        relativeImageSource: document.querySelector('#relative-preview-image')?.getAttribute('src'),
        parentImageLoaded: document.querySelector('#parent-preview-image')?.naturalWidth > 0,
        relativeCssApplied: getComputedStyle(document.querySelector('#styled-by-relative-css')).color,
        cssBackground: getComputedStyle(document.querySelector('#styled-by-relative-css')).backgroundImage,
        externalCssBackground: getComputedStyle(document.querySelector('#external-css-resource')).backgroundImage,
        outsideImageSource: document.querySelector('#outside-preview-image')?.getAttribute('src'),
        outsideImageWidth: document.querySelector('#outside-preview-image')?.naturalWidth,
        externalImageSource: document.querySelector('#external-preview-image')?.getAttribute('src'),
        externalImageWidth: document.querySelector('#external-preview-image')?.naturalWidth,
        blockedResourceCount: document.querySelectorAll('[data-poiesis-preview-asset="blocked"]').length,
        stylesheetLinkCount: document.querySelectorAll('link[rel~="stylesheet"]').length
    }));
    assert(frameState.source === 'workspace-file' && frameState.script === 'ran'
        && frameState.marker === 'Workspace file HTML',
    `The iframe did not receive the workspace file content: ${JSON.stringify(frameState)}`);
    assert(frameState.relativeImageLoaded && frameState.relativeImageSource?.startsWith('data:image/svg+xml;base64,')
        && frameState.parentImageLoaded,
    `Relative preview images did not load: ${JSON.stringify(frameState)}`);
    assert(frameState.relativeCssApplied === 'rgb(17, 34, 51)'
        && frameState.cssBackground.startsWith('url("data:image/svg+xml;base64,')
        && frameState.externalCssBackground === 'none'
        && frameState.stylesheetLinkCount === 0,
    `Relative preview CSS did not render safely: ${JSON.stringify(frameState)}`);
    assert(frameState.outsideImageSource === null && frameState.outsideImageWidth === 0
        && frameState.externalImageSource === null && frameState.externalImageWidth === 0
        && frameState.blockedResourceCount === 2 && forbiddenPreviewRequests.length === 0,
    `Preview resources escaped the workspace boundary: ${JSON.stringify({ frameState, forbiddenPreviewRequests })}`);

    const updatedHtml = previewHtml.replace('Workspace file HTML', 'Reloaded workspace HTML');
    writeFileSync(resolve(previewDirectory, 'preview.html'), updatedHtml, 'utf8');
    await page.click('[aria-label="preview.html のプレビューを再読み込み"]');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-html-preview__frame')
        ?.getAttribute('srcdoc')?.includes('Reloaded workspace HTML'));
    frame = await previewFrame(page, 0);
    await frame.waitForFunction(() => document.querySelector('#workspace-file-marker')?.textContent === 'Reloaded workspace HTML');

    const layouts = [];
    for (const size of [{ width: 1280, height: 720 }, { width: 1600, height: 900 }]) {
        await page.setViewport({ ...size, deviceScaleFactor: 1 });
        layouts.push(await assertLayout(page, `${size.width}x${size.height}`));
    }
    layouts.push(await maximizeAndAssert(page));
    assert(layouts[0].conversationWidth > 680,
        `Conversation width did not expand beyond the previous 680px limit: ${JSON.stringify(layouts)}`);
    assert(layouts[1].conversationWidth >= layouts[0].conversationWidth,
        `Conversation width shrank as the viewport grew: ${JSON.stringify(layouts)}`);
    assert(Math.abs(layouts[1].conversationWidth - 960) <= 2
        && Math.abs(layouts[2].conversationWidth - 960) <= 2,
    `Conversation width cap did not hold at large sizes: ${JSON.stringify(layouts)}`);

    await page.click('.poiesis-markdown img[alt="workspace image"]');
    await waitForCodeTab(page, 'workspace-image.svg');
    await page.click('[aria-label="Agentへ戻る"]');
    await page.waitForSelector('.poiesis-agent-window__agent');
    await page.click('[aria-label="preview.html を Code で開く"]');
    await waitForCodeTab(page, 'preview.html');

    console.log(`AGENT_RICH_CONTENT_SMOKE_RESULT=${JSON.stringify({
        workspaceImage: true,
        bareImage: true,
        externalImageBlocked: true,
        brokenImageFallback: true,
        htmlPreview: true,
        relativeImageLoaded: true,
        relativeCssApplied: true,
        workspaceEscapeBlocked: true,
        externalPreviewResourcesBlocked: true,
        allowSameOrigin: false,
        rawHtmlEscaped: true,
        reload: true,
        imageOpen: 'workspace-image.svg',
        htmlOpen: 'preview.html',
        previousConversationLimit: 680,
        conversationWidthCap: 960,
        layouts
    })}`);
} catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${ascii(detail)}\nServer log (ASCII):\n${ascii(serverLog)}`);
} finally {
    if (browser) await browser.close().catch(() => undefined);
    stopProcessTree(serverProcess);
    rmSync(runDirectory, { recursive: true, force: true });
}

async function installFixture(page, workspacePath) {
    const timestamp = Date.now();
    await page.evaluate(fixture => {
        const key = 'poiesis:global:poiesis.agent-window.sessions.global.v1';
        localStorage.setItem(key, JSON.stringify({
            version: 1,
            selectedSessionId: 'agent-rich-content-session',
            railWidth: 258,
            railCollapsed: false,
            sessions: [{
                id: 'agent-rich-content-session',
                createdAt: fixture.timestamp - 60_000,
                updatedAt: fixture.timestamp,
                workspaceUri: fixture.workspaceUri,
                branch: 'main',
                runTarget: 'local',
                title: 'Agent rich content smoke',
                hasUserMessage: true,
                pinned: false,
                archived: false,
                activeTab: 'agent',
                agentDraft: '',
                messages: [{
                    id: 'rich-user',
                    role: 'user',
                    content: 'Show workspace rich content.',
                    complete: true
                }, {
                    id: 'rich-agent',
                    role: 'agent',
                    content: [
                        '![workspace image](workspace-image.svg)',
                        '',
                        'bare-image.svg',
                        '',
                        '![broken image](broken.svg)',
                        '',
                        '![external image](https://example.com/external.png)',
                        '',
                        '![data image](data:image/png;base64,AAAA)',
                        '',
                        '[preview.html](site/preview.html)',
                        '',
                        'Secondary preview: secondary.htm',
                        '',
                        '```ts',
                        `const deliberatelyLongLine = '${'agent-width-smoke-'.repeat(18)}';`,
                        '```',
                        '',
                        '<article id="llm-raw-html"><h1>LLM raw HTML must stay text</h1></article>'
                    ].join('\n'),
                    complete: true
                }],
                resultsDrafts: []
            }]
        }));
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
    }, { workspaceUri: pathToFileURL(workspacePath).toString(), timestamp });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForApp(page);
}

async function previewFrame(page, index) {
    const frames = await page.$$('.poiesis-agent-html-preview__frame');
    const frame = await frames[index]?.contentFrame();
    if (!frame) throw new Error(`HTML preview frame ${index} was not attached.`);
    return frame;
}

async function waitForCodeTab(page, expected) {
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__content')?.getAttribute('data-mode') === 'code');
    await page.waitForFunction(label => [...document.querySelectorAll('.poiesis-agent-window__code-editor-tab-name')]
        .some(element => element.textContent?.trim() === label), {}, expected);
}

async function assertLayout(page, label) {
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const snapshot = await page.evaluate(currentLabel => {
        const messages = document.querySelector('.poiesis-agent-window__messages');
        const messagesInner = document.querySelector('.poiesis-agent-window__messages-inner');
        const composer = document.querySelector('.poiesis-agent-window__composer');
        const card = document.querySelector('.poiesis-agent-html-preview.expanded');
        const frame = document.querySelector('.poiesis-agent-html-preview__frame');
        const image = document.querySelector('.poiesis-markdown img[alt="workspace image"]');
        const codeBlock = document.querySelector('.poiesis-markdown pre');
        const bounds = element => {
            if (!(element instanceof HTMLElement)) return undefined;
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
        };
        return {
            label: currentLabel,
            viewport: { width: innerWidth, height: innerHeight },
            messages: bounds(messages),
            messagesInner: bounds(messagesInner),
            composer: bounds(composer),
            card: bounds(card),
            frame: bounds(frame),
            image: bounds(image),
            codeBlock: bounds(codeBlock),
            codeScrollWidth: codeBlock instanceof HTMLElement ? codeBlock.scrollWidth : 0,
            codeClientWidth: codeBlock instanceof HTMLElement ? codeBlock.clientWidth : 0
        };
    }, label);
    assert(snapshot.messages && snapshot.messagesInner && snapshot.composer && snapshot.card && snapshot.frame
        && snapshot.image && snapshot.codeBlock,
    `Rich content layout is incomplete at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.messagesInner.width > 680 && snapshot.messagesInner.width <= 961,
        `Conversation width is outside the expanded bounded range at ${label}: ${JSON.stringify(snapshot)}`);
    assert(Math.abs(snapshot.messagesInner.width - snapshot.composer.width) <= 2,
        `Conversation and composer widths diverged at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.card.left >= snapshot.messagesInner.left && snapshot.card.right <= snapshot.messagesInner.right + 1,
        `HTML preview escaped the conversation at ${label}: ${JSON.stringify(snapshot)}`);
    assert(Math.abs(snapshot.frame.height - 360) <= 1 && snapshot.frame.width <= snapshot.card.width + 1,
        `HTML preview dimensions changed at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.image.left >= snapshot.messagesInner.left && snapshot.image.right <= snapshot.messagesInner.right + 1,
        `Inline image escaped the conversation at ${label}: ${JSON.stringify(snapshot)}`);
    assert(snapshot.codeBlock.left >= snapshot.messagesInner.left && snapshot.codeBlock.right <= snapshot.messagesInner.right + 1
        && snapshot.codeScrollWidth > snapshot.codeClientWidth,
    `Code block did not remain bounded and horizontally scrollable at ${label}: ${JSON.stringify(snapshot)}`);
    return {
        label,
        viewport: snapshot.viewport,
        conversationWidth: Math.round(snapshot.messagesInner.width),
        composerWidth: Math.round(snapshot.composer.width),
        previewWidth: Math.round(snapshot.card.width),
        imageWidth: Math.round(snapshot.image.width),
        codeBlockWidth: Math.round(snapshot.codeBlock.width),
        codeScrollWidth: snapshot.codeScrollWidth,
        frameHeight: Math.round(snapshot.frame.height)
    };
}

async function maximizeAndAssert(page) {
    const client = await page.createCDPSession();
    let nativeMaximize = false;
    try {
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
        nativeMaximize = true;
    } catch {
        // Headless Chromium may not expose a native window.
    } finally {
        await client.detach();
    }
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    return { ...(await assertLayout(page, 'maximized')), nativeMaximize };
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

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
