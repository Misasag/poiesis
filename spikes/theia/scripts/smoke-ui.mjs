import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const uiTimeout = Number(process.env.THEIA_SMOKE_UI_TIMEOUT ?? 120_000);
const uiUrl = process.env.THEIA_SMOKE_UI_URL ?? 'http://127.0.0.1:3000';
const browserCandidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const executablePath = browserCandidates.find(candidate => existsSync(candidate));
if (!executablePath) {
    throw new Error('Chrome or Edge was not found. Set CHROME_PATH to run this smoke test.');
}

const repositoryRoot = resolve(process.cwd(), '..', '..');
const scmFixtureGitPath = 'docs/UX.md';
const scmFixturePath = resolve(repositoryRoot, scmFixtureGitPath);
const scmFixtureStatus = spawnSync('git', ['status', '--porcelain', '--', scmFixtureGitPath], {
    cwd: repositoryRoot,
    encoding: 'utf8'
});
if (scmFixtureStatus.status !== 0 || scmFixtureStatus.stdout.trim()) {
    throw new Error(`SCM smoke fixture must be clean before the test: ${scmFixtureStatus.stderr || scmFixtureStatus.stdout}`);
}
const scmFixtureOriginal = readFileSync(scmFixturePath, 'utf8');

const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    args: [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-default-browser-check',
        '--no-first-run',
        '--no-sandbox'
    ]
});

