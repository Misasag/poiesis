import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = process.cwd();
const timeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 180_000);
const pageUrl = option('--url');
const browserUrl = option('--cdp') ?? option('--browser-url');
const workspaceArg = option('--workspace');
if ((!pageUrl && !browserUrl) || (pageUrl && browserUrl) || !workspaceArg) {
    throw new Error('Usage: node scripts/smoke-code-workspace.mjs (--url <page-url> | --cdp <browser-url>) --workspace <path>');
}

const workspace = resolve(workspaceArg);
const runDirectory = resolve(root, '.run', `code-workspace-${Date.now()}`);
const screenshotPath = resolve(runDirectory, 'code-workspace.png');
const failureScreenshotPath = resolve(runDirectory, 'failure.png');
const fixtureId = `${process.pid}-${Date.now()}`;
const alphaDirectoryName = `code-smoke-alpha-${fixtureId}`;
const betaDirectoryName = `code-smoke-beta-${fixtureId}`;
const alphaDirectory = resolve(workspace, alphaDirectoryName);
const betaDirectory = resolve(workspace, betaDirectoryName);
const searchFileName = `unopened-review-${fixtureId}.txt`;
const quickFileName = `quick-unopened-${fixtureId}.txt`;
const searchMarker = `ReviewUnopened${fixtureId.replaceAll('-', '')}`;

mkdirSync(runDirectory, { recursive: true });
mkdirSync(alphaDirectory, { recursive: true });
mkdirSync(betaDirectory, { recursive: true });
writeFileSync(resolve(workspace, searchFileName), `${searchMarker}\n`, 'utf8');
writeFileSync(resolve(workspace, quickFileName), 'Quick open unopened file discovery\n', 'utf8');
writeFileSync(resolve(alphaDirectory, 'config.js'), longConfig('alpha'), 'utf8');
writeFileSync(resolve(betaDirectory, 'config.js'), longConfig('beta'), 'utf8');

