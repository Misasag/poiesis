import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(scriptDirectory, '../../../..');
const require = createRequire(import.meta.url);
const { CliDetector } = require('../../agent-window/lib/node/cli-detector');
const { ResultsQuestionServerImpl } = require('../../agent-window/lib/node/results-question-server');

const service = new ResultsQuestionServerImpl(new CliDetector());
const result = await service.ask('What status does this fake Task have? Answer in one short sentence.', {
    taskId: 'smoke-task',
    workspaceUri: pathToFileURL(workspace).toString(),
    taskMetadata: {
        title: 'Results question smoke test',
        status: 'completed',
        startedAt: '2026-08-27T00:00:00.000Z',
        endedAt: '2026-08-27T00:00:01.000Z'
    },
    changeSetSummary: 'No files changed.',
    resultsHtml: '<!doctype html><html><body><main><p>The fake Task completed successfully.</p></main></body></html>'
});

if (result.status !== 'answered') {
    throw new Error(`Results question failed: ${JSON.stringify(result.error)}`);
}

console.log(result.answer);
