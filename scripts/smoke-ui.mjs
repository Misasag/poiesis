import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
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

const repositoryRoot = process.env.POIESIS_SMOKE_REPOSITORY_ROOT
    ? resolve(process.env.POIESIS_SMOKE_REPOSITORY_ROOT)
    : process.cwd();
const scmFixtureGitPath = 'docs/UX.md';
const scmFixturePath = resolve(repositoryRoot, scmFixtureGitPath);
const scmFixtureOriginal = readFileSync(scmFixturePath, 'utf8');
const scmFixtureMarker = '<!-- Poiesis SCM smoke change -->';
if (scmFixtureOriginal.includes(scmFixtureMarker)) {
    throw new Error('SCM smoke fixture still contains a marker from an interrupted test.');
}
const terminalFixturePath = resolve(process.cwd(), '.poiesis-terminal-smoke.txt');
const existingSkillDirectory = resolve(repositoryRoot, '.poiesis', 'skills', 'poiesis-customize-existing-smoke');
const existingSkillPath = resolve(existingSkillDirectory, 'skill.md');
const createdSkillDirectory = resolve(repositoryRoot, '.poiesis', 'skills', 'poiesis-customize-created-smoke');
const createdSkillPath = resolve(createdSkillDirectory, 'skill.md');
const skillEditMarker = 'Edited and saved by the Poiesis Customize smoke.';
removeTerminalFixture();

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
    if (existsSync(existingSkillDirectory) || existsSync(createdSkillDirectory)) {
        throw new Error('Customize smoke skill fixture already exists.');
    }
    mkdirSync(existingSkillDirectory, { recursive: true });
    writeFileSync(existingSkillPath, `---\nname: Existing smoke skill\ndescription: Workspace scan fixture\nkind: agent\n---\n\n# Existing smoke skill\n`, 'utf8');
    writeFileSync(scmFixturePath, `${scmFixtureOriginal}\n${scmFixtureMarker}\n`, 'utf8');
    const page = await browser.newPage();
    const reactUnmountWarnings = [];
    page.on('console', message => {
        if (message.text().includes('Attempted to synchronously unmount a root')) {
            reactUnmountWarnings.push(message.text());
        }
    });
    page.setDefaultTimeout(uiTimeout);
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout: uiTimeout });
    await page.waitForSelector('#poiesis-window-host .poiesis-agent-window__content', { timeout: uiTimeout });
    await page.waitForSelector('.poiesis-agent-window__agent');
    await page.waitForSelector('.poiesis-agent-window__rail');

    const initial = await page.evaluate(readState);
    assert(initial.mode === 'agent', `Expected Agent mode, got ${initial.mode}`);
    assert(initial.activeSessionTab === 'Agent' || initial.headerTitle === '新しいチャット',
        `Expected Agent or unsent chat state, got ${initial.activeSessionTab ?? initial.headerTitle}`);
    assert(initial.agentComposerVisible, 'Agent Composer is missing');
    assert(initial.sessionRailVisible, 'Session rail is missing');
    assert(!initial.legacyChangesVisible, 'Historical Changes UI is still registered');
    assert(!initial.deferredContextControlVisible, 'Deferred context control is visible');
    assert(!initial.sessionRemoveVisible, 'Deferred Session removal is visible');

    const blankSessionCount = await page.$$eval('.poiesis-agent-window__session-row[data-session-archived="false"]', rows => rows.length);
    await click(page, '.poiesis-agent-window__rail-action', '新しいチャット');
    await page.waitForFunction(expected =>
        document.querySelectorAll('.poiesis-agent-window__session-row[data-session-archived="false"]').length === expected
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
        const storageKey = 'poiesis:global:poiesis.agent-window.sessions.global.v1';
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
        localStorage.setItem('poiesis:global:poiesis.agent-window.sessions.migrated.v1', 'true');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-session-id="smoke-alpha"]');
    await page.waitForSelector('[data-session-id="smoke-beta"]');

    await page.click('[data-session-id="smoke-beta"] .poiesis-agent-window__session-menu-trigger');
    await click(page, '.poiesis-agent-window__session-menu button', 'ピン留め');
    await page.waitForSelector('[data-session-id="smoke-beta"][data-session-pinned="true"]');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__session-section-label')?.textContent === 'ピン留め');

    await page.click('[data-session-id="smoke-beta"] .poiesis-agent-window__session-menu-trigger');
    await click(page, '.poiesis-agent-window__session-menu button', '名前を変更');
    await page.waitForSelector('[data-session-id="smoke-beta"] .poiesis-agent-window__session-rename');
    await page.click('[data-session-id="smoke-beta"] .poiesis-agent-window__session-rename');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.type('[data-session-id="smoke-beta"] .poiesis-agent-window__session-rename', 'Pinned session');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-session-id="smoke-beta"] .poiesis-agent-window__session-title')?.textContent === 'Pinned session');

    const railWidthBefore = await page.$eval('.poiesis-agent-window__rail', element => element.getBoundingClientRect().width);
    await page.focus('.poiesis-agent-window__rail-resize-handle');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(width => document.querySelector('.poiesis-agent-window__rail')?.getBoundingClientRect().width === width + 12, {}, railWidthBefore);

    await page.click('[data-session-id="smoke-alpha"] .poiesis-agent-window__session-menu-trigger');
    await click(page, '.poiesis-agent-window__session-menu button', 'アーカイブ');
    await page.waitForSelector('.poiesis-agent-window__archived-toggle');
    await page.click('.poiesis-agent-window__archived-toggle');
    await page.waitForSelector('[data-session-id="smoke-alpha"][data-session-archived="true"]');
    await page.click('[data-session-id="smoke-alpha"] .poiesis-agent-window__session');
    await page.waitForSelector('[data-session-id="smoke-alpha"][data-session-archived="false"]');

    await page.click('[data-session-id="smoke-alpha"] .poiesis-agent-window__session-menu-trigger');
    await click(page, '.poiesis-agent-window__session-menu button', 'アーカイブ');
    await page.waitForSelector('[data-session-id="smoke-alpha"][data-session-archived="true"]');
    await page.click('[data-session-id="smoke-alpha"] .poiesis-agent-window__session-menu-trigger');
    await click(page, '.poiesis-agent-window__session-menu button', '完全に削除');
    await page.waitForSelector('[data-session-id="smoke-alpha"] [aria-label="完全削除の確認"]');
    await click(page, '[data-session-id="smoke-alpha"] [aria-label="完全削除の確認"] button', '削除');
    await page.waitForFunction(() => !document.querySelector('[data-session-id="smoke-alpha"]'));

    const activeCountBeforeNewChat = await page.$$eval('.poiesis-agent-window__session-row[data-session-archived="false"]', rows => rows.length);
    await click(page, '.poiesis-agent-window__rail-action', '新しいチャット');
    await page.waitForFunction(expected =>
        document.querySelectorAll('.poiesis-agent-window__session-row[data-session-archived="false"]').length === expected,
    {}, activeCountBeforeNewChat);
    await page.waitForSelector('.poiesis-agent-window__new-agent-empty');
    await page.waitForSelector('.poiesis-agent-window__new-agent-context');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__context > strong')?.textContent === '新しいチャット');
    const newAgentContext = await page.evaluate(() => ({
        repository: document.querySelector('.poiesis-agent-window__context-pill.primary span:not(.codicon)')?.textContent,
        branch: document.querySelectorAll('.poiesis-agent-window__context-pill')[1]?.textContent?.trim(),
        staticRunTargetVisible: Boolean(document.querySelector('.poiesis-agent-window__context-pill.static[title*="実行先"]')),
        resultsTabVisible: [...document.querySelectorAll('.poiesis-agent-window__tabs button')]
            .some(button => button.textContent?.trim() === 'Results')
    }));
    assert(newAgentContext.repository && newAgentContext.repository !== 'Repositoryを選択', 'Unsent Agent must inherit an explicit repository');
    assert(newAgentContext.branch, 'Unsent Agent branch picker is missing');
    assert(!newAgentContext.staticRunTargetVisible, 'Unsent Agent must not expose a static run target');
    assert(!newAgentContext.resultsTabVisible, 'Unsent Agent must not expose Results before the first run');

    await page.click('.poiesis-agent-window__context-pill.primary');
    await page.waitForSelector('[aria-label="Repositoryを選択"]');
    await page.waitForFunction(() => {
        const labels = [...document.querySelectorAll('.poiesis-agent-window__repository-group-label')]
            .map(label => label.textContent?.trim());
        return labels.includes('最近') && labels.includes('この PC');
    });
    await page.type('[aria-label="Repositoryを検索"]', '__no_matching_repository__');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__repository-empty')?.textContent?.includes('一致するRepository'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Repositoryを選択"]'));
    await page.click('.poiesis-agent-window__context-pill.primary');
    await page.waitForSelector('[aria-label="Repositoryを選択"]');
    await click(page, '.poiesis-agent-window__repository-footer button', '新しいフォルダー');
    await page.waitForSelector('[aria-label="フォルダーを選択"]');
    await page.waitForSelector('[aria-label="フォルダーパス"]');
    await page.waitForFunction(() => document.querySelector('[aria-label="フォルダーパス"]')?.value?.length > 0);
    await page.click('[aria-label="フォルダー選択を閉じる"]');
    await page.waitForFunction(() => !document.querySelector('[aria-label="フォルダーを選択"]'));

    const resizedRailWidth = await page.$eval('.poiesis-agent-window__rail', element => element.getBoundingClientRect().width);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-session-id="smoke-beta"][data-session-pinned="true"]');
    await page.waitForFunction(expectedWidth =>
        document.querySelector('.poiesis-agent-window__rail')?.getBoundingClientRect().width === expectedWidth
        && !document.querySelector('[data-session-id="smoke-alpha"]'), {}, resizedRailWidth);
    const sidebar = await page.evaluate(() => ({
        activeSessionCount: document.querySelectorAll('.poiesis-agent-window__session-row[data-session-archived="false"]').length,
        pinnedTitle: document.querySelector('[data-session-pinned="true"] .poiesis-agent-window__session-title')?.textContent,
        railWidth: document.querySelector('.poiesis-agent-window__rail')?.getBoundingClientRect().width,
        archivedCount: document.querySelectorAll('.poiesis-agent-window__session-row[data-session-archived="true"]').length
    }));

    await page.click('.poiesis-agent-window__repository-open');
    await page.waitForSelector('[aria-label="ワークスペースを開く"]');
    await page.waitForSelector('[aria-label="ワークスペースを検索"]');
    await page.type('[aria-label="ワークスペースを検索"]', '__no_matching_workspace__');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__workspace-picker-empty')?.textContent?.includes('一致するワークスペース'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[aria-label="ワークスペースを開く"]'));

    await click(page, '.poiesis-agent-window__rail-action', '検索');
    await page.waitForSelector('[aria-label="会話を検索"]');
    await page.type('[aria-label="会話を検索"]', '__no_matching_session__');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__session-empty')?.textContent?.includes('一致する会話'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[aria-label="会話を検索"]'));
    await page.click('[data-session-id="smoke-beta"] .poiesis-agent-window__session');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__context > strong')?.textContent === 'Pinned session');

    await click(page, '.poiesis-agent-window__tabs button', 'Results');
    await page.waitForSelector('.poiesis-results');
    const results = await page.evaluate(readState);
    assert(results.mode === 'results', `Expected Results mode, got ${results.mode}`);
    assert(results.activeSessionTab === 'Results', `Expected Results tab, got ${results.activeSessionTab}`);
    assert(results.resultsComposerVisible, 'Results Composer is missing');
    assert(results.resultsEmptyVisible, 'Results empty state is missing');

    await click(page, '.poiesis-agent-window__code-control', 'Code');
    await page.waitForSelector('.poiesis-agent-window__code');
    await page.waitForFunction(() => Boolean(document.querySelector('.poiesis-agent-window__code-terminal-host > *')));
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
    await page.waitForSelector('.poiesis-agent-window__code-terminal-host .xterm-helper-textarea');
    const firstTerminalId = await page.$eval('.poiesis-agent-window__code-terminal-host > *', element => element.id);
    const terminalCommand = process.platform === 'win32'
        ? `echo poiesis-terminal-smoke>"${terminalFixturePath}"`
        : `printf poiesis-terminal-smoke > '${terminalFixturePath.replaceAll("'", "'\\''")}'`;
    await page.focus('.poiesis-agent-window__code-terminal-host .xterm-helper-textarea');
    await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
    await page.keyboard.type(terminalCommand);
    await page.keyboard.press('Enter');
    for (let attempt = 0; attempt < 100 && !existsSync(terminalFixturePath); attempt++) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    }
    assert(existsSync(terminalFixturePath) && readFileSync(terminalFixturePath, 'utf8').trim() === 'poiesis-terminal-smoke',
        'Terminal command did not write its output fixture');
    removeTerminalFixture();
    const terminalPanelHeight = await page.$eval('.poiesis-agent-window__code-panel', element => Math.round(element.getBoundingClientRect().height));
    await page.focus('.poiesis-agent-window__code-panel-resize');
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(height => Math.round(document.querySelector('.poiesis-agent-window__code-panel')?.getBoundingClientRect().height ?? 0) === height + 12,
        {}, terminalPanelHeight);
    await page.click('.poiesis-agent-window__code-panel-tabs button[aria-label="新しい Terminal"]');
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id !== id
        && document.querySelector('.poiesis-agent-window__code-terminal-select')?.dataset.optionCount === '2', {}, firstTerminalId);
    const secondTerminalId = await page.$eval('.poiesis-agent-window__code-terminal-host > *', element => element.id);
    await choosePoiesisSelect(page, '.poiesis-agent-window__code-terminal-select .poiesis-select__trigger', firstTerminalId);
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);
    await page.click('.poiesis-agent-window__code-panel-tabs button[aria-label="パネルを閉じる"]');
    await page.waitForSelector('.poiesis-agent-window__code-status button[aria-label="パネルを切り替える"][aria-expanded="false"]');
    assert(!await page.$('.poiesis-agent-window__code-panel'), 'Close Panel must hide the Terminal panel');
    await page.click('.poiesis-agent-window__code-status button[aria-label="パネルを切り替える"]');
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);
    await page.keyboard.down('Control');
    await page.keyboard.press('Backquote');
    await page.keyboard.up('Control');
    await page.waitForSelector('.poiesis-agent-window__code-status button[aria-label="パネルを切り替える"][aria-expanded="false"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('Backquote');
    await page.keyboard.up('Control');
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);
    await choosePoiesisSelect(page, '.poiesis-agent-window__code-terminal-select .poiesis-select__trigger', secondTerminalId);
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, secondTerminalId);
    await page.click('.poiesis-agent-window__code-panel-tabs button[aria-label="Terminal を終了"]');
    await page.waitForFunction(id => document.querySelector('.poiesis-agent-window__code-terminal-select')?.dataset.optionCount === '1'
        && document.querySelector('.poiesis-agent-window__code-terminal-host > *')?.id === id, {}, firstTerminalId);
    while (await page.$('.poiesis-agent-window__code-editor-tab-close')) {
        const tabCount = await page.$$eval('.poiesis-agent-window__code-editor-tab', tabs => tabs.length);
        await page.click('.poiesis-agent-window__code-editor-tab-close');
        await page.waitForFunction(count => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length < count, {}, tabCount);
    }
    for (const label of ['新しいファイル', '新しいフォルダー', 'Explorer を更新', 'フォルダーを折りたたむ']) {
        assert(await page.$(`.poiesis-agent-window__code-sidebar-actions button[aria-label="${label}"]`), `Explorer action is missing: ${label}`);
    }
    const explorerWidth = await page.$eval('.poiesis-agent-window__code-sidebar', element => element.getBoundingClientRect().width);
    await page.focus('.poiesis-agent-window__code-sidebar-resize');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(width => document.querySelector('.poiesis-agent-window__code-sidebar')?.getBoundingClientRect().width === width + 12, {}, explorerWidth);
    await page.click('.poiesis-agent-window__code-sidebar-resize', { count: 2, delay: 80 });
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-sidebar')?.getBoundingClientRect().width === 260);
    await page.click('.poiesis-agent-window__code-sidebar-actions button[aria-label="Explorer を更新"]');
    await page.waitForSelector('#files .theia-FileStatNode');
    assert(await page.$('#files .theia-FileStatNode[title$=".gitignore"] .git-icon.file-icon'), 'Explorer must show a Git icon for .gitignore');
    const revealExplorerNode = async (label, align = 'end') => {
        const deadline = Date.now() + uiTimeout;
        while (Date.now() < deadline) {
            if (await page.evaluate(nodeLabel => [...document.querySelectorAll('#files .theia-FileStatNode')]
                .some(element => element.getAttribute('title')?.endsWith(nodeLabel)), label)) return;
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
        const rows = await page.$$eval('#files .theia-FileStatNode', elements => elements.map(element => element.getAttribute('title')));
        throw new Error(`${label} was not revealed in Explorer; visible rows=${JSON.stringify(rows)}`);
    };
    for (const [folder, child] of [['spikes', 'theia'], ['theia', 'scripts'], ['scripts', 'smoke-ui.mjs']]) {
        await revealExplorerNode(folder);
        await page.evaluate(label => {
            const node = [...document.querySelectorAll('#files .theia-FileStatNode')]
                .find(element => element.getAttribute('title')?.endsWith(label));
            node?.querySelector('.theia-ExpansionToggle.theia-mod-collapsed')
                ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        }, folder);
        await revealExplorerNode(child);
    }
    assert(await page.$('#files .theia-FileStatNode[title$="smoke-ui.mjs"] .js-icon.file-icon'), 'Explorer must show a JavaScript icon for .js/.mjs files');
    await page.click('.poiesis-agent-window__code-sidebar-actions button[aria-label="フォルダーを折りたたむ"]');
    await page.waitForFunction(() => ![...document.querySelectorAll('#files .theia-FileStatNode')]
        .some(element => element.getAttribute('title')?.endsWith('smoke-ui.mjs')));
    await page.click('.poiesis-agent-window__code-explorer-more button[aria-label="その他の操作"]');
    await page.waitForSelector('.poiesis-agent-window__code-explorer-menu[role="menu"]');
    const explorerMenuItems = await page.$$eval('.poiesis-agent-window__code-explorer-menu [role="menuitem"]', items => items.map(item => item.textContent?.trim()));
    for (const label of ['隠しファイルを切り替える', '自動表示', 'Explorer を更新', 'フォルダーを折りたたむ']) {
        assert(explorerMenuItems.includes(label), `Explorer More Actions is missing: ${label}`);
    }
    await click(page, '.poiesis-agent-window__code-explorer-menu [role="menuitem"]', '自動表示');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__code-explorer-menu'));

    await page.click('.poiesis-agent-window__code-activity button[aria-label="Search"]');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Search');
    await page.waitForSelector('#search-input-field');
    await page.waitForFunction(() => document.activeElement?.id === 'search-input-field');
    for (const label of ['検索結果を更新', '検索結果をクリア', '検索結果をすべて折りたたむ']) {
        assert(await page.$(`.poiesis-agent-window__code-sidebar-actions button[aria-label="${label}"]`), `Search action is missing: ${label}`);
    }
    await page.click('.poiesis-agent-window__code-sidebar-actions button[aria-label="検索結果をクリア"]');
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
    await page.click('.poiesis-agent-window__code-sidebar-actions button[aria-label="検索結果を更新"]');
    await page.waitForFunction(() => document.querySelectorAll('#search-in-workspace .theia-TreeNode:not(.theia-CompositeTreeNode)').length === 2);
    await page.evaluate(() => {
        const result = [...document.querySelectorAll('#search-in-workspace .theia-TreeNode:not(.theia-CompositeTreeNode)')]
            .find(node => node.textContent?.includes("console.log('Source contract " + "validation passed.');"));
        if (!(result instanceof HTMLElement)) throw new Error('Search result row is missing');
        result.click();
    });
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'validate-source.mjs');
    await page.click('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-close');
    await page.waitForFunction(() => ![...document.querySelectorAll('.poiesis-agent-window__code-editor-tab-name')]
        .some(element => element.textContent?.trim() === 'validate-source.mjs'));
    await page.click('.poiesis-agent-window__code-sidebar-actions button[aria-label="検索結果をすべて折りたたむ"]');
    await page.waitForFunction(() => document.querySelectorAll('#search-in-workspace .theia-TreeNode:not(.theia-CompositeTreeNode)').length === 0);
    await page.click('.poiesis-agent-window__code-sidebar-actions button[aria-label="検索結果をクリア"]');
    await page.waitForFunction(() => document.querySelector('#search-input-field')?.value === ''
        && document.querySelectorAll('#search-in-workspace .theia-TreeNode').length === 0);
    await page.click('.poiesis-agent-window__code-activity button[aria-label="Source Control"]');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Source Control');
    await page.waitForSelector('.poiesis-agent-window__code-sidebar-actions button[aria-label="Source Control を更新"]');
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
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-title[aria-expanded="true"]');
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-host #scm-history-graph-widget');
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-host .scm-history-graph-row svg');
    assert(!await page.$('.poiesis-agent-window__code .lm-Widget.lm-Panel'), 'Source Control Graph must not restore a Lumino panel');
    await page.click('.poiesis-agent-window__code-git-graph-title');
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-title[aria-expanded="false"]');
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-host[hidden]');
    await page.click('.poiesis-agent-window__code-git-graph-title');
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-host:not([hidden])');
    await page.waitForSelector('.poiesis-agent-window__code-git-graph-host .scm-history-graph-row');
    await page.click('.poiesis-agent-window__code-sidebar-actions button[aria-label="Source Control を更新"]');
    await waitForScmAction(page, 'UX.md', 'Stage Changes');
    await hoverScmResource(page, 'UX.md');
    for (const action of ['Open File', 'Discard Changes', 'Stage Changes']) {
        assert(await scmActionExists(page, 'UX.md', action), `Source Control action is missing: ${action}`);
    }
    await executeScmAction(page, 'UX.md', 'Stage Changes', 'staged');
    await page.click('.poiesis-agent-window__code-sidebar-actions button[aria-label="Source Control を更新"]');
    await waitForScmAction(page, 'UX.md', 'Unstage Changes');
    await executeScmAction(page, 'UX.md', 'Unstage Changes', 'unstaged');
    await page.click('.poiesis-agent-window__code-sidebar-actions button[aria-label="Source Control を更新"]');
    await waitForScmAction(page, 'UX.md', 'Stage Changes');
    await openScmResourceDiff(page, 'UX.md');
    await page.click('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-close');
    await page.waitForFunction(() => ![...document.querySelectorAll('.poiesis-agent-window__code-editor-tab-name')]
        .some(element => element.textContent?.trim().startsWith('UX.md')));
    restoreScmFixture();
    await page.click('.poiesis-agent-window__code-activity button[aria-label="Extensions"]');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Extensions');
    await page.waitForSelector('.poiesis-agent-window__code-sidebar-host > *');
    await page.waitForFunction(() => document.querySelector('#vsx-extensions-search-bar input')?.value === '@builtin');
    await page.waitForFunction(() => (document.getElementById('vsx-extensions:builtin')?.querySelectorAll('.theia-TreeNode').length ?? 0) > 0);
    assert(!await page.$('.poiesis-agent-window__customize-page'), 'Code Extensions must stay in Code mode');
    assert(reactUnmountWarnings.length === 0,
        `Code widget transitions synchronously unmounted a React root: ${reactUnmountWarnings.join('\n')}`);
    await page.click('.poiesis-agent-window__code-activity-footer button[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal:not(.poiesis-customize-modal)');
    await click(page, '.poiesis-settings-modal__footer button', 'エディタとTerminalの設定は Theia Settings で');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'Settings');
    await page.waitForSelector('.poiesis-agent-window__code-editor-host #settings_widget');
    assert(await page.$('.poiesis-agent-window__code'), 'Code Settings must stay in Code mode');
    await page.click('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-close');
    await page.waitForFunction(() => ![...document.querySelectorAll('.poiesis-agent-window__code-editor-tab-name')]
        .some(element => element.textContent?.trim() === 'Settings'));
    await page.click('.poiesis-agent-window__code-activity button[aria-label="Explorer"]');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-sidebar-title > span')?.textContent?.trim() === 'Explorer');
    await page.waitForFunction(() => [...document.querySelectorAll('#files .theia-FileStatNode')]
        .some(element => element.getAttribute('title')?.endsWith('.gitignore')));
    const clickExplorerFile = async label => {
        const point = await page.evaluate(fileLabel => {
            const file = [...document.querySelectorAll('#files .theia-FileStatNode')]
                .find(element => element.getAttribute('title')?.endsWith(fileLabel));
            if (!(file instanceof HTMLElement)) throw new Error(`${fileLabel} was not found in Explorer`);
            file.scrollIntoView({ block: 'center' });
            const bounds = file.getBoundingClientRect();
            return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
        }, label);
        await page.mouse.click(point.x, point.y);
        assert(await page.evaluate(fileLabel => {
            const file = [...document.querySelectorAll('#files .theia-FileStatNode')]
                .find(element => element.getAttribute('title')?.endsWith(fileLabel));
            return file instanceof HTMLElement
                && file.draggable
                && !document.body.classList.contains('poiesis-code-file-pointer-drag');
        }, label), `${label} click left stale drag state behind`);
    };
    const expandExplorerDirectory = async label => {
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
    };
    const dragExplorerFileToTabs = async label => {
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
            `${label} drag did not enter an accepted tab-bar drop target`);
        assert(await page.evaluate(({ x, y }) => {
            const target = document.elementFromPoint(x, y);
            return document.body.classList.contains('poiesis-code-file-pointer-drag')
                && !!target
                && getComputedStyle(target).cursor === 'copy';
        }, points.target), `${label} drag did not switch from the browser no-drop cursor to copy`);
        await page.mouse.up();
        assert(await page.evaluate(fileLabel => {
            const file = [...document.querySelectorAll('#files .theia-FileStatNode')]
                .find(element => element.getAttribute('title')?.endsWith(fileLabel));
            return file instanceof HTMLElement
                && file.draggable
                && !document.body.classList.contains('poiesis-code-file-pointer-drag');
        }, label), `${label} drop left stale drag state behind`);
    };
    await clickExplorerFile('.gitignore');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length === 1
        && document.querySelector('.poiesis-agent-window__code-editor-tab.active.preview .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === '.gitignore');
    await expandExplorerDirectory('docs');
    await revealExplorerNode('UX.md', 'end');
    await clickExplorerFile('UX.md');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length === 1
        && document.querySelector('.poiesis-agent-window__code-editor-tab.active.preview .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'UX.md');
    assert(!await page.evaluate(() => [...document.querySelectorAll('.poiesis-agent-window__code-editor-tab-name')]
        .some(tab => tab.textContent?.trim() === '.gitignore')), 'A new Explorer click must replace the previous preview tab');

    await dragExplorerFileToTabs('.gitignore');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length === 2
        && [...document.querySelectorAll('.poiesis-agent-window__code-editor-tab')].some(tab =>
            tab.dataset.preview === 'false' && tab.querySelector('.poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === '.gitignore'));

    await expandExplorerDirectory('docs');
    await revealExplorerNode('PRODUCT.md', 'start');
    await clickExplorerFile('PRODUCT.md');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length === 2
        && document.querySelector('.poiesis-agent-window__code-editor-tab.active.preview .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'PRODUCT.md'
        && ![...document.querySelectorAll('.poiesis-agent-window__code-editor-tab-name')].some(tab => tab.textContent?.trim() === 'UX.md'));

    await expandExplorerDirectory('docs');
    await revealExplorerNode('UX.md', 'end');
    await dragExplorerFileToTabs('UX.md');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length === 3
        && document.querySelector('.poiesis-agent-window__code-editor-tab.active:not(.preview) .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'UX.md');
    await page.waitForSelector('.poiesis-agent-window__code-editor-host .monaco-editor');
    assert(await page.$('#files .theia-FileStatNode.theia-mod-selected'), 'Opened file must remain selected in Explorer');
    const openedCode = await page.evaluate(readState);
    assert(openedCode.editorTabs.includes('.gitignore'), 'Dragging a file must create a pinned Poiesis editor tab');
    assert(openedCode.editorTabs.includes('UX.md') && openedCode.editorTabs.includes('PRODUCT.md'), 'Pinned tabs and the current preview must coexist');
    assert(openedCode.editorTabs.filter(label => label === '.gitignore').length === 1, 'Explorer must open one editor tab per file');
    assert(openedCode.codeLuminoPanelCount === 0, 'Opening an editor must not reintroduce Lumino panel wrappers');
    assert(openedCode.codeLuminoTabContainerCount === 0, 'Opening an editor must not reintroduce Lumino tab wrappers');
    const editorTabState = await page.$$eval('.poiesis-agent-window__code-editor-tab', tabs => tabs.map(tab => ({
        name: tab.querySelector('.poiesis-agent-window__code-editor-tab-name')?.textContent?.trim(),
        active: tab.classList.contains('active'),
        preview: tab.dataset.preview === 'true',
        role: tab.querySelector('.poiesis-agent-window__code-editor-tab-label')?.getAttribute('role'),
        selected: tab.querySelector('.poiesis-agent-window__code-editor-tab-label')?.getAttribute('aria-selected'),
        width: Math.round(tab.getBoundingClientRect().width),
        fontStyle: getComputedStyle(tab.querySelector('.poiesis-agent-window__code-editor-tab-name')).fontStyle,
        fontWeight: Number(getComputedStyle(tab.querySelector('.poiesis-agent-window__code-editor-tab-name')).fontWeight)
    })));
    assert(editorTabState.every(tab => tab.role === 'tab' && tab.width >= 80 && tab.width <= 220), 'Editor tabs must stay within the content-fit width bounds and preserve tab semantics');
    assert(new Set(editorTabState.map(tab => tab.width)).size > 1, 'Editor tab widths must vary with file name length');
    assert(editorTabState.filter(tab => tab.active && tab.selected === 'true').length === 1, 'Exactly one editor tab must be active and selected');
    assert(editorTabState.every(tab => tab.fontWeight >= 600), 'Editor tab names must use a bold weight');
    assert(editorTabState.filter(tab => !tab.active).every(tab => tab.fontStyle === 'italic'), 'Inactive editor tab names must be italic');
    assert(editorTabState.find(tab => tab.name === 'PRODUCT.md')?.preview, 'The last Explorer click must remain the single preview tab');
    assert(await page.$('.poiesis-agent-window__code-editor-tab .git-icon.file-icon'), 'The Git editor tab icon is missing');
    assert(await page.$('.poiesis-agent-window__code-editor-tab .markdown-icon.file-icon'), 'The Markdown editor tab icon is missing');

    await click(page, '.poiesis-agent-window__code-editor-tab-label', 'UX.md');
    const codeSaveFixtureBefore = readFileSync(scmFixturePath, 'utf8');
    await clickStable(page, '.poiesis-agent-window__code-editor-host .monaco-editor .view-lines');
    await page.keyboard.type('x');
    await page.waitForSelector('.poiesis-agent-window__code-editor-tab.active.dirty .poiesis-agent-window__code-editor-tab-dirty');
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__code-editor-tab.active.dirty'));
    assert(readFileSync(scmFixturePath, 'utf8') !== codeSaveFixtureBefore, 'Ctrl+S cleared dirty state without writing the editor content');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyZ');
    await page.keyboard.up('Control');
    await page.waitForSelector('.poiesis-agent-window__code-editor-tab.active.dirty .poiesis-agent-window__code-editor-tab-dirty');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyS');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__code-editor-tab.active.dirty'));
    assert(readFileSync(scmFixturePath, 'utf8') === codeSaveFixtureBefore, 'Ctrl+S did not persist the restored editor content');

    await click(page, '.poiesis-agent-window__code-editor-tab-label', 'PRODUCT.md');
    await page.click('.poiesis-agent-window__code-editor-host .monaco-editor .view-lines');
    await page.keyboard.type('x');
    await page.waitForSelector('.poiesis-agent-window__code-editor-tab.active.dirty .poiesis-agent-window__code-editor-tab-dirty');
    assert(!await page.$('.poiesis-agent-window__code-editor-tab.active.preview'), 'Editing a preview tab must pin it before another preview can replace it');
    await page.click('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-close');
    await page.waitForSelector('.poiesis-agent-window__code-close-dialog[role="dialog"]');
    await page.waitForFunction(() => document.body.textContent?.includes('PRODUCT.md の変更を保存しますか？'));
    assert(!await page.$('.dialogBlock'), 'Unsaved close must not use the Theia/VS Code dialogBlock');
    assert(await page.$('.poiesis-agent-window__code-editor-tab.active.dirty'), 'Unsaved close confirmation must appear before the tab is removed');
    await click(page, '.poiesis-agent-window__code-close-dialog footer button', 'キャンセル');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__code-close-dialog'));
    assert(await page.$('.poiesis-agent-window__code-editor-tab.active.dirty'), 'Cancel must preserve the dirty editor tab');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyZ');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => !document.querySelector('.poiesis-agent-window__code-editor-tab.active.dirty'));

    await page.focus('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-label');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'UX.md');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'PRODUCT.md');
    await page.click('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-close');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length === 2
        && document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'UX.md');

    await page.focus('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-label');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === '.gitignore');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === 'UX.md');
    await page.click('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-label', { button: 'middle' });
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length === 1
        && document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')?.textContent?.trim() === '.gitignore');
    await page.click('.poiesis-agent-window__code-editor-tab-close');
    await page.waitForFunction(() => document.querySelectorAll('.poiesis-agent-window__code-editor-tab').length === 0
        && Boolean(document.querySelector('.poiesis-agent-window__code-empty')));

    await click(page, '.poiesis-agent-window__code-control', 'Code');
    await page.waitForSelector('.poiesis-results');
    const returned = await page.evaluate(readState);
    assert(returned.mode === 'results', `Code must return to Results, got ${returned.mode}`);
    assert(returned.activeSessionTab === 'Results', 'Results selection was not preserved');

    const settingsButtonHitTarget = await page.$eval('.poiesis-agent-window__rail-footer button[aria-label="設定"]', element => {
        const bounds = element.getBoundingClientRect();
        const center = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        return center?.closest('button') === element;
    });
    assert(settingsButtonHitTarget, 'An overlay is intercepting the Settings control');
    await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal:not(.poiesis-customize-modal)');
    const settings = await page.evaluate(() => ({
        modal: Boolean(document.querySelector('.poiesis-settings-modal:not(.poiesis-customize-modal)')),
        text: document.querySelector('.poiesis-settings-modal:not(.poiesis-customize-modal)')?.textContent ?? '',
        codeSidebarVisible: Boolean(document.querySelector('.poiesis-agent-window__code-sidebar'))
    }));
    assert(settings.modal, 'Settings must open the Poiesis-owned settings modal');
    assert(!settings.text.includes('Skills') && !settings.text.includes('Plugins'), 'Settings modal still contains Customize sections');
    assert(!settings.codeSidebarVisible, 'Settings must not open the Code sidebar');
    await page.waitForFunction(() => document.querySelectorAll('input[name="poiesis-agent-cli"]').length === 4
        && document.querySelectorAll('input[name="poiesis-results-cli"]').length === 4);
    await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal__section-heading .poiesis-settings-modal__text-button')?.disabled);
    const cliRegistry = await page.evaluate(() => {
        const role = name => {
            const heading = [...document.querySelectorAll('.poiesis-settings-modal__cli-role h3')]
                .find(element => element.textContent?.trim() === name);
            const container = heading?.closest('.poiesis-settings-modal__cli-role');
            return [...(container?.querySelectorAll('.poiesis-settings-modal__cli-row') ?? [])].map(row => ({
                name: row.querySelector('strong')?.textContent?.trim(),
                status: row.querySelector('.poiesis-settings-modal__cli-status')?.textContent?.trim(),
                disabled: row.querySelector('input')?.disabled
            }));
        };
        return { agent: role('Agent の AI'), results: role('Results の AI') };
    });
    for (const role of [cliRegistry.agent, cliRegistry.results]) {
        assert(role.some(entry => entry.name === 'Grok' && entry.status === '検出済み（実行可）' && !entry.disabled),
            `Grok registry status is dishonest: ${JSON.stringify(role)}`);
        assert(role.some(entry => entry.name === 'Gemini' && entry.status === '未検出' && entry.disabled),
            `Gemini registry status is dishonest: ${JSON.stringify(role)}`);
    }
    await page.click('input[name="poiesis-agent-cli"][value="claude"]');
    await page.waitForFunction(() => document.querySelector('[aria-label="Agent の AI モデル"]')?.dataset.value === 'fable');
    await choosePoiesisSelect(page, '[aria-label="Agent の AI モデル"]', 'haiku');
    await choosePoiesisSelect(page, '[aria-label="Results の AI モデル"]', '__custom__');
    await page.waitForSelector('[aria-label="Results の AI カスタムモデルID"]');
    await page.type('[aria-label="Results の AI カスタムモデルID"]', 'custom-model-smoke');
    await choosePoiesisSelect(page, '[aria-label="Results の AI モデル"]', 'gpt-5.4');
    await page.waitForFunction(() => [...Object.values(localStorage)].some(value =>
        typeof value === 'string' && value.includes('"agentModel":"haiku"') && value.includes('"resultsModel":"gpt-5.4"')));
    await page.setViewport({ width: 1024, height: 600, deviceScaleFactor: 1 });
    const settingsResize = await page.$eval('.poiesis-settings-modal:not(.poiesis-customize-modal)', element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
    });
    assert(settingsResize.left >= 0 && settingsResize.top >= 0
        && settingsResize.right <= 1024 && settingsResize.bottom <= 600,
    `Settings modal overflowed after resize: ${JSON.stringify(settingsResize)}`);
    await page.click('[aria-label="Results の AI モデル"]');
    await page.waitForSelector('.poiesis-select__listbox');
    const settingsDropdownBounds = await page.$eval('.poiesis-select__listbox', element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
    });
    assert(settingsDropdownBounds.left >= 0 && settingsDropdownBounds.top >= 0
        && settingsDropdownBounds.right <= 1024 && settingsDropdownBounds.bottom <= 600,
    `Settings dropdown clipped at 1024x600: ${JSON.stringify(settingsDropdownBounds)}`);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[aria-label="Results の AI モデル"]')?.dataset.value !== 'gpt-5.4');
    await page.waitForFunction(() => document.querySelector('[aria-label="Results の AI モデル"]') === document.activeElement);
    await choosePoiesisSelect(page, '[aria-label="Results の AI モデル"]', 'gpt-5.4');
    const modelSelections = { agent: 'claude/haiku', results: 'codex/gpt-5.4', customField: true };
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.poiesis-settings-modal'));
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

    await click(page, '.poiesis-agent-window__rail-action', 'カスタマイズ');
    await page.waitForSelector('.poiesis-customize-view');
    await page.waitForFunction(() => [...document.querySelectorAll('.poiesis-customize-view__skill-card')]
        .some(card => card.textContent?.includes('Existing smoke skill')));
    const expandedCustomize = await page.evaluate(() => ({
        mode: document.querySelector('.poiesis-agent-window__content')?.dataset.mode,
        railVisible: Boolean(document.querySelector('.poiesis-agent-window__rail')),
        modalBackdrop: Boolean(document.querySelector('.poiesis-customize-modal__backdrop')),
        builtIns: [...document.querySelectorAll('.poiesis-customize-view .poiesis-agent-window__status-badge.active')]
            .filter(badge => badge.textContent?.trim() === '組み込み').length,
        existingSkill: [...document.querySelectorAll('.poiesis-customize-view__skill-card')]
            .some(card => card.textContent?.includes('Existing smoke skill')),
        plugins: document.querySelector('.poiesis-customize-view')?.textContent?.includes('Poiesis plugin bundles'),
        hooks: document.querySelector('.poiesis-customize-view')?.textContent?.includes('Hooks')
    }));
    assert(expandedCustomize.mode === 'customize' && expandedCustomize.railVisible && !expandedCustomize.modalBackdrop,
        `Customize must be an inline central view: ${JSON.stringify(expandedCustomize)}`);
    assert(expandedCustomize.builtIns === 2, `Expected two built-in Skills, got ${expandedCustomize.builtIns}`);
    assert(expandedCustomize.existingSkill, 'Workspace user skill was not scanned');
    assert(expandedCustomize.plugins, 'Plugins section did not move to Customize');
    assert(!expandedCustomize.hooks, 'Unsupported Hooks section is visible');
    assert(!await page.$('.poiesis-agent-window__plugins-host'), 'Poiesis Customize must not host the Code extensions manager');
    assert(!(await page.$eval('.poiesis-customize-view', element => element.textContent ?? '')).includes('VS Code built-in extensions'), 'Poiesis Customize still describes Code extensions');
    await page.evaluate(() => {
        const skill = [...document.querySelectorAll('.poiesis-customize-view__skill-card')]
            .find(card => card.textContent?.includes('Bundled Results'));
        if (!(skill instanceof HTMLElement)) throw new Error('Bundled Results was not clickable');
        skill.click();
    });
    await page.waitForSelector('.poiesis-customize-view__builtin-preview');
    assert((await page.$eval('.poiesis-customize-view__builtin-preview', element => element.textContent ?? '')).includes('読み取り専用'),
        'Built-in skill preview is not read-only');
    await page.evaluate(() => {
        const skill = [...document.querySelectorAll('.poiesis-customize-view__skill-card')]
            .find(card => card.textContent?.includes('Existing smoke skill'));
        if (!(skill instanceof HTMLElement)) throw new Error('Existing user skill was not clickable');
        skill.click();
    });
    await page.waitForSelector('.poiesis-customize-view__editor-input');
    assert((await page.$eval('.poiesis-customize-view__editor-input', element => element.value)).includes('# Existing smoke skill'),
        'User skill did not open in the inline editor');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.poiesis-customize-view__editor'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.poiesis-customize-view'));

    await page.click('.poiesis-agent-window__rail-toggle');
    await page.waitForSelector('.poiesis-agent-window__rail[data-collapsed="true"]');
    await page.click('.poiesis-agent-window__rail-action[title="カスタマイズ"]');
    await page.waitForSelector('.poiesis-customize-view');
    await page.setViewport({ width: 1024, height: 600, deviceScaleFactor: 1 });
    await page.waitForFunction(() => {
        const view = document.querySelector('.poiesis-customize-view')?.getBoundingClientRect();
        const rail = document.querySelector('.poiesis-agent-window__rail')?.getBoundingClientRect();
        return Boolean(view && rail && rail.width > 0 && view.left >= rail.right && view.top >= 0
            && view.right <= innerWidth && view.bottom <= innerHeight);
    });
    await click(page, '.poiesis-customize-view__text-button', '新しいSkill');
    await page.waitForSelector('[aria-label="新しいSkill ID"]');
    await page.type('[aria-label="新しいSkill ID"]', 'poiesis-customize-created-smoke');
    await page.click('[aria-label="新しいSkillの種類"]');
    await page.waitForSelector('.poiesis-select__listbox');
    const customizeDropdownBounds = await page.$eval('.poiesis-select__listbox', element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
    });
    assert(customizeDropdownBounds.left >= 0 && customizeDropdownBounds.top >= 0
        && customizeDropdownBounds.right <= 1024 && customizeDropdownBounds.bottom <= 600,
    `Customize dropdown clipped at 1024x600: ${JSON.stringify(customizeDropdownBounds)}`);
    await page.evaluate(() => document.querySelector('.poiesis-select__option[data-value="results"]')?.click());
    await click(page, '.poiesis-customize-view__new-skill button', '作成して開く');
    await page.waitForSelector('.poiesis-customize-view__editor-input');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view__editor header small')
        ?.textContent?.includes('poiesis-customize-created-smoke'));
    assert(existsSync(createdSkillPath), '新しいSkill did not scaffold skill.md');
    const scaffoldedSkill = readFileSync(createdSkillPath, 'utf8');
    assert(scaffoldedSkill.includes('kind: results'), 'Scaffolded skill.md did not preserve the selected kind');
    await page.focus('.poiesis-customize-view__editor-input');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');
    await page.keyboard.type(`\n${skillEditMarker}\n`);
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view__dirty.active')?.textContent?.includes('未保存'));
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelector('.poiesis-customize-view__dirty:not(.active)')?.textContent?.includes('保存済み'));
    assert(readFileSync(createdSkillPath, 'utf8').includes(skillEditMarker), 'Edited skill.md was not saved');
    await page.focus('.poiesis-customize-view__editor-input');
    await page.keyboard.type('\ndiscard-this-smoke-change');
    await click(page, '.poiesis-customize-view__editor footer button', '閉じる');
    await page.waitForSelector('.poiesis-customize-view__discard-confirm');
    await click(page, '.poiesis-customize-view__discard-confirm button', '破棄して閉じる');
    await page.waitForFunction(() => !document.querySelector('.poiesis-customize-view__editor'));
    assert(!readFileSync(createdSkillPath, 'utf8').includes('discard-this-smoke-change'), 'Inline close did not discard the unsaved edit');
    assert(await page.$eval('body', () => document.querySelectorAll('select').length === 0), 'Native select remained in Customize');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.click('.poiesis-agent-window__rail-footer button[aria-label="設定"]');
    await page.waitForSelector('.poiesis-settings-modal');
    await page.waitForFunction(() => document.querySelector('[aria-label="Agent の AI モデル"]')?.dataset.value === 'haiku'
        && document.querySelector('[aria-label="Results の AI モデル"]')?.dataset.value === 'gpt-5.4');
    const persistedModels = await page.evaluate(() => ({
        agentProvider: document.querySelector('input[name="poiesis-agent-cli"]:checked')?.value,
        agentModel: document.querySelector('[aria-label="Agent の AI モデル"]')?.dataset.value,
        resultsProvider: document.querySelector('input[name="poiesis-results-cli"]:checked')?.value,
        resultsModel: document.querySelector('[aria-label="Results の AI モデル"]')?.dataset.value
    }));
    await page.keyboard.press('Escape');

    const customize = {
        expanded: expandedCustomize,
        collapsedRailOpened: true,
        resize: { width: 1024, height: 600 },
        scaffolded: '.poiesis/skills/poiesis-customize-created-smoke/skill.md',
        editedAndSaved: true
    };

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
        cliRegistry,
        modelSelections,
        settingsResize,
        persistedModels,
        customize
    }, null, 2));
} finally {
    restoreScmFixture();
    removeTerminalFixture();
    removeSkillFixtures();
    await browser.close();
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

function removeSkillFixtures() {
    for (const directory of [existingSkillDirectory, createdSkillDirectory]) {
        if (existsSync(directory)) {
            rmSync(directory, { recursive: true, force: true });
        }
    }
    for (const directory of [resolve(repositoryRoot, '.poiesis', 'skills'), resolve(repositoryRoot, '.poiesis')]) {
        try {
            rmdirSync(directory);
        } catch {
            // Preserve parent folders when the workspace contains other user data.
        }
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
    return page.evaluate(fileLabel => document.querySelector('.poiesis-agent-window__code-editor-tab.active .poiesis-agent-window__code-editor-tab-name')
        ?.textContent?.trim().startsWith(fileLabel)
        && Boolean(document.querySelector('.poiesis-agent-window__code-editor-host .monaco-diff-editor')), label);
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

async function choosePoiesisSelect(page, triggerSelector, value) {
    await page.click(triggerSelector);
    await page.waitForSelector('.poiesis-select__listbox');
    const selected = await page.evaluate(nextValue => {
        const option = [...document.querySelectorAll('.poiesis-select__option')]
            .find(candidate => candidate.dataset.value === nextValue);
        if (!(option instanceof HTMLElement)) return false;
        option.click();
        return true;
    }, value);
    assert(selected, `Poiesis select option was not found: ${value}`);
    await page.waitForFunction((selector, nextValue) => document.querySelector(selector)?.dataset.value === nextValue,
        {}, triggerSelector, value);
}

async function clickStable(page, selector) {
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            await page.click(selector);
            return;
        } catch (error) {
            if (!String(error).includes('detached')) throw error;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
    throw new Error(`${selector} remained detached.`);
}

async function insertComposedText(page, value) {
    await page.evaluate(() => {
        const input = document.querySelector('[aria-label="Agent へのメッセージ"]');
        if (!(input instanceof HTMLTextAreaElement)) throw new Error('Agent composer is missing');
        input.focus();
        input.select();
    });
    const client = await page.createCDPSession();
    try {
        await client.send('Input.insertText', { text: value });
    } finally {
        await client.detach();
    }
}

function readState() {
    const content = document.querySelector('.poiesis-agent-window__content');
    const activeSessionTab = document.querySelector('.poiesis-agent-window__tabs button.active')?.textContent?.trim();
    return {
        mode: content?.getAttribute('data-mode'),
        activeSessionTab,
        headerTitle: document.querySelector('.poiesis-agent-window__context > strong')?.textContent?.trim(),
        sessionTabCount: document.querySelectorAll('.poiesis-agent-window__tabs button').length,
        sessionRailVisible: Boolean(document.querySelector('.poiesis-agent-window__rail')),
        agentComposerVisible: Boolean(document.querySelector('[aria-label="Agent の入力欄"]')),
        resultsComposerVisible: Boolean(document.querySelector('[aria-label="Results の入力欄"]')),
        resultsEmptyVisible: Boolean(document.querySelector('.poiesis-results__empty')),
        codeSidebarVisible: Boolean(document.querySelector('.poiesis-agent-window__code-sidebar-host')),
        codeEditorVisible: Boolean(document.querySelector('.poiesis-agent-window__code-editor-host')),
        codeActivityVisible: Boolean(document.querySelector('.poiesis-agent-window__code-activity')),
        codePanelVisible: Boolean(document.querySelector('.poiesis-agent-window__code-panel')),
        codeTerminalVisible: Boolean(document.querySelector('.poiesis-agent-window__code-terminal-host > *')),
        codeStatusVisible: Boolean(document.querySelector('.poiesis-agent-window__code-status')),
        editorTabs: [...document.querySelectorAll('.poiesis-agent-window__code-editor-tab-label')]
            .map(button => button.textContent?.trim()),
        codeLuminoPanelCount: document.querySelectorAll('.poiesis-agent-window__code .lm-Widget.lm-Panel').length,
        codeLuminoTabContainerCount: document.querySelectorAll('.poiesis-agent-window__code .lm-TabBar-content-container').length,
        applicationShellVisible: Boolean(document.querySelector('.poiesis-agent-window__code #theia-app-shell')),
        legacyChangesVisible: Boolean(document.querySelector('.poiesis-changes, #status-bar-poiesis-changes')),
        deferredContextControlVisible: Boolean(document.querySelector('[aria-label="コンテキストを追加"]')),
        sessionRemoveVisible: Boolean(document.querySelector('.poiesis-agent-window__session-remove'))
    };
}