try {
    writeFileSync(scmFixturePath, `${scmFixtureOriginal}\n<!-- Lens SCM smoke change -->\n`, 'utf8');
    const page = await browser.newPage();
    page.setDefaultTimeout(uiTimeout);
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout: uiTimeout });
    await page.waitForSelector('#lens-window-host .lens-agent-window__content', { timeout: uiTimeout });
    await page.waitForSelector('.lens-agent-window__agent');
    await page.waitForSelector('.lens-agent-window__rail');

    const initial = await page.evaluate(readState);
    assert(initial.mode === 'agent', `Expected Agent mode, got ${initial.mode}`);
    assert(initial.activeSessionTab === 'Agent' || initial.headerTitle === 'New Agent',
        `Expected Agent or New Agent state, got ${initial.activeSessionTab ?? initial.headerTitle}`);
    assert(initial.agentComposerVisible, 'Agent Composer is missing');
    assert(initial.sessionRailVisible, 'Session rail is missing');
    assert(!initial.legacyChangesVisible, 'Historical Changes UI is still registered');
    assert(!initial.deferredContextControlVisible, 'Deferred context control is visible');
    assert(!initial.sessionRemoveVisible, 'Deferred Session removal is visible');

    const blankSessionCount = await page.$$eval('.lens-agent-window__session-row[data-session-archived="false"]', rows => rows.length);
    await click(page, '.lens-agent-window__rail-action', 'New Chat');
    await page.waitForFunction(expected =>
        document.querySelectorAll('.lens-agent-window__session-row[data-session-archived="false"]').length === expected
        && document.activeElement?.getAttribute('aria-label') === 'Agent へのメッセージ', {}, blankSessionCount);
    await page.focus('[aria-label="Agent へのメッセージ"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await insertComposedText(page, 'あ');
    const firstJapaneseInput = await page.$eval('[aria-label="Agent へのメッセージ"]', input => input.value);
    assert(firstJapaneseInput === 'あ', `Composer duplicated the first Japanese input: ${JSON.stringify(firstJapaneseInput)}`);
    await insertComposedText(page, 'ああ');
    const repeatedJapaneseInput = await page.$eval('[aria-label="Agent へのメッセージ"]', input => input.value);
    assert(repeatedJapaneseInput === 'ああ', `Composer duplicated repeated Japanese input: ${JSON.stringify(repeatedJapaneseInput)}`);

    await page.evaluate(() => {
        const now = Date.now();
        const session = (id, title, updatedAt) => ({
            id,
            createdAt: updatedAt - 60_000,
            updatedAt,
            title,
            hasUserMessage: true,
            pinned: false,
            archived: false,
            activeTab: 'agent',
            agentDraft: '',
            messages: [{ id: `restored-${id}`, role: 'agent', content: `${title} restored`, complete: true }],
            resultsDrafts: []
        });
        const storageKey = Object.keys(localStorage).find(key => key.endsWith(':lens.agent-window.sessions.v1'))
            ?? `theia:${location.pathname}:lens.agent-window.sessions.v1`;
        localStorage.setItem(storageKey, JSON.stringify({
            version: 1,
            selectedSessionId: 'smoke-alpha',
            railWidth: 252,
            railCollapsed: false,
            sessions: [
                session('smoke-alpha', 'Alpha session', now - 1_000),
                session('smoke-beta', 'Beta session', now)
            ]
        }));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-session-id="smoke-alpha"]');
    await page.waitForSelector('[data-session-id="smoke-beta"]');

    await page.click('[data-session-id="smoke-beta"] .lens-agent-window__session-menu-trigger');
    await click(page, '.lens-agent-window__session-menu button', 'ピン留め');
    await page.waitForSelector('[data-session-id="smoke-beta"][data-session-pinned="true"]');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__session-section-label')?.textContent === 'Pinned');

    await page.click('[data-session-id="smoke-beta"] .lens-agent-window__session-menu-trigger');
    await click(page, '.lens-agent-window__session-menu button', '名前を変更');
    await page.waitForSelector('[data-session-id="smoke-beta"] .lens-agent-window__session-rename');
    await page.click('[data-session-id="smoke-beta"] .lens-agent-window__session-rename');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.type('[data-session-id="smoke-beta"] .lens-agent-window__session-rename', 'Pinned session');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-session-id="smoke-beta"] .lens-agent-window__session-title')?.textContent === 'Pinned session');

    const railWidthBefore = await page.$eval('.lens-agent-window__rail', element => element.getBoundingClientRect().width);
    await page.focus('.lens-agent-window__rail-resize-handle');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(width => document.querySelector('.lens-agent-window__rail')?.getBoundingClientRect().width === width + 12, {}, railWidthBefore);

    await page.click('[data-session-id="smoke-alpha"] .lens-agent-window__session-menu-trigger');
    await click(page, '.lens-agent-window__session-menu button', 'アーカイブ');
    await page.waitForSelector('.lens-agent-window__archived-toggle');
    await page.click('.lens-agent-window__archived-toggle');
    await page.waitForSelector('[data-session-id="smoke-alpha"][data-session-archived="true"]');
    await page.click('[data-session-id="smoke-alpha"] .lens-agent-window__session');
    await page.waitForSelector('[data-session-id="smoke-alpha"][data-session-archived="false"]');

    await page.click('[data-session-id="smoke-alpha"] .lens-agent-window__session-menu-trigger');
    await click(page, '.lens-agent-window__session-menu button', 'アーカイブ');
    await page.waitForSelector('[data-session-id="smoke-alpha"][data-session-archived="true"]');
    await page.click('[data-session-id="smoke-alpha"] .lens-agent-window__session-menu-trigger');
    page.once('dialog', dialog => void dialog.accept());
    await click(page, '.lens-agent-window__session-menu button', '完全に削除');
    await page.waitForFunction(() => !document.querySelector('[data-session-id="smoke-alpha"]'));

    const activeCountBeforeNewChat = await page.$$eval('.lens-agent-window__session-row[data-session-archived="false"]', rows => rows.length);
    await click(page, '.lens-agent-window__rail-action', 'New Chat');
    await page.waitForFunction(expected =>
        document.querySelectorAll('.lens-agent-window__session-row[data-session-archived="false"]').length === expected,
    {}, activeCountBeforeNewChat);
    await page.waitForSelector('.lens-agent-window__new-agent-empty');
    await page.waitForSelector('.lens-agent-window__new-agent-context');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__context > strong')?.textContent === 'New Agent');
    const newAgentContext = await page.evaluate(() => ({
        repository: document.querySelector('.lens-agent-window__context-pill.primary span:not(.codicon)')?.textContent,
        branch: document.querySelectorAll('.lens-agent-window__context-pill')[1]?.textContent?.trim(),
        runOn: document.querySelector('.lens-agent-window__context-pill.static')?.textContent?.trim(),
        resultsTabVisible: [...document.querySelectorAll('.lens-agent-window__tabs button')]
            .some(button => button.textContent?.trim() === 'Results')
    }));
    assert(newAgentContext.repository && newAgentContext.repository !== 'Select repository', 'New Agent must inherit an explicit repository');
    assert(newAgentContext.branch, 'New Agent branch picker is missing');
    assert(newAgentContext.runOn === 'Run on · This Computer', `Unexpected run target: ${newAgentContext.runOn}`);
    assert(!newAgentContext.resultsTabVisible, 'New Agent must not expose Results before the first run');

    await page.click('.lens-agent-window__context-pill.primary');
    await page.waitForSelector('[aria-label="Repositoryを選択"]');
    await page.waitForFunction(() => {
        const labels = [...document.querySelectorAll('.lens-agent-window__repository-group-label')]
            .map(label => label.textContent?.trim());
        return labels.includes('No Repo') && labels.includes('Recents') && labels.includes('On This PC');
    });
    await page.type('[aria-label="Repositoryを検索"]', '__no_matching_repository__');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__repository-empty')?.textContent?.includes('一致するRepository'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Repositoryを選択"]'));
    await page.click('.lens-agent-window__context-pill.primary');
    await page.waitForSelector('[aria-label="Repositoryを選択"]');
    await click(page, '.lens-agent-window__repository-footer button', 'New Folder');
    await page.waitForSelector('[aria-label="フォルダーを選択"]');
    await page.waitForSelector('[aria-label="フォルダーパス"]');
    await page.waitForFunction(() => document.querySelector('[aria-label="フォルダーパス"]')?.value?.length > 0);
    await page.click('[aria-label="フォルダー選択を閉じる"]');
    await page.waitForFunction(() => !document.querySelector('[aria-label="フォルダーを選択"]'));

    const resizedRailWidth = await page.$eval('.lens-agent-window__rail', element => element.getBoundingClientRect().width);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-session-id="smoke-beta"][data-session-pinned="true"]');
    await page.waitForFunction(expectedWidth =>
        document.querySelector('.lens-agent-window__rail')?.getBoundingClientRect().width === expectedWidth
        && !document.querySelector('[data-session-id="smoke-alpha"]'), {}, resizedRailWidth);
    const sidebar = await page.evaluate(() => ({
        activeSessionCount: document.querySelectorAll('.lens-agent-window__session-row[data-session-archived="false"]').length,
        pinnedTitle: document.querySelector('[data-session-pinned="true"] .lens-agent-window__session-title')?.textContent,
        railWidth: document.querySelector('.lens-agent-window__rail')?.getBoundingClientRect().width,
        archivedCount: document.querySelectorAll('.lens-agent-window__session-row[data-session-archived="true"]').length
    }));

    await page.click('.lens-agent-window__repository-open');
    await page.waitForSelector('[aria-label="Workspaceを開く"]');
    await page.waitForSelector('[aria-label="Workspaceを検索"]');
    await page.type('[aria-label="Workspaceを検索"]', '__no_matching_workspace__');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__workspace-picker-empty')?.textContent?.includes('一致するWorkspace'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Workspaceを開く"]'));

    await click(page, '.lens-agent-window__rail-action', 'Search');
    await page.waitForSelector('[aria-label="会話をタイトルで検索"]');
    await page.type('[aria-label="会話をタイトルで検索"]', '__no_matching_session__');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__session-empty')?.textContent?.includes('一致する会話'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[aria-label="会話をタイトルで検索"]'));
    await page.click('[data-session-id="smoke-beta"] .lens-agent-window__session');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__context > strong')?.textContent === 'Pinned session');

    await click(page, '.lens-agent-window__tabs button', 'Results');
    await page.waitForSelector('.lens-results');
    const results = await page.evaluate(readState);
    assert(results.mode === 'results', `Expected Results mode, got ${results.mode}`);
    assert(results.activeSessionTab === 'Results', `Expected Results tab, got ${results.activeSessionTab}`);
    assert(results.resultsComposerVisible, 'Results Composer is missing');
    assert(results.resultsEmptyVisible, 'Results empty state is missing');

    await click(page, '.lens-agent-window__code-control', 'Code');
    await page.waitForSelector('.lens-agent-window__code');
    const code = await page.evaluate(readState);
    assert(code.mode === 'code', `Expected Code mode, got ${code.mode}`);
    assert(!code.sessionRailVisible, 'Session rail must be hidden in Code mode');
    assert(code.codeSidebarVisible, 'Code sidebar is missing');
    assert(code.codeEditorVisible, 'Code editor host is missing');
    assert(code.codeActivityVisible, 'Code Activity Bar is missing');
    assert(code.codePanelVisible, 'Code bottom panel is missing');
    assert(code.codeTerminalVisible, 'Code terminal is missing');
    assert(code.codeStatusVisible, 'Code status bar is missing');
    assert(code.codeLuminoPanelCount === 0, 'Code must not contain lm-Widget lm-Panel wrappers');
    assert(code.codeLuminoTabContainerCount === 0, 'Code must not contain lm-TabBar-content-container wrappers');
    assert(!code.applicationShellVisible, 'Code must not mount the Theia ApplicationShell');
    assert(code.sessionTabCount === 0, 'Agent / Results tabs must be hidden in Code mode');
    while (await page.$('.lens-agent-window__code-editor-tab-close')) {
        const tabCount = await page.$$eval('.lens-agent-window__code-editor-tab', tabs => tabs.length);
        await page.click('.lens-agent-window__code-editor-tab-close');
        await page.waitForFunction(count => document.querySelectorAll('.lens-agent-window__code-editor-tab').length < count, {}, tabCount);
    }
    for (const label of ['New File', 'New Folder', 'Refresh Explorer', 'Collapse Folders']) {
        assert(await page.$(`.lens-agent-window__code-sidebar-actions button[aria-label="${label}"]`), `Explorer action is missing: ${label}`);
    }
    const explorerWidth = await page.$eval('.lens-agent-window__code-sidebar', element => element.getBoundingClientRect().width);
    await page.focus('.lens-agent-window__code-sidebar-resize');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(width => document.querySelector('.lens-agent-window__code-sidebar')?.getBoundingClientRect().width === width + 12, {}, explorerWidth);
    await page.click('.lens-agent-window__code-sidebar-resize', { count: 2, delay: 80 });
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-sidebar')?.getBoundingClientRect().width === 260);
    await page.click('.lens-agent-window__code-sidebar-actions button[aria-label="Refresh Explorer"]');
    await page.waitForSelector('#files .theia-FileStatNode');
    assert(await page.$('#files .theia-FileStatNode[title$=".gitignore"] .git-icon.file-icon'), 'Explorer must show a Git icon for .gitignore');
    for (const [folder, child] of [['spikes', 'theia'], ['theia', 'scripts'], ['scripts', 'smoke-ui.mjs']]) {
        await page.evaluate(label => {
            const node = [...document.querySelectorAll('#files .theia-FileStatNode')]
                .find(element => element.textContent?.trim() === label);
            node?.querySelector('.theia-ExpansionToggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        }, folder);
        await page.waitForFunction(label => [...document.querySelectorAll('#files .theia-FileStatNode')]
            .some(element => element.textContent?.trim() === label), {}, child);
    }
    assert(await page.$('#files .theia-FileStatNode[title$="smoke-ui.mjs"] .js-icon.file-icon'), 'Explorer must show a JavaScript icon for .js/.mjs files');
    await page.click('.lens-agent-window__code-sidebar-actions button[aria-label="Collapse Folders"]');
    await page.waitForFunction(() => ![...document.querySelectorAll('#files .theia-FileStatNode')]
        .some(element => element.textContent?.trim() === 'smoke-ui.mjs'));
    await page.click('.lens-agent-window__code-explorer-more button[aria-label="More Actions"]');
    await page.waitForSelector('.lens-agent-window__code-explorer-menu[role="menu"]');
    const explorerMenuItems = await page.$$eval('.lens-agent-window__code-explorer-menu [role="menuitem"]', items => items.map(item => item.textContent?.trim()));
    for (const label of ['Toggle Hidden Files', 'Auto Reveal', 'Refresh Explorer', 'Collapse Folders']) {
        assert(explorerMenuItems.includes(label), `Explorer More Actions is missing: ${label}`);
    }
    await click(page, '.lens-agent-window__code-explorer-menu [role="menuitem"]', 'Auto Reveal');
    await page.waitForFunction(() => !document.querySelector('.lens-agent-window__code-explorer-menu'));

    await page.click('.lens-agent-window__code-activity button[aria-label="Search"]');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Search');
    await page.waitForSelector('#search-input-field');
    await page.waitForFunction(() => document.activeElement?.id === 'search-input-field');
    for (const label of ['Refresh Search Results', 'Clear Search Results', 'Collapse All Search Results']) {
        assert(await page.$(`.lens-agent-window__code-sidebar-actions button[aria-label="${label}"]`), `Search action is missing: ${label}`);
    }
    await page.click('.lens-agent-window__code-sidebar-actions button[aria-label="Clear Search Results"]');
    await page.focus('#search-input-field');
    const codeSearchQuery = ['Source contract', 'validation passed.'].join(' ');
    await page.type('#search-input-field', codeSearchQuery);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#search-in-workspace .search-info')?.textContent?.includes('2 results in 2 files'));
    await page.waitForFunction(() => document.querySelectorAll('#search-in-workspace .theia-TreeNode:not(.theia-CompositeTreeNode)').length === 2);
    await page.click('#search-in-workspace .replace-toggle[title="Toggle Replace"]');
    await page.waitForSelector('#search-in-workspace .replace-field:not(.hidden) #replace-input-field');
    await page.click('#search-in-workspace [title="Toggle Search Details"]');
    await page.waitForSelector('#search-in-workspace .glob-field-container:not(.hidden) #include-glob-field');
    await page.waitForSelector('#search-in-workspace .glob-field-container:not(.hidden) #exclude-glob-field');
    await page.click('.lens-agent-window__code-sidebar-actions button[aria-label="Refresh Search Results"]');
    await page.waitForFunction(() => document.querySelectorAll('#search-in-workspace .theia-TreeNode:not(.theia-CompositeTreeNode)').length === 2);
    await page.evaluate(() => {
        const result = [...document.querySelectorAll('#search-in-workspace .theia-TreeNode:not(.theia-CompositeTreeNode)')]
            .find(node => node.textContent?.includes("console.log('Source contract " + "validation passed.');"));
        if (!(result instanceof HTMLElement)) throw new Error('Search result row is missing');
        result.click();
    });
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === 'validate-source.mjs');
    await page.click('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-close');
    await page.waitForFunction(() => ![...document.querySelectorAll('.lens-agent-window__code-editor-tab-name')]
        .some(element => element.textContent?.trim() === 'validate-source.mjs'));
    await page.click('.lens-agent-window__code-sidebar-actions button[aria-label="Collapse All Search Results"]');
    await page.waitForFunction(() => document.querySelectorAll('#search-in-workspace .theia-TreeNode:not(.theia-CompositeTreeNode)').length === 0);
    await page.click('.lens-agent-window__code-sidebar-actions button[aria-label="Clear Search Results"]');
    await page.waitForFunction(() => document.querySelector('#search-input-field')?.value === ''
        && document.querySelectorAll('#search-in-workspace .theia-TreeNode').length === 0);
    await page.click('.lens-agent-window__code-activity button[aria-label="Source Control"]');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Source Control');
    await page.waitForSelector('.lens-agent-window__code-sidebar-actions button[aria-label="Refresh Source Control"]');
    await page.waitForSelector('[data-node-id="workingTree"]');
    const scmLayoutDoesNotOverlap = await page.evaluate(() => {
        const action = document.getElementById('scm-action-button-widget');
        const changes = document.querySelector('[data-node-id="workingTree"]')?.closest('.theia-TreeNode');
        if (!(action instanceof HTMLElement) || !(changes instanceof HTMLElement)) return false;
        return action.getBoundingClientRect().bottom <= changes.getBoundingClientRect().top;
    });
    assert(scmLayoutDoesNotOverlap, 'Source Control action buttons overlap the Changes accordion');
    await page.evaluate(() => {
        const toggle = document.querySelector('[data-node-id="workingTree"]');
        if (toggle?.classList.contains('theia-mod-collapsed')) {
            toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        }
    });
    await page.waitForFunction(() => !document.querySelector('[data-node-id="workingTree"]')?.classList.contains('theia-mod-collapsed'));
    const scmGroupPoint = await page.evaluate(() => {
        const label = document.querySelector('[data-node-id="workingTree"]')?.nextElementSibling;
        if (!(label instanceof HTMLElement)) throw new Error('Changes accordion label is missing');
        const bounds = label.getBoundingClientRect();
        return { x: bounds.left + 8, y: bounds.top + bounds.height / 2 };
    });
    await page.mouse.move(scmGroupPoint.x, scmGroupPoint.y);
    await page.mouse.down();
    await page.mouse.move(scmGroupPoint.x + 4, scmGroupPoint.y, { steps: 3 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('[data-node-id="workingTree"]')?.classList.contains('theia-mod-collapsed'));
    assert(await page.evaluate(() => !window.getSelection()?.toString()), 'Changes accordion text was selected');
    await page.click('[data-node-id="workingTree"] + .noWrapInfo');
    await page.waitForFunction(() => !document.querySelector('[data-node-id="workingTree"]')?.classList.contains('theia-mod-collapsed'));
    await page.waitForSelector('.lens-agent-window__code-git-graph-title[aria-expanded="true"]');
    await page.waitForSelector('.lens-agent-window__code-git-graph-host #scm-history-graph-widget');
    await page.waitForSelector('.lens-agent-window__code-git-graph-host .scm-history-graph-row svg');
    assert(!await page.$('.lens-agent-window__code .lm-Widget.lm-Panel'), 'Source Control Graph must not restore a Lumino panel');
    await page.click('.lens-agent-window__code-git-graph-title');
    await page.waitForSelector('.lens-agent-window__code-git-graph-title[aria-expanded="false"]');
    await page.waitForSelector('.lens-agent-window__code-git-graph-host[hidden]');
    await page.click('.lens-agent-window__code-git-graph-title');
    await page.waitForSelector('.lens-agent-window__code-git-graph-host:not([hidden])');
    await page.waitForSelector('.lens-agent-window__code-git-graph-host .scm-history-graph-row');
    await page.click('.lens-agent-window__code-sidebar-actions button[aria-label="Refresh Source Control"]');
    await waitForScmAction(page, 'UX.md', 'Stage Changes');
    await hoverScmResource(page, 'UX.md');
    for (const action of ['Open File', 'Discard Changes', 'Stage Changes']) {
        assert(await scmActionExists(page, 'UX.md', action), `Source Control action is missing: ${action}`);
    }
    await executeScmAction(page, 'UX.md', 'Stage Changes', 'staged');
    await page.click('.lens-agent-window__code-sidebar-actions button[aria-label="Refresh Source Control"]');
    await waitForScmAction(page, 'UX.md', 'Unstage Changes');
    await executeScmAction(page, 'UX.md', 'Unstage Changes', 'unstaged');
    await page.click('.lens-agent-window__code-sidebar-actions button[aria-label="Refresh Source Control"]');
    await waitForScmAction(page, 'UX.md', 'Stage Changes');
    await openScmResourceDiff(page, 'UX.md');
    await page.click('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-close');
    await page.waitForFunction(() => ![...document.querySelectorAll('.lens-agent-window__code-editor-tab-name')]
        .some(element => element.textContent?.trim().startsWith('UX.md')));
    restoreScmFixture();
    await page.click('.lens-agent-window__code-activity button[aria-label="Extensions"]');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Extensions');
    await page.waitForSelector('.lens-agent-window__code-sidebar-host > *');
    await page.waitForFunction(() => document.querySelector('#vsx-extensions-search-bar input')?.value === '@builtin');
    await page.waitForFunction(() => (document.getElementById('vsx-extensions:builtin')?.querySelectorAll('.theia-TreeNode').length ?? 0) > 0);
    assert(!await page.$('.lens-agent-window__customize-page'), 'Code Extensions must stay in Code mode');
    await page.click('.lens-agent-window__code-activity-footer button[aria-label="Settings"]');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === 'Settings');
    await page.waitForSelector('.lens-agent-window__code-editor-host #settings_widget');
    assert(await page.$('.lens-agent-window__code'), 'Code Settings must stay in Code mode');
    await page.click('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-close');
    await page.waitForFunction(() => ![...document.querySelectorAll('.lens-agent-window__code-editor-tab-name')]
        .some(element => element.textContent?.trim() === 'Settings'));
    await page.click('.lens-agent-window__code-activity button[aria-label="Explorer"]');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Explorer');
    await page.waitForFunction(() => [...document.querySelectorAll('#files .theia-FileStatNode')]
        .some(element => element.textContent?.trim() === '.gitignore'));
    const clickExplorerFile = async label => {
        const point = await page.evaluate(fileLabel => {
            const file = [...document.querySelectorAll('#files .theia-FileStatNode')]
                .find(element => element.textContent?.trim() === fileLabel);
            if (!(file instanceof HTMLElement)) throw new Error(`${fileLabel} was not found in Explorer`);
            file.scrollIntoView({ block: 'center' });
            const bounds = file.getBoundingClientRect();
            return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
        }, label);
        await page.mouse.click(point.x, point.y);
        assert(await page.evaluate(fileLabel => {
            const file = [...document.querySelectorAll('#files .theia-FileStatNode')]
                .find(element => element.textContent?.trim() === fileLabel);
            return file instanceof HTMLElement
                && file.draggable
                && !document.body.classList.contains('lens-code-file-pointer-drag');
        }, label), `${label} click left stale drag state behind`);
    };
    const dragExplorerFileToTabs = async label => {
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
            `${label} drag did not enter an accepted tab-bar drop target`);
        assert(await page.evaluate(({ x, y }) => {
            const target = document.elementFromPoint(x, y);
            return document.body.classList.contains('lens-code-file-pointer-drag')
                && !!target
                && getComputedStyle(target).cursor === 'copy';
        }, points.target), `${label} drag did not switch from the browser no-drop cursor to copy`);
        await page.mouse.up();
        assert(await page.evaluate(fileLabel => {
            const file = [...document.querySelectorAll('#files .theia-FileStatNode')]
                .find(element => element.textContent?.trim() === fileLabel);
            return file instanceof HTMLElement
                && file.draggable
                && !document.body.classList.contains('lens-code-file-pointer-drag');
        }, label), `${label} drop left stale drag state behind`);
    };
    await clickExplorerFile('.gitignore');
    await page.waitForFunction(() => document.querySelectorAll('.lens-agent-window__code-editor-tab').length === 1
        && document.querySelector('.lens-agent-window__code-editor-tab.active.preview .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === '.gitignore');
    await page.evaluate(() => {
        const docs = [...document.querySelectorAll('#files .theia-FileStatNode')]
            .find(element => element.textContent?.trim() === 'docs');
        docs?.querySelector('.theia-ExpansionToggle')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#files .theia-FileStatNode')]
        .some(element => element.textContent?.trim() === 'UX.md'));
    await clickExplorerFile('UX.md');
    await page.waitForFunction(() => document.querySelectorAll('.lens-agent-window__code-editor-tab').length === 1
        && document.querySelector('.lens-agent-window__code-editor-tab.active.preview .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === 'UX.md');
    assert(!await page.evaluate(() => [...document.querySelectorAll('.lens-agent-window__code-editor-tab-name')]
        .some(tab => tab.textContent?.trim() === '.gitignore')), 'A new Explorer click must replace the previous preview tab');

    await dragExplorerFileToTabs('.gitignore');
    await page.waitForFunction(() => document.querySelectorAll('.lens-agent-window__code-editor-tab').length === 2
        && [...document.querySelectorAll('.lens-agent-window__code-editor-tab')].some(tab =>
            tab.dataset.preview === 'false' && tab.querySelector('.lens-agent-window__code-editor-tab-name')?.textContent?.trim() === '.gitignore'));

    await clickExplorerFile('PRODUCT.md');
    await page.waitForFunction(() => document.querySelectorAll('.lens-agent-window__code-editor-tab').length === 2
        && document.querySelector('.lens-agent-window__code-editor-tab.active.preview .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === 'PRODUCT.md'
        && ![...document.querySelectorAll('.lens-agent-window__code-editor-tab-name')].some(tab => tab.textContent?.trim() === 'UX.md'));

    await page.evaluate(() => {
        const docs = [...document.querySelectorAll('#files .theia-FileStatNode')]
            .find(element => element.textContent?.trim() === 'docs');
        docs?.scrollIntoView({ block: 'center' });
        const toggle = docs?.querySelector('.theia-ExpansionToggle.theia-mod-collapsed');
        toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('#files .theia-FileStatNode')]
        .some(element => element.textContent?.trim() === 'UX.md'));
    await dragExplorerFileToTabs('UX.md');
    await page.waitForFunction(() => document.querySelectorAll('.lens-agent-window__code-editor-tab').length === 3
        && document.querySelector('.lens-agent-window__code-editor-tab.active:not(.preview) .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === 'UX.md');
    await page.waitForSelector('.lens-agent-window__code-editor-host .monaco-editor');
    assert(await page.$('#files .theia-FileStatNode.theia-mod-selected'), 'Opened file must remain selected in Explorer');
    const openedCode = await page.evaluate(readState);
    assert(openedCode.editorTabs.includes('.gitignore'), 'Dragging a file must create a pinned Lens editor tab');
    assert(openedCode.editorTabs.includes('UX.md') && openedCode.editorTabs.includes('PRODUCT.md'), 'Pinned tabs and the current preview must coexist');
    assert(openedCode.editorTabs.filter(label => label === '.gitignore').length === 1, 'Explorer must open one editor tab per file');
    assert(openedCode.codeLuminoPanelCount === 0, 'Opening an editor must not reintroduce Lumino panel wrappers');
    assert(openedCode.codeLuminoTabContainerCount === 0, 'Opening an editor must not reintroduce Lumino tab wrappers');
    const editorTabState = await page.$$eval('.lens-agent-window__code-editor-tab', tabs => tabs.map(tab => ({
        name: tab.querySelector('.lens-agent-window__code-editor-tab-name')?.textContent?.trim(),
        active: tab.classList.contains('active'),
        preview: tab.dataset.preview === 'true',
        role: tab.querySelector('.lens-agent-window__code-editor-tab-label')?.getAttribute('role'),
        selected: tab.querySelector('.lens-agent-window__code-editor-tab-label')?.getAttribute('aria-selected'),
        width: Math.round(tab.getBoundingClientRect().width),
        fontStyle: getComputedStyle(tab.querySelector('.lens-agent-window__code-editor-tab-name')).fontStyle,
        fontWeight: Number(getComputedStyle(tab.querySelector('.lens-agent-window__code-editor-tab-name')).fontWeight)
    })));
    assert(editorTabState.every(tab => tab.role === 'tab' && tab.width >= 80 && tab.width <= 220), 'Editor tabs must stay within the content-fit width bounds and preserve tab semantics');
    assert(new Set(editorTabState.map(tab => tab.width)).size > 1, 'Editor tab widths must vary with file name length');
    assert(editorTabState.filter(tab => tab.active && tab.selected === 'true').length === 1, 'Exactly one editor tab must be active and selected');
    assert(editorTabState.every(tab => tab.fontWeight >= 600), 'Editor tab names must use a bold weight');
    assert(editorTabState.filter(tab => !tab.active).every(tab => tab.fontStyle === 'italic'), 'Inactive editor tab names must be italic');
    assert(editorTabState.find(tab => tab.name === 'PRODUCT.md')?.preview, 'The last Explorer click must remain the single preview tab');
    assert(await page.$('.lens-agent-window__code-editor-tab .git-icon.file-icon'), 'The Git editor tab icon is missing');
    assert(await page.$('.lens-agent-window__code-editor-tab .markdown-icon.file-icon'), 'The Markdown editor tab icon is missing');

    await click(page, '.lens-agent-window__code-editor-tab-label', 'PRODUCT.md');
    await page.click('.lens-agent-window__code-editor-host .monaco-editor .view-lines');
    await page.keyboard.type('x');
    await page.waitForSelector('.lens-agent-window__code-editor-tab.active.dirty .lens-agent-window__code-editor-tab-dirty');
    assert(!await page.$('.lens-agent-window__code-editor-tab.active.preview'), 'Editing a preview tab must pin it before another preview can replace it');
    await page.click('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-close');
    await page.waitForSelector('.lens-agent-window__code-close-dialog[role="dialog"]');
    await page.waitForFunction(() => document.body.textContent?.includes('Save changes to PRODUCT.md?'));
    assert(!await page.$('.dialogBlock'), 'Unsaved close must not use the Theia/VS Code dialogBlock');
    assert(await page.$('.lens-agent-window__code-editor-tab.active.dirty'), 'Unsaved close confirmation must appear before the tab is removed');
    await click(page, '.lens-agent-window__code-close-dialog footer button', 'Cancel');
    await page.waitForFunction(() => !document.querySelector('.lens-agent-window__code-close-dialog'));
    assert(await page.$('.lens-agent-window__code-editor-tab.active.dirty'), 'Cancel must preserve the dirty editor tab');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyZ');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => !document.querySelector('.lens-agent-window__code-editor-tab.active.dirty'));

    await page.focus('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-label');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === 'UX.md');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === 'PRODUCT.md');
    await page.click('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-close');
    await page.waitForFunction(() => document.querySelectorAll('.lens-agent-window__code-editor-tab').length === 2
        && document.querySelector('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === 'UX.md');

    await page.focus('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-label');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === '.gitignore');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === 'UX.md');
    await page.click('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-label', { button: 'middle' });
    await page.waitForFunction(() => document.querySelectorAll('.lens-agent-window__code-editor-tab').length === 1
        && document.querySelector('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-name')?.textContent?.trim() === '.gitignore');
    await page.click('.lens-agent-window__code-editor-tab-close');
    await page.waitForFunction(() => document.querySelectorAll('.lens-agent-window__code-editor-tab').length === 0
        && Boolean(document.querySelector('.lens-agent-window__code-empty')));

    await click(page, '.lens-agent-window__code-control', 'Code');
    await page.waitForSelector('.lens-results');
    const returned = await page.evaluate(readState);
    assert(returned.mode === 'results', `Code must return to Results, got ${returned.mode}`);
    assert(returned.activeSessionTab === 'Results', 'Results selection was not preserved');

    const settingsButtonHitTarget = await page.$eval('.lens-agent-window__rail-footer button[aria-label="設定"]', element => {
        const bounds = element.getBoundingClientRect();
        const center = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        return center?.closest('button') === element;
    });
    assert(settingsButtonHitTarget, 'An overlay is intercepting the Settings control');
    await page.click('.lens-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.lens-agent-window__app-page[aria-label="Lensの設定"]');
    const settings = await page.evaluate(readState);
    assert(settings.mode === 'settings', 'Settings must open the Lens-owned settings page');
    assert(!settings.codeSidebarVisible, 'Settings must not open the Code sidebar');

    await click(page, '.lens-agent-window__app-nav button', 'Customize');
    await page.waitForSelector('.lens-agent-window__app-page[aria-label="Customize"]');
    await page.waitForSelector('[aria-label="Results skillを有効化"]');
    await click(page, '.lens-agent-window__customize-tabs button', 'Plugins');
    await page.waitForFunction(() => document.querySelector('.lens-agent-window__customize-card')?.textContent?.includes('Lens plugin bundles'));
    assert(!await page.$('.lens-agent-window__plugins-host'), 'Lens Customize must not host the Code extensions manager');
    assert(!(await page.$eval('.lens-agent-window__customize-page', element => element.textContent ?? '')).includes('VS Code built-in extensions'), 'Lens Customize still describes Code extensions');
    const customize = await page.evaluate(readState);
    assert(customize.mode === 'customize', 'Customize must be a Lens-owned page');

    console.log(JSON.stringify({
        executablePath,
        uiUrl,
        viewport: { width: 1280, height: 720 },
        sidebar,
        initial,
        results,
        code,
        returned,
        settings,
        customize
    }, null, 2));
} finally {
    restoreScmFixture();
    await browser.close();
}

function restoreScmFixture() {
    spawnSync('git', ['reset', '--quiet', '--', scmFixtureGitPath], { cwd: repositoryRoot });
    writeFileSync(scmFixturePath, scmFixtureOriginal, 'utf8');
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
        await clickScmAction(page, label, action);
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

async function clickScmResource(page, label) {
    const handle = await page.evaluateHandle(fileLabel => {
        const row = [...document.querySelectorAll('#scm-resource-widget .theia-TreeNode:not(.theia-CompositeTreeNode)')]
            .find(element => element.querySelector('.name')?.textContent?.trim() === fileLabel);
        const item = row?.querySelector('.scmItem');
        if (!(item instanceof HTMLElement)) throw new Error(`${fileLabel} was not found in Source Control`);
        return item;
    }, label);
    const element = handle.asElement();
    if (!element) throw new Error(`${label} is not an SCM resource element`);
    try {
        await element.evaluate(target => target.click());
    } finally {
        await handle.dispose();
    }
}

async function openScmResourceDiff(page, label) {
    const deadline = Date.now() + uiTimeout;
    while (Date.now() < deadline) {
        if (await scmDiffIsVisible(page, label)) return;
        await clickScmResource(page, label);
        for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (await scmDiffIsVisible(page, label)) return;
        }
    }
    throw new Error(`Timed out opening the Source Control diff for ${label}`);
}

async function scmDiffIsVisible(page, label) {
    return page.evaluate(fileLabel => document.querySelector('.lens-agent-window__code-editor-tab.active .lens-agent-window__code-editor-tab-name')
        ?.textContent?.trim().startsWith(fileLabel)
        && Boolean(document.querySelector('.lens-agent-window__code-editor-host .monaco-diff-editor')), label);
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
    const handle = await page.evaluateHandle((fileLabel, actionTitle) => {
        const row = [...document.querySelectorAll('#scm-resource-widget .theia-TreeNode:not(.theia-CompositeTreeNode)')]
            .find(element => element.querySelector('.name')?.textContent?.trim() === fileLabel);
        const target = [...(row?.querySelectorAll('[title]') ?? [])]
            .find(element => element.getAttribute('title') === actionTitle);
        if (!(target instanceof HTMLElement)) throw new Error(`${actionTitle} was not found for ${fileLabel}`);
        return target;
    }, label, action);
    const element = handle.asElement();
    if (!element) throw new Error(`${action} on ${label} is not an element`);
    try {
        await element.hover();
        await new Promise(resolve => setTimeout(resolve, 150));
        const stable = await element.evaluate(target => target.isConnected);
        if (!stable) throw new Error(`${action} on ${label} changed before it could be clicked`);
        await element.click({ delay: 50 });
        await element.evaluate(target => target.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
            view: window
        })));
    } finally {
        await handle.dispose();
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function click(page, selector, text) {
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

async function insertComposedText(page, value) {
    await page.evaluate(nextValue => {
        const input = document.querySelector('[aria-label="Agent へのメッセージ"]');
        if (!(input instanceof HTMLTextAreaElement)) throw new Error('Agent composer is missing');
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'あ' }));
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(input, nextValue);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'あ', inputType: 'insertCompositionText', isComposing: true }));
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'あ' }));
    }, value);
}

