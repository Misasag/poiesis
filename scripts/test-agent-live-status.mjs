import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { agentLiveStatus } = require('../agent-window/lib/browser/agent-live-status.js');
const started = '2026-09-23T00:00:00Z';
const progress = { phase: 'activity', lastOutputAt: started };
const activity = { kind: 'command', status: 'running', detail: 'npm test\n--verbose', startedAt: started };
const at = age => Date.parse(started) + age;
assert.equal(agentLiveStatus(started, progress, activity, false, at(9999)), 'コマンドを実行しています: npm test --verbose');
assert.equal(agentLiveStatus(started, progress, activity, false, at(10000)), '応答を待っています · 最終出力 10秒前');
assert.equal(agentLiveStatus(started, progress, activity, true, at(60000)), '成果をまとめています');
assert.equal(agentLiveStatus(started, { phase: 'preparing' }, activity, false, at(60000)), '変更前のファイルを記録しています');
for (const [kind, detail, expected] of [['file-change', 'index.html · 更新', 'index.html を編集しています'],
    ['read', 'src/app.ts', 'ファイルを読んでいます: src/app.ts'], ['reasoning', 'private thought', '考えています']]) {
    assert.equal(agentLiveStatus(started, progress, { ...activity, kind, detail }, false, at(0)), expected);
}
assert(agentLiveStatus(started, progress, { ...activity, detail: 'x'.repeat(500) }, false, at(0)).length < 130);
console.log('AGENT_LIVE_STATUS_TEST=passed');
