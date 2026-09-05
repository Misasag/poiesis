import assert from 'node:assert/strict';
import {
    parseClassification,
    parseSuggestedRequirementTitle,
    shouldClassify
} from '../agent-window/lib/browser/requirement-classifier.js';

const earlierTask = {
    id: 'task-earlier',
    status: 'completed',
    startedAt: '2026-09-02T01:00:00.000Z'
};
const task = {
    id: 'task-new',
    status: 'completed',
    startedAt: '2026-09-02T02:00:00.000Z',
    requirementChoice: 'default',
    workspaceUri: 'file:///workspace',
    changeSet: {
        source: 'task-diff',
        files: ['src/new.ts'],
        diff: 'diff --git a/src/new.ts b/src/new.ts'
    }
};
const requirement = {
    taskIds: [earlierTask.id, task.id],
    tasks: [earlierTask, task]
};

assert.equal(shouldClassify({ ...task, requirementChoice: 'explicit' }, requirement, {
    enabled: true,
    workspaceIsLocal: true,
    outcomeIsResult: true
}), false, 'An explicit composer choice must skip classification.');
assert.equal(shouldClassify(task, { taskIds: [task.id], tasks: [task] }, {
    enabled: true,
    workspaceIsLocal: true,
    outcomeIsResult: true
}), false, 'The first Task in a Requirement must skip classification.');
assert.equal(shouldClassify(task, requirement, {
    enabled: false,
    workspaceIsLocal: true,
    outcomeIsResult: true
}), false, 'The disabled setting must skip classification.');
assert.equal(shouldClassify(task, requirement, {
    enabled: true,
    workspaceIsLocal: true,
    outcomeIsResult: true
}), true, 'A later default Task with changes in a local Workspace is eligible.');
assert.equal(shouldClassify({ ...task, changeSet: { source: 'empty', files: [], diff: '' } }, requirement, {
    enabled: true,
    workspaceIsLocal: true,
    outcomeIsResult: true
}), true, 'A concrete no-file outcome must still be eligible for semantic grouping.');
assert.equal(shouldClassify(task, requirement, {
    enabled: true,
    workspaceIsLocal: true,
    outcomeIsResult: false
}), false, 'Conversation-only turns must not be classified as Results.');

const sameFileSeparateGoal = parseClassification(
    '{"decision":"new","confidence":0.94,"title":"削除取り消し","reason":"並び順改善とは独立した機能"}'
);
assert.equal(sameFileSeparateGoal.decision, 'new',
    'An undo-deletion feature must be a separate Result even when it changes the same file as ordering work.');

assert.equal(parseClassification('not json').decision, 'continue');
assert.equal(parseClassification('{"decision":"new","confidence":0.79,"title":"別要件","reason":"やや不確実"}').decision, 'continue');
const longTitle = 'これは二十四文字を超える新しい要件タイトルの候補です';
const parsedNew = parseClassification(
    `prefix {"decision":"new","confidence":0.8,"title":"${longTitle}","reason":"目的が独立"} suffix`
);
assert.equal(parsedNew.decision, 'new');
assert.equal(parsedNew.title, longTitle.slice(0, 24));
assert.equal(parsedNew.title?.length, 24);

assert.equal(parseSuggestedRequirementTitle('{"title":"成果文書の条件検証"}'), '成果文書の条件検証');
assert.equal(parseSuggestedRequirementTitle('prefix {"title":"不正"}'), undefined);
assert.equal(parseSuggestedRequirementTitle('{"title":"これは二十四文字を超える要件名の候補なので切り詰められます"}')?.length, 24);

console.log('requirement-classifier tests passed');
