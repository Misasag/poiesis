import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { route, textWidth } from '../agent-window/skills/poiesis-results/scripts/layout.mjs';
import { appInput, fixture, runFolder, skill, writeCase, prepare, render, copyFixtureDraft } from './fixtures/results-skill/helper.mjs';

const skillText = readFileSync(resolve(skill, 'SKILL.md'), 'utf8').replace(/^\uFEFF/, '');
assert(skillText.indexOf('1. `node <skillフォルダー>/scripts/prepare.mjs`') < skillText.indexOf('## 判断基準'));
for (const phrase of [
  '## 判断基準', '現在の対象で実行成功', '失敗・未実施・実行不明', '変更前の対象で成功',
  '検証用ファイルが変わった', '人の判断が残る', '入力が矛盾・不足', '変更がない', '委任先の報告',
  '## 冒頭の答え', '終了コード0', '## 地図の根拠', '構文から分かる関係',
  '## 画像と確認の限界', '別の版', '## 平易な日本語', '## 危険な兆候と避けること',
  '## 書き終える前の確認', '## 根拠', 'harness-results/SKILL.md',
  'research-r6-results-visual-first.md', 'research-r8-results-for-engineers.md',
  'research-r9-results-app-skill-boundary.md',
  '`lead`', '`mapCaption`', '`nodes[].title/caption`', '`offMap`', '`interpretations`',
  '`concerns`', '`unverified`'
]) assert(skillText.includes(phrase), `SKILL.md に ${phrase} がありません。`);
assert(!/\b(?:flow|states|tree|compare)\b/i.test(skillText), 'アプリの図の部品名を SKILL.md に移してはいけません。');

const htmlPath = resolve(runFolder, 'results.html');
const clearHtml = () => { if (existsSync(htmlPath)) unlinkSync(htmlPath); };
const expectReason = (draftBytes, match) => {
  writeFileSync(resolve(runFolder, 'draft.json'), draftBytes);
  clearHtml();
  const result = render();
  assert.equal(result.body.ok, false);
  assert.match(result.body.reasons.join(' '), match);
  assert.equal(existsSync(htmlPath), false);
};

const input = appInput();
writeCase(input);
let result = prepare();
assert.equal(result.status, 0);
assert.equal(result.body.ok, true);
const prepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert.equal(prepared.hunks.length, 10);
assert(prepared.skipped.includes('README.md'));
result = render();
assert.equal(result.status, 0);
assert.equal(result.body.ok, true, JSON.stringify(result.body.reasons));
const original = JSON.parse(readFileSync(resolve(fixture, 'original-draft.json'), 'utf8'));
const draft = JSON.parse(readFileSync(resolve(fixture, 'draft.json'), 'utf8'));
assert.deepEqual(draft.nodes.map(x => [x.id, x.title, x.caption]), original.nodes.map(x => [x.id, x.title, x.caption]));
assert.deepEqual(draft.edges, original.edges);
assert.deepEqual(draft.offMap.map(x => [x.title, x.caption]), original.offMap.map(x => [x.title, x.caption]));
const oldHunks = ['h-64a09a5f389e', 'h-ac092537fa7d', 'h-839cec3a40f2', 'h-159d9c242bdc',
  'h-954125474537', 'h-9319192d5977', 'h-c7a2fc15a207', 'h-2420dc43fe0a',
  'h-7fe8eb6b72ec', 'h-06341ba05255'];
const remap = new Map(oldHunks.map((id, i) => [id, prepared.hunks[i].id]));
assert.deepEqual(draft.nodes.map(item => item.hunkIds), original.nodes.map(item => item.hunkIds.map(id => remap.get(id))));
assert.deepEqual(draft.offMap.map(item => item.hunkIds), original.offMap.map(item => item.hunkIds.map(id => remap.get(id))));
assert.equal(result.body.unassignedHunks, 0);
assert(result.body.drawnEdges.every(id => prepared.map.edges.some(edge => edge.id === id)));
assert.equal(new Set([...result.body.drawnEdges, ...result.body.foldedEdges]).size, draft.edges.length);
assert.equal(result.body.geometry.layerCount, 4);
assert(result.body.geometry.width <= 1000);
const html = readFileSync(htmlPath, 'utf8');
// R10-P7: one head per arrow kind, and legend heads use the document text colour instead of the SVG default black.
const heads = Object.fromEntries([...html.matchAll(/<marker id="arrow-(\w+)"[^>]*><path class="ex-arrowhead-\1" d="([^"]+)"\/><\/marker>/g)]
  .map(match => [match[1], match[2]]));
