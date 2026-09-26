import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
require.extensions['.css'] = () => undefined;
class ElementStub {
    classList = { add() {}, remove() {} }; style = {}; dataset = {}; children = [];
    matches() { return false; } setAttribute() {} appendChild(child) { this.children.push(child); return child; }
    addEventListener() {} removeEventListener() {}
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
const { detectEncodingDamage, SnapshotStore } = require('../agent-window/lib/node/snapshot-store.js');
const { tasksForDurableSession, restoredDurableTaskCandidates } = require('../agent-window/lib/common/session-persistence.js');
const { DurableDataStore } = require('../agent-window/lib/common/durable-data-store.js');
const { TaskService } = require('../agent-window/lib/browser/task-service.js');

// Short byte excerpts from workspace-start/files/index.html and workspace/index.html in the 2026-09-26 dogfood run.
const before = Buffer.from('202020203c703ee99b86e4b8ade381a8e4bc91e686a9e38292e7b9b0e3828ae8bf94e38199', 'hex');
const damaged = Buffer.from('202020203c703ee99b8145efbfbdefbfbde381a8e4bc91efbfbd45e38292e7b9b0e3828ae8bf94e38199', 'hex');
assert.equal(detectEncodingDamage(before, damaged), 'replacement-characters');
assert.equal(detectEncodingDamage(before, Buffer.concat([before, Buffer.from([0x81])])), 'invalid-utf8');
assert.equal(detectEncodingDamage(before, Buffer.from('正常な編集', 'utf8')), undefined);
assert.equal(detectEncodingDamage(before, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), before])), undefined);
assert.equal(detectEncodingDamage(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), before]), before), undefined);
assert.equal(detectEncodingDamage(Buffer.from([0, 1]), damaged), undefined);

