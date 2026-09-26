import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { formatExecutionEvidence } = require('../agent-window/lib/browser/results-document-normalizer.js');

const activities = [
    {
        id: 'reasoning-1', kind: 'reasoning', title: 'Thinking', detail: 'private chain', status: 'completed',
        startedAt: '2026-09-02T00:00:00.000Z', endedAt: '2026-09-02T00:00:01.000Z'
    },
    {
        id: 'command-1', kind: 'command', title: 'Command', detail: 'npm test (exit code 1)', status: 'failed',
        startedAt: '2026-09-02T00:00:02.000Z', endedAt: '2026-09-02T00:00:03.000Z'
    },
    {
        id: 'file-1', kind: 'file-change', title: 'File change', detail: 'index.html - updated', status: 'completed',
        startedAt: '2026-09-02T00:00:04.000Z', endedAt: '2026-09-02T00:00:05.000Z'
    },
    {
        id: 'message-1', kind: 'message', title: 'Message', detail: 'done', status: 'completed',
        startedAt: '2026-09-02T00:00:06.000Z', endedAt: '2026-09-02T00:00:07.000Z'
    }
];
const evidence = formatExecutionEvidence(activities, 12_000);
assert(evidence.includes('[失敗] コマンド実行:'), 'Evidence must render failed commands in Japanese.');
assert(evidence.includes('[完了] ファイル変更:'), 'Evidence must render completed file changes in Japanese.');
assert(evidence.includes('[メッセージ] done'), 'Evidence must render message activities.');
assert(!evidence.includes('private chain'), 'Evidence must omit reasoning activities.');

const truncated = formatExecutionEvidence(activities, 70);
assert(truncated.includes('[古い実行記録を省略しました]'), 'Truncated evidence must include its marker.');
assert(truncated.includes('[メッセージ] done'), 'Truncation must retain the newest fitting evidence.');
assert(!truncated.includes('npm test'), 'Truncation must remove oldest evidence first.');
assert(truncated.length <= 70, 'Evidence must obey the requested character cap.');

console.log('RESULTS_NORMALIZER_TEST=passed');
