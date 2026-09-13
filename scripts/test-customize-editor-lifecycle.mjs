import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { CustomizePart } = require(resolve(root, 'agent-window/lib/browser/agent-window/customize-part.js'));

globalThis.requestAnimationFrame = callback => {
    callback(0);
    return 1;
};

function deferred() {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createFakeEditor(initialValue, uri = 'file:///workspace/.poiesis/skills/example/SKILL.md') {
    let value = initialValue;
    const modelListeners = new Set();
    const dirtyListeners = new Set();
    const document = {
        dirty: false,
        revertCalls: [],
        onDirtyChanged(listener) {
            dirtyListeners.add(listener);
            return { dispose: () => dirtyListeners.delete(listener) };
        },
        async revert(options) {
            this.revertCalls.push(options);
            if (this.dirty) {
                this.dirty = false;
                for (const listener of dirtyListeners) listener();
            }
        }
    };
    const emitContent = nextDirty => {
        if (document.dirty !== nextDirty) {
            document.dirty = nextDirty;
            for (const listener of dirtyListeners) listener();
        }
        for (const listener of modelListeners) listener();
    };
    const model = {
        getValue: () => value,
        setValue(nextValue) {
            value = nextValue;
            emitContent(true);
        }
    };
    const control = {
        focusCalls: 0,
        getModel: () => model,
        onDidChangeModelContent(listener) {
            modelListeners.add(listener);
            return { dispose: () => modelListeners.delete(listener) };
        },
        focus() {
            this.focusCalls += 1;
        }
    };
    const editor = {
        uri,
        document,
        disposeCalls: 0,
        getControl: () => control,
        dispose() {
            this.disposeCalls += 1;
        }
    };
    return {
        control,
        document,
        editor,
        model,
        edit(nextValue) {
            value = nextValue;
            emitContent(true);
        }
    };
}

function createPart(overrides = {}) {
    const host = {
        fileService: {
            read: async () => ({ value: '' }),
            write: async () => undefined
        },
        monacoEditorProvider: {
            createInline: async () => createFakeEditor('').editor
        },
        node: { querySelector: () => undefined },
        state: { customizeViewVisible: true, workspaceSkillWatchRoots: [] },
        update() { },
        ...overrides
    };
    const part = new CustomizePart(host);
    part.refreshWorkspaceSkills = async () => undefined;
    return { host, part };
}

function editorState(content = 'base') {
    return {
        uri: 'file:///workspace/.poiesis/skills/example/SKILL.md',
        path: '/workspace/.poiesis/skills/example/SKILL.md',
        content,
        savedContent: content
    };
}

{
    const { part } = createPart();
    const firstListView = { scrollTop: 0 };
    const firstListMount = {
        isConnected: true,
        closest: selector => selector === '.poiesis-customize-view' ? firstListView : undefined
    };

    part.customizeListScrollTop = 70;
    part.restoreCustomizeListScroll();
    assert.equal(firstListView.scrollTop, 0, 'Restoration must wait until React commits the list mount.');
    part.setCustomizeListMount(firstListMount);
    assert.equal(firstListView.scrollTop, 70, 'The committed list mount must consume pending restoration.');

    firstListView.scrollTop = 96;
    part.setCustomizeListMount(firstListMount);
    assert.equal(firstListView.scrollTop, 96, 'An ordinary list update must not repeatedly restore old scroll.');
    part.captureCustomizeListScroll();
    assert.equal(part.customizeListScrollTop, 96);

    part.setCustomizeListMount(null);
    firstListView.scrollTop = 0;
    part.captureCustomizeListScroll();
    assert.equal(part.customizeListScrollTop, 96, 'A detail view must not overwrite remembered list scroll.');
    part.restoreCustomizeListScroll();

    const remountedListView = { scrollTop: 0 };
    part.setCustomizeListMount({
        isConnected: true,
        closest: selector => selector === '.poiesis-customize-view' ? remountedListView : undefined
    });
    assert.equal(remountedListView.scrollTop, 96, 'A deferred list remount must restore the remembered position.');
}

{
    const creation = deferred();
    let createCalls = 0;
    const fake = createFakeEditor('base');
    const { part } = createPart({
        monacoEditorProvider: {
            createInline: async () => {
                createCalls += 1;
                await creation.promise;
                return fake.editor;
            }
        }
    });
    part.workspaceSkillEditor = editorState();
    part.inlineEditorContainer = { isConnected: true };
    const first = part.ensureInlineEditor();
    const duplicate = part.ensureInlineEditor();
    assert.equal(createCalls, 1, 'Duplicate calls must share the in-flight inline editor creation.');
    creation.resolve();
    await Promise.all([first, duplicate]);
    assert.equal(part.inlineEditor, fake.editor);
    assert.equal(createCalls, 1);
}

{
    const firstCreation = deferred();
    const secondCreation = deferred();
    const firstFake = createFakeEditor('first');
    const secondFake = createFakeEditor('second');
    let createCalls = 0;
    const { part } = createPart({
        monacoEditorProvider: {
            createInline: async () => {
                createCalls += 1;
                if (createCalls === 1) {
                    await firstCreation.promise;
                    return firstFake.editor;
                }
                await secondCreation.promise;
                return secondFake.editor;
            }
        }
    });
    part.workspaceSkillEditor = editorState();
    part.inlineEditorContainer = { isConnected: true };
    const first = part.ensureInlineEditor();
    part.disposeInlineEditor();
    const second = part.ensureInlineEditor();
    firstCreation.resolve();
    await first;
    assert.equal(firstFake.editor.disposeCalls, 1, 'A stale creation must be disposed.');
    await part.ensureInlineEditor();
    assert.equal(createCalls, 2, 'A stale completion must not clear the newer in-flight marker.');
    secondCreation.resolve();
    await second;
    assert.equal(part.inlineEditor, secondFake.editor);
}

{
    const write = deferred();
    const writes = [];
    const fake = createFakeEditor('first draft');
    fake.document.dirty = true;
    const { part } = createPart({
        fileService: {
            read: async () => ({ value: '' }),
            write: async (uri, content) => {
                writes.push({ uri: uri.toString(), content });
                await write.promise;
            }
        }
    });
    const state = editorState('base');
    state.content = 'first draft';
    part.workspaceSkillEditor = state;
    part.inlineEditor = fake.editor;
    part.inlineEditorUri = state.uri;
    const saving = part.saveWorkspaceSkill();
    await Promise.resolve();
    fake.edit('second draft typed during save');
    write.resolve();
    await saving;
    assert.equal(writes.length, 1);
    assert.equal(writes[0].content, 'first draft');
    assert.equal(fake.model.getValue(), 'second draft typed during save');
    assert.equal(state.content, 'second draft typed during save');
    assert.equal(state.savedContent, 'first draft');
    assert.equal(fake.document.dirty, true);
    assert.equal(fake.document.revertCalls.length, 0, 'A newer edit must not be marked clean by the completed save.');
}

{
    const write = deferred();
    const original = createFakeEditor('old draft');
    original.document.dirty = true;
    const replacement = createFakeEditor('replacement draft');
    replacement.document.dirty = true;
    const { part } = createPart({
        fileService: {
            read: async () => ({ value: '' }),
            write: async () => write.promise
        }
    });
    const oldState = editorState('base');
    oldState.content = 'old draft';
    part.workspaceSkillEditor = oldState;
    part.inlineEditor = original.editor;
    part.inlineEditorUri = oldState.uri;
    const saving = part.saveWorkspaceSkill();
    await Promise.resolve();
    const newState = editorState('replacement saved');
    newState.content = 'replacement draft';
    part.workspaceSkillEditor = newState;
    part.inlineEditor = replacement.editor;
    write.resolve();
    await saving;
    assert.equal(newState.savedContent, 'replacement saved');
    assert.equal(replacement.model.getValue(), 'replacement draft');
    assert.equal(replacement.document.revertCalls.length, 0, 'A completed save must not touch a replacement editor.');
}

{
    const read = deferred();
    const fake = createFakeEditor('base');
    const { part } = createPart({
        fileService: {
            read: async () => read.promise,
            write: async () => undefined
        }
    });
    const state = editorState();
    part.workspaceSkillEditor = state;
    part.inlineEditor = fake.editor;
    part.inlineEditorUri = state.uri;
    const synchronizing = part.synchronizeWorkspaceSkillEditorFromDisk();
    fake.edit('local edit typed during external read');
    read.resolve({ value: 'external disk value' });
    await synchronizing;
    assert.equal(fake.model.getValue(), 'local edit typed during external read');
    assert.equal(state.content, 'local edit typed during external read');
    assert.equal(state.savedContent, 'external disk value');
    assert.equal(fake.document.dirty, true);
    assert.equal(fake.document.revertCalls.length, 0, 'External reload must not overwrite an edit made while reading.');

    part.pendingEditorNavigation = 'list';
    part.discardWorkspaceSkillChanges();
    assert.equal(fake.model.getValue(), 'external disk value', 'Discard must reset a model retained by another owner.');
    assert.equal(fake.document.dirty, false);
    assert.equal(fake.editor.disposeCalls, 1);

    const reopened = createFakeEditor(fake.model.getValue());
    const reopenedState = editorState('external disk value');
    part.workspaceSkillEditor = reopenedState;
    part.inlineEditorContainer = { isConnected: true };
    part.host.monacoEditorProvider.createInline = async () => reopened.editor;
    await part.ensureInlineEditor();
    assert.equal(reopened.model.getValue(), 'external disk value');
    assert(!reopened.model.getValue().includes('local edit'));
}

{
    const read = deferred();
    const fake = createFakeEditor('base');
    const { part } = createPart({
        fileService: {
            read: async () => read.promise,
            write: async () => undefined
        }
    });
    const state = editorState();
    part.workspaceSkillEditor = state;
    part.inlineEditor = fake.editor;
    part.inlineEditorUri = state.uri;
    const synchronizing = part.synchronizeWorkspaceSkillEditorFromDisk();
    read.resolve({ value: 'clean external update' });
    await synchronizing;
    assert.equal(fake.model.getValue(), 'clean external update');
    assert.equal(state.content, 'clean external update');
    assert.equal(state.savedContent, 'clean external update');
    assert.equal(fake.document.dirty, false);
    assert.deepEqual(fake.document.revertCalls, [{ soft: true }]);
}

console.log('Customize editor lifecycle races verified.');