const headShape = d => `${/A/.test(d) ? 'arc' : 'line'}:${[...new Set(d.match(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g))].sort().join(' ')}`;
assert.deepEqual(Object.keys(heads).sort(), ['call', 'display', 'read', 'trigger', 'write']);
assert.equal(new Set(Object.values(heads).map(headShape)).size, 5, 'Each arrow kind needs its own head shape.');
assert(/<marker id="legend-arrow-(\w+)"[^>]*><path class="ex-arrowhead-\1"/.test(html), 'Legend heads carry their kind class.');
const skillStyle = readFileSync(resolve(skill, 'assets/style.css'), 'utf8');
assert(/\.ex-legend-svg \[class\^="ex-arrowhead-"\][^{]*\{[^}]*fill: var\(--results-fg/.test(skillStyle),
  'Legend heads use the text colour in both themes.');
for (const phrase of [draft.lead, draft.mapCaption, ...draft.nodes.flatMap(node => [node.title, node.caption]),
  ...draft.offMap.flatMap(item => [item.title, item.caption]),
  ...draft.interpretations.flatMap(item => [item.decision, item.evidence]),
  ...draft.concerns.map(item => item.text), ...draft.unverified, input.task.request])
  assert(html.includes(phrase), `Missing draft text: ${phrase}`);
for (const [index, row] of draft.interpretations.entries()) {
  const component = html.match(new RegExp(`<g data-map-node="${row.nodeId}">([\\s\\S]*?)<\\/g>`))?.[1];
  assert(component?.includes(`判断${index + 1}`), `Decision badge ${index + 1}`);
}
const concernPart = prepared.map.nodes.find(node => node.file === draft.concerns[0].file &&
  draft.concerns[0].line >= node.line && draft.concerns[0].line <= node.end && node.kind === 'function');
assert(html.match(new RegExp(`<g data-map-node="${concernPart.id}">([\\s\\S]*?)<\\/g>`))?.[1].includes('懸念1'));
assert(html.indexOf('class="ex-mapfig"') < html.indexOf('<h2>懸念点') &&
  html.indexOf('<h2>懸念点') < html.indexOf('<h2>補った判断') &&
  html.indexOf('<h2>依頼文') < html.indexOf('<details><summary>確認結果'));
const unlinkedJudgment = structuredClone(draft);
unlinkedJudgment.interpretations.push({ decision: '画面の余白を優先しました。', evidence: '画面の画像で確かめます。' });
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(unlinkedJudgment), 'utf8');
assert.equal(render().body.ok, true);
const unlinkedHtml = readFileSync(htmlPath, 'utf8');
assert(unlinkedHtml.includes('<td>判断6</td>') && unlinkedHtml.includes('画面の余白を優先しました。'));
assert(!unlinkedHtml.includes('ex-marker-decision"') || !unlinkedHtml.includes('>判断6</text>'));
const badgeTarget = draft.interpretations[1].nodeId;
const checkBadgeGeometry = (variant, expected) => {
  writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(variant), 'utf8');
  const made = render();
  assert.equal(made.body.ok, true, JSON.stringify(made.body.reasons));
  const box = made.body.geometry.boxes.find(candidate => candidate.id === badgeTarget);
  const markup = readFileSync(htmlPath, 'utf8').match(new RegExp(`<g data-map-node="${badgeTarget}">([\\s\\S]*?)<\\/g>`))?.[1];
  const badges = [...markup.matchAll(/<text class="ex-marker ex-marker-decision" x="([\d.]+)" y="([\d.]+)">([^<]+)<\/text>/g)]
    .map(match => ({ x: +match[1], y: +match[2], label: match[3] }));
  assert.deepEqual(badges.map(badge => badge.label), expected);
  const lastSubBaseline = box.y + 31 + box.titleLines.length * 19 + (box.subLines.length - 1) * 15;
  const rects = badges.map(badge => ({ x: badge.x, y: badge.y - 12, w: textWidth(badge.label, 12) + 4, h: 15 }));
  for (const rect of rects) {
    assert(rect.x >= box.x + 8 && rect.x + rect.w <= box.x + box.w - 8);
    assert(rect.y > lastSubBaseline + 2 && rect.y >= box.y && rect.y + rect.h <= box.y + box.h);
  }
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    assert(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  }
};
const allBadges = structuredClone(draft);
allBadges.concerns = [];
allBadges.interpretations.forEach(row => { row.nodeId = badgeTarget; });
checkBadgeGeometry(allBadges, ['判断1', '判断2', '判断3', '判断4', '判断5']);
const fifthBadge = structuredClone(allBadges);
fifthBadge.interpretations.slice(0, 4).forEach(row => { delete row.nodeId; });
checkBadgeGeometry(fifthBadge, ['判断5']);
// A box reserves one row per badge it draws, never rows for badges drawn elsewhere.
const markersIn = (markup, id) => [...(markup.match(new RegExp(`<g data-map-node="${id}">([\\s\\S]*?)<\\/g>`))?.[1] ?? '')
  .matchAll(/<text class="ex-marker [^"]+"[^>]*>([^<]+)<\/text>/g)].map(match => match[1]);
const expectReservedRows = (made, markup) => {
  for (const box of made.body.geometry.boxes) assert.equal(box.badgeCount, markersIn(markup, box.id).length, box.symbol);
};
expectReservedRows(result, html);
const helperId = result.body.geometry.helperIds[0];
assert(helperId, 'The fixture map must fold a helper.');
const helperJudgment = structuredClone(draft);
helperJudgment.interpretations[0].nodeId = helperId;
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(helperJudgment), 'utf8');
const helperMade = render();
assert.equal(helperMade.body.ok, true, JSON.stringify(helperMade.body.reasons));
const helperHtml = readFileSync(htmlPath, 'utf8');
const helperOwner = helperMade.body.geometry.folded.find(edge => edge.to === helperId).owner;
assert(markersIn(helperHtml, helperOwner).includes('判断1'), 'A folded helper judgment appears on the box that calls it.');
expectReservedRows(helperMade, helperHtml);
copyFixtureDraft();
assert.equal((html.match(/<script\b/g) ?? []).length, 1);
assert(html.includes('<p class="ex-fact">部品を押すと、変更の根拠を右に表示します。</p>'));
assert(html.includes(readFileSync(resolve(skill, 'assets/document.js'), 'utf8')));
assert(!/<\w+[^>]*\son[a-z]+\s*=/i.test(html));
assert(!/(?:src|href)="https?:/i.test(html));
assert(!/<img[^>]+src="(?!data:)/i.test(html));

input.images = [{ path: 'sample.png', label: '確認画像' }];
writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(input), 'utf8');
assert.equal(render().body.ok, true);
assert.match(readFileSync(htmlPath, 'utf8'), /src="data:image\/png;base64,/);
assert.match(readFileSync(htmlPath, 'utf8'), /data-poiesis-image="sample.png"/);
const largePath = resolve(fixture, 'large-image.png');
try {
  writeFileSync(largePath, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2 * 1024 * 1024)]));
  input.images = [{ path: 'large-image.png', label: '大きな画像' }];
  writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(input), 'utf8');
  assert.equal(render().body.ok, true);
  assert.match(readFileSync(htmlPath, 'utf8'), /画像が大きすぎるため省略しました。/);
  assert.match(readFileSync(htmlPath, 'utf8'), /data-poiesis-image="large-image.png"/);
} finally { if (existsSync(largePath)) unlinkSync(largePath); }
input.images = [{ path: '../outside.png', label: '外の画像' }];
writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(input), 'utf8');
assert.equal(render().body.ok, true);
assert(!readFileSync(htmlPath, 'utf8').includes('data-poiesis-image="../outside.png"'));
input.images = [];
input.requirement = { title: '作業回数の表示', tasks: [{ title: '表示の追加', completionSummary: '回数を表示しました。' }] };
writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(input), 'utf8');
assert.equal(render().body.ok, true);
assert.match(readFileSync(htmlPath, 'utf8'), /関連する作業/);
input.requirement = null;
writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(input), 'utf8');

