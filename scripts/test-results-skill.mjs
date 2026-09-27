import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { route } from '../agent-window/skills/poiesis-results/scripts/layout.mjs';
import { appInput, fixture, runFolder, skill, writeCase, prepare, render } from './fixtures/results-skill/helper.mjs';
import './fixtures/results-skill/generic-checks.mjs';
const htmlPath = resolve(runFolder, 'results.html');
const clearHtml = () => { if (existsSync(htmlPath)) unlinkSync(htmlPath); };
const expectReason = (draft, pattern) => {
  writeFileSync(resolve(runFolder, 'draft.json'), draft, 'utf8');
  clearHtml();
  const result = render();
  assert.equal(result.body.ok, false);
  assert.match(result.body.reasons.join(' '), pattern);
  assert.equal(existsSync(htmlPath), false);
};
const namesFor = prepared => ({
  count: '保存する入口', refresh: '表示を読む入口', flow: '処理の入口', key: '日付ごとの保存',
  stateTitle: '状態の変化', flowTitle: '入口と表示', dataTitle: '保存の形', raceTitle: '並行して保存する時',
  stateSentence: '変更した処理を通る線を見ます。', nonMain: '変更した処理を通らない',
  dataSentence: '保存先に値を書き、画面に値を表示する処理を見ます。',
  raceSentence: '2つの画面が同じ保存先に書く順番を見ます。',
  ...Object.fromEntries(['entries', 'conditions', 'origins', 'keyParts', 'states', 'stateValues', 'stateEvents'].map(field =>
    [field, Object.fromEntries((prepared.views?.naming?.[field] ?? []).map((item, i) =>
      [item[field === 'keyParts' || field === 'stateValues' ? 'id' : 'line'], `${{entries:'入口',conditions:'条件',origins:'日付の出どころ',keyParts:'キーの部分',states:'手元の値',stateValues:'状態',stateEvents:'切り替え'}[field]}${i + 1}`]))]))
});
const skillStyle = readFileSync(resolve(skill, 'assets/style.css'), 'utf8');
const skillText = readFileSync(resolve(skill, 'SKILL.md'), 'utf8').replace(/^\uFEFF/, '');
assert(skillText.indexOf('1. `node <skillフォルダー>/scripts/prepare.mjs`') < skillText.indexOf('## 判断基準'));
for (const phrase of ['## 判断基準', '現在の対象で実行成功', '失敗・未実施・実行不明', '変更前の対象で成功',
  '検証用ファイルが変わった', '人の判断が残る', '入力が矛盾・不足', '変更がない', '委任先の報告',
  '## 冒頭の答え', '終了コード0', '## 地図の根拠', '構文から分かる関係',
  '## 画像と確認の限界', '別の版', '## 平易な日本語', '## 危険な兆候と避けること',
  '## 書き終える前の確認', '## 根拠', 'harness-results/SKILL.md',
  'research-r6-results-visual-first.md', 'research-r8-results-for-engineers.md',
  'research-r9-results-app-skill-boundary.md',
  '`lead`', '`mapCaption`', '`nodes[].title/caption`', '`offMap`', '`interpretations`',
  '`concerns`', '`unverified`', '`viewNames`', '`interpretations[].tests`', 'views.naming', 'views.structure'])
  assert(skillText.includes(phrase), `SKILL.md に ${phrase} がありません。`);