const root = await mkdtemp(join(tmpdir(), 'poiesis-encoding-damage-'));
try {
    const workspace = join(root, 'workspace');
    const store = new SnapshotStore(join(root, 'store'));
    await mkdir(workspace);
    for (const path of ['index.html', 'later.html']) {
        await writeFile(join(workspace, path), before);
    }
    await writeFile(join(workspace, 'valid.txt'), '作業前', 'utf8');
    await writeFile(join(workspace, 'bom.txt'), before);
    await writeFile(join(workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
    await writeFile(join(workspace, 'deleted.txt'), before);
    const baseline = await store.capture(workspace);
    assert.equal(baseline.source, 'git-snapshot', JSON.stringify(baseline));
    for (const path of ['index.html', 'later.html']) {
        await writeFile(join(workspace, path), damaged);
    }
    await writeFile(join(workspace, 'valid.txt'), '作業後', 'utf8');
    await writeFile(join(workspace, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), before]));
    await writeFile(join(workspace, 'binary.bin'), Buffer.from([0, 0xff, 2]));
    await writeFile(join(workspace, 'added.txt'), damaged);
    await rm(join(workspace, 'deleted.txt'));
    const changes = await store.captureChangeSet(baseline.snapshotId);
    assert.equal(changes.source, 'task-diff', JSON.stringify(changes));
    assert.deepEqual(changes.encodingDamage, [
        { path: 'index.html', reason: 'replacement-characters' },
        { path: 'later.html', reason: 'replacement-characters' }
    ]);
    assert.deepEqual(changes.encodingDamageErrors, undefined);
    assert(changes.files.includes('binary.bin') && changes.files.includes('added.txt') && changes.files.includes('deleted.txt'));

    const task = {
        id: 'task', sessionId: 'session', title: '修正', request: '修正', startedAt: '2026-09-26T00:00:00Z',
        status: 'completed', baselineSnapshotId: baseline.snapshotId, endSnapshotId: changes.endSnapshotId,
        changeSet: { ...changes, capturedAt: '2026-09-26T00:00:01Z' }
    };
    const persisted = JSON.parse(JSON.stringify(tasksForDurableSession([task])));
    assert.deepEqual(restoredDurableTaskCandidates(persisted)[0].changeSet.encodingDamage, changes.encodingDamage);

    await writeFile(join(workspace, 'later.html'), 'その後の編集', 'utf8');
    const restored = await store.restoreEncodingDamage({
        workspacePath: workspace, baselineSnapshotId: baseline.snapshotId,
        endSnapshotId: changes.endSnapshotId, paths: ['index.html', 'later.html']
    });
    assert.deepEqual(restored, {
        restoredPaths: ['index.html'], skippedPaths: ['later.html'],
        skippedReasons: { 'later.html': 'changed-after-task' }
    });
    assert.deepEqual(await readFile(join(workspace, 'index.html')), before);
    assert.equal(await readFile(join(workspace, 'later.html'), 'utf8'), 'その後の編集');
    task.encodingRestore = { ...restored, restoredAt: '2026-09-26T00:00:02Z' };
    const savedOutcome = JSON.parse(JSON.stringify(tasksForDurableSession([task])));
    assert.deepEqual(restoredDurableTaskCandidates(savedOutcome)[0].encodingRestore, task.encodingRestore);
    let saved;
    const durable = new DurableDataStore({
        read: async () => saved,
        write: async (_key, contents) => { saved = contents; }
    });
    await durable.setData('tasks', tasksForDurableSession([task]));
    const reloaded = restoredDurableTaskCandidates(await durable.getData('tasks'))[0];
    assert.deepEqual(reloaded.changeSet.encodingDamage, changes.encodingDamage);
    assert.deepEqual(reloaded.encodingRestore, task.encodingRestore);

    const runtime = { restoreEncodingDamage: async () => restored };
    const service = new TaskService(runtime, {}, {}, {});
    service.restore([{ ...task, workspaceUri: pathToFileURL(workspace).toString(), encodingRestore: undefined }]);
    let update;
    let persistedOnEvent;
    service.onDidChangeTask(event => {
        update = event;
        persistedOnEvent = durable.setData('updated-task', tasksForDurableSession(service.list()));
    });
    await service.restoreEncodingDamage(task.id);
    await persistedOnEvent;
    assert.equal(update.type, 'updated');
    assert.deepEqual(update.task.encodingRestore.restoredPaths, ['index.html']);
    assert.deepEqual(restoredDurableTaskCandidates(await durable.getData('updated-task'))[0].encodingRestore,
        update.task.encodingRestore);

    await rm(join(workspace, 'later.html'));
    const unavailable = await store.restoreEncodingDamage({
        workspacePath: workspace, baselineSnapshotId: baseline.snapshotId,
        endSnapshotId: changes.endSnapshotId, paths: ['later.html']
    });
    assert.deepEqual(unavailable.skippedReasons, { 'later.html': 'unavailable' });

    class FailingDetectionStore extends SnapshotStore {
        async detectEncodingDamageBatch() { throw new Error('injected detection error'); }
    }
    const failing = new FailingDetectionStore(join(root, 'store'));
    const withError = await failing.captureBetween({
        fromSnapshotId: baseline.snapshotId, toSnapshotId: changes.endSnapshotId
    });
    assert.equal(withError.source, 'task-diff');
    assert.deepEqual(withError.files, changes.files);
    assert.equal(withError.diff, changes.diff);
    assert.deepEqual(withError.encodingDamageErrors, changes.files);

    class NoDetectionStore extends SnapshotStore {
        async withEncodingDamage(capture) { return capture; }
    }
    class HangingDetectionStore extends SnapshotStore {
        async detectEncodingDamageBatch() { return new Promise(() => undefined); }
    }
    const withoutDetection = await new NoDetectionStore(join(root, 'store')).captureBetween({
        fromSnapshotId: baseline.snapshotId, toSnapshotId: changes.endSnapshotId
    });
    const timedOut = await new HangingDetectionStore(join(root, 'store'), undefined, {
        encodingDetectionTimeoutMs: 50
    }).captureBetween({ fromSnapshotId: baseline.snapshotId, toSnapshotId: changes.endSnapshotId });
    assert.equal(timedOut.source, withoutDetection.source);
    assert.deepEqual(timedOut.files, withoutDetection.files);
    assert.equal(timedOut.diff, withoutDetection.diff);
    assert.deepEqual(timedOut.encodingDamageErrors, withoutDetection.files);

    const manyWorkspace = join(root, 'many-files');
    await mkdir(manyWorkspace);
    for (let index = 0; index < 30; index++) {
        await writeFile(join(manyWorkspace, `file-${index}.html`), before);
    }
    class CountingDetectionStore extends SnapshotStore {
        detectionGitProcesses = 0;
        detectionActive = false;
        async detectEncodingDamageBatch(...args) {
            this.detectionActive = true;
            try { return await super.detectEncodingDamageBatch(...args); }
            finally { this.detectionActive = false; }
        }
        runGit(args, ...rest) {
            if (this.detectionActive) { this.detectionGitProcesses++; }
            return super.runGit(args, ...rest);
        }
        runGitBuffer(args, ...rest) {
            if (this.detectionActive) { this.detectionGitProcesses++; }
            return super.runGitBuffer(args, ...rest);
        }
    }
    const counting = new CountingDetectionStore(join(root, 'many-store'));
    const manyBaseline = await counting.capture(manyWorkspace);
    for (let index = 0; index < 30; index++) {
        await writeFile(join(manyWorkspace, `file-${index}.html`), damaged);
    }
    const manyChanges = await counting.captureChangeSet(manyBaseline.snapshotId);
    assert.equal(manyChanges.files.length, 30);
    assert.equal(manyChanges.encodingDamage.length, 30);
    assert.equal(counting.detectionGitProcesses, 2);
    console.log(`ENCODING_DAMAGE_GIT_PROCESSES_30_FILES=${counting.detectionGitProcesses}`);
    counting.dispose();
    failing.dispose();
    store.dispose();
} finally {
    await rm(root, { recursive: true, force: true });
}
console.log('encoding-damage tests passed');
