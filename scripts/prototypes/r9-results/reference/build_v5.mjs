// Build the S6 target Results v4: machine-derived change map + real diff hunks + real screenshots.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const WS = 'C:/Users/owner/github/poiesis/.harness/tmp/example-s6/workspace';
const S = 'C:/Users/owner/AppData/Local/Temp/claude/C--Users-owner-github-poiesis/eea67a51-3900-42d3-9b3a-e0fabedc4141/scratchpad';
const OUT = `${WS}/.poiesis-example/ideal-v4.html`;
const map = JSON.parse(fs.readFileSync(`${S}/map.json`, 'utf8'));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fail = m => { console.error('STOP: ' + m); process.exit(1); };

// ---------- 1. Map structure: every drawn/folded/excluded edge must be a machine edge ----------
const edgeKey = e => `${e.from}|${e.to}|${e.line}`;
const machine = new Set(map.allEdges.map(edgeKey));
const E = (from, to, line) => { const k = `${from}|${to}|${line}`; if (!machine.has(k)) fail(`not a machine edge: ${k}`); return k; };

const nodes = {
  // id: [x, y, w, h, status, title, sub lines, citation]
  E1: [10, 16, 195, 62, 'same', '作業の時間切れ', ['tick() 639-648行'], 'index.html:639-648'],
  E2: [10, 150, 195, 62, 'new', 'ページを開いたとき', ['728行'], 'index.html:728'],
  E3: [10, 232, 195, 62, 'chg', 'タブに戻ったとき', ['visibilitychange 719-724行'], 'index.html:719-724'],
  E4: [10, 314, 195, 62, 'new', '別のタブが保存したとき', ['storage 726行'], 'index.html:726'],
  E5: [10, 396, 195, 62, 'new', '1秒ごと', ['setInterval 727行'], 'index.html:727'],
  F1: [275, 16, 250, 62, 'chg', '作業を終える処理', ['finish() 609-637行'], 'index.html:609-637'],
  F2: [275, 132, 250, 78, 'new', '回数を1足して保存', ['recordCompletedWork() 473-484行', '日付は getLocalDay(deadline) 475行'], 'index.html:473-484'],
  F3: [275, 300, 250, 78, 'new', '画面の数字を読み直す', ['renderDailyCount() 468-471行', '今日の日付 getLocalDay() 469行'], 'index.html:468-471'],
  F4: [578, 214, 190, 78, 'new', '日付ごとの回数を読む', ['getDailyCount() 455-466行', '覚えた数と保存の大きいほう'], 'index.html:455-466'],
  S1: [805, 62, 185, 108, 'new', 'ブラウザの保存', ['localStorage のキー', 'pomodoro-completed-work:', '+ 日付(442行)'], 'index.html:442'],
  S2: [805, 300, 185, 150, 'new', '画面の欄', ['#daily-count 385行'], 'index.html:383-388']
};
// Drawn edges: [from, to, machine key, label, source anchor, target anchor]
const drawn = [
  ['E1', 'F1', E('fn:tick', 'fn:finish', 647), '647'],
  ['F1', 'F2', E('fn:finish', 'fn:recordCompletedWork', 613), '613', 'bottom', 'top'],
  ['F2', 'F3', E('fn:recordCompletedWork', 'fn:renderDailyCount', 483), '483', 'bottom', 'top'],
  ['F2', 'F4', E('fn:recordCompletedWork', 'fn:getDailyCount', 476), '476', 'right:-14', 'left:-18'],
  ['F2', 'S1', E('fn:recordCompletedWork', 'store:setItem DAILY_COUNT_PREFIX + day', 479), '書き込み 479', 'right:14', 'left:-16'],
  ['F3', 'F4', E('fn:renderDailyCount', 'fn:getDailyCount', 469), '469', 'right:-14', 'left:18'],
  ['F4', 'S1', E('fn:getDailyCount', 'store:getItem DAILY_COUNT_PREFIX + day', 458), '読み出し 458', 'right:-10', 'left:18'],
  ['F3', 'S2', E('fn:renderDailyCount', 'dom:#daily-count', 470), '表示 470', 'right:16', 'left:0'],
  ['E2', 'F3', E('entry:page load (top level)', 'fn:renderDailyCount', 728), '728', 'right:0', 'left:-24'],
  ['E3', 'F3', E('entry:event:document "visibilitychange"', 'fn:renderDailyCount', 722), '722', 'right:0', 'left:-8'],
  ['E4', 'F3', E('entry:event:window "storage"', 'fn:renderDailyCount', 726), '726', 'right:0', 'left:8'],
  ['E5', 'F3', E('entry:timer:setInterval 1000ms', 'fn:renderDailyCount', 727), '727', 'right:0', 'left:24']
];
// Folded into node text (kept visible as sub lines) and excluded (not on the shortest path to a changed part).
const folded = [
  [E('entry:timer:setInterval 250ms', 'fn:tick', 659), 'E1 は start() の 659行で 250ミリ秒ごとに tick を呼ぶ入口'],
  [E('entry:event:document "visibilitychange"', 'fn:tick', 721), 'E3 の中の既存の tick 呼び出し'],
  [E('fn:recordCompletedWork', 'fn:getLocalDay', 475), 'F2 の2行目'],
  [E('fn:renderDailyCount', 'fn:getLocalDay', 469), 'F3 の2行目']
];
const excluded = [
  [E('fn:pause', 'fn:tick', 663), '一時停止ボタンから tick への経路。finish までの最短の経路ではない'],
  [E('entry:event:toggleButton "click"', 'fn:pause', 672), '同上']
];
const accounted = new Set([...drawn.map(d => d[2]), ...folded.map(f => f[0]), ...excluded.map(x => x[0])]);
for (const e of map.mapEdges) if (!accounted.has(edgeKey(e))) fail(`machine map edge not shown or explained: ${edgeKey(e)}`);
const newFns = Object.entries(map.functions).filter(([, v]) => v.status === 'new').map(([k]) => k);
if (newFns.length !== 4) fail(`expected 4 new functions, got ${newFns}`);

