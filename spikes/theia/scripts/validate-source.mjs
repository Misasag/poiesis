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
const safeMarkdown = await read('agent-window/src/browser/safe-markdown.ts');
const moduleSource = await read('agent-window/src/browser/agent-window-frontend-module.ts');
const poiesisFrontendApplication = await read('agent-window/src/browser/poiesis-frontend-application.ts');
const poiesisWorkspaceTrustService = await read('agent-window/src/browser/poiesis-workspace-trust-service.ts');
const poiesisFileResourceResolver = await read('agent-window/src/browser/poiesis-file-resource-resolver.ts');
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
const workspaceSkillService = await read('agent-window/src/browser/workspace-skill-service.ts');
const cliDetector = await read('agent-window/src/node/cli-detector.ts');
const cliProviderRegistry = await read('agent-window/src/node/cli-provider-registry.ts');
const knownCliRegistry = await read('agent-window/src/node/known-cli-registry.ts');
const hiddenProcess = await read('agent-window/src/node/hidden-process.ts');
const skillBundleContract = await read('agent-window/src/common/skill-bundle.ts');
const runtimeServer = await read('agent-window/src/node/agent-runtime-server.ts');
const electronSmoke = await read('scripts/smoke-electron.mjs');
const markdownSmoke = await read('scripts/smoke-markdown.mjs');
const round15Smoke = await read('scripts/smoke-round15-browser.mjs');
const round16Smoke = await read('scripts/smoke-round16-console.mjs');
const round16Watcher = await read('scripts/watch-visible-console-windows.ps1');
const round17Smoke = await read('scripts/smoke-round17-browser.mjs');
const electronFrontendModule = await read('agent-window/src/electron-browser/agent-window-electron-frontend-module.ts');
const electronWindowControls = await read('agent-window/src/electron-browser/window-controls.tsx');
const electronWindowStyles = await read('agent-window/src/electron-browser/window-controls.css');
const iconBuildScript = await read('scripts/build-icon.mjs');
const appIcon = await readFile(resolve(root, 'electron-app/resources/poiesis.ico'));
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
assert.equal(electronPackage.theia.frontend.config.electron.windowOptions.icon, 'resources/poiesis.ico');
assert.equal(electronPackage.theia.frontend.config.electron.windowOptions.minWidth, 1024);
assert.equal(electronPackage.theia.frontend.config.electron.windowOptions.minHeight, 600);
assert.equal(appIcon.readUInt16LE(2), 1, 'Poiesis app icon must be an ICO image');
assert.equal(appIcon.readUInt16LE(4), 7, 'Poiesis app icon must contain seven sizes');
assert.ok(iconBuildScript.includes('const sizes = [16, 24, 32, 48, 64, 128, 256]'), 'App icon build sizes are missing');
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
    'modalWindowChecks',
    'assertSettingsToggleKeepsLayout',
    'assertNativeMinimumWindowSize',
    'Electron allowed an OS resize below 1024x600',
    'POIESIS_SETTINGS_WINDOW_ONLY',
    'ELECTRON_SETTINGS_WINDOW_SMOKE_RESULT=',
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
assert.ok(resultsQuestionProtocol.includes('model?: string'), 'Results question scope must carry its selected model');
assert.ok(resultsQuestionProtocol.includes('history?: ResultsQuestionHistoryEntry[]'), 'Results question scope must carry recent Q&A history');
assert.ok(resultsQuestionService.includes('return this.server.ask(question, scope)'), 'Results question browser proxy is missing');
for (const marker of [
    'this.resultsQuestionService.ask(question, {',
    'workspaceUri: session.workspaceUri',
    'providerId: this.resultsCli',
    'model: this.resultsModel.trim() || undefined',
    "status: 'sending'",
    "status: 'failed'",
    'this.taskService.recordResultsQuestion(taskId',
    'history: (task.resultsQuestions ?? []).slice(-6)',
    'question.length > 4_000',
    "currentNotice?.status === 'sending'"
]) {
    assert.ok(agentWidget.includes(marker), `Results question widget wiring is missing ${marker}`);
}
assert.ok(!agentWidget.includes('this.resultsService.answer('), 'Bundled Results skill must not answer questions');
assert.ok(!resultsSkill.includes('async answer('), 'Bundled Results skill must only generate documents');
for (const marker of [
    'this.resolveWorkspace(scope.workspaceUri)',
    "this.providerRegistry.resolve('results', scope.providerId, scope.model)",
    "resource.scheme !== 'file'",
    "'--sandbox', 'read-only'",
    "'--permission-mode', 'plan'",
    "'--tools='",
    "provider.id === 'claude'",
    "provider.id === 'grok'",
    "['-m', provider.model]",
    "['--model', provider.model]",
    'this.runs.has(scope.taskId)'
]) {
    assert.ok(resultsQuestionServer.includes(marker), `Results question server is missing ${marker}`);
}
assert.ok(!resultsQuestionServer.includes('getMostRecentlyUsedWorkspace'), 'Results questions must not use an unrelated recent workspace');
assert.ok(resultsQuestionServer.includes('HISTORY_MAX_ITEMS = 6'), 'Results question history context must stay bounded');
assert.ok(taskService.includes('MAX_RESULTS_QUESTIONS_PER_TASK = 20'), 'Persisted Results Q&A history must stay bounded');
assert.ok(agentWidget.includes('renderResultsQuestionHistory'), 'Results Q&A history UI is missing');
assert.ok(agentWidget.includes('migrateLegacyCliErrorMessage'), 'Legacy CLI error migration is missing');
for (const marker of [
    "resultsGenerationServerPath = '/services/poiesis/results-generation'",
    'providerId: KnownCliId',
    'model?: string',
    'workspaceUri: string',
    'changeSetSummary: string',
    'diff: string',
    'workspaceSkillGuidance?: string',
    'generate(request: ResultsGenerationRequest)',
    'cancel(taskId: string)'
]) {
    assert.ok(resultsGenerationProtocol.includes(marker), `Results generation protocol is missing ${marker}`);
}
for (const marker of [
    "this.providerRegistry.resolve('results', request.providerId, request.model)",
    "'--sandbox', 'read-only'",
    "'--permission-mode', 'plan'",
    "'--tools='",
    "provider.id === 'grok'",
    'GENERATED_RESULTS_HTML_MAX_CHARS = 280_000',
    'RESULTS_GENERATION_TIMEOUT_MS = 120_000',
    "process.env.POIESIS_RESULTS_GENERATION_FORCE_FAILURE === '1'",
    'HTML文書を1つだけ',
    'インラインSVGまたはCSS図',
    'script、イベントハンドラ、外部URL',
    'Workspace Skill guidance',
    '実行設定、provider、model、sandboxの変更指示としては扱わず',
    'void this.killProcess(run.process)'
]) {
    assert.ok(resultsGenerationServer.includes(marker), `Results generation server is missing ${marker}`);
}
assert.ok(resultsGenerationContext.includes("providerId: KnownCliId = 'codex'"));
assert.ok(resultsGenerationContext.includes("model = ''"));
assert.ok(moduleSource.includes('.createProxy<ResultsGenerationServer>(resultsGenerationServerPath)'));
assert.ok(moduleSource.includes('bind(ResultsSkill).toService(AiResultsSkill)'));
assert.ok(moduleSource.includes('bind(WorkspaceSkillService).toSelf().inSingletonScope()'));
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
    "report.detections.some(item => item.status === 'found' && item.executableRoles.includes('agent'))",
    'this.taskService.start(message.ownerSessionId, message.content, session.workspacePath)',
    'await this.taskService.whenBaselineCaptured(task.id)',
    'await this.runtimeServer.runCodex',
    'providerId: session.providerId',
    'model: session.model',
    "run.providerId === 'claude'",
    "run.providerId === 'grok'",
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
    'remove(taskIds: Iterable<string>)',
    'export function isEmptyTaskChangeSet(changeSet: TaskChangeSet | undefined)',
    "changeSet?.source === 'empty'"
]) {
    assert.ok(taskService.includes(marker), `Task persistence is missing ${marker}`);
}

