import * as vscode from 'vscode';
import * as path from 'node:path';

const AGENT_PANEL_TYPE = 'lens.agentWindow';
const CHANGES_VIEW_ID = 'lens.changesView';
const CHANGES_CONTAINER_COMMAND = 'workbench.view.extension.lensChanges';
const CHANGE_SET_ID = 'task-auth-redis-001';
const SAMPLE_FILE = 'sample-src/auth-service.ts';
const BASELINE_FILE = 'sample-src/auth-service.before.ts';
const SAMPLE_LINE = 11;

let agentPanel: vscode.WebviewPanel | undefined;

class ChangesViewProvider implements vscode.WebviewViewProvider {
    protected view: vscode.WebviewView | undefined;

    constructor(protected readonly context: vscode.ExtensionContext) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [] };
        view.webview.html = renderChangesView();
        view.webview.onDidReceiveMessage(async message => {
            if (message?.type === 'openCodeDiff') {
                await openCodeDiff(this);
            } else if (message?.type === 'openEvidence') {
                await openEvidence(this);
            }
        }, undefined, this.context.subscriptions);
    }

    postNavigationResult(ok: boolean, message: string): Thenable<boolean> | undefined {
        return this.view?.webview.postMessage({ type: 'navigationResult', ok, message });
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const changesProvider = new ChangesViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(CHANGES_VIEW_ID, changesProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        }),
        vscode.commands.registerCommand('lens.openAgentWindow', () => openAgentWindow(context)),
        vscode.commands.registerCommand('lens.openChanges', async () => {
            await vscode.commands.executeCommand(CHANGES_CONTAINER_COMMAND);
            await vscode.commands.executeCommand(`${CHANGES_VIEW_ID}.focus`);
        }),
        { dispose: () => agentPanel?.dispose() }
    );

    await openSampleEditor();
    await openAgentWindow(context);

    if (process.env.LENS_CODE_OSS_SMOKE === '1') {
        void verifyExistingCapabilities(context);
    }
}

export function deactivate(): void {
    agentPanel?.dispose();
}

async function openSampleEditor(): Promise<void> {
    const uri = resolveWorkspaceFile(SAMPLE_FILE);
    if (!uri) {
        return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false
    });
}

async function openAgentWindow(context: vscode.ExtensionContext): Promise<void> {
    if (agentPanel) {
        agentPanel.reveal(vscode.ViewColumn.Two, true);
        return;
    }

    agentPanel = vscode.window.createWebviewPanel(
        AGENT_PANEL_TYPE,
        'Agent Window',
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    agentPanel.iconPath = new vscode.ThemeIcon('hubot');
    agentPanel.webview.html = renderAgentWindow();
    agentPanel.onDidDispose(() => {
        agentPanel = undefined;
    }, undefined, context.subscriptions);
}

async function openCodeDiff(changes: ChangesViewProvider): Promise<void> {
    const before = resolveWorkspaceFile(BASELINE_FILE);
    const after = resolveWorkspaceFile(SAMPLE_FILE);
    if (!before || !after) {
        await changes.postNavigationResult(false, 'Repository が開かれていません。');
        return;
    }
    try {
        await vscode.commands.executeCommand(
            'vscode.diff',
            before,
            after,
            'Change Set: auth-service.ts',
            { preview: false, viewColumn: vscode.ViewColumn.One }
        );
        await changes.postNavigationResult(true, 'Code-OSS の既存 Diff Editor で Code Diff を開きました。');
    } catch (error) {
        await changes.postNavigationResult(false, `Code Diff を開けませんでした: ${errorMessage(error)}`);
    }
}

async function openEvidence(changes: ChangesViewProvider): Promise<void> {
    const uri = resolveWorkspaceFile(SAMPLE_FILE);
    if (!uri) {
        await changes.postNavigationResult(false, 'Repository が開かれていません。');
        return;
    }

    try {
        const document = await vscode.workspace.openTextDocument(uri);
        const position = new vscode.Position(SAMPLE_LINE, 8);
        await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: false,
            preview: false,
            selection: new vscode.Range(position, position)
        });
        await vscode.commands.executeCommand('revealLine', { lineNumber: SAMPLE_LINE, at: 'center' });
        await changes.postNavigationResult(true, '根拠コードの 12 行目を Editor で開きました。');
    } catch (error) {
        await changes.postNavigationResult(false, `Editor を開けませんでした: ${errorMessage(error)}`);
    }
}

