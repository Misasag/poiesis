import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function subject(path, className, names) {
    const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'),
        ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
    assert.ok(declaration, `${className} was not found`);
    const members = names.map(name => {
        const member = declaration.members.find(node => node.name?.getText(source) === name);
        assert.ok(member, `${className}.${name} was not found`);
        return member.getText(source);
    });
    const { outputText } = ts.transpileModule(`class Subject { ${members.join('\n')} }\nSubject;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    });
    return new (vm.runInNewContext(outputText, {
        URI: class URI { constructor(value) { this.value = value; } },
        console
    }))();
}

const active = {
    id: 'active', archived: false, pinned: false, updatedAt: 100, hasUserMessage: true,
    workspaceUri: 'file:///workspace', unreadTaskCompletion: true, messages: [], agentDraft: '', resultsNotices: new Map()
};
const archived = {
    id: 'archived', archived: true, pinned: false, updatedAt: 200, hasUserMessage: true,
    workspaceUri: 'file:///workspace', unreadTaskCompletion: true, messages: [{ id: 'm', content: 'kept' }], agentDraft: '',
    resultsNotices: new Map()
};
let closeCustomizeCalls = 0;
let providerCalls = 0;
let clearPendingRevealCalls = 0;
const store = subject('../agent-window/src/browser/agent-window/session-store.ts', 'SessionStore', [
    'workspaceNavigationRevision', 'cancelPendingWorkspaceNavigation', 'selectSession'
]);
Object.assign(store, {
    sessions: [active, archived],
    selectedSessionId: active.id,
    host: {
        state: { customizeViewVisible: false, openSessionMenuId: active.id },
        closeCustomize: () => { closeCustomizeCalls += 1; },
        clearPendingAgentSearchReveal: () => { clearPendingRevealCalls += 1; },
        prepareCustomizeNavigation: () => true,
        sameWorkspaceUri: (left, right) => left === right
    },
    workspaceRoot: () => ({ resource: { toString: () => 'file:///workspace' } }),
    ensureProviderSession: () => { providerCalls += 1; },
    persistWindowState: () => Promise.resolve(),
    update() {}
});

await store.selectSession(archived.id);
assert.equal(store.selectedSessionId, archived.id, 'Archived conversations must be selectable for reading');
assert.equal(archived.archived, true, 'Reading an archived conversation must not restore it');
assert.equal(archived.updatedAt, 200, 'Reading a conversation must not change its activity time');
assert.equal(providerCalls, 0, 'Reading an archived conversation must not prepare a mutable provider session');
assert.equal(closeCustomizeCalls, 1);
assert.equal(clearPendingRevealCalls, 1, 'Ordinary navigation must discard a stale pending search reveal');

store.host.state.customizeViewVisible = true;
store.host.prepareCustomizeNavigation = () => false;
await store.selectSession(active.id);
assert.equal(store.selectedSessionId, archived.id, 'A dirty Customize guard must prevent navigation');
assert.equal(clearPendingRevealCalls, 1, 'Cancelled navigation must not mutate pending reveal state');

const foreign = {
    id: 'foreign', archived: false, pinned: false, updatedAt: 300, hasUserMessage: true,
    workspaceUri: 'file:///foreign', unreadTaskCompletion: false, messages: [], agentDraft: '', resultsNotices: new Map()
};
store.sessions.push(foreign);
store.host.state.customizeViewVisible = false;
store.host.prepareCustomizeNavigation = () => true;
let finishPersistence;
let workspaceOpen;
store.persistWindowState = () => new Promise(resolve => { finishPersistence = resolve; });
store.workspaceService = {
    open: (uri, options) => {
        workspaceOpen = { uri: uri.value, options };
        return Promise.resolve();
    }
};
const switching = store.selectSession(foreign.id, true);
assert.equal(workspaceOpen, undefined, 'Workspace navigation must wait until the selected session is durable');
assert.equal(clearPendingRevealCalls, 1, 'Search navigation must preserve its staged one-shot reveal');
finishPersistence();
await switching;
assert.equal(workspaceOpen?.uri, foreign.workspaceUri);
assert.equal(workspaceOpen?.options?.preserveWindow, true);

const picker = subject('../agent-window/src/browser/agent-window/rail-part.tsx', 'RailPart', ['openKnownWorkspace']);
Object.assign(picker, { host: { state: {}, sessions: store }, workspaceService: store.workspaceService });
workspaceOpen = undefined;
const supersededSwitch = store.selectSession(foreign.id, true);
picker.openKnownWorkspace('file:///newer-folder');
assert.equal(workspaceOpen?.uri, 'file:///newer-folder');
finishPersistence();
await supersededSwitch;
assert.equal(workspaceOpen?.uri, 'file:///newer-folder',
    'A delayed conversation search must not override a newer folder-picker choice');

const inputKeys = subject('../agent-window/src/browser/agent-window/rail-part.tsx', 'RailPart', ['handleSessionSearchInputKeyDown']);
inputKeys.sessionSearchActiveIndex = 0;
for (const key of ['ArrowDown', 'ArrowUp', 'Enter']) {
    for (const nativeEvent of [{ isComposing: true, keyCode: 0 }, { isComposing: false, keyCode: 229 }]) {
        inputKeys.handleSessionSearchInputKeyDown({ key, nativeEvent,
            preventDefault: () => assert.fail(`Search intercepted ${key} while composing`)
        }, [{ sessionId: 'first' }, { sessionId: 'second' }], 0);
        assert.equal(inputKeys.sessionSearchActiveIndex, 0, 'IME candidate keys must not move search selection');
    }
}

let persistenceCalls = 0;
const rail = subject('../agent-window/src/browser/agent-window/rail-part.tsx', 'RailPart', [
    'archiveSession', 'restoreSession', 'deleteSession', 'sessionHasPendingWork'
]);
Object.assign(rail, {
    host: {
        state: {
            openSessionMenuId: active.id,
            expandedWorkspaceGroups: new Set(),
            deleteSessionConfirmationId: archived.id
        },
        sessions: {
            sessions: [active, archived],
            selectedSessionId: active.id,
            runningTask: () => undefined,
            persistWindowState: async () => { persistenceCalls += 1; }
        }
    },
    expandedArchivedGroups: new Set(),
    workspaceGroupKey: () => 'workspace',
    update() {}
});

await rail.archiveSession(active.id);
assert.equal(active.archived, true);
assert.equal(rail.host.sessions.selectedSessionId, active.id,
    'Archiving the selected conversation must keep it selected for read-only viewing');
assert.equal(active.pinned, false);
assert.ok(rail.expandedArchivedGroups.has('workspace'));

const keptMessages = active.messages;
rail.restoreSession(active.id);
assert.equal(active.archived, false, 'Only the explicit restore action may make the conversation writable');
assert.equal(active.messages, keptMessages, 'Restore must preserve conversation content');

rail.host.sessions.runningTask = session => session.id === archived.id ? { id: 'running' } : undefined;
await rail.deleteSession(archived.id);
assert.ok(rail.host.sessions.sessions.includes(archived), 'A running archived conversation must not be deleted');
assert.ok(persistenceCalls >= 2);

console.log('Conversation navigation tests passed.');