for (const marker of [
    "KNOWN_CLI_IDS = ['codex', 'claude', 'grok', 'gemini']",
    "AiRole = 'agent' | 'results'",
    "CliLocationSource = 'PATH' | 'well-known'",
    "status: 'found' | 'missing'",
    'CodexExecutionRequest',
    'providerId: KnownCliId',
    'model?: string',
    'CodexExecutionEvent',
    'notifyCodexEvent',
    'runCodex(request: CodexExecutionRequest)',
    'cancelCodex(executionId: string)'
]) {
    assert.ok(runtimeProtocol.includes(marker), `Runtime protocol is missing ${marker}`);
}
for (const marker of [
    "process.env.PATH",
    "process.env.POIESIS_DISABLE_CLI_DETECTION === '1'",
    'lastReport',
    "status: 'found'",
    "status: 'missing'",
    'probeVersion(definition, candidate.path)',
    'spawnHiddenCli(definition.id, command, definition.versionProbe)'
]) {
    assert.ok(cliDetector.includes(marker), `CliDetector is missing ${marker}`);
}
for (const marker of [
    'interface KnownCliDefinition',
    'executableNames: readonly string[]',
    'wellKnownLocations: readonly string[]',
    'versionProbe: readonly string[]',
    "id: 'codex'",
    "id: 'claude'",
    "id: 'grok'",
    "id: 'gemini'",
    "join(userProfile, '.grok', 'bin', 'grok.exe')",
    "{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }",
    "{ id: 'fable', label: 'fable (既定)' }",
    "{ id: 'haiku', label: 'haiku' }"
]) {
    assert.ok(knownCliRegistry.includes(marker), `Known CLI registry is missing ${marker}`);
}
assert.ok(backendModule.includes('RpcConnectionHandler'));
assert.ok(backendModule.includes('CliDetector'));
assert.ok(backendModule.includes('CliProviderRegistry'));
assert.ok(backendModule.includes('server.setClient(client)'));
for (const marker of [
    'knownCliDefinitions()',
    'definition?.executableRoles.includes(role)',
    'this.cliDetector.recordedReport',
    'class CliProviderRegistry',
    'model: selectedModel || undefined'
]) {
    assert.ok(cliProviderRegistry.includes(marker), `CLI provider registry is missing ${marker}`);
}