// The screen box grows only for a screenshot the AI chose, so a document without images has no empty frame.
const screenNode = draft.nodes.find(item => prepared.map.nodes.find(node => node.id === item.id)?.kind === 'screen');
assert(screenNode, 'The fixture draft must include the screen part.');
const screenHeight = body => body.geometry.boxes.find(box => box.id === screenNode.id).h;
const plain = render();
assert.equal(plain.body.ok, true, JSON.stringify(plain.body.reasons));
const plainHtml = readFileSync(htmlPath, 'utf8');
assert(!plainHtml.includes('class="ex-mapshot"'));
assert(!plainHtml.includes('の中身</summary>'), 'Helper names read as their own names, not "〜の中身".');
assert(plainHtml.includes('ex-edge-line') && !plainHtml.includes('箱の説明に畳んだ'));
input.images = [{ path: 'sample.png', label: '変更後の画面' }];
writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(input), 'utf8');
const withShot = { ...structuredClone(draft), screenImage: 'sample.png' };
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(withShot), 'utf8');
const shot = render();
assert.equal(shot.body.ok, true, JSON.stringify(shot.body.reasons));
assert.equal(screenHeight(shot.body), screenHeight(plain.body) + 90);
assert.match(readFileSync(htmlPath, 'utf8'), /<img class="ex-mapshot" src="data:image\/png;base64,[^"]+" alt="変更後の画面"/);
expectReason(Buffer.from(JSON.stringify({ ...withShot, screenImage: 'missing.png' }), 'utf8'), /screenImage/);
input.images = [];
writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(input), 'utf8');
expectReason(Buffer.from(JSON.stringify(withShot), 'utf8'), /screenImage/);
// A hook screenshot left in the workspace reaches the document only when the AI chooses it, with its own caption.
const chosen = { ...structuredClone(draft), images: [{ path: 'sample.png', caption: '変更後のタイマー画面を幅1280で撮った画像です。' }], screenImage: 'sample.png' };
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(chosen), 'utf8');
const chosenResult = render();
assert.equal(chosenResult.body.ok, true, JSON.stringify(chosenResult.body.reasons));
const chosenHtml = readFileSync(htmlPath, 'utf8');
assert.match(chosenHtml, /<figcaption>変更後のタイマー画面を幅1280で撮った画像です。<\/figcaption>/);
assert.match(chosenHtml, /<img class="ex-mapshot" src="data:image\/png;base64,/);
assert.equal(screenHeight(chosenResult.body), screenHeight(plain.body) + 90);
expectReason(Buffer.from(JSON.stringify({ ...chosen, images: [{ path: 'missing.png', caption: '無い画像です。' }], screenImage: undefined }), 'utf8'), /missing\.png を載せられません/);
expectReason(Buffer.from(JSON.stringify({ ...chosen, images: [{ path: '../outside.png', caption: '外の画像です。' }], screenImage: undefined }), 'utf8'), /載せられません/);
expectReason(Buffer.from(JSON.stringify({ ...chosen, images: [{ path: 'README.md', caption: '画像ではありません。' }], screenImage: undefined }), 'utf8'), /載せられません/);
copyFixtureDraft();

const invalid = structuredClone(draft);
invalid.nodes[0].id = 'not-a-candidate';
expectReason(Buffer.from(JSON.stringify(invalid), 'utf8'), /候補にない部品/);
invalid.nodes[0].id = draft.nodes[0].id;
invalid.concerns[0].line = 999999;
expectReason(Buffer.from(JSON.stringify(invalid), 'utf8'), /範囲外/);
invalid.concerns[0].line = draft.concerns[0].line;
invalid.offMap[0].hunkIds = [];
expectReason(Buffer.from(JSON.stringify(invalid), 'utf8'), /割り当てのない差分/);
expectReason(Buffer.from(JSON.stringify(draft).replace('今日', '\uFFFD'), 'utf8'), /壊れた文字/);
expectReason(Buffer.from(JSON.stringify(draft), 'utf16le'), /UTF-16/);
expectReason(Buffer.from([0xff, 0xfe, 0x7b, 0x00]), /UTF-16/);
writeFileSync(resolve(runFolder, 'draft.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(draft), 'utf8')]));
assert.equal(render().body.ok, true);
copyFixtureDraft();

const deletion = appInput();
deletion.diff = 'diff --git a/gone.txt b/gone.txt\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old text\n';
deletion.changedFiles = [{ path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 }];
writeCase(deletion, JSON.stringify({ lead: '文書を削除しました。', nodes: [], edges: [], offMap: [], interpretations: [], concerns: [], unverified: [] }));
assert.equal(prepare().body.ok, true);
const removed = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert.equal(removed.hunks.length, 1);
assert.equal(removed.hunks[0].file, 'gone.txt');
const deletionDraft = { lead: '文書を削除しました。', nodes: [], edges: [],
  mapCaption: '削除した説明の差分を確認します。',
  offMap: [{ title: '文書の削除', caption: '不要な説明を取り除きました。', hunkIds: [removed.hunks[0].id] }],
  interpretations: [], concerns: [], unverified: [] };
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(deletionDraft), 'utf8');
assert.equal(render().body.ok, true);
assert.match(readFileSync(htmlPath, 'utf8'), /文書の削除/);

const emptyDraft = { lead: '変更はありません。', mapCaption: '差分と表示の結果を確認します。', nodes: [], edges: [], offMap: [], interpretations: [], concerns: [], unverified: [] };
const tsInput = appInput(fixture, "diff --git a/example.ts b/example.ts\n--- /dev/null\n+++ b/example.ts\n@@ -0,0 +1,2 @@\n+function greet(name: string): string { return name; }\n+greet('hi');\n");
tsInput.changedFiles = [{ path: 'example.ts', status: 'added', additions: 2, deletions: 0 }];
writeCase(tsInput, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);
const tsPrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert(!tsPrepared.skipped.includes('example.ts'));
assert(tsPrepared.map.nodes.some(node => node.symbol === 'greet'));

for (const status of ['completed', 'failed', 'cancelled']) {
  const noChange = appInput();
  noChange.diff = '';
  noChange.changedFiles = [];
  noChange.task.status = status;
  noChange.task.failureSummary = status === 'failed' ? '作業を完了できませんでした。' : '';
  writeCase(noChange, JSON.stringify(emptyDraft));
  assert.equal(prepare().body.ok, true);
  clearHtml();
  const output = render();
  assert.equal(output.body.ok, true, JSON.stringify(output.body.reasons));
  assert(existsSync(htmlPath));
}

const addedFile = name => {
  const lines = readFileSync(resolve(fixture, name), 'utf8').trimEnd().split('\n');
  return `diff --git a/${name} b/${name}\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n`;
};
const robustInput = appInput(fixture, addedFile('robust.js'));
writeCase(robustInput, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);
const robust = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
const part = symbol => robust.map.nodes.find(node => node.symbol === symbol);
for (const symbol of ['save', 'arrow', 'expression', 'actions.run', 'this.increment', 'this.save']) assert(part(symbol), symbol);
assert.equal(robust.map.nodes.filter(node => node.symbol === 'duplicate').length, 2);
assert.equal(new Set(robust.map.nodes.filter(node => node.symbol === 'duplicate').map(node => node.id)).size, 2);
for (const scope of ['firstScope', 'secondScope']) {
  const calls = robust.map.edges.filter(edge => edge.from === part(scope)?.id && robust.map.nodes.find(node => node.id === edge.to)?.symbol === 'duplicate');
  assert.equal(calls.length, 1, scope);
  assert.equal(calls[0].line, scope === 'firstScope' ? 11 : 12);
  assert.equal(robust.map.nodes.find(node => node.id === calls[0].to)?.line, calls[0].line);
}
assert(robust.map.edges.some(edge => edge.from === part('arrow').id && edge.to === part('save').id));
assert(robust.map.edges.some(edge => edge.from === part('actions.run').id && edge.to === part('arrow').id));
assert(robust.map.edges.some(edge => edge.from === part('this.increment').id && edge.to === part('actions.run').id));
assert(robust.map.edges.some(edge => edge.from === part('expression').id && edge.access === 'read'));
assert(robust.map.edges.some(edge => edge.from === part('save').id && edge.access === 'write'));
assert(robust.map.edges.some(edge => robust.map.nodes.find(node => node.id === edge.from)?.symbol?.includes('onclick') && edge.to === part('save').id));
assert(!robust.map.edges.some(edge => robust.map.nodes.find(node => node.id === edge.from)?.symbol === 'page load' && edge.to === part('save').id));
// Synchronous callbacks belong to their owner; deferred callbacks form a triggered processing unit.
assert(robust.map.edges.some(edge => edge.from === part('saveEach').id && edge.to === part('save').id && edge.line === 13));
const delayed = part('setTimeout 10ms の処理');
assert(delayed);
assert(robust.map.edges.some(edge => robust.map.nodes.find(node => node.id === edge.from)?.symbol === 'page load'
  && edge.to === delayed.id && edge.access === 'trigger' && edge.line === 14));
assert(robust.map.edges.some(edge => edge.from === delayed.id && edge.to === part('expression').id && edge.access === 'call'));
assert(!robust.map.edges.some(edge => robust.map.nodes.find(node => node.id === edge.from)?.symbol === 'page load'
  && edge.to === part('expression').id));
const callbackCase = appInput(fixture, addedFile('callbacks.js'));
writeCase(callbackCase, JSON.stringify(emptyDraft));
assert.equal(prepare().status, 0);
const callbackPrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
const callbackNode = symbol => callbackPrepared.map.nodes.find(node => node.symbol === symbol);
const callbackEdges = callbackPrepared.map.edges;
const fromTo = (from, to, access) => callbackEdges.some(edge => edge.from === from?.id && edge.to === to?.id && edge.access === access);
const timerBody = callbackNode('setTimeout 10ms の処理');
assert(fromTo(callbackNode('a'), timerBody, 'trigger'));
assert(fromTo(timerBody, callbackNode('b'), 'call'));
assert(!fromTo(callbackNode('a'), callbackNode('b'), 'call'));
assert(fromTo(callbackNode('each'), callbackNode('b'), 'call'));
assert(fromTo(callbackNode('later'), callbackNode('save'), 'trigger'));
const continuation = callbackNode('then の処理');
assert(fromTo(callbackNode('later'), continuation, 'trigger'));
assert(callbackEdges.some(edge => edge.from === continuation.id && edge.access === 'write'));
assert(fromTo(callbackNode('watch'), callbackNode('MutationObserver の処理'), 'trigger'));
assert(fromTo(callbackNode('page load'), callbackNode('b'), 'call'));
const nestedCase = appInput(fixture, addedFile('nested.js'));
writeCase(nestedCase, JSON.stringify(emptyDraft));
assert.equal(prepare().status, 0);
const nestedPrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert.equal(nestedPrepared.mapDecision.kind, 'map');
const nestedDraft = { lead: '保存処理を追加しました。', mapCaption: '保存する処理と行を確認します。',
  nodes: nestedPrepared.map.nodes.map((node, i) => ({ id: node.id, title: `処理${i + 1}`, caption: '保存の流れを示します。',
    hunkIds: i === 0 ? nestedPrepared.hunks.map(h => h.id) : [] })),
  edges: nestedPrepared.map.edges.map(edge => edge.id), offMap: [], interpretations: [],
  concerns: [{ text: '保存が失敗する場合があります。', file: 'nested.js', line: 3 }], unverified: [] };
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(nestedDraft), 'utf8');
const nestedMade = render();
assert.equal(nestedMade.body.ok, true);
const nestedHtml = readFileSync(htmlPath, 'utf8');
// The enclosing functions contain line 3 too, but only the part that draws the badge grows.
expectReservedRows(nestedMade, nestedHtml);
assert.equal((nestedHtml.match(/class="ex-marker ex-marker-concern"/g) ?? []).length, 1);
const affectedPart = nestedPrepared.map.nodes.find(node => node.kind === 'storage');
assert(nestedHtml.match(new RegExp(`<g data-map-node="${affectedPart.id}">([\\s\\S]*?)<\\/g>`))?.[1].includes('懸念1'));
const secretCall = appInput(fixture, addedFile('secret-call.js').replace('hunter2hunter2', '[REDACTED]'));
writeCase(secretCall, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);
assert(!readFileSync(resolve(runFolder, 'prepared.json'), 'utf8').includes('hunter2hunter2'));

const noMap = appInput(fixture, 'diff --git a/theme.css b/theme.css\n--- a/theme.css\n+++ b/theme.css\n@@ -1 +1 @@\n-old\n+new\n');
noMap.task.request = '画面を <見やすく> してください。';
noMap.changeCaptureError = '記録に失敗しました。';
noMap.verification.rows = [{ label: '画面の確認', status: 'unknown', detail: '文字化け � を含む記録です。' }];
const noMapDraft = { lead: 'README.md の 0.4.1 は 1.5秒 < 2秒です。', mapCaption: '地図はありません。', nodes: [], edges: [],
  offMap: [{ title: '画面の調整', caption: '文字の間隔を変えました。', hunkIds: [] }],
  interpretations: [{ decision: '余白を優先しました。', evidence: '画面の記録で確かめました。' }],
  concerns: [{ text: '狭い幅では崩れる可能性があります。', file: 'theme.css', line: 1 }],
  unverified: ['狭い画面での表示は未確認です。'] };
writeCase(noMap, JSON.stringify(noMapDraft));
assert.equal(prepare().body.ok, true);
const noMapPrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
noMapDraft.offMap[0].hunkIds = [noMapPrepared.hunks[0].id];
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(noMapDraft), 'utf8');
assert.equal(render().body.ok, true);
const noMapHtml = readFileSync(htmlPath, 'utf8');
for (const phrase of ['画面を &lt;見やすく&gt;', '余白を優先しました。', '狭い幅では崩れる可能性があります。',
  '狭い画面での表示は未確認です。', '記録に失敗しました。', '文字化け �', '地図はありません。']) assert(noMapHtml.includes(phrase), phrase);
