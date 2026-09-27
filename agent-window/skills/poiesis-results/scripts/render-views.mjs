const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const numeral = index => ['①', '②', '③', '④', '⑤'][index] ?? String(index + 1);
const cite = (file, line, label = `${line}行 Code で開く`) => file && Number.isInteger(line)
  ? `<a href="#" data-poiesis-citation="${esc(`${file}:${line}-${line}`)}">${esc(label)}</a>` : '';
const section = (kind, number, title, before, body, after, omissions = []) =>
  `<section class="ex-view ex-view-${kind}" data-view="${kind}"><h2>図${number}　${esc(title)}</h2><p>${esc(before)}</p>${body}` +
  `<p class="ex-ai-text">${esc(after)}</p><p class="ex-view-provenance">部品と線はコードから取り出したもの、名前は AI が付けたものです。` +
  `図に載せなかったもの ${omissions.length}件${omissions.length ? `：${omissions.map(item =>
    item.kind === 'folded' ? `補助の処理 ${item.line}行` : '入口から届かなかった保存の箇所').join('・')}` : ''}。</p></section>`;

function judgmentUi(prepared, draft, gallery) {
  const nodes = new Map(prepared.map.nodes.map(item => [item.id, item]));
  const edges = new Map(prepared.map.edges.map(item => [item.id, item]));
  const locate = row => {
    const edge = edges.get(row.edgeId), node = nodes.get(row.nodeId);
    return { file: node?.file ?? edge?.file, line: row.line ?? node?.line ?? edge?.line };
  };
  const facts = row => (row.tests?.length ? row.tests.map(name => `検査「${esc(name)}」：成功`).join('<br>')
    : '対応するテストは未確認');
  const badge = (row, index) => {
    const { file, line } = locate(row);
    const hunk = prepared.hunks.find(item => item.file === file && item.lines.some(item => item.line === line));
    const at = hunk?.lines.findIndex(item => item.line === line) ?? -1;
    const excerpt = at >= 0 ? hunk.lines.slice(Math.max(0, at - 2), at + 3)
      .map(item => `${item.kind === 'add' ? '+' : item.kind === 'delete' ? '-' : ' '} ${esc(item.text)}`).join('\n') : '';
    const label = numeral(index);
    const picture = row.image ? gallery.get(esc(row.image)) : null;
    const visualEvidence = picture ? `<figure class="ex-view-judgment-image"><button type="button" class="ex-image-button" data-poiesis-image="${esc(row.image)}">` +
      `<img src="${picture.src}" alt="${picture.alt}"></button><figcaption>AI が選んだ画面の画像（写っている範囲）</figcaption></figure>` : '';
    return `<details class="ex-hit-inline ex-view-judgment" name="ex-panel"><summary class="ex-view-badge ${row.tests?.length ? '' : 'ex-view-badge-unverified'}" ` +
      `${row.nodeId ? `data-badge-part="${esc(row.nodeId)}"` : `data-badge-edge="${esc(row.edgeId)}"`} aria-label="判断${index + 1}の根拠を右に表示">${label}` +
      `${row.unrequested ? '<span class="ex-view-addition">追加</span>' : ''}${row.tests?.length ? '' : '<span class="ex-view-unverified">未確認</span>'}</summary>` +
      `<div class="ex-panel" role="region" aria-label="判断${index + 1}の根拠"><div class="ex-panel-grip" role="separator" tabindex="0" aria-orientation="vertical" aria-label="説明欄の幅"></div>` +
      `<div class="ex-p-top"><span class="ex-p-title">${label} ${esc(row.decision)}</span><button type="button" class="ex-panel-close">閉じる</button></div>` +
      `${row.why ? `<p class="ex-p-why ex-ai-text">${esc(row.why)}</p>` : ''}<h3>確かめ方</h3><p>${facts(row)}</p>${visualEvidence}` +
      `<p class="ex-view-provenance">検査は AI が選び、実行の記録で成功を確かめました。</p>` +
      `<h3>差分の抜粋</h3>${excerpt ? `<pre class="ex-diff">${excerpt}</pre>` : '<p>この行の差分はありません。</p>'}` +
      `<p>${cite(file, line)}</p></div></details>`;
  };
  const onNode = id => draft.interpretations.flatMap((row, i) => row.nodeId === id ? [badge(row, i)] : []).join('');
  const onEdge = id => draft.interpretations.flatMap((row, i) => row.edgeId === id ? [badge(row, i)] : []).join('');
  const table = `<h2>補った判断 ${draft.interpretations.length}件</h2><table class="ex-interp ex-judgments"><tr><th>番号</th><th>補った判断（AI）</th>` +
    `<th>確かめ方（検査は AI が選び、実行の記録で成功を確かめたもの）</th></tr>${draft.interpretations.map((row, i) => {
      const { file, line } = locate(row);
      return `<tr><td>${numeral(i)}</td><td class="ex-ai-text">${esc(row.decision)}${row.unrequested ? ' <span class="ex-view-addition">追加</span>' : ''}</td>` +
        `<td>${cite(file, line)}・${facts(row)}</td></tr>`;
    }).join('')}</table>`;
  return { onNode, onEdge, table };
}

