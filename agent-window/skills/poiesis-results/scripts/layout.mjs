import { reduceGraph } from './graph.mjs';

import { corridorRoutes } from './corridors.mjs';

const WIDTH = 1000;
export const CAPACITY = { total: 20, perColumn: 6 };
const COLUMNS = [{ x: 10, w: 195, title: '入口' }, { x: 275, w: 250, title: '処理' },
  { x: 578, w: 190, title: '共有の読み出し' }, { x: 805, w: 185, title: '保存先・画面' }];
function checkCapacity(nodes) {
  const counts = COLUMNS.map((_, layer) => nodes.filter(n => n.layer === layer).length);
  if (nodes.length > CAPACITY.total || counts.some(n => n > CAPACITY.perColumn)) {
    throw new Error(`畳んだあとの箱は${nodes.length}個（全体の上限${CAPACITY.total}個）、${counts.map((n, i) => `${COLUMNS[i].title}${n}個`).join('・')}（各列の上限${CAPACITY.perColumn}個）です。4列・幅1000に収まるように部品を絞るか畳んでください。`);
  }
}
export const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const segmentHits = (a, b, r, margin = 0) => a.x === b.x
  ? a.x > r.x - margin && a.x < r.x + r.w + margin && Math.max(a.y, b.y) > r.y - margin && Math.min(a.y, b.y) < r.y + r.h + margin
  : a.y === b.y && a.y > r.y - margin && a.y < r.y + r.h + margin && Math.max(a.x, b.x) > r.x - margin && Math.min(a.x, b.x) < r.x + r.w + margin;
