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
const poiesisFrontendApplication = await read('agent-window/src/browser/poiesis-frontend-application.ts');
const poiesisWorkspaceTrustService = await read('agent-window/src/browser/poiesis-workspace-trust-service.ts');
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
const resultsQuestionProtocol = await read('agent-window/src/common/results-question-protocol.ts');
const resultsQuestionService = await read('agent-window/src/browser/results-question-service.ts');
const resultsQuestionServer = await read('agent-window/src/node/results-question-server.ts');
const resultsGenerationProtocol = await read('agent-window/src/common/results-generation-protocol.ts');
const resultsGenerationContext = await read('agent-window/src/browser/results-generation-context.ts');
const resultsGenerationServer = await read('agent-window/src/node/results-generation-server.ts');
const globalStorageService = await read('agent-window/src/browser/global-storage-service.ts');
const cliDetector = await read('agent-window/src/node/cli-detector.ts');
const cliProviderRegistry = await read('agent-window/src/node/cli-provider-registry.ts');
const skillBundleContract = await read('agent-window/src/common/skill-bundle.ts');
const runtimeServer = await read('agent-window/src/node/agent-runtime-server.ts');
const electronSmoke = await read('scripts/smoke-electron.mjs');
const electronFrontendModule = await read('agent-window/src/electron-browser/agent-window-electron-frontend-module.ts');
const electronWindowControls = await read('agent-window/src/electron-browser/window-controls.tsx');
const electronWindowStyles = await read('agent-window/src/electron-browser/window-controls.css');
const readme = await read('README.md');
const firstCompletion = await read('../../docs/FIRST-COMPLETION.md');
const skillsContract = await read('../../docs/SKILLS-CONTRACT.md');

