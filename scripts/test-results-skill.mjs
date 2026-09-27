import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { route } from '../agent-window/skills/poiesis-results/scripts/layout.mjs';
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
assert.equal((html.match(/<script\b/g) ?? []).length, 1);
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
assert(plainHtml.includes('矢印の数字は呼び出している行です。') && !plainHtml.includes('箱の説明に畳んだ'));
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
  offMap: [{ title: '文書の削除', caption: '不要な説明を取り除きました。', hunkIds: [removed.hunks[0].id] }],
  interpretations: [], concerns: [], unverified: [] };
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(deletionDraft), 'utf8');
assert.equal(render().body.ok, true);
assert.match(readFileSync(htmlPath, 'utf8'), /文書の削除/);

const emptyDraft = { lead: '変更はありません。', nodes: [], edges: [], offMap: [], interpretations: [], concerns: [], unverified: [] };
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
// Anonymous callbacks belong to the code around them: saveEach calls save through forEach,
// and the page schedules expression through setTimeout.
assert(robust.map.edges.some(edge => edge.from === part('saveEach').id && edge.to === part('save').id && edge.line === 13));
assert(robust.map.edges.some(edge => robust.map.nodes.find(node => node.id === edge.from)?.symbol === 'page load'
  && edge.to === part('expression').id && edge.line === 14));
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
assert.equal(render().body.ok, true);
assert.match(readFileSync(htmlPath, 'utf8'), /改行コードだけが異なる行が 1 行/);
const removedStatement = appInput(fixture, "diff --git a/deletion-only.js b/deletion-only.js\n--- a/deletion-only.js\n+++ b/deletion-only.js\n@@ -1,4 +1,3 @@\n function remaining() {\n-  console.log('old');\n   return localStorage.getItem('count');\n }\n");
writeCase(removedStatement, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);
const removalPrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert.equal(removalPrepared.map.nodes.find(node => node.symbol === 'remaining')?.status, 'modified');
const started = Date.now();
const path = route({ x: 200, y: 50 }, { x: 300, y: 200 }, [{ x: 4, y: 80, w: 500, h: 90 }], [], 350, true);
assert(Date.now() - started < 2000);
assert(path?.some(point => point.x > 400), 'The path must use the corridor beyond its destination.');

console.log('Results skill: fixture, candidates, assignments, invalid drafts, encoding, and no-change states passed.');