const textWidth = (text, size) => [...text].reduce((w, c) => w + (/[\x20-\x7e]/.test(c) ? size * .60 : size), 0);
// Keep quoted strings, function calls and line references together. Overflow is
// abbreviated on the map; the panel always contains the complete source text.
export function abbreviate(text, width, size) {
  if (textWidth(text, size) <= width) return text;
  const tokens = text.match(/"[^"]*"|'[^']*'|[A-Za-z_$][\w$]*(?:\([^)]*\))?|\d+(?:-\d+)?行|\s+|[^\s]/gu) ?? [];
  let line = '';
  for (const token of tokens) {
    if (textWidth(line + token + '…', size) > width) break;
    line += token;
  }
  // A single overlong identifier still needs a recognizable prefix.
  if (!line.trim() && /^["']/.test(text)) return '…';
  if (!line.trim()) for (const c of text) {
    if (textWidth(line + c + '…', size) > width) break;
    line += c;
  }
  return line.trimEnd() + '…';
}
function wrapTitle(text, width) {
  const tokens = [...new Intl.Segmenter('ja', { granularity: 'word' }).segment(text)].map(s => s.segment);
  let first = '';
  for (const token of tokens) {
    if (textWidth(first + token, 15) > width) break;
    first += token;
  }
  if (!first) return [abbreviate(text, width, 15)];
  const rest = text.slice(first.length);
  return rest ? [first.trimEnd(), abbreviate(rest.trimStart(), width, 15)] : [first];
}
const center = b => b.y + b.h / 2;
const stable = (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id);
function orderProcessing(nodes, edges) {
  const ids = new Set(nodes.map(n => n.id)), pending = [...nodes].sort(stable), result = [];
  while (pending.length) {
    let i = pending.findIndex(n => !edges.some(e => e.to === n.id && ids.has(e.from)));
    if (i < 0) i = 0; // Cycles use a return path in the inter-column corridor.
    const [node] = pending.splice(i, 1); ids.delete(node.id); result.push(node);
  }
  return result;
}
// The screen box grows only when a screenshot will be drawn inside it; an empty frame reads as missing content.
function arrange(model, { screenImage = false } = {}) {
  const boxes = model.nodes.map(n => {
    const column = COLUMNS[n.layer];
    const titleLines = wrapTitle(n.title, column.w - 20);
    const subLines = n.subs.slice(0, 3).map(s => {
      const annotation = n.annotations.find(a => a.text === s);
      if (!annotation || textWidth(s, 11) <= column.w - 20) return abbreviate(s, column.w - 20, 11);
      const reference = `${annotation.call} ${annotation.line}行`;
      const room = column.w - 20 - textWidth(` ${reference}`, 11);
      return room >= 22 ? `${abbreviate(annotation.title, room, 11)} ${reference}` : abbreviate(reference, column.w - 20, 11);
    });
    if (n.subs.length > 3) subLines[2] = 'ほかの呼び出しは中身に表示';
    const textHeight = 18 + titleLines.length * 19 + subLines.length * 15 + 10;
    return { ...n, ...column, title: n.title, titleLines, subLines, h: Math.max(62, textHeight) + (n.kind === 'screen' && screenImage ? 90 : 0), y: 34 };
  });
  const byId = new Map(boxes.map(b => [b.id, b]));
  const processing = orderProcessing(boxes.filter(b => b.layer === 1), model.edges);
  let y = 34;
  for (const box of processing) {
    box.y = y;
    y += box.h + (model.edges.some(e => e.from === box.id && byId.get(e.to).layer === 2) ? 90 : 54);
  }
  const rank = new Map(processing.map((b, i) => [b.id, i]));
  const entries = boxes.filter(b => b.layer === 0).sort((a, b) => {
    const r = n => Math.min(...model.edges.filter(e => e.from === n.id).map(e => rank.get(e.to) ?? 99));
    return r(a) - r(b) || (a.symbol === 'page load' ? -1 : b.symbol === 'page load' ? 1 : stable(a, b));
  });
  y = 34;
  for (let i = 0; i < entries.length; i++) {
    const box = entries[i]; box.y = y;
    const targets = n => model.edges.filter(e => e.from === n.id).map(e => e.to).sort().join();
    y += box.h + 20 + (i + 1 < entries.length && targets(box) !== targets(entries[i + 1]) ? 52 : 0);
  }
  let floor = 34;
  for (const box of boxes.filter(b => b.layer === 2).sort(stable)) {
    const callers = model.edges.filter(e => e.to === box.id).map(e => byId.get(e.from));
    box.y = Math.round(Math.max(floor, callers.reduce((s, b) => s + center(b), 0) / callers.length - box.h / 2));
    floor = box.y + box.h + 36;
  }
  floor = 34;
  for (const box of boxes.filter(b => b.layer === 3).sort((a, b) => (a.kind === 'storage' ? 0 : 1) - (b.kind === 'storage' ? 0 : 1) || stable(a, b))) {
    const callers = model.edges.filter(e => e.to === box.id).map(e => byId.get(e.from));
    const reader = callers.find(b => b.layer === 2);
    const desired = reader && box.kind === 'storage' ? reader.y - box.h - 64 : Math.max(34, ...callers.map(b => b.y));
    box.y = Math.max(floor, desired); floor = box.y + box.h + 40;
  }
  const height = Math.max(300, ...boxes.map(b => b.y + b.h + 22));
  return { boxes, byId, height };
}
class Heap {
  items = [];
  push(item) {
    const a = this.items; a.push(item);
    for (let i = a.length - 1; i > 0;) { const p = (i - 1) >> 1; if (a[p].score <= a[i].score) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.items, first = a[0], last = a.pop();
    if (a.length) { a[0] = last; for (let i = 0;;) { let c = i * 2 + 1; if (c >= a.length) break; if (c + 1 < a.length && a[c + 1].score < a[c].score) c++; if (a[i].score <= a[c].score) break; [a[i], a[c]] = [a[c], a[i]]; i = c; } }
    return first;
  }
}
const segments = points => points.slice(1).map((b, i) => [points[i], b]);
const along = (a, b, c, d) => a.x === b.x && c.x === d.x && a.x === c.x
  ? Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) > Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y))
  : a.y === b.y && c.y === d.y && a.y === c.y && Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) > Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
