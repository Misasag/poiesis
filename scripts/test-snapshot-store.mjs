import assert from 'node:assert/strict';
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
