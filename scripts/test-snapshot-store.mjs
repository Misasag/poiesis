import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
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

    const containedWorkspace = join(root, 'contained-internals');
    const containedStore = join(containedWorkspace, '.snapshot-store');
    const containedTemporaryDirectory = join(containedWorkspace, '.temporary');
    await Promise.all([
        mkdir(containedWorkspace, { recursive: true }),
        mkdir(containedTemporaryDirectory, { recursive: true })
    ]);
    await writeFile(join(containedWorkspace, 'kept.txt'), 'keep\n', 'utf8');
    const staleTemporaryRoot = join(containedTemporaryDirectory, 'poiesis-snapshot-index-stale');
    await mkdir(staleTemporaryRoot, { recursive: true });
    await writeFile(join(staleTemporaryRoot, 'index.lock'), 'stale\n', 'utf8');
    const containedSnapshotStore = new SnapshotStore(containedStore, SNAPSHOT_FILE_MAX_BYTES, {
        homePath: join(root, 'unrelated-home'),
        temporaryDirectory: containedTemporaryDirectory
    });
    const containedBaseline = await containedSnapshotStore.capture(containedWorkspace);
    assert.equal(containedBaseline.source, 'git-snapshot', JSON.stringify(containedBaseline));
    const containedGitDir = join(
        containedStore,
        createHash('sha1').update(resolveForSnapshot(containedWorkspace), 'utf8').digest('hex') + '.git'
    );
    const containedTree = await execFileAsync('git', [
        '--git-dir', containedGitDir, 'ls-tree', '-r', '--name-only', containedBaseline.snapshotId
    ], { cwd: containedWorkspace });
    assert.deepEqual(containedTree.stdout.trim().split(/\r?\n/).filter(Boolean), ['kept.txt'],
        'Snapshot storage and temporary indexes inside a Workspace must not enter its tree.');
    await writeFile(join(containedStore, 'untracked-internal.txt'), 'internal\n', 'utf8');
    await writeFile(join(staleTemporaryRoot, 'later.lock'), 'later\n', 'utf8');
    const legacyInternalSnapshot = await writeLegacySnapshot(
        containedStore,
        containedWorkspace,
        containedBaseline.snapshotId,
        ['.snapshot-store/untracked-internal.txt', '.temporary/poiesis-snapshot-index-stale/later.lock']
    );
    const containedCurrent = await containedSnapshotStore.capture(containedWorkspace);
    const containedRange = await containedSnapshotStore.captureBetween({
        fromSnapshotId: containedBaseline.snapshotId,
        toSnapshotId: containedCurrent.snapshotId
    });
    assert.equal(containedRange.source, 'empty');
    assert.deepEqual(containedRange.files, [],
        'Internal storage changes must not appear in change evidence.');
    const legacyInternalRange = await containedSnapshotStore.captureBetween({
        fromSnapshotId: legacyInternalSnapshot,
        toSnapshotId: containedCurrent.snapshotId
    });
    assert.equal(legacyInternalRange.source, 'empty');
    assert.deepEqual(legacyInternalRange.files, [],
        'Previously recorded internal files must not reappear as deletion evidence.');

    const broadParent = join(root, 'broad-parent');
    const testHome = join(broadParent, 'home');
    const testHomeAlias = join(root, 'home-alias');
    const guardStore = join(root, 'guard-store');
    await mkdir(testHome, { recursive: true });
    await symlink(testHome, testHomeAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const guardSnapshotStore = new SnapshotStore(guardStore, SNAPSHOT_FILE_MAX_BYTES, { homePath: testHome });
    for (const broadWorkspace of [testHome, testHomeAlias, broadParent]) {
        const skipped = await guardSnapshotStore.capture(broadWorkspace);
        assert.equal(skipped.source, 'empty');
        assert.equal(skipped.error, 'ホームフォルダー全体では変更を記録しません。');
    }
    const skippedRoot = await guardSnapshotStore.capture(parse(root).root);
    assert.equal(skippedRoot.source, 'empty');
    assert.equal(skippedRoot.error, 'ドライブ全体では変更を記録しません。');
    await mkdir(guardStore, { recursive: true });
    const skippedStore = await guardSnapshotStore.capture(guardStore);
    assert.equal(skippedStore.source, 'empty');
    assert.equal(skippedStore.error, '変更記録の保存場所は記録対象にできません。');

    const legacyHome = join(root, 'legacy-home');
    const legacyHomeStoreRoot = join(root, 'legacy-home-store');
    await mkdir(legacyHome, { recursive: true });
    await writeFile(join(legacyHome, 'preserved.txt'), 'legacy baseline\n', 'utf8');
    const legacyWriter = new SnapshotStore(legacyHomeStoreRoot, SNAPSHOT_FILE_MAX_BYTES, {
        homePath: join(root, 'other-home')
    });
    const legacyHomeBaseline = await legacyWriter.capture(legacyHome);
    assert.equal(legacyHomeBaseline.source, 'git-snapshot', JSON.stringify(legacyHomeBaseline));
    await writeFile(join(legacyHome, 'preserved.txt'), 'must not be captured\n', 'utf8');
    const guardedLegacyStore = new SnapshotStore(legacyHomeStoreRoot, SNAPSHOT_FILE_MAX_BYTES, {
        homePath: legacyHome
    });
    const guardedLegacyChangeSet = await guardedLegacyStore.captureChangeSet(legacyHomeBaseline.snapshotId);
    assert.equal(guardedLegacyChangeSet.source, 'empty');
    assert.equal(guardedLegacyChangeSet.error, 'ホームフォルダー全体では変更を記録しません。');
    assert.equal(guardedLegacyChangeSet.endSnapshotId, undefined,
        'A legacy broad-scope baseline must not cause a new ending tree to be written.');
    const legacyHomeComparison = await guardedLegacyStore.readFileComparison({
        workspacePath: legacyHome,
        fromSnapshotId: legacyHomeBaseline.snapshotId,
        toSnapshotId: legacyHomeBaseline.snapshotId,
        path: 'preserved.txt'
    });
    assert.equal(legacyHomeComparison.source, 'snapshot-file', JSON.stringify(legacyHomeComparison));
    assert.deepEqual(legacyHomeComparison.before, { state: 'text', content: 'legacy baseline\n' },
        'Guarding a new broad capture must not make valid legacy history unreadable.');

    const concurrentWorkspace = join(root, 'concurrent-workspace');
    const concurrentStoreRoot = join(root, 'concurrent-store');
    await mkdir(concurrentWorkspace, { recursive: true });
    await writeFile(join(concurrentWorkspace, 'shared.txt'), 'before\n', 'utf8');
    const concurrentStore = new SnapshotStore(concurrentStoreRoot, SNAPSHOT_FILE_MAX_BYTES, {
        homePath: join(root, 'other-home')
    });
    const concurrentBaseline = await concurrentStore.capture(concurrentWorkspace);
    assert.equal(concurrentBaseline.source, 'git-snapshot', JSON.stringify(concurrentBaseline));
    await writeFile(join(concurrentWorkspace, 'shared.txt'), 'after\n', 'utf8');
    const concurrentChangeSets = await Promise.all([
        concurrentStore.captureChangeSet(concurrentBaseline.snapshotId, 'concurrent-a'),
        concurrentStore.captureChangeSet(concurrentBaseline.snapshotId, 'concurrent-b')
    ]);
    for (const changeSet of concurrentChangeSets) {
        assert.equal(changeSet.source, 'task-diff', JSON.stringify(changeSet));
        assert.deepEqual(changeSet.files, ['shared.txt']);
        assert.match(changeSet.endSnapshotId ?? '', /^[0-9a-f]{40}$/);
        assert.equal(changeSet.error, undefined,
            'Concurrent ending captures on one Workspace must not report a false missing snapshot.');
    }

    const isolatedWorkspace = join(root, 'isolated-config-workspace');
    const isolatedStoreRoot = join(root, 'isolated-config-store');
    const controlledConfig = join(root, 'controlled-global.gitconfig');
    const controlledHooks = join(root, 'controlled-hooks');
    const hookMarker = join(root, 'hook-invoked.txt');
    const filterMarker = join(root, 'filter-invoked.txt');
    const processMarker = join(root, 'filter-process-invoked.txt');
    const fsmonitorMarker = join(root, 'fsmonitor-invoked.txt');
    const filterScript = join(root, 'filter-clean.sh');
    const processScript = join(root, 'filter-process.sh');
    const fsmonitorScript = join(root, 'fsmonitor.sh');
    await Promise.all([
        mkdir(isolatedWorkspace, { recursive: true }),
        mkdir(controlledHooks, { recursive: true })
    ]);
    await execFileAsync('git', ['init'], { cwd: isolatedWorkspace });
    await writeExecutableScript(join(controlledHooks, 'post-index-change'), hookMarker, true);
    await writeExecutableScript(filterScript, filterMarker, true);
    await writeExecutableScript(processScript, processMarker, false);
    await writeExecutableScript(fsmonitorScript, fsmonitorMarker, false);
    await execFileAsync('git', ['config', '--file', controlledConfig, 'core.hooksPath', shellPath(controlledHooks)]);
    await execFileAsync('git', ['config', '--file', controlledConfig, 'core.fsmonitor', shellPath(fsmonitorScript)]);
    await execFileAsync('git', ['config', '--file', controlledConfig, 'filter.tripwire.clean', shellPath(filterScript)]);
    await execFileAsync('git', ['config', '--file', controlledConfig, 'filter.tripwire.process', shellPath(processScript)]);
    await execFileAsync('git', ['config', '--file', controlledConfig, 'filter.tripwire.required', 'true']);
    await writeFile(join(isolatedWorkspace, '.gitattributes'), '*.lfs filter=tripwire text\n', 'utf8');
    const rawBefore = 'version https://git-lfs.github.com/spec/v1\nbefore raw workspace bytes\n';
    const rawAfter = 'version https://git-lfs.github.com/spec/v1\nafter raw workspace bytes\n';
    await writeFile(join(isolatedWorkspace, 'asset.lfs'), rawBefore, 'utf8');
    const isolatedStore = new SnapshotStore(isolatedStoreRoot, SNAPSHOT_FILE_MAX_BYTES, {
        homePath: join(root, 'other-home'),
        gitEnvironment: {
            ...process.env,
            GIT_CONFIG_GLOBAL: controlledConfig,
            GIT_CONFIG_NOSYSTEM: '1'
        }
    });
    const isolatedBaseline = await isolatedStore.capture(isolatedWorkspace);
    assert.equal(isolatedBaseline.source, 'git-snapshot', JSON.stringify(isolatedBaseline));
    await writeFile(join(isolatedWorkspace, 'asset.lfs'), rawAfter, 'utf8');
    const isolatedCurrent = await isolatedStore.capture(isolatedWorkspace);
    assert.equal(isolatedCurrent.source, 'git-snapshot', JSON.stringify(isolatedCurrent));
    const rawComparison = await isolatedStore.readFileComparison({
        workspacePath: isolatedWorkspace,
        fromSnapshotId: isolatedBaseline.snapshotId,
        toSnapshotId: isolatedCurrent.snapshotId,
        path: 'asset.lfs'
    });
    assert.equal(rawComparison.source, 'snapshot-file', JSON.stringify(rawComparison));
    assert.deepEqual(rawComparison.before, { state: 'text', content: rawBefore });
    assert.deepEqual(rawComparison.after, { state: 'text', content: rawAfter });
    for (const marker of [hookMarker, filterMarker, processMarker, fsmonitorMarker]) {
        assert.equal(await exists(marker), false,
            `Snapshot Git unexpectedly invoked configured external behavior: ${marker}`);
    }

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

async function writeLegacySnapshot(storeRoot, workspace, baseSnapshotId, paths = ['.npm-cache']) {
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
        await execFileAsync('git', ['add', '-A', '-f', '--', ...paths], { cwd: workspace, env });
        const { stdout } = await execFileAsync('git', ['write-tree'], { cwd: workspace, env, encoding: 'utf8' });
        return stdout.trim();
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
}

async function writeExecutableScript(path, marker, passthrough) {
    const body = [
        '#!/bin/sh',
        `printf invoked > "${shellPath(marker)}"`,
        passthrough ? 'cat' : 'exit 1',
        ''
    ].join('\n');
    await writeFile(path, body, 'utf8');
    await chmod(path, 0o755);
}

function shellPath(path) {
    return path.replace(/\\/g, '/').replace(/"/g, '\\"');
}

async function exists(path) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function resolveForSnapshot(workspace) {
    const normalized = join(workspace).replace(/\\/g, '/').replace(/\/$/, '');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}