let browser;
let launchedBrowser = false;
let page;
try {
    if (browserUrl) {
        browser = await puppeteer.connect({ browserURL: browserUrl, defaultViewport: null });
    } else {
        const executablePath = [
            process.env.CHROME_PATH,
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        ].filter(Boolean).find(candidate => existsSync(candidate));
        if (!executablePath) throw new Error('Chrome or Edge was not found.');
        browser = await puppeteer.launch({
            executablePath,
            headless: true,
            defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
            args: ['--disable-gpu', '--no-first-run', '--no-sandbox']
        });
        launchedBrowser = true;
    }

    const pages = await browser.pages();
    page = browserUrl
        ? pages.find(candidate => candidate.url() !== 'about:blank' && !candidate.url().startsWith('devtools://')) ?? await browser.newPage()
        : pages[0] ?? await browser.newPage();
    page.setDefaultTimeout(timeout);
    if (pageUrl) {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout });
    }
    await page.waitForSelector('.poiesis-agent-window__content:not(.poiesis-agent-window__content--initializing)');
    await clickText(page, '.poiesis-agent-window__code-control', 'Code');
    await page.waitForSelector('.poiesis-agent-window__code');
    const explorerWorkspace = await page.$eval(
        '.poiesis-agent-window__code-explorer-root strong',
        element => element.textContent?.trim()
    );
    assert(explorerWorkspace?.toLocaleLowerCase() === basename(workspace).toLocaleLowerCase(),
        `The app workspace is ${explorerWorkspace}; expected ${basename(workspace)}.`);
    assert(await page.$eval('.poiesis-agent-window__code-control', element => element.textContent?.trim()) === 'Agent',
        'Code return control did not identify Agent.');
    assert(await page.$eval('.poiesis-agent-window__code-control', element => element.getAttribute('aria-label')) === 'Agent に戻る',
        'Code return control did not preserve the Agent destination.');
    assert(!await page.$('.poiesis-agent-window__code-panel'), 'Code opened an unrelated Terminal panel.');
    const initialEditorTabs = await page.$$eval('.poiesis-agent-window__code-editor-tab-label', tabs => tabs.map(tab => tab.title));
    assert(initialEditorTabs.length === 0,
        `Code workspace smoke requires a fresh profile with no restored editor tabs: ${JSON.stringify(initialEditorTabs)}.`);

    await page.focus('.poiesis-agent-window__code-control');
    const editorWidthWithSidebar = await page.$eval('.poiesis-agent-window__code-editor', element => element.getBoundingClientRect().width);
    await page.keyboard.down('Control');
    await page.keyboard.press('B');
    await page.keyboard.up('Control');
    await page.waitForSelector('.poiesis-agent-window__code.sidebar-collapsed');
    const editorWidthWithoutSidebar = await page.$eval('.poiesis-agent-window__code-editor', element => element.getBoundingClientRect().width);
    assert(editorWidthWithoutSidebar > editorWidthWithSidebar,
        `Ctrl+B did not return sidebar width to the editor: ${editorWidthWithSidebar} -> ${editorWidthWithoutSidebar}.`);
    assert(await page.$eval('.poiesis-agent-window__code-control', element => element === document.activeElement),
        'Ctrl+B did not preserve focus outside the collapsed sidebar.');
    await page.keyboard.down('Control');
    await page.keyboard.press('B');
    await page.keyboard.up('Control');
    await page.waitForSelector('.poiesis-agent-window__code:not(.sidebar-collapsed)');
    const storedLayout = await page.evaluate(() => {
        const key = Object.keys(localStorage).find(candidate => candidate.endsWith(':poiesis.code-layout.v1'));
        return key ? JSON.parse(localStorage.getItem(key) ?? '{}') : undefined;
    });
    assert(storedLayout?.sidebarCollapsed === false && storedLayout?.sidebarTab === 'files',
        `Code sidebar state was not persisted: ${JSON.stringify(storedLayout)}.`);
    await page.$eval('.poiesis-agent-window__code-activity button[aria-label="Explorer"]', element => element.click());
    await page.waitForSelector('.poiesis-agent-window__code.sidebar-collapsed');
    await page.$eval('.poiesis-agent-window__code-activity button[aria-label="Explorer"]', element => element.click());
    await page.waitForSelector('.poiesis-agent-window__code:not(.sidebar-collapsed)');

    await page.$eval('.poiesis-agent-window__code-activity button[aria-label="Search"]', element => element.click());
    await page.waitForSelector('#search-input-field');
    await replaceText(page, '#search-input-field', searchMarker);
    await page.keyboard.press('Enter');
    await page.waitForFunction(fileName => document.querySelector('#search-in-workspace')
        ?.textContent?.includes(fileName), {}, searchFileName);
    const searchText = await page.$eval('#search-in-workspace', element => element.textContent ?? '');
    assert(searchText.includes(searchFileName), `Workspace search did not discover unopened ${searchFileName}.`);

    await page.keyboard.down('Control');
    await page.keyboard.press('P');
    await page.keyboard.up('Control');
    await page.waitForSelector('#quick-input-container .quick-input-widget input');
    await page.focus('#quick-input-container .quick-input-widget input');
    await page.keyboard.type(quickFileName);
    await page.waitForFunction(fileName => document.querySelector('#quick-input-container .quick-input-list')
        ?.textContent?.includes(fileName), {}, quickFileName);
    const quickOpenText = await page.$eval('#quick-input-container .quick-input-list', element => element.textContent ?? '');
    assert(quickOpenText.includes(quickFileName), `Quick Open did not discover unopened ${quickFileName}.`);
    await page.keyboard.press('Escape');

    await page.$eval('.poiesis-agent-window__code-activity button[aria-label="Explorer"]', element => element.click());
    await page.waitForSelector('.poiesis-agent-window__code-explorer-more button[aria-label="その他の操作"]');
    await page.$eval('.poiesis-agent-window__code-explorer-more button[aria-label="その他の操作"]', element => element.click());
    await page.waitForSelector('.poiesis-agent-window__code-explorer-menu [role="menuitem"]');
    await clickText(page, '.poiesis-agent-window__code-explorer-menu [role="menuitem"]', 'Explorer を更新');
    await expandTreeDirectory(page, alphaDirectoryName);
    await clickTreePath(page, `${alphaDirectoryName}/config.js`, 2);
    await page.waitForFunction(directory => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length === 1
        && document.querySelector('.poiesis-agent-window__code-editor-tab')?.getAttribute('data-preview') === 'false'
        && document.querySelector('.poiesis-agent-window__code-editor-tab-label')?.getAttribute('title')?.includes(directory), {}, alphaDirectoryName);
    await waitForEditorFocus(page);
    const firstOpenFocusedEditor = await page.$eval(
        '.poiesis-agent-window__code-editor-host',
        host => host.contains(document.activeElement)
    );
    assert(firstOpenFocusedEditor, 'First-opening an Explorer file by double-click did not focus its editor.');

    await expandTreeDirectory(page, betaDirectoryName);
    await clickTreePath(page, `${betaDirectoryName}/config.js`, 1);
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length === 2);
    await waitForEditorFocus(page);
    const previewStates = await page.$$eval('.poiesis-agent-window__code-editor-tab', tabs => tabs.map(tab => tab.getAttribute('data-preview')));
    assert(previewStates.filter(value => value === 'true').length === 1
        && previewStates.filter(value => value === 'false').length === 1,
    `A new preview replaced or marked the pinned file: ${JSON.stringify(previewStates)}.`);
    await clickTreePath(page, `${betaDirectoryName}/config.js`, 2);
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-agent-window__code-editor-tab')]
        .every(tab => tab.getAttribute('data-preview') === 'false'));

    const tabLabels = await page.$$eval('.poiesis-agent-window__code-editor-tab-name', tabs => tabs.map(tab => tab.textContent?.trim() ?? ''));
    assert(tabLabels.length === 2 && new Set(tabLabels).size === 2 && tabLabels.every(label => label.includes(' — ')),
        `Same-name tabs lacked distinct path context: ${JSON.stringify(tabLabels)}.`);

    await page.click('.poiesis-agent-window__code-status button[aria-label="パネルを切り替える"]');
    await page.waitForSelector('.poiesis-agent-window__code-terminal-host .xterm-helper-textarea');
    await page.focus('.poiesis-agent-window__code-terminal-host .xterm-helper-textarea');
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
    await clickTabContaining(page, alphaDirectoryName);
    await waitForEditorFocus(page);
    const editorFocusedWithTerminalVisible = await page.$eval(
        '.poiesis-agent-window__code-editor-host',
        host => host.contains(document.activeElement)
    );
    assert(editorFocusedWithTerminalVisible, 'Selecting an editor tab with the Terminal visible did not focus the editor.');
    await page.keyboard.down('Control');
    await page.keyboard.press('G');
    await page.keyboard.up('Control');
    await page.waitForSelector('#quick-input-container .quick-input-widget input');
    await page.keyboard.type('120');
    await page.keyboard.press('Enter');
    await page.keyboard.down('Shift');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-host .selected-text'));
    const beforeRoundTrip = await readEditorState(page);
    assert(beforeRoundTrip.focusInsideEditor, 'Opening a file did not focus its editor.');
    assert(beforeRoundTrip.scrollTop > 0, `Editor did not scroll to the selected line: ${JSON.stringify(beforeRoundTrip)}.`);
    assert(beforeRoundTrip.selection.length > 0, `Editor selection was not visible: ${JSON.stringify(beforeRoundTrip)}.`);

    await clickText(page, '.poiesis-agent-window__code-control', 'Agent');
    await page.waitForSelector('.poiesis-agent-window__composer textarea');
    await clickText(page, '.poiesis-agent-window__code-control', 'Code');
    await page.waitForSelector('.poiesis-agent-window__code');
    await waitForEditorFocus(page, beforeRoundTrip.activeTab);
    const afterRoundTrip = await readEditorState(page);
    assert(afterRoundTrip.activeTab === beforeRoundTrip.activeTab,
        `Selected file changed across Agent/Code: ${beforeRoundTrip.activeTab} -> ${afterRoundTrip.activeTab}.`);
    assert(Math.abs(afterRoundTrip.scrollTop - beforeRoundTrip.scrollTop) < 2,
        `Editor scroll changed across Agent/Code: ${beforeRoundTrip.scrollTop} -> ${afterRoundTrip.scrollTop}.`);
    assert(JSON.stringify(afterRoundTrip.cursor) === JSON.stringify(beforeRoundTrip.cursor),
        `Editor cursor changed across Agent/Code: ${JSON.stringify(beforeRoundTrip.cursor)} -> ${JSON.stringify(afterRoundTrip.cursor)}.`);
    assert(JSON.stringify(afterRoundTrip.selection) === JSON.stringify(beforeRoundTrip.selection),
        `Editor selection changed across Agent/Code: ${JSON.stringify(beforeRoundTrip.selection)} -> ${JSON.stringify(afterRoundTrip.selection)}.`);
    assert(afterRoundTrip.focusInsideEditor, 'Returning to Code did not focus the selected editor.');
    assert(await page.$('.poiesis-agent-window__code-panel'), 'The explicitly opened Terminal panel was not preserved.');
    assert(await page.$('.poiesis-agent-window__code-terminal-host > *'), 'The preserved Terminal was not reattached.');

    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`CODE_WORKSPACE_SMOKE_RESULT=${JSON.stringify({
        workspace,
        searchFileName,
        quickFileName,
        tabLabels,
        previewStates,
        firstOpenFocusedEditor,
        editorFocusedWithTerminalVisible,
        beforeRoundTrip,
        afterRoundTrip,
        screenshotPath
    })}`);
} catch (error) {
    await page?.screenshot({ path: failureScreenshotPath, fullPage: false }).catch(() => undefined);
    console.error(`CODE_WORKSPACE_SMOKE_FAILURE_SCREENSHOT=${failureScreenshotPath}`);
    throw error;
} finally {
    if (browser) {
        if (launchedBrowser) await browser.close().catch(() => undefined);
        else browser.disconnect();
    }
}

