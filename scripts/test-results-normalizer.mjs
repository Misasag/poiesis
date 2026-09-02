import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    formatExecutionEvidence,
    normalizeAiResultsHtml
} = require('../agent-window/lib/browser/results-document-normalizer.js');

const titled = normalizeAiResultsHtml(
    '<!doctype html><html><head><title>Result</title></head><body><h1>Long task title…</h1><p>Body</p></body></html>',
    { taskTitle: 'Long task title that was clamped by the Application…' }
);
assert(!titled.html.includes('<h1>Long task title…</h1>'), 'Leading task-title h1 must be removed.');
assert(titled.html.includes('<p>Body</p>'), 'Removing the title must preserve the document body.');

const demoted = normalizeAiResultsHtml(
    '<html><head></head><body><p>Intro</p><h1 class="section">Details</h1></body></html>',
    { taskTitle: 'Different title' }
);
assert(demoted.html.includes('<h2 class="section">Details</h2>'), 'Non-title h1 elements must become h2 elements.');

assert.throws(() => normalizeAiResultsHtml(
    '<html><head></head><body><script>alert(1)</script></body></html>',
    { taskTitle: 'Unsafe' }
), /scripts or external resources/, 'Script-bearing output must still be rejected.');

const fenced = normalizeAiResultsHtml(
    '```html\n<html><head></head><body><p>Fenced</p></body></html>\n```',
    { taskTitle: 'Fenced task' }
);
assert(fenced.html.startsWith('<html>') && fenced.html.includes('<p>Fenced</p>'), 'Fenced HTML must be unwrapped.');

const missingClose = normalizeAiResultsHtml(
    '<!doctype html><html lang="ja"><head></head><body><p>Missing close</p></body>',
    { taskTitle: 'Missing close task' }
);
assert(missingClose.html.endsWith('</html>'), 'A missing closing html tag must be appended.');
assert(missingClose.notes.includes('Missing closing html tag was appended.'),
    'Appending a missing closing html tag must be reported in normalization notes.');

assert.throws(() => normalizeAiResultsHtml(
    '<html><head></head><body>First</body></html><html><body>Second</body></html>',
    { taskTitle: 'Repeated html' }
), /one complete HTML document/, 'Multiple html elements must still be rejected.');

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
