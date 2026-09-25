import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    assertNoActiveResultsContent,
    checkResultsTopAnswer,
    formatExecutionEvidence,
    normalizeAiResultsHtml,
    RESULTS_VISIBLE_PROSE_MAX_CHARS
} = require('../agent-window/lib/browser/results-document-normalizer.js');

const verification = { counts: { pass: 0, fail: 0, unknown: 0, outdated: 0, human: 0 },
    total: 0, humanCount: 0, summary: '確認なし' };
const figure = '<figure data-poiesis-figure-rendered="flow"><figcaption>操作が続きます。</figcaption></figure>';
const document = (opening, next = figure, rest = '') => `<html><body><p>${opening}</p>${next}${rest}</body></html>`;
const statuses = (html, table = verification, options = {}) => Object.fromEntries(
    checkResultsTopAnswer(html, table, options).map(result => [result.text, result.status]));
assert.equal(RESULTS_VISIBLE_PROSE_MAX_CHARS, 400);
assert(Object.values(statuses(document('入力を保持します。'))).every(status => status === 'pass'));
assert.equal(statuses(document('入力を保持します。確認できました。次も動きます。'))['冒頭に1〜2文の短い回答がある'], 'fail');
assert.equal(statuses(document('入力を保持します。', ''))['冒頭の直後に主図がある'], 'fail');
assert.equal(statuses(document('入力を保持します。', '<svg><rect/></svg>'))['冒頭の直後に主図がある'], 'fail');
assert.equal(statuses(document('入力を保持します。', '<img src="shot.png" alt="画面">'))['冒頭の直後に主図がある'], 'pass');
const small = { files: ['one.ts'], diff: '+line\n+line' };
assert.equal(statuses(document('入力を保持します。', ''), verification, { changeSet: small })['冒頭の直後に主図がある'], 'pass');
assert.equal(statuses(document('入力を保持します。', ''), verification, { changeSet: small, imageInputs: ['shot.png'] })['冒頭の直後に主図がある'], 'fail');
for (const heading of ['何が変わったか', '開始ボタンとは', '変更点', '概要', 'Test Plan', '確認できたこと']) {
    assert.equal(statuses(`<html><body><h2>${heading}</h2><p>入力を保持します。</p>${figure}</body></html>`)['見出しと折りたたみの名前が対象を示す'], 'fail', heading);
}
assert.equal(statuses(document('入力を保持します。', figure, '<details><summary>まとめ</summary>記録</details>'))['見出しと折りたたみの名前が対象を示す'], 'fail');
assert.equal(statuses(document('何が残るか分かります。'))['冒頭と図の文が疑問詞で始まらない'], 'fail');
assert.equal(statuses(document('入力を保持します。', '<figure data-poiesis-figure-rendered="flow"><figcaption>どう進むか分かります。</figcaption></figure>'))['冒頭と図の文が疑問詞で始まらない'], 'fail');
assert.equal(statuses(document('入力を保持します。', figure, '<ul><li><strong>確認</strong>: 成功</li></ul>'))['太字の札とコロンを使わない'], 'fail');
assert.equal(statuses(document('入力を保持します。', figure, '<ol><li>画面を開く</li></ol>'))['番号付きの手順を折りたたむ'], 'fail');
assert.equal(statuses(document('入力を保持します。', figure, '<details><summary>画面の確認手順</summary><ol><li>画面を開く</li></ol></details>'))['番号付きの手順を折りたたむ'], 'pass');
assert.equal(statuses(document('入力を保持します。', figure, `<p>${'長'.repeat(410)}</p>`))['折りたたみの外の文章が短い'], 'fail');
assert.equal(statuses(document('入力を保持します。', figure, `<details><summary>実行記録</summary>${'長'.repeat(500)}</details>`))['折りたたみの外の文章が短い'], 'pass');
const unresolved = { ...verification, counts: { ...verification.counts, fail: 1, unknown: 1, outdated: 1 },
    humanCount: 1, total: 4 };
assert.equal(statuses(document('入力を保持します。', figure, '<p>失敗: 接続。未確認: 操作。以前の結果: 撮影。判断待ち: 配布。</p>'), unresolved)['確認状況がアプリの記録と一致する'], 'pass');
assert.equal(statuses(document('入力を保持します。', figure, '<details><summary>接続の記録</summary>失敗、未確認、以前の結果、判断待ち</details>'), unresolved)['確認状況がアプリの記録と一致する'], 'fail');
// A real Results AI paraphrased the unconfirmed item and skipped the decision card; the retry must learn exactly that.
const humanUnknown = { ...verification, counts: { ...verification.counts, pass: 2, unknown: 1 }, humanCount: 1, total: 3,
    summary: '確認 3件中 2件成功・1件未確認' };
