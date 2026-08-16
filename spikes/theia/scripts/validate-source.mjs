import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFile(resolve(root, path), 'utf8');

const rootPackage = JSON.parse(await read('package.json'));
const appPackage = JSON.parse(await read('browser-app/package.json'));
const extensionPackage = JSON.parse(await read('agent-window/package.json'));
const agentWidget = await read('agent-window/src/browser/agent-window-widget.tsx');
const changesWidget = await read('agent-window/src/browser/changes-widget.tsx');
const moduleSource = await read('agent-window/src/browser/agent-window-frontend-module.ts');
const agentContribution = await read('agent-window/src/browser/agent-window-contribution.ts');
const changesContribution = await read('agent-window/src/browser/changes-contribution.ts');
const sample = await read('sample-src/auth-service.ts');
const baseline = await read('sample-src/auth-service.before.ts');

assert.equal(rootPackage.devDependencies['@theia/cli'], '1.73.1');
assert.equal(appPackage.theia.target, 'browser');
for (const [name, version] of Object.entries(appPackage.dependencies)) {
    if (name.startsWith('@theia/')) {
        assert.equal(version, '1.73.1', `${name} must match the selected Theia version`);
    }
}

assert.equal(
    extensionPackage.theiaExtensions[0].frontend,
    'lib/browser/agent-window-frontend-module'
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

for (const marker of ['質問', 'Mock agent message', 'Mock follow-up question']) {
    assert.ok(agentWidget.includes(marker), `Agent Window is missing ${marker}`);
}
const removedAgentAction = ['変更', 'を', '見る'].join('');
for (const forbidden of [removedAgentAction, 'Semantic Diff', 'Change Set', 'openEvidence']) {
    assert.ok(!agentWidget.includes(forbidden), `Agent Window must not contain ${forbidden}`);
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
assert.ok(agentContribution.includes("area: 'right'"));
assert.ok(changesContribution.includes("area: 'bottom'"));
assert.ok(!changesContribution.includes('FrontendApplicationContribution'));
assert.ok(changesContribution.includes('Lens: Open IDE Changes'));
assert.match(sample.split(/\r?\n/)[11], /rotateRefreshToken/);
assert.match(baseline, /Database/);

console.log('Source contract validation passed.');
