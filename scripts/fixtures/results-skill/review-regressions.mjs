import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { appInput, fixture, runFolder, writeCase, prepare, render } from './helper.mjs';
import { baselinePrepared, baselineDraft, baselineInput } from './generic-checks.mjs';
import { deriveViews } from '../../../agent-window/skills/poiesis-results/scripts/derive-views.mjs';
import { deriveTestResults } from '../../../agent-window/skills/poiesis-results/scripts/derive-test-links.mjs';
import { reduceGraph } from '../../../agent-window/skills/poiesis-results/scripts/graph.mjs';

const clone = value => structuredClone(value);
const htmlPath = resolve(runFolder, 'results.html');
const preparedPath = resolve(runFolder, 'prepared.json');
function caseRender(input = baselineInput, draft = baselineDraft, prepared = baselinePrepared) {
  writeCase(clone(input), JSON.stringify(draft));
  writeFileSync(preparedPath, JSON.stringify(prepared), 'utf8');
  const result = render().body;
  return { result, html: result.ok ? readFileSync(htmlPath, 'utf8') : '' };
}
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('J1 置換中のドル記号をそのまま表示する', () => {
  const input = clone(baselineInput);
  input.task.request = '文字 $& $1 $` $\' を表示します。';
  const { result, html } = caseRender(input);
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert(html.includes(input.task.request.replaceAll('&', '&amp;').replaceAll("'", '&#39;')),
    html.match(/<p class="ex-request">[\s\S]*?<\/p>/)?.[0] ?? '依頼の文がありません');
});
check('J2 M の入口図にも題名を必須にする', () => {
  const draft = clone(baselineDraft), prepared = clone(baselinePrepared);
  prepared.views.selected.T = false;
  delete draft.viewNames.flowTitle;
  const { result } = caseRender(baselineInput, draft, prepared);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /入口の図/);
});
check('J2 構造の索引がなくても描く入口のまとまりには名前を必須にする', () => {
  const draft = clone(baselineDraft), prepared = clone(baselinePrepared);
  prepared.views.selected.T = false; prepared.views.structure = null;
  delete draft.viewNames.count;
  const { result } = caseRender(baselineInput, draft, prepared);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /入口のまとまり/);
});
check('J3 読む部品にも日本語名を必須にする', () => {
  const draft = clone(baselineDraft);
  const reader = baselinePrepared.views.structure.readerId;
  const index = draft.nodes.findIndex(item => item.id === reader);
  assert(index >= 0);
  const [removed] = draft.nodes.splice(index, 1);
  draft.nodes[0].hunkIds.push(...removed.hunkIds);
  const { result } = caseRender(baselineInput, draft);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /図に出す部品/);
});
check('J4 状態図の主役の線で使う条件を命名索引に入れる', () => {
  const source = readFileSync(resolve(fixture, 'index.html'), 'utf8')
    .replace(/(function finish\(\) \{\r?\n\s*)stopTicker\(\);/, '$1recordCompletedWork();');
  const workspace = resolve(runFolder, 'j4');
  mkdirSync(workspace, { recursive: true }); writeFileSync(resolve(workspace, 'index.html'), source, 'utf8');
  writeCase(appInput(workspace));
  assert.equal(prepare().body.ok, true);
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
  const through = prepared.views.stateMachine.transitions.find(item => item.main).throughLine;
  const primary = prepared.map.edges.find(item => item.id === prepared.views.structure.primaryCallId).line;
  assert.notEqual(through, primary);
  assert(prepared.views.naming.conditions.some(item => item.line === through));
});
check('J5 同じ値の異なる引数名で日付の境目を作らない', () => {
  const source = readFileSync(resolve(fixture, 'index.html'), 'utf8').replace('getLocalDay(deadline)', 'getLocalDay(Date.now())');
  const workspace = resolve(runFolder, 'j5');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(resolve(workspace, 'index.html'), source, 'utf8');
  const input = appInput(workspace);
  writeCase(input, JSON.stringify({ lead: '変更しました。', mapCaption: '処理を示します。', nodes: [], edges: [], offMap: [], interpretations: [], concerns: [], unverified: [] }));
  assert.equal(prepare().body.ok, true);
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
  assert.equal(prepared.views.boundary, null);
});
check('J5 補助関数の本文に今の取得があっても既定値を取り違えない', () => {
  const source = readFileSync(resolve(fixture, 'index.html'), 'utf8')
    .replace('timestamp = Date.now()', 'timestamp = deadline')
    .replace('const date = new Date(timestamp);', 'const date = new Date(timestamp); Date.now();');
  const workspace = resolve(runFolder, 'j5-default');
  mkdirSync(workspace, { recursive: true }); writeFileSync(resolve(workspace, 'index.html'), source, 'utf8');
  writeCase(appInput(workspace));
  assert.equal(prepare().body.ok, true);
  assert.equal(JSON.parse(readFileSync(preparedPath, 'utf8')).views.boundary, null);
});
check('J9 不正な完了日時を境目の日付として表示しない', () => {
  const input = clone(baselineInput); input.task.endedAt = 'invalid';
  writeCase(input, JSON.stringify(baselineDraft));
  assert.equal(prepare().body.ok, true);
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
  const { result, html } = caseRender(input, baselineDraft, prepared);
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert(!/<div class="ex-view-date-axis"><span> 23:59/.test(html));
});
check('J10 キーの例では日付の穴だけを日付にする', () => {
  const prepared = clone(baselinePrepared), draft = clone(baselineDraft);
  prepared.views.keys[0].shape = 'scope:{scope}:{getLocalDay()}';
  prepared.views.boundary.datePartIds = ['1'];
  prepared.views.naming.keyParts = [{ id: '0', expression: 'scope' }, { id: '1', expression: 'getLocalDay()' }];
  draft.viewNames.keyParts = { 0: '保存する範囲', 1: '現地の日付' };
  const { result, html } = caseRender(baselineInput, draft, prepared);
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert(html.includes('scope:{保存する範囲}:2026-'));
});
check('J6 削除を調べた範囲だけを説明する', () => {
  const { html } = caseRender();
  assert(!html.includes('古い日は消さない'));
});
check('J6 try の外の読み込みに catch を付けない', () => {
  const source = readFileSync(resolve(fixture, 'index.html'), 'utf8')
    .replace('        try {\n          const stored', '        const marker = true;\n          const stored')
    .replace('        } catch {\n          // Keep counting', '        try { throw Error() } catch {\n          // Keep counting');
  const workspace = resolve(runFolder, 'j6');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(resolve(workspace, 'index.html'), source, 'utf8');
  writeCase(appInput(workspace));
  assert.equal(prepare().body.ok, true);
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
  assert.equal(prepared.views.keys[0].facts.readCatchLine, null);
});
check('J7 図のカードから部品の説明と差分を開く', () => {
  const { result, html } = caseRender();
  assert.equal(result.ok, true);
  const writer = baselineDraft.nodes.find(item => item.id === baselinePrepared.views.structure.writerId);
  assert(html.includes(writer.caption));
  assert(html.includes(`data-node-id="${writer.id}"`) || html.includes(`data-view-source="${writer.id}"`));
  for (const node of baselineDraft.nodes) assert(html.includes(node.caption), `J7: ${node.title} の説明がありません`);
});
check('J11 prototype の名前を対応表の値として受け取らない', () => {
  const draft = clone(baselineDraft);
  const line = baselinePrepared.views.naming.entries[0].line;
  delete draft.viewNames.entries[line];
  draft.viewNames.entries = Object.fromEntries(Object.entries(draft.viewNames.entries).filter(([key]) => key !== String(line)));
  const prepared = clone(baselinePrepared);
  prepared.views.naming.entries[0].line = 'constructor';
  const { result } = caseRender(baselineInput, draft, prepared);
  assert.equal(result.ok, false);
});
check('J12 部品のない判断に状態図の札を付けない', () => {
  const draft = clone(baselineDraft);
  draft.interpretations.push({ decision: '追加の判断', tests: [] });
  const prepared = clone(baselinePrepared);
  prepared.views.keys = []; prepared.views.structure = null;
  prepared.views.selected.D = false; prepared.views.selected.C = false;
  const { result, html } = caseRender(baselineInput, draft, prepared);
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert(!/<section class="ex-view ex-view-state"[\s\S]*?<\/section>/.exec(html)?.[0].includes('判断6'));
});
check('J13 塊の本文に現れるファイル見出し風の追加行を読む', () => {
  const source = `++ b/other;\nfunction save(){ localStorage.setItem('k', 'v'); }\nsave();\n`;
  const diff = `diff --git a/case.js b/case.js\n--- a/case.js\n+++ b/case.js\n@@ -1 +1,3 @@\n--- old\n+++ b/other;\n+function save(){ localStorage.setItem('k', 'v'); }\n+save();\n`;
  const views = deriveViews(source, diff, 'case.js');
  assert(views?.keys?.some(key => key.changed));
});
check('J14 別々の実行の終了コードを結び付けない', () => {
  const found = deriveTestResults('command: first\ncommand: second\nexit code: 0\nok 1 - passed second\n');
  assert.deepEqual(found.run, { command: 'second', exitCode: 0 });
  assert.deepEqual(found.tests.map(test => test.name), ['passed second']);
});
check('J14 失敗した後の別実行の検査を初回成功に含めない', () => {
  const found = deriveTestResults('command: first\nexit code: 0\nok 1 - passed first\ncommand: second\nexit code: 1\nok 1 - failed second\n');
  assert.deepEqual(found.run, { command: 'first', exitCode: 0 });
  assert.deepEqual(found.tests.map(test => test.name), ['passed first']);
});
check('J15 入口に畳んだ部品の札を入口に数える', () => {
  const nodes = [{ id: 'entry', kind: 'entry', symbol: 'event', file: 'case.js', line: 1, end: 1,
    title: '入口', caption: '入口です。', status: 'new', outgoing: ['edge'], badgeCount: 0 },
  { id: 'target', kind: 'function', symbol: 'target', file: 'case.js', line: 2, end: 3,
    title: '処理', caption: '処理です。', status: 'existing', outgoing: [], badgeCount: 1 }];
  const graph = reduceGraph(nodes, [{ id: 'edge', from: 'entry', to: 'target', file: 'case.js', line: 1, access: 'call' }]);
  assert.deepEqual(graph.nodes[0].members, ['entry', 'target']);
  assert.equal(graph.nodes[0].badgeCount, 1);
});
check('J15 M だけの文書でも畳まれた部品の札を描く', () => {
  const source = "function bridge(){ changeA(); }\nfunction changeA(){ return 2; }\nfunction changeB(){ return changeA()+3; }\ndocument.addEventListener('click', bridge);\n";
  const diff = "diff --git a/merged.js b/merged.js\n--- a/merged.js\n+++ b/merged.js\n@@ -1,4 +1,4 @@\n function bridge(){ changeA(); }\n-function changeA(){ return 1; }\n+function changeA(){ return 2; }\n-function changeB(){ return changeA()+2; }\n+function changeB(){ return changeA()+3; }\n document.addEventListener('click', bridge);\n";
  const workspace = resolve(runFolder, 'j15');
  mkdirSync(workspace, { recursive: true }); writeFileSync(resolve(workspace, 'merged.js'), source, 'utf8');
  const input = appInput(workspace, diff);
  input.changedFiles = [{ path: 'merged.js', status: 'modified', additions: 2, deletions: 2 }];
  writeCase(input);
  assert.equal(prepare().body.ok, true);
  const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
  assert.deepEqual(prepared.views.selected, { S: false, D: false, T: false, C: false, M: true });
  const target = prepared.map.nodes.find(node => node.symbol === 'bridge');
  const entry = prepared.map.nodes.find(node => node.kind === 'entry' && node.symbol.includes('click'));
  assert(target && entry);
  const draft = { lead: '処理を変更しました。', mapCaption: '入口と処理の関係を示します。',
    nodes: prepared.map.nodes.map((node, index) => ({ id: node.id, title: `部品${index + 1}`, caption: 'この部品の役割を示します。',
      hunkIds: index === 0 ? prepared.hunks.map(hunk => hunk.id) : [] })),
    edges: prepared.map.edges.map(edge => edge.id), offMap: [],
    interpretations: [{ decision: '入口の先を確かめます。', nodeId: target.id, line: target.line, tests: [] }],
    concerns: [], unverified: [] };
  const { result, html } = caseRender(input, draft, prepared);
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  const box = result.geometry.boxes.find(item => item.members.includes(entry.id) && item.members.includes(target.id));
  assert(box && box.badgeCount === 1);
  assert.match(html, /class="ex-marker ex-marker-decision"[^>]*>判断1<\/text>/);
});
check('J16 大きい方と不正値の行は読む処理だけから取る', () => {
  const source = readFileSync(resolve(fixture, 'index.html'), 'utf8')
    .replace('Number.isSafeInteger(parsed) && parsed >= 0) count = Math.max(count, parsed)', 'parsed >= 0) count = count > parsed ? count : parsed')
    .replace('getDailyCount(day) + 1', 'Math.max(1, getDailyCount(day)) + 1');
  const workspace = resolve(runFolder, 'j16');
  mkdirSync(workspace, { recursive: true }); writeFileSync(resolve(workspace, 'index.html'), source, 'utf8');
  writeCase(appInput(workspace));
  assert.equal(prepare().body.ok, true);
  const facts = JSON.parse(readFileSync(preparedPath, 'utf8')).views.keys[0].facts;
  assert.equal(facts.maxLine, null);
  assert.equal(facts.invalidLine, null);
});
check('J17 読めない script を skipped に記録する', () => {
  const source = '<script>function broken( {</script>\n<script>function valid(){ return 1; } valid();</script>\n';
  const diff = `diff --git a/case.html b/case.html\n--- a/case.html\n+++ b/case.html\n@@ -0,0 +1,2 @@\n${source.trimEnd().split('\n').map(line => '+' + line).join('\n')}\n`;
  const workspace = resolve(runFolder, 'j17');
  mkdirSync(workspace, { recursive: true }); writeFileSync(resolve(workspace, 'case.html'), source, 'utf8');
  const input = appInput(workspace, diff);
  input.changedFiles = [{ path: 'case.html', status: 'added', additions: 2, deletions: 0 }];
  writeCase(input);
  assert.equal(prepare().body.ok, true);
  assert(JSON.parse(readFileSync(preparedPath, 'utf8')).skipped.includes('case.html'));
});

const failed = [];
for (const [name, fn] of checks) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failed.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
if (failed.length) throw new Error(`${failed.length}件の独立レビュー回帰試験が失敗しました。`);