function resolveWorkspaceFile(relativePath: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }
    const normalized = folder.uri.fsPath.replaceAll('\\', '/').toLowerCase();
    return normalized.endsWith('/spikes/code-oss')
        ? vscode.Uri.joinPath(folder.uri, relativePath)
        : vscode.Uri.joinPath(folder.uri, 'spikes', 'code-oss', relativePath);
}

async function verifyExistingCapabilities(context: vscode.ExtensionContext): Promise<void> {
    const proofDirectory = process.env.LENS_CODE_OSS_PROOF_DIR;
    if (!proofDirectory) {
        return;
    }

    const terminalProof = path.join(proofDirectory, 'terminal-proof.txt');
    const terminal = vscode.window.createTerminal({
        name: 'Lens Spike Terminal',
        shellPath: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        shellArgs: ['/d']
    });
    context.subscriptions.push(terminal);
    terminal.show(true);
    terminal.sendText(`> "${terminalProof}" echo LENS_TERMINAL_OK`, true);

    await delay(3500);
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    let gitRepositoryCount: number | undefined;
    let gitWorkingTreeChangeCount: number | undefined;
    if (gitExtension) {
        const exports = await gitExtension.activate() as {
            getAPI?: (version: number) => {
                repositories?: Array<{ state?: { workingTreeChanges?: unknown[] } }>;
            };
        };
        const repositories = exports.getAPI?.(1).repositories ?? [];
        gitRepositoryCount = repositories.length;
        gitWorkingTreeChangeCount = repositories[0]?.state?.workingTreeChanges?.length;
    }

    const typescriptExtension = vscode.extensions.getExtension('vscode.typescript-language-features');
    if (typescriptExtension && !typescriptExtension.isActive) {
        await typescriptExtension.activate();
    }
    const sampleUri = resolveWorkspaceFile(SAMPLE_FILE);
    const hoverItems = sampleUri
        ? await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', sampleUri, new vscode.Position(5, 13))
        : undefined;

    const result = {
        terminalCreated: Boolean(vscode.window.terminals.find(item => item.name === 'Lens Spike Terminal')),
        gitExtensionPresent: Boolean(gitExtension),
        gitExtensionActive: Boolean(gitExtension?.isActive),
        gitRepositoryCount: gitRepositoryCount ?? null,
        gitWorkingTreeChangeCount: gitWorkingTreeChangeCount ?? null,
        typescriptExtensionPresent: Boolean(typescriptExtension),
        typescriptExtensionActive: Boolean(typescriptExtension?.isActive),
        typescriptHoverCount: hoverItems?.length ?? 0
    };
    await vscode.workspace.fs.writeFile(
        vscode.Uri.file(path.join(proofDirectory, 'capabilities.json')),
        Buffer.from(JSON.stringify(result, null, 2), 'utf8')
    );
}

