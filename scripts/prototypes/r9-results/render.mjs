import { readFileSync, realpathSync } from 'node:fs';
import { resolve, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutGraph } from './layout.mjs';

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const list = value => Array.isArray(value) ? value : [];
const onlyKeys = (value, keys, label, reasons) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { reasons.push(`${label}を JSON オブジェクトで書き直してください。`); return; }
  for (const key of Object.keys(value)) if (!keys.includes(key)) reasons.push(`${label}に不要な項目 ${key} があります。指定された形だけで書き直してください。`);
};
const plain = (value, label, reasons) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 600 || /[<>]/.test(value)) { reasons.push(`${label}を短いプレーンテキストで書き直してください。`); return ''; }
  return value.trim();
};
const oneSentence = (value, label, reasons) => {
  const text = plain(value, label, reasons);
  if (!/[。．.!！]$/.test(text) || (text.match(/[。．.!！]/g) ?? []).length !== 1) reasons.push(`${label}を1文で書き直してください。`);
  return text;
};
const tag = { new: '新規', modified: '変更', existing: '既存' };
const safePath = (workspace, path) => {
  if (typeof path !== 'string' || /^(?:[a-z]+:|\/\/)/i.test(path)) return null;
  const full = resolve(workspace, path);
  const rel = relative(workspace, full);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : null;
};
const imagePath = (workspace, path) => {
  const full = safePath(workspace, path);
  if (!full) throw new Error(`画像のパスが作業場所の外を指しています: ${path}`);
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(full).toLowerCase()];
  if (!mime) throw new Error(`画像の形式を確認してください: ${path}`);
  const actual = realpathSync(full), root = realpathSync(workspace);
  const rel = relative(root, actual);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`画像の実体が作業場所の外を指しています: ${path}`);
  const data = readFileSync(actual);
  if (data.length > 5 * 1024 * 1024) throw new Error(`画像が大きすぎます: ${path}`);
  const signatures = { 'image/png': data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'image/jpeg': data[0] === 0xff && data[1] === 0xd8, 'image/webp': data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' };
  if (!signatures[mime]) throw new Error(`画像の内容を確認してください: ${path}`);
  return relative(root, actual).replace(/\\/g, '/');
};

