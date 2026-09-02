import assert from 'node:assert/strict';
import {
    currentRequirementIdForTasks,
    migrateRequirementModel,
    moveTaskInRequirementModel,
    removeTaskFromRequirementModel,
    splitTaskInRequirementModel
} from '../agent-window/lib/browser/requirement-model.js';
import { shortenLegacyRequirementTitle } from '../agent-window/lib/browser/requirement-title-migration.js';

const tasks = [
    { id: 'task-a', sessionId: 'session-1', title: 'A', startedAt: '2026-09-02T01:00:00.000Z' },
    { id: 'task-b', sessionId: 'session-1', title: 'B', startedAt: '2026-09-02T02:00:00.000Z' },
    { id: 'task-c', sessionId: 'session-1', title: 'C', startedAt: '2026-09-02T03:00:00.000Z' }
];
let sequence = 0;
const nextId = () => `requirement-${++sequence}`;

const migrated = migrateRequirementModel(tasks, [], nextId);
assert.equal(migrated.requirements.length, 3);
assert.deepEqual(migrated.requirements.map(requirement => requirement.title), ['A', 'B', 'C']);
assert(migrated.requirements.every(requirement => requirement.titleSource === 'task'));

const assignedTasks = tasks.map(task => ({ ...task, requirementId: migrated.assignments.get(task.id) }));
const target = migrated.assignments.get('task-a');
assert.ok(target);
const moved = moveTaskInRequirementModel(migrated.requirements, assignedTasks, 'task-b', target);
assert.equal(moved.requirements.length, 2);
assert.equal(moved.assignments.get('task-a'), moved.assignments.get('task-b'));

const movedTasks = assignedTasks.map(task => ({ ...task, requirementId: moved.assignments.get(task.id) }));
const split = splitTaskInRequirementModel(moved.requirements, movedTasks, 'task-b', nextId);
assert.notEqual(split.assignments.get('task-a'), split.assignments.get('task-b'));
assert.equal(split.requirements.length, 3);

const occurrences = new Map();
for (const requirement of split.requirements) {
    for (const taskId of requirement.taskIds) {
        occurrences.set(taskId, (occurrences.get(taskId) ?? 0) + 1);
    }
}
assert.deepEqual([...occurrences.values()], [1, 1, 1]);

const removed = removeTaskFromRequirementModel(split.requirements, 'task-b');
assert.equal(removed.some(requirement => requirement.taskIds.includes('task-b')), false);
assert.equal(removed.length, 2);

const currentTasks = tasks.map(task => ({ ...task, requirementId: split.assignments.get(task.id) }));
assert.equal(currentRequirementIdForTasks(currentTasks), split.assignments.get('task-c'));

const legacyLongTitle = 'これは二十四文字を超える古いタスク由来の要件タイトルです';
const secondLongTitle = '一度短縮されたあとに設定された二十四文字を超えるタイトルです';
const storedRequirement = (id, title, titleSource, titleShortened) => ({
    id,
    sessionId: 'legacy',
    title,
    titleSource,
    titleShortened,
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    taskIds: [`${id}-task`]
});
const restoredLegacy = shortenLegacyRequirementTitle(storedRequirement('legacy-long', legacyLongTitle, 'task'));
assert(restoredLegacy.title.length <= 24);
assert.equal(restoredLegacy.titleShortened, true);
const restoredAgain = shortenLegacyRequirementTitle({ ...restoredLegacy, title: secondLongTitle });
assert.equal(restoredAgain.title, secondLongTitle);
const userTitle = shortenLegacyRequirementTitle(storedRequirement(
    'user-long', 'User supplied requirement title that remains untouched', 'user'));
assert.equal(userTitle.title, 'User supplied requirement title that remains untouched');
assert.equal(userTitle.titleShortened, undefined);
const aiTitle = shortenLegacyRequirementTitle(storedRequirement(
    'ai-long', 'AI supplied requirement title that remains untouched', 'ai'));
assert.equal(aiTitle.title, 'AI supplied requirement title that remains untouched');
assert.equal(aiTitle.titleShortened, undefined);
const shortTitle = shortenLegacyRequirementTitle(storedRequirement('task-short', '短いタイトル', 'task'));
assert.equal(shortTitle.title, '短いタイトル');
assert.equal(shortTitle.titleShortened, undefined);

console.log('requirement-model tests passed');
