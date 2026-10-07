import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { layoutGraph, CAPACITY, abbreviate } from './layout.mjs';
import { verifyBrowser } from './browser-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = process.argv[2];
if (!workspace) { process.stderr.write('作業場所のパスが必要です。\n'); process.exit(1); }
const fail = message => { throw new Error(message); };
const request = 'タイマー画面に、今日の作業回数を大きく表示してください。';
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const painted = edge => edge.paintedSegments ?? edge.points.slice(1).map((b, i) => [edge.points[i], b]);
const crosses = (a, b, box) => a.x === b.x
  ? a.x > box.x && a.x < box.x + box.w && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.h
  : a.y === b.y && a.y > box.y && a.y < box.y + box.h && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.w;
const verifyGeometry = (graph, label) => {
  if (!graph?.boxes?.length || !graph?.edges?.length) fail(`${label}: 地図の幾何データがありません。`);
  if (graph.layerCount > 4 || graph.width > 1000) fail(`${label}: 4列・幅1000を超えています。`);
  for (const box of graph.boxes) {
    if (box.kind === 'entry' && box.layer !== 0) fail(`${label}: 入口が左端にありません。`);
    if ((box.kind === 'storage' || box.kind === 'screen') && box.layer !== graph.layerCount - 1) fail(`${label}: 保存先・画面が右端にありません。`);
    if (box.kind === 'function' && (box.layer < 1 || box.layer >= graph.layerCount - 1)) fail(`${label}: 処理が中間の層にありません。`);
  }
  for (let i = 0; i < graph.boxes.length; i++) for (let j = i + 1; j < graph.boxes.length; j++)
    if (overlaps(graph.boxes[i], graph.boxes[j])) fail(`${label}: 箱どうしが重なっています。`);
  const boxes = new Map(graph.boxes.map(box => [box.id, box]));
  for (const edge of graph.edges) {
    const from = boxes.get(edge.from), to = boxes.get(edge.to);
    if (!from || !to) fail(`${label}: 矢印の端の箱がありません。`);
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1], b = edge.points[i];
      if ([a, b].some(p => p.x < 0 || p.y < 0 || p.x > graph.width || p.y > graph.height)) fail(`${label}: 矢印が地図の外に出ています。`);
      if (a.x !== b.x && a.y !== b.y) fail(`${label}: 矢印が直交線ではありません。`);
      if (graph.routing === 'compact' && from.layer < to.layer && b.x < a.x) fail(`${label}: 左から右への矢印が戻っています。`);
      for (const box of graph.boxes) if (box.id !== edge.from && box.id !== edge.to && crosses(a, b, box)) fail(`${label}: 矢印 ${edge.id} が別の箱を横切っています。`);
    }
    if (graph.boxes.some(box => overlaps(edge.label, box))) fail(`${label}: 行番号 ${edge.line} の札が箱に重なっています。`);
    for (const line of graph.edges) for (const [a, b] of painted(line))
      if (crosses(a, b, edge.label)) fail(`${label}: 札が矢印と重なっています。`);
    if (edge.label.x < 0 || edge.label.y < 0 || edge.label.x + edge.label.w > graph.width || edge.label.y + edge.label.h > graph.height) fail(`${label}: 行番号の札が地図の外に出ています。`);
  }
  for (let i = 0; i < graph.edges.length; i++) for (let j = i + 1; j < graph.edges.length; j++)
    if (overlaps(graph.edges[i].label, graph.edges[j].label)) fail(`${label}: 行番号の札どうしが重なっています。`);
  const segments = graph.edges.flatMap(e => painted(e).map(([a, b]) => ({ id: e.id, a, b })));
  for (let i = 0; i < segments.length; i++) for (const t of segments.slice(i + 1)) {
    const s = segments[i]; if (s.id === t.id) continue;
    const vertical = s.a.x === s.b.x && t.a.x === t.b.x && s.a.x === t.a.x;
    const horizontal = s.a.y === s.b.y && t.a.y === t.b.y && s.a.y === t.a.y;
    const axis = vertical ? 'y' : horizontal ? 'x' : null;
    if (axis && Math.min(Math.max(s.a[axis], s.b[axis]), Math.max(t.a[axis], t.b[axis])) > Math.max(Math.min(s.a[axis], s.b[axis]), Math.min(t.a[axis], t.b[axis]))) fail(`${label}: 別の矢印が同じ線を通っています。`);
    const v = s.a.x === s.b.x ? s : t, h = v === s ? t : s;
    if (v.a.x === v.b.x && h.a.y === h.b.y && v.a.x >= Math.min(h.a.x, h.b.x) && v.a.x <= Math.max(h.a.x, h.b.x)
      && h.a.y >= Math.min(v.a.y, v.b.y) && h.a.y <= Math.max(v.a.y, v.b.y)) fail(`${label}: 別の矢印どうしが交差しています。`);
  }
  const length = ([a, b]) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const rawLength = graph.edges.flatMap(e => e.points.slice(1).map((b, i) => [e.points[i], b])).reduce((sum, s) => sum + length(s), 0);
  const paintedLength = graph.edges.flatMap(painted).reduce((sum, s) => sum + length(s), 0);
  if (rawLength - paintedLength > (graph.bridges ?? 0) * 6 + .001) fail(`${label}: 交差を避ける切れ目以外の線が消えています。`);
};
const verifyOwnDiff = (result, draft, prepared, label) => {
  const { html, geometry } = result;
  const candidates = new Map(prepared.map.nodes.map(n => [n.id, n]));
  const ranges = new Map(draft.nodes.map(part => {
    const node = candidates.get(part.id);
    return [part.id, node.symbol === 'page load'
      ? prepared.map.edges.filter(e => e.from === node.id && draft.edges.includes(e.id)).map(e => ({ file: e.file, line: e.line, end: e.line }))
      : [node]];
  }));
  const covers = (rs, file, row) => rs.some(r => r.file === file && (row.newLine ?? row.line) >= r.line && (row.newLine ?? row.line) <= r.end);
  const hasRow = (text, file, row) => text.includes(`data-diff-file="${file}" data-diff-line="${row.line}" data-diff-kind="${row.kind}"`);
  for (const part of draft.nodes) {
    const node = candidates.get(part.id);
    const box = geometry.boxes.find(b => b.members.includes(part.id));
    const members = box?.members ?? [part.id];
    const open = html.indexOf(`data-node-id="${box?.id ?? part.id}"`);
    if (open < 0) fail(`${label}: 部品 ${part.id} のパネルがありません。`);
    const close = html.indexOf('<details class="ex-close"', open);
    const panel = html.slice(open, close);
    for (const h of prepared.hunks) for (const row of h.lines) {
      const own = members.some(id => covers(ranges.get(id), h.file, row));
      const claimed = [...ranges.values()].some(rs => covers(rs, h.file, row));
      const assigned = draft.nodes.some(n => members.includes(n.id) && n.hunkIds.includes(h.id));
      const expected = own || !claimed && assigned;
      if (hasRow(panel, h.file, row) !== expected) fail(`${label}: ${part.title} の差分範囲が不正です: ${h.file}:${row.line} (${row.kind})`);
    }
  }
  const primary = html.slice(0, html.indexOf('<h2>依頼と'));
  for (const h of prepared.hunks) for (const row of h.lines) if (!hasRow(primary, h.file, row)) fail(`${label}: 差分の行がどのパネルにもありません: ${h.file}:${row.line}`);
};
const verifyS6 = (result, draft, prepared, label) => {
  const graph = result.geometry;
  verifyGeometry(graph, label); verifyOwnDiff(result, draft, prepared, label);
  const find = symbol => graph.boxes.find(b => b.symbol === symbol);
  const chain = ['finish', 'recordCompletedWork', 'renderDailyCount'].map(find);
  if (chain.some(b => !b || b.layer !== 1) || chain.some((b, i) => i && b.y <= chain[i - 1].y + chain[i - 1].h)) fail(`${label}: 3つの処理が同じ列の縦の連鎖ではありません。`);
  for (let i = 1; i < chain.length; i++) {
    const edge = graph.edges.find(e => e.from === chain[i - 1].id && e.to === chain[i].id);
    if (!edge || edge.points[0].y !== chain[i - 1].y + chain[i - 1].h || edge.points.at(-1).y !== chain[i].y || edge.points.some(p => p.x !== edge.points[0].x)) fail(`${label}: 処理の矢印が下辺から上辺への直線ではありません。`);
  }
  if (find('getLocalDay') || graph.boxes.filter(b => b.subLines.some(s => s.includes('getLocalDay('))).length !== 2) fail(`${label}: 補助関数が2つの箱の説明へ畳まれていません。`);
  if (graph.boxes.filter(b => b.kind === 'entry').length !== 5 || find('getDailyCount')?.layer !== 2) fail(`${label}: 入口5つと共有の読み出しの列が違います。`);
  if (!result.html.includes(`viewBox="0 0 ${graph.width} ${graph.height}"`)) fail(`${label}: SVGの幅が幾何データと違います。`);
  const accounted = [...result.drawnEdges, ...result.foldedEdges];
  if (accounted.length !== new Set(accounted).size || accounted.length !== draft.edges.length || !draft.edges.every(id => accounted.includes(id))) fail(`${label}: 折り畳んだ呼び出しを含む矢印の集計が一致しません。`);
  for (const edge of graph.edges) {
    const machine = prepared.map.edges.find(e => e.id === edge.id);
    if (!machine || machine.from !== edge.originalFrom || machine.to !== edge.originalTo || machine.line !== edge.line) fail(`${label}: 機械の候補と矢印の根拠が違います。`);
    const prefix = { read: '読み出し ', write: '書き込み ', display: '表示 ', call: '' }[machine.access];
    if (edge.text !== prefix + machine.line) fail(`${label}: 読み書きの札が構文の種類と違います。`);
  }
};
const run = (file, input, cwd = here) => {
  const result = spawnSync(process.execPath, [file], { cwd, input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) fail(`${file}: ${result.error.message}`);
  if (result.status !== 0) fail(`${file}: exit ${result.status}: ${result.stderr} ${result.stdout}`);
  try { return JSON.parse(result.stdout); } catch { fail(`${file}: 標準出力が JSON ではありません。`); }
};

try {
  const prepared = run(resolve(here, 'prepare.mjs'), { workspace });
  if (!prepared.ok) fail(prepared.reasons.join(' / '));
  if (prepared.aiMaterial.length > 16000) fail('AI に渡す資料が16000字を超えました。');
  const draft = JSON.parse(readFileSync(resolve(here, 'fixture-s6.json'), 'utf8'));
  const aiOriginal = JSON.parse(readFileSync(resolve(here, 'fixture-s6-ai.json'), 'utf8'));
  const ai3Original = JSON.parse(readFileSync(resolve(here, 'fixture-s6-ai3.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (createHash('sha256').update(readFileSync(resolve(here, 'fixture-s6-ai3.json'))).digest('hex') !== 'fa3718bf112c788325c699c900d5e27b894364f9329212495e8a01a916308b14') fail('AIの3回目の原文が書き換わっています。');
  const tests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/daily-count.test.cjs'], { cwd: resolve(workspace), encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 8 * 1024 * 1024 });
  if (tests.error) fail(`S6 のテストを実行できません: ${tests.error.message}`);
  const output = tests.stdout ?? '';
  const total = Number(output.match(/^ℹ tests (\d+)/m)?.[1] ?? output.match(/^# tests (\d+)/m)?.[1] ?? 0);
  const pass = Number(output.match(/^ℹ pass (\d+)/m)?.[1] ?? output.match(/^# pass (\d+)/m)?.[1] ?? 0);
  if (tests.status !== 0 || total !== 8 || pass !== 8) fail(`S6 のテストが8/8ではありません: exit ${tests.status}, ${pass}/${total}`);
  const evidence = { tests: { command: 'node --test --test-reporter=tap tests/daily-count.test.cjs', output, pass, total, exitCode: tests.status }, images: [
    { role: 'before', path: '.poiesis-example/shots/before.png', alt: '変更前のタイマー画面', caption: '変更前' },
    { role: 'after', path: '.poiesis-example/shots/after.png', alt: '今日の作業回数を追加した画面', caption: '変更後' },
    { role: 'sequence', path: '.poiesis-example/shots/seq-1-start.png', alt: '作業開始前の画面', caption: '作業を始める前' },
    { role: 'sequence', path: '.poiesis-example/shots/seq-2-finished.png', alt: '作業を終えた直後の画面', caption: '作業を1回終えた直後' },
    { role: 'sequence', path: '.poiesis-example/shots/seq-3-reloaded.png', alt: '再読み込み後の画面', caption: '再読み込みした後' }
  ], mapImage: '.poiesis-example/shots/map-daily-count.png' };
  const renderDraft = current => run(resolve(here, 'render.mjs'), { prepared, draft: current, evidence, request });
  const result = renderDraft(draft);
  if (!result.ok) fail(`見本の組み立てに失敗: ${result.reasons.join(' / ')}`);
  verifyS6(result, draft, prepared, '見本');
  const aiResult = renderDraft(aiOriginal);
  if (!aiResult.ok) fail(`実際の AI の選択を組み立てられません: ${aiResult.reasons.join(' / ')}`);
  verifyS6(aiResult, aiOriginal, prepared, '実際の AI');
  const ai3Result = renderDraft(ai3Original);
  if (!ai3Result.ok) fail(`新しい指示文の AI を組み立てられません: ${ai3Result.reasons.join(' / ')}`);
  verifyS6(ai3Result, ai3Original, prepared, '新しい指示文の AI');
  const ai3Merged = ai3Result.geometry.boxes.find(b => b.members.includes('n-baba4cd4e01c'));
  if (ai3Merged?.kind !== 'entry' || !ai3Merged.members.includes('n-399aa1ab477d')) fail('新しいAIの入口と既存処理が一つの箱ではありません。');
  const ai3Machine = ai3Original.nodes.map(n => ({ ...prepared.map.nodes.find(m => m.id === n.id), ...n }));
  const ai3Edges = ai3Original.edges.map(id => prepared.map.edges.find(e => e.id === id));
  const corridorCase = layoutGraph(ai3Machine, ai3Edges, { forceCorridors: true });
  verifyGeometry(corridorCase, '列間と箱の上下を通る代替経路');
  if (corridorCase.edges.length !== ai3Result.drawnEdges.length || corridorCase.boxes.length !== 11) fail('代替経路で部品や矢印が消えています。');
  const denseNodes = Array.from({ length: 6 }, (_, i) => ({ id: `dense-${i}`, kind: 'function', symbol: `dense${i}`, title: '処理を進める', caption: '次の処理へ進みます。', file: 'example.js', line: i + 1, end: i + 1, status: 'new', helper: false, hunkIds: [] }));
  const denseEdges = denseNodes.slice(0, 3).flatMap((from, i) => denseNodes.slice(3).map((to, j) => ({ id: `dense-edge-${i}-${j}`, from: from.id, to: to.id, line: i * 3 + j + 1, access: 'call', status: 'new' })));
  const dense = layoutGraph(denseNodes, denseEdges, { forceCorridors: true });
  verifyGeometry(dense, '交差を避ける切れ目を持つ多対多の経路');
  if (dense.edges.length !== 9 || !dense.bridges) fail('多対多の経路が省かれています。');
  // Renamed/reordered inputs must still obey the role, reduction and geometry rules.
  const selectedMachine = draft.nodes.map(n => ({ ...prepared.map.nodes.find(m => m.id === n.id), ...n }));
  const selectedEdges = draft.edges.map(id => prepared.map.edges.find(e => e.id === id));
  const rename = id => `renamed-${id}`;
  const renamed = layoutGraph(selectedMachine.map(n => ({ ...n, id: rename(n.id), symbol: `fn_${n.line}`, outgoing: n.outgoing.map(rename) })).reverse(),
    selectedEdges.map(e => ({ ...e, id: rename(e.id), from: rename(e.from), to: rename(e.to) })).reverse());
  if (renamed.layerCount !== 4 || renamed.width > 1000 || renamed.boxes.filter(b => b.kind === 'entry').length !== 5 || renamed.folded.length !== 4) fail('名前を変えると役割や折り畳みが変わります。');
  verifyGeometry(renamed, '名前と順序を変えた地図');
  for (const candidate of [result, aiResult, ai3Result]) {
    if (/<script\b|\son[a-z]+\s*=|data:|(?:href|src)=["'](?:https?:|\/\/)|href=["']#[^"']+/i.test(candidate.html)) fail('文書に禁止された要素やリンクがあります。');
    if (candidate.unassignedHunks !== 0) fail('割り当てのない差分があります。');
  }
  const candidateEdges = new Set(prepared.map.edges.map(e => e.id));
  if (!result.drawnEdges.every(id => candidateEdges.has(id))) fail('描いた矢印に候補外のものがあります。');
  if (result.unassignedHunks !== 0) fail(`割り当てのない差分が ${result.unassignedHunks} 件あります。`);
  if (!result.html.includes('自動テスト 8/8件 成功(終了コード 0)') || !result.html.includes('tests/daily-count.test.cjs')) fail('テストの証拠が文書にありません。');
  if (result.html.split(request).length !== 2 || result.html.includes('<th>依頼</th>')) fail('元の依頼文が表の上にそのまま1回だけ出ていません。');
  if (/<script\b/i.test(result.html) || /\s(?:on[a-z]+)\s*=/i.test(result.html) || /(?:src|href)\s*=\s*["'](?:https?:|\/\/)/i.test(result.html) || /url\(\s*["']?(?:https?:|\/\/)/i.test(result.html)) fail('文書にスクリプト、イベント属性、外部 URL があります。');
  if (!result.html.includes('<details class="ex-hit" name="ex-panel"') || !result.html.includes('<details class="ex-close" name="ex-panel"><summary>閉じる</summary>')) fail('地図のパネルと閉じる操作がありません。');
  if (!result.html.includes('.ex-panel details.ex-close > summary::before { content: none !important; display: none !important;')) fail('閉じる操作の枠と印を打ち消す CSS がありません。');
  if (/data:/i.test(result.html)) fail('文書に data: URI があります。');
  if ([...result.html.matchAll(/href="#[^"]*"/g)].some(m => m[0] !== 'href="#"')) fail('文書に枠内で使えないページ内リンクがあります。');
  if ([...result.html.matchAll(/<a\b[^>]*>/g)].some(m => !/^<a class="ex-p-open" href="#" data-poiesis-citation="[^"]+:\d+-\d+">$/.test(m[0]))) fail('Code で開くリンクの形が違います。');
  if (result.html.includes('読む順番')) fail('文書に不要なコードを読む順番の節があります。');
  if (!result.html.includes('src=".poiesis-example/shots/map-daily-count.png"')) fail('地図の画像が相対パスではありません。');
  const markers = new Map(), panelStack = [];
  for (const match of result.html.matchAll(/<details\b[^>]*>|<\/details>|<div class="ex-hunk" data-hunk-id="([^"]+)"[^>]*>/g)) {
    const token = match[0];
    if (token.startsWith('<details')) panelStack.push(/class="ex-hit(?:-inline)?"/.test(token));
    else if (token === '</details>') panelStack.pop();
    else {
      if (!panelStack.includes(true)) fail(`差分の塊 ${match[1]} がパネルの外にあります。`);
      markers.set(match[1], (markers.get(match[1]) ?? 0) + 1);
    }
  }
  for (const h of prepared.hunks) if (markers.get(h.id) !== 1) fail(`差分の塊 ${h.id} がちょうど1つのパネルにありません。`);
  if (markers.size !== prepared.hunks.length) fail('候補外の差分の塊が文書にあります。');
  const tally = result.html.slice(result.html.indexOf('<div class="ex-tally">'), result.html.indexOf('<h2>依頼と'));
  for (const item of draft.offMap) {
    const count = item.hunkIds.flatMap(id => prepared.hunks.find(h => h.id === id).lines).filter(l => l.kind === 'add' || l.kind === 'delete').length;
    if (!tally.includes(`<details class="ex-hit-inline" name="ex-panel"><summary>${item.title} ${count}行</summary><div class="ex-panel"`)) fail(`地図に載らない変更 ${item.title} が集計行からパネルを開けません。`);
  }
  const concernSection = result.html.slice(result.html.indexOf('<h2>懸念点</h2>'), result.html.indexOf('</ol>', result.html.indexOf('<h2>懸念点</h2>')));
  for (const concern of draft.concerns) {
    const summary = `<details class="ex-hit-inline" name="ex-panel"><summary>${concern.text}</summary><div class="ex-panel"`;
    const start = concernSection.indexOf(summary);
    const excerpt = concernSection.slice(start, concernSection.indexOf('<details class="ex-close"', start));
    if (start < 0 || !excerpt.includes('<pre class="ex-diff">') || !excerpt.includes(`<span class="ex-n">${concern.line}</span>`)
      || !excerpt.includes(`data-poiesis-citation="${concern.file}:${concern.line}-${concern.line}"`)) fail(`懸念点 ${concern.file}:${concern.line} が差分つきの右パネルを開けません。`);
  }
  const invalid = [
    { name: '候補外の部品', mutate: d => d.nodes[0].id = 'not-a-candidate', expected: /候補にない部品/ },
    { name: '候補外の矢印', mutate: d => d.edges.push('e-not-a-candidate'), expected: /候補にない矢印/ },
    { name: '範囲外の行', mutate: d => d.concerns[0].line = 999999, expected: /範囲外/ },
    { name: '割り当ての抜け', mutate: d => d.nodes.find(n => n.hunkIds.length).hunkIds.pop(), expected: /割り当てのない差分/ },
    { name: '割り当ての重複', mutate: d => d.nodes[0].hunkIds.push(d.offMap[0].hunkIds[0]), expected: /重複/ },
    { name: '依頼を書き換える古い形', mutate: d => d.interpretations[0].request = '置き換え', expected: /不要な項目 request/ }
  ];
  for (const test of invalid) {
    const broken = structuredClone(draft); test.mutate(broken);
    const refusal = renderDraft(broken);
    if (refusal.ok || refusal.html || !Array.isArray(refusal.reasons) || !refusal.reasons.some(reason => test.expected.test(reason))) fail(`${test.name}を理由つきで拒否できません。`);
  }
  const longDraft = structuredClone(draft);
  longDraft.nodes[0].title = '長い名前'.repeat(40);
  const longResult = renderDraft(longDraft);
  if (!longResult.ok || !longResult.html.includes(longDraft.nodes[0].title)) fail('長い名前を省略して全文をパネルに出せません。');
  verifyGeometry(longResult.geometry, '長い名前');
  const quoted = 'document "visibilitychange" 719-724行';
  const shortened = abbreviate(quoted, 175, 11);
  if (!shortened.endsWith('…') || (shortened.match(/"/g) ?? []).length % 2) fail('引用符の途中で補助行を省略しています。');
  // Only excess box counts cause a layout retry. A cycle has a return route.
  for (const count of [2, 22]) {
    const crowded = structuredClone(prepared), proposal = structuredClone(draft);
    crowded.map.nodes = Array.from({ length: count }, (_, i) => ({ id: `part-${i}`, kind: 'function', symbol: `part${i}`, file: 'example.js', line: i + 1, end: i + 1, status: 'new', helper: false }));
    crowded.map.edges = Array.from({ length: count === 2 ? 2 : count - 1 }, (_, i) => ({ id: `call-${i}`, from: `part-${i}`, to: `part-${(i + 1) % count}`, file: 'example.js', line: i + 1, access: 'call', status: 'new' }));
    crowded.hunks = [];
    proposal.nodes = crowded.map.nodes.map(n => ({ id: n.id, title: '処理を進める', caption: '次の処理へ進みます。', hunkIds: [] }));
    proposal.edges = crowded.map.edges.map(e => e.id); proposal.offMap = []; proposal.concerns = [];
    const refusal = run(resolve(here, 'render.mjs'), { prepared: crowded, draft: proposal, evidence: {}, request });
    if (count === 2) {
      if (!refusal.ok) fail('小さな循環を列間の経路で描けません。');
      verifyGeometry(refusal.geometry, '処理の循環');
    } else if (refusal.ok || refusal.html || !refusal.reasons.some(r => r.includes(`${count}個`) && r.includes(`上限${CAPACITY.total}個`) && r.includes(`上限${CAPACITY.perColumn}個`))) fail('箱が多い場合の理由に数と上限がありません。');
  }
  const out = resolve(here, 'out/s6.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.html, 'utf8');
  writeFileSync(resolve(here, 'out/s6-ai.html'), aiResult.html, 'utf8');
  writeFileSync(resolve(here, 'out/s6-ai3.html'), ai3Result.html, 'utf8');
  const browser = await verifyBrowser([{ name: 'fixture', result }, { name: 'ai', result: aiResult }, { name: 'fixture-ai3', result: ai3Result }], prepared.workspace, evidence);
  const report = { ok: true, out, hunks: prepared.hunks.length, nodes: result.geometry.boxes.length, edges: result.drawnEdges.length, folded: result.foldedEdges.length, layers: result.geometry.layerCount, width: result.geometry.width, height: result.geometry.height, aiNodes: aiResult.geometry.boxes.length, aiEdges: aiResult.drawnEdges.length, aiFolded: aiResult.foldedEdges.length, aiLayers: aiResult.geometry.layerCount, aiWidth: aiResult.geometry.width, aiHeight: aiResult.geometry.height, geometryCases: 3, unassignedHunks: result.unassignedHunks, tests: `${pass}/${total}`, testExit: tests.status, invalidCases: invalid.length + 2, browser };
  report.ai3 = { nodes: ai3Result.geometry.boxes.length, entries: ai3Result.geometry.boxes.filter(b => b.kind === 'entry').length, edges: ai3Result.drawnEdges.length, folded: ai3Result.foldedEdges.length, layers: ai3Result.geometry.layerCount, width: ai3Result.geometry.width, height: ai3Result.geometry.height, routing: ai3Result.geometry.routing };
  report.geometryCases = 8; report.invalidCases = invalid.length + 1;
  report.corridorCase = { edges: corridorCase.edges.length, bridges: corridorCase.bridges };
  writeFileSync(resolve(here, 'out/check-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
