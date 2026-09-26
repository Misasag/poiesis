import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require.extensions['.css'] = () => undefined;
class ElementStub {
    constructor() {
        this.classList = { add() {}, remove() {} };
        this.style = {};
        this.dataset = {};
    }
    addEventListener() {}
    removeEventListener() {}
    setAttribute() {}
    appendChild(child) { return child; }
}
for (const name of ['Element', 'HTMLElement', 'DragEvent', 'MouseEvent', 'KeyboardEvent', 'Event', 'CustomEvent', 'FocusEvent']) {
    globalThis[name] = ElementStub;
}
globalThis.document = { createElement: () => new ElementStub(), body: new ElementStub(),
    documentElement: new ElementStub(), addEventListener() {}, removeEventListener() {},
    queryCommandSupported: () => false };
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'Win32', userAgent: 'node' } });
require('@theia/core/lib/browser/frontend-application-config-provider').FrontendApplicationConfigProvider.set({});

const { SessionStore, GLOBAL_SESSION_STORAGE_KEY, SESSION_MIGRATION_MARKER_KEY } =
    require('../agent-window/lib/browser/agent-window/session-store.js');
const { ResultsDocumentStorage, resultsDocumentHtmlKey } =
    require('../agent-window/lib/browser/results-document-storage.js');
const { RequirementService } = require('../agent-window/lib/browser/requirement-service.js');

const saved = new Map([[SESSION_MIGRATION_MARKER_KEY, true]]);
const writes = new Map();
const clone = value => value === undefined ? undefined : structuredClone(value);
const storage = {
    async getData(key) { return clone(saved.get(key)); },
    async setData(key, value) {
        writes.set(key, (writes.get(key) ?? 0) + 1);
        if (value === undefined) saved.delete(key);
        else saved.set(key, clone(value));
    }
};
const session = {
    id: 'session-1', title: 'Document', createdAt: 1, updatedAt: 1,
    runTarget: 'local', hasUserMessage: true, pinned: false, archived: false,
    activeTab: 'results', agentDraft: '', messages: [], taskIds: ['task-1'],
    resultsDrafts: new Map(), resultsNotices: new Map(), resultsQaExpanded: new Map()
};
const image = 'data:image/png;base64,' + 'A'.repeat(900_000);
const html = `<html><img src="${image}">${'z'.repeat(99_953)}</html>`;
assert.equal(html.length, 1_000_000);
let task = { id: 'task-1', sessionId: session.id,
    resultsDocument: { taskId: 'task-1', status: 'ready', html, generatedAt: '2026-09-27T00:00:00.000Z' } };
function makeStore() {
    const host = { globalStorageService: storage, state: { railWidth: 232, railCollapsed: false },
        messageService: { error() {} } };
    const store = new SessionStore(host);
    store.sessions.push(session);
    store.windowStatePersistence = Promise.resolve();
    store.persistedTasks = () => task ? [clone(task)] : [];
    return store;
}
const key = resultsDocumentHtmlKey('task', task.id);
const store = makeStore();
await store.persistWindowState();
assert.equal(saved.get(key), html, 'The separate key must retain every character of the image document.');
assert.equal(saved.get(GLOBAL_SESSION_STORAGE_KEY).sessions[0].tasks[0].resultsDocument.html, undefined);
assert.equal(saved.get(GLOBAL_SESSION_STORAGE_KEY).sessions[0].tasks[0].resultsDocument.htmlStored.length, html.length);
await store.persistWindowState();
assert.equal(writes.get(key), 1, 'Unchanged HTML must not be written again.');
const restored = await makeStore().loadGlobalWindowState();
assert.equal(restored.sessions[0].tasks[0].resultsDocument.html, html);
const restartedStore = makeStore();
await restartedStore.loadGlobalWindowState();
await restartedStore.persistWindowState();
assert.equal(writes.get(key), 1, 'Reloading an unchanged document must not rewrite its key.');