assert.equal(rootPackage.devDependencies['@theia/cli'], '1.73.1');
assert.equal(appPackage.theia.target, 'browser');
assert.ok(appPackage.scripts.start.includes('theia start ../../..'), 'Browser app must open the Poiesis repository root');
assert.ok(rootPackage.workspaces.includes('electron-app'));
assert.equal(electronPackage.theia.target, 'electron');
assert.equal(electronPackage.dependencies['@theia/electron'], '1.73.1');
assert.equal(electronPackage.devDependencies.electron, '39.8.7');
assert.equal(appPackage.theia.frontend.config.preferences['security.workspace.trust.enabled'], false);
assert.equal(electronPackage.theia.frontend.config.preferences['security.workspace.trust.enabled'], false);
assert.equal(appPackage.theia.frontend.config.preferences['extensions.ignoreRecommendations'], true);
assert.equal(electronPackage.theia.frontend.config.preferences['extensions.ignoreRecommendations'], true);
for (const marker of [
    "'#poiesis-window-host .poiesis-agent-window__content'",
    "'.poiesis-agent-window__code'",
    "'.poiesis-agent-window__code-terminal-host > *'",
    'poiesis-terminal-smoke',
    'Active Terminal',
    'Kill Terminal',
    'Refresh Source Control',
    'scm-history-graph-row',
    "'Stage Changes'",
    "'Unstage Changes'",
    'assertNativeWindowDrag',
    'assertNativeHeaderDoubleClick',
    'PoiesisNativeInput',
    'session rail top',
    'headerInteractionChecks',
    'customizeWindowChecks',
    'POIESIS_WINDOW_DRAG_ONLY',
    'ELECTRON_WINDOW_DRAG_SMOKE_RESULT=',
    'dragExplorerFileToTabs',
    'ELECTRON_SMOKE_RESULT='
]) {
    assert.ok(electronSmoke.includes(marker), `Electron smoke test is missing current Poiesis UI check ${marker}`);
}
for (const obsolete of [
    "clickSelector(page, '#status-bar-poiesis-changes'",
    'Code Diff representation',
    'Semantic Diff representation',
    "activateEditorTab(page, 'auth-service.ts'"
]) {
    assert.ok(!electronSmoke.includes(obsolete), `Electron smoke test still targets removed UI: ${obsolete}`);
}
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
assert.equal(
    extensionPackage.theiaExtensions[1].frontendElectron,
    'lib/electron-browser/agent-window-electron-frontend-module'
);
for (const marker of [
    'bind(WindowControls).toSelf().inSingletonScope()',
    'bind(FrontendApplicationContribution).toService(WindowControls)',
    "import '../../src/electron-browser/window-controls.css'"
]) {
    assert.ok(electronFrontendModule.includes(marker), `Electron window-controls module is missing ${marker}`);
}
for (const marker of [
    'window.electronTheiaCore',
    "this.electron.minimize()",
    "this.electron.maximize()",
    "this.electron.unMaximize()",
    "this.electron.close()",
    "this.electron.onWindowEvent('maximize'",
    "document.addEventListener('dblclick'",
    "event.target.closest('.poiesis-agent-window__header')",
    "aria-label='最小化'",
    "'元に戻す' : '最大化'",
    "aria-label='閉じる'"
]) {
    assert.ok(electronWindowControls.includes(marker), `Electron window controls are missing ${marker}`);
}
assert.ok(!electronWindowControls.includes("require('electron')"), 'Window controls must use Theia electron APIs');
for (const marker of [
    '.poiesis-agent-window__header {',
    '.poiesis-agent-window__rail-top,',
    '\n    app-region: drag;',
    '-webkit-app-region: drag;',
    'user-select: none;',
    "[role='tab']",
    '\n    app-region: no-drag;',
    '-webkit-app-region: no-drag;',
    'padding-right: 154px;',
    '.poiesis-window-controls__close:hover',
    'outline: 2px solid #c28b60'
]) {
    assert.ok(electronWindowStyles.includes(marker), `Electron window-control styles are missing ${marker}`);
}
assert.equal(extensionPackage.dependencies['@theia/scm'], '1.73.1');
assert.equal(extensionPackage.dependencies['@theia/search-in-workspace'], '1.73.1');
assert.ok(resultsQuestionProtocol.includes('workspaceUri: string'), 'Results question scope must name its workspace');
assert.ok(resultsQuestionProtocol.includes('providerId: KnownCliId'), 'Results question scope must name its AI provider');
assert.ok(resultsQuestionService.includes('return this.server.ask(question, scope)'), 'Results question browser proxy is missing');
for (const marker of [
    'this.resultsQuestionService.ask(question, {',
    'workspaceUri: session.workspaceUri',
    'providerId: this.resultsCli',
    "status: 'sending'",
    "status: 'answered'",
    "status: 'failed'",
    'question.length > 4_000',
    "currentNotice?.status === 'sending'"
]) {
    assert.ok(agentWidget.includes(marker), `Results question widget wiring is missing ${marker}`);
}
assert.ok(!agentWidget.includes('this.resultsService.answer('), 'Bundled Results skill must not answer questions');
assert.ok(!resultsSkill.includes('async answer('), 'Bundled Results skill must only generate documents');
for (const marker of [
    'this.resolveWorkspace(scope.workspaceUri)',
    "this.providerRegistry.resolve('results', scope.providerId)",
    "resource.scheme !== 'file'",
    "'--sandbox', 'read-only'",
    "'--permission-mode', 'plan'",
    "'--tools='",
    "provider.id === 'claude'",
    'this.runs.has(scope.taskId)'
]) {
    assert.ok(resultsQuestionServer.includes(marker), `Results question server is missing ${marker}`);
}
assert.ok(!resultsQuestionServer.includes('getMostRecentlyUsedWorkspace'), 'Results questions must not use an unrelated recent workspace');
for (const marker of [
    "resultsGenerationServerPath = '/services/poiesis/results-generation'",
    'providerId: KnownCliId',
    'workspaceUri: string',
    'changeSetSummary: string',
    'diff: string',
    'generate(request: ResultsGenerationRequest)',
    'cancel(taskId: string)'
]) {
    assert.ok(resultsGenerationProtocol.includes(marker), `Results generation protocol is missing ${marker}`);
}
for (const marker of [
    "this.providerRegistry.resolve('results', request.providerId)",
    "'--sandbox', 'read-only'",
    "'--permission-mode', 'plan'",
    "'--tools='",
    'GENERATED_RESULTS_HTML_MAX_CHARS = 280_000',
    'RESULTS_GENERATION_TIMEOUT_MS = 120_000',
    "process.env.POIESIS_RESULTS_GENERATION_FORCE_FAILURE === '1'",
    'HTML文書を1つだけ',
    'インラインSVGまたはCSS図',
    'script、イベントハンドラ、外部URL',
    'void this.killProcess(run.process)'
]) {
    assert.ok(resultsGenerationServer.includes(marker), `Results generation server is missing ${marker}`);
}
assert.ok(resultsGenerationContext.includes("providerId: KnownCliId = 'codex'"));
assert.ok(moduleSource.includes('.createProxy<ResultsGenerationServer>(resultsGenerationServerPath)'));
assert.ok(moduleSource.includes('bind(ResultsSkill).toService(AiResultsSkill)'));
assert.ok(!resultsSkill.includes('isSkillEnabled'), 'Built-in Results generation must not be disabled by a hidden legacy setting');
assert.ok(backendModule.includes('bind(ResultsGenerationServer).to(ResultsGenerationServerImpl).inSingletonScope()'));
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
assert.ok(providerSource.includes('ownerSessionId: string'), 'Agent messages must retain their stable app-session owner');
assert.ok(agentWidget.includes("import { AgentEvent, AgentProvider, AgentSession }"));
assert.ok(!agentWidget.includes("from './mock-agent-provider'"), 'Agent UI must depend on AgentProvider, not its implementation');
assert.ok(moduleSource.includes('bind(AgentProvider).toService(CliAgentProvider)'));
assert.ok(moduleSource.includes('.createProxy<AgentRuntimeServer>(agentRuntimeServerPath, client)'));
assert.ok(moduleSource.includes('rebind(WorkspaceTrustService).toService(PoiesisWorkspaceTrustService)'));
assert.ok(poiesisWorkspaceTrustService.includes('extends WorkspaceTrustService'));
assert.ok(poiesisWorkspaceTrustService.includes('return Promise.resolve(true)'));

for (const marker of [
    'const providerId = input.providerId',
    'providerName: detection.name',
    'return this.mockProvider.createSession(input)',
    "report.detections.some(item => item.status === 'found')",
    'this.taskService.start(message.ownerSessionId, message.content, session.workspacePath)',
    'await this.taskService.whenBaselineCaptured(task.id)',
    'await this.runtimeServer.runCodex',
    'providerId: session.providerId',
    "run.providerId === 'claude'",
    "claudeEvent.type === 'assistant'",
    "claudeEvent.type === 'result'",
    'type: \'message-delta\'',
    'type: \'message-completed\'',
    'await this.taskService.end(run.taskId)',
    'await this.runtimeServer.cancelCodex',
    'await this.taskService.cancel(run.taskId)',
    'You are the Poiesis implementer. Only edit files in this directory. Do not leave it. Do not git commit or push.'
]) {
    assert.ok(cliProvider.includes(marker), `CLI AgentProvider is missing ${marker}`);
}
assert.ok(runtimeClient.includes('notifyCodexEvent'));
assert.ok(runtimeClient.includes('onCodexEvent'));