assert(!/(?:<svg|<script|class="ex-)/i.test(skillText), '図の HTML 実装を SKILL.md に移してはいけません。');
const contractInput = appInput();
writeCase(contractInput);
assert.equal(prepare().body.ok, true);
const contractPrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert.equal(contractPrepared.hunks.length, 10);
assert(contractPrepared.skipped.includes('README.md'));
const contractDraft = JSON.parse(readFileSync(resolve(fixture, 'draft.json'), 'utf8'));
contractDraft.edges = [];
contractDraft.viewNames = namesFor(contractPrepared);
contractDraft.interpretations.forEach(row => { delete row.evidence; row.tests = []; });
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(contractDraft), 'utf8');
const contractMade = render();
assert.equal(contractMade.body.ok, true, JSON.stringify(contractMade.body.reasons));
assert.equal(contractMade.body.unassignedHunks, 0);
const contractHtml = readFileSync(htmlPath, 'utf8');
for (const phrase of [contractDraft.lead, contractDraft.mapCaption,
  ...contractDraft.nodes.filter(node => contractHtml.includes(`data-part="${node.id}"`)).map(node => node.title),
  ...contractDraft.offMap.flatMap(item => [item.title, item.caption]),
  ...contractDraft.interpretations.map(item => item.decision), contractInput.task.request])
  assert(contractHtml.includes(phrase), `Missing draft text: ${phrase}`);
assert(contractHtml.includes(readFileSync(resolve(skill, 'assets/document.js'), 'utf8')));
assert(!/<\w+[^>]*\son[a-z]+\s*=/i.test(contractHtml));
assert(!/(?:src|href)="https?:/i.test(contractHtml));
assert(!/<img[^>]+src="(?!data:)/i.test(contractHtml));
const invalidNode = structuredClone(contractDraft);
invalidNode.nodes[0].id = 'not-a-candidate';
expectReason(Buffer.from(JSON.stringify(invalidNode), 'utf8'), /候補にない部品/);
const invalidHunk = structuredClone(contractDraft);
invalidHunk.offMap[0].hunkIds = [];
expectReason(Buffer.from(JSON.stringify(invalidHunk), 'utf8'), /割り当てのない差分/);
expectReason(Buffer.from(JSON.stringify(contractDraft), 'utf16le'), /UTF-16/);
expectReason(Buffer.from([0xff, 0xfe, 0x7b, 0x00]), /UTF-16/);
writeFileSync(resolve(runFolder, 'draft.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from(JSON.stringify(contractDraft), 'utf8')]));
assert.equal(render().body.ok, true);
contractInput.images = [{ path: 'sample.png', label: '変更後の画面' }];
writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(contractInput), 'utf8');
assert.equal(render().body.ok, true);
assert.match(readFileSync(htmlPath, 'utf8'), /src="data:image\/png;base64,/);
contractInput.images = [{ path: '../outside.png', label: '外の画像' }];
writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(contractInput), 'utf8');
assert.equal(render().body.ok, true);
assert(!readFileSync(htmlPath, 'utf8').includes('data-poiesis-image="../outside.png"'));
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
assert.equal(nestedMade.body.geometry.boxes.reduce((total, box) => total + box.badgeCount, 0), 1);
assert(nestedMade.body.geometry.boxes.find(box => box.badgeCount === 1).h >
  Math.max(...nestedMade.body.geometry.boxes.filter(box => box.badgeCount === 0).map(box => box.h)));
assert.equal((nestedHtml.match(/class="ex-marker ex-marker-concern"/g) ?? []).length, 1);
const affectedPart = nestedPrepared.map.nodes.find(node => node.kind === 'storage');
assert(nestedHtml.match(new RegExp(`<g data-map-node="${affectedPart.id}">([\\s\\S]*?)<\\/g>`))?.[1].includes('懸念1'));
// The legacy map remains a production path when M alone is selected.
const legacyInput = appInput(fixture, addedFile('legacy-map.js'));
writeCase(legacyInput, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);
const legacyPrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert.equal(legacyPrepared.mapDecision.kind, 'map');
assert.deepEqual(legacyPrepared.views.selected, { S: false, D: false, T: false, C: false, M: true });
const legacyScreen = legacyPrepared.map.nodes.find(node => node.kind === 'screen');
assert(legacyScreen, 'M だけの地図に画面の部品が必要です。');
const legacyDraft = { lead: '画面の値を更新しました。', mapCaption: '値を作る処理から画面までの線を見ます。',
  nodes: legacyPrepared.map.nodes.map((node, i) => ({ id: node.id, title: `部品${i + 1}`,
    caption: '画面へ値を渡す処理です。', hunkIds: i === 0 ? legacyPrepared.hunks.map(h => h.id) : [] })),
  edges: legacyPrepared.map.edges.map(edge => edge.id), offMap: [], interpretations: [], concerns: [], unverified: [] };
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(legacyDraft), 'utf8');
const legacyPlain = render();
assert.equal(legacyPlain.body.ok, true, JSON.stringify(legacyPlain.body.reasons));
const legacyScreenHeight = output => output.body.geometry.boxes.find(box => box.id === legacyScreen.id).h;
assert(!readFileSync(htmlPath, 'utf8').includes('class="ex-mapshot"'), '画像のない画面の箱に空枠を出さない。');
const largePath = resolve(fixture, 'large-image.png');
try {
  writeFileSync(largePath, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(2 * 1024 * 1024)]));
  legacyInput.images = [{ path: 'large-image.png', label: '大きな画像' }];
  writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(legacyInput), 'utf8');
  assert.equal(render().body.ok, true);
  assert.match(readFileSync(htmlPath, 'utf8'), /画像が大きすぎるため省略しました。/);
} finally { if (existsSync(largePath)) unlinkSync(largePath); }
legacyInput.images = [];
legacyInput.requirement = { title: '表示の変更', tasks: [{ title: '値の表示', completionSummary: '画面に値を出しました。' }] };
writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(legacyInput), 'utf8');
assert.equal(render().body.ok, true);
assert.match(readFileSync(htmlPath, 'utf8'), /関連する作業/);
legacyInput.requirement = null;
legacyInput.images = [{ path: 'sample.png', label: '変更後の画面' }];
writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(legacyInput), 'utf8');
const legacyWithShot = { ...structuredClone(legacyDraft), screenImage: 'sample.png' };
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(legacyWithShot), 'utf8');
const legacyShot = render();
assert.equal(legacyShot.body.ok, true, JSON.stringify(legacyShot.body.reasons));
assert.equal(legacyScreenHeight(legacyShot), legacyScreenHeight(legacyPlain) + 90);
assert.match(readFileSync(htmlPath, 'utf8'), /<img class="ex-mapshot" src="data:image\/png;base64,/);
expectReason(Buffer.from(JSON.stringify({ ...legacyWithShot, screenImage: 'missing.png' }), 'utf8'), /screenImage/);
legacyInput.images = [];
writeFileSync(resolve(runFolder, 'input.json'), JSON.stringify(legacyInput), 'utf8');
expectReason(Buffer.from(JSON.stringify(legacyWithShot), 'utf8'), /screenImage/);
const legacyChosen = { ...structuredClone(legacyDraft), images: [{ path: 'sample.png', caption: '変更後の画面を撮影しました。' }], screenImage: 'sample.png' };
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(legacyChosen), 'utf8');
assert.equal(render().body.ok, true);
const legacyChosenHtml = readFileSync(htmlPath, 'utf8');
assert.match(legacyChosenHtml, /<figcaption>変更後の画面を撮影しました。<\/figcaption>/);
assert.match(legacyChosenHtml, /<img class="ex-mapshot" src="data:image\/png;base64,/);
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox', '--disable-gpu'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1688, height: 960 });
  await page.setContent(legacyChosenHtml);
  const mapFont = () => page.evaluate(() => {
    const svg = document.querySelector('.ex-map');
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    return { scale, min: Math.min(...[...svg.querySelectorAll('text')].map(item =>
      Number.parseFloat(getComputedStyle(item).fontSize) * scale)) };
  });
  assert((await mapFont()).min >= 12, JSON.stringify(await mapFont()));
  await page.click('.ex-hit > summary');
  assert((await mapFont()).min >= 12, JSON.stringify(await mapFont()));
} finally { await browser.close(); }
expectReason(Buffer.from(JSON.stringify({ ...legacyChosen, images: [{ path: 'missing.png', caption: '画像がありません。' }], screenImage: undefined }), 'utf8'), /載せられません/);
expectReason(Buffer.from(JSON.stringify({ ...legacyChosen, images: [{ path: '..\/outside.png', caption: '外の画像です。' }], screenImage: undefined }), 'utf8'), /載せられません/);
expectReason(Buffer.from(JSON.stringify({ ...legacyChosen, images: [{ path: 'README.md', caption: '文書です。' }], screenImage: undefined }), 'utf8'), /載せられません/);
expectReason(Buffer.from(JSON.stringify({ ...legacyDraft, concerns: [{ text: '範囲外です。', file: 'legacy-map.js', line: 50 }] }), 'utf8'), /範囲外/);
expectReason(Buffer.from(JSON.stringify({ ...legacyDraft, lead: '文字�けです。' }), 'utf8'), /壊れた文字/);
const keyPartInput = appInput(fixture, addedFile('shared-key-part.js'));
writeCase(keyPartInput, JSON.stringify(emptyDraft));
assert.equal(prepare().body.ok, true);
const keyPartPrepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
assert(keyPartPrepared.views.steps.some(step => step.kind === 'keyPart'));
assert(!keyPartPrepared.views.steps.some(step => step.kind === 'date'));
assert.equal(keyPartPrepared.views.boundary, null);
assert.equal(keyPartPrepared.views.selected.C, true);
const keyPartDraft = { ...structuredClone(emptyDraft), viewNames: namesFor(keyPartPrepared),
  nodes: keyPartPrepared.map.nodes.map((node, i) => ({ id: node.id, title: `部品${i + 1}`,
    caption: '値を受け渡す処理です。', hunkIds: i === 0 ? keyPartPrepared.hunks.map(h => h.id) : [] })) };
writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(keyPartDraft), 'utf8');
const keyPartMade = render();
assert.equal(keyPartMade.body.ok, true, JSON.stringify(keyPartMade.body.reasons));
const keyPartHtml = readFileSync(htmlPath, 'utf8');
assert.match(keyPartHtml, /キーの部分を決める/);
assert(!keyPartHtml.includes('日付を決める'));
assert.match(keyPartHtml, /2つのタブが保存する順番を示します。/);
assert(!keyPartHtml.includes('日付の境目をまたぐ処理を示します。'));
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
  interpretations: [{ decision: '余白を優先しました。', tests: [] }],
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
noMap.images = [];
noMapDraft.images = [
  { path: 'target/s6-before-card.png', caption: '変更前の画面を撮影しました。', role: 'before', screen: '画面' },
  { path: 'target/s6-after-card.png', caption: '変更後の画面を撮影しました。', role: 'after', screen: '画面' }
];
writeCase(noMap, JSON.stringify(noMapDraft));
assert.equal(prepare().body.ok, true);
assert.equal(render().body.ok, true);
assert.match(readFileSync(htmlPath, 'utf8'), /class="ex-screen-pair"[^>]*>[\s\S]*s6-before-card\.png[\s\S]*s6-after-card\.png/);
assert.equal((readFileSync(htmlPath, 'utf8').match(/data-poiesis-image="target\/s6-before-card\.png"/g) ?? []).length, 1);
noMapDraft.images.shift();
writeCase(noMap, JSON.stringify(noMapDraft));
assert.equal(prepare().body.ok, true);
assert.equal(render().body.ok, true);
assert.match(readFileSync(htmlPath, 'utf8'), /変更前の画面の画像がありません。/);
noMapDraft.images[0].role = 'later';
writeCase(noMap, JSON.stringify(noMapDraft));
assert.equal(prepare().body.ok, true);
assert.equal(render().body.ok, false);
noMapDraft.images[0].role = 'after';
delete noMapDraft.images[0].screen;
writeCase(noMap, JSON.stringify(noMapDraft));
assert.equal(prepare().body.ok, true);
assert.equal(render().body.ok, false);
noMapDraft.images[0].screen = '画面';
noMapDraft.images.push({ path: 'target/s6-before-card.png', caption: '別の変更後の画面です。', role: 'after', screen: '画面' });
writeCase(noMap, JSON.stringify(noMapDraft));
assert.equal(prepare().body.ok, true);
assert.equal(render().body.ok, false);
noMapDraft.images.pop();
noMapDraft.images[0].role = 'before';
writeCase(noMap, JSON.stringify(noMapDraft));
assert.equal(prepare().body.ok, true);
assert.equal(render().body.ok, true);
assert.match(readFileSync(htmlPath, 'utf8'), /変更後の画面の画像がありません。/);
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
assert(mixed.skipped.includes('mixed.html'), 'J17: a file with an unreadable script is reported even when other scripts parse');
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
    interpretations: [{ decision: '表示を優先しました。', tests: [] }],
    concerns: addedLine ? [{ text: '狭い幅の表示は未確認です。', ...addedLine }] : [],
    unverified: ['狭い幅の画面表示を確認していません。'] };
  writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(caseDraft), 'utf8');
  const caseResult = render();
  assert.equal(caseResult.body.ok, true, `${label}: ${JSON.stringify(caseResult.body.reasons)}`);
  const document = readFileSync(htmlPath, 'utf8');
  for (const phrase of [caseDraft.lead, caseDraft.mapCaption, caseDraft.interpretations[0].decision,
    '対応するテストは未確認', ...caseDraft.unverified, ...caseDraft.concerns.map(c => c.text),
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

for (const name of ['v1-lock', 'v2-recomputed-key', 'v3-inline-literal', 'v5-constant-write', 'v6-stale-module-var']) {
  const workspace = resolve(fixture, 'r10-d', name);
  const diff = readFileSync(resolve(workspace, 'diff.txt'), 'utf8');
  writeCase(appInput(workspace, diff), JSON.stringify(emptyDraft));
  const preparedResult = prepare();
  assert.equal(preparedResult.status, 0, name);
  assert.equal(preparedResult.body.ok, true, name);
  const variant = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
  assert.equal(variant.views.selected.C, !['v1-lock', 'v5-constant-write'].includes(name), name);
  if (name === 'v3-inline-literal') assert(variant.views.keys.length >= 2, 'Both changed storage keys must be listed.');
  const variantDraft = { lead: '変更した処理を確認しました。', mapCaption: '変更箇所のコードを確認します。', viewNames: namesFor(variant),
    nodes: variant.mapDecision.kind === 'map' ? [...new Set([...(variant.views.structure?.countNodeIds ?? []),
      ...(variant.views.structure?.refreshNodeIds ?? []),
      (variant.map.nodes.find(node => node.kind === 'function' && !node.helper) ?? variant.map.nodes.find(node => !node.helper))?.id])]
      .map(id => variant.map.nodes.find(node => node.id === id)).filter(Boolean).map((node, i) =>
        ({ id: node.id, title: `変更した処理${i + 1}`, caption: '変更した処理の入口を示します。', hunkIds: [] })) : [],
    edges: [], offMap: variant.hunks.length ? [{ title: '変更の詳細', caption: '実際の差分を確認します。',
      hunkIds: variant.hunks.map(hunk => hunk.id) }] : [],
    interpretations: [], concerns: [], unverified: [] };
  writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(variantDraft), 'utf8');
  const made = render();
  assert.equal(made.status, 0, name);
  assert.equal(made.body.ok, true, `${name}: ${JSON.stringify(made.body.reasons)}`);
  assert.equal(made.body.unassignedHunks, 0, name);
  if (variant.views.selected.D && variant.views.selected.T && variant.mapDecision.kind === 'map')
    assert(readFileSync(resolve(runFolder, 'results.html'), 'utf8').includes('data-view="structure"'), name);
}
for (const [name, expected] of [['one-storage.js', { S: false, D: true, T: false, C: false, M: false }],
  ['single-flow.js', { S: false, D: false, T: true, C: false, M: false }]]) {
  writeCase(appInput(fixture, addedFile(name)), JSON.stringify(emptyDraft));
  assert.equal(prepare().body.ok, true, name);
  const prepared = JSON.parse(readFileSync(resolve(runFolder, 'prepared.json'), 'utf8'));
  assert.deepEqual(prepared.views.selected, expected, name);
  assert.equal(prepared.mapDecision.kind, 'map', name);
  const node = prepared.map.nodes.find(item => item.kind === 'function' && !item.helper);
  assert(node, name);
  const onlyDraft = { lead: '変更した処理を確認しました。', mapCaption: '変更箇所のコードを確認します。', viewNames: namesFor(prepared),
    nodes: [...new Set([node.id, ...(prepared.views.structure?.countNodeIds ?? []),
      ...(prepared.views.structure?.refreshNodeIds ?? [])])].map((id, i) =>
      ({ id, title: `変更した処理${i + 1}`, caption: '変更した処理の入口を示します。', hunkIds: [] })),
    edges: [], offMap: [{ title: '変更の詳細', caption: '実際の差分を確認します。',
      hunkIds: prepared.hunks.map(hunk => hunk.id) }],
    interpretations: expected.D ? [{ decision: '保存先の名前を選びました。', tests: [] }] : [], concerns: [], unverified: [] };
  writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify(onlyDraft), 'utf8');
  const made = render();
  assert.equal(made.body.ok, true, `${name}: ${JSON.stringify(made.body.reasons)}`);
  const html = readFileSync(resolve(runFolder, 'results.html'), 'utf8');
  assert.equal(/<section class="ex-view[^"]*" data-view="data"/.test(html), expected.D, name);
  assert.equal(/<section class="ex-view[^"]*" data-view="structure"/.test(html), expected.T, name);
  assert(!/<section class="ex-view[^"]*" data-view="race"/.test(html), name);
  if (expected.D) assert.match(html, /対応するテストは未確認/, 'A judgment without source or verification stays unverified.');
  for (const sentence of [...html.matchAll(/<section class="ex-view[^>]*>[\s\S]*?<\/section>/g)]
    .flatMap(section => [...section[0].matchAll(/<(?:h2|p)[^>]*>([^<]+)<\/(?:h2|p)>/g)].map(match => match[1])))
    assert(!/(?:か。|ですか|ますか|[?？])$/.test(sentence), `${name}: ${sentence}`);
  if (expected.D) {
    writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify({ ...onlyDraft,
      interpretations: [{ decision: '保存先の名前を選びました。', evidence: 'AI が確かめました。' }] }), 'utf8');
    assert.equal(render().body.ok, false, 'Derived evidence must come from prepared facts and input records.');
    writeFileSync(resolve(runFolder, 'draft.json'), JSON.stringify({ ...onlyDraft,
      mapCaption: '保存先はどこですか。' }), 'utf8');
    assert.equal(render().body.ok, false, 'Diagram text must be declarative.');
  }
}

console.log('Results skill: fixture, derived variants, candidates, assignments, invalid drafts, encoding, and no-change states passed.');
await import('./fixtures/results-skill/review-regressions.mjs');