for (const marker of [
    "'exec'",
    "'--sandbox', 'workspace-write'",
    "'-C', resolvedWorkspace",
    'prompt',
    'spawnHiddenCli(providerId, command, args, { cwd, env })',
    "child.stdout.on('data'",
    "child.stderr.on('data'",
    "type: 'output'",
    "type: 'exit'",
    'killHiddenProcessTree(child)',
    "process.env.POIESIS_AGENT_FORCE_PRESPAWN_FAILURE === '1'",
    'const testReply = process.env.POIESIS_AGENT_TEST_REPLY',
    "item: { type: 'agent_message', text: testReply }",
    'const resolvedWorkspace = await this.resolveWorkspace(workspacePath)',
    "this.providerRegistry.resolve('agent', providerId, model)",
    "provider.id === 'claude'",
    "provider.id === 'grok'",
    "'--permission-mode', 'acceptEdits'",
    "'--output-format', 'stream-json'",
    "'--safe-mode'",
    "['-m', provider.model]",
    "['--model', provider.model]",
    'const snapshot = await this.captureWorkspace(resolvedWorkspace)'
]) {
    assert.ok(runtimeServer.includes(marker), `Codex runtime is missing ${marker}`);
}
for (const source of [runtimeServer, resultsQuestionServer, resultsGenerationServer, cliDetector]) {
    assert.ok(!source.includes('shell: true'), 'Product child-process sites must not use a shell fallback');
    assert.ok(!source.includes('cmd.exe'), 'Product child-process sites must not launch cmd.exe');
    assert.ok(!source.includes('ComSpec'), 'Product child-process sites must not launch a command interpreter');
}
for (const marker of [
    'resolveKnownCliInvocation(providerId, command, args)',
    "providerId === 'claude'",
    "'@anthropic-ai', 'claude-code', 'bin', 'claude.exe'",
    "providerId === 'codex'",
    "'@openai', 'codex', 'bin', 'codex.js'",
    'nodeExecutable(shimDirectory)',
    'windowsHide: true',
    'shell: false',
    "spawn('taskkill.exe'",
    "stdio: 'ignore'"
]) {
    assert.ok(hiddenProcess.includes(marker), `Hidden process boundary is missing ${marker}`);
}
for (const source of [runtimeServer, resultsQuestionServer, resultsGenerationServer]) {
    assert.ok(source.includes('spawnHiddenCli(providerId, command, args, { cwd, env })'));
    assert.ok(source.includes('return killHiddenProcessTree(child)'));
}
assert.ok(runtimeServer.includes('{ cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }'), 'Git calls must stay hidden');
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
    'this.generationTokens.get(task.id) !== generationToken',
    'isEmptyTaskChangeSet(task.changeSet)',
    '!isEmptyTaskChangeSet(task.changeSet)'
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
    'readonly enabled: boolean',
    'interface SkillPromptContribution',
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
    '`skill.md` bundleも`SkillBundle`契約へ適合する',
    '1 Skillあたり8,000文字、合計24,000文字',
    'provider、model、sandbox、runtime configを変更する権限を与えない'
]) {
    assert.ok(skillsContract.includes(marker), `Skills contract document is missing ${marker}`);
}
assert.ok(skillsContract.includes('`builtin.ai-results`'), 'Skills contract must describe the AI Results bundle');