for (const marker of [
    'モック応答です。',
    'Workspaceの読み取り・編集・実行は行っていません。',
    "type: 'message-delta'",
    "type: 'message-completed'"
]) {
    assert.ok(mockProvider.includes(marker), `MockAgentProvider is missing ${marker}`);
}
for (const forbidden of ['TaskService', 'taskService.start', 'taskService.end', 'captureGitSnapshot']) {
    assert.ok(!mockProvider.includes(forbidden), `MockAgentProvider must not create a Task through ${forbidden}`);
}
for (const forbidden of ['FileService', 'WorkspaceService', 'readFile', 'writeFile', 'execFile']) {
    assert.ok(!mockProvider.includes(forbidden), `MockAgentProvider must not use ${forbidden}`);
}

for (const marker of [
    "start(sessionId: string, request: string, workspacePath?: string)",
    'failBeforeStart(sessionId: string, request: string, failure: TaskFailure)',
    "async end(taskId: string)",
    "async fail(taskId: string, failure?: TaskFailure)",
    "async cancel(taskId: string)",
    "kind: 'workspace-snapshot'",
    'baselineCaptures',
    'captureGitSnapshot',
    'captureGitChangeSet',
    'whenBaselineCaptured',
    'workspacePath ?? root?.resource.path.fsPath()',
    'baseline = await baselinePromise',
    "source: 'empty'"
]) {
    assert.ok(taskService.includes(marker), `TaskService is missing ${marker}`);
}
assert.ok(runtimeServer.includes("'git'"));
assert.ok(runtimeServer.includes("'ls-files', '--cached', '--others', '--exclude-standard'"));
assert.ok(runtimeServer.includes("'diff', '--no-index', '--binary', '--no-color'"));
assert.ok(!taskService.includes("kind: 'placeholder'"), 'TaskService must capture a real baseline');
for (const marker of [
    'restore(tasks: readonly ExecutionTask[])',
    "failure: { summary: 'アプリ終了により中断されました' }",
    'remove(taskIds: Iterable<string>)'
]) {
    assert.ok(taskService.includes(marker), `Task persistence is missing ${marker}`);
}

for (const marker of [
    "KnownCliId = 'codex' | 'claude'",
    "AiRole = 'agent' | 'results'",
    "CliLocationSource = 'PATH' | 'well-known'",
    "status: 'found' | 'missing'",
    'CodexExecutionRequest',
    'providerId: KnownCliId',
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
    "process.env.POIESIS_DISABLE_CLI_DETECTION === '1'",
    'lastReport',
    "status: 'found'",
    "status: 'missing'"
]) {
    assert.ok(cliDetector.includes(marker), `CliDetector is missing ${marker}`);
}
assert.ok(!cliDetector.includes('execFile'), 'CliDetector must not execute detected CLIs');
assert.ok(backendModule.includes('RpcConnectionHandler'));
assert.ok(backendModule.includes('CliDetector'));
assert.ok(backendModule.includes('CliProviderRegistry'));
assert.ok(backendModule.includes('server.setClient(client)'));
for (const marker of [
    "agent: ['codex', 'claude']",
    "results: ['codex', 'claude']",
    'this.cliDetector.recordedReport',
    'class CliProviderRegistry'
]) {
    assert.ok(cliProviderRegistry.includes(marker), `CLI provider registry is missing ${marker}`);
}

for (const marker of [
    "'exec'",
    "'--sandbox', 'workspace-write'",
    "'-C', resolvedWorkspace",
    'prompt',
    "cwd, windowsHide: true",
    "child.stdout.on('data'",
    "child.stderr.on('data'",
    "type: 'output'",
    "type: 'exit'",
    "'taskkill'",
    "process.env.POIESIS_AGENT_FORCE_PRESPAWN_FAILURE === '1'",
    'const resolvedWorkspace = await this.resolveWorkspace(workspacePath)',
    "this.providerRegistry.resolve('agent', providerId)",
    "provider.id === 'claude'",
    "'--permission-mode', 'acceptEdits'",
    "'--output-format', 'stream-json'",
    "'--safe-mode'",
    'const snapshot = await this.captureWorkspace(resolvedWorkspace)'
]) {
    assert.ok(runtimeServer.includes(marker), `Codex runtime is missing ${marker}`);
}
assert.ok(!runtimeServer.includes("'--model'"), 'Poiesis must respect the model selected by Codex configuration');
assert.ok(!runtimeServer.includes('resolveSampleWorkspace'), 'Codex must run in the open Workspace');
assert.ok(!runtimeServer.includes('C:\\Users\\owner\\github\\poiesis'), 'Codex runtime must not hard-code the repository root');