assert(!noMapHtml.includes('変更はありません。'));
assert(noMapHtml.includes('<h2>作業内容</h2><p>作業回数を表示しました。</p>'), 'The agent summary stays the work description without a map.');
assert(noMapHtml.includes('1.5秒 &lt; 2秒'));
const redactedDiff = appInput(fixture, 'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+token: [REDACTED];\n');
writeCase(redactedDiff, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);

const broken = appInput(fixture, addedFile('unsupported.ts') + addedFile('robust.js'));
writeCase(broken, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);
const partial = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert(partial.skipped.includes('unsupported.ts'));
assert(partial.map.nodes.some(node => node.symbol === 'arrow'));
const scripts = appInput(fixture, addedFile('mixed.html'));
writeCase(scripts, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);
const mixed = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert(!mixed.skipped.includes('mixed.html'));
assert(mixed.map.nodes.some(node => node.symbol === 'valid'));
assert(!mixed.map.nodes.some(node => node.symbol.includes('imports')));
const sameLine = appInput(fixture, addedFile('same-line.html'));
writeCase(sameLine, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);
const sameLinePrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
const sameLineFunctions = sameLinePrepared.map.nodes.filter(node => node.kind === 'function');
assert.deepEqual(sameLineFunctions.map(node => node.symbol), ['first', 'second']);
assert.equal(new Set(sameLineFunctions.map(node => node.id)).size, 2);