function validate(prepared, draft) {
  const reasons = [];
  if (!prepared?.ok || !Array.isArray(prepared?.map?.nodes) || !Array.isArray(prepared?.map?.edges) || !Array.isArray(prepared?.hunks)) return ['準備の出力がありません。準備をやり直してください。'];
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return ['JSON の本文をオブジェクトとして書き直してください。'];
  onlyKeys(draft, ['lead', 'nodes', 'edges', 'offMap', 'interpretations', 'concerns', 'unverified'], 'JSON の本文', reasons);
  oneSentence(draft.lead, '冒頭', reasons);
  const nodes = new Map(prepared.map.nodes.map(n => [n.id, n]));
  const edges = new Map(prepared.map.edges.map(e => [e.id, e]));
  const hunks = new Map(prepared.hunks.map(h => [h.id, h]));
  const assigned = new Map();
  const assign = (ids, owner) => {
    if (!Array.isArray(ids)) { reasons.push(`${owner}の差分の塊を hunkIds の配列で指定してください。`); return; }
    for (const id of ids) {
      if (!hunks.has(id)) reasons.push(`${owner}に候補にない差分の塊 ${id} があります。`);
      else if (assigned.has(id)) reasons.push(`差分の塊 ${id} は ${assigned.get(id)} と ${owner} に重複して割り当てられています。一か所にしてください。`);
      else assigned.set(id, owner);
    }
  };
  if (!Array.isArray(draft.nodes) || !draft.nodes.length) reasons.push('描く部品を nodes に選んでください。');
  const selected = new Set();
  for (const item of list(draft.nodes)) {
    onlyKeys(item, ['id', 'title', 'caption', 'hunkIds'], '部品', reasons);
    if (!nodes.has(item?.id)) reasons.push(`候補にない部品 ${item?.id ?? '(ID なし)'} を選んでいます。準備の候補から選び直してください。`);
    if (selected.has(item?.id)) reasons.push(`部品 ${item?.id ?? '(ID なし)'} が重複しています。`);
    selected.add(item?.id);
    plain(item?.title, '部品の日本語名', reasons); oneSentence(item?.caption, `部品 ${item?.id ?? '(ID なし)'} の説明`, reasons);
    assign(item?.hunkIds, `部品 ${item?.id ?? '(ID なし)'}`);
  }
  if (!Array.isArray(draft.edges)) reasons.push('描く矢印を edges に指定してください。');
  const selectedEdges = new Set();
  for (const id of list(draft.edges)) {
    if (!edges.has(id)) reasons.push(`候補にない矢印 ${id} があります。準備の矢印から選び直してください。`);
    else if (!selected.has(edges.get(id).from) || !selected.has(edges.get(id).to)) reasons.push(`矢印 ${id} の両端の部品を選んでください。`);
    if (selectedEdges.has(id)) reasons.push(`矢印 ${id} が重複しています。`);
    selectedEdges.add(id);
  }
  if (!Array.isArray(draft.offMap)) reasons.push('地図に載らない変更を offMap の配列で書いてください。');
  for (const item of list(draft.offMap)) {
    onlyKeys(item, ['title', 'caption', 'hunkIds'], '地図に載らない変更', reasons);
    plain(item?.title, '地図に載らない変更の名前', reasons);
    oneSentence(item?.caption, '地図に載らない変更の説明', reasons);
    if (!Array.isArray(item?.hunkIds) || !item.hunkIds.length) reasons.push('地図に載らない変更には差分の塊を1件以上割り当ててください。');
    assign(item?.hunkIds, `地図に載らない変更 ${item?.title ?? '(名前なし)'}`);
  }
  const unassigned = [...hunks.keys()].filter(id => !assigned.has(id));
  if (unassigned.length) reasons.push(`割り当てのない差分の塊が ${unassigned.length} 件あります。${unassigned.join('、')} を部品か地図に載らない変更のパネルへ割り当ててください。`);
  if (!Array.isArray(draft.interpretations) || !draft.interpretations.length) reasons.push('依頼と解釈の表を interpretations に書いてください。');
  for (const row of list(draft.interpretations)) { onlyKeys(row, ['decision', 'evidence'], '補った判断の行', reasons); plain(row?.decision, '依頼にない判断', reasons); plain(row?.evidence, '確かめ方', reasons); }
  if (!Array.isArray(draft.concerns) || draft.concerns.length > 3) reasons.push('懸念点は最大3件にしてください。');
  const changedLines = new Map();
  for (const h of prepared.hunks) for (const l of h.lines) if (l.kind === 'add') { if (!changedLines.has(h.file)) changedLines.set(h.file, new Set()); changedLines.get(h.file).add(l.line); }
  for (const c of list(draft.concerns)) {
    onlyKeys(c, ['text', 'file', 'line'], '懸念点', reasons);
    plain(c?.text, '懸念点', reasons);
    if (!changedLines.get(c?.file)?.has(c?.line)) reasons.push(`懸念点の ${c?.file ?? '(ファイルなし)'}:${c?.line ?? '(行なし)'} は差分の追加行の範囲外です。実際の差分から行を選び直してください。`);
  }
  if (!Array.isArray(draft.unverified)) reasons.push('未確認の項目を unverified の配列にしてください。');
  for (const value of list(draft.unverified)) plain(value, '未確認の項目', reasons);
  return reasons;
}

