import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sessionFacts, resolveAppRoot, SESSION_KEY, REQUIREMENTS_KEY } from '../bin/lib/dogfood.mjs';
import { context, git } from '../bin/lib/util.mjs';

const envelope = (key, value) => ({ format: 1, key, present: true, value });
const document = { taskId: 'task-2', status: 'ready', html: '<h1>Actual result</h1>',
  generator: 'ai', model: 'gpt-6-luna', assertionAttempts: 2, generatedAt: '2026-09-23T10:00:20Z' };
const task = { id: 'task-2', sessionId: 'session-1', requirementId: 'requirement-1',
  status: 'completed', startedAt: '2026-09-23T10:00:00Z', endedAt: '2026-09-23T10:00:10Z',
  activities: [{ id: 'a1' }, { id: 'a2', metadata: { activities: [1, 2, 3, 4] } }], resultsDocument: document };
const saved = (tasks = [task], extra = {}) => envelope(SESSION_KEY, { version: 1,
  sessions: [{ id: 'session-1', tasks, messages: [{ activities: [1, 2, 3], assertionAttempts: 99 }], ...extra },
    { id: 'other-session', tasks: [{ ...task, sessionId: 'other-session', startedAt: '2026-10-01T00:00:00Z', activities: [] }] }] });

test('dogfood extracts only the selected durable Task, not nested activities or another session', () => {
  const facts = sessionFacts(saved([{ ...task, id: 'old-task', startedAt: '2026-09-22T00:00:00Z' }, task]), 'session-1');
  assert.equal(facts.task_id, 'task-2');
  assert.equal(facts.activity_count, 2);
  assert.equal(facts.assertionAttempts, 2);
  assert.equal(facts.document_source, 'task.resultsDocument');
  assert.equal(facts.generatedAt, document.generatedAt);
  assert.match(facts.html_sha256, /^[a-f0-9]{64}$/);
  assert.equal(sessionFacts(saved(), 'absent'), null);
  assert.equal(sessionFacts(saved(), 'session-1', undefined, 'absent'), null);
});

test('dogfood distinguishes a measured zero from missing fields and rejects invalid envelopes', () => {
  const noDocument = { ...task, resultsDocument: undefined, activities: undefined };
  assert.equal(sessionFacts(saved([noDocument]), 'session-1').activity_count, null);
  assert.equal(sessionFacts(saved([noDocument]), 'session-1').assertionAttempts, null);
  assert.equal(sessionFacts(saved([{ ...noDocument, activities: [] }]), 'session-1').activity_count, 0);
  assert.equal(sessionFacts({ ...saved(), present: false }, 'session-1'), null);
  assert.equal(sessionFacts({ ...saved(), key: REQUIREMENTS_KEY }, 'session-1'), null);
  assert.equal(sessionFacts(saved().value, 'session-1'), null);
});

test('dogfood resolves legacy and requirement documents only through the owning session and requirement', () => {
  const noDocument = { ...task, resultsDocument: undefined };
  const legacy = sessionFacts(saved([noDocument], { resultsDocuments: [{ ...document, taskId: 'wrong' }, document] }), 'session-1');
  assert.equal(legacy.document_source, 'session.resultsDocuments');
  assert.equal(legacy.assertionAttempts, 2);
  const requirements = envelope(REQUIREMENTS_KEY, { version: 1, sessions: { 'session-1': [
    { id: 'requirement-1', sessionId: 'session-1', taskIds: ['task-2'], resultsDocument: { ...document, taskId: 'requirement-1' } }
  ] } });
  const aggregate = sessionFacts(saved([noDocument]), 'session-1', requirements);
  assert.equal(aggregate.document_source, 'requirement.resultsDocument');
  assert.equal(aggregate.document_task_id, 'requirement-1');
  requirements.value.sessions['session-1'][0].taskIds = ['another-task'];
  assert.equal(sessionFacts(saved([noDocument]), 'session-1', requirements).document_status, null);
  assert.equal(sessionFacts(saved(), 'session-1', requirements).document_source, 'task.resultsDocument');
});

test('dogfood preserves generating and fallback states without inventing attempt counts', () => {
  const generating = sessionFacts(saved([{ ...task, resultsDocument: { ...document, status: 'generating' } }]), 'session-1');
  assert.equal(generating.document_status, 'generating');
  const fallback = sessionFacts(saved([{ ...task, resultsDocument: { taskId: task.id, status: 'ready',
    generator: 'fallback', fallbackReason: 'generation-failed', html: '<p>Fallback</p>' } }]), 'session-1');
  assert.equal(fallback.assertionAttempts, null);
  assert.equal(fallback.generator, 'fallback');
  assert.equal(fallback.fallback_reason, 'generation-failed');
});

test('dogfood resolves default app-root through the Git common dir and accepts an explicit override', async () => {
  const ctx = context();
  const common = (await git(ctx.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
  assert.equal(path.resolve(await resolveAppRoot(ctx)), path.resolve(path.dirname(common)));
  assert.equal(await resolveAppRoot(ctx, 'explicit-app'), path.resolve('explicit-app'));
  await assert.rejects(resolveAppRoot(ctx, true), /requires a directory/);
  await assert.rejects(resolveAppRoot(ctx, ' '), /requires a directory/);
});