const deletedDashes = appInput(fixture, 'diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n--- old note\n+new note\n');
writeCase(deletedDashes, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);
const dashed = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert.deepEqual(dashed.hunks[0].lines.map(line => line.text), ['-- old note', 'new note']);
const endings = appInput(fixture, 'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-function greet(name: string): string { return name; }\r\n+function greet(name: string): string { return name; }\n');
writeCase(endings, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);
const endingPrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert.equal(endingPrepared.lineEndingChanges, 1);
assert.equal(endingPrepared.hunks.length, 0);
assert.notEqual(endingPrepared.mapDecision.reason, '変更はありません。');
assert.equal(render().body.ok, true);
assert.match(readFileSync(htmlPath, 'utf8'), /改行コードだけの変更 1件/);
const removedStatement = appInput(fixture, "diff --git a/deletion-only.js b/deletion-only.js\n--- a/deletion-only.js\n+++ b/deletion-only.js\n@@ -1,4 +1,3 @@\n function remaining() {\n-  console.log('old');\n   return localStorage.getItem('count');\n }\n");
writeCase(removedStatement, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);
const removalPrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert.equal(removalPrepared.map.nodes.find(node => node.symbol === 'remaining')?.status, 'modified');
const started = Date.now();
const path = route({ x: 200, y: 50 }, { x: 300, y: 200 }, [{ x: 4, y: 80, w: 500, h: 90 }], [], 350, true);
assert(Date.now() - started < 2000);
assert(path?.some(point => point.x > 400), 'The path must use the corridor beyond its destination.');

