import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const { codeTabLabel } = require(resolve(
    root,
    'agent-window',
    'lib',
    'browser',
    'agent-window',
    'code-tab-label.js'
));
const { liveWorkspaceBranch } = require(resolve(
    root,
    'agent-window',
    'lib',
    'browser',
    'agent-window',
    'workspace-context.js'
));
const { PendingEditorPins } = require(resolve(
    root,
    'agent-window',
    'lib',
    'browser',
    'agent-window',
    'pending-editor-pins.js'
));
const { resolveBundledRipgrepPath } = require(resolve(
    root,
    'electron-app',
    'scripts',
    'bundled-ripgrep-path.js'
));

assert.equal(codeTabLabel('/workspace/src/config.js', ['/workspace/src/config.js']), 'config.js');
assert.equal(
    codeTabLabel('/workspace/src/config.js', ['/workspace/src/config.js', '/workspace/test/config.js']),
    'config.js — src'
);
assert.equal(
    codeTabLabel('/workspace/src/client/config.js', [
        '/workspace/src/client/config.js',
        '/workspace/test/client/config.js'
    ]),
    'config.js — src/client'
);
assert.equal(
    codeTabLabel('C:\\workspace\\SRC\\config.js', [
        'C:\\workspace\\SRC\\config.js',
        'C:\\workspace\\test\\CONFIG.js'
    ]),
    'config.js — SRC'
);

const workspaceUri = 'file:///C:/workspace/target';
let requestedWorkspace;
const scmService = ref => ({
    findRepository(uri) {
        requestedWorkspace = uri.toString();
        return {
            provider: {
                id: 'git',
                historyProvider: { currentHistoryItemRef: ref }
            }
        };
    }
});

assert.equal(liveWorkspaceBranch(scmService({
    id: 'refs/heads/feature/search',
    name: 'feature/search',
    revision: '0123456789abcdef'
}), workspaceUri), 'feature/search');
assert.match(requestedWorkspace, /workspace\/target$/);
assert.equal(liveWorkspaceBranch(scmService({
    id: '0123456789abcdef',
    name: '0123456789abcdef',
    revision: '0123456789abcdef'
}), workspaceUri), 'detached HEAD 0123456');
assert.equal(liveWorkspaceBranch({ findRepository: () => undefined }, workspaceUri), undefined);
assert.equal(liveWorkspaceBranch(scmService(undefined), workspaceUri), undefined);
assert.equal(liveWorkspaceBranch(scmService({ id: 'refs/heads/main', name: 'main' }), undefined), undefined);

const pendingPins = new PendingEditorPins();
const delayedUri = 'file:///workspace/delayed.ts';
const delayedRequest = pendingPins.begin(delayedUri);
await new Promise(resolveDelay => setTimeout(resolveDelay, 1_100));
assert.equal(pendingPins.has(delayedUri), true, 'A delayed editor registration must retain its pin request.');
delayedRequest.dispose();
assert.equal(pendingPins.has(delayedUri), false, 'A completed editor registration must release its pin request.');

const failedRequest = pendingPins.begin('file:///workspace/failed.ts');
failedRequest.dispose();
assert.equal(pendingPins.has('file:///workspace/failed.ts'), false, 'A failed editor open must release its pin request.');

const overlappingUri = 'file:///workspace/overlapping.ts';
const firstRequest = pendingPins.begin(overlappingUri);
const secondRequest = pendingPins.begin(overlappingUri);
firstRequest.dispose();
assert.equal(pendingPins.has(overlappingUri), true, 'One completed open must not clear another pending pin for the same URI.');
secondRequest.dispose();
assert.equal(pendingPins.has(overlappingUri), false);

const staleRequest = pendingPins.begin(delayedUri);
pendingPins.clear();
assert.equal(staleRequest.isActive(), false, 'Disposal must cancel an unfinished pin request.');
const replacementRequest = pendingPins.begin(delayedUri);
staleRequest.dispose();
assert.equal(pendingPins.has(delayedUri), true, 'A stale completion after disposal must not clear a later pin request.');
replacementRequest.dispose();

const packagedRgPath = 'C:\\Program Files\\Poiesis\\resources\\app.asar\\lib\\backend\\native\\rg.exe';
assert.equal(
    resolveBundledRipgrepPath(packagedRgPath),
    'C:\\Program Files\\Poiesis\\resources\\app.asar.unpacked\\lib\\backend\\native\\rg.exe'
);
assert.equal(
    resolveBundledRipgrepPath('C:\\workspace\\electron-app\\lib\\backend\\native\\rg.exe'),
    'C:\\workspace\\electron-app\\lib\\backend\\native\\rg.exe'
);
assert.equal(
    resolveBundledRipgrepPath('C:\\workspace\\app.asar-copy\\lib\\backend\\native\\rg.exe'),
    'C:\\workspace\\app.asar-copy\\lib\\backend\\native\\rg.exe'
);
const webpackConfigs = require(resolve(root, 'electron-app', 'webpack.config.js'));
const backendConfig = webpackConfigs.find(config => config.target === 'node');
const ripgrepReplacement = backendConfig?.plugins.find(plugin => plugin.constructor.name === 'NormalModuleReplacementPlugin'
    && String(plugin.resourceRegExp).includes('ripgrep'));
assert(ripgrepReplacement, 'Electron backend webpack config must replace Theia\'s generated ripgrep module.');
assert.equal(ripgrepReplacement.newResource, resolve(root, 'electron-app', 'scripts', 'bundled-ripgrep-path.js'));
const builderConfiguration = readFileSync(resolve(root, 'electron-app', 'electron-builder.yml'), 'utf8');
assert.match(builderConfiguration, /asarUnpack:[\s\S]*\*\*\/lib\/backend\/native\/\*\*/,
    'electron-builder must unpack Theia native backend executables.');

console.log('CODE_WORKSPACE_REGRESSION_RESULT=pass');
