import { readFile } from 'node:fs/promises';

const extension = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const sample = await readFile(new URL('../sample-src/auth-service.ts', import.meta.url), 'utf8');
const baseline = await readFile(new URL('../sample-src/auth-service.before.ts', import.meta.url), 'utf8');

const requiredSourceTokens = [
    'createWebviewPanel',
    'registerWebviewViewProvider',
    "vscode.commands.executeCommand(\n            'vscode.diff'",
    'poiesis.changesView',
    'task-auth-redis-001',
    'Code Diff',
    'Semantic Diff',
    'workspace.openTextDocument',
    'window.showTextDocument',
    'new vscode.Range',
    '質問',
    'openEvidence'
];
for (const token of requiredSourceTokens) {
    if (!extension.includes(token)) {
        throw new Error(`Missing required source contract: ${token}`);
    }
}

const agentMarkup = extension.slice(extension.indexOf('function renderAgentWindow'), extension.indexOf('function renderChangesView'));
const removedAgentAction = ['変更', 'を', '見る'].join('');
for (const forbidden of [removedAgentAction, 'Semantic Diff', 'Change Set', 'openEvidence']) {
    if (agentMarkup.includes(forbidden)) {
        throw new Error(`Agent Window must not contain ${forbidden}`);
    }
}
if (!manifest.activationEvents.includes('onStartupFinished')) {
    throw new Error('The extension must activate after workbench startup.');
}
if (!manifest.activationEvents.includes('onView:poiesis.changesView')) {
    throw new Error('The Changes Webview View activation event is missing.');
}
if (!manifest.contributes.viewsContainers?.activitybar?.some(container => container.id === 'poiesisChanges')) {
    throw new Error('The Changes Activity Bar container is missing.');
}
if (!manifest.contributes.views?.poiesisChanges?.some(view => view.id === 'poiesis.changesView' && view.type === 'webview')) {
    throw new Error('The Changes Webview View contribution is missing.');
}
if (sample.split(/\r?\n/).length < 12 || !baseline.includes('Database')) {
    throw new Error('The Change Set sample files are incomplete.');
}

console.log('Source contract validation passed.');