// ---------- 2. SVG map ----------
const W = 1000, TOP = 18, H = 470 + 18;
const anchor = (id, spec) => {
  const [x, y0, w, h] = nodes[id]; const y = y0 + TOP;
  const [side, off] = (spec ?? 'mid').split(':'); const o = Number(off ?? 0);
  if (side === 'bottom') return [x + w / 2, y + h];
  if (side === 'top') return [x + w / 2, y];
  if (side === 'left') return [x, y + h / 2 + o];
  return [x + w, y + h / 2 + o];
};
const svg = [];
svg.push(`<svg class="ex-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="変更の全体の地図: 入口から処理、保存先と画面まで">`);
svg.push('<defs><marker id="ex-arrow-new" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ex-arrowhead-new" d="M0,0 L10,5 L0,10 z"/></marker>'
  + '<marker id="ex-arrow-same" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ex-arrowhead-same" d="M0,0 L10,5 L0,10 z"/></marker></defs>');
svg.push(`<text class="ex-col" x="107" y="14">入口</text><text class="ex-col" x="400" y="14">処理</text><text class="ex-col" x="673" y="${206 + TOP}">読み書き</text><text class="ex-col" x="897" y="${54 + TOP}">保存先</text><text class="ex-col" x="897" y="${292 + TOP}">画面</text>`);
const labels = [];
for (const [from, to, key, label, sa, ta] of drawn) {
  const [x1, y1] = anchor(from, sa ?? 'right'); const [x2, y2] = anchor(to, ta ?? 'left');
  const line = Number(key.split('|')[2]);
  const isNew = map.allEdges.find(e => edgeKey(e) === key).added;
  const cls = isNew ? 'new' : 'same';
  let d, lx, ly;
  if (sa === 'bottom') { d = `M${x1},${y1} L${x2},${y2 - 1}`; lx = x1 + 8; ly = (y1 + y2) / 2 + 4; }
  else {
    const dx = Math.max(30, (x2 - x1) / 2);
    d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2 - 1},${y2}`;
    lx = (x1 + x2) / 2; ly = (y1 + y2) / 2;
  }
  svg.push(`<path class="ex-edge ex-edge-${cls}" d="${d}" marker-end="url(#ex-arrow-${cls})"/>`);
  labels.push(`<g><text class="ex-edge-label" x="${lx}" y="${ly}" text-anchor="${sa === 'bottom' ? 'start' : 'middle'}" dy="0.35em">${esc(label)}</text></g>`);
}
const TAG = { new: '新規', chg: '変更', same: '既存' };
for (const [id, [x, y0, w, h, st, title, subs, cite]] of Object.entries(nodes)) {
  const y = y0 + TOP;
  const shape = id === 'S1'
    ? `<path class="ex-node ex-node-${st}" d="M${x},${y + 10} a${w / 2},10 0 0,1 ${w},0 v${h - 20} a${w / 2},10 0 0,1 ${-w},0 z M${x},${y + 10} a${w / 2},10 0 0,0 ${w},0"/>`
    : `<rect class="ex-node ex-node-${st}" x="${x}" y="${y}" width="${w}" height="${h}" rx="9"/>`;
  const ty = id === 'S1' ? y + 36 : y + 23;
  const subText = subs.map((s, i) => `<text class="ex-sub" x="${x + 12}" y="${ty + 20 + i * 17}">${esc(s)}</text>`).join('');
  svg.push(`<g>${shape}<text class="ex-title" x="${x + 12}" y="${ty}">${esc(title)}</text>`
    + `<text class="ex-tag ex-tag-${st}" x="${x + w - 10}" y="${ty}" text-anchor="end">${TAG[st]}</text>${subText}</g>`);
}
svg.push(...labels);
svg.push('</svg>');
// Real screenshot placed inside the S2 node (percent positions follow the uniformly scaled viewBox).
const [sx, sy, sw] = nodes.S2; const img = { x: sx + 10, y: sy + TOP + 52, w: sw - 20 };

// ---------- 3. Source + diff (never retyped): render any new-file range with added/deleted marks ----------
const OUT5 = `${WS}/.poiesis-example/ideal-v5.html`;
const srcLines = { 'index.html': fs.readFileSync(`${WS}/index.html`, 'utf8').replace(/\r/g, '').split('\n'),
  'README.md': fs.readFileSync(`${WS}/README.md`, 'utf8').replace(/\r/g, '').split('\n') };
const diffText = execFileSync('git', ['-C', WS, 'diff', '-U0', '--', 'index.html', 'README.md'], { encoding: 'utf8' }).replace(/\r/g, '');
const addedBy = { 'index.html': new Set(), 'README.md': new Set() }, deletedBefore = { 'index.html': new Map(), 'README.md': new Map() };
{
  let file = null, oldNo = 0, newNo = 0;
  for (const raw of diffText.split('\n')) {
    let m;
    if ((m = raw.match(/^\+\+\+ b\/(.+)$/))) { file = m[1]; continue; }
    if (raw.startsWith('--- ') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    if ((m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/))) { oldNo = +m[1]; newNo = +m[3]; if (m[4] === '0') newNo += 1; continue; }
    if (!file) continue;
    if (raw[0] === '+') addedBy[file].add(newNo++);
    else if (raw[0] === '-') { const list = deletedBefore[file].get(newNo) ?? []; list.push(raw.slice(1)); deletedBefore[file].set(newNo, list); oldNo++; }
  }
}
const shown = { 'index.html': new Set(), 'README.md': new Set() };
function codeHtml(ranges) {
  return ranges.map(([f, a, b]) => {
    const rows = [];
    for (let n = a; n <= b; n++) {
      for (const del of deletedBefore[f].get(n) ?? []) { rows.push(`<span class="ex-l ex-del"><span class="ex-n"></span>- ${esc(del)}</span>`); shown[f].add(`d${n}`); }
      const add = addedBy[f].has(n); if (add) shown[f].add(n);
      rows.push(`<span class="ex-l ${add ? 'ex-add' : ''}"><span class="ex-n">${n}</span>${add ? '+' : ' '} ${esc(srcLines[f][n - 1])}</span>`);
    }
    return `<div class="ex-diff-head">${esc(f)} ${a === b ? a : `${a}-${b}`}行</div><pre class="ex-diff">${rows.join('')}</pre>`;
  }).join('');
}

// ---------- 4. Tests (run now; never copy the agent's claim) ----------
let testOut = '', testExit = 0;
try { testOut = execFileSync(process.execPath, ['--test', 'tests/daily-count.test.cjs'], { cwd: WS, encoding: 'utf8' }); }
catch (e) { testOut = e.stdout ?? ''; testExit = e.status ?? 1; }
const pass = Number(testOut.match(/^ℹ pass (\d+)/m)?.[1] ?? -1), total = Number(testOut.match(/^ℹ tests (\d+)/m)?.[1] ?? -1);
if (total !== 8 || [...testOut.matchAll(/^✔ /gm)].length !== 8) fail(`expected 8 passing tests, got ${pass}/${total}`);
const T = [null,
  '作業を終えたときだけ増え、一時停止・リセット・切り替えでは増えない',
  '4回終えると長い休憩になり、その日の回数も残る',
  '再読み込みで今日の回数が戻り、次の日は0回から始まる',
  '午前0時をまたいだ作業は、終えた日の回数になる',
  '午前0時の後に遅れて確かめても、本来の終了時刻の日付で数える',
  '壊れた保存値は無視し、作業の完了は止まらない',
  '保存が使えないときは、ページの中で数え続ける',
  '別のタブで終えた回数が表示され、次の完了でも消えない'];
const testLines = srcLinesCount(`${WS}/tests/daily-count.test.cjs`);
function srcLinesCount(p) { const l = fs.readFileSync(p, 'utf8').split(/\r?\n/); return l[l.length - 1] === '' ? l.length - 1 : l.length; }

// ---------- 5. Panels: one per map part, plus the parts the map does not show ----------
const panels = {
  E1: { why: '250ミリ秒ごとに残り時間を確かめ、0になると作業を終える処理を呼びます。今回は変更していません。', code: [['index.html', 639, 648], ['index.html', 657, 660]], tests: [] },
  E2: { why: 'ページを読み込んだ最後に、1回だけ数字を読みます。', code: [['index.html', 725, 729]], tests: [3] },
  E3: { why: 'タブが見える状態に戻ったとき、実行中なら時間を進め、実行中でなくても数字を読み直します。既存の1行を、この形に書き換えています。', code: [['index.html', 719, 724]], tests: [] },
  E4: { why: '別のタブで保存が変わると届く通知で、数字を読み直します。', code: [['index.html', 726, 726]], tests: [8] },
  E5: { why: '1秒ごとに数字を読み直します。日付が変わったときの0回への切り替えは、この読み直しで表示されます。', code: [['index.html', 727, 727]], tests: [3] },
  F1: { why: '作業の時間が終わったとき、休憩へ切り替える前に回数を1足します。休憩の終わりでは足しません。', code: [['index.html', 609, 620]], tests: [1, 2] },
  F2: { why: '時間切れの時刻(deadline)の日付に1を足して保存します。保存に失敗しても、ページの中の数は増えます。', code: [['index.html', 473, 484]], tests: [1, 2, 4, 5, 7] },
  F3: { why: '今日の日付の回数を読み、表示と違うときだけ書き換えます。日付は端末の時計の現地の日付です。', code: [['index.html', 425, 425], ['index.html', 450, 453], ['index.html', 468, 471]], tests: [3, 8] },
  F4: { why: 'ページの中で覚えている数と保存された数のうち、大きいほうを使います。壊れた保存値は無視します。', code: [['index.html', 441, 442], ['index.html', 455, 466]], tests: [3, 6, 8] },
  S1: { why: 'キーは「pomodoro-completed-work:」に日付(例 2026-09-26)を付けたもので、1日に1件ずつ増えます。古い日付のキーは消しません。', code: [['index.html', 442, 442], ['index.html', 458, 458], ['index.html', 479, 479]], tests: [3] },
  S2: { why: 'スタートボタンの下に欄を1つ足しました。数字が変わると、画面の読み上げにも伝わる設定(aria-live)です。', code: [['index.html', 383, 388]], tests: [], img: true },
  CSS: { title: '回数の欄の見た目', st: 'new', cite: 'index.html:262-296', why: '欄の余白・背景・文字の大きさを指定しています。', code: [['index.html', 262, 296]], tests: [] },
  README: { title: 'README の要件', st: 'new', cite: 'README.md:13-14', why: 'エージェントが足した解釈を、要件として2行書き足しています。', code: [['README.md', 13, 14]], tests: [] },
  TESTS: { title: '自動テストのファイル', st: 'new', cite: `tests/daily-count.test.cjs:1-${testLines}`, why: `新しいファイル(${testLines}行)です。いまの内容で ${pass}/${total}件 成功しました(終了コード ${testExit})。`, code: [], tests: [1, 2, 3, 4, 5, 6, 7, 8] }
};
const TAGS = { new: '新規', chg: '変更', same: '既存' };
function panelHtml(id) {
  const p = panels[id]; const n = nodes[id];
  const title = p.title ?? n[5], st = p.st ?? n[4], cite = p.cite ?? n[7];
  const tests = p.tests.length ? `<div class="ex-p-tests"><div class="ex-p-h">確かめている自動テスト</div><ul>${p.tests.map(t => `<li>${t}. ${esc(T[t])}</li>`).join('')}</ul></div>` : '';
  const img = p.img ? `<img class="ex-p-img" src=".poiesis-example/shots/map-daily-count.png" alt="実際の画面の回数の欄。今日の作業回数 1回">` : '';
  return `<div class="ex-panel" role="region" aria-label="${esc(title)}の中身"><div class="ex-p-top"><span class="ex-p-title">${esc(title)}</span><span class="ex-p-tag ex-p-tag-${st}">${TAGS[st]}</span></div>`
    + `<p class="ex-p-why">${esc(p.why)}</p>${img}${codeHtml(p.code)}${tests}`
    + `<p class="ex-p-foot"><a class="ex-p-open" href="#" data-poiesis-citation="${cite}">Code で開く</a><span>閉じるときは、同じ部品をもう一度押します。</span></p></div>`;
}
// Every changed line must be reachable from some panel.
for (const id of Object.keys(panels)) panelHtml(id);
const missing = [];
for (const f of ['index.html', 'README.md']) {
  for (const n of addedBy[f]) if (!shown[f].has(n) && srcLines[f][n - 1].trim() !== '') missing.push(`${f}:${n}`);
  for (const n of deletedBefore[f].keys()) if (!shown[f].has(`d${n}`)) missing.push(`${f}:deleted-before-${n}`);
}
if (missing.length) fail(`changed lines not shown in any panel: ${missing.join(', ')}`);
const cssLines = [...addedBy['index.html']].filter(n => n >= 262 && n <= 296).length;
const readmeLines = addedBy['README.md'].size;

// Invisible hit areas over the map parts (percent boxes follow the uniformly scaled viewBox).
const hits = Object.entries(nodes).map(([id, [x, y0, w, h, , title]]) => {
  const y = y0 + TOP, pad = 3;
  const box = `left:${((x - pad) / W * 100).toFixed(2)}%;top:${((y - pad) / H * 100).toFixed(2)}%;width:${((w + 2 * pad) / W * 100).toFixed(2)}%;height:${((h + 2 * pad) / H * 100).toFixed(2)}%`;
  return `<details class="ex-hit" name="ex-panel" style="${box}"><summary aria-label="${esc(title)}の中身を右に表示"></summary>${panelHtml(id)}</details>`;
}).join('');
const inline = (id, label) => `<details class="ex-hit-inline" name="ex-panel"><summary>${esc(label)}</summary>${panelHtml(id)}</details>`;
const mapHtml5 = `<figure class="ex-mapfig"><div class="ex-mapbox">${svg.join('')}`
  + `<img class="ex-mapshot" src=".poiesis-example/shots/map-daily-count.png" alt="実際の画面の回数の欄。今日の作業回数 1回" `
  + `style="left:${(img.x / W * 100).toFixed(2)}%;top:${(img.y / H * 100).toFixed(2)}%;width:${(img.w / W * 100).toFixed(2)}%">${hits}</div>`;

// ---------- 6. Document ----------
const style = `
:root { --ex-new: var(--results-accent); --ex-chg: #a8581a; --ex-same: var(--results-muted); --ex-panel-w: min(46vw, 620px); }
:root[data-theme="dark"] { --ex-chg: #e3a15f; }
.ex-lead { font-size: 1.05em; }
.ex-mapfig { margin: 1em 0 1.4em; }
.ex-mapbox { position: relative; }
.ex-map { display: block; width: 100%; height: auto; font-family: inherit; }
.ex-map .ex-col { font-size: 12px; fill: var(--results-muted); text-anchor: middle; letter-spacing: 0.08em; }
.ex-map .ex-node { fill: var(--results-bg); stroke-width: 1.6; }
.ex-map .ex-node-new { stroke: var(--ex-new); fill: color-mix(in srgb, var(--ex-new) 9%, var(--results-bg)); }
.ex-map .ex-node-chg { stroke: var(--ex-chg); stroke-dasharray: 6 4; fill: color-mix(in srgb, var(--ex-chg) 9%, var(--results-bg)); }
.ex-map .ex-node-same { stroke: var(--ex-same); }
.ex-map .ex-title { font-size: 15px; font-weight: 700; fill: var(--results-fg); }
.ex-map .ex-sub { font-size: 12px; fill: var(--results-muted); font-family: Consolas, 'Cascadia Mono', 'BIZ UDGothic', monospace; }
.ex-map .ex-tag { font-size: 11.5px; font-weight: 700; }
.ex-map .ex-tag-new { fill: var(--ex-new); } .ex-map .ex-tag-chg { fill: var(--ex-chg); } .ex-map .ex-tag-same { fill: var(--ex-same); }
.ex-map .ex-edge { fill: none; stroke-width: 1.6; }
.ex-map .ex-edge-new { stroke: var(--ex-new); } .ex-map .ex-edge-same { stroke: var(--ex-same); stroke-dasharray: 3 3; }
.ex-map .ex-arrowhead-new { fill: var(--ex-new); } .ex-map .ex-arrowhead-same { fill: var(--ex-same); }
.ex-map .ex-edge-label { font-size: 11.5px; fill: var(--results-fg); paint-order: stroke; stroke: var(--results-bg); stroke-width: 4px; stroke-linejoin: round; }
.ex-mapshot { position: absolute; height: auto; border-radius: 6px; pointer-events: none; }
.ex-mapfig figcaption { margin-top: 10px; }
.ex-legend { font-size: 0.85em; color: var(--results-muted); margin: 4px 0 0; }
.ex-tally { font-size: 0.9em; margin: 6px 0 0; }
/* Hit areas: override the app's details box with a more specific rule. */
.ex-mapbox details.ex-hit { position: absolute !important; border: 0 !important; margin: 0 !important; padding: 0 !important; border-radius: 10px !important; background: transparent !important; }
.ex-mapbox details.ex-hit > summary { display: block !important; width: 100% !important; height: 100% !important; margin: 0 !important; cursor: pointer !important; border-radius: 10px; }
.ex-mapbox details.ex-hit > summary::before, details.ex-hit-inline > summary::before { content: none !important; }
.ex-mapbox details.ex-hit > summary:hover { outline: 2px dashed var(--results-accent); outline-offset: -1px; }
.ex-mapbox details.ex-hit[open] > summary { outline: 3px solid var(--results-accent); outline-offset: -1px; margin: 0 !important; }
details.ex-hit-inline { display: inline-block !important; vertical-align: baseline; border: 0 !important; margin: 0 !important; padding: 0 !important; }
details.ex-hit-inline > summary { display: inline-block !important; font-weight: 400 !important; text-decoration: underline; text-underline-offset: 3px; cursor: pointer !important; margin: 0 !important; }
details.ex-hit-inline[open] > summary { font-weight: 700 !important; margin: 0 !important; }
.ex-panel { position: fixed; top: 0; right: 0; bottom: 0; width: var(--ex-panel-w); overflow-y: auto; z-index: 20; padding: 22px 22px 40px; background: var(--results-bg); border-left: 1px solid var(--results-border); box-shadow: -8px 0 24px rgba(0,0,0,0.18); font-weight: 400; cursor: auto; text-align: left; }
body:has(details.ex-hit[open], details.ex-hit-inline[open]) > :not(script):not(style) { margin-inline: 0 !important; box-sizing: border-box !important; width: calc(100vw - var(--ex-panel-w) - 24px) !important; max-width: none !important; }
.ex-p-top { display: flex; align-items: baseline; gap: 10px; }
.ex-p-title { font-size: 1.15em; font-weight: 700; }
.ex-p-tag { font-size: 0.8em; font-weight: 700; } .ex-p-tag-new { color: var(--ex-new); } .ex-p-tag-chg { color: var(--ex-chg); } .ex-p-tag-same { color: var(--ex-same); }
.ex-p-why { margin: 8px 0 12px; }
.ex-p-img { display: block; width: 70%; height: auto; border-radius: 8px; margin: 0 0 10px; }
.ex-p-h { font-size: 0.85em; color: var(--results-muted); margin: 14px 0 4px; }
.ex-p-tests ul { margin: 0; padding-left: 1.2em; }
.ex-p-foot { margin-top: 16px; display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; }
.ex-p-foot span { font-size: 0.8em; color: var(--results-muted); }
.ex-p-open { font-weight: 600; }
.ex-diff-head { font-size: 0.8em; color: var(--results-muted); margin: 10px 0 2px; font-family: Consolas, 'Cascadia Mono', monospace; }
.ex-diff { margin: 0; font-family: Consolas, 'Cascadia Mono', monospace; font-size: 12px; line-height: 1.5; overflow-x: auto; padding: 6px 0; border-radius: 8px; background: rgba(127,127,127,0.10); white-space: pre; }
.ex-l { display: block; padding: 0 10px 0 0; }
.ex-n { display: inline-block; width: 3.2em; text-align: right; padding-right: 0.8em; opacity: 0.5; user-select: none; }
.ex-add { background: rgba(46,160,67,0.18); }
.ex-del { background: rgba(248,81,73,0.18); }
.ex-interp { border-collapse: collapse; width: 100%; margin: 0.4em 0 1em; font-size: 0.95em; }
.ex-interp th, .ex-interp td { text-align: left; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--results-border); vertical-align: top; }
.ex-interp th { font-weight: 600; color: var(--results-muted); font-size: 0.9em; }
.ex-interp td:last-child { color: var(--results-muted); white-space: nowrap; }
.ex-seq { margin: 1.2em 0; }
.ex-seq__row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; align-items: start; }
.ex-seq__label { font-size: 0.85em; font-weight: 600; margin-bottom: 6px; }
.ex-seq__row img { width: 100%; height: auto; border-radius: 8px; }
.ex-seq figcaption { margin-top: 8px; }
.ex-points li { margin: 0 0 6px; }
.ex-testlist { margin: 0.4em 0; padding-left: 1.6em; }
`;
const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<style>${style}</style>
</head>
<body>
<p class="ex-lead">作業を1回終えるたびにその日の回数を保存し、スタートボタンの下に大きく表示するようにしました。</p>

${mapHtml5}
<figcaption>時間切れで回数を足して保存し、画面の数字は5つの場面で保存から読み直します。
<p class="ex-tally">新しい関数 ${newFns.length} ・ 手を入れた既存の処理 2 ・ 地図に載らない変更: ${inline('CSS', `CSS ${cssLines}行`)}、${inline('TESTS', `テストのファイル ${testLines}行`)}、${inline('README', `README ${readmeLines}行`)} ・ どこにも表示されない変更 ${missing.length}件</p>
<p class="ex-legend">緑: 今回足した部品と呼び出し / 橙の破線: 手を入れた既存の部品 / 灰色: 変更のない部品と呼び出し。矢印の数字は呼び出している行です。部品を押すと、右にその部品のコードが出ます。</p>
</figcaption></figure>

<h2>依頼と、エージェントが足した解釈</h2>
<p>依頼は「タイマー画面に、今日の作業回数を大きく表示してください。」の1文です。エージェントは次の5つを足して作りました。</p>
<table class="ex-interp">
<tr><th>足した解釈</th><th>確かめ方</th></tr>
<tr><td>休憩・一時停止・リセットでは数えない</td><td>自動テスト1・2</td></tr>
<tr><td>再読み込みしても回数を残す</td><td>自動テスト3、下の画面の3枚目</td></tr>
<tr><td>端末の日付で数え、日付が変わったら0回から始める</td><td>自動テスト3・4・5(画面では未確認)</td></tr>
<tr><td>保存が使えないときは、ページを開いている間だけ数える</td><td>自動テスト7</td></tr>
<tr><td>別のタブで終えた作業も反映する(README にない追加)</td><td>自動テスト8</td></tr>
</table>

<h2>画面で確かめた結果</h2>
<figure class="poiesis-figure" data-poiesis-figure-rendered="compare"><div class="poiesis-figure__columns poiesis-figure__compare"><div class="poiesis-figure__column"><div class="poiesis-figure__label">変更前</div><img src=".poiesis-example/shots/before.png" alt="変更前のタイマー画面。回数の欄はない"></div><div class="poiesis-figure__column"><div class="poiesis-figure__label">変更後(青い枠が追加部分)</div><img src=".poiesis-example/shots/after.png" alt="変更後のタイマー画面。スタートボタンの下に今日の作業回数の欄がある"></div></div><figcaption>回数の欄はスタートボタンの下に入り、ほかの部分の配置は変わっていません。</figcaption></figure>

<figure class="ex-seq">
<div class="ex-seq__row">
<div><div class="ex-seq__label">作業を始める前</div><img src=".poiesis-example/shots/seq-1-start.png" alt="作業回数0回のタイマー画面"></div>
<div><div class="ex-seq__label">作業を1回終えた直後(時計を25分進めて撮影)</div><img src=".poiesis-example/shots/seq-2-finished.png" alt="休憩に切り替わり、作業回数が1回になった画面"></div>
<div><div class="ex-seq__label">再読み込みした後</div><img src=".poiesis-example/shots/seq-3-reloaded.png" alt="再読み込み後も作業回数が1回のままの画面"></div>
</div>
<figcaption>時間切れで1回に増え(地図の「作業の時間切れ」)、再読み込みしても1回のままです(「ページを開いたとき」)。</figcaption>
</figure>

<h2>懸念点</h2>
<ol class="ex-points">
<li>2つのタブでほぼ同時に作業を終えると、1回分が消えることがあります。両方が同じ数を読んでから1を足して保存するためです。コードを読んでの判断で、試していません(${inline('F2', '回数を1足して保存')})。</li>
<li>別のタブの反映は依頼にない追加で、そのために1秒ごとに保存を読み直しています(${inline('E5', '1秒ごと')})。</li>
<li>作業場所に npm のキャッシュ(.npm-cache、18MB)が残っています。除外の設定がないので、このままではコミットに入ります。</li>
</ol>

<details>
<summary>自動テスト ${pass}/${total}件 成功(終了コード ${testExit})</summary>
<p><code>node --test tests/daily-count.test.cjs</code> で確かめました。</p>
<ol class="ex-testlist">
${T.slice(1).map(n => `<li>${esc(n)}</li>`).join('\n')}
</ol>
</details>

<details>
<summary>まだ確かめていないこと 2件</summary>
<ul>
<li>日付が変わる瞬間の表示の切り替えは、画面では見ていません(自動テスト3・4・5で確認)。</li>
<li>2つのタブで同時に作業を終えたときの動き(懸念点の1)。</li>
</ul>
</details>
</body>
</html>
`;
fs.writeFileSync(OUT5, html, 'utf8');
console.log(JSON.stringify({ out: OUT5, bytes: html.length, pass, total, testExit, missing: missing.length, cssLines, readmeLines, testLines, hits: Object.keys(nodes).length, drawn: drawn.length }));