const decisionCases = [
  ['CSS only', 'visual', 'diff --git a/theme.css b/theme.css\n--- a/theme.css\n+++ b/theme.css\n@@ -1 +1 @@\n-old\n+new\n'],
  ['wording only', 'visual', 'diff --git a/index.html b/index.html\n--- a/index.html\n+++ b/index.html\n@@ -1 +1 @@\n-old\n+<h1>作業回数</h1>\n'],
  ['one function', 'none', addedFile('example.ts')],
  ['deletion only', 'none', removedStatement.diff],
  ['unparsed language', 'none', 'diff --git a/change.py b/change.py\n--- /dev/null\n+++ b/change.py\n@@ -0,0 +1 @@\n+def save(): pass\n'],
  ['two or more functions', 'map', addedFile('robust.js')]
];
for (const [label, kind, diff] of decisionCases) {
  const caseInput = appInput(fixture, diff);
  caseInput.images = [{ path: 'sample.png', label: '変更後の画面' }];
  writeCase(caseInput, JSON.stringify(emptyDraft));
  assert.equal(prepare().status, 0, label);
  const decision = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
  assert.equal(decision.mapDecision.kind, kind, label);
  if (kind === 'map') {
    expectReason(Buffer.from(JSON.stringify(emptyDraft), 'utf8'), /候補の部品を選んでください/);
    continue;
  }
  const addedLine = decision.hunks.flatMap(h => h.lines.filter(line => line.kind === 'add').map(line => ({ file: h.file, line: line.line })))[0];
  const caseDraft = { lead: '変更した内容を確認しました。', mapCaption: '変更箇所と実際の表示を確認します。', nodes: [], edges: [],
    offMap: decision.hunks.map(h => ({ title: '変更のまとまり', caption: '実際の差分を確認します。', hunkIds: [h.id] })),
    interpretations: [{ decision: '表示を優先しました。', evidence: '画面と差分で確かめます。' }],
    concerns: addedLine ? [{ text: '狭い幅の表示は未確認です。', ...addedLine }] : [],
    unverified: ['狭い幅の画面表示を確認していません。'] };
  writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(caseDraft), 'utf8');
  const caseResult = render();
  assert.equal(caseResult.body.ok, true, `${label}: ${JSON.stringify(caseResult.body.reasons)}`);
  const document = readFileSync(htmlPath, 'utf8');
  for (const phrase of [caseDraft.lead, caseDraft.mapCaption, caseDraft.interpretations[0].decision,
    caseDraft.interpretations[0].evidence, ...caseDraft.unverified, ...caseDraft.concerns.map(c => c.text),
    caseInput.task.request, decision.mapDecision.reason]) assert(document.includes(phrase), `${label}: ${phrase}`);
  assert(document.indexOf('ex-lead') < document.indexOf('ex-screens') &&
    document.indexOf('<h2>懸念点') < document.indexOf('<h2>補った判断') &&
    document.indexOf('<h2>依頼文') < document.indexOf('<details><summary>確認結果'), label);
  assert.match(document, /<summary>差分の全体 \d+件<\/summary>/);
  assert.match(document, /<summary>改行コードだけの変更 \d+件<\/summary>/);
  assert(document.includes('data:image/png;base64,'), label);
  expectReason(Buffer.from(JSON.stringify({ ...caseDraft, nodes: [{ id: 'invented', title: '処理', caption: '処理します。', hunkIds: [] }] }), 'utf8'), /地図を出さない/);
}
const pythonAddition = decisionCases.find(([label]) => label === 'unparsed language')[2];
const mixedDecisionInput = appInput(fixture, addedFile('nested.js') + pythonAddition);
writeCase(mixedDecisionInput, JSON.stringify(emptyDraft));
assert.equal(prepare().status, 0);
const mixedDecision = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert.equal(mixedDecision.mapDecision.kind, 'map');
assert(mixedDecision.skipped.includes('change.py'));
const mixedDraft = { lead: '保存処理を追加しました。', mapCaption: '保存の流れと別の変更を確認します。',
  nodes: mixedDecision.map.nodes.map((node, i) => ({ id: node.id, title: `処理${i + 1}`, caption: '保存の流れを示します。',
    hunkIds: i === 0 ? mixedDecision.hunks.filter(h => h.file === 'nested.js').map(h => h.id) : [] })),
  edges: mixedDecision.map.edges.map(edge => edge.id),
  offMap: [{ title: '別の言語の変更', caption: '地図に載せない差分を示します。',
    hunkIds: mixedDecision.hunks.filter(h => h.file === 'change.py').map(h => h.id) }],
  interpretations: [], concerns: [], unverified: [] };