function route(start, end, boxes, occupied, height, detour = false) {
  const xs = new Set([start.x, end.x, 4, 996]), ys = new Set([start.y, end.y, 28, height - 6]);
  for (const b of boxes) {
    for (const gap of [8, 18, 28]) {
      xs.add(b.x - gap); xs.add(b.x + b.w + gap); ys.add(b.y - gap); ys.add(b.y + b.h + gap);
    }
  }
  if (detour) for (const [a, b] of occupied) for (const p of [a, b]) for (const gap of [-6, 6]) { xs.add(p.x + gap); ys.add(p.y + gap); }
  const X = [...xs].filter(x => x >= 4 && x <= 996).sort((a, b) => a - b), Y = [...ys].filter(y => y >= 28 && y <= height - 6).sort((a, b) => a - b);
  const nx = X.length, idx = (x, y) => y * nx + x;
  const begin = idx(X.indexOf(start.x), Y.indexOf(start.y)), goal = idx(X.indexOf(end.x), Y.indexOf(end.y));
  const heap = new Heap(), best = new Map(), parent = new Map();
  const point = p => ({ x: X[p % nx], y: Y[Math.floor(p / nx)] });
  const heuristic = p => Math.abs(point(p).x - end.x) + Math.abs(point(p).y - end.y);
  heap.push({ p: begin, axis: 0, cost: 0, score: heuristic(begin) }); best.set(`${begin}:0`, 0);
  let terminal;
  while (heap.items.length) {
    const current = heap.pop(), key = `${current.p}:${current.axis}`;
    if (best.get(key) !== current.cost) continue;
    if (current.p === goal) { terminal = key; break; }
    const x = current.p % nx, y = Math.floor(current.p / nx);
    for (const [dx, dy, axis] of [[1, 0, 1], [-1, 0, 1], [0, 1, 2], [0, -1, 2]]) {
      if (!detour && end.x > start.x && dx < 0) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= nx || yy < 0 || yy >= Y.length) continue;
      const p = idx(xx, yy), a = point(current.p), b = point(p);
      if (boxes.some(box => segmentHits(a, b, box, 5)) || occupied.some(([c, d]) => along(a, b, c, d))) continue;
      const crossing = occupied.some(([c, d]) => a.x === b.x
        ? c.y === d.y && a.x >= Math.min(c.x, d.x) && a.x <= Math.max(c.x, d.x) && c.y >= Math.min(a.y, b.y) && c.y <= Math.max(a.y, b.y)
        : c.x === d.x && a.y >= Math.min(c.y, d.y) && a.y <= Math.max(c.y, d.y) && c.x >= Math.min(a.x, b.x) && c.x <= Math.max(a.x, b.x));
      if (crossing) continue;
      // Fan-in from upper entries uses the rightmost corridor first, leaving
      // room for lower entries without introducing crossings.
      const corridor = axis === 2 && end.x > start.x && end.y > start.y ? (end.x - a.x) * Math.abs(a.y - b.y) * .01 : 0;
      const cost = current.cost + Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + (current.axis && current.axis !== axis ? 26 : 0) + corridor;
      const next = `${p}:${axis}`;
      if (cost >= (best.get(next) ?? Infinity)) continue;
      best.set(next, cost); parent.set(next, key); heap.push({ p, axis, cost, score: cost + heuristic(p) });
    }
  }
  if (!terminal) return null;
  const path = [];
  for (let key = terminal; key; key = parent.get(key)) path.push(point(Number(key.split(':')[0])));
  path.reverse();
  return path.filter((p, i) => !i || i === path.length - 1 || !(path[i - 1].x === p.x && p.x === path[i + 1].x) && !(path[i - 1].y === p.y && p.y === path[i + 1].y));
}
function placeLabel(edge, boxes, labels, allSegments, height) {
  const w = Math.ceil(textWidth(edge.text, 12) + 10), h = 18, candidates = [];
  for (const [a, b] of segments(edge.points)) {
    const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    for (let offset = 4; offset <= length - 4; offset += 4) {
      const x = a.x + (b.x - a.x) * offset / length, y = a.y + (b.y - a.y) * offset / length;
      const choices = a.y === b.y ? [{ x: x - w / 2, y: y - h - 3 }, { x: x - w / 2, y: y + 3 }]
        : [{ x: x + 4, y: y - h / 2 }, { x: x - w - 4, y: y - h / 2 }];
      for (const c of choices) candidates.push({ ...c, w, h, score: Math.abs(offset - length / 2) - Math.min(length, 100) });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  const result = candidates.find(c => c.x >= 0 && c.y >= 28 && c.x + w <= WIDTH && c.y + h <= height
    && !boxes.some(b => overlaps(c, b)) && !labels.some(b => overlaps(c, b)) && !allSegments.some(([a, b]) => segmentHits(a, b, c, 1)));
  if (!result) return null;
  return { x: result.x, y: result.y, w, h };
}
function compactRoutes(model, { boxes, byId, height }, detour) {
  const ports = new Map();
  for (const box of boxes) {
    for (const side of ['in', 'out']) {
      const relevant = model.edges.filter(e => (side === 'in' ? e.to : e.from) === box.id);
      const vertical = relevant.filter(e => byId.get(e.from).layer === byId.get(e.to).layer);
      const lateral = relevant.filter(e => !vertical.includes(e)).sort((a, b) => center(byId.get(side === 'in' ? a.from : a.to)) - center(byId.get(side === 'in' ? b.from : b.to)) || a.line - b.line);
      vertical.forEach((e, i) => ports.set(`${e.id}:${side}`, { x: box.x + box.w / 2 + i * 12, y: side === 'out' ? box.y + box.h : box.y }));
      lateral.forEach((e, i) => ports.set(`${e.id}:${side}`, { x: side === 'out' ? box.x + box.w : box.x, y: Math.round(box.y + box.h * (i + 1) / (lateral.length + 1)) }));
    }
  }
  const occupied = [], routed = [], labels = [];
  const order = [...model.edges].sort((a, b) => b.text.length - a.text.length ||
    (byId.get(a.to).layer - byId.get(a.from).layer) - (byId.get(b.to).layer - byId.get(b.from).layer)
    || byId.get(a.from).layer - byId.get(b.from).layer || byId.get(a.from).y - byId.get(b.from).y || a.line - b.line);
  for (const edge of order) {
    const from = ports.get(`${edge.id}:out`), to = ports.get(`${edge.id}:in`), vertical = byId.get(edge.from).layer === byId.get(edge.to).layer;
    if (vertical && to.y <= from.y) return null;
    const start = { x: from.x + (vertical ? 0 : 8), y: from.y + (vertical ? 8 : 0) };
    const end = { x: to.x - (vertical ? 0 : 8), y: to.y - (vertical ? 8 : 0) };
    const middle = route(start, end, [...boxes, ...labels], occupied, height, detour);
    if (!middle) return null;
    const points = [from, ...middle, to];
    occupied.push(...segments(points));
    const drawn = { ...edge, points };
    drawn.label = placeLabel(drawn, boxes, labels, occupied, height);
    if (!drawn.label) return null;
    labels.push(drawn.label); routed.push(drawn);
  }
  return routed;
}

export function layoutGraph(nodes, edges, { forceCorridors = false, screenImage = false } = {}) {
  if (!nodes.length) throw new Error('地図の部品がありません。');
  const model = reduceGraph(nodes, edges);
  checkCapacity(model.nodes);
  const arranged = arrange(model, { screenImage });
  let routed = !forceCorridors && compactRoutes(model, arranged, false), routing = 'compact';
  if (!routed && !forceCorridors) { routed = compactRoutes(model, arranged, true); routing = 'detour'; }
  let height = arranged.height, bridges = 0;
  if (!routed) {
    const fallback = corridorRoutes(arranged.boxes, model.edges, COLUMNS, height);
    routed = fallback.edges; height = fallback.height; bridges = fallback.bridges; routing = 'corridors';
  }
  return { width: WIDTH, height, boxes: arranged.boxes, edges: routed, folded: model.folded, helperIds: model.helperIds,
    layerCount: 4, columns: COLUMNS, routing, bridges };
}
