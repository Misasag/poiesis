import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const {
    buildFailedAssertionPromptSection,
    extractResultsAssertionText,
    parseResultsAssertionJudgement,
    selectBetterResultsAssertionCandidate,
    shortRequirementTitleFallback
} = require(resolve(root, 'agent-window/lib/browser/results-assertions.js'));

const extracted = extractResultsAssertionText('<html><head><style>hidden</style></head><body><h2>概要</h2><p>本文 <b>です</b></p></body></html>');
assert(extracted.includes('## 概要'));
assert(extracted.includes('本文 です'));
assert(!extracted.includes('<h2>') && !extracted.includes('hidden'));
assert.equal(extractResultsAssertionText(`<html><body><p>${'x'.repeat(61_000)}</p></body></html>`).length, 60_000);

const structured = extractResultsAssertionText(`<html><body>
    <h2>検証の証跡</h2><table><caption>実行結果</caption><thead><tr><th> コマンド </th><th>結果</th></tr></thead>
    <tbody><tr><td><code>npm test</code></td><td>成功</td></tr><tr><td>echo a | b</td><td>1 &lt; 2</td></tr></tbody></table>
    <h3>確認手順</h3><ul><li>タイマーを開始</li><li>通知を確認</li></ul>
    <ol><li>再実行</li></ol><pre><code>if (a &lt; b) {\n  notify('&amp;lt;');\n}</code></pre>
    <script>hiddenScript()</script><style>hiddenStyle</style>
    </body></html>`);
assert(structured.includes('## 検証の証跡\n\n実行結果\n| コマンド | 結果 |\n| --- | --- |\n| npm test | 成功 |'));
assert(structured.includes('| echo a \\| b | 1 < 2 |'));
assert(structured.includes('- タイマーを開始\n- 通知を確認'));
assert(structured.includes('- 再実行'));
assert(structured.includes("```\nif (a < b) {\n  notify('&lt;');\n}\n```"), 'Code indentation and single entity decoding must survive.');
assert(!structured.includes('hiddenScript') && !structured.includes('hiddenStyle'));
assert.equal(extractResultsAssertionText('<pre>```\ncode\n```</pre>'), '````\n```\ncode\n```\n````');
assert(extractResultsAssertionText('<table><tr><td>名前</td><td>値</td></tr><tr><td>一つ</td></tr></table>')
    .includes('| 名前 | 値 |\n| --- | --- |\n| 一つ |  |'));
const manyRows = extractResultsAssertionText('<table><tr><th>番号</th></tr>'
    + Array.from({ length: 70 }, (_, index) => `<tr><td>行${index}</td></tr>`).join('') + '</table>');
assert(manyRows.includes('| 行49 |') && !manyRows.includes('| 行50 |') && manyRows.includes('省略'));
const largeCell = extractResultsAssertionText(`<table><tr><th>結果</th></tr><tr><td>${'あ'.repeat(600)}</td></tr></table>`);
assert(largeCell.includes('あ'.repeat(499) + '…') && !largeCell.includes('あ'.repeat(500)) && largeCell.includes('省略'));
const manyColumns = extractResultsAssertionText('<table><tr>' + Array.from({ length: 20 }, (_, index) => `<th>列${index}</th>`).join('') + '</tr></table>');
assert(manyColumns.includes('列11') && !manyColumns.includes('列12') && manyColumns.includes('省略'));
assert.equal(extractResultsAssertionText(`<pre>${'あ'.repeat(65_000)}</pre>`, 100_000).length, 60_000);
assert.equal(extractResultsAssertionText('<h2>概要</h2>', 0), '');

const definitions = [
    { text: '要約がある', skillId: 'summary-skill' },
    { text: '確認手順がある', skillId: 'verification-skill' }
];
const judged = parseResultsAssertionJudgement(
    '{"results":[{"index":0,"pass":true,"evidence":"要約を確認"},{"index":1,"pass":false,"evidence":"手順なし"}]}',
    definitions
);
assert.deepEqual(judged.map(result => result.status), ['pass', 'fail']);
assert.deepEqual(judged.map(result => result.skillId), ['summary-skill', 'verification-skill']);
for (const invalid of [
    'not json',
    'prefix {"results":[]} suffix',
    '{"results":[{"index":0,"pass":true,"evidence":"only one"}]}',
    '{"results":[{"index":0,"pass":"yes","evidence":"bad"},{"index":1,"pass":true,"evidence":"ok"}]}'
]) {
    assert.deepEqual(
        parseResultsAssertionJudgement(invalid, definitions).map(result => result.status),
        ['unknown', 'unknown'],
        'Invalid judge output must make every Skill assertion unknown.'
    );
}

const oneFailure = { document: 'first', assertions: [{ text: 'a', source: 'app', status: 'fail' }] };
const noFailures = { document: 'second', assertions: [{ text: 'a', source: 'app', status: 'pass' }] };
assert.equal(selectBetterResultsAssertionCandidate(oneFailure, noFailures).document, 'second');
assert.equal(selectBetterResultsAssertionCandidate(noFailures, noFailures).document, 'second', 'The second document must win a tie.');

const retrySection = buildFailedAssertionPromptSection(judged);
assert(retrySection.startsWith('前回の生成は次の必須条件を満たしていませんでした。今回は必ず満たしてください:'));
assert(retrySection.includes('- 確認手順がある'));
assert(!retrySection.includes('要約がある'));
assert(buildFailedAssertionPromptSection([{ source: 'app', text: '図の部品が表示できる', status: 'fail',
    evidence: 'キャプションを1文にしてください。' }]).includes('図の部品が表示できる: キャプションを1文にしてください。'));

assert.equal(shortRequirementTitleFallback('Results文書を検証する仕組みを追加してください。'), 'Results文書');
assert.equal(shortRequirementTitleFallback('短い要件名、一覧改善'), '短い要件名');
assert.equal(shortRequirementTitleFallback('境界のない長いタイトルabcdefghijklmnop'), '境界のない長いタイトルabcdefghijklmn'.slice(0, 24));

console.log('results-assertions tests passed');