function option(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}

function longConfig(name) {
    return Array.from({ length: 180 }, (_, index) => `export const ${name}Line${index + 1} = ${index + 1};`).join('\n') + '\n';
}

async function replaceText(page, selector, value) {
    await page.focus(selector);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(value);
}

async function expandTreeDirectory(page, directoryName) {
    await page.waitForFunction(suffix => [...document.querySelectorAll('#files .theia-FileStatNode[title]')]
        .some(element => (element.getAttribute('title') ?? '').replaceAll('\\', '/').toLocaleLowerCase()
            .endsWith(suffix.toLocaleLowerCase())), {}, directoryName);
    const expanded = await page.evaluate(suffix => [...document.querySelectorAll('#files .theia-FileStatNode[title]')]
        .find(element => (element.getAttribute('title') ?? '').replaceAll('\\', '/').toLocaleLowerCase()
            .endsWith(suffix.toLocaleLowerCase()))?.querySelector('.theia-ExpansionToggle:not(.theia-mod-collapsed)') != null, directoryName);
    if (!expanded) {
        const toggleBounds = await page.evaluate(suffix => {
            const node = [...document.querySelectorAll('#files .theia-FileStatNode[title]')]
                .find(element => element.title.replaceAll('\\', '/').toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase()));
            const toggle = node?.querySelector('.theia-ExpansionToggle');
            if (!toggle) throw new Error('Directory expansion toggle is unavailable.');
            const bounds = toggle.getBoundingClientRect();
            return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
        }, directoryName);
        await page.mouse.click(toggleBounds.x, toggleBounds.y, { count: 1 });
    }
    await page.waitForFunction(async suffix => {
        const find = target => [...document.querySelectorAll('#files .theia-FileStatNode[title]')]
            .find(element => element.title.replaceAll('\\', '/').toLocaleLowerCase().endsWith(target.toLocaleLowerCase()));
        const ready = () => find(suffix)?.querySelector('.theia-ExpansionToggle:not(.theia-mod-collapsed)') && find(`${suffix}/config.js`);
        const child = ready();
        if (!child) return false;
        const before = child.getBoundingClientRect();
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        const current = ready();
        if (!current || current !== child) return false;
        const after = current.getBoundingClientRect();
        return after.width > 0 && after.height > 0 && before.x === after.x && before.y === after.y;
    }, {}, directoryName);
}

