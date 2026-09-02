import assert from 'node:assert/strict';
import {
    heuristicDecision,
    parseClassification,
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
    workspaceIsLocal: true
}), false, 'An explicit composer choice must skip classification.');
assert.equal(shouldClassify(task, { taskIds: [task.id], tasks: [task] }, {
    enabled: true,
    workspaceIsLocal: true
}), false, 'The first Task in a Requirement must skip classification.');
assert.equal(shouldClassify(task, requirement, {
    enabled: false,
    workspaceIsLocal: true
}), false, 'The disabled setting must skip classification.');
assert.equal(shouldClassify(task, requirement, {
    enabled: true,
    workspaceIsLocal: true
}), true, 'A later default Task with changes in a local Workspace is eligible.');

assert.deepEqual(
    heuristicDecision(['src\\shared.ts'], ['src/shared.ts'], '独立した変更を追加'),
    { decision: 'continue', reason: 'file-overlap' }
);
assert.deepEqual(
    heuristicDecision(['src/new.ts'], ['src/old.ts'], '前回の続きとして調整して'),
    { decision: 'continue', reason: 'previous-task-reference' }
);
assert.equal(heuristicDecision(['src/new.ts'], ['src/old.ts'], '別の画面を追加して'), undefined);

assert.equal(parseClassification('not json').decision, 'continue');
assert.equal(parseClassification('{"decision":"new","confidence":0.79,"title":"別要件","reason":"やや不確実"}').decision, 'continue');
const longTitle = 'これは二十四文字を超える新しい要件タイトルの候補です';
const parsedNew = parseClassification(
    `prefix {"decision":"new","confidence":0.8,"title":"${longTitle}","reason":"目的が独立"} suffix`
);
assert.equal(parsedNew.decision, 'new');
assert.equal(parsedNew.title, longTitle.slice(0, 24));
assert.equal(parsedNew.title?.length, 24);

console.log('requirement-classifier tests passed');