for (const marker of [
    "type AgentWindowTab = 'agent' | 'results'",
    "type CodeSidebarTab = 'files' | 'search' | 'git' | 'extensions'",
    'protected codeMode = false',
    'protected customizeViewVisible = false',
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
    "data-mode={this.codeMode ? 'code' : this.customizeViewVisible ? 'customize' : activeTab}",
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
    "import { FormatType, open, OpenerService, Saveable, SaveableService, SaveReason, StorageService, WidgetManager } from '@theia/core/lib/browser'",
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
    'protected renderCustomizeView(): React.ReactNode',
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
    'this.resultsGenerationContext.model = defaultModel',
    'this.resultsGenerationContext.providerId = this.resultsCli',
    'providerId: this.agentCli',
    'model: this.agentModel.trim() || undefined',
    'detection.executableRoles.includes(role)',
    '検出済み（実行可）',
    '検出済み（実行対応は今後）',
    'protected setRoleModelChoice(',
    'protected setRoleModel(',
    'version: 3',
    '有効なAgent Skillは次のTaskから実装指示へ加わり',
    '組み込みテンプレートへのfallback時はResults Skillの追加指示を使いません。',
    '<strong>Bundled Results</strong>',
    '<strong>AI Results</strong>',
    "className={`poiesis-agent-window__rail-action${this.customizeViewVisible ? ' active' : ''}`}",
    "<span className='poiesis-agent-window__rail-action-label'>Customize</span>",
    'this.workspaceSkillService.list(root)',
    'protected async setWorkspaceSkillEnabled(',
    'protected async createWorkspaceSkill(): Promise<void>',
    'await this.fileService.createFolder(skillDirectory)',
    'await this.fileService.create(skillUri, content)',
    'await this.workspaceSkillService.setEnabled(skillUri.toString(), true)',
    'await this.openWorkspaceSkillInline(this.workspaceSkillService.parse',
    'protected async openWorkspaceSkillInline(skill: WorkspaceSkillDefinition): Promise<void>',
    'protected async saveWorkspaceSkill(): Promise<void>',
    'protected installWorkspaceSkillSaveShortcut(): void',
    'protected requestCloseWorkspaceSkill(): void',
    'protected async openWorkspaceSkillInCode(rawUri: string): Promise<void>',
    'const PoiesisSelect = (',
    "role='combobox'",
    "role='listbox'",
    "role='option'",
    'ReactDOM.createPortal(',
    'protected async openCodeFile(rawUri: string): Promise<void>',
    "message.role === 'agent'",
    'this.renderMarkdown(entry.answer ?? \'\')',
    'renderSafeMarkdown(content, workspaceUri)',
    'POIESIS_FILE_LINK_ATTRIBUTE',
    'open(this.openerService, new URI(externalUri))',
    "value={session?.agentDraft ?? ''}",
    'const PoiesisTextInput = (',
    'const PoiesisTextArea = (',
    'if (!composing.current && !nativeEvent.isComposing)',
    'onValueChange={value => this.setAgentDraft(session?.id, value)}',
    'onValueChange={value => selectedTask && this.setResultsDraft(selectedTask.id, value)}',
    'このタスクにファイル変更はありません。会話の返答は Agent タブにあります。',
    'Results への質問は、成果文書があるタスクで利用できます。',
    'protected async deleteResultsTask(taskId: string): Promise<void>',
    'this.resultsService.remove([taskId])',
    'this.taskService.remove([taskId])'
]) {
    assert.ok(agentWidget.includes(marker), `Agent / Results / Code UI is missing ${marker}`);
}

