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
const {
    codeSidebarContainsFocus,
    isCodeSidebarVisible,
    normalizeCodeLayoutState,
    setCodeSidebarViewport,
    setCodeSidebarVisibility,
    shouldFocusCodeActivity
} = require(resolve(
    root,
    'agent-window',
    'lib',
    'browser',
    'agent-window',
    'code-layout-state.js'
));
const { LatestCodeReviewRequest } = require(resolve(
    root,
    'agent-window',
    'lib',
    'browser',
    'agent-window',
    'latest-code-review-request.js'
));
const {
    TaskReviewResourceResolver
} = require(resolve(
    root,
    'agent-window',
    'lib',
    'browser',
    'task-review-resource.js'
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

assert.deepEqual(normalizeCodeLayoutState(undefined), {
    version: 1,
    sidebarWidth: 260,
    sidebarCollapsed: false,
    sidebarTab: 'files',
    graphExpanded: false
});
assert.deepEqual(normalizeCodeLayoutState({
    version: 1,
    sidebarWidth: 900,
    sidebarCollapsed: true,
    sidebarTab: 'git',
    graphExpanded: true,
    untouchedFutureValue: 'preserved outside this state'
}), {
    version: 1,
    sidebarWidth: 520,
    sidebarCollapsed: true,
    sidebarTab: 'git',
    graphExpanded: true
});
assert.equal(normalizeCodeLayoutState({ version: 1, sidebarWidth: Number.NaN }).sidebarWidth, 260);
assert.equal(normalizeCodeLayoutState({ version: 1, sidebarTab: 'unknown' }).sidebarTab, 'files');
assert.equal(normalizeCodeLayoutState({ version: 2, sidebarCollapsed: true }).sidebarCollapsed, false);

let openWideSidebar = {
    wideCollapsed: false,
    narrowViewport: false,
    narrowOpen: false
};
assert.equal(isCodeSidebarVisible(openWideSidebar), true);
openWideSidebar = setCodeSidebarViewport(openWideSidebar, true);
assert.equal(isCodeSidebarVisible(openWideSidebar), false,
    'Entering a narrow viewport must leave the editor unobstructed.');
let narrowTransition = setCodeSidebarVisibility(openWideSidebar, true);
assert.equal(narrowTransition.persistWidePreference, false);
assert.equal(isCodeSidebarVisible(narrowTransition.state), true);
narrowTransition = setCodeSidebarVisibility(narrowTransition.state, false);
assert.equal(narrowTransition.persistWidePreference, false,
    'Dismissing the narrow overlay must not persist a wide collapse preference.');
openWideSidebar = setCodeSidebarViewport(narrowTransition.state, false);
assert.equal(isCodeSidebarVisible(openWideSidebar), true,
    'A previously open wide sidebar must reopen after leaving the narrow viewport.');

let collapsedWideSidebar = {
    wideCollapsed: true,
    narrowViewport: false,
    narrowOpen: false
};
collapsedWideSidebar = setCodeSidebarViewport(collapsedWideSidebar, true);
narrowTransition = setCodeSidebarVisibility(collapsedWideSidebar, true);
narrowTransition = setCodeSidebarVisibility(narrowTransition.state, false);
collapsedWideSidebar = setCodeSidebarViewport(narrowTransition.state, false);
assert.equal(isCodeSidebarVisible(collapsedWideSidebar), false,
    'A previously collapsed wide sidebar must remain collapsed after a narrow overlay closes.');
const intentionalWideCollapse = setCodeSidebarVisibility({
    wideCollapsed: false,
    narrowViewport: false,
    narrowOpen: false
}, false);
assert.equal(intentionalWideCollapse.persistWidePreference, true);
assert.equal(intentionalWideCollapse.state.wideCollapsed, true);

let sidebarAttached = true;
const focusTarget = {};
const focusWasInSidebar = codeSidebarContainsFocus({
    contains: candidate => sidebarAttached && candidate === focusTarget
}, focusTarget);
sidebarAttached = false;
assert.equal(focusWasInSidebar, true,
    'Sidebar focus containment must be captured before the Theia widget is detached.');
assert.equal(shouldFocusCodeActivity(true, false, focusWasInSidebar), true,
    'Closing a focused sidebar must move focus to its visible Activity button.');
assert.equal(shouldFocusCodeActivity(true, false, false), false,
    'Closing from the editor must preserve editor focus.');

const reviewRequests = new LatestCodeReviewRequest();
let resolveHistoricalResponse;
const historicalResponse = new Promise(resolveResponse => {
    resolveHistoricalResponse = resolveResponse;
});
let selectedReviewTarget = 'unchanged';
const historicalRequest = reviewRequests.begin();
const deferredHistoricalOpen = historicalResponse.then(() => {
    if (historicalRequest.isCurrent()) {
        selectedReviewTarget = 'historical';
    }
});
reviewRequests.cancel();
selectedReviewTarget = 'current-file';
resolveHistoricalResponse();
await deferredHistoricalOpen;
assert.equal(selectedReviewTarget, 'current-file',
    'A late historical response must not reselect its diff after the current-file action.');
const supersededTaskRequest = reviewRequests.begin();
const latestTaskRequest = reviewRequests.begin();
assert.equal(supersededTaskRequest.isCurrent(), false,
    'Choosing another Task or changed file must supersede the earlier historical request.');
assert.equal(latestTaskRequest.isCurrent(), true);

const reviewResources = new TaskReviewResourceResolver();
const reviewUri = reviewResources.register('task-visible-id', 'src/todo.js', 'before', 'saved before\n');
const reviewResource = reviewResources.resolve(reviewUri);
assert.equal(reviewResource.readOnly, true, 'Historical Task resources must be read-only.');
assert.equal(reviewResource.saveContents, undefined, 'Historical Task resources must not expose a save operation.');
assert.equal(await reviewResource.readContents(), 'saved before\n');
assert.equal(reviewResources.getName(reviewUri), 'todo.js (変更前)');
assert.equal(reviewResources.getLongName(reviewUri), 'src/todo.js (変更前)');
assert.doesNotMatch(reviewResources.getLongName(reviewUri), /poiesis-task-review|[0-9a-f]{40}/i);

const codeCss = readFileSync(resolve(root, 'agent-window', 'src', 'browser', 'style', 'code.css'), 'utf8');
const resultsCss = readFileSync(resolve(root, 'agent-window', 'src', 'browser', 'style', 'results.css'), 'utf8');
const responsiveCss = readFileSync(resolve(root, 'agent-window', 'src', 'browser', 'style', 'responsive.css'), 'utf8');
assert.match(codeCss, /grid-template-columns: 44px var\(--poiesis-code-sidebar-width, 260px\) minmax\(0, 1fr\)/,
    'The wide Code grid must retain the user-selected sidebar width.');
assert.match(codeCss, /@media \(max-width: 900px\)[\s\S]*grid-template-columns: 44px minmax\(0, 1fr\)/,
    'The narrow Code grid must overlay the sidebar without squeezing the editor.');
assert.match(codeCss, /\.poiesis-agent-window__code\.sidebar-collapsed[\s\S]*grid-template-columns: 44px 0 minmax\(0, 1fr\)/,
    'The collapsed Code grid must return sidebar width to the editor.');
assert.doesNotMatch(resultsCss, /\.poiesis-agent-window__code\s*\{[\s\S]*?grid-template-columns/,
    'Code grid ownership must not leak into Results CSS.');
assert.doesNotMatch(responsiveCss, /\.poiesis-agent-window__code\s*\{[\s\S]*?grid-template-columns/,
    'Responsive CSS must not override the Code grid.');

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