function stateView(prepared, draft, number, ui) {
  const machine = prepared.views.stateMachine;
  if (!prepared.views.selected.S || !machine) return '';
  const names = draft.viewNames;
  const name = value => names.stateValues[value];
  const main = machine.transitions.find(item => item.main);
  const writer = prepared.views.nodes.find(item => item.id === prepared.views.structure?.writerId);
  const writerName = draft.nodes.find(item => item.id === writer?.id)?.title;
  const mainProcess = main && writer && writerName ? `<span class="ex-state-process" data-part="${esc(writer.id)}" data-evidence="${main.throughLine}">` +
    `<strong>${esc(writerName)}</strong><small>${writer.line}–${writer.end}行</small>` +
    `${main.throughLine && names.conditions?.[main.throughLine] ? `<small>${esc(names.conditions[main.throughLine])}　${cite(writer.file, main.throughLine, `${main.throughLine}行`)}</small>` : ''}` +
    `</span>` : '';
  const binary = machine.states.length === 2;
  const stateCard = item => `<div class="ex-state-card" data-state-value="${esc(item.value)}" data-evidence="${item.line}">` +
    `<strong>${esc(name(item.value))}</strong><small>${cite(prepared.views.nodes[0]?.file, item.line, `${item.line}行`)}</small></div>`;
  const stateCards = machine.states.map(stateCard).join('');
  const transitions = machine.transitions.map(item => {
    const direction = binary && item.from.length === 1 && item.to.length === 1
      ? item.from[0] === machine.states[0].value && item.to[0] === machine.states[1].value ? 'right'
        : item.from[0] === machine.states[1].value && item.to[0] === machine.states[0].value ? 'left' : 'both'
      : 'both';
    return `<div class="ex-state-transition ${item.main ? 'ex-state-main' : ''}" ` +
    `data-transition-line="${item.line}" data-state-from="${esc(item.from.join(','))}" data-state-to="${esc(item.to.join(','))}" data-main="${item.main}" data-dynamic-target="${item.dynamicTarget}">` +
    `${binary ? `<span class="ex-state-line ex-state-line-${direction}">${item.main ? mainProcess : ''}</span>` :
      `<span>${esc(item.from.map(name).join('・'))}</span><span class="ex-state-line" aria-hidden="true"></span><span>${esc(item.to.map(name).join('・'))}</span>`}` +
    `<span class="ex-state-event">${esc(names.stateEvents[item.line])}　${cite(prepared.views.nodes[0]?.file, item.line, `${item.line}行`)}` +
    `${item.dynamicTarget ? '<span class="ex-view-dynamic-target">値は操作で決まる</span>' : ''}` +
    `${item.main ? `　${ui.onNode(prepared.views.structure?.countNodeIds?.[0])}` : `<span class="ex-view-no-count">${esc(names.nonMain)}</span>`}</span></div>`;
  }).join('');
  const entries = main?.entries.map(item => `${esc(names.entries[item.line])} ${cite(prepared.views.nodes[0]?.file, item.line, `${item.line}行`)}`).join('・') ?? '';
  return section('state', number, names.stateTitle,
    `${machine.states.map(item => name(item.value)).join('と')}の切り替えのうち、変更した処理を通るものを示します。`,
    `<div class="ex-state-diagram${binary ? ' ex-state-binary' : ''}">${binary ?
      `${stateCard(machine.states[0])}<div class="ex-state-transitions">${transitions}</div>${stateCard(machine.states[1])}`
      : `<div class="ex-state-cards">${stateCards}</div><div class="ex-state-transitions">${transitions}</div>`}</div>` +
    `<p class="ex-view-entry-note">主役の線に届く入口：${entries}</p>`, names.stateSentence, []);
}