function renderAgentWindow(): string {
    const nonce = createNonce();
    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">${baseStyles()}
        main { max-width: 760px; margin: 0 auto; padding: 28px; }
        .message, .question { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 18px; background: var(--vscode-sideBar-background); }
        .question { margin-top: 12px; }
        .question[hidden] { display: none; }
        .question input { width: 100%; margin-top: 8px; padding: 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
    </style>
</head>
<body>
<main data-responsibility="chat-task-result-question">
    <div class="eyebrow">LENS · AGENT-FIRST SPIKE</div>
    <h1>Agent Window</h1>
    <section class="message" aria-label="Mock agent message">
        <h2>AI</h2>
        <p>認証処理を変更しました。</p>
        <ul>
            <li>Refresh Token の保存先を Redis へ変更</li>
            <li>TokenStore を追加</li>
            <li>Logout 時の失効処理を変更</li>
        </ul>
        <div class="actions"><button id="questionButton" class="secondary">質問</button></div>
    </section>
    <section id="question" class="question" aria-label="Mock follow-up question" hidden>
        <h2>この Task について質問</h2>
        <input aria-label="Question input" value="なぜ Redis に変更したの？" readonly>
        <p>Spike のため送信処理はモックです。</p>
    </section>
</main>
<script nonce="${nonce}">
    const question = document.getElementById('question');
    document.getElementById('questionButton').addEventListener('click', () => {
        question.hidden = !question.hidden;
    });
</script>
</body>
</html>`;
}

function renderChangesView(): string {
    const nonce = createNonce();
    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">${baseStyles()}
        main { padding: 12px; }
        header code { display: block; margin: 6px 0 12px; color: var(--vscode-descriptionForeground); }
        .tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 9px; }
        .representation { margin-top: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; }
        .representation[hidden] { display: none; }
        .flow { display: grid; gap: 6px; }
        .state { padding: 9px; border-radius: 4px; background: var(--vscode-editor-inactiveSelectionBackground); }
        .state span { display: block; color: var(--vscode-descriptionForeground); font-size: 11px; }
        .impact { color: var(--vscode-descriptionForeground); }
        .evidence { width: 100%; text-align: left; }
        .evidence small { display: block; opacity: .8; }
        #status { min-height: 20px; margin-top: 8px; color: var(--vscode-testing-iconPassed); }
    </style>
</head>
<body>
<main data-change-set-id="${CHANGE_SET_ID}">
    <header>
        <div class="eyebrow">CHANGE SET · MOCK</div>
        <h1>IDE Changes</h1>
        <code>${CHANGE_SET_ID}</code>
    </header>
    <div class="tabs" role="tablist" aria-label="Change Set representations">
        <button id="codeTab" role="tab" aria-selected="true">Code Diff</button>
        <button id="semanticTab" class="secondary" role="tab" aria-selected="false">Semantic Diff</button>
    </div>
    <section id="codeDiff" class="representation" aria-label="Code Diff representation">
        <div class="eyebrow">CODE DIFF · SAME CHANGE SET</div>
        <h2>sample-src/auth-service.ts</h2>
        <p>AuthService の保存先を Database から TokenStore へ変更。</p>
        <button id="openCodeDiffButton">既存 Diff Editor で開く</button>
    </section>
    <section id="semanticDiff" class="representation" aria-label="Semantic Diff representation" hidden>
        <div class="eyebrow">SEMANTIC DIFF · SAME CHANGE SET</div>
        <h2>Refresh Token の保存責務を分離</h2>
        <div class="flow">
            <div class="state"><span>変更前</span><strong>AuthService → Database</strong></div>
            <div aria-hidden="true">↓</div>
            <div class="state"><span>変更後</span><strong>AuthService → TokenStore → Redis</strong></div>
        </div>
        <p class="impact">影響: Refresh / Logout / Session</p>
        <button id="evidenceButton" class="evidence">
            <strong>根拠コードを開く</strong>
            <small>sample-src/auth-service.ts:12</small>
        </button>
    </section>
    <div id="status" role="status"></div>
</main>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const codeTab = document.getElementById('codeTab');
    const semanticTab = document.getElementById('semanticTab');
    const codeDiff = document.getElementById('codeDiff');
    const semanticDiff = document.getElementById('semanticDiff');
    const selectMode = mode => {
        const semantic = mode === 'semantic';
        codeDiff.hidden = semantic;
        semanticDiff.hidden = !semantic;
        codeTab.setAttribute('aria-selected', String(!semantic));
        semanticTab.setAttribute('aria-selected', String(semantic));
        codeTab.className = semantic ? 'secondary' : '';
        semanticTab.className = semantic ? '' : 'secondary';
        document.getElementById('status').textContent = '';
    };
    codeTab.addEventListener('click', () => selectMode('code'));
    semanticTab.addEventListener('click', () => selectMode('semantic'));
    document.getElementById('openCodeDiffButton').addEventListener('click', () => {
        document.getElementById('status').textContent = 'Code Diff を開いています…';
        vscode.postMessage({ type: 'openCodeDiff' });
    });
    document.getElementById('evidenceButton').addEventListener('click', () => {
        document.getElementById('status').textContent = '根拠コードを開いています…';
        vscode.postMessage({ type: 'openEvidence' });
    });
    window.addEventListener('message', event => {
        if (event.data?.type === 'navigationResult') {
            document.getElementById('status').textContent = event.data.message;
        }
    });
</script>
</body>
</html>`;
}

function baseStyles(): string {
    return `
        :root { color-scheme: light dark; }
        * { box-sizing: border-box; }
        body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px/1.5 var(--vscode-font-family); }
        h1 { margin: 4px 0 12px; font-size: 20px; }
        h2 { margin: 0 0 8px; font-size: 14px; }
        ul { padding-left: 20px; }
        .eyebrow { color: var(--vscode-descriptionForeground); font-size: 10px; letter-spacing: .1em; }
        .actions { display: flex; gap: 8px; margin-top: 14px; }
        button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 6px 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    `;
}

function createNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index += 1) {
        value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return value;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