for (const marker of [
    'WORKSPACE_SKILL_INSTRUCTION_MAX_CHARS = 8_000',
    'WORKSPACE_SKILLS_TOTAL_MAX_CHARS = 24_000',
    "root.resolve('.poiesis/skills')",
    "content.slice(frontmatter[0].length).trim()",
    "skills = await this.list(new URI(workspaceUri))",
    'if (!skill.enabled)',
    'Workspace skills (user-defined instructions)',
    'setEnabled(skillDocumentUri: string, enabled: boolean)'
]) {
    assert.ok(workspaceSkillService.includes(marker), `Workspace Skill execution boundary is missing ${marker}`);
}
assert.ok(cliProvider.includes("buildPrompt(session.workspaceUri, 'agent')"));
assert.ok(cliProvider.includes('this.implementerPrompt(message.content, workspaceSkills.content)'));
assert.ok(resultsSkill.includes("buildPrompt(workspace.resource.toString(), 'results')"));
assert.ok(resultsSkill.includes('workspaceSkillGuidance: workspaceSkills.content || undefined'));
for (const marker of [
    'Round 15 Agent marker',
    'Round 15 Results headings',
    "assert(enabledRun.lastMessage.startsWith('[SKILL-OK]')",
    "assert(!disabledRun.lastMessage.startsWith('[SKILL-OK]')",
    "assert(resultsHeading.startsWith('◇')",
    'persistedEnablement',
    'restoredDisabled',
    'layout.clipped.length === 0'
]) {
    assert.ok(round15Smoke.includes(marker), `Round 15 live regression is missing ${marker}`);
}
for (const marker of [
    "{ id: 'codex', model: 'gpt-5.6-luna' }",
    "{ id: 'claude', model: 'haiku' }",
    "{ id: 'grok', model: '' }",
    "spawn('powershell.exe'",
    'windowsHide: true',
    'shell: false',
    "'-PollMilliseconds', '100'",
    'visibleConsoleWindows: observations.length',
    'assert(observations.length === 0'
]) {
    assert.ok(round16Smoke.includes(marker), `Round 16 console smoke is missing ${marker}`);
}
assert.equal(rootPackage.scripts['smoke:round17'], 'node scripts/smoke-round17-browser.mjs');
for (const marker of [
    'codexRolloutFiles()',
    "document.querySelector('.poiesis-results__state.no-change')",
    "assert(noChange.iframeCount === 0",
    "assert(noChange.composerCount === 0",
    "process.env.POIESIS_ROUND17_REAL_AGENT === '1'",
    'const expectedCodexRollouts = realAgent ? 1 : 0',
    'Document-bearing task deletion did not persist',
    'No-change task deletion did not persist',
    'width: 1024, height: 600'
]) {
    assert.ok(round17Smoke.includes(marker), `Round 17 live regression is missing ${marker}`);
}
for (const marker of [
    "@('powershell', 'pwsh', 'cmd', 'conhost')",
    '[PoiesisWindowWatcher]::EnumWindows',
    '[PoiesisWindowWatcher]::IsWindowVisible',
    'Start-Sleep -Milliseconds $PollMilliseconds',
    'ROUND16_WATCHER_READY',
    'ROUND16_WATCHER_DONE'
]) {
    assert.ok(round16Watcher.includes(marker), `Round 16 visible-window watcher is missing ${marker}`);
}
for (const marker of [
    'html: false',
    'linkify: false',
    'DOMPurify.sanitize',
    "ALLOWED_TAGS: ['a', 'blockquote', 'br', 'code'",
    "workspace.isEqualOrParent(candidate, false)",
    "replaceWithCode(anchor, decodedHref(href))",
    'linkBareWorkspacePaths(host, workspace)'
]) {
    assert.ok(safeMarkdown.includes(marker), `Safe Agent markdown is missing ${marker}`);
}
assert.equal(rootPackage.scripts['smoke:markdown'], 'node scripts/smoke-markdown.mjs');
assert.equal(rootPackage.scripts['smoke:round13'], 'node scripts/smoke-round13-browser.mjs');
assert.equal(rootPackage.scripts['smoke:round14'], 'node scripts/smoke-round14-browser.mjs');
for (const marker of [
    'rebind(FileResourceResolver).toService(PoiesisFileResourceResolver)',
    "import { PoiesisFileResourceResolver } from './poiesis-file-resource-resolver'"
]) {
    assert.ok(moduleSource.includes(marker), `Poiesis file dialog binding is missing ${marker}`);
}
for (const marker of [
    'class PoiesisFileResourceResolver extends FileResourceResolver',
    'このファイルはバイナリ、または未対応のエンコーディングです。開きますか？',
    "ok: '開く'",
    "cancel: 'キャンセル'",
    '外部で変更されたファイル'
]) {
    assert.ok(poiesisFileResourceResolver.includes(marker), `Poiesis file dialog policy is missing ${marker}`);
}
for (const marker of [
    'body .lm-Widget.dialogOverlay',
    'body .lm-Widget.dialogOverlay .dialogBlock',
    'body .lm-Widget.dialogOverlay .dialogControl .theia-button.main'
]) {
    assert.ok(agentStyles.includes(marker), `Poiesis stock-dialog safety-net style is missing ${marker}`);
}
for (const marker of [
    'userStayedPlain',
    'javascriptAnchorCount',
    'outsideIsCode',
    "getAttribute('data-poiesis-file-uri')",
    "textContent?.trim() === 'SCRATCH-DEMO.md'"
]) {
    assert.ok(markdownSmoke.includes(marker), `Agent markdown smoke is missing ${marker}`);
}
assert.ok(!agentWidget.includes('Saveable.confirmSaveBeforeClose'), 'Editor close must use the Poiesis-owned confirmation dialog');
assert.ok(!agentWidget.includes('branchPickerVisible'), 'The non-functional branch picker must not return');
assert.ok(!agentWidget.includes('<strong>No Repo</strong>'), 'The non-functional No Repo option must not return');
assert.ok(!agentWidget.includes('&& session && !session.selectedResultsTaskId'), 'Results must select the latest terminated Task');
assert.ok(!agentWidget.includes("aria-label='Extensions' onClick={() => this.openCustomize()}"), 'Code Extensions must not open Poiesis Customize');
assert.ok(!agentWidget.includes("aria-label='Settings' onClick={() => this.openSettings()}"), 'Code Settings must not open Poiesis Settings');
assert.ok(!agentWidget.includes('VS Code built-in extensions'), 'Poiesis Customize must not manage Code extensions');
const settingsModalSource = agentWidget.match(/protected renderSettingsModal\(\): React\.ReactNode \{[\s\S]*?\n    protected renderShortcutsOverlay/)?.[0] ?? '';
assert.ok(!settingsModalSource.includes('poiesis-settings-skills'), 'Settings modal must not contain Skills');
assert.ok(!settingsModalSource.includes('poiesis-settings-plugins'), 'Settings modal must not contain Plugins');
assert.ok(!agentWidget.includes('<h2>Hooks</h2>'), 'Customize must not advertise unsupported Hooks');
assert.ok(!agentWidget.includes('<select'), 'Poiesis UI must not render native select elements');
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
    '.then(() => this.refreshCliDetection())',
    '.then(() => this.initializeSessions())',
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
    ':is(button, [tabindex]):focus-visible',
    '.poiesis-agent-window__content :is(input, textarea):focus-visible',
    'overflow: clip',
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
    '.poiesis-customize-view',
    '.poiesis-customize-view__skill-card',
    '.poiesis-customize-view__editor',
    '.poiesis-customize-view__new-skill',
    '.poiesis-select__listbox',
    '.poiesis-settings-modal__model-field',
    '.poiesis-agent-window__switch',
    '.poiesis-agent-window__composer',
    '.poiesis-agent-window__new-agent-empty',
    '.poiesis-agent-window__new-agent-context',
    '.poiesis-agent-window__content--initializing',
    '.poiesis-agent-window__initializing',
    '.poiesis-agent-window__repository-picker',
    '.poiesis-agent-window__context-pill',
    '.poiesis-markdown pre',
    '.poiesis-markdown a:focus-visible',
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
    /\.poiesis-agent-window__workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    'The restored center column must shrink to the actual remaining rail width'
);
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
assert.match(agentStyles, /@media \(max-width: 1279px\)[\s\S]*?\.poiesis-agent-window__composer\s*\{[^}]*width:\s*min\(680px, calc\(100% - 32px\)\);/,
    'Agent composer must shrink fluidly between the native minimum and the design floor');
