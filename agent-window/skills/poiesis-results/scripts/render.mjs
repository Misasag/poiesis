import { readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
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
const verificationStatus = { pass: '確認済み', fail: '失敗', unknown: '未確認', outdated: '以前の結果', human: '人の確認待ち' };
const safePath = (workspace, path) => {
  if (typeof path !== 'string' || /^(?:[a-z]+:|\/\/)/i.test(path)) return null;
  const full = resolve(workspace, path);
  const rel = relative(workspace, full);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? full : null;
};
const imagePath = (workspace, path, budget) => {
  const full = safePath(workspace, path);
  if (!full) return { omitted: true, reason: '画像の場所を確認できません。', path: null };
  let actual, root, data;
  try { actual = realpathSync(full); root = realpathSync(workspace); data = readFileSync(actual); }
  catch { return { omitted: true, reason: '画像を読み込めません。', path }; }
  const rel = relative(root, actual);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { omitted: true, reason: '画像の場所を確認できません。', path: null };
  if (data.length > 2 * 1024 * 1024 || budget.used + data.length > 6 * 1024 * 1024)
    return { omitted: true, reason: '画像が大きすぎるため省略しました。', path: rel.replace(/\\/g, '/') };
  const mime = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
    : data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9 ? 'image/jpeg'
    : data.toString('ascii', 0, 6) === 'GIF87a' || data.toString('ascii', 0, 6) === 'GIF89a' ? 'image/gif'
    : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (!mime) return { omitted: true, reason: '画像の形式を確認できません。', path: rel.replace(/\\/g, '/') };
  budget.used += data.length;
  return { src: `data:${mime};base64,${data.toString('base64')}`, path: rel.replace(/\\/g, '/') };
};

function validate(prepared, draft, imagePaths = []) {
  const reasons = [];
  if (!prepared?.ok || !Array.isArray(prepared?.map?.nodes) || !Array.isArray(prepared?.map?.edges) || !Array.isArray(prepared?.hunks)) return ['準備の出力がありません。準備をやり直してください。'];
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return ['JSON の本文をオブジェクトとして書き直してください。'];
  onlyKeys(draft, ['lead', 'mapCaption', 'nodes', 'edges', 'offMap', 'screenImage', 'interpretations', 'concerns', 'unverified'], 'JSON の本文', reasons);
  oneSentence(draft.lead, '冒頭', reasons);
  if (prepared.map.nodes.length && list(draft.nodes).length) oneSentence(draft.mapCaption, '地図の説明', reasons);
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
  if (!Array.isArray(draft.nodes) || (prepared.hunks.length && prepared.map.nodes.length && !draft.nodes.length)) reasons.push('描く部品を nodes に選んでください。');
  const selected = new Set();
  for (const item of list(draft.nodes)) {
    onlyKeys(item, ['id', 'title', 'caption', 'hunkIds'], '部品', reasons);
    if (!nodes.has(item?.id)) reasons.push(`候補にない部品 ${item?.id ?? '(ID なし)'} を選んでいます。準備の候補から選び直してください。`);
    if (selected.has(item?.id)) reasons.push(`部品 ${item?.id ?? '(ID なし)'} が重複しています。`);
    selected.add(item?.id);
    plain(item?.title, '部品の日本語名', reasons); oneSentence(item?.caption, `部品 ${item?.id ?? '(ID なし)'} の説明`, reasons);
    for (const id of list(item?.hunkIds)) if (prepared.skipped?.includes(hunks.get(id)?.file))
      reasons.push(`地図で解析しないファイル ${hunks.get(id).file} の変更は、ファイルごとの説明へ割り当ててください。`);
    assign(item?.hunkIds, `部品 ${item?.id ?? '(ID なし)'}`);
  }
  if (draft.screenImage !== undefined) {
    if (typeof draft.screenImage !== 'string' || !imagePaths.includes(draft.screenImage.replaceAll('\\', '/')))
      reasons.push('screenImage は input.json の images か確認の表の画像の path から1つ選んでください。画像がなければこの項目を書きません。');
    else if (!list(draft.nodes).some(item => nodes.get(item?.id)?.kind === 'screen'))
      reasons.push('screenImage を使うときは、画面の部品を nodes に選んでください。');
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
    const files = new Set(list(item?.hunkIds).map(id => hunks.get(id)?.file).filter(Boolean));
    if (files.size > 1 && [...files].some(file => prepared.skipped?.includes(file))) reasons.push('地図に載らないファイルは、ファイルごとの説明へ分けてください。');
    assign(item?.hunkIds, `地図に載らない変更 ${item?.title ?? '(名前なし)'}`);
  }
  const unassigned = [...hunks.keys()].filter(id => !assigned.has(id));
  if (unassigned.length) reasons.push(`割り当てのない差分の塊が ${unassigned.length} 件あります。${unassigned.join('、')} を部品か地図に載らない変更のパネルへ割り当ててください。`);
  if (!Array.isArray(draft.interpretations)) reasons.push('依頼と解釈の表を interpretations に書いてください。');
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

function render(prepared, draft, evidence, request, input) {
  const nodes = new Map(prepared.map.nodes.map(n => [n.id, n]));
  const edges = new Map(prepared.map.edges.map(e => [e.id, e]));
  const hunks = new Map(prepared.hunks.map(h => [h.id, h]));
  const selected = draft.nodes.map(item => ({ ...nodes.get(item.id), title: item.title, caption: item.caption, hunkIds: item.hunkIds }));
  const budget = { used: 0 };
  const shotEntry = draft.screenImage ? evidenceImages(evidence).find(item => item.path.replaceAll('\\', '/') === draft.screenImage.replaceAll('\\', '/')) : null;
  const mapShotImage = shotEntry && selected.some(n => n.kind === 'screen') ? imagePath(prepared.workspace, shotEntry.path, budget) : null;
  const graph = layoutGraph(selected, draft.edges.map(id => edges.get(id)), { screenImage: Boolean(mapShotImage?.src) });
  const { width, height } = graph;
  const positions = new Map(graph.boxes.map(box => [box.id, box]));
  const diffRows = (lines, file) => lines.map(l => `<span class="ex-l ${l.kind === 'add' ? 'ex-add' : l.kind === 'delete' ? 'ex-del' : ''}" data-diff-file="${esc(file)}" data-diff-line="${l.line}" data-diff-kind="${l.kind}"><span class="ex-n">${l.line}</span>${l.kind === 'add' ? '+' : l.kind === 'delete' ? '-' : ' '} ${esc(l.text)}</span>`).join('');
  const diffHtml = h => `<div class="ex-hunk" data-hunk-id="${esc(h.id)}"><div class="ex-diff-head">${esc(h.file)} ${h.start}${h.count > 1 ? `-${h.start + h.count - 1}` : ''}行</div><pre class="ex-diff">${diffRows(h.lines, h.file)}</pre></div>`;
  const cite = (file, start, end = start) => `${file}:${start}-${end}`;
  const panel = ({ title, caption, chunks, citation, status }) => `<div class="ex-panel" role="region" aria-label="${esc(title)}の中身"><div class="ex-panel-grip" role="separator" tabindex="0" aria-orientation="vertical" aria-label="説明欄の幅" aria-valuemin="320"></div><div class="ex-p-top"><span class="ex-p-title">${esc(title)}</span>${status ? `<span class="ex-p-tag ex-p-tag-${status === 'modified' ? 'chg' : status === 'new' ? 'new' : 'same'}">${tag[status]}</span>` : ''}</div><p class="ex-p-why">${esc(caption)}</p>${chunks || '<p>この部品に割り当てた差分はありません。</p>'}<p class="ex-p-foot"><a class="ex-p-open" href="#" data-poiesis-citation="${esc(citation)}">Code で開く</a></p><details class="ex-close"><summary>閉じる</summary></details></div>`;
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
  const mapShot = mapShotImage?.src && screenBox ? `<img class="ex-mapshot" src="${esc(mapShotImage.src)}" alt="${esc(shotEntry.label ?? '画面の画像')}" data-poiesis-image="${esc(mapShotImage.path)}" style="left:${((screenBox.x + 10) / width * 100).toFixed(3)}%;top:${((screenBox.y + screenBox.h - 84) / height * 100).toFixed(3)}%;width:${((screenBox.w - 20) / width * 100).toFixed(3)}%;height:${(74 / height * 100).toFixed(3)}%;object-fit:contain">` : '';
  const hits = graph.boxes.map(p => `<details class="ex-hit" name="ex-panel" data-node-id="${p.id}" style="left:${(p.x / width * 100).toFixed(3)}%;top:${(p.y / height * 100).toFixed(3)}%;width:${(p.w / width * 100).toFixed(3)}%;height:${(p.h / height * 100).toFixed(3)}%"><summary aria-label="${esc(p.title)}の中身を右に表示"></summary>${nodePanel(p)}</details>`).join('');
  const foldedPanels = selected.filter(n => graph.helperIds.includes(n.id)).map(n => `<details class="ex-hit-inline" name="ex-panel" data-node-id="${n.id}"><summary>${esc(n.title)}</summary>${nodePanel(n)}</details>`).join('・');
  const offMap = draft.offMap.map(item => {
    const count = item.hunkIds.flatMap(id => hunks.get(id).lines).filter(line => line.kind === 'add' || line.kind === 'delete').length;
    return `<details class="ex-hit-inline" name="ex-panel"><summary>${esc(item.title)} ${count}行</summary>${offMapPanel(item)}</details>`;
  }).join('・');
  const concerns = draft.concerns.map(c => `<li><details class="ex-hit-inline" name="ex-panel"><summary>${esc(c.text)}</summary>${concernPanel(c)}</details></li>`).join('');
  const imageEntries = evidenceImages(evidence);
  const pictures = imageEntries.map(item => ({ ...item, data: imagePath(prepared.workspace, item.path, budget) }));
  const picture = item => item.data.src
    ? `<figure><button type="button" class="ex-image-button" data-poiesis-image="${esc(item.data.path)}"><img src="${esc(item.data.src)}" alt="${esc(item.label ?? item.path)}"></button><figcaption>${esc(item.label ?? item.path)}</figcaption></figure>`
    : `<p>${esc(item.data.reason)} ${item.data.path ? `<button type="button" data-poiesis-image="${esc(item.data.path)}">${esc(item.data.path)}</button>` : esc(item.path)}</p>`;
  const images = pictures.map(picture).join('');
  const verification = evidence.verification ?? { rows: [] };
  const verificationHtml = `<details><summary>確認結果${verification.summary ? ` ${esc(verification.summary)}` : ''}</summary><ul class="ex-testlist">${(verification.rows ?? []).map(row => `<li><strong>${esc(verificationStatus[row.status] ?? '未確認')}</strong> ${esc(row.label)}${row.detail ? `：${esc(row.detail)}` : ''}</li>`).join('')}</ul></details>`;
  const style = readFileSync(fileURLToPath(new URL('../assets/style.css', import.meta.url)), 'utf8');
  const script = readFileSync(fileURLToPath(new URL('../assets/document.js', import.meta.url)), 'utf8');
  const selectedFiles = new Set(selected.map(n => n.file));
  const newFunctions = prepared.map.nodes.filter(n => n.kind === 'function' && n.status === 'new' && selectedFiles.has(n.file)).length;
  const modifiedProcessing = selected.filter(n => n.kind === 'function' && n.status === 'modified').length
    + selected.filter(n => n.kind === 'entry' && n.status !== 'new' && n.symbol !== 'page load' && draft.edges.some(id => edges.get(id).from === n.id && edges.get(id).status === 'new')).length;
  const assigned = new Set([...draft.nodes.flatMap(n => n.hunkIds), ...draft.offMap.flatMap(item => item.hunkIds)]);
  const unassignedHunks = prepared.hunks.filter(h => !assigned.has(h.id)).length;
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${style}</style></head><body>
<p class="ex-lead">${esc(draft.lead)}</p>
${input.task?.status === 'failed' ? '<p>作業を完了できませんでした。</p>' : input.task?.status === 'cancelled' ? '<p>作業は取り消されました。</p>' : ''}
<figure class="ex-mapfig"><div class="ex-mapviewport"><div class="ex-mapbox">${svg.join('')}${mapShot}${hits}</div></div><figcaption>${esc(draft.mapCaption)}</figcaption></figure>
<p class="ex-legend">部品を押すと、変更の根拠を右に表示します。</p>
<p class="ex-legend">実線と「新規」は追加、破線と「変更」は既存への変更、点線の矢印は既存の呼び出しです。矢印の数字は呼び出している行です。${graph.folded.length ? `補助の処理の呼び出し ${graph.folded.length}か所は、矢印にせず呼び出す側の箱の中に書いています。` : ''}${graph.bridges ? '線の交差にある切れ目は、つながらずに通り越すことを示します。' : ''}</p>
<div class="ex-tally">新しい関数 ${newFunctions} ・ 手を入れた既存の処理 ${modifiedProcessing} ・ 補助の処理 ${foldedPanels || 'なし'} ・ 地図に載らない変更 ${offMap || 'なし'} ・ 割り当てのない差分 ${unassignedHunks}件</div>
<h2>依頼と判断</h2><p class="ex-request">${esc(request)}</p><table class="ex-interp"><tr><th>補った判断</th><th>確かめ方</th></tr>${draft.interpretations.map(r => `<tr><td>${esc(r.decision)}</td><td>${esc(r.evidence)}</td></tr>`).join('')}</table>
${input.requirement ? `<h2>関連する作業</h2><ul>${(input.requirement.tasks ?? []).map(task => `<li>${esc(task.title)}：${esc(task.completionSummary || task.failureSummary || '確認中')}</li>`).join('')}</ul>` : ''}
${images ? `<h2>画像</h2>${images}` : ''}
<h2>懸念点</h2><ol class="ex-points">${concerns}</ol>
${verificationHtml}<details><summary>まだ確かめていないこと ${draft.unverified.length}件</summary><ul>${draft.unverified.map(v => `<li>${esc(v)}</li>`).join('')}</ul></details><script>${script}</script></body></html>`;
  return { html, drawnEdges: graph.edges.map(e => e.id), foldedEdges: graph.folded.map(e => e.id), unassignedHunks, panelCount: graph.boxes.length + graph.helperIds.length, geometry: graph };
}

// The app also lists verification images in input.images; show each file once.
const uniqueImages = items => [...new Map(items.filter(item => typeof item?.path === 'string')
  .map(item => [item.path.replaceAll('\\', '/'), item])).values()];
const evidenceImages = evidence => uniqueImages([...(evidence.images ?? []), ...(evidence.verification?.rows ?? []).filter(row => row.image).map(row => ({ path: row.image, label: row.label }))]);

const readJson = (name) => {
  const bytes = readFileSync(resolve(process.cwd(), name));
  if (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff || bytes.includes(0))
    throw new Error(`${name} が UTF-16 です。UTF-8 で書き直してください。`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { throw new Error(`${name} に読めないバイト列があります。UTF-8 で書き直してください。`); }
  if (text.includes('\uFFFD')) throw new Error(`${name} に壊れた文字があります。UTF-8 で書き直してください。`);
  return JSON.parse(text);
};

try {
  rmSync(resolve(process.cwd(), 'results.html'), { force: true });
  const input = readJson('input.json'), prepared = readJson('prepared.json'), draft = readJson('draft.json');
  const reasons = validate(prepared, draft, evidenceImages({ images: input.images, verification: input.verification }).map(item => item.path.replaceAll('\\', '/')));
  if (input.schema !== 'poiesis-results-input/1') reasons.push('入力の形式が違います。');
  if (reasons.length) emit({ ok: false, reasons });
  else {
    const evidence = { images: input.images, verification: input.verification };
    let result;
    if (!draft.nodes.length) {
      const style = readFileSync(fileURLToPath(new URL('../assets/style.css', import.meta.url)), 'utf8');
      const script = readFileSync(fileURLToPath(new URL('../assets/document.js', import.meta.url)), 'utf8');
      const state = input.task?.status === 'failed' ? '作業を完了できませんでした。' : input.task?.status === 'cancelled' ? '作業は取り消されました。' : '変更はありません。';
      const hunks = new Map(prepared.hunks.map(hunk => [hunk.id, hunk]));
      const offMap = draft.offMap.map(item => {
        const first = hunks.get(item.hunkIds[0]);
        const source = first ? `${first.file}:${first.start}-${first.start + Math.max(0, first.count - 1)}` : '';
        const parts = item.hunkIds.map(id => hunks.get(id)).filter(Boolean).map(hunk => `<div class="ex-diff-head">${esc(hunk.file)}</div><pre class="ex-diff">${hunk.lines.map(line => `${line.kind === 'add' ? '+' : '-'} ${esc(line.text)}`).join('\n')}</pre>`).join('');
        return `<details class="ex-hit-inline"><summary>${esc(item.title)}</summary><div class="ex-panel" role="region"><div class="ex-panel-grip" role="separator" tabindex="0" aria-label="説明欄の幅"></div><h3>${esc(item.title)}</h3><p>${esc(item.caption)}</p>${parts}<p><a href="#" data-poiesis-citation="${esc(source)}">Code で開く</a></p><details class="ex-close"><summary>閉じる</summary></details></div></details>`;
      }).join('・');
      const budget = { used: 0 };
      const images = uniqueImages([...(input.images ?? []), ...(input.verification?.rows ?? []).filter(row => row.image).map(row => ({ path: row.image, label: row.label }))]).map(item => {
        const image = imagePath(input.workspace, item.path, budget);
        return image.src ? `<figure><button type="button" data-poiesis-image="${esc(image.path)}"><img src="${esc(image.src)}" alt="${esc(item.label ?? item.path)}"></button><figcaption>${esc(item.label ?? item.path)}</figcaption></figure>`
          : `<p>${esc(image.reason)} ${image.path ? `<button type="button" data-poiesis-image="${esc(image.path)}">${esc(image.path)}</button>` : esc(item.path)}</p>`;
      }).join('');
      const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${style}</style></head><body><p class="ex-lead">${esc(input.task?.status === 'completed' ? draft.lead : state)}</p><h2>作業内容</h2><p>${esc(input.task?.status === 'completed' ? input.task?.completionSummary || state : input.task?.failureSummary || state)}</p>${offMap ? `<h2>変更の詳細</h2><div class="ex-tally">${offMap}</div>` : ''}${input.requirement ? `<h2>関連する作業</h2><ul>${(input.requirement.tasks ?? []).map(task => `<li>${esc(task.title)}：${esc(task.completionSummary || task.failureSummary || '確認中')}</li>`).join('')}</ul>` : ''}${images ? `<h2>画像</h2>${images}` : ''}<h2>確認結果</h2><p>${esc(input.verification?.summary || '確認結果はありません。')}</p><ul>${(input.verification?.rows ?? []).map(row => `<li><strong>${esc(verificationStatus[row.status] ?? '未確認')}</strong> ${esc(row.label)}：${esc(row.detail || '詳細なし')}</li>`).join('')}</ul><script>${script}</script></body></html>`;
      result = { html, drawnEdges: [], foldedEdges: [], unassignedHunks: 0, panelCount: 0, geometry: { boxes: [], edges: [], columns: [], width: 0, height: 0 } };
    } else result = render(prepared, draft, evidence, input.task?.request ?? '', input);
    const bytes = Buffer.byteLength(result.html, 'utf8');
    if (bytes > 8 * 1024 * 1024) emit({ ok: false, reasons: [`文書が8 MiBを超えました (${bytes} bytes)。画像や本文を減らしてください。`] });
    else {
      writeFileSync(resolve(process.cwd(), 'results.html'), result.html, 'utf8');
      emit({ ok: true, output: 'results.html', bytes, drawnEdges: result.drawnEdges, foldedEdges: result.foldedEdges, unassignedHunks: result.unassignedHunks, panelCount: result.panelCount, geometry: result.geometry });
    }
  }
} catch (error) { emit({ ok: false, reasons: [`組み立てに失敗しました: ${error.message}`] }); }
