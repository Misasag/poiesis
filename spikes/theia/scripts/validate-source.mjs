import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFile(resolve(root, path), 'utf8');

const rootPackage = JSON.parse(await read('package.json'));
const appPackage = JSON.parse(await read('browser-app/package.json'));
const electronPackage = JSON.parse(await read('electron-app/package.json'));
const extensionPackage = JSON.parse(await read('agent-window/package.json'));
const agentWidget = await read('agent-window/src/browser/agent-window-widget.tsx');
const agentStyles = await read('agent-window/src/browser/style/index.css');
const moduleSource = await read('agent-window/src/browser/agent-window-frontend-module.ts');
const lensFrontendApplication = await read('agent-window/src/browser/lens-frontend-application.ts');
const designShotContribution = await read('agent-window/src/browser/design-shot-contribution.ts');
const backendModule = await read('agent-window/src/node/agent-window-backend-module.ts');
const agentContribution = await read('agent-window/src/browser/agent-window-contribution.ts');
const providerSource = await read('agent-window/src/common/agent-provider.ts');
const runtimeProtocol = await read('agent-window/src/common/agent-runtime-protocol.ts');
const runtimeClient = await read('agent-window/src/browser/agent-runtime-client.ts');
const cliProvider = await read('agent-window/src/browser/cli-agent-provider.ts');
const mockProvider = await read('agent-window/src/browser/mock-agent-provider.ts');
const taskService = await read('agent-window/src/browser/task-service.ts');
const resultsSkill = await read('agent-window/src/browser/results-skill.ts');
const cliDetector = await read('agent-window/src/node/cli-detector.ts');
const runtimeServer = await read('agent-window/src/node/agent-runtime-server.ts');
const readme = await read('README.md');
const firstCompletion = await read('../../docs/FIRST-COMPLETION.md');

assert.equal(rootPackage.devDependencies['@theia/cli'], '1.73.1');
assert.equal(appPackage.theia.target, 'browser');
assert.ok(appPackage.scripts.start.includes('theia start ../../..'), 'Browser app must open the Lens repository root');
assert.ok(rootPackage.workspaces.includes('electron-app'));
assert.equal(electronPackage.theia.target, 'electron');
assert.equal(electronPackage.dependencies['@theia/electron'], '1.73.1');
assert.equal(electronPackage.devDependencies.electron, '39.8.7');
for (const [name, version] of Object.entries(appPackage.dependencies)) {
    if (name.startsWith('@theia/')) {
        assert.equal(version, '1.73.1', `${name} must match the selected Theia version`);
    }
}
for (const [name, version] of Object.entries(electronPackage.dependencies)) {
    if (name.startsWith('@theia/')) {
        assert.equal(version, '1.73.1', `${name} must match the selected Theia version`);
    }
}

assert.equal(
    extensionPackage.theiaExtensions[0].frontend,
    'lib/browser/agent-window-frontend-module'
);
assert.equal(
    extensionPackage.theiaExtensions[0].backend,
    'lib/node/agent-window-backend-module'
);
assert.equal(extensionPackage.dependencies['@theia/scm'], '1.73.1');
for (const dependency of [
    '@theia/editor',
    '@theia/filesystem',
    '@theia/monaco',
    '@theia/navigator',
    '@theia/plugin-ext-vscode',
    '@theia/scm',
    '@theia/terminal',
    '@theia/workspace'
]) {
    assert.ok(appPackage.dependencies[dependency], `missing ${dependency}`);
}

for (const signature of [
    'createSession(input: CreateSessionInput): Promise<AgentSession>',
    'sendMessage(sessionId: string, message: AgentMessage): Promise<void>',
    'cancel(sessionId: string): Promise<void>',
    'onEvent(listener: (event: AgentEvent) => void): Disposable'
]) {
    assert.ok(providerSource.includes(signature), `AgentProvider is missing ${signature}`);
}
assert.ok(agentWidget.includes("import { AgentEvent, AgentProvider, AgentSession }"));
assert.ok(!agentWidget.includes("from './mock-agent-provider'"), 'Agent UI must depend on AgentProvider, not its implementation');
assert.ok(moduleSource.includes('bind(AgentProvider).toService(CliAgentProvider)'));
assert.ok(moduleSource.includes('.createProxy<AgentRuntimeServer>(agentRuntimeServerPath, client)'));

