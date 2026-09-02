import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const {
    buildFailedAssertionPromptSection,
    checkAppResultsAssertions,
    extractResultsAssertionText,
    parseResultsAssertionJudgement,
    selectBetterResultsAssertionCandidate,
    shortRequirementTitleFallback
} = require(resolve(root, 'agent-window/lib/browser/results-assertions.js'));

const completeHtml = '<!doctype html><html><body><h2>変更内容</h2><p>説明</p><a data-poiesis-citation="src/a.ts:2">src/a.ts:2</a></body></html>';
const complete = checkAppResultsAssertions(completeHtml, ['src/a.ts']);
assert.deepEqual(complete.map(result => result.status), ['pass', 'pass', 'pass']);

const citationRequired = checkAppResultsAssertions('<html><body><h2>変更内容</h2></body></html>', ['src/a.ts']);
assert.equal(citationRequired[0].status, 'fail', 'A changed-file document must include a citation.');
const citationNotRequired = checkAppResultsAssertions('<html><body><h2>変更内容</h2></body></html>', []);
assert.equal(citationNotRequired[0].status, 'pass', 'A no-change document does not require a citation.');
assert.equal(checkAppResultsAssertions('<html><body><p>見出しなし</p></body></html>', [])[1].status, 'fail');
assert.equal(checkAppResultsAssertions('<html><body><h3><span> </span></h3></body></html>', [])[2].status, 'fail');

const extracted = extractResultsAssertionText('<html><head><style>hidden</style></head><body><h2>概要</h2><p>本文 <b>です</b></p></body></html>');
assert(extracted.includes('## 概要'));
assert(extracted.includes('本文 です'));
assert(!extracted.includes('<h2>') && !extracted.includes('hidden'));
assert.equal(extractResultsAssertionText(`<html><body><p>${'x'.repeat(61_000)}</p></body></html>`).length, 60_000);

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

assert.equal(shortRequirementTitleFallback('Results文書を検証する仕組みを追加してください。'), 'Results文書');
assert.equal(shortRequirementTitleFallback('短い要件名、一覧改善'), '短い要件名');
assert.equal(shortRequirementTitleFallback('境界のない長いタイトルabcdefghijklmnop'), '境界のない長いタイトルabcdefghijklmn'.slice(0, 24));

console.log('results-assertions tests passed');
