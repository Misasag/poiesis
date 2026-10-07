import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context } from '../bin/lib/util.mjs';
import { append, ledger } from '../bin/lib/ledger.mjs';
import { evaluateScenario, deterministicAssertions, judgeItems, compareReports, scenarioLedgerRecord, executeSteps } from '../bin/lib/scenario.mjs';

const capture = { message: 'こう理解しました T-1', workspace: { source_paths_delta: [] }, harness_files: { 'intent/T-1.md': '作業の記録を残す', 'tickets/T-1.md': 'title: Records\nstate: 実行中' }, usage_line: '42 tokens', results: 'なぜ 何を 証拠 未検証 人間が判断すること', screenshots: ['S2.png'] };

test('fake driver executes ordered steps and evaluates assertions', async () => {
  const calls = [], driver = { begin: async () => calls.push('begin'), send: async s => calls.push(`send:${s.text}`), wait: async () => calls.push('wait'), capture: async () => { calls.push('capture'); return capture; } };
  const spec = { id: 'S2', steps: [{ type: 'send', text: 'request' }, { type: 'wait' }, { type: 'capture' }], assertions: [{ noSourceChanges: true }, { messageMatches: 'こう理解しました' }, { harnessFileMatches: { path: '^intent/', pattern: '作業の記録' } }, { activeTicketNamed: true }] };
  const row = await evaluateScenario(context(), spec, driver, 'fake', 'gpt-6-luna');
  assert.deepEqual(calls, ['begin', 'send:request', 'wait', 'capture']);
  assert.equal(row.passed, 4);
  assert.equal(row.total, 4);
  assert.equal(row.tokens, 42);
  assert.deepEqual(row.screenshots, ['S2.png']);
  assert.deepEqual(deterministicAssertions([{ filesChanged: true }], capture)[0].verdict, 'fail');
  await assert.rejects(executeSteps([{ type: 'wait' }], driver, 'fake'), /no capture/);
});

test('judge failure is uncertain, never a pass; deterministic failure wins', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-scenario-test-'));
  try {
    const ctx = context(tmp);
    const items = [{ id: 'summary', question: 'Scannable?' }];
    const judged = await judgeItems(ctx, items, capture, 'gpt-6-luna', { run: async () => ({ run_id: 'judge-failed', exit_code: 1 }) });
    assert.deepEqual(judged.map(x => x.verdict), ['uncertain']);
    const row = await evaluateScenario(ctx, { id: 'S2', steps: [{ type: 'capture' }], assertions: [{ filesChanged: true }], rubric: items }, { capture: async () => capture }, 'fake', 'gpt-6-luna', { run: async () => ({ run_id: 'judge-failed', exit_code: 1 }) });
    assert.equal(row.passed, 0);
    assert.equal(row.total, 2);
    assert.deepEqual(row.assertions.map(x => x.verdict), ['fail', 'uncertain']);
    const record = scenarioLedgerRecord(ctx, 'core', row, 'gpt-6-luna', { 'skill/SKILL.md': 'abc' }, path.join(tmp, '.harness', 'scenarios', 'example'));
    append(ctx, record);
    assert.equal(ledger(ctx).at(-1).kind, 'scenario');
    assert.equal(ledger(ctx).at(-1).harness_skill_hashes['skill/SKILL.md'], 'abc');
    assert.equal(record.report_rel, '.harness/scenarios/example/report.json');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('compare reports lists assertion transitions', () => {
  const before = { scenarios: [{ id: 'S1', assertions: [{ id: 'det-1', verdict: 'fail' }, { id: 'det-2', verdict: 'pass' }] }] };
  const after = { scenarios: [{ id: 'S1', assertions: [{ id: 'det-1', verdict: 'pass' }, { id: 'det-2', verdict: 'pass' }] }] };
  assert.deepEqual(compareReports(before, after), [{ assertion: 'S1/det-1', before: 'fail', after: 'pass' }]);
});

test('usage line keeps compact input and output token counts', async () => {
  const row = await evaluateScenario(context(), { id: 'S1', steps: [{ type: 'capture' }] },
    { capture: async () => ({ ...capture, usage_line: '31秒 · 入力 1.2k トークン（キャッシュ 90%） · 出力 765' }) }, 'fake', 'gpt-6-luna');
  assert.equal(row.tokens, 1965);
});