task = { ...task, resultsDocument: { ...task.resultsDocument, html: '<html>replacement</html>', generatedAt: '2026-09-27T00:01:00.000Z' } };
await store.persistWindowState();
assert.equal(saved.get(key), task.resultsDocument.html, 'Regeneration must overwrite the same key.');

const legacy = '<html>legacy inline document</html>';
saved.set(GLOBAL_SESSION_STORAGE_KEY, { version: 1, railWidth: 232, railCollapsed: false,
    sessions: [{ ...session, resultsDrafts: [], tasks: [{ ...task,
        resultsDocument: { taskId: task.id, status: 'ready', html: legacy } }] }] });
const migrated = await makeStore().loadGlobalWindowState();
assert.equal(migrated.sessions[0].tasks[0].resultsDocument.html, legacy);
task = migrated.sessions[0].tasks[0];
await makeStore().persistWindowState();
assert.equal(saved.get(key), legacy);
assert.equal(saved.get(GLOBAL_SESSION_STORAGE_KEY).sessions[0].tasks[0].resultsDocument.html, undefined);

task = undefined;
await store.persistWindowState();
assert.equal(saved.has(key), false, 'Removing a task must remove its HTML key.');
task = { id: 'task-1', sessionId: session.id,
    resultsDocument: { taskId: 'task-1', status: 'ready', html: 'x'.repeat(8 * 1024 * 1024 + 1) } };

await store.persistWindowState();
assert.equal(saved.has(key), false, 'Oversized HTML must not leave a partial durable document.');
const oversize = saved.get(GLOBAL_SESSION_STORAGE_KEY).sessions[0].tasks[0].resultsDocument;
assert.equal(oversize.status, 'failed');
assert.equal(oversize.html, undefined);
assert.match(oversize.error, /8 MiB/);

const documentStorage = new ResultsDocumentStorage(storage);
const marker = { taskId: task.id, status: 'ready', htmlStored: { version: 1, length: 10, hash: 'deadbeef' } };
assert.equal((await documentStorage.restore('task', task.id, marker)).status, 'failed',
    'A missing document must use the existing failure state.');
assert(resultsDocumentHtmlKey('requirement', 'x'.repeat(500)).length <= 160);

saved.set('poiesis.requirements.migrated.v1', true);
const fakeTasks = { onDidChangeTask: () => ({ dispose() {} }), onDidRemoveTask: () => ({ dispose() {} }),
    list: () => [], get: () => undefined };
const fakeLegacy = { async getData(_key, fallback) { return fallback; } };
const requirements = new RequirementService(fakeTasks, storage, fakeLegacy);
requirements.init();
await requirements.loading;
requirements.requirements.set('requirement-1', {
    id: 'requirement-1', sessionId: 'session-1', title: 'Aggregate', titleSource: 'task',
    createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z', taskIds: [],
    resultsDocument: { taskId: 'requirement:requirement-1', status: 'ready', html }
});
await requirements.persist();
const requirementKey = resultsDocumentHtmlKey('requirement', 'requirement-1');
assert.equal(saved.get(requirementKey), html);
assert.equal(saved.get('poiesis.requirements.sessions.v1').sessions['session-1'][0].resultsDocument.html, undefined);
const restoredRequirements = new RequirementService(fakeTasks, storage, fakeLegacy);
restoredRequirements.init();
await restoredRequirements.loading;
assert.equal(restoredRequirements.get('requirement-1').resultsDocument.html, html);
assert.equal(requirements.remove('requirement-1'), true);
await requirements.persistence;
assert.equal(saved.has(requirementKey), false, 'Removing a requirement must remove its HTML key.');
console.log('RESULTS_DOCUMENT_PERSISTENCE_TEST={"imageChars":1000000,"separateKey":true,"legacyMigrated":true,"unchangedWrites":1,"oversizeFailed":true}');
