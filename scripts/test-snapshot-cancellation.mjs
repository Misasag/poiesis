import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntimeServerImpl } from '../agent-window/lib/node/agent-runtime-server.js';
import { killHiddenProcessTree } from '../agent-window/lib/node/hidden-process.js';
import { SnapshotStore } from '../agent-window/lib/node/snapshot-store.js';

const root = await mkdtemp(join(tmpdir(), 'poiesis-snapshot-cancellation-'));
const fakeGitPath = join(root, 'fake-git.mjs');
const descendantPath = join(root, 'descendant.mjs');
const lookupGitPath = join(root, 'lookup-git.mjs');
const unsafeGitPath = join(root, 'unsafe-git.mjs');

try {
    await writeFile(descendantPath, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid), 'utf8');
setInterval(() => undefined, 1_000);
`, 'utf8');
    await writeFile(fakeGitPath, `
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [statePath, descendantPath, processMarker, ...args] = process.argv.slice(2);
if (args.includes('init')) {
    mkdirSync(args.at(-1), { recursive: true });
    process.exit(0);
}
if (args.includes('read-tree')) {
    mkdirSync(dirname(process.env.GIT_INDEX_FILE), { recursive: true });
    writeFileSync(process.env.GIT_INDEX_FILE, '', 'utf8');
    process.exit(0);
}
if (args.includes('ls-files') || args.includes('config')) {
    process.exit(0);
}
if (args.includes('add')) {
    const count = existsSync(statePath) ? Number(readFileSync(statePath, 'utf8')) : 0;
    writeFileSync(statePath, String(count + 1), 'utf8');
    if (count === 0) {
        writeFileSync(process.env.GIT_INDEX_FILE + '.lock', 'locked', 'utf8');
        const childMarker = processMarker + '.child';
        const descendant = spawn(process.execPath, [descendantPath, childMarker], {
            windowsHide: true,
            shell: false,
            stdio: 'ignore'
        });
        writeFileSync(processMarker, JSON.stringify({ parent: process.pid, child: descendant.pid }), 'utf8');
        setInterval(() => undefined, 1_000);
        await new Promise(() => undefined);
    } else {
        process.exit(0);
    }
}
if (args.includes('write-tree')) {
    process.stdout.write('0123456789012345678901234567890123456789\\n', () => process.exit(0));
} else {
    process.exit(0);
}
`, 'utf8');
    await writeFile(lookupGitPath, `
import { appendFileSync, writeFileSync } from 'node:fs';
const [logPath, processMarker, ...args] = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(args) + '\\n', 'utf8');
writeFileSync(processMarker, String(process.pid), 'utf8');
setInterval(() => undefined, 1_000);
await new Promise(() => undefined);
`, 'utf8');
    await writeFile(unsafeGitPath, `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const [logPath, processMarker, ...args] = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(args) + '\\n', 'utf8');