function galleryFrom(baseHtml) {
  return new Map([...baseHtml.matchAll(/<button type="button" class="ex-image-button" data-poiesis-image="([^"]+)"><img src="([^"]+)" alt="([^"]*)"><\/button>/g)]
    .map(match => [match[1], { src: match[2], alt: match[3] }]));
}
function screenComparison(draft, gallery) {
  const screens = new Map();
  for (const item of draft.images ?? []) {
    if (!item.role) continue;
    const screen = item.screen.trim();
    if (!screens.has(screen)) screens.set(screen, {});
    screens.get(screen)[item.role] = item;
  }
  const figure = item => {
    const path = item.path.replaceAll('\\', '/'), image = gallery.get(esc(path));
    return image ? `<figure><button type="button" class="ex-image-button" data-poiesis-image="${esc(path)}"><img src="${image.src}" alt="${image.alt}"></button>` +
      `<figcaption>${esc(item.caption)}</figcaption></figure>` : '';
  };
  const missing = [...screens.values()].flatMap(pair => [
    pair.after && !pair.before ? '変更前の画面の画像がありません。' : '',
    pair.before && !pair.after ? '変更後の画面の画像がありません。' : ''
  ].filter(Boolean));
  return { html: screens.size ? `<section class="ex-screen-comparison"><h2>画面の変更</h2>` +
    [...screens].map(([screen, pair]) => `<div class="ex-screen-pair" data-screen="${esc(screen)}">${pair.before ? figure(pair.before) : ''}` +
      `${pair.before && pair.after ? '<span aria-hidden="true">→</span>' : ''}${pair.after ? figure(pair.after) : ''}</div>`).join('') + '</section>' : '',
    pairedPaths: new Set([...screens.values()].flatMap(pair => [pair.before, pair.after].filter(Boolean).map(item => item.path.replaceAll('\\', '/')))), missing };
}

function withoutPairedGallery(html, paths) {
  if (!paths.size) return html;
  return html.replace(/<details><summary>画像 \d+件<\/summary>([\s\S]*?)<\/details>/, (_, body) => {
    const figures = [...body.matchAll(/<figure>[\s\S]*?<\/figure>|<p>[\s\S]*?<\/p>/g)]
      .map(match => match[0]).filter(fragment => ![...paths].some(path => fragment.includes(`data-poiesis-image="${esc(path)}"`)));
    return figures.length ? `<details><summary>画像 ${figures.length}件</summary>${figures.join('')}</details>` : '';
  });
}

function withMissingImages(html, missing) {
  return missing.length ? html.replace(/<details><summary>まだ確かめていないこと (\d+)件<\/summary><ul>/,
    (_, count) => `<details><summary>まだ確かめていないこと ${Number(count) + missing.length}件</summary><ul>${missing.map(item => `<li>${esc(item)}</li>`).join('')}`) : html;
}

function legend() {
  const line = (kind, label) => `<span><i class="ex-legend-line ex-legend-${kind}" aria-hidden="true"></i>${label}</span>`;
  return `<div class="ex-view-legend ex-view-main-legend" aria-label="図の凡例">${line('call', '呼ぶ')}${line('storage', '保存を読む・書く')}${line('display', '画面に表示')}` +
    `<span><i class="ex-legend-entry"></i>入口（きっかけ）</span><span><i class="ex-legend-new"></i>新しく作った</span>` +
    `<span><i class="ex-legend-modified"></i>手を入れた既存</span><span>① 補った判断</span><span><b class="ex-view-addition">追加</b>依頼にない追加</span>` +
    `<span><b class="ex-view-unverified">未確認</b>確かめていない</span><span><b class="ex-view-concern">懸念1</b>懸念（並行の図）</span></div>`;
}