for (const marker of [
    "item.id === 'codex'",
    "providerName: 'Codex'",
    'return this.mockProvider.createSession(input)',
    'await this.taskService.whenBaselineCaptured(task.id)',
    'await this.runtimeServer.runCodex',
    'type: \'message-delta\'',
    'type: \'message-completed\'',
    'await this.taskService.end(run.taskId)',
    'await this.runtimeServer.cancelCodex',
    'await this.taskService.cancel(run.taskId)',
    'You are the Lens implementer. Only edit files in this directory. Do not leave it. Do not git commit or push.'
]) {
    assert.ok(cliProvider.includes(marker), `CLI AgentProvider is missing ${marker}`);
}
assert.ok(runtimeClient.includes('notifyCodexEvent'));
assert.ok(runtimeClient.includes('onCodexEvent'));

for (const marker of [
    'taskService.start',
    'taskService.end',
    'taskService.cancel',
    "type: 'message-delta'",
    'setTimeout(() => void streamNext()'
]) {
    assert.ok(mockProvider.includes(marker), `MockAgentProvider is missing ${marker}`);
}
for (const forbidden of ['FileService', 'WorkspaceService', 'readFile', 'writeFile', 'execFile']) {
    assert.ok(!mockProvider.includes(forbidden), `MockAgentProvider must not use ${forbidden}`);
}

for (const marker of [
    "start(sessionId: string, request: string)",
    "async end(taskId: string)",
    "async fail(taskId: string)",
    "async cancel(taskId: string)",
    "kind: 'workspace-snapshot'",
    'baselineCaptures',
    'captureGitSnapshot',
    'captureGitChangeSet',
    'whenBaselineCaptured',
    "source: 'empty'"
]) {
    assert.ok(taskService.includes(marker), `TaskService is missing ${marker}`);
}
assert.ok(runtimeServer.includes("'git'"));
assert.ok(runtimeServer.includes("'ls-files', '--cached', '--others', '--exclude-standard'"));
assert.ok(runtimeServer.includes("'diff', '--no-index', '--binary', '--no-color'"));
assert.ok(!taskService.includes("kind: 'placeholder'"), 'TaskService must capture a real baseline');

for (const marker of [
    "KnownCliId = 'codex' | 'claude'",
    "CliLocationSource = 'PATH' | 'well-known'",
    "status: 'found' | 'missing'",
    'CodexExecutionRequest',
    'CodexExecutionEvent',
    'notifyCodexEvent',
    'runCodex(request: CodexExecutionRequest)',
    'cancelCodex(executionId: string)'
]) {
    assert.ok(runtimeProtocol.includes(marker), `Runtime protocol is missing ${marker}`);
}
for (const marker of [
    "process.env.PATH",
    'process.env.APPDATA',
    'process.env.LOCALAPPDATA',
    'process.env.USERPROFILE',
    "id: 'codex'",
    "id: 'claude'",
    'lastReport',
    "status: 'found'",
    "status: 'missing'"
]) {
    assert.ok(cliDetector.includes(marker), `CliDetector is missing ${marker}`);
}
assert.ok(!cliDetector.includes('execFile'), 'CliDetector must not execute detected CLIs');
assert.ok(backendModule.includes('RpcConnectionHandler'));
assert.ok(backendModule.includes('CliDetector'));
assert.ok(backendModule.includes('server.setClient(client)'));

for (const marker of [
    "'exec'",
    "'--sandbox', 'workspace-write'",
    "'--approve-for-me'",
    "'-C', resolvedWorkspace",
    'prompt',
    "cwd, windowsHide: true",
    "child.stdout.on('data'",
    "child.stderr.on('data'",
    "type: 'output'",
    "type: 'exit'",
    "'taskkill'",
    'const resolvedWorkspace = await this.resolveWorkspace(workspacePath)',
    'const snapshot = await this.captureWorkspace(resolvedWorkspace)'
]) {
    assert.ok(runtimeServer.includes(marker), `Codex runtime is missing ${marker}`);
}
assert.ok(!runtimeServer.includes("'--model'"), 'Lens must respect the model selected by Codex configuration');
assert.ok(!runtimeServer.includes('resolveSampleWorkspace'), 'Codex must run in the open Workspace');
assert.ok(!runtimeServer.includes('C:\\Users\\owner\\github\\lens'), 'Codex runtime must not hard-code the repository root');

