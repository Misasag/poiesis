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
const changesWidget = await read('agent-window/src/browser/changes-widget.tsx');
const moduleSource = await read('agent-window/src/browser/agent-window-frontend-module.ts');
const backendModule = await read('agent-window/src/node/agent-window-backend-module.ts');
const agentContribution = await read('agent-window/src/browser/agent-window-contribution.ts');
const changesContribution = await read('agent-window/src/browser/changes-contribution.ts');
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
const sample = await read('sample-src/auth-service.ts');
const baseline = await read('sample-src/auth-service.before.ts');

assert.equal(rootPackage.devDependencies['@theia/cli'], '1.73.1');
assert.equal(appPackage.theia.target, 'browser');
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
    "'--model', 'gpt-5.6-sol'",
    "'--config', 'model_reasoning_effort=xhigh'",
    "'--approve-for-me'",
    "'-C', sampleWorkspace",
    'prompt',
    "cwd, windowsHide: true",
    "child.stdout.on('data'",
    "child.stderr.on('data'",
    "type: 'output'",
    "type: 'exit'",
    "'taskkill'",
    "join(resolvedWorkspace, 'spikes', 'theia', 'sample-src')",
    'const sampleWorkspace = await this.resolveSampleWorkspace(workspacePath)',
    'const snapshot = await this.captureWorkspace(sampleWorkspace)'
]) {
    assert.ok(runtimeServer.includes(marker), `Codex runtime is missing ${marker}`);
}
assert.ok(!runtimeServer.includes("'--sandbox'"), 'Codex exec must not receive a separate sandbox option');
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
    "event.type === 'ended' || event.type === 'cancelled'",
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
    "type CodeRailTab = 'files' | 'source-control'",
    'protected codeMode = false',
    "this.activeTab === 'agent'",
    "data-mode={this.codeMode ? 'code' : this.activeTab}",
    "<small>lens / main</small>",
    'lens-agent-window__code-control',
    'aria-pressed={this.codeMode}',
    '{!this.codeMode && (',
    "aria-label='Agent と Results の切り替え'",
    '<span>New Chat</span>',
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
    'this.codeMode = !this.codeMode;',
    'protected renderCode(): React.ReactNode'
]) {
    assert.ok(agentWidget.includes(marker), `Agent / Results / Code UI is missing ${marker}`);
}
assert.equal(
    agentWidget.match(/this\.selectTab\('results'\)/g)?.length,
    1,
    'Only the explicit Results tab action may switch to Results'
);
const codeToggle = agentWidget.match(/protected toggleCodeMode\(\): void \{[\s\S]*?\n    \}/)?.[0];
assert.ok(codeToggle, 'Code mode toggle is missing');
assert.ok(!codeToggle.includes('activeTab'), 'Code mode must preserve the previous Agent / Results tab');
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
    '--lens-chrome-bg: #181918',
    '--lens-chrome-panel: #1d1e1c',
    'grid-template-columns: minmax(164px, 196px) minmax(0, 1fr)',
    '.lens-agent-window__composer',
    'align-self: end',
    '.lens-results__main',
    'grid-template-rows: minmax(0, 1fr) auto auto',
    '.lens-results__task-switcher',
    'border-left: 1px solid var(--lens-chrome-line)'
]) {
    assert.ok(agentStyles.includes(marker), `Agent chrome styles are missing ${marker}`);
}

for (const marker of [
    'IDE Changes',
    'task-auth-redis-001',
    'Code Diff',
    'Semantic Diff',
    'DiffUris.encode',
    'this.editorManager.open',
    "line: 11"
]) {
    assert.ok(changesWidget.includes(marker), `Changes Widget is missing ${marker}`);
}
assert.ok(moduleSource.includes('ChangesWidget'));
assert.ok(moduleSource.includes('ChangesContribution'));
assert.ok(agentContribution.includes("isDesignVariant('d1-b') ? 'main' : 'right'"));
assert.ok(changesContribution.includes("isDesignVariant('d2-b') ? 'main' : 'bottom'"));
assert.ok(!changesContribution.includes('initializeLayout'));
assert.ok(changesContribution.includes("setElement('lens-changes'"));
assert.ok(changesContribution.includes("onclick: () => void this.openView"));
assert.ok(changesContribution.includes('Lens: Open IDE Changes'));
assert.match(sample, /logout\(userId: string\): void/);
assert.match(sample, /失効処理は未実装/);
assert.match(sample, /async rotateRefreshToken/);
assert.match(baseline, /Database/);
for (const marker of ['AgentProvider', 'CliDetector', 'TaskService', 'BundledResultsSkill', 'Agent / Results']) {
    assert.ok(readme.includes(marker), `README is missing ${marker}`);
}

console.log('Source contract validation passed.');