for (const marker of [
    'class BundledResultsSkill',
    'class AiResultsSkill',
    '<!doctype html>',
    '<html lang="ja">',
    'background: #f1efe8',
    'タスク設計',
    'AuthService に logout の出口が加わった',
    'revoke はまだ空のままです。',
    'この Task ではファイルは変更されませんでした。',
    'role="img" aria-label="変更された設計境界"',
    '<cite class="citation"',
    '.paper { width: 100%; min-height: 100vh;',
    '::-webkit-scrollbar-thumb',
    "event.type === 'ended' || event.type === 'failed' || event.type === 'cancelled'",
    "status: 'generating'",
    "status: 'ready'",
    'one complete HTML document',
    "id: 'builtin.ai-results'",
    "entry: 'builtin:ai-results'",
    'this.generationServer.generate({',
    'this.fallbackSkill.generate(input)',
    'normalizeAndValidate',
    'AI_RESULTS_HTML_MAX_CHARS = 280_000',
    'this.resultsSkill.cancel?.(taskId)',
    'this.generationTokens.get(task.id) !== generationToken'
]) {
    assert.ok(resultsSkill.includes(marker), `Bundled Results skill is missing ${marker}`);
}
assert.equal(resultsSkill.match(/<h1/g)?.length, 1, 'Results document must have one design heading');
for (const forbidden of [
    '<h2>Request</h2>',
    '<pre',
    '${this.escape(diff)}',
    'this.escape(task.request)',
    'poiesis-results__task-switcher',
    'Results composer'
]) {
    assert.ok(!resultsSkill.includes(forbidden), `Results document must not contain ${forbidden}`);
}
assert.ok(!resultsSkill.includes('task.baseline.note'), 'Results must not render the old placeholder baseline');
for (const marker of [
    "id: 'builtin.results'",
    "kind: 'results' as const",
    "entry: 'builtin:results'",
    'extends ResultsSkillBundle',
    'restore(documents: readonly TaskResultDocument[]'
]) {
    assert.ok(resultsSkill.includes(marker), `Bundled Results bundle is missing ${marker}`);
}
for (const marker of [
    "SkillBundleKind = 'agent' | 'results'",
    'interface SkillBundleManifest',
    'interface SkillDocumentFrontmatter',
    'interface SkillDocumentBundle',
    "readonly source: 'workspace'",
    'readonly skillDocumentUri: string',
    'interface SkillBundleLifecycle',
    'install(manifest: SkillBundleManifest)',
    'remove(id: string)',
    'enable(id: string)',
    'disable(id: string)'
]) {
    assert.ok(skillBundleContract.includes(marker), `Skill bundle TypeScript contract is missing ${marker}`);
}
for (const marker of [
    '# Poiesis Skills bundle contract',
    'Agent skill',
    'Results skill',
    'multi-agent orchestration',
    'runtime config schema',
    '`builtin.results`',
    '.poiesis/skills/<skill-id>/',
    '`skill.md` bundleも`SkillBundle`契約へ適合する'
]) {
    assert.ok(skillsContract.includes(marker), `Skills contract document is missing ${marker}`);
}
assert.ok(skillsContract.includes('`builtin.ai-results`'), 'Skills contract must describe the AI Results bundle');