for (const marker of [
    'class BundledResultsSkill',
    '<!doctype html>',
    '<html lang="ja">',
    'background: #f1efe8',
    'タスク設計',
    'AuthService に logout の出口が加わった',
    'revoke はまだ空のままです。',
    'この Task ではファイルは変更されませんでした。',
    'role="img" aria-label="変更された設計境界"',
    '<cite class="citation"',
    "event.type === 'ended' || event.type === 'failed' || event.type === 'cancelled'",
    "status: 'generating'",
    "status: 'ready'",
    'one complete HTML document'
]) {
    assert.ok(resultsSkill.includes(marker), `Bundled Results skill is missing ${marker}`);
}
assert.equal(resultsSkill.match(/<h1/g)?.length, 1, 'Results document must have one design heading');
for (const forbidden of [
    '<h2>Request</h2>',
    '<pre',
    '${this.escape(diff)}',
    'task.request',
    'lens-results__task-switcher',
    'Results composer'
]) {
    assert.ok(!resultsSkill.includes(forbidden), `Results document must not contain ${forbidden}`);
}
assert.ok(!resultsSkill.includes('task.baseline.note'), 'Results must not render the old placeholder baseline');

for (const marker of [
    "type AgentWindowTab = 'agent' | 'results'",
    "type CodeSidebarTab = 'files' | 'git'",
    'protected codeMode = false',
    "static readonly FILES_WIDGET_FACTORY_ID = 'files'",
    "static readonly GIT_WIDGET_FACTORY_ID = 'scm-view'",
    "static readonly EDITOR_WIDGET_FACTORY_ID = 'code-editor-opener'",
    "static readonly SETTINGS_WIDGET_FACTORY_ID = 'settings_widget'",
    "import { EditorWidget } from '@theia/editor/lib/browser'",
    "import { FileDialogService } from '@theia/filesystem/lib/browser'",
    "import { ScmService } from '@theia/scm/lib/browser/scm-service'",
    "const NEW_SESSION_TITLE = '新しい会話'",
    'interface WindowAgentSession',
    'protected readonly sessions: WindowAgentSession[] = []',
    'this.filteredSessions(false).filter(session => session.hasUserMessage)',
    'const activeTab = session?.activeTab ?? \'agent\'',
    "data-mode={this.appPage ?? (this.codeMode ? 'code' : activeTab)}",
    "data-rail-collapsed={this.railCollapsed ? 'true' : 'false'}",
    '{!this.codeMode && this.renderRail()}',
    'pinnedSessions.map(session => this.renderSessionRow(session))',
    'protected renderSessionRow(session: WindowAgentSession): React.ReactNode',
    '{this.workspaceFolderName()}',
    '{this.workspaceContextLabel()}',
    "ref?.id.startsWith('refs/heads/')",
    'provider.historyProvider?.currentHistoryItemRef',
    'session.title = this.titleForSession(content)',
    'session.hasUserMessage = true',
    'protected async createSession(): Promise<void>',
    "activeTab: 'agent'",
    'session.activeTab = tab',
    'lens-agent-window__code-control',
    'aria-pressed={this.codeMode}',
    '{!this.codeMode && session?.hasUserMessage && (',
    "aria-label='Agent と Results の切り替え'",
    "<span className='lens-agent-window__rail-action-label'>New Chat</span>",
    "aria-label='Results 画面'",
    'lens-results__main',
    'lens-results__task-switcher',
    "aria-label='Results HTML キャンバス'",
    "srcDoc={document.html}",
    "aria-label='Agent の入力欄'",
    "aria-label='Results の入力欄'",
    "placeholder='次の変更内容や質問を入力…'",
    "placeholder='この結果について質問…'",
    'submitResultsQuestion',
    'protected toggleCodeMode(): void',
    'protected renderCode(): React.ReactNode',
    "className='lens-agent-window__code-sidebar-host'",
    "className='lens-agent-window__code-editor-host'",
    "this.selectCodeSidebarTab('files')",
    "this.selectCodeSidebarTab('git')",
    'registerCodeWidget(factoryId: string, widget: Widget): void',
    'protected isCodeCenterWidget(factoryId: string, widget: Widget): boolean',
    'widget instanceof EditorWidget',
    'factoryId.startsWith(AgentWindowWidget.EDITOR_WIDGET_FACTORY_ID)',
    'protected syncCodeWidgetAttachments(): void',
    'this.attachCodeWidget(this.activeCodeSidebarWidget(), this.codeSidebarHost)',
    'this.attachCodeWidget(this.activeCodeCenterWidget, this.codeEditorHost)',
    'this.resizeCodeWidget(this.activeCodeSidebarWidget(), host)',
    'this.resizeCodeWidget(this.activeCodeCenterWidget, host)',
    'widget.parent = null',
    'protected revealCodeWidget(widget: Widget, host: HTMLDivElement): void',
    'requestAnimationFrame(() =>',
    'protected resizeCodeWidget(widget: Widget | undefined, host: HTMLDivElement): void',
    'const width = host.clientWidth',
    'const height = host.clientHeight',
    'new Widget.ResizeMessage(width, height)',
    'widget.editor.resizeToFit()',
    'widget.editor.refresh()',
    'Widget.attach(widget, host)',
    'Widget.detach(widget)',
    'protected openSettings(): void',
    "this.appPage = 'settings'",
    'protected openCustomize(): void',
    "this.appPage = 'customize'",
    'protected renderAppPage(): React.ReactNode',
    'protected renderLensSettings(): React.ReactNode',
    'protected renderCustomize(): React.ReactNode',
    "static readonly PLUGINS_WIDGET_FACTORY_ID = 'vsx-extensions-view-container'",
    'protected async ensurePluginsWidget(): Promise<void>',
    "className='lens-agent-window__plugins-host'",
    "aria-label='Results skillを有効化'",
    'this.customizationService.setSkillEnabled',
    'onCompositionEnd={event => this.setAgentDraft(event.currentTarget.value)}'
]) {
    assert.ok(agentWidget.includes(marker), `Agent / Results / Code UI is missing ${marker}`);
}
for (const dummyChrome of [
    '<small>lens / main</small>',
    '<strong>lens</strong>',
    '認証を Redis 方式へ変更',
    "<span className='codicon codicon-settings-gear' title='設定'"
]) {
    assert.ok(!agentWidget.includes(dummyChrome), `Dummy Agent chrome must not return: ${dummyChrome}`);
}
assert.ok(agentWidget.includes('@inject(StorageService)'), 'Window sessions must use the application storage boundary');
assert.ok(agentWidget.includes('this.storageService.setData'), 'Window sessions must persist across reloads');
assert.ok(!agentWidget.includes('window.localStorage'), 'The Agent widget must not write browser storage directly');
assert.ok(!agentWidget.includes('sessionStorage'), 'Window sessions must survive a browser session');
const railSource = agentWidget.match(
    /protected renderRail\(\): React\.ReactNode \{[\s\S]*?\n    protected readonly setSessionSearchInput/
)?.[0];
assert.ok(railSource, 'Agent rail render source is missing');
const newChatPosition = railSource.indexOf("<span className='lens-agent-window__rail-action-label'>New Chat</span>");
const searchPosition = railSource.indexOf("<span className='lens-agent-window__rail-action-label'>Search</span>");
assert.ok(newChatPosition !== -1, 'Agent rail must contain New Chat');
assert.ok(searchPosition > newChatPosition, 'Conversation Search must sit directly under New Chat');
for (const marker of [
    'protected railCollapsed = false',
    'protected toggleRail(): void',
    'this.railCollapsed = !this.railCollapsed',
    "data-collapsed={this.railCollapsed ? 'true' : 'false'}",
    'protected sessionSearchQuery = \'\'',
    "aria-label='会話をタイトルで検索'",
    'session.title.toLocaleLowerCase().includes(query)',
    'protected workspaceExpanded = true',
    'protected toggleWorkspace(): void',
    "<div className='lens-agent-window__rail-heading'>",
    '<span>Workspaces</span>',
    "className='lens-agent-window__workspace-group'",
    "className='lens-agent-window__session-title'",
    'lens-agent-window__session-meta',
    'protected sessionMeta(session: WindowAgentSession): string',
    'protected togglePinnedSession(sessionId: string): void',
    'protected beginSessionRename(sessionId: string): void',
    'protected async archiveSession(sessionId: string): Promise<void>',
    'protected async deleteSession(sessionId: string): Promise<void>',
    'protected restoreSession(sessionId: string, select = false): void',
    "aria-label='サイドバーの幅を変更'",
    'protected startRailResize(event: React.PointerEvent<HTMLDivElement>): void',
    'protected async persistWindowState(): Promise<void>',
    'protected async restoreWindowState(): Promise<boolean>',
    'protected async openRepository(): Promise<void>',
    'protected renderWorkspacePicker(): React.ReactNode',
    "aria-label='Workspaceを開く'",
    "aria-label='Workspaceを検索'",
    'this.fileDialogService.showOpenDialog',
    'this.workspaceService.open(folder, { preserveWindow: true })',
    "runTarget: 'local'",
    "className='lens-agent-window__new-agent-context'",
    "aria-label='Repositoryを選択'",
    "aria-label='Repositoryを検索'",
    '<span>Run on · This Computer</span>',
    'protected repositoryChoices()',
    'protected selectRepository(session: WindowAgentSession, workspaceUri: string): void',
    'protected async chooseExistingRepository(session: WindowAgentSession): Promise<void>',
    'protected async openFolderExplorer(session: WindowAgentSession): Promise<void>',
    'this.folderExplorerService.browse',
    'protected renderFolderExplorer(): React.ReactNode',
    "aria-label='フォルダーを選択'",
    'await this.ensureProviderSession(session, false, true)',
    'onClick={() => this.openSettings()}'
]) {
    assert.ok(agentWidget.includes(marker), `Agent rail is missing ${marker}`);
}
assert.ok(!railSource.includes('<small>現在</small>'), 'Selected sessions must use quiet age metadata, not a current badge');
assert.ok(
    (agentWidget.match(/onClick=\{\(\) => this\.openSettings\(\)\}/g)?.length ?? 0) >= 2,
    'Settings controls must open the Lens-owned settings page'
);
assert.ok(!agentWidget.includes('lens-agent-window__composer-tools'), 'Deferred composer tools must not be shown');
assert.ok(!agentWidget.includes('protected activeTab:'), 'Agent / Results selection must belong to each session');
assert.ok(!agentWidget.includes('Widget.ResizeMessage.UnknownSize'), 'Code widgets must receive measured pixel resize messages');
assert.equal(
    agentWidget.match(/this\.selectTab\('results'\)/g)?.length,
    1,
    'Only the explicit Results tab action may switch to Results'
);
const codeToggle = agentWidget.match(/protected toggleCodeMode\(\): void \{[\s\S]*?\n    \}/)?.[0];
assert.ok(codeToggle, 'Code mode toggle is missing');
assert.ok(!codeToggle.includes('activeTab'), 'Code mode must preserve the previous Agent / Results tab');
assert.match(
    codeToggle,
    /if \(this\.codeMode\) \{\s*this\.detachCodeWidgets\(\);\s*this\.codeMode = false;/,
    'Leaving Code mode must detach direct Theia widgets before rendering Agent / Results'
);
for (const forbidden of [
    'ApplicationShell',
    'setCodeShell',
    'attachCodeShell',
    'detachCodeShell',
    'codeShell',
    'lens-agent-window__theia-host'
]) {
    assert.ok(!agentWidget.includes(forbidden), `Code mode must not host ${forbidden}`);
}
for (const forbidden of [
    'renderQuestion',
    'showQuestion',
    'hideQuestion',
    'Agent CLI detection report',
    '{item.name}: {item.status}',
    'IMPLEMENTER',
    'DETECTED AGENT',
    "implementerName = usingCodex ? 'Codex'",
    'Detected Codex CLI active as implementer',
    'MockAgentProvider active because Codex was not found',
    'Detecting CLIs…',
    "'-- Running --'",
    '● Ready',
    '● Running',
    'Finished or cancelled Tasks will appear here.',
    'Generating one complete Results document…',
    'Kept in Results scope;'
]) {
    assert.ok(!agentWidget.includes(forbidden), `Old Agent chrome remains: ${forbidden}`);
}
for (const forbidden of ['AgentRuntimeServer', 'CliDetectionReport', 'detectClis()']) {
    assert.ok(!agentWidget.includes(forbidden), `Agent widget must not expose CLI diagnostics: ${forbidden}`);
}
for (const marker of [
    '#lens-window-host',
    '.theia-preload.theia-hidden',
    'pointer-events: none',
    '--lens-chrome-bg: #181918',
    '--lens-chrome-panel: #1d1e1c',
    'grid-template-columns: var(--lens-rail-width, 252px) minmax(0, 1fr)',
    ".lens-agent-window__content[data-mode='code']",
    ".lens-agent-window__content:not([data-mode='code'])[data-rail-collapsed='true']",
    ".lens-agent-window__rail[data-collapsed='true']",
    '.lens-agent-window__session-search',
    '.lens-agent-window__workspace-group',
    '.lens-agent-window__workspace-picker',
    '.lens-agent-window__session-meta',
    '.lens-agent-window__session-menu',
    '.lens-agent-window__session-rename',
    '.lens-agent-window__archived-toggle',
    '.lens-agent-window__rail-resize-handle',
    '.lens-agent-window__viewport',
    '.lens-agent-window__code',
    '.lens-agent-window__code-sidebar-host',
    '.lens-agent-window__code-editor-host',
    '.lens-agent-window__code-footer',
    '.lens-agent-window__app-page',
    '.lens-agent-window__app-nav',
    '.lens-agent-window__customize-card',
    '.lens-agent-window__plugins-manager',
    '.lens-agent-window__plugins-host',
    '.lens-agent-window__switch',
    '.lens-agent-window__composer',
    '.lens-agent-window__new-agent-empty',
    '.lens-agent-window__new-agent-context',
    '.lens-agent-window__repository-picker',
    '.lens-agent-window__context-pill',
    'align-self: end',
    '.lens-results__main',
    'grid-template-rows: minmax(0, 1fr) auto auto',
    '.lens-results__task-switcher',
    'border-left: 1px solid var(--lens-chrome-line)'
]) {
    assert.ok(agentStyles.includes(marker), `Agent chrome styles are missing ${marker}`);
}
assert.match(
    agentStyles,
    /\.lens-agent-window__rail-action\s*\{[^}]*font-size:\s*11px;/,
    'New Chat and Search text must match the sidebar spec'
);
assert.match(
    agentStyles,
    /\.lens-agent-window__rail-heading\s*\{[^}]*font-size:\s*10px;/,
    'Workspaces text must match the sidebar spec'
);
assert.ok(!agentStyles.includes('.lens-agent-window__composer-tools'), 'Deferred composer tool styles must not remain');
assert.match(
    agentStyles,
    /\.lens-agent-window__send \.codicon,[\s\S]*?color:\s*#222320;/,
    'Send icons must contrast their light button background'
);
assert.match(
    agentStyles,
    /\.lens-agent-window__viewport\s*\{[^}]*height:\s*100%;/,
    'Code viewport must have a definite height'
);
assert.match(
    agentStyles,
    /\.lens-agent-window__code\s*\{[^}]*height:\s*100%;/,
    'Code layout must have a definite height'
);
assert.match(
    agentStyles,
    /\.lens-agent-window__code-sidebar-host,\s*\.lens-agent-window__code-editor-host\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/,
    'Code widget hosts must fill their minmax rows without collapsing'
);
assert.match(
    agentStyles,
    /\.lens-agent-window__code-editor\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/,
    'Editor host must occupy the remaining row below its tabs'
);

assert.ok(!moduleSource.includes('ChangesWidget'), 'Historical Changes must not be registered');
assert.ok(!moduleSource.includes('ChangesContribution'), 'Historical Changes must not be registered');
assert.ok(moduleSource.includes('bind(AgentWindowWidget).toSelf().inSingletonScope()'));
assert.ok(moduleSource.includes('bind(AgentWindowContribution).toSelf().inSingletonScope()'));
assert.ok(!moduleSource.includes('bindViewContribution(bind, AgentWindowContribution)'));
assert.ok(!moduleSource.includes('id: AgentWindowWidget.ID'));
assert.ok(!moduleSource.includes('createWidget: () => context.container.get(AgentWindowWidget)'));
for (const marker of [
    'implements FrontendApplicationContribution',
    '@inject(AgentWindowWidget)',
    '@inject(WidgetManager)',
    '@inject(EditorManager)',
    'this.editorManager.onCreated',
    'this.widgetManager.onDidCreateWidget',
    'async onDidInitializeLayout(): Promise<void>',
    'this.widgetManager.getOrCreateWidget(AgentWindowWidget.FILES_WIDGET_FACTORY_ID)',
    'this.widgetManager.getOrCreateWidget(AgentWindowWidget.GIT_WIDGET_FACTORY_ID)',
    'for (const editor of this.editorManager.all)',
    'this.agentWindowWidget.registerCodeWidget(factoryId, widget)',
    "host.id = 'lens-window-host'",
    'document.body.appendChild(host)',
    'Widget.attach(this.agentWindowWidget, host)'
]) {
    assert.ok(agentContribution.includes(marker), `Lens-owned Agent host is missing ${marker}`);
}
for (const forbidden of [
    'AbstractViewContribution',
    'defaultWidgetOptions',
    'widgetName',
    'toggleCommandId',
    'openView('
]) {
    assert.ok(!agentContribution.includes(forbidden), `Agent Window must not use docked view API ${forbidden}`);
}
assert.ok(!agentContribution.includes('ApplicationShell'), 'Agent Window contribution must never receive ApplicationShell');
assert.ok(!agentContribution.includes('app.shell'), 'Agent Window must never receive or attach ApplicationShell');
for (const marker of [
    'class LensFrontendApplication extends FrontendApplication',
    'protected override attachShell(_host: HTMLElement): void'
]) {
    assert.ok(lensFrontendApplication.includes(marker), `Lens frontend shell policy is missing ${marker}`);
}
assert.ok(!lensFrontendApplication.includes('super.attachShell'), 'Lens must not delegate ApplicationShell attachment');
assert.ok(!lensFrontendApplication.includes('Widget.attach'), 'Lens frontend must not attach ApplicationShell directly');
assert.ok(moduleSource.includes('rebind(FrontendApplication).to(LensFrontendApplication).inSingletonScope()'));
for (const marker of [
    "import { ThemeService } from '@theia/core/lib/browser/theming'",
    'this.themeService.onDidColorThemeChange',
    'void this.preferenceService.ready.then',
    "this.themeService.setCurrentTheme('dark', false)"
]) {
    assert.ok(designShotContribution.includes(marker), `Lens startup theme lock is missing ${marker}`);
}
assert.ok(
    !designShotContribution.includes('getDesignVariant'),
    'Lens startup theme lock must also run outside design-shot variants'
);
assert.ok(moduleSource.includes('bind(FrontendApplicationContribution).toService(DesignShotContribution)'));
assert.ok(!agentWidget.includes('this.title.label'), 'Agent / Results must not define a Theia tab title');
assert.ok(!agentWidget.includes('this.title.closable'), 'Lens outer content must not opt into closable Theia tab chrome');
assert.ok(!agentStyles.includes('theia-tabBar-tab-row'), 'Agent / Results must not hide Theia tab rows with CSS');
assert.ok(!agentStyles.includes('.theia-tabBar'), 'Agent / Results styles must not target Theia tab bars');
assert.ok(!agentStyles.includes('.lm-TabBar'), 'Agent / Results styles must not target Lumino tab bars');
for (const forbidden of ['lm-Widget', 'lm-Panel', 'lm-BoxPanel', 'lm-SplitPanel-child', 'theia-mod-collapsed']) {
    assert.ok(!agentStyles.includes(forbidden), `Code chrome must remove ${forbidden} nodes instead of hiding them with CSS`);
}
for (const forbidden of ['theia-ApplicationShell', 'theia-tabBar-tab-row', '.theia-tabBar', '.lm-TabBar']) {
    assert.ok(!agentStyles.includes(forbidden), `Code chrome must not CSS-hide ${forbidden}`);
}
assert.ok(
    firstCompletion.includes('Code does not host ApplicationShell; Lens hosts Files/Git/Editor widgets only.'),
    'FIRST-COMPLETION must state the Code widget-hosting boundary'
);
for (const marker of ['AgentProvider', 'Codex CLI', 'TaskService', 'ResultsSkill', 'Agent / Results / Code']) {
    assert.ok(readme.includes(marker), `README is missing ${marker}`);
}

console.log('Source contract validation passed.');
