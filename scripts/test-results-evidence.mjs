import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { buildVerificationTable, verificationPrompt } = require('../agent-window/lib/browser/results-evidence.js');
const { checkResultsTopAnswer, normalizeAiResultsHtml } = require('../agent-window/lib/browser/results-document-normalizer.js');
const { hashChangeSet } = require('../agent-window/lib/common/change-set-hash.js');
const current = { diff: '+入力保持', files: ['b', 'a'], capturedAt: 'now' };
current.changeSetHash = await hashChangeSet(current);
assert.equal(current.changeSetHash, 'sha256:' + createHash('sha256').update(JSON.stringify([1, ['a', 'b'], current.diff])).digest('hex'));
assert.equal(await hashChangeSet({ ...current, files: ['a', 'b'], capturedAt: 'later' }), current.changeSetHash);
assert.notEqual(await hashChangeSet({ ...current, diff: '+別の変更' }), current.changeSetHash);
assert.equal(await hashChangeSet({ ...current, error: 'capture failed' }), undefined);
const entry = (status, extra = {}) => ({ label: status, status, detail: status === 'human' ? '制約を案内して配布しますか？' : '観測結果', changeSetHash: current.changeSetHash, ...extra });
const task = { changeSet: current, activities: [{ kind: 'message', status: 'completed', detail: 'すべて成功' }],
    hookEvidence: [{ runId: 'run', evidence: [entry('pass', { image: 'shot.png' }), entry('fail'), entry('pass', { changeSetHash: 'old' }), entry('human')] }] };
const table = buildVerificationTable([task], current);
assert.deepEqual(table.counts, { pass: 1, fail: 1, unknown: 1, outdated: 1, human: 1 });
assert.equal(table.humanCount, 1);
assert.equal(table.summary, '確認 5件中 1件成功・1件失敗・1件未確認・1件以前の結果・1件人間の判断待ち');
assert.equal(table.rows[0].image, 'shot.png');
assert.equal(table.rows[0].runId, 'run');
const legacy = buildVerificationTable([{ hookEvidence: [{ evidence: [entry('pass', { changeSetHash: undefined })] }] }], current);
assert.equal(legacy.counts.pass, 0);
assert.equal(legacy.counts.unknown, 2);
const stale = buildVerificationTable([task], { ...current, changeSetHash: 'next' });
assert.equal(stale.counts.pass, 0);
assert.equal(stale.counts.outdated, 4);
assert.equal(stale.humanCount, 1, 'Outdated human questions must remain pending');
assert.equal(buildVerificationTable([], undefined).counts.unknown, 1);
assert.equal(buildVerificationTable([{ hookEvidence: [{ incomplete: true, notes: 'timeout', evidence: [] }] }], current).counts.unknown, 2);
assert.equal(buildVerificationTable([{ hookRuns: [{ event: 'taskEnd', status: 'fail', id: 'advisory', runId: 'a' }] }], current).counts.unknown, 2);
const execution = buildVerificationTable([{ changeSet: current, activities: [{ kind: 'command', status: 'completed' }, { kind: 'tool', status: 'failed' }] }], current);
assert.equal(execution.counts.fail, 1);
assert.match(execution.rows[0].detail, /1件完了・1件失敗/);
assert.equal(buildVerificationTable([{ changeSet: current, activities: [{ kind: 'command', status: 'running' }] }], current).counts.unknown, 1);
const passing = buildVerificationTable([{ changeSet: current, activities: [{ kind: 'command', status: 'completed' }] }], current);
const doc = answer => `<html><body><main><h2>要点</h2><p>${answer}</p><h2>根拠</h2></main></body></html>`;
const good = '入力を保持できるようにしました。確認5件中1件成功で、通信の確認は失敗、以前の結果と未確認が残ります。配布するか人間の判断が必要です。';
assert(checkResultsTopAnswer(normalizeAiResultsHtml(doc(good), { taskTitle: '入力保持' }).html, table).every(a => a.status === 'pass'));
assert(checkResultsTopAnswer(doc('操作を終了しました。確認1件中1件成功です。'), passing).every(a => a.status === 'pass'));
const allPassed = buildVerificationTable([{ changeSet: current, activities: [{ kind: 'command', status: 'completed' }],
    hookEvidence: [{ evidence: [entry('pass'), entry('pass'), entry('pass')] }] }], current);
assert.equal(allPassed.summary, '確認 4件中 4件成功');
const countCheck = (answer, evidence = table) => checkResultsTopAnswer(doc(answer), evidence)
    .find(result => result.text === '冒頭の確認件数がアプリの記録と一致する').status;
assert.equal(countCheck('入力を保持しました。確認2件中1件成功です。', allPassed), 'fail');
assert.equal(countCheck('入力を保持しました。確認4件中2件成功です。', allPassed), 'fail');
for (const answer of [
    '入力を保持しました。確認4件中3件成功です。',
    '入力を保持しました。確認5件中1件成功・2件失敗・1件未確認で、以前の結果と判断待ちがあります。',
    '入力を保持しました。確認5件中1件成功・1件失敗・2件未確認で、以前の結果と判断待ちがあります。',
    '入力を保持しました。確認5件中1件成功・1件失敗・2件未検証で、以前の結果と判断待ちがあります。',
    '入力を保持しました。確認5件中、成功は1件、失敗は2件です。以前の結果と未確認と判断待ちがあります。',
    '入力を保持しました。確認5件中、成功は1件、未確認が2件です。失敗と以前の結果と判断待ちがあります。'
]) assert.equal(countCheck(answer, answer.includes('4件中') ? allPassed : table), 'fail', answer);
for (const answer of [
    '2026年9月24日に3ファイルを変更しました。確認5件中1件成功・1件失敗・1件未確認で、以前の結果と判断待ちがあります。',
    '3ファイルを変更しました。確認5件中1件成功・1件失敗・1件未確認で、以前の結果と判断待ちがあります。'
]) assert.equal(countCheck(answer), 'pass', answer);
for (const answer of [
    '入力を保持します。すべて確認済みです。',
    '入力を保持します。全件成功です。',
    '入力を保持します。確認5件中5件成功です。失敗は残り、判断が必要です。',
    '入力を保持します。成功 ５件です。未確認と判断待ちです。',
    '入力を保持します。合格率100%です。',
    '入力を保持します。確認5件中1件成功です。',
    '入力を保持します。確認5件中1件成功で失敗もあります。',
    '説明だけ'
]) assert(checkResultsTopAnswer(doc(answer), table).some(a => a.status === 'fail'), answer);
for (const html of ['<h2>空</h2>', `<details><summary>要点</summary><p>${good}</p></details>`, `<table></table><p>${good}</p>`, `<p hidden>${good}</p>`]) {
    assert.equal(checkResultsTopAnswer(html, table)[0].status, 'fail');
}
const packet = JSON.parse(verificationPrompt({ ...table, rows: [...table.rows, ...Array.from({ length: 100 }, () => ({ label: 'long', status: 'fail', detail: 'x'.repeat(2000) }))] }));
assert.deepEqual(packet.counts, table.counts);
assert(packet.omittedRows > 0);
const prompt = await readFile('agent-window/src/node/results-generation-server.ts', 'utf8');
for (const text of ['App verification table', '2〜4文', '利用者への変更', '最重要の未確認', 'AI本文に確認表を再生成しない', '入力保持を確認した手順', 'details の中だけに置かない']) assert(prompt.includes(text), text);
assert(prompt.includes('冒頭で件数に触れる場合は「${verificationSentence}」をそのまま使ってください。'));
console.log('results-evidence tests passed');