// The concern sits on the Python line, which no part draws: it stays listed, and the legend shows no concern badge.
mixedDraft.concerns = [{ text: '別の言語の保存は未確認です。', file: 'change.py', line: 1 }];
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(mixedDraft), 'utf8');
assert.equal(render().body.ok, true);
const mixedHtml = readFileSync(htmlPath, 'utf8');
assert(mixedHtml.includes('別の言語の変更') && mixedHtml.includes('別の言語の保存は未確認です。'));
assert(!mixedHtml.includes('class="ex-marker ex-marker-concern"') && !mixedHtml.includes('懸念1：見てほしい点の札'),
  'The legend lists only badges that the map draws.');

for (const [status, fact, summary] of [['failed', '作業を完了できませんでした。', 'テストが失敗しました。'],
  ['cancelled', '作業は取り消されました。', '利用者が取り消しました。']]) {
  const stopped = appInput(fixture, decisionCases[0][2]);
  stopped.images = [{ path: 'sample.png', label: '変更後の画面' }];
  stopped.task = { ...stopped.task, status, completionSummary: '作業回数を表示しました。', failureSummary: summary };
  writeCase(stopped, JSON.stringify(emptyDraft));
  assert.equal(prepare().status, 0);
  const stoppedPrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
  writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify({ ...emptyDraft,
    offMap: stoppedPrepared.hunks.map(h => ({ title: '表示の変更', caption: '実際の差分を確認します。', hunkIds: [h.id] })) }), 'utf8');
  assert.equal(render().body.ok, true, status);
  const stoppedHtml = readFileSync(htmlPath, 'utf8');
  assert(stoppedHtml.includes(fact) && stoppedHtml.includes(summary), `A ${status} task is stated in a document without a map.`);
  assert(!stoppedHtml.includes('作業回数を表示しました。'), `A ${status} task does not read as completed.`);
}

