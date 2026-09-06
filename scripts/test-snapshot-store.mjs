import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
    normalizeSnapshotPath,
    SNAPSHOT_FILE_MAX_BYTES,
    SnapshotStore
} from '../agent-window/lib/node/snapshot-store.js';

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

        const comparison = await secondStore.readFileComparison({
            workspacePath: workspace,
            fromSnapshotId: baseline.snapshotId,
            toSnapshotId: current.snapshotId,
            path: 'one.txt'
        });
        assert.equal(comparison.source, 'snapshot-file', JSON.stringify(comparison));
        assert.deepEqual(comparison.before, { state: 'text', content: 'before\n' });
        assert.deepEqual(comparison.after, { state: 'text', content: 'after\n' });

        const oversizedComparison = await new SnapshotStore(storeRoot, 3).readFileComparison({
            workspacePath: workspace,
            fromSnapshotId: baseline.snapshotId,
            toSnapshotId: current.snapshotId,
            path: 'one.txt'
        });
        assert.equal(oversizedComparison.source, 'unavailable');
        assert.equal(oversizedComparison.error, 'ファイルが大きすぎるため、変更を表示できません。');

        const addedComparison = await secondStore.readFileComparison({
            workspacePath: workspace,
            fromSnapshotId: baseline.snapshotId,
            toSnapshotId: current.snapshotId,
            path: 'two.txt'
        });
        assert.deepEqual(addedComparison.before, { state: 'missing' });
        assert.deepEqual(addedComparison.after, { state: 'text', content: 'added\n' });

        const wrongWorkspace = await secondStore.readFileComparison({
            workspacePath: join(root, 'not-the-workspace'),
            fromSnapshotId: baseline.snapshotId,
            toSnapshotId: current.snapshotId,
            path: 'one.txt'
        });
        assert.equal(wrongWorkspace.source, 'unavailable');
        assert.equal(wrongWorkspace.error, 'このワークスペースの変更ではありません。');

        for (const path of ['../one.txt', 'src/../../one.txt', '/one.txt', 'C:\\one.txt', 'src//one.txt']) {
            const invalidPath = await secondStore.readFileComparison({
                workspacePath: workspace,
                fromSnapshotId: baseline.snapshotId,
                toSnapshotId: current.snapshotId,
                path
            });
            assert.equal(invalidPath.source, 'unavailable', `Unsafe snapshot path was accepted: ${path}`);
            assert.equal(invalidPath.error, 'ファイルを特定できません。');
        }

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

        await writeFile(join(workspace, 'binary.dat'), Buffer.concat([
            Buffer.alloc(1_024, 65),
            Buffer.from([0])
        ]));
        const binarySnapshot = await firstStore.capture(workspace);
        const binaryComparison = await secondStore.readFileComparison({
            workspacePath: workspace,
            fromSnapshotId: afterLegacySnapshot.snapshotId,
            toSnapshotId: binarySnapshot.snapshotId,
            path: 'binary.dat'
        });
        assert.equal(binaryComparison.source, 'unavailable');
        assert.equal(binaryComparison.error, 'バイナリファイルの変更は表示できません。');

        await rm(join(workspace, 'two.txt'));
        const deletedSnapshot = await firstStore.capture(workspace);
        const deletedComparison = await secondStore.readFileComparison({
            workspacePath: workspace,
            fromSnapshotId: binarySnapshot.snapshotId,
            toSnapshotId: deletedSnapshot.snapshotId,
            path: 'two.txt'
        });
        assert.deepEqual(deletedComparison.before, { state: 'text', content: 'added\n' });
        assert.deepEqual(deletedComparison.after, { state: 'missing' });
    }

    const identicalWorkspaceA = join(root, 'identical-a');
    const identicalWorkspaceB = join(root, 'identical-b');
    await Promise.all([
        mkdir(identicalWorkspaceA, { recursive: true }),
        mkdir(identicalWorkspaceB, { recursive: true })
    ]);
    await Promise.all([
        writeFile(join(identicalWorkspaceA, 'same.txt'), 'identical\n', 'utf8'),
        writeFile(join(identicalWorkspaceB, 'same.txt'), 'identical\n', 'utf8')
    ]);
    const identicalStore = new SnapshotStore(storeRoot);
    const identicalA = await identicalStore.capture(identicalWorkspaceA);
    const identicalB = await identicalStore.capture(identicalWorkspaceB);
    assert.equal(identicalA.snapshotId, identicalB.snapshotId,
        'Identical workspace trees should reproduce the same Git tree object ID.');
    const requestedWorkspaceComparison = await new SnapshotStore(storeRoot).readFileComparison({
        workspacePath: identicalWorkspaceA,
        fromSnapshotId: identicalA.snapshotId,
        toSnapshotId: identicalA.snapshotId,
        path: 'same.txt'
    });
    assert.equal(requestedWorkspaceComparison.source, 'snapshot-file',
        'Snapshot lookup must select the requested workspace when object IDs exist in multiple stores.');
    assert.deepEqual(requestedWorkspaceComparison.before, { state: 'text', content: 'identical\n' });
    assert.deepEqual(requestedWorkspaceComparison.after, { state: 'text', content: 'identical\n' });

    const missing = await new SnapshotStore(storeRoot).captureBetween({
        fromSnapshotId: '0'.repeat(40),
        toSnapshotId: '1'.repeat(40)
    });
    assert.equal(missing.source, 'empty');
    assert.equal(missing.error, 'スナップショットが見つかりません。');
    const missingComparison = await new SnapshotStore(storeRoot).readFileComparison({
        workspacePath: root,
        fromSnapshotId: '0'.repeat(40),
        toSnapshotId: '1'.repeat(40),
        path: 'one.txt'
    });
    assert.equal(missingComparison.source, 'unavailable');
    assert.equal(missingComparison.error, '保存された変更を利用できません。');
    assert.equal(SNAPSHOT_FILE_MAX_BYTES, 50 * 1024 * 1024);
    assert.equal(normalizeSnapshotPath('./src/file.ts'), 'src/file.ts');
    assert.equal(normalizeSnapshotPath('src\\file.ts'), 'src/file.ts');
    assert.equal(normalizeSnapshotPath('../file.ts'), undefined);
    assert.equal(normalizeSnapshotPath('src/../file.ts'), undefined);
    assert.equal(normalizeSnapshotPath('src//file.ts'), undefined);
    assert.equal(normalizeSnapshotPath(''), undefined);
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