for (const marker of [
    'renderShortcutsOverlay()',
    'shortcutsOverlayVisible',
    "event.key !== 'Escape'"
]) {
    assert.ok(agentWidget.includes(marker), `Round 10 interaction wiring is missing ${marker}`);
}
for (const marker of [
    '--poiesis-control-border: #70726b',
    '--poiesis-results-accent: #6577a0',
    '--motion-fast: 120ms cubic-bezier(.2, 0, 0, 1)',
    '@media (prefers-reduced-motion: reduce)',
    'animation-duration: 0ms !important',
    '.poiesis-shortcuts__backdrop'
]) {
    assert.ok(agentStyles.includes(marker), `Round 10 UI styles are missing ${marker}`);
}
assert.ok(!agentWidget.includes('EXAMPLE_AGENT_PROMPTS'), 'Example prompt chips must stay removed');
assert.ok(!agentStyles.includes('.poiesis-agent-window__example-prompts'), 'Example prompt chip styles must stay removed');
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
const agentStylesWithoutDialogSafetyNet = agentStyles.replaceAll('.lm-Widget.dialogOverlay', '.poiesis-stock-dialog');
for (const forbidden of ['lm-Widget', 'lm-Panel', 'lm-BoxPanel', 'lm-SplitPanel-child', 'theia-mod-collapsed']) {
    assert.ok(!agentStylesWithoutDialogSafetyNet.includes(forbidden), `Code chrome must remove ${forbidden} nodes instead of hiding them with CSS`);
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