function readState() {
    const content = document.querySelector('.lens-agent-window__content');
    const activeSessionTab = document.querySelector('.lens-agent-window__tabs button.active')?.textContent?.trim();
    return {
        mode: content?.getAttribute('data-mode'),
        activeSessionTab,
        headerTitle: document.querySelector('.lens-agent-window__context > strong')?.textContent?.trim(),
        sessionTabCount: document.querySelectorAll('.lens-agent-window__tabs button').length,
        sessionRailVisible: Boolean(document.querySelector('.lens-agent-window__rail')),
        agentComposerVisible: Boolean(document.querySelector('[aria-label="Agent の入力欄"]')),
        resultsComposerVisible: Boolean(document.querySelector('[aria-label="Results の入力欄"]')),
        resultsEmptyVisible: Boolean(document.querySelector('.lens-results__empty')),
        codeSidebarVisible: Boolean(document.querySelector('.lens-agent-window__code-sidebar-host')),
        codeEditorVisible: Boolean(document.querySelector('.lens-agent-window__code-editor-host')),
        codeActivityVisible: Boolean(document.querySelector('.lens-agent-window__code-activity')),
        codePanelVisible: Boolean(document.querySelector('.lens-agent-window__code-panel')),
        codeTerminalVisible: Boolean(document.querySelector('.lens-agent-window__code-terminal-host > *')),
        codeStatusVisible: Boolean(document.querySelector('.lens-agent-window__code-status')),
        editorTabs: [...document.querySelectorAll('.lens-agent-window__code-editor-tab-label')]
            .map(button => button.textContent?.trim()),
        codeLuminoPanelCount: document.querySelectorAll('.lens-agent-window__code .lm-Widget.lm-Panel').length,
        codeLuminoTabContainerCount: document.querySelectorAll('.lens-agent-window__code .lm-TabBar-content-container').length,
        applicationShellVisible: Boolean(document.querySelector('.lens-agent-window__code #theia-app-shell')),
        legacyChangesVisible: Boolean(document.querySelector('.lens-changes, #status-bar-lens-changes')),
        deferredContextControlVisible: Boolean(document.querySelector('[aria-label="コンテキストを追加"]')),
        sessionRemoveVisible: Boolean(document.querySelector('.lens-agent-window__session-remove'))
    };
}