function render(prepared, draft, evidence, request) {
  const nodes = new Map(prepared.map.nodes.map(n => [n.id, n]));
  const edges = new Map(prepared.map.edges.map(e => [e.id, e]));
  const hunks = new Map(prepared.hunks.map(h => [h.id, h]));
  const selected = draft.nodes.map(item => ({ ...nodes.get(item.id), title: item.title, caption: item.caption, hunkIds: item.hunkIds }));
  const graph = layoutGraph(selected, draft.edges.map(id => edges.get(id)));
  const { width, height } = graph;
  const positions = new Map(graph.boxes.map(box => [box.id, box]));
  const diffRows = (lines, file) => lines.map(l => `<span class="ex-l ${l.kind === 'add' ? 'ex-add' : l.kind === 'delete' ? 'ex-del' : ''}" data-diff-file="${esc(file)}" data-diff-line="${l.line}" data-diff-kind="${l.kind}"><span class="ex-n">${l.line}</span>${l.kind === 'add' ? '+' : l.kind === 'delete' ? '-' : ' '} ${esc(l.text)}</span>`).join('');
  const diffHtml = h => `<div class="ex-hunk" data-hunk-id="${esc(h.id)}"><div class="ex-diff-head">${esc(h.file)} ${h.start}${h.count > 1 ? `-${h.start + h.count - 1}` : ''}行</div><pre class="ex-diff">${diffRows(h.lines, h.file)}</pre></div>`;
  const cite = (file, start, end = start) => `${file}:${start}-${end}`;
  const panel = ({ title, caption, chunks, citation, status }) => `<div class="ex-panel" role="region" aria-label="${esc(title)}の中身"><div class="ex-p-top"><span class="ex-p-title">${esc(title)}</span>${status ? `<span class="ex-p-tag ex-p-tag-${status === 'modified' ? 'chg' : status === 'new' ? 'new' : 'same'}">${tag[status]}</span>` : ''}</div><p class="ex-p-why">${esc(caption)}</p>${chunks || '<p>この部品に割り当てた差分はありません。</p>'}<p class="ex-p-foot"><a class="ex-p-open" href="#" data-poiesis-citation="${esc(citation)}">Code で開く</a></p><details class="ex-close" name="ex-panel"><summary>閉じる</summary></details></div>`;
  const ranges = new Map(selected.map(n => [n.id, [{ file: n.file, line: n.line, end: n.end }]]));
  for (const box of graph.boxes) for (const member of box.members) ranges.set(member, box.ranges.filter(r => r.id === member));
  const inRange = (file, row, rs) => rs.some(r => r.file === file && (row.newLine ?? row.line) >= r.line && (row.newLine ?? row.line) <= r.end);
  const belongs = (file, row) => [...ranges.values()].some(rs => inRange(file, row, rs));
  // Assignment owns only the remainder; it never imports another part's lines.
  const chunksFor = members => prepared.hunks.map(h => {
    const assigned = members.some(id => selected.find(n => n.id === id)?.hunkIds.includes(h.id));
    const lines = h.lines.filter(l => members.some(id => inRange(h.file, l, ranges.get(id))) || assigned && !belongs(h.file, l));
    const marker = assigned ? `<div class="ex-hunk" data-hunk-id="${esc(h.id)}"></div>` : '';
    return marker + (lines.length ? `<div class="ex-diff-head">${esc(h.file)} ${lines[0].line}-${lines.at(-1).line}行の変更</div><pre class="ex-diff">${diffRows(lines, h.file)}</pre>` : '');
  }).join('');
  const nodePanel = n => {
    const members = n.members ?? [n.id];
    const names = members.length > 1 ? members.map(id => selected.find(s => s.id === id).title) : [];
    const source = [...names, ...(n.subs ?? [`${n.symbol} ${n.line}-${n.end}行`])];
    const fullText = `<div class="ex-p-source">${source.map(s => `<p>${esc(s)}</p>`).join('')}</div>`;
    const diff = chunksFor(members);
    return panel({ title: n.title, caption: n.caption, chunks: fullText + (diff || '<p>この部品に変更はありません。</p>'), citation: cite(n.file, n.line, n.end), status: n.status });
  };
  const offMapPanel = item => {
    const first = hunks.get(item.hunkIds[0]);
    return panel({ title: item.title, caption: item.caption, chunks: item.hunkIds.map(id => {
      const h = hunks.get(id); return diffHtml({ ...h, lines: h.lines.filter(l => !belongs(h.file, l)) });
    }).join(''), citation: cite(first.file, first.start, first.start + Math.max(first.count - 1, 0)) });
  };
  const concernPanel = concern => {
    const hunk = prepared.hunks.find(h => h.file === concern.file && h.lines.some(l => l.kind === 'add' && l.line === concern.line));
    const at = hunk.lines.findIndex(l => l.kind === 'add' && l.line === concern.line);
    const nearby = hunk.lines.slice(Math.max(0, at - 2), Math.min(hunk.lines.length, at + 3));
    const excerpt = `<div class="ex-diff-head">${esc(concern.file)} ${concern.line}行の周辺</div><pre class="ex-diff">${diffRows(nearby, concern.file)}</pre>`;
    return panel({ title: '懸念点', caption: concern.text, chunks: excerpt, citation: cite(concern.file, concern.line) });
  };
  const svg = [`<svg class="ex-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="変更の全体の地図"><defs><marker id="arrow-new" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="ex-arrowhead-new" d="M0,0 L10,5 L0,10 z"/></marker><marker id="arrow-same" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="ex-arrowhead-same" d="M0,0 L10,5 L0,10 z"/></marker></defs>`];
  for (const column of graph.columns) svg.push(`<text class="ex-col" x="${column.x + column.w / 2}" y="18">${column.title}</text>`);
  for (const edge of graph.edges) {
    const cls = edge.status === 'new' ? 'new' : 'same';
    const path = edge.points.map((point, i) => `${i ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
    if (edge.paintedSegments) {
      const paint = edge.paintedSegments.map(([a, b]) => `M${a.x},${a.y} L${b.x},${b.y}`).join(' ');
      const [a, b] = edge.paintedSegments.at(-1);
      svg.push(`<path class="ex-edge ex-edge-${cls}" d="${paint}"/><path class="ex-edge ex-edge-${cls}" d="M${a.x},${a.y} L${b.x},${b.y}" marker-end="url(#arrow-${cls})"/>`);
    } else svg.push(`<path class="ex-edge ex-edge-${cls}" d="${path}" marker-end="url(#arrow-${cls})"/>`);
  }
  for (const p of graph.boxes) {
    const cls = p.status === 'modified' ? 'chg' : p.status === 'new' ? 'new' : 'same';
    const title = p.titleLines.map((text, i) => `<text class="ex-title" x="${p.x + 10}" y="${p.y + 31 + i * 19}">${esc(text)}</text>`).join('');
    const subs = p.subLines.map((text, i) => `<text class="ex-sub" x="${p.x + 10}" y="${p.y + 31 + p.titleLines.length * 19 + i * 15}">${esc(text)}</text>`).join('');
    svg.push(`<g data-map-node="${p.id}"><rect class="ex-node ex-node-${cls}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="9"/>${title}<text class="ex-tag ex-tag-${cls}" x="${p.x + p.w - 8}" y="${p.y + 13}" text-anchor="end">${tag[p.status]}</text>${subs}</g>`);
  }
  for (const edge of graph.edges) svg.push(`<g><rect class="ex-label-bg" x="${edge.label.x}" y="${edge.label.y}" width="${edge.label.w}" height="${edge.label.h}" rx="4"/><text class="ex-edge-label" x="${edge.label.x + edge.label.w / 2}" y="${edge.label.y + 13}" text-anchor="middle">${edge.text}</text></g>`);
  svg.push('</svg>');
  const screen = selected.find(n => n.kind === 'screen');
  const screenBox = screen ? positions.get(screen.id) : null;
  const mapShot = evidence.mapImage && screenBox ? `<img class="ex-mapshot" src="${esc(imagePath(prepared.workspace, evidence.mapImage))}" alt="画面で確かめた表示" style="left:${((screenBox.x + 10) / width * 100).toFixed(3)}%;top:${((screenBox.y + screenBox.h - 84) / height * 100).toFixed(3)}%;width:${((screenBox.w - 20) / width * 100).toFixed(3)}%;height:${(74 / height * 100).toFixed(3)}%;object-fit:contain">` : '';
  const hits = graph.boxes.map(p => `<details class="ex-hit" name="ex-panel" data-node-id="${p.id}" style="left:${(p.x / width * 100).toFixed(3)}%;top:${(p.y / height * 100).toFixed(3)}%;width:${(p.w / width * 100).toFixed(3)}%;height:${(p.h / height * 100).toFixed(3)}%"><summary aria-label="${esc(p.title)}の中身を右に表示"></summary>${nodePanel(p)}</details>`).join('');
  const foldedPanels = selected.filter(n => graph.helperIds.includes(n.id)).map(n => `<details class="ex-hit-inline" name="ex-panel" data-node-id="${n.id}"><summary>${esc(n.title)}の中身</summary>${nodePanel(n)}</details>`).join('・');
  const offMap = draft.offMap.map(item => {
    const count = item.hunkIds.flatMap(id => hunks.get(id).lines).filter(line => line.kind === 'add' || line.kind === 'delete').length;
    return `<details class="ex-hit-inline" name="ex-panel"><summary>${esc(item.title)} ${count}行</summary>${offMapPanel(item)}</details>`;
  }).join('・');
  const concerns = draft.concerns.map(c => `<li><details class="ex-hit-inline" name="ex-panel"><summary>${esc(c.text)}</summary>${concernPanel(c)}</details></li>`).join('');
  const pictures = (evidence.images ?? []).map(item => ({ ...item, src: imagePath(prepared.workspace, item.path) }));
  const picture = item => `<div><div class="ex-seq__label">${esc(item.caption)}</div><img src="${esc(item.src)}" alt="${esc(item.alt)}"></div>`;
  const comparison = pictures.filter(item => item.role === 'before' || item.role === 'after');
  const sequence = pictures.filter(item => item.role === 'sequence');
  const otherImages = pictures.filter(item => !['before', 'after', 'sequence'].includes(item.role));
  const images = `${comparison.length ? `<figure class="ex-compare"><div class="ex-compare__row">${comparison.map(picture).join('')}</div><figcaption>変更前後の画面</figcaption></figure>` : ''}${sequence.length ? `<figure class="ex-seq"><div class="ex-seq__row">${sequence.map(picture).join('')}</div><figcaption>作業を終えてから再読み込みするまでの画面</figcaption></figure>` : ''}${otherImages.map(item => `<figure><img src="${esc(item.src)}" alt="${esc(item.alt)}"><figcaption>${esc(item.caption)}</figcaption></figure>`).join('')}`;
  const t = evidence.tests ?? {}, tests = `<details><summary>自動テスト ${Number(t.pass)}/${Number(t.total)}件 成功(終了コード ${Number(t.exitCode)})</summary><p>${esc(t.command ?? '')}</p><pre class="ex-diff">${esc(t.output ?? '')}</pre></details>`;
  const style = readFileSync(resolve(fileURLToPath(new URL('.', import.meta.url)), 'style.css'), 'utf8');
  const selectedFiles = new Set(selected.map(n => n.file));
  const newFunctions = prepared.map.nodes.filter(n => n.kind === 'function' && n.status === 'new' && selectedFiles.has(n.file)).length;
  const modifiedProcessing = selected.filter(n => n.kind === 'function' && n.status === 'modified').length
    + selected.filter(n => n.kind === 'entry' && n.status !== 'new' && n.symbol !== 'page load' && draft.edges.some(id => edges.get(id).from === n.id && edges.get(id).status === 'new')).length;
  const assigned = new Set([...draft.nodes.flatMap(n => n.hunkIds), ...draft.offMap.flatMap(item => item.hunkIds)]);
  const unassignedHunks = prepared.hunks.filter(h => !assigned.has(h.id)).length;
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${style}</style></head><body>
<p class="ex-lead">${esc(draft.lead)}</p>
<figure class="ex-mapfig"><div class="ex-mapviewport"><div class="ex-mapbox">${svg.join('')}${mapShot}${hits}</div></div><figcaption>入口から処理、保存先・画面への流れ。部品を押すと根拠のコードが右に出ます。</figcaption></figure>
<p class="ex-legend">実線と「新規」は追加、破線と「変更」は既存への変更、点線の矢印は既存の呼び出しです。矢印 ${graph.edges.length}本・箱の説明に畳んだ呼び出し ${graph.folded.length}本。${graph.bridges ? '線の交差にある切れ目は、つながらずに通り越すことを示します。' : ''}</p>
<div class="ex-tally">新しい関数 ${newFunctions} ・ 手を入れた既存の処理 ${modifiedProcessing} ・ 補助の処理 ${foldedPanels || 'なし'} ・ 地図に載らない変更 ${offMap || 'なし'} ・ 割り当てのない差分 ${unassignedHunks}件</div>
<h2>依頼と、エージェントが足した解釈</h2><p class="ex-request">${esc(request)}</p><table class="ex-interp"><tr><th>補った判断</th><th>確かめ方</th></tr>${draft.interpretations.map(r => `<tr><td>${esc(r.decision)}</td><td>${esc(r.evidence)}</td></tr>`).join('')}</table>
<h2>画面で確かめた結果</h2>${images || '<p>画面の画像はありません。</p>'}
<h2>懸念点</h2><ol class="ex-points">${concerns}</ol>
${tests}<details><summary>まだ確かめていないこと ${draft.unverified.length}件</summary><ul>${draft.unverified.map(v => `<li>${esc(v)}</li>`).join('')}</ul></details></body></html>`;
  return { html, drawnEdges: graph.edges.map(e => e.id), foldedEdges: graph.folded.map(e => e.id), unassignedHunks, panelCount: graph.boxes.length + graph.helperIds.length, geometry: graph };
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const reasons = validate(input.prepared, input.draft);
  if (typeof input.request !== 'string' || !input.request.trim() || input.request.length > 4000) reasons.push('元の依頼文を request に渡してください。');
  if (reasons.length) emit({ ok: false, reasons });
  else emit({ ok: true, ...render(input.prepared, input.draft, input.evidence ?? {}, input.request) });
} catch (error) { emit({ ok: false, reasons: [`組み立てに失敗しました: ${error.message}`] }); }