const consistency = html => checkResultsTopAnswer(html, humanUnknown).find(result => result.text === '確認状況がアプリの記録と一致する');
const paraphrased = consistency(document('回数を表示しました。', figure, '<p>画面の見やすさは、実際の画面での確認がまだありません。</p>'));
assert.equal(paraphrased.status, 'fail');
assert(paraphrased.evidence.startsWith('確認 3件中 2件成功・1件未確認。'), 'The evidence starts with the application summary.');
assert(paraphrased.evidence.includes('未確認 1件の対象を、折りたたみの外に1項目1行で、対象・「未確認」の語・理由を含めて書いてください。'));
assert(paraphrased.evidence.includes('人の判断が残る項目が1件あります。判断ごとに判断待ちのカードを置いてください。'));
assert(!paraphrased.evidence.includes('失敗 ') && !paraphrased.evidence.includes('以前の結果 '), 'Only the broken conditions are named.');
const stated = consistency(document('回数を表示しました。', figure,
    '<p>画面の見やすさは未確認です。人の目での確認がまだありません。</p><section class="poiesis-decision" data-poiesis-decision-rendered="decision"><span>判断待ち</span><h3>回数の大きさ</h3></section>'));
assert.equal(stated.status, 'pass');
assert.equal(stated.evidence, '確認 3件中 2件成功・1件未確認。本文の確認状況は記録と一致しています。');

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
assert.doesNotThrow(() => normalizeAiResultsHtml(
    '<html><body><figure data-poiesis-figure="flow"><script>alert(1)</script></figure></body></html>',
    { taskTitle: 'Figure content' }
), 'Figure renderer removes forbidden markup inside figure data.');
for (const [html, label] of [
    ['<figure><img src="a.png" alt="画面"><script>alert(1)</script></figure>', 'plain figure'],
    ['<figure data-poiesis-figure-x="flow"><script>alert(1)</script></figure>', 'look-alike figure attribute'],
    ['<section onclick="alert(1)"><p>本文</p></section>', 'ordinary section'],
    ['<section data-poiesis-decisions onclick="alert(1)"><p>本文</p></section>', 'look-alike decision attribute']
]) {
    assert.throws(() => normalizeAiResultsHtml(`<html><body>${html}</body></html>`, { taskTitle: 'Unsafe' }),
        /scripts or external resources/, `Active content inside a ${label} must be rejected.`);
}
assert.throws(() => assertNoActiveResultsContent('<html><body><div onclick="x()">a</div></body></html>'),
    /scripts or external resources/, 'The rendered document is checked with the same rule.');
assert.equal(statuses('<html><body><section><p>入力を保持します。</p></section><section><figure data-poiesis-figure-rendered="flow"><figcaption>操作が続きます。</figcaption></figure></section></body></html>')['冒頭の直後に主図がある'], 'pass',
    'Layout wrappers between the answer and the visual must not hide the main figure.');
assert.equal(statuses(document('入力を保持します。', '<figure><img src="shot.png" alt="画面"><figcaption>画面です。</figcaption></figure>'))['冒頭の直後に主図がある'], 'pass',
    'A captioned image counts as the main visual.');
assert.equal(statuses(document('入力を保持します。', '<section data-poiesis-decision-rendered="decision"><h3>配布</h3></section>'))['冒頭の直後に主図がある'], 'fail',
    'A decision card is not the main visual.');

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

const masked = normalizeAiResultsHtml(
    '<html><head></head><body><p>TASK-12-3 を更新し、task-1790190570418-2 の画面を撮影しました。</p>'
        + '<img src=".harness/evidence/shots/task-1790190570418-2/page-after.png" alt="変更後">'
        + '<p><code>.harness/evidence/shots/task-1790190570418-2/page-before.png</code></p></body></html>',
    { taskTitle: 'Masked ids' }
);
assert(masked.html.includes('<p>完了したタスク を更新し、完了したタスク の画面'), 'Task IDs in reader text must be hidden.');
assert(masked.html.includes('src=".harness/evidence/shots/task-1790190570418-2/page-after.png"'),
    'Task IDs inside image sources must stay resolvable.');
assert(masked.html.includes('shots/task-1790190570418-2/page-before.png</code>'), 'Task IDs inside file paths must not be rewritten.');

assert.throws(() => normalizeAiResultsHtml(
    '<html><head></head><body>First</body></html><html><body>Second</body></html>',
    { taskTitle: 'Repeated html' }
), /one complete HTML document/, 'Multiple html elements must still be rejected.');

// A real Results AI returned only the body content; the app owns the envelope, so the fragment is kept.
const fragment = normalizeAiResultsHtml(
    '<p>開始ボタンの文字に細い縁取りを加えました。</p>\n<details><summary>変更の根拠</summary><p>縁取りを足しました。</p></details>',
    { taskTitle: 'Fragment' }
);
assert(/^<!doctype html>\s*<html lang="ja">/i.test(fragment.html) && fragment.html.match(/<html(?:\s|>)/gi).length === 1
    && /<body>\s*<p>開始ボタンの文字に細い縁取りを加えました。<\/p>/.test(fragment.html) && /<\/html>\s*$/.test(fragment.html),
    'A body fragment must be wrapped in one complete document.');
assert(fragment.notes.some(note => note.includes('fragment')), 'Wrapping a fragment must be reported in normalization notes.');
assert.throws(() => normalizeAiResultsHtml('以下が成果文書です。\n<p>本文</p>', { taskTitle: 'Preface' }),
    /one complete HTML document/, 'Prose before the document must still be rejected.');

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
