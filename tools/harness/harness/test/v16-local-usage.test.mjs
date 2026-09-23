import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context, write } from '../bin/lib/util.mjs';
import { importLocalUsage } from '../bin/lib/local-usage.mjs';
import { costReport, formatCost } from '../bin/lib/cost.mjs';
import { seedLocalData } from './fixtures/local-data.mjs';

test('Local CLI import streams Codex and Claude records, deduplicates Claude messages and measures weekly plan fit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-v16-')), ctx = context(root), home = path.join(root, 'home');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seedLocalData(ctx); ctx.localUsageHome = home; ctx.accountStatus = async () => ({ status: 'unavailable' });
  const now = new Date(), recent = new Date(now.getTime() - 86400000).toISOString(), old = new Date(now.getTime() - 40 * 86400000).toISOString();
  const reset = Math.floor((now.getTime() + 4 * 86400000) / 1000);
  const codex = [
    { timestamp: recent, type: 'turn_context', payload: { model: 'gpt-6-sol' } },
    { timestamp: recent, type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: 'prolite', primary: { used_percent: 90, window_minutes: 10080, resets_at: reset - 7 * 86400 } } } },
    { timestamp: recent, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } }, rate_limits: { plan_type: 'pro', primary: { used_percent: 30, window_minutes: 10080, resets_at: reset } } } },
    { timestamp: recent, type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: 'pro', primary: { used_percent: 35, window_minutes: 10080, resets_at: reset + 100 } } } },
    { timestamp: recent, type: 'turn_context', payload: { model: 'unknown-codex' } },
    { timestamp: recent, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 7, output_tokens: 3 } }, rate_limits: { plan_type: 'pro', primary: { used_percent: 10, window_minutes: 10080, resets_at: reset + 7 * 86400 } } } },
    { timestamp: old, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 999 } } } }
  ];
  write(path.join(home, '.codex/sessions/2026/09/22/rollout-fixture.jsonl'), codex.map(x => JSON.stringify(x)).join('\n') + '\ninvalid\n');
  const assistant = { timestamp: recent, type: 'assistant', message: { id: 'msg-1', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 } } };
  const unknown = { timestamp: recent, type: 'assistant', message: { id: 'msg-2', model: 'unknown-claude', usage: { input_tokens: 5, output_tokens: 2 } } };
  write(path.join(home, '.claude/projects/a/one.jsonl'), [assistant, assistant, unknown,
    { ...assistant, message: { ...assistant.message, id: 'synthetic', model: '<synthetic>' } },
    { ...assistant, timestamp: old, message: { ...assistant.message, id: 'old' } }].map(x => JSON.stringify(x)).join('\n'));
  write(path.join(home, '.claude/projects/a/sub/two.jsonl'), JSON.stringify(assistant) + '\n');
  const local = await importLocalUsage(ctx, { home, days: 30, now });
  assert.equal(local.codex.input, 107); assert.equal(local.codex.cached_input, 40); assert.equal(local.codex.output, 13);
  assert.equal(local.codex.api_equivalent_usd, .000228); assert.deepEqual(local.codex.unpriced_models, ['unknown-codex']);
  assert.equal(local.claude.input, 15); assert.equal(local.claude.cache_creation_input, 2); assert.equal(local.claude.cached_input, 3);
  assert.equal(local.claude.api_equivalent_usd, .0001306); assert.deepEqual(local.claude.unpriced_models, ['unknown-claude']);
  assert.equal(local.weekly_windows.length, 3); assert.equal(local.weekly_windows[1].peak_used_percent, 35);
  assert.equal(local.plan_fit.plan_type, 'pro'); assert.equal(local.plan_fit.quarter_capacity_exceeded_weeks, 1);
  const report = await costReport(ctx, { local: true, days: '30' }, now);
  assert.equal(report.subscriptions[0].local_usage.api_equivalent_usd, .000228);
  assert.match(formatCost(report), /a plan with 1\/4 of the capacity would have been exceeded in 1 of 2 weeks/);
});

test('Local import uses only the supplied home and rejects invalid periods', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-v16-empty-')), ctx = context(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seedLocalData(ctx);
  const local = await importLocalUsage(ctx, { home: path.join(root, 'empty'), days: 30 });
  assert.equal(local.codex.files, 0); assert.equal(local.claude.files, 0);
  await assert.rejects(importLocalUsage(ctx, { home: root, days: 0 }), /days/);
});
