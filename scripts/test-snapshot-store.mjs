import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SnapshotStore } from '../agent-window/lib/node/snapshot-store.js';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'poiesis-snapshot-test-'));
const storeRoot = join(root, 'store');

try {
    for (const kind of ['git', 'plain']) {
        const workspace = join(root, kind);
        await mkdir(workspace, { recursive: true });
        if (kind === 'git') {
            await execFileAsync('git', ['init'], { cwd: workspace });
        }
        await writeFile(join(workspace, 'one.txt'), 'before\n', 'utf8');
        await writeFile(join(workspace, 'untouched.txt'), 'same\n', 'utf8');

        const firstStore = new SnapshotStore(storeRoot);
        const baseline = await firstStore.capture(workspace);
        assert.equal(baseline.source, 'git-snapshot');
        assert.match(baseline.snapshotId ?? '', /^[0-9a-f]{40}$/);

        await writeFile(join(workspace, 'one.txt'), 'after\n', 'utf8');
        await writeFile(join(workspace, 'two.txt'), 'added\n', 'utf8');
        const current = await firstStore.capture(workspace);
        assert.equal(current.source, 'git-snapshot');

        const secondStore = new SnapshotStore(storeRoot);
        const range = await secondStore.captureBetween({
            fromSnapshotId: baseline.snapshotId,
            toSnapshotId: current.snapshotId
        });
        assert.equal(range.source, 'task-diff');
        assert.deepEqual(range.files, ['one.txt', 'two.txt']);
        assert.match(range.diff, /diff --git a\/one\.txt b\/one\.txt/);

        const filtered = await secondStore.captureBetween({
            fromSnapshotId: baseline.snapshotId,
            toSnapshotId: current.snapshotId,
            paths: ['two.txt']
        });
        assert.equal(filtered.source, 'task-diff');
        assert.deepEqual(filtered.files, ['two.txt']);
        assert.doesNotMatch(filtered.diff, /one\.txt/);

        let cacheBaseline = current;
        const trackedCachePath = '.npm-cache/_logs/user-authored.txt';
        if (kind === 'git') {
            await mkdir(join(workspace, '.npm-cache', '_logs'), { recursive: true });
            await writeFile(join(workspace, ...trackedCachePath.split('/')), 'tracked before\n', 'utf8');
            await execFileAsync('git', ['add', '--', trackedCachePath], { cwd: workspace });
            const trackedSnapshot = await firstStore.capture(workspace);
            const trackedRange = await secondStore.captureBetween({
                fromSnapshotId: current.snapshotId,
                toSnapshotId: trackedSnapshot.snapshotId
            });
            assert.deepEqual(trackedRange.files, [trackedCachePath],
                'A user-authored Git tracked file under a similarly named directory must be preserved.');
            assert.match(trackedRange.diff, /user-authored\.txt/);
            cacheBaseline = trackedSnapshot;
        }

        await writeNpmRuntimeArtifacts(workspace, 'first');
        const cacheOnlySnapshot = await firstStore.capture(workspace);
        const cacheOnly = await secondStore.captureBetween({
            fromSnapshotId: cacheBaseline.snapshotId,
            toSnapshotId: cacheOnlySnapshot.snapshotId
        });
        assert.equal(cacheOnly.source, 'empty');
        assert.deepEqual(cacheOnly.files, [], `${kind} cache-only changes must not become task evidence.`);
        assert.equal(cacheOnly.diff, '');

        await writeFile(join(workspace, 'README.md'), 'source change\n', 'utf8');
        await writeNpmRuntimeArtifacts(workspace, 'second');
        const mixedSnapshot = await firstStore.capture(workspace);
        const mixed = await secondStore.captureBetween({
            fromSnapshotId: cacheOnlySnapshot.snapshotId,
            toSnapshotId: mixedSnapshot.snapshotId
        });
        assert.equal(mixed.source, 'task-diff');
        assert.deepEqual(mixed.files, ['README.md'], `${kind} mixed changes must retain only source evidence.`);
        assert.match(mixed.diff, /diff --git a\/README\.md b\/README\.md/);
        assert.doesNotMatch(mixed.diff, /\.npm-cache/);

        const legacySnapshotId = await writeLegacySnapshot(storeRoot, workspace, mixedSnapshot.snapshotId);
        await writeFile(join(workspace, 'README.md'), 'source change after legacy snapshot\n', 'utf8');
        await writeNpmRuntimeArtifacts(workspace, 'third');
        const afterLegacySnapshot = await firstStore.capture(workspace);
        const legacyRange = await secondStore.captureBetween({
            fromSnapshotId: legacySnapshotId,
            toSnapshotId: afterLegacySnapshot.snapshotId
        });
        assert.deepEqual(legacyRange.files, ['README.md'],
            `${kind} legacy cache entries must be filtered from file evidence.`);
        assert.doesNotMatch(legacyRange.diff, /\.npm-cache/,
            `${kind} legacy cache entries must be filtered from diff evidence.`);

        const legacyCacheOnly = await secondStore.captureBetween({
            fromSnapshotId: legacySnapshotId,
            toSnapshotId: afterLegacySnapshot.snapshotId,
            paths: ['.npm-cache/_npx/session/package.json']
        });
        assert.equal(legacyCacheOnly.source, 'empty');
        assert.deepEqual(legacyCacheOnly.files, []);
        assert.equal(legacyCacheOnly.diff, '');

        const cumulative = await secondStore.captureBetween({
            fromSnapshotId: legacySnapshotId,
            toSnapshotId: afterLegacySnapshot.snapshotId,
            paths: ['.npm-cache/_cacache/content-v2/blob', 'README.md']
        });
        assert.deepEqual(cumulative.files, ['README.md'],
            `${kind} cumulative filtering must retain source evidence only.`);
        assert.doesNotMatch(cumulative.diff, /\.npm-cache/);
    }

    const missing = await new SnapshotStore(storeRoot).captureBetween({
        fromSnapshotId: '0'.repeat(40),
        toSnapshotId: '1'.repeat(40)
    });
    assert.equal(missing.source, 'empty');
    assert.equal(missing.error, 'スナップショットが見つかりません。');
    console.log('snapshot-store tests passed');
} finally {
    await rm(root, { recursive: true, force: true });
}