if (args.includes('init')) {
    mkdirSync(args.at(-1), { recursive: true });
    process.exit(0);
}
if (args.includes('config')) {
    process.exit(0);
}
if (args.includes('ls-files')) {
    writeFileSync(processMarker, String(process.pid), 'utf8');
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
}
process.exit(0);
`, 'utf8');

    const timeout = await runTimeoutCase();
    const queued = await runQueuedCancellationCase();
    const disposed = await runDisposeCase();
    const preSpawnCancellation = await runPreSpawnCancellationCase();
    const delayedResolution = await runDelayedWorkspaceResolutionCase();
    const postStopChangeCapture = await runPostStopChangeCaptureCase();
    const cancelledLookup = await runRepositoryLookupAbortCase('cancel');
    const timedOutLookup = await runRepositoryLookupAbortCase('timeout');
    const stickyCleanupFailure = await runStickyCleanupFailureCase();
    const failedTreeKill = await runFailedTreeKillCase();
    console.log(`SNAPSHOT_CANCELLATION_TEST=${JSON.stringify({
        timeout,
        queued,
        disposed,
        preSpawnCancellation,
        delayedResolution,
        postStopChangeCapture,
        cancelledLookup,
        timedOutLookup,
        stickyCleanupFailure,
        failedTreeKill
    })}`);
} finally {
    await rm(root, { recursive: true, force: true });
}

async function runTimeoutCase() {
    const fixture = await createFixture('timeout');
    const store = snapshotStore(fixture, 1_000);
    const startedAt = Date.now();
    const capture = await store.capture(fixture.workspace, 'timeout-task');
    const elapsedMs = Date.now() - startedAt;
    assert.equal(capture.source, 'empty');
    assert.equal(capture.error, '変更の記録が時間内に完了しませんでした。');
    assert(elapsedMs < 4_000, `Timed-out capture took ${elapsedMs}ms.`);
    const pids = await recordedPids(fixture.processMarker);
    await assertProcessesGone(pids);
    await assertTemporaryIndexesRemoved(fixture.temporaryDirectory);
    return { elapsedMs, descendantsStopped: true, temporaryIndexesRemoved: true };
}

async function runQueuedCancellationCase() {
    const fixture = await createFixture('queued');
    const store = snapshotStore(fixture, 5_000);
    const activePromise = store.capture(fixture.workspace, 'active-task');
    await waitForFile(fixture.processMarker);
    const queuedPromise = store.capture(fixture.workspace, 'queued-task');
    const cancelStartedAt = Date.now();
    await store.cancel('queued-task');
    const queuedCapture = await queuedPromise;
    const queuedCancelMs = Date.now() - cancelStartedAt;
    assert.equal(queuedCapture.error, '変更の記録をキャンセルしました。');
    assert(queuedCancelMs < 1_000, `Queued cancellation took ${queuedCancelMs}ms.`);
    await store.cancel('active-task');
    const activeCapture = await activePromise;
    assert.equal(activeCapture.error, '変更の記録をキャンセルしました。');
    await assertProcessesGone(await recordedPids(fixture.processMarker));
    const subsequent = await store.capture(fixture.workspace, 'subsequent-task');
    assert.equal(subsequent.source, 'git-snapshot', JSON.stringify(subsequent));
    assert.match(subsequent.snapshotId ?? '', /^[0-9a-f]{40}$/);
    await assertTemporaryIndexesRemoved(fixture.temporaryDirectory);
    return { queuedCancelMs, subsequentCaptureSucceeded: true };
}

async function runDisposeCase() {
    const fixture = await createFixture('dispose');
    const store = snapshotStore(fixture, 5_000);
    const capturePromise = store.capture(fixture.workspace, 'dispose-task');
    await waitForFile(fixture.processMarker);
    store.dispose();
    const capture = await capturePromise;
    assert.equal(capture.error, '変更の記録をキャンセルしました。');
    await assertProcessesGone(await recordedPids(fixture.processMarker));
    await assertTemporaryIndexesRemoved(fixture.temporaryDirectory);
    return { descendantsStopped: true, temporaryIndexesRemoved: true };
}

async function runPreSpawnCancellationCase() {
    let providerResolved = false;
    const server = new AgentRuntimeServerImpl(
        {},
        { async resolve() { providerResolved = true; throw new Error('Provider must not be resolved.'); } },
        {}
    );
    await server.cancelCodex('pre-spawn-task');
    await assert.rejects(server.runCodex({
        executionId: 'pre-spawn-task',
        providerId: 'codex',
        workspacePath: root,
        prompt: 'This must not launch.'
    }), /cancelled/);
    assert.equal(providerResolved, false,
        'A cancellation received before process registration must prevent later Agent launch.');
    server.dispose();
    return { laterAgentLaunchPrevented: true };
}

async function runDelayedWorkspaceResolutionCase() {
    let providerResolved = false;
    let snapshotCaptures = 0;
    const resolutionStarted = deferred();
    const resolutionRelease = deferred();
    const server = new AgentRuntimeServerImpl(
        {},
        { async resolve() { providerResolved = true; throw new Error('Provider must not be resolved.'); } },
        {}
    );
    server.resolveWorkspace = async () => {
        resolutionStarted.resolve();
        await resolutionRelease.promise;
        return root;
    };
    server.snapshotStore.capture = async () => {
        snapshotCaptures += 1;
        return { source: 'empty', error: 'Snapshot capture must not start.' };
    };
    const taskId = 'delayed-workspace-task';
    const request = server.captureGitSnapshot({ workspacePath: root, taskId })
        .then(() => server.runCodex({
            executionId: taskId,
            providerId: 'codex',
            workspacePath: root,
            prompt: 'This must not launch.'
        }));
    await resolutionStarted.promise;
    await server.cancelCodex(taskId);
    resolutionRelease.resolve();
    await assert.rejects(request, /cancelled/);
    assert.equal(snapshotCaptures, 0,
        'A cancellation during workspace resolution must prevent later snapshot registration.');
    assert.equal(providerResolved, false,
        'A cancellation during workspace resolution must prevent later Agent launch.');
    server.dispose();
    return { snapshotPrevented: true, agentLaunchPrevented: true };
}

async function runPostStopChangeCaptureCase() {
    const taskId = 'running-cancelled-task';
    let cancelledSnapshotId;
    let capturedRequest;
    let processStopped = false;
    const process = { kill() { return true; } };
    const server = new AgentRuntimeServerImpl({}, {}, {});
    server.snapshotStore.cancel = async captureId => { cancelledSnapshotId = captureId; };
    server.snapshotStore.captureChangeSet = async (baselineSnapshotId, captureId) => {
        capturedRequest = { baselineSnapshotId, captureId };
        return {
            source: 'task-diff',
            diff: 'post-stop change',
            files: ['changed-after-start.txt'],
            endSnapshotId: 'b'.repeat(40)
        };
    };
    server.killProcess = async child => {
        assert.equal(child, process);
        processStopped = true;
    };
    server.codexRuns.set(taskId, { process, cancelled: false });

    await server.cancelCodex(taskId);
    assert.equal(cancelledSnapshotId, taskId,
        'Stopping a running Agent must still cancel an in-flight snapshot for the same Task.');
    assert.equal(processStopped, true);
    assert.equal(server.codexRuns.get(taskId)?.cancelled, true);
    const capture = await server.captureGitChangeSet({
        baselineSnapshotId: 'a'.repeat(40),
        taskId
    });
    assert.deepEqual(capturedRequest, { baselineSnapshotId: 'a'.repeat(40), captureId: taskId },
        'The real runtime must allow a fresh ending capture after Agent cancellation finishes.');
    assert.deepEqual(capture.files, ['changed-after-start.txt']);
    server.dispose();
    return { activeSnapshotCancelled: true, processStopped: true, endingCaptureAllowed: true };
}

async function runRepositoryLookupAbortCase(mode) {
    const fixtureRoot = join(root, `lookup-${mode}`);
    const storeRoot = join(fixtureRoot, 'store');
    const logPath = join(fixtureRoot, 'commands.log');
    const processMarker = join(fixtureRoot, 'process.pid');
    await mkdir(storeRoot, { recursive: true });
    await Promise.all(Array.from({ length: 64 }, (_, index) =>
        mkdir(join(storeRoot, `candidate-${String(index).padStart(2, '0')}.git`), { recursive: true })
    ));
    const store = new SnapshotStore(storeRoot, undefined, {
        captureTimeoutMs: mode === 'timeout' ? 500 : 5_000,
        processCleanupTimeoutMs: 2_000,
        homePath: join(root, 'unrelated-home'),
        gitInvocation: {
            executable: process.execPath,
            argsPrefix: [lookupGitPath, logPath, processMarker]
        }
    });
    const captureId = `lookup-${mode}-task`;
    const startedAt = Date.now();
    const capturePromise = store.captureChangeSet('a'.repeat(40), captureId);
    if (mode === 'cancel') {
        await waitForFile(processMarker);
        await store.cancel(captureId);
    }
    const capture = await capturePromise;
    const elapsedMs = Date.now() - startedAt;
    assert.equal(capture.source, 'empty');
    assert.equal(capture.error, mode === 'cancel'
        ? '変更の記録をキャンセルしました。'
        : '変更の記録が時間内に完了しませんでした。');
    assert(elapsedMs < 4_000, `${mode} repository lookup took ${elapsedMs}ms.`);
    const commands = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    assert.equal(commands.length, 1,
        'Repository lookup must not spawn another Git process after cancellation or timeout.');
    await assertProcessesGone([Number(await readFile(processMarker, 'utf8'))]);
    return { elapsedMs, candidates: 64, processesStarted: commands.length };
}

async function runStickyCleanupFailureCase() {
    const fixtureRoot = join(root, 'sticky-cleanup');
    const workspace = join(fixtureRoot, 'workspace');
    const storeRoot = join(fixtureRoot, 'store');
    const temporaryDirectory = join(fixtureRoot, 'temporary');
    const logPath = join(fixtureRoot, 'commands.log');
    const processMarker = join(fixtureRoot, 'process.pid');
    await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(temporaryDirectory, { recursive: true })
    ]);
    await writeFile(join(workspace, 'file.txt'), 'content\n', 'utf8');
    const store = new SnapshotStore(storeRoot, undefined, {
        captureTimeoutMs: 500,
        processCleanupTimeoutMs: 1_000,
        homePath: join(root, 'unrelated-home'),
        temporaryDirectory,
        gitInvocation: {
            executable: process.execPath,
            argsPrefix: [unsafeGitPath, logPath, processMarker]
        },
        processTreeTerminator: async child => {
            await stopDirectChild(child);
            throw new Error('Synthetic process-tree verification failure.');
        }
    });
    const activeCapture = store.capture(workspace, 'unsafe-cleanup-task');
    await waitForFile(processMarker);
    const commandsWhileActive = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    const queuedCapture = store.capture(workspace, 'queued-unsafe-cleanup-task');
    const [capture, queued] = await Promise.all([activeCapture, queuedCapture]);
    assert.equal(capture.source, 'empty');
    assert.equal(capture.error,
        '変更の記録を安全に停止できなかったため、Agent を開始しませんでした。');
    assert.equal(capture.blocksAgentStart, true,
        'A cleanup error swallowed by optional tracked-path discovery must still block Agent start.');
    assert.equal(queued.blocksAgentStart, true,
        'Already queued captures must inherit an unverified process-tree termination.');
    assert.equal(queued.error, capture.error);
    await assertProcessesGone([Number(await readFile(processMarker, 'utf8'))]);
    await assertTemporaryIndexesRemoved(temporaryDirectory);
    const commandsBeforeRetry = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    assert.deepEqual(commandsBeforeRetry, commandsWhileActive,
        'A queued capture must not start Git after an earlier capture fails process-tree verification.');
    assert(commandsBeforeRetry.some(command => command.includes('ls-files')));
    assert.equal(commandsBeforeRetry.some(command => command.includes('read-tree')), false,
        'Snapshot capture must stop after unverified cleanup instead of continuing to write a tree.');
    const subsequent = await store.capture(workspace, 'after-unsafe-cleanup-task');
    assert.equal(subsequent.blocksAgentStart, true);
    assert.equal(subsequent.error, capture.error);
    const commandsAfterRetry = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    assert.equal(commandsAfterRetry.length, commandsBeforeRetry.length,
        'A store with a known possible orphan writer must not start another Git process.');
    return { swallowedErrorStayedBlocking: true, queuedSpawnPrevented: true, subsequentSpawnPrevented: true };
}

async function runFailedTreeKillCase() {
    if (process.platform !== 'win32') {
        return { skipped: true };
    }
    for (const failure of ['spawn-error', 'nonzero', 'timeout']) {
        let childKillCalls = 0;
        const child = {
            pid: 424_242,
            kill() {
                childKillCalls += 1;
                return true;
            }
        };
        const spawnTreeKiller = () => {
            const killer = new EventEmitter();
            killer.kill = () => true;
            if (failure === 'spawn-error') {
                queueMicrotask(() => killer.emit('error', new Error('synthetic spawn error')));
            } else if (failure === 'nonzero') {
                queueMicrotask(() => killer.emit('close', 1));
            }
            return killer;
        };
        await assert.rejects(
            killHiddenProcessTree(child, 100, true, spawnTreeKiller),
            /Process tree termination/
        );
        assert.equal(childKillCalls, 1,
            `A ${failure} tree-kill failure must still attempt the bounded direct-child fallback.`);
    }

    const nonStrictChild = { pid: 424_243, kill() { return true; } };
    const nonStrictSpawner = () => {
        const killer = new EventEmitter();
        killer.kill = () => true;
        queueMicrotask(() => killer.emit('close', 1));
        return killer;
    };
    await killHiddenProcessTree(nonStrictChild, 100, false, nonStrictSpawner);
    return { strictFailuresRejected: 3, nonStrictCompatibilityPreserved: true };
}

async function createFixture(name) {
    const fixtureRoot = join(root, name);
    const workspace = join(fixtureRoot, 'workspace');
    const storeRoot = join(fixtureRoot, 'store');
    const temporaryDirectory = join(fixtureRoot, 'temporary');
    const statePath = join(fixtureRoot, 'add-count.txt');
    const processMarker = join(fixtureRoot, 'processes.json');
    await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(temporaryDirectory, { recursive: true })
    ]);
    await writeFile(join(workspace, 'file.txt'), 'content\n', 'utf8');
    return { workspace, storeRoot, temporaryDirectory, statePath, processMarker };
}

function snapshotStore(fixture, captureTimeoutMs) {
    return new SnapshotStore(fixture.storeRoot, undefined, {
        captureTimeoutMs,
        processCleanupTimeoutMs: 2_000,
        homePath: join(root, 'unrelated-home'),
        temporaryDirectory: fixture.temporaryDirectory,
        gitInvocation: {
            executable: process.execPath,
            argsPrefix: [fakeGitPath, fixture.statePath, descendantPath, fixture.processMarker]
        }
    });
}

async function recordedPids(marker) {
    const recorded = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(Number.isInteger(recorded.parent), true);
    assert.equal(Number.isInteger(recorded.child), true);
    await waitForFile(`${marker}.child`);
    return [recorded.parent, recorded.child];
}

async function assertProcessesGone(pids) {
    const deadline = Date.now() + 2_000;
    while (pids.some(isProcessAlive) && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
    assert.deepEqual(pids.filter(isProcessAlive), [], 'Snapshot Git process descendants survived cleanup.');
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function assertTemporaryIndexesRemoved(temporaryDirectory) {
    const entries = await readdir(temporaryDirectory);
    assert.equal(entries.some(name => name.startsWith('poiesis-snapshot-index-')), false,
        'Temporary snapshot index storage was not cleaned.');
}

async function waitForFile(path) {
    const deadline = Date.now() + 2_000;
    while (true) {
        try {
            await readFile(path);
            return;
        } catch {
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for ${path}.`);
            }
            await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
        }
    }
}

async function stopDirectChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    await new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error('Synthetic child did not stop.')), 1_000);
        child.once('close', () => {
            clearTimeout(timeout);
            resolvePromise();
        });
        child.kill();
    });
}

function deferred() {
    let resolvePromise;
    const promise = new Promise(resolve => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}
