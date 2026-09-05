import assert from 'node:assert/strict';
import {
    hasReadableResultDocument,
    parseAgentCompletion,
    taskProducesResult
} from '../agent-window/lib/common/task-outcome.js';

const conversation = parseAgentCompletion('こんにちは。\n<!-- poiesis-outcome: conversation -->');
assert.deepEqual(conversation, { message: 'こんにちは。', outcomeKind: 'conversation' });
assert.equal(taskProducesResult({
    status: 'completed',
    outcomeKind: conversation.outcomeKind,
    changeSet: { files: [], diff: '' }
}), false, 'An ordinary conversation must not create a Result.');

const designExplanation = parseAgentCompletion(
    'ソフトウェア設計とは、責務や構造を整理する活動です。\n<!-- poiesis-outcome: conversation -->'
);
assert.equal(designExplanation.outcomeKind, 'conversation',
    'A general explanation of software design is conversation, not an outcome.');
const generalUsabilityDiscussion = parseAgentCompletion(
    `${'一般論としてタスクリストの使いやすさを議論します。'.repeat(80)}\nアプリ固有の提案はしていません。\n<!-- poiesis-outcome: conversation -->`
);
assert.equal(generalUsabilityDiscussion.outcomeKind, 'conversation',
    'Length and design vocabulary alone must not turn general discussion into a Result.');

const design = parseAgentCompletion('画面遷移と状態遷移を含む仕様を確定しました。\n<!-- poiesis-outcome: result -->');
assert.equal(design.outcomeKind, 'result');
assert.equal(taskProducesResult({
    status: 'completed',
    outcomeKind: design.outcomeKind,
    changeSet: { files: [], diff: '' }
}), true, 'A concrete design outcome must produce a Result without file changes.');

const concreteTaskListDesign = parseAgentCompletion(
    '設計案として、未完了と完了を分け、各グループ内の順序を保持し、再読み込み後も状態を復元し、空の場合は説明文を表示します。\n'
    + '<!-- poiesis-outcome: result -->'
);
assert.equal(concreteTaskListDesign.outcomeKind, 'result',
    'A concrete no-file task-list design is a Result described as design.');
const refinement = parseAgentCompletion(
    '前の設計を更新し、空状態には作成操作への短い案内も含めます。\n<!-- poiesis-outcome: result -->'
);
assert.equal(refinement.outcomeKind, 'result', 'A concrete refinement remains a Result outcome.');

assert.equal(taskProducesResult({
    status: 'completed',
    outcomeKind: 'conversation',
    changeSet: { files: ['src/app.ts'], diff: 'diff --git a/src/app.ts b/src/app.ts' }
}), true, 'Observed material changes must remain visible even when the semantic marker is wrong.');
assert.equal(taskProducesResult({
    status: 'failed',
    changeSet: { files: [], diff: '' }
}), false, 'An empty failed attempt must not become a polished Result.');
assert.equal(taskProducesResult({
    status: 'cancelled',
    outcomeKind: 'result',
    changeSet: { files: [], diff: '' }
}), false, 'A cancelled no-change turn must not be promoted by an unsupported success marker.');
assert.equal(taskProducesResult({
    status: 'cancelled',
    changeSet: { files: ['src/partial.ts'], diff: 'diff --git a/src/partial.ts b/src/partial.ts' }
}), true, 'Material partial changes must remain visible with their cancelled status.');
assert.equal(taskProducesResult({
    status: 'completed',
    changeSet: { files: [], diff: '' },
    resultsDocument: { status: 'ready', html: '<html><body>legacy</body></html>' }
}), true, 'A meaningful legacy Result must stay visible without the new marker.');
const omittedMarker = parseAgentCompletion('判定のない応答です。');
assert.equal(omittedMarker.outcomeKind, undefined);
assert.equal(taskProducesResult({
    status: 'completed',
    outcomeKind: omittedMarker.outcomeKind,
    changeSet: { files: [], diff: '' }
}), false, 'An omitted marker without observable changes must fall back to conversation.');
assert.deepEqual(
    parseAgentCompletion('完了したと主張しています。\n<!-- poiesis-outcome: polished-success -->'),
    { message: '完了したと主張しています。' },
    'Malformed outcome metadata must not leak and must fall back to observable state.'
);
assert.equal(taskProducesResult({
    status: 'completed',
    outcomeKind: parseAgentCompletion('完了しました。\n<!-- poiesis-outcome: polished-success -->').outcomeKind,
    changeSet: { files: [], diff: '' }
}), false, 'Malformed metadata cannot promote an unsupported success claim to a Result.');
assert.deepEqual(
    parseAgentCompletion('マーカーが閉じていません。\n<!-- poiesis-outcome: result'),
    { message: 'マーカーが閉じていません。' },
    'An unterminated outcome marker must not leak into the conversation.'
);
assert.equal(hasReadableResultDocument({ status: 'ready', html: '<html>previous result</html>' }), true,
    'A readable Result must remain available while its refinement is generated.');

console.log('OUTCOME_SEMANTICS_TEST=passed');