async function writeNpmRuntimeArtifacts(workspace, marker) {
    const files = [
        ['.npm-cache', '_npx', 'session', 'package.json'],
        ['.npm-cache', '_cacache', 'content-v2', 'blob'],
        ['.npm-cache', '_logs', 'startup.log'],
        ['.npm-cache', '_update-notifier-last-checked']
    ];
    for (const segments of files) {
        const target = join(workspace, ...segments);
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, `${marker}\n`, 'utf8');
    }
}

async function writeLegacySnapshot(storeRoot, workspace, baseSnapshotId) {
    const normalized = resolveForSnapshot(workspace);
    const repository = join(storeRoot, `${createHash('sha1').update(normalized, 'utf8').digest('hex')}.git`);
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'poiesis-legacy-snapshot-index-'));
    const env = {
        ...process.env,
        GIT_DIR: repository,
        GIT_WORK_TREE: workspace,
        GIT_INDEX_FILE: join(temporaryRoot, 'index')
    };
    try {
        await execFileAsync('git', ['read-tree', baseSnapshotId], { cwd: workspace, env });
        await execFileAsync('git', ['add', '-A', '-f', '--', '.npm-cache'], { cwd: workspace, env });
        const { stdout } = await execFileAsync('git', ['write-tree'], { cwd: workspace, env, encoding: 'utf8' });
        return stdout.trim();
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
}

function resolveForSnapshot(workspace) {
    const normalized = join(workspace).replace(/\\/g, '/').replace(/\/$/, '');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}
