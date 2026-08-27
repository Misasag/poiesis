import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { ResultsQuestionServerImpl } = require('../../agent-window/lib/node/results-question-server');
const detector = {
    recordedReport: {
        detections: [{ id: 'codex', status: 'found', path: process.execPath }]
    }
};
const scope = {
    taskId: 'process-test',
    workspaceUri: pathToFileURL(process.cwd()).toString(),
    taskMetadata: { status: 'completed' },
    changeSetSummary: 'No changes.',
    resultsHtml: '<html><body>Test</body></html>'
};

const missing = new ResultsQuestionServerImpl({
    recordedReport: { detections: [{ id: 'codex', status: 'missing' }] }
});
const missingResult = await missing.ask('Test missing CLI.', scope);
assert.equal(missingResult.status, 'failed');
assert.equal(missingResult.error.code, 'cli-not-found');

const failed = new ResultsQuestionServerImpl(detector);
failed.spawnCodex = () => spawn(
    process.execPath,
    ['-e', 'process.stderr.write("expected failure");process.exit(7)'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
);
const failedResult = await failed.ask('Test failure.', scope);
assert.equal(failedResult.status, 'failed');
assert.equal(failedResult.error.code, 'cli-failed');
assert.equal(failedResult.error.exitCode, 7);

const cancelled = new ResultsQuestionServerImpl(detector);
cancelled.spawnCodex = () => spawn(
    process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write("late"), 10000)'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
);
const pending = cancelled.ask('Test cancellation.', scope);
await new Promise(resolve => setTimeout(resolve, 250));
await cancelled.cancel(scope.taskId);
const cancelledResult = await pending;
assert.equal(cancelledResult.status, 'cancelled');
assert.equal(cancelledResult.error.code, 'cancelled');

console.log('CLI-not-found, non-zero exit, and cancellation checks passed.');