for (const marker of [
    "type AgentWindowTab = 'agent' | 'results'",
    "type CodeSidebarTab = 'files' | 'search' | 'git' | 'extensions'",
    'protected codeMode = false',
    'protected customizeModalVisible = false',
    "static readonly FILES_WIDGET_FACTORY_ID = 'files'",
    "static readonly SEARCH_WIDGET_FACTORY_ID = 'search-in-workspace'",
    "static readonly GIT_WIDGET_FACTORY_ID = 'scm-view'",
    "static readonly GIT_GRAPH_WIDGET_FACTORY_ID = 'scm-history-graph-widget'",
    "static readonly EXTENSIONS_WIDGET_FACTORY_ID = 'vsx-extensions-view-container'",
    "static readonly EDITOR_WIDGET_FACTORY_ID = 'code-editor-opener'",
    "static readonly SETTINGS_WIDGET_FACTORY_ID = 'settings_widget'",
    "import { EditorManager, EditorWidget } from '@theia/editor/lib/browser'",
    "import { IconThemeService } from '@theia/core/lib/browser/icon-theme-service'",
    "import { BUILTIN_QUERY, VSXExtensionsSearchModel } from '@theia/vsx-registry/lib/browser/vsx-extensions-search-model'",
    "import { ScmService } from '@theia/scm/lib/browser/scm-service'",
    "const NEW_SESSION_TITLE = '新しい会話'",
    'interface WindowAgentSession',
    'protected readonly sessions: WindowAgentSession[] = []',
    'const workspaceGroups = this.workspaceSessionGroups()',
    'const activeTab = session?.activeTab ?? \'agent\'',
    "data-mode={this.codeMode ? 'code' : activeTab}",
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
    'poiesis-agent-window__code-control',
    'aria-pressed={this.codeMode}',
    '{!this.codeMode && session?.hasUserMessage && (',
    "aria-label='Agent と Results の切り替え'",
    "<span className='poiesis-agent-window__rail-action-label'>New Chat</span>",
    "id='poiesis-results-panel'",
    "role='tabpanel'",
    "role='tablist'",
    "aria-controls='poiesis-agent-panel'",
    "aria-controls='poiesis-results-panel'",
    "aria-controls='poiesis-results-task-panel'",
    'poiesis-results__main',
    'poiesis-results__task-switcher',
    "aria-label='Results HTML キャンバス'",
    "srcDoc={this.resultsDocumentHtml(document.html)}",
    "aria-label='Agent の入力欄'",
    "aria-label='Results の入力欄'",
    "placeholder='次の変更内容や質問を入力…'",
    "placeholder='この結果について質問…'",
    'submitResultsQuestion',
    'protected toggleCodeMode(): void',
    'protected renderCode(): React.ReactNode',
    "import { FormatType, Saveable, SaveableService, SaveReason, StorageService, WidgetManager } from '@theia/core/lib/browser'",
    'protected installCodeEditorSaveShortcut(): void',
    'saveReason: SaveReason.Manual',
    'const dirty = Saveable.isDirty(widget)',
    'protected renderCodeCenterCloseDialog(): React.ReactNode',
    'protected async resolveCodeCenterClose(save: boolean): Promise<void>',
    "className='poiesis-agent-window__code-close-dialog'",
    "role='tab'",
    'protected handleCodeTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, widget: Widget): void',
    'this.codeCenterWidgets[index + 1] ?? this.codeCenterWidgets[index - 1]',
    'protected revealCodeCenterTab(widget: Widget | undefined, focus = false): void',
    'candidate.editor.uri.toString() === uri',
    'protected closeDuplicateCodeWidget(widget: Widget): void',
    "this.iconThemeService.current = 'theia-file-icons'",
    'protected renderExplorerMoreMenu(): React.ReactNode',
    "FileNavigatorCommands.TOGGLE_HIDDEN_FILES.id",
    "FileNavigatorCommands.TOGGLE_AUTO_REVEAL.id",
    "className='poiesis-agent-window__code-sidebar-host'",
    "className='poiesis-agent-window__code-editor-host'",
    "className='poiesis-agent-window__code-activity'",
    "className='poiesis-agent-window__code-terminal-host'",
    "className='poiesis-agent-window__code-terminal-select'",
    "aria-label='Kill Terminal'",
    "aria-label='Close Panel'",
    "aria-label='Toggle Panel'",
    "className='poiesis-agent-window__code-status'",
    "this.renderCodeActivity('files', 'files', 'Explorer')",
    "this.renderCodeActivity('search', 'search', 'Search')",
    "this.renderSearchAction('refresh', 'Refresh Search Results', SearchInWorkspaceCommands.REFRESH_RESULTS.id)",
    "this.renderSearchAction('clear-all', 'Clear Search Results', SearchInWorkspaceCommands.CLEAR_ALL.id)",
    "this.renderSearchAction('collapse-all', 'Collapse All Search Results', SearchInWorkspaceCommands.COLLAPSE_ALL.id)",
    "this.renderCodeActivity('git', 'source-control', 'Source Control')",
    "aria-label='Refresh Source Control'",
    "this.commandService.executeCommand('git.refresh')",
    'protected installCodeSidebarTreeInteractions(host: HTMLDivElement): Disposable',
    'node.setPointerCapture(event.pointerId)',
    'window.getSelection()?.removeAllRanges()',
    "className='poiesis-agent-window__code-git-graph-title'",
    "className='poiesis-agent-window__code-git-graph-host'",
    'this.attachCodeWidget(this.codeGitGraphWidget, this.codeGitGraphHost)',
    "this.renderCodeActivity('extensions', 'extensions', 'Extensions')",
    'onClick={() => void this.openTheiaSettings()}',
    'protected async ensureCodeTerminal(): Promise<void>',
    'protected scheduleCodeWidgetAttachments(): void',
    'protected readonly codeTerminalWidgets: TerminalWidget[] = []',
    'protected async newCodeTerminal(): Promise<TerminalWidget>',
    'void terminal.start()',
    'protected installCodeTerminalShortcut(): void',
    'protected startCodePanelResize(event: React.PointerEvent<HTMLDivElement>): void',
    'protected async ensureCodeExtensionsWidget(): Promise<void>',
    'this.extensionsSearchModel.query = BUILTIN_QUERY',
    'registerCodeWidget(factoryId: string, widget: Widget, pinned = false): void',
    'protected previewCodeCenterWidget?: Widget',
    'protected pinCodeCenterWidget(widget: Widget): void',
    'protected installCodeTabDropTarget(): void',
    'protected codeFilePointerDrag?: {',
    'node.draggable = false',
    "document.addEventListener('pointermove', onPointerMove, true)",
    'protected finishCodeFilePointerDrag(): void',
    'protected async openDraggedCodeFile(rawUri: string): Promise<void>',
    'this.pendingPinnedEditorUris.add(uriKey)',
    'protected isCodeCenterWidget(factoryId: string, widget: Widget): boolean',
    'widget instanceof EditorWidget',
    'factoryId.startsWith(AgentWindowWidget.EDITOR_WIDGET_FACTORY_ID)',
    'protected syncCodeWidgetAttachments(): void',
    'this.attachCodeWidget(this.activeCodeSidebarWidget(), this.codeSidebarHost)',
    'this.attachCodeWidget(this.activeCodeCenterWidget, this.codeEditorHost)',
    'this.attachCodeWidget(this.codeTerminalWidget, this.codeTerminalHost)',
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
    'this.settingsModalVisible = true',
    'protected closeSettings(): void',
    'protected renderSettingsModal(): React.ReactNode',
    'protected renderCustomizeModal(): React.ReactNode',
    "role='dialog'",
    "aria-modal='true'",
    'protected async restorePoiesisSettings(): Promise<void>',
    'protected resultsDocumentHtml(html: string): string',
    'Content-Security-Policy',
    'protected async clearSavedSessionData(): Promise<void>',
    '<strong>Poiesis plugin bundles</strong>',
    "this.renderCliRoleSelector('agent', 'Agent の AI', this.agentCli)",
    "this.renderCliRoleSelector('results', 'Results の AI', this.resultsCli)",
    '成果文書は Results の AI が生成します（未検出時は組み込みテンプレート）。',
    'this.resultsGenerationContext.providerId = cli',
    'this.resultsGenerationContext.providerId = this.resultsCli',
    'providerId: this.agentCli',
    "detection?.status === 'found'",
    'WorkspaceのUser Skillは定義・編集できますが、Agent／Results実行への反映は今後です。',
    '<strong>Bundled Results</strong>',
    '<strong>AI Results</strong>',
    "className={`poiesis-agent-window__rail-action${this.customizeModalVisible ? ' active' : ''}`}",
    "<span className='poiesis-agent-window__rail-action-label'>Customize</span>",
    "root.resolve('.poiesis/skills')",
    'protected parseWorkspaceSkill(',
    'protected async createWorkspaceSkill(): Promise<void>',
    'await this.fileService.createFolder(skillDirectory)',
    'await this.fileService.create(skillUri, this.workspaceSkillTemplate',
    'await this.openWorkspaceSkill(skillUri.toString())',
    'protected async openWorkspaceSkill(rawUri: string): Promise<void>',
    "value={session?.agentDraft ?? ''}",
    'onChange={event => this.setAgentDraft(session?.id, event.currentTarget.value)}',
    'onCompositionEnd={event => this.setAgentDraft(session?.id, event.currentTarget.value)}'
]) {
    assert.ok(agentWidget.includes(marker), `Agent / Results / Code UI is missing ${marker}`);
}
assert.ok(!agentWidget.includes('Saveable.confirmSaveBeforeClose'), 'Editor close must use the Poiesis-owned confirmation dialog');
assert.ok(!agentWidget.includes('branchPickerVisible'), 'The non-functional branch picker must not return');
assert.ok(!agentWidget.includes('<strong>No Repo</strong>'), 'The non-functional No Repo option must not return');
assert.ok(!agentWidget.includes('&& session && !session.selectedResultsTaskId'), 'Results must select the latest terminated Task');
assert.ok(!agentWidget.includes("aria-label='Extensions' onClick={() => this.openCustomize()}"), 'Code Extensions must not open Poiesis Customize');
assert.ok(!agentWidget.includes("aria-label='Settings' onClick={() => this.openSettings()}"), 'Code Settings must not open Poiesis Settings');
assert.ok(!agentWidget.includes('VS Code built-in extensions'), 'Poiesis Customize must not manage Code extensions');
const settingsModalSource = agentWidget.match(/protected renderSettingsModal\(\): React\.ReactNode \{[\s\S]*?\n    protected renderCustomizeModal/)?.[0] ?? '';
assert.ok(!settingsModalSource.includes('poiesis-settings-skills'), 'Settings modal must not contain Skills');
assert.ok(!settingsModalSource.includes('poiesis-settings-plugins'), 'Settings modal must not contain Plugins');
assert.ok(!agentWidget.includes('<h2>Hooks</h2>'), 'Customize must not advertise unsupported Hooks');
for (const dummyChrome of [
    '<small>poiesis / main</small>',
    '<strong>poiesis</strong>',
    '認証を Redis 方式へ変更',
    "<span className='codicon codicon-settings-gear' title='設定'"
]) {
    assert.ok(!agentWidget.includes(dummyChrome), `Dummy Agent chrome must not return: ${dummyChrome}`);
}
assert.ok(agentWidget.includes('@inject(GlobalStorageService)'), 'Window sessions must use the global storage boundary');
assert.ok(agentWidget.includes('this.globalStorageService.setData'), 'Window sessions must persist across workspaces');
for (const marker of [
    'MAX_PERSISTED_TASKS_PER_SESSION = 10',
    'MAX_PERSISTED_RESULTS_HTML_CHARS = 300_000',
    'taskIds: string[]',
    'tasks?: ExecutionTask[]',
    'resultsDocuments?: TaskResultDocument[]',
    'this.taskService.restore',
    'this.resultsService.restore',
    'protected persistedTasks(session: WindowAgentSession)',
    "failure: { summary: 'アプリ終了により中断されました' }"
]) {
    assert.ok(agentWidget.includes(marker), `Session artifact persistence is missing ${marker}`);
}
assert.ok(!agentWidget.includes("defaultValue={session?.agentDraft ?? ''}"), 'Agent composer must have one controlled source of truth');
assert.ok(!agentWidget.includes('window.localStorage'), 'The Agent widget must not write browser storage directly');
assert.ok(!agentWidget.includes('sessionStorage'), 'Window sessions must survive a browser session');
for (const marker of [
    'class BrowserGlobalStorageService',
    'window.localStorage',
    '`poiesis:global:${key}`',
    'getWorkspaceData<T>(key: string)',
    "storageKey.startsWith('theia:')"
]) {
    assert.ok(globalStorageService.includes(marker), `Global session storage is missing ${marker}`);
}
const railSource = agentWidget.match(
    /protected renderRail\(\): React\.ReactNode \{[\s\S]*?\n    protected readonly setSessionSearchInput/
)?.[0];
assert.ok(railSource, 'Agent rail render source is missing');
const newChatPosition = railSource.indexOf("<span className='poiesis-agent-window__rail-action-label'>New Chat</span>");
const searchPosition = railSource.indexOf("<span className='poiesis-agent-window__rail-action-label'>Search</span>");
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
    'protected readonly expandedWorkspaceGroups = new Set<string>()',
    'protected toggleWorkspaceGroup(groupKey: string): void',
    "<div className='poiesis-agent-window__rail-heading'>",
    '<span>Workspaces</span>',
    'poiesis-agent-window__workspace-group',
    '<small>Local · {group.branch}</small>',
    "className='poiesis-agent-window__session-title'",
    'poiesis-agent-window__session-meta',
    'protected sessionMeta(session: WindowAgentSession): string',
    'protected togglePinnedSession(sessionId: string): void',
    'protected beginSessionRename(sessionId: string): void',
    'protected async archiveSession(sessionId: string): Promise<void>',
    'protected async deleteSession(sessionId: string): Promise<void>',
    'protected restoreSession(sessionId: string, select = false): void',
    "aria-label='サイドバーの幅を変更'",
    'protected startRailResize(event: React.PointerEvent<HTMLDivElement>): void',
    'protected persistWindowState(): Promise<void>',
    'protected windowStatePersistence: Promise<void> = Promise.resolve()',
    'this.windowStatePersistence = this.windowStatePersistence',
    'this.restorePoiesisSettings().then(() => this.initializeSessions())',
    'protected sessionsInitialized = false',
    'protected findSessionForTask(task: ExecutionTask)',
    'protected canonicalWorkspaceUri(workspaceUri: string | undefined)',
    'protected sameWorkspaceUri(left: string | undefined, right: string | undefined)',
    '? this.canonicalWorkspaceUri(candidate.workspaceUri)',
    'await this.persistWindowState()',
    'ownerSessionId: session.id',
    'protected async recordPreSpawnFailure(',
    'this.taskService.failBeforeStart(session.id, request, { summary, details })',
    'protected async restoreWindowState(): Promise<boolean>',
    'protected async loadGlobalWindowState()',
    'protected mergePersistedWindowStates(',
    'SESSION_MIGRATION_MARKER_KEY',
    'GLOBAL_SESSION_STORAGE_KEY',
    'protected async openRepository(): Promise<void>',
    'protected renderWorkspacePicker(): React.ReactNode',
    "aria-label='Workspaceを開く'",
    "aria-label='Workspaceを検索'",
    'await this.openFolderExplorer()',
    'this.workspaceService.open(folder, { preserveWindow: true })',
    "runTarget: 'local'",
    "className='poiesis-agent-window__new-agent-context'",
    "aria-label='Repositoryを選択'",
    "aria-label='Repositoryを検索'",
    '<span>Run on · This Computer</span>',
    'protected repositoryChoices()',
    'protected selectRepository(session: WindowAgentSession, workspaceUri: string): void',
    'protected async openFolderExplorer(session?: WindowAgentSession, createFolder = false): Promise<void>',
    'onClick={() => void this.openFolderExplorer(session, true)}',
    'this.folderExplorerService.browse',
    'protected renderFolderExplorer(): React.ReactNode',
    "aria-label='フォルダーを選択'",
    'await this.ensureProviderSession(session, false, true)',
    'onClick={() => this.openSettings()}'
]) {
    assert.ok(agentWidget.includes(marker), `Agent rail is missing ${marker}`);
}
assert.ok(!agentWidget.includes('FileDialogService'), 'Poiesis must not open stock Theia file dialogs');
assert.ok(!agentWidget.includes('showOpenDialog'), 'Folder selection must use the Poiesis explorer');
assert.ok(!railSource.includes('<small>現在</small>'), 'Selected sessions must use quiet age metadata, not a current badge');
assert.ok(
    (agentWidget.match(/onClick=\{\(\) => this\.openSettings\(\)\}/g)?.length ?? 0) >= 2,
    'Settings controls must open the Poiesis-owned settings modal'
);
assert.ok(!agentWidget.includes('poiesis-agent-window__composer-tools'), 'Deferred composer tools must not be shown');
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
    'poiesis-agent-window__theia-host'
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
for (const marker of [
    '#poiesis-window-host',
    '.theia-preload.theia-hidden',
    'pointer-events: none',
    '--poiesis-chrome-bg: #181918',
    '--poiesis-chrome-panel: #1d1e1c',
    'grid-template-columns: var(--poiesis-rail-width, 258px) minmax(0, 1fr)',
    '--poiesis-chrome-muted: #92948d',
    '--poiesis-results-muted: #9aa5bd',
    ':is(button, input, textarea, select, [tabindex]):focus-visible',
    'outline: 2px solid var(--poiesis-focus-ring, #c28b60)',
    ".poiesis-agent-window__content[data-mode='code']",
    ".poiesis-agent-window__content:not([data-mode='code'])[data-rail-collapsed='true']",
    ".poiesis-agent-window__rail[data-collapsed='true']",
    '.poiesis-agent-window__session-search',
    '.poiesis-agent-window__workspace-group',
    '.poiesis-agent-window__workspace-picker',
    '.poiesis-agent-window__session-meta',
    '.poiesis-agent-window__session-menu',
    '.poiesis-agent-window__session-rename',
    '.poiesis-agent-window__archived-toggle',
    '.poiesis-agent-window__rail-resize-handle',
    '.poiesis-agent-window__viewport',
    '.poiesis-agent-window__code',
    '.poiesis-agent-window__code-activity',
    '.poiesis-agent-window__code-sidebar-title',
    '.poiesis-agent-window__code-sidebar-host',
    '.poiesis-agent-window__code-git-graph-title',
    '.poiesis-agent-window__code-git-graph-host',
    '.poiesis-agent-window__code-source-control #scm-action-button-widget',
    'user-select: none',
    '.poiesis-agent-window__code-editor-host',
    '.poiesis-agent-window__code-close-dialog',
    '.poiesis-agent-window__code-editor-tab.dirty',
    '.poiesis-agent-window__code-editor-tab-name',
    '.poiesis-agent-window__code-editor-tabs.drop-target',
    'font-style: italic',
    'font-weight: 600',
    'flex: 0 0 auto',
    'max-width: 220px',
    '.poiesis-agent-window__code-terminal-host',
    '.poiesis-agent-window__code-panel',
    '.poiesis-agent-window__code-panel-resize',
    '.poiesis-agent-window__code-terminal-select',
    '.poiesis-code-panel-resizing',
    '.poiesis-agent-window__code-status',
    '.poiesis-agent-window__app-page',
    '.poiesis-agent-window__app-nav',
    '.poiesis-agent-window__customize-card',
    '.poiesis-customize-modal',
    '.poiesis-customize-modal__skill-card',
    '.poiesis-customize-modal__new-skill',
    '.poiesis-agent-window__switch',
    '.poiesis-agent-window__composer',
    '.poiesis-agent-window__new-agent-empty',
    '.poiesis-agent-window__new-agent-context',
    '.poiesis-agent-window__content--initializing',
    '.poiesis-agent-window__initializing',
    '.poiesis-agent-window__repository-picker',
    '.poiesis-agent-window__context-pill',
    'align-self: end',
    '.poiesis-results__main',
    'grid-template-rows: minmax(0, 1fr) auto auto',
    '.poiesis-results__task-switcher',
    'border-left: 1px solid var(--poiesis-chrome-line)'
]) {
    assert.ok(agentStyles.includes(marker), `Agent chrome styles are missing ${marker}`);
}
assert.match(
    agentStyles,
    /\.poiesis-agent-window__rail-action\s*\{[^}]*font-size:\s*12px;/,
    'New Chat and Search text must match the sidebar spec'
);
assert.match(
    agentStyles,
    /\.poiesis-agent-window__rail-heading\s*\{[^}]*font-size:\s*12px;/,
    'Workspaces text must match the sidebar spec'
);
assert.match(agentStyles, /\.poiesis-agent-window__content\s*\{[\s\S]*?font-size:\s*13px;[\s\S]*?zoom:\s*var\(--poiesis-ui-font-scale, 1\);/,
    'Poiesis chrome must use the raised default scale');
assert.match(agentStyles, /\.poiesis-agent-window__message,[\s\S]*?font-size:\s*14px;/,
    'Agent conversation text must be at least 14px');
assert.ok(!/font-size:\s*(?:8|9|10|11)px;/.test(agentStyles), 'Poiesis chrome text must not fall below the 12px CSS floor');
assert.ok(!agentStyles.includes('.poiesis-agent-window__composer-tools'), 'Deferred composer tool styles must not remain');
assert.match(
    agentStyles,
    /\.poiesis-agent-window__send \.codicon,[\s\S]*?color:\s*#222320;/,
    'Send icons must contrast their light button background'
);
assert.match(
    agentStyles,
    /\.poiesis-agent-window__viewport\s*\{[^}]*height:\s*100%;/,
    'Code viewport must have a definite height'
);
assert.match(
    agentStyles,
    /\.poiesis-agent-window__code\s*\{[^}]*height:\s*100%;/,
    'Code layout must have a definite height'
);
assert.match(
    agentStyles,
    /\.poiesis-agent-window__code-sidebar-host,\s*\.poiesis-agent-window__code-git-graph-host,\s*\.poiesis-agent-window__code-editor-host,\s*\.poiesis-agent-window__code-terminal-host\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/,
    'Code widget hosts must fill their minmax rows without collapsing'
);
assert.match(
    agentStyles,
    /\.poiesis-agent-window__code-editor\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/,
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
    'this.widgetManager.getOrCreateWidget(AgentWindowWidget.SEARCH_WIDGET_FACTORY_ID)',
    'this.widgetManager.getOrCreateWidget(AgentWindowWidget.GIT_WIDGET_FACTORY_ID)',
    'this.widgetManager.getOrCreateWidget(AgentWindowWidget.GIT_GRAPH_WIDGET_FACTORY_ID)',
    'for (const editor of this.editorManager.all)',
    'this.agentWindowWidget.registerCodeWidget(factoryId, widget)',
    'this.agentWindowWidget.registerCodeWidget(factoryId, editor, true)',
    "host.id = 'poiesis-window-host'",
    'document.body.appendChild(host)',
    'Widget.attach(this.agentWindowWidget, host)',
    'this.hostResizeObserver = new ResizeObserver',
    'MessageLoop.sendMessage(this.agentWindowWidget, new Widget.ResizeMessage(width, height))',
    'this.hostResizeObserver.observe(host)',
    'this.hostResizeObserver?.disconnect()'
]) {
    assert.ok(agentContribution.includes(marker), `Poiesis-owned Agent host is missing ${marker}`);
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
    'class PoiesisFrontendApplication extends FrontendApplication',
    'protected override attachShell(_host: HTMLElement): void'
]) {
    assert.ok(poiesisFrontendApplication.includes(marker), `Poiesis frontend shell policy is missing ${marker}`);
}
assert.ok(!poiesisFrontendApplication.includes('super.attachShell'), 'Poiesis must not delegate ApplicationShell attachment');
assert.ok(!poiesisFrontendApplication.includes('Widget.attach'), 'Poiesis frontend must not attach ApplicationShell directly');
assert.ok(moduleSource.includes('rebind(FrontendApplication).to(PoiesisFrontendApplication).inSingletonScope()'));
for (const marker of [
    "import { ThemeService } from '@theia/core/lib/browser/theming'",
    'this.themeService.onDidColorThemeChange',
    'void this.preferenceService.ready.then',
    "this.themeService.setCurrentTheme('dark', false)"
]) {
    assert.ok(designShotContribution.includes(marker), `Poiesis startup theme lock is missing ${marker}`);
}
assert.ok(
    !designShotContribution.includes('getDesignVariant'),
    'Poiesis startup theme lock must also run outside design-shot variants'
);
assert.ok(moduleSource.includes('bind(FrontendApplicationContribution).toService(DesignShotContribution)'));
assert.ok(!agentWidget.includes('this.title.label'), 'Agent / Results must not define a Theia tab title');
assert.ok(!agentWidget.includes('this.title.closable'), 'Poiesis outer content must not opt into closable Theia tab chrome');
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
    firstCompletion.includes('Code does not host ApplicationShell; Poiesis hosts Files/Search/Git/Editor/Terminal widgets in its own Cursor-style chrome.'),
    'FIRST-COMPLETION must state the Code widget-hosting boundary'
);
for (const marker of ['AgentProvider', 'Codex CLI', 'TaskService', 'ResultsSkill', 'Agent / Results / Code']) {
    assert.ok(readme.includes(marker), `README is missing ${marker}`);
}

console.log('Source contract validation passed.');