function renderWithoutKey(prepared, draft, base, input) {
  const views = prepared.views, names = draft.viewNames ?? {};
  const file = views.nodes[0]?.file ?? prepared.hunks[0]?.file;
  const gallery = galleryFrom(base.html);
  const ui = judgmentUi(prepared, draft, gallery), compare = screenComparison(draft, gallery);
  let number = 1;
  const state = stateView(prepared, draft, views.selected.S ? number++ : number, ui);
  const flow = views.selected.T ? section('structure', number++, names.flowTitle, '変更した処理へ届く入口と順番を示します。',
    views.groups.flatMap(group => group.entries).map(entry => `<div class="ex-view-generic-flow"><div class="ex-view-bundle">${esc(names.entries?.[entry.line])} ${cite(file, entry.line)}</div>` +
      entry.path.map(step => `<span class="ex-view-generic-step" data-evidence="${step.line}">${cite(file, step.line, `${step.line}行`)}${step.guards?.length ? '　条件あり' : ''}</span>`).join('') + '</div>').join(''), draft.mapCaption) : '';
  const data = views.selected.D && views.state.length ? section('data', number++, names.dataTitle,
    '追加した状態と読み書きする処理を示します。', `<table class="ex-interp"><tr><th>状態</th><th>書く処理</th><th>読む処理</th></tr>` +
    views.state.map(row => `<tr><td>${esc(names.states?.[row.declaredLine])}</td><td>${row.writers.map(item => cite(file, Number(item.match(/\d+$/)?.[0]))).join('、')}</td>` +
      `<td>${row.readers.map(item => cite(file, Number(item.match(/\d+$/)?.[0]))).join('、')}</td></tr>`).join('') + '</table>', names.dataSentence) : '';
  let html = base.html.replace(/<p class="ex-fact">[^<]*<\/p>\s*<figure class="ex-mapfig">[\s\S]*?<\/figure>/,
    `${compare.html}${legend()}${state}${flow}${data}`);
  html = html.replace(/<h2>依頼文<\/h2><p class="ex-request">([\s\S]*?)<\/p>/, '');
  html = html.replace(/(<p class="ex-lead ex-ai-text">[\s\S]*?<\/p>)/,
    `$1<p class="ex-request">依頼：${esc(input.task?.request ?? '')}</p>`);
  html = html.replace(/<h2>補った判断 \d+件<\/h2><table class="ex-interp">[\s\S]*?<\/table>/, ui.table);
  html = withMissingImages(withoutPairedGallery(html, compare.pairedPaths), compare.missing);
  return { html,
    views: views.selected, drawnEdges: [], foldedEdges: [], panelCount: draft.offMap.length,
    geometry: { boxes: views.nodes, edges: [], width: 0, height: 0, layerCount: 0 } };
}