async function clickTreePath(page, suffix, count) {
    const normalizedSuffix = suffix.replaceAll('\\', '/').toLocaleLowerCase();
    const nodes = await page.$$('#files .theia-FileStatNode[title]');
    for (const node of nodes) {
        const matches = await node.evaluate((element, expected) => (element.getAttribute('title') ?? '')
            .replaceAll('\\', '/').toLocaleLowerCase().endsWith(expected), normalizedSuffix);
        if (!matches) continue;
        const bounds = await node.boundingBox();
        if (!bounds) continue;
        await page.mouse.click(bounds.x + Math.min(24, bounds.width / 2), bounds.y + bounds.height / 2, {
            count,
            delay: 60
        });
        return;
    }
    throw new Error(`Explorer node ending in ${suffix} was not found.`);
}

async function clickTabContaining(page, text) {
    const tabs = await page.$$('.poiesis-agent-window__code-editor-tab-label');
    for (const tab of tabs) {
        if (!await tab.evaluate((element, expected) => element.textContent?.includes(expected) === true, text)) continue;
        const bounds = await tab.boundingBox();
        if (!bounds) continue;
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return;
    }
    throw new Error(`Editor tab containing ${text} was not found.`);
}

async function waitForEditorFocus(page, activeTab) {
    await page.waitForFunction(expectedTab => {
        const host = document.querySelector('.poiesis-agent-window__code-editor-host');
        const attachedEditor = host?.querySelector(':scope > .theia-editor, :scope > [id^="code-editor-opener"]')
            ?? host?.querySelector('.monaco-editor');
        const selectedTab = document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')
            ?.textContent?.trim();
        return Boolean(attachedEditor)
            && host?.contains(document.activeElement)
            && (!expectedTab || selectedTab === expectedTab);
    }, {}, activeTab);
}

async function readEditorState(page) {
    return page.evaluate(() => {
        const host = document.querySelector('.poiesis-agent-window__code-editor-host');
        const activeTab = document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name');
        const container = window.theia.container;
        const widgetKey = [...container._bindingDictionary._map.keys()]
            .find(key => typeof key === 'function' && key.name === 'AgentWindowWidget');
        const control = container.get(widgetKey).codePart.activeCodeCenterWidget?.editor.getControl();
        if (!control) throw new Error('The selected editor has no Monaco control.');
        const selection = (control.getSelections() ?? []).filter(value => !value.isEmpty()).map(value => ({
            startLineNumber: value.startLineNumber,
            startColumn: value.startColumn,
            endLineNumber: value.endLineNumber,
            endColumn: value.endColumn
        }));
        return {
            activeTab: activeTab?.textContent?.trim() ?? '',
            scrollTop: control.getScrollTop(),
            cursor: control.getPosition(),
            selection,
            focusInsideEditor: Boolean(host?.contains(document.activeElement))
        };
    });
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

function assert(condition, message) {
    if (!condition) throw new Error(message);
}