const miscounted = appInput(fixture, 'diff --git a/a.css b/a.css\n--- a/a.css\n+++ b/a.css\n@@ -1,3 +1,3 @@\n-old\n+new\n'
  + 'diff --git a/b.css b/b.css\n--- a/b.css\n+++ b/b.css\n@@ -1 +1 @@\n-x\n+y\n');
writeCase(miscounted, JSON.stringify(emptyDraft));
assert.equal(prepare().status, 0);
const miscountedHunks = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8')).hunks;
assert.deepEqual(miscountedHunks.map(h => [h.file, h.lines.map(l => `${l.kind}:${l.text}`)]),
  [['a.css', ['delete:old', 'add:new']], ['b.css', ['delete:x', 'add:y']]], 'A miscounted hunk must not absorb the next file header.');

const contextInput = appInput(fixture, 'diff --git a/theme.css b/theme.css\n--- a/theme.css\n+++ b/theme.css\n@@ -1,3 +1,3 @@\n unchanged before\n-old\n+new\n unchanged after\n');
contextInput.images = [{ path: 'sample.png', label: '変更後の画面' }];
writeCase(contextInput, JSON.stringify(emptyDraft));
assert.equal(prepare().status, 0);
const contextPrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert.equal(contextPrepared.mapDecision.kind, 'visual');
contextPrepared.hunks[0].lines.unshift({ kind: 'context', line: 1, text: 'unchanged before' });
contextPrepared.hunks[0].lines.push({ kind: 'context', line: 3, text: 'unchanged after' });
writeFileSync(resolve(runFolder, 'prepared.json'), JSON.stringify(contextPrepared), 'utf8');
const contextDraft = { lead: '表示の差分を確認しました。', mapCaption: '前後の行と変更行を確認します。',
  nodes: [], edges: [], offMap: [{ title: '表示の変更', caption: '実際の差分を確認します。', hunkIds: [contextPrepared.hunks[0].id] }],
  interpretations: [], concerns: [], unverified: [] };
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(contextDraft), 'utf8');
assert.equal(render().body.ok, true);
const contextHtml = readFileSync(htmlPath, 'utf8');
assert.equal((contextHtml.match(/data-diff-kind="context"/g) ?? []).length, 4);
assert(!contextHtml.includes('- unchanged before') && !contextHtml.includes('- unchanged after'));
assert.equal((contextHtml.match(/<span class="ex-n">1<\/span>  unchanged before/g) ?? []).length, 2);
assert.equal((contextHtml.match(/<span class="ex-n">3<\/span>  unchanged after/g) ?? []).length, 2);

const styleText = readFileSync(resolve(skill, 'assets/style.css'), 'utf8');
const darkColors = styleText.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/)?.[1] ?? '';
const color = name => new RegExp(`--ex-${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(darkColors)?.[1];
const luminance = hex => {
  const values = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = values.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
};
for (const name of ['decision', 'concern']) {
  const foreground = color(name);
  assert(foreground, `Missing dark color for ${name}`);
  assert((luminance(foreground) + .05) / (luminance('#242722') + .05) >= 4.5, name);
  assert(styleText.includes(`var(--ex-${name})`), name);
}
const captureCase = appInput(fixture, decisionCases[0][2]);
captureCase.changeCaptureError = '記録を読み取れませんでした。';
writeCase(captureCase, JSON.stringify(emptyDraft));
assert.equal(prepare().status, 0);
const captured = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert.equal(captured.mapDecision.kind, 'none');
assert.match(captured.mapDecision.reason, /記録に失敗/);

console.log('Results skill: fixture, candidates, assignments, invalid drafts, encoding, and no-change states passed.');
