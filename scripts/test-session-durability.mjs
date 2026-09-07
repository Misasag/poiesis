import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    canReuseSessionForNewChat,
    restoredDurableTaskCandidates,
    sessionHasRailContent,
    tasksForDurableSession
} = require('../agent-window/lib/common/session-persistence.js');
const { taskProducesResult } = require('../agent-window/lib/common/task-outcome.js');

const tasks = Array.from({ length: 15 }, (_, index) => {
    const id = `task-${index + 1}`;
    return {
        id,
        sessionId: 'session-a',
        requirementId: index === 0 ? 'requirement-result' : 'requirement-conversation',
        title: `Task ${index + 1}`,
        request: index === 0 ? '最初の成果' : `後続の質問 ${index}`,
        requirementChoice: 'default',
        status: 'completed',
        startedAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
        endedAt: new Date(Date.UTC(2026, 8, 1, 0, index, 30)).toISOString(),
        outcomeKind: index === 0 ? undefined : 'conversation',
        baseline: { kind: 'workspace-snapshot', capturedAt: '2026-09-01T00:00:00.000Z' },
        changeSet: { source: 'empty', files: [], diff: '', capturedAt: '2026-09-01T00:00:30.000Z' },
        resultsDocument: index === 0 ? {
            taskId: id,
            status: 'ready',
            html: '<html><body>保持する成果</body></html>'
        } : undefined
    };
});

const persisted = tasksForDurableSession(tasks);
tasks[1].changeSet.error = '変更の記録が時間内に完了しませんでした。';
const persistedWithUnavailableReason = tasksForDurableSession(tasks);
assert.equal(persisted.length, 15, 'Durable session storage must not discard Tasks after the tenth turn.');
const roundTripped = JSON.parse(JSON.stringify(persisted));
const restored = restoredDurableTaskCandidates(roundTripped);
assert.equal(restored.length, 15, 'All persisted Tasks must restore after reload.');
assert.equal(restored[0].resultsDocument?.html, '<html><body>保持する成果</body></html>');
assert.equal(taskProducesResult(restored[0]), true, 'A backward-compatible Result must remain reachable after restoration.');
assert.equal(restored.at(-1)?.request, '後続の質問 14');
assert.equal(
    JSON.parse(JSON.stringify(persistedWithUnavailableReason))[1].changeSet.error,
    '変更の記録が時間内に完了しませんでした。',
    'Persisted Task change evidence must retain why capture was unavailable.'
);
const draftSession = { archived: false, hasUserMessage: false, agentDraft: '送信前の下書き' };
assert.equal(sessionHasRailContent(draftSession), true, 'A non-empty draft must remain reachable in the rail.');
assert.equal(canReuseSessionForNewChat(draftSession), false, 'New Chat must not overwrite or trap a non-empty draft.');
assert.equal(sessionHasRailContent({ ...draftSession, agentDraft: '   ' }), false,
    'An empty conversation must not clutter the rail.');

console.log('SESSION_DURABILITY_TEST={"tasksPersisted":15,"tasksRestored":15,"legacyResultRetained":true,"captureErrorRetained":true}');
