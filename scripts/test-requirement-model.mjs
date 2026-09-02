import assert from 'node:assert/strict';
import {
    currentRequirementIdForTasks,
    migrateRequirementModel,
    moveTaskInRequirementModel,
    removeTaskFromRequirementModel,
    splitTaskInRequirementModel
} from '../agent-window/lib/browser/requirement-model.js';

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
console.log('requirement-model tests passed');