export function renderViews(prepared, draft, base, input) {
  const views = prepared.views, key = views.keys[0];
  if (!key) return renderWithoutKey(prepared, draft, base, input);
  const names = draft.viewNames, structure = views.structure ?? {}, gallery = galleryFrom(base.html);
  const part = id => views.nodes.find(item => item.id === id), edge = id => prepared.map.edges.find(item => item.id === id);
  const record = part(structure.writerId), reader = part(structure.readerId), display = part(structure.displayId);
  const storage = part(structure.storageId), screen = part(structure.screenId);
  const writeEdge = edge(structure.writeEdgeId), readEdge = edge(structure.readEdgeId);
  const displayEdge = edge(structure.displayEdgeId), continuation = edge(structure.continuationId);
  const ui = judgmentUi(prepared, draft, gallery);
  const title = node => draft.nodes.find(item => item.id === node?.id)?.title ?? '';
  const card = (node, note = '', hint = '') => node ? `<div class="ex-view-card ex-part-${node.kind} ex-status-${node.status}" data-part="${esc(node.id)}" tabindex="0" role="button" aria-label="${esc(title(node))}を選ぶ">` +
    `<strong>${esc(title(node))}</strong><span class="ex-view-card-kind">${node.status === 'new' ? '新規' : node.status === 'modified' ? '変更' : '既存'}</span>` +
    `${ui.onNode(node.id)}${note ? `<small>${esc(note)}</small>` : ''}${hint ? `<span class="ex-view-hint">${esc(hint)}</span>` : ''}${cite(node.file, node.line)}</div>` : '';
  const arrow = (kind, evidence, from, to, edgeId) => `<span class="ex-view-arrow ex-view-arrow-${kind}" data-evidence="${esc(evidence ?? '')}" data-from="${esc(from?.id ?? '')}" data-to="${esc(to?.id ?? '')}">` +
    `<i class="ex-view-arrow-line" aria-hidden="true"></i><span>${kind === 'storage' ? '書く' : kind === 'display' ? '表示' : '呼ぶ'}</span>` +
    `${Number.isInteger(evidence) ? `<small>${evidence}行</small>` : ''}${edgeId ? ui.onEdge(edgeId) : ''}` +
    `${kind === 'storage' && views.selected.C ? '<a class="ex-view-concern" href="#ex-race-view">懸念1</a>' : ''}</span>`;
  const entryName = entry => names.entries?.[entry.line] ?? '';
  const bundle = group => group ? `<div class="ex-view-bundle"><strong>${esc(names[group.kind])}</strong><ul>${group.entries.map(item => {
    const node = prepared.map.nodes.find(candidate => candidate.kind === 'entry' && candidate.file === item.file && candidate.line === item.line);
    const actionLine = item.actionLine ?? item.line;
    const status = node?.status ?? 'existing';
    return `<li class="ex-view-entry ex-status-${status}" data-entry-line="${item.line}" data-action-line="${actionLine}">` +
      `${cite(item.file, actionLine, entryName(item))} ${node ? ui.onNode(node.id) : ''}` +
      `<small>${status === 'new' ? '新しく作った' : status === 'modified' ? '手を入れた既存' : '既存'}　${actionLine}行</small></li>`;
  }).join('')}</ul></div>` : '';
  const compare = screenComparison(draft, gallery);
  const availableScreens = [...(input.images ?? []), ...(draft.images ?? []).map(item => ({ path: item.path, label: item.caption }))];
  const selectedImage = availableScreens.find(item => item.path?.replaceAll('\\', '/') === draft.screenImage?.replaceAll('\\', '/'));
  const family = selectedImage?.label?.split(/[：:]/)[0];
  const screenShots = (family ? availableScreens.filter(item => item.label?.split(/[：:]/)[0] === family).slice(0, 3) : selectedImage ? [selectedImage] : [])
    .map(item => { const path = item.path.replaceAll('\\', '/'), image = gallery.get(esc(path)); return image ? `<figure class="ex-view-shot"><img class="ex-view-screen" src="${image.src}" alt="${image.alt}" data-poiesis-image="${esc(path)}">` +
      `<figcaption>${esc(item.label?.split(/[：:]/).slice(1).join('：') || item.label)}</figcaption></figure>` : ''; }).join('');
  let number = 1;
  const state = stateView(prepared, draft, views.selected.S ? number++ : number, ui);
  const count = views.groups.find(item => item.kind === 'count'), refresh = views.groups.find(item => item.kind === 'refresh');
  const steps = views.steps.map(step => `<li data-step="${step.number}" data-evidence="${step.line}"><span>${esc(step.number)}　${step.kind === 'date' ? '日付を決める' : step.kind === 'read' ? '今の値を読む' : step.kind === 'write' ? '保存に書く' : '表示を読み直す'}</span>` +
    `${step.kind === 'date' ? `（${esc(names.origins?.[step.line])}）` : ''} <small>${step.line}行</small></li>`).join('');
  const recordCard = record ? `<div class="ex-view-card ex-part-function ex-status-${record.status} ex-view-record" data-part="${esc(record.id)}" tabindex="0" role="button" aria-label="${esc(title(record))}を選ぶ">` +
    `<strong>${esc(title(record))}</strong><span class="ex-view-card-kind">${record.status === 'new' ? '新規' : record.status === 'modified' ? '変更' : '既存'}</span>${ui.onNode(record.id)}<ol class="ex-view-steps">${steps}</ol>${cite(record.file, record.line)}</div>` : '';
  const writeOrigin = (structure.originEdges ?? []).map(edge).find(item => item?.from === record?.id);
  const displayOrigin = (structure.originEdges ?? []).map(edge).find(item => item?.from === display?.id);
  const flow = views.selected.T || views.selected.M ? section('structure', number++, names.flowTitle,
    `${esc(title(display))}へ届く入口と、保存する処理の順番を示します。`,
    `<div class="ex-view-structure-scroll"><div class="ex-view-structure"><div class="ex-view-flow">` +
      `${count ? `<div class="ex-view-from-state">${views.selected.S ? '状態の図の主役の線から' : bundle(count)}</div>` : ''}` +
      `${recordCard}${storage ? `${arrow('storage', writeEdge?.line, record, storage, writeEdge?.id)}${card(storage, `${writeEdge?.line ?? ''}行`, views.selected.D ? `選ぶと図${number} 保存の形` : '')}` : ''}</div>` +
      `${refresh ? '<div class="ex-view-link-gap" aria-hidden="true"></div>' : ''}` +
      `${refresh ? `<div class="ex-view-flow">${bundle(refresh)}${arrow('call', refresh.entries.map(item => item.line).join(','), null, display)}${card(display, displayOrigin ? `${names.origins?.[displayOrigin.line]}　${displayOrigin.line}行` : '')}` +
      `${screen ? `${arrow('display', displayEdge?.line, display, screen, displayEdge?.id)}<div class="ex-view-screen-pair">${card(screen)}<div class="ex-view-screen-list">${screenShots}</div></div>` : ''}</div>` : ''}` +
      `<svg class="ex-view-link-layer" aria-hidden="true"><defs><marker id="ex-view-call-head" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8"/></marker>` +
      `<marker id="ex-view-read-head" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8"/></marker></defs>` +
      `${continuation && display ? `<g class="ex-view-link ex-view-link-call" data-evidence="${continuation.line}" data-from="${esc(record.id)}" data-to="${esc(display.id)}" data-verb="呼ぶ"><path marker-end="url(#ex-view-call-head)"/><rect/><text>呼ぶ <tspan>${continuation.line}行</tspan></text></g>` : ''}` +
      `${readEdge && display ? `<g class="ex-view-link ex-view-link-read" data-evidence="${readEdge.line}" data-from="${esc(storage.id)}" data-to="${esc(display.id)}" data-verb="読む"><path marker-end="url(#ex-view-read-head)"/><rect/><text>読む <tspan>${readEdge.line}行</tspan></text></g>` : ''}</svg></div></div>`,
    draft.mapCaption, views.omissions) : '';
  // Each key example uses the captured shape and dates computed from the task's completion day.
  const keyName = names.key;
  let partIndex = 0;
  const namedShape = key.shape.replace(/\{[^}]+\}/g, () => `{${names.keyParts?.[String(partIndex++)] ?? ''}}`);
  const example = day => key.shape.replace(/\{[^}]+\}/g, day);
  const memory = views.state.find(item => item.declaredLine === key.facts?.memoryLine);
  const siteCells = sites => sites.map(site => {
    const line = Number(site.match(/\d+$/)?.[0]), symbol = site.replace(/ \d+$/, '');
    const node = views.nodes.find(item => item.symbol === symbol);
    return cite(node?.file ?? storage?.file, line, `${title(node)} ${line}行`);
  }).join('<br>') || '—';
  const entryCells = entries => entries.map(name => { const item = views.groups.flatMap(group => group.entries).find(entry => entry.entry === name);
    return item ? cite(item.file, item.line, `${entryName(item)} ${item.line}行`) : ''; }).filter(Boolean).join('<br>') || '—';
  const rows = views.keys.map(item => `<tr><td>${esc(keyName)}：${esc(namedShape)}</td><td>${siteCells(item.writers)}</td><td>${siteCells(item.readers)}</td>` +
    `<td>${entryCells(item.writeEntries)}</td><td>${entryCells(item.readEntries)}</td></tr>`).join('') +
    views.state.map(item => `<tr><td>${esc(names.states?.[item.declaredLine])} ${cite(storage?.file, item.declaredLine, `${item.declaredLine}行`)}</td>` +
      `<td>${siteCells(item.writers)}</td><td>${siteCells(item.readers)}</td><td>—</td><td>—</td></tr>`).join('');
  const boundary = views.boundary;
  const keyExamples = boundary?.previousDate && boundary?.completedDate ? `<div class="ex-view-key-examples" data-key-dates="${esc(boundary.previousDate)},${esc(boundary.completedDate)}">` +
    `<div>${esc(example(boundary.previousDate))} <small>前の日。${key.facts.noDelete ? '消さない' : '削除の有無は未確認'}</small></div>` +
    `<div>${esc(example(boundary.completedDate))} <small>完了日（例の値）</small></div></div>` : '';
  const origins = writeOrigin && displayOrigin ? `<div class="ex-view-origins" data-write-origin="${writeOrigin.line}" data-display-origin="${displayOrigin.line}">` +
    `<div class="ex-view-origin"><strong>保存するとき</strong><span>${esc(names.origins?.[writeOrigin.line])} ${cite(writeOrigin.file, writeOrigin.line, `${writeOrigin.line}行`)}${ui.onNode(record?.id)}</span><i class="ex-view-origin-line" aria-hidden="true"></i><span>${esc(keyName)}</span></div>` +
    `<div class="ex-view-origin"><strong>表示するとき</strong><span>${esc(names.origins?.[displayOrigin.line])} ${cite(displayOrigin.file, displayOrigin.line, `${displayOrigin.line}行`)}</span><i class="ex-view-origin-line" aria-hidden="true"></i><span>${esc(keyName)}</span></div></div>` : '';
  const caughtAt = [cite(reader?.file, key.facts?.readCatchLine, `${key.facts?.readCatchLine}行`),
    cite(record?.file, key.facts?.saveCatchLine, `${key.facts?.saveCatchLine}行`)].filter(Boolean).join('・');
  const broken = key.facts?.saveCatchLine || key.facts?.readCatchLine ? `<div class="ex-view-broken" data-read-catch="${key.facts.readCatchLine ?? ''}" data-write-catch="${key.facts.saveCatchLine ?? ''}">` +
    `<strong>保存できないとき</strong><div><span>${esc(names.states?.[memory?.declaredLine] ?? keyName)}</span><i class="ex-view-broken-line" aria-hidden="true"></i>` +
    `<span>${esc(title(storage))}</span></div><small>読み書きの失敗を受ける箇所　${caughtAt}</small></div>` : '';
  const data = views.selected.D ? section('data', number++, names.dataTitle,
    '保存のキーと、値を読み書きする処理と、日付の出どころを示します。',
    `<div class="ex-view-data">${memory ? `<div class="ex-view-card ex-part-state" data-part="${esc(memory.name)}"><strong>${esc(names.states?.[memory.declaredLine])}</strong><small>${memory.declaredLine}行</small></div>` : ''}` +
    `<div class="ex-view-transfer">${reader ? `<div>${card(reader)}<span>← 読む　${readEdge?.line}行</span><small>${key.facts.maxLine ? `大きい方　${key.facts.maxLine}行` : ''}${key.facts.invalidLine ? `・壊れた値は無視　${key.facts.invalidLine}行` : ''}</small></div>` : ''}` +
    `${record ? `<div>${card(record)}<span>→ 書く　${writeEdge?.line}行</span><small>${key.facts.incrementLine ? `+1　${key.facts.incrementLine}行` : ''}</small></div>` : ''}</div>` +
    `${card(storage, `${keyName}：${namedShape}`)}</div>${keyExamples}` +
    `<div class="ex-view-data-table"><table class="ex-interp"><tr><th>保存先・状態</th><th>書く処理</th><th>読む処理</th><th>書く入口</th><th>読む入口</th></tr>${rows}</table></div>` +
    `${origins}${broken}<div class="ex-view-facts">${key.facts.noDelete ? '<span>古い日は消さない</span>' : ''}</div>`,
    names.dataSentence).replace('<section class="ex-view ex-view-data" data-view="data"',
      `<section class="ex-view ex-view-data${flow ? '' : ' ex-view-visible'}" data-view="data" data-storage-part="${esc(storage?.id)}"`) : '';
  const race = views.race;
  const oldValue = race?.increment ? 3 : 'n', newValue = race?.increment ? 4 : 'f(n)';
  const points = race ? [['タブA', '読む', oldValue, readEdge?.line], ['タブB', '読む', oldValue, readEdge?.line],
    ['タブA', '書く', newValue, writeEdge?.line], ['タブB', '書く', newValue, writeEdge?.line]] : [];
  const raceRows = points.map(([lane, verb, value, line], i) => {
    const direction = lane === 'タブA' ? verb === '読む' ? '←' : '→' : verb === '読む' ? '→' : '←';
    return `<div class="ex-view-race-row" data-point="${i + 1}" data-evidence="${line}" data-lane="${lane}" data-direction="${direction}">` +
      `<span>${lane === 'タブA' ? `${i + 1}. ${verb} ${value}` : ''}</span><span>${direction} ${verb}　${cite(verb === '読む' ? reader?.file : record?.file, line, `${line}行`)}` +
      `${i === 3 ? '<a class="ex-view-concern" href="#ex-race-view">懸念1</a>' : ''}</span><span>${lane === 'タブB' ? `${i + 1}. ${verb} ${value}` : ''}</span></div>`;
  }).join('');
  const raceEntries = (race?.entries ?? []).map(item => {
    const entry = count?.entries.find(candidate => candidate.entry === item.entry);
    const path = [...item.path.matchAll(/@(\d+)/g)].map(match => `${match[1]}行`).join(' → ');
    return entry ? `<li>${cite(entry.file, entry.line, `${entryName(entry)} ${entry.line}行`)} → ${esc(path)} → 書く ${writeEdge?.line}行</li>` : '';
  }).join('');
  const date = boundary ? `<div class="ex-view-date-boundary" data-write-origin="${boundary.writeOriginLine}" data-display-origin="${boundary.displayOriginLine}">` +
    `<h3>日付の境目</h3><div class="ex-view-date-axis"><span>${esc(boundary.previousDate)} 23:59</span><i aria-label="日付の境目"></i><span>${esc(boundary.completedDate)} 0:00</span></div>` +
    `<div class="ex-view-date-timeline"><div class="ex-view-date-marker" aria-hidden="true"></div>` +
    `<div class="ex-view-date-lane" data-lane="background"><strong>裏で動く画面</strong><i class="ex-view-date-lane-line" aria-hidden="true"></i>` +
    `<span class="ex-view-date-event ex-view-date-event-before">保存に使う日付：${esc(names.origins?.[boundary.writeOriginLine])} ${cite(record?.file, boundary.writeOriginLine, `${boundary.writeOriginLine}行`)}</span>` +
    `<span class="ex-view-date-event ex-view-date-event-after">境目の後に入口が動く</span></div>` +
    `<div class="ex-view-date-lane" data-lane="storage"><strong>ブラウザの保存</strong><i class="ex-view-date-lane-line" aria-hidden="true"></i>` +
    `<span class="ex-view-date-event ex-view-date-event-old">前の日のキーへ書く</span>` +
    `<span class="ex-view-date-event ex-view-date-event-current">表示する日のキーを読む：${esc(names.origins?.[boundary.displayOriginLine])} ${cite(display?.file, boundary.displayOriginLine, `${boundary.displayOriginLine}行`)}</span></div>` +
    `<i class="ex-view-date-flow-line ex-view-date-flow-write" aria-label="前の日のキーへ書く"></i>` +
    `<i class="ex-view-date-flow-line ex-view-date-flow-read" aria-label="表示する日のキーを読む"></i></div>` +
    '<span class="ex-view-unverified">実画面は未確認</span></div>' : '';
  const raceView = views.selected.C && race ? section('race', number++, `${names.raceTitle}（実行では未確認）`,
    '2つのタブが保存する順番と、日付の境目をまたぐ処理を示します。',
    `<div id="ex-race-view" class="ex-view-race"><div class="ex-view-race-head"><span>タブA</span>${card(storage, keyName)}<span>タブB</span></div>` +
    `<div class="ex-view-race-window"><span>ほぼ同時（排他なし）</span>${raceRows}</div></div>` +
    `<div class="ex-view-result">${race.increment ? '保存結果 4　／　本来 5' : '最後に書いた値が残る'}</div>` +
    `${structure.noticeLine ? `<p class="ex-view-notify">保存の通知（${cite(display?.file, structure.noticeLine, `${structure.noticeLine}行`)}）で両方の画面を読み直します。</p>` : ''}` +
    `${date}<div class="ex-view-race-entries"><strong>起こしうる入口と経路</strong><ul>${raceEntries}</ul></div>`, names.raceSentence) : '';
  const diagramHtml = `${compare.html}${legend()}${state}${flow}${data}${raceView}`;
  let html = base.html.replace(/<p class="ex-fact">[^<]*<\/p>\s*<figure class="ex-mapfig">[\s\S]*?<\/figure>/, diagramHtml);
  html = html.replace(/<div class="ex-tally">[\s\S]*?<h2>懸念点 \d+件<\/h2><ol class="ex-points">[\s\S]*?<\/ol>/, '');
  html = html.replace(/<h2>依頼文<\/h2><p class="ex-request">([\s\S]*?)<\/p>/, '');
  html = html.replace(/(<p class="ex-lead ex-ai-text">[\s\S]*?<\/p>)/, `$1<p class="ex-request">依頼：${esc(input.task?.request ?? '')}</p>`);
  html = html.replace(/<h2>補った判断 \d+件<\/h2><table class="ex-interp">[\s\S]*?<\/table>/, ui.table);
  html = withMissingImages(withoutPairedGallery(html, compare.pairedPaths), compare.missing);
  const used = new Set([...html.matchAll(/data-part="([^"]+)"/g)].map(match => match[1]));
  const edges = views.edges.filter(item => used.has(item.from) && used.has(item.to));
  return { ...base, html, views: views.selected, drawnEdges: edges.map(item => item.id), foldedEdges: [], panelCount: draft.offMap.length,
    geometry: { boxes: views.nodes.filter(item => used.has(item.id)), edges, width: 0, height: 0, layerCount: 0 } };
}
