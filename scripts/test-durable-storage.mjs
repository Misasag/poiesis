import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DurableDataStore } from '../agent-window/lib/common/durable-data-store.js';
import { DurableFileStore } from '../agent-window/lib/node/durable-storage-server.js';

const fixtureRoot = await mkdtemp(join(tmpdir(), 'poiesis-durable-storage-'));
const adapterFor = fileStore => ({
    read: key => fileStore.read(key),
    write: (key, contents) => fileStore.write(key, contents)
});

try {
    const productionFiles = new DurableFileStore(fixtureRoot);
    const activeLockPath = join(fixtureRoot, 'active-owner.json.lock');
    await writeFile(activeLockPath, JSON.stringify({ pid: process.pid, token: 'active-owner' }), 'utf8');
    const oldLockTime = new Date(Date.now() - 180_000);
    await utimes(activeLockPath, oldLockTime, oldLockTime);
    assert.equal(await productionFiles.removeAbandonedLock(activeLockPath), false,
        'An old lock must remain owned while its process is still alive.');
    assert((await stat(activeLockPath)).isFile(), 'A competing writer must not remove a live owner lock.');
    await rm(activeLockPath);
    const legacyState = {
        version: 1,
        sessions: [{
            id: 'legacy-session',
            tasks: [{
                id: 'legacy-task',
                resultsDocument: {
                    taskId: 'legacy-task',
                    status: 'ready',
                    html: '<!doctype html><html><body><h1>Valid legacy Result</h1></body></html>'
                }
            }]
        }]
    };
    const migrationFailures = [];
    const migratingStore = new DurableDataStore(
        adapterFor(productionFiles),
        { getData: async key => key === 'sessions' ? legacyState : undefined },
        failure => migrationFailures.push(failure)
    );
    assert.deepEqual(await migratingStore.getData('sessions'), legacyState);
    assert.equal(migrationFailures.length, 0);
    assert.match((await migratingStore.getData('sessions')).sessions[0].tasks[0].resultsDocument.html, /Valid legacy Result/,
        'A valid legacy Result must stay readable after migration.');

    const largeStore = new DurableDataStore(adapterFor(productionFiles));
    const largeResults = Array.from({ length: 18 }, (_, index) => ({
        id: `task-${index}`,
        resultsDocument: { taskId: `task-${index}`, status: 'ready', html: `<html>${'x'.repeat(300_000)}</html>` }
    }));
    await largeStore.setData('large-results', { version: 1, tasks: largeResults });
    const durableBytes = Buffer.byteLength(await productionFiles.read('large-results'), 'utf8');
    assert(durableBytes > 5 * 1024 * 1024, `Durable fixture did not exceed a small browser quota: ${durableBytes}`);
    assert.equal((await largeStore.getData('large-results')).tasks.length, 18,
        'More than ten large Results must round-trip through the production file persistence boundary.');

    const orderedStore = new DurableDataStore(adapterFor(productionFiles));
    const first = orderedStore.setData('rapid', { value: 1 });
    const second = orderedStore.setData('rapid', { value: 2 });
    const third = orderedStore.setData('rapid', { value: 3 });
    assert.deepEqual(await orderedStore.getData('rapid'), { value: 3 },
        'A read must wait for the newest queued write.');
    await Promise.all([first, second, third]);
    assert.deepEqual(await new DurableDataStore(adapterFor(new DurableFileStore(fixtureRoot))).getData('rapid'), { value: 3 },
        'A new store instance must reload the newest completed write.');

    const competingFilesA = new DurableFileStore(fixtureRoot);
    const competingFilesB = new DurableFileStore(fixtureRoot);
    const competingValues = [JSON.stringify({ writer: 'a', body: 'a'.repeat(150_000) }),
        JSON.stringify({ writer: 'b', body: 'b'.repeat(150_000) })];
    await Promise.all([
        competingFilesA.write('competing-writers', competingValues[0]),
        competingFilesB.write('competing-writers', competingValues[1])
    ]);
    const competingSaved = await new DurableFileStore(fixtureRoot).read('competing-writers');
    assert(competingValues.includes(competingSaved),
        'Separate backend clients must be serialized by the filesystem lock without producing a mixed value.');

    let failInstall = false;
    let failRestore = false;
    const replacementFiles = new DurableFileStore(fixtureRoot, {
        beforeInstall(key) {
            if (key === 'replacement' && failInstall) {
                failInstall = false;
                throw new Error('injected replacement-stage failure');
            }
        },
        beforeRestore(key) {
            if (key === 'replacement' && failRestore) {
                failRestore = false;
                throw new Error('injected immediate-restore failure');
            }
        }
    });
    const failures = [];
    const replacementStore = new DurableDataStore(
        adapterFor(replacementFiles),
        undefined,
        failure => failures.push(failure)
    );
    await replacementStore.setData('replacement', { value: 'readable previous state' });
    failInstall = true;
    failRestore = true;
    await assert.rejects(
        replacementStore.setData('replacement', { value: 'not persisted' }),
        /injected replacement-stage failure/
    );
    await Promise.resolve();
    assert(failures.some(failure => failure.operation === 'write' && failure.key === 'replacement'));
    assert((await readdir(fixtureRoot)).some(name => name === 'replacement.json.bak'),
        'The previous successful value must survive when replacement and immediate restoration both fail.');
    const reloadedStore = new DurableDataStore(adapterFor(new DurableFileStore(fixtureRoot)));
    assert.deepEqual(await reloadedStore.getData('replacement'), { value: 'readable previous state' },
        'A real reload must recover the last successful value from the replacement journal.');
    assert((await readdir(fixtureRoot)).includes('replacement.json'),
        'Reload recovery must restore the normal target file.');
    await replacementStore.setData('replacement', { value: 'recovered' });
    assert.deepEqual(await replacementStore.getData('replacement'), { value: 'recovered' },
        'A later write must proceed after an earlier rejected replacement.');

    let failMigration = true;
    const migrationFailureFiles = new DurableFileStore(fixtureRoot, {
        beforeInstall(key) {
            if (key === 'retry-migration' && failMigration) {
                failMigration = false;
                throw new Error('injected migration write failure');
            }
        }
    });
    const migrationFailureEvents = [];
    const migrationFailureStore = new DurableDataStore(
        adapterFor(migrationFailureFiles),
        { getData: async () => legacyState },
        failure => migrationFailureEvents.push(failure)
    );
    assert.deepEqual(await migrationFailureStore.getData('retry-migration'), legacyState,
        'A migration failure must not hide readable legacy state.');
    assert(migrationFailureEvents.some(failure => failure.operation === 'migrate'));
    assert.deepEqual(await migrationFailureStore.getData('retry-migration'), legacyState);
    assert.deepEqual(
        await new DurableDataStore(adapterFor(new DurableFileStore(fixtureRoot))).getData('retry-migration'),
        legacyState,
        'A later read must retry and durably complete an incomplete migration.'
    );

    console.log(`DURABLE_STORAGE_TEST=${JSON.stringify({
        largeResults: 18,
        durableBytes,
        serializedWrites: 3,
        coordinatedWriters: 2,
        replacementFailureRecoveredOnReload: true
    })}`);
} finally {
    await rm(fixtureRoot, { recursive: true, force: true });
}
