// A constructive fallback: every endpoint gets a separate lane in a column
// gutter and every edge gets a row below the boxes. No graph search can fail.
// Non-planar graphs use explicit gaps at crossings, never implied junctions.
export function corridorRoutes(boxes, edges, columns, baseHeight) {
  const byId = new Map(boxes.map(b => [b.id, b]));
  const gutters = columns.map((c, i) => ({ left: i ? columns[i - 1].x + columns[i - 1].w : 0, right: c.x, tracks: [] }));
  gutters.push({ left: columns.at(-1).x + columns.at(-1).w, right: 1000, tracks: [] });
  const tracks = new Map(), usedY = new Set(), direct = [], pending = [];
  const clean = points => points.filter((p, i) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  const hits = (a, b, r) => a.x === b.x && a.x > r.x && a.x < r.x + r.w && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h;
  const order = [...edges].sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
  for (const edge of order) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    const a = { x: from.x + from.w / 2, y: from.y + from.h }, b = { x: to.x + to.w / 2, y: to.y };
    if (from.layer === to.layer && b.y > a.y && !boxes.some(r => hits(a, b, r))
      && !direct.some(e => e.points[0].x === a.x && Math.min(e.points[1].y, b.y) > Math.max(e.points[0].y, a.y))) {
      direct.push({ ...edge, points: [a, b], label: { x: a.x + 5, y: (a.y + b.y) / 2 - 9, w: edge.text.length * 8 + 12, h: 18 } });
    } else pending.push(edge);
  }
  const port = (edge, side) => {
    const box = byId.get(side === 'out' ? edge.from : edge.to);
    const peers = pending.filter(e => (side === 'out' ? e.from : e.to) === box.id);
    let y = box.y + box.h * ((side === 'out' ? .15 : .6) + .25 * (peers.indexOf(edge) + 1) / (peers.length + 1));
    while (usedY.has(y)) y += .001;
    usedY.add(y);
    return { x: side === 'out' ? box.x + box.w : box.x, y };
  };
  for (const edge of pending) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    const left = from.layer < to.layer;
    for (const [name, gutter] of [['out', from.layer + 1], ['in', to.layer], ['turn', left ? 0 : 4]])
      gutters[gutter].tracks.push(`${edge.id}:${name}`);
    tracks.set(`${edge.id}:left`, left);
  }
  for (const gutter of gutters) gutter.tracks.forEach((key, i) => {
    tracks.set(key, gutter.left + 1 + (gutter.right - gutter.left - 2) * (i + 1) / (gutter.tracks.length + 1));
  });
  const routed = pending.map((edge, i) => {
    const from = port(edge, 'out'), to = port(edge, 'in');
    const sx = tracks.get(`${edge.id}:out`), tx = tracks.get(`${edge.id}:in`), turn = tracks.get(`${edge.id}:turn`);
    const y = baseHeight + 28 + i * 54, left = tracks.get(`${edge.id}:left`);
    const box = byId.get(left ? edge.from : edge.to);
    const w = Math.min(box.w - 20, [...edge.text].reduce((n, c) => n + (c.charCodeAt(0) < 128 ? 7.2 : 12), 10));
    return { ...edge, points: clean([from, { x: sx, y: from.y }, { x: sx, y }, { x: turn, y },
      { x: turn, y: y + 24 }, { x: tx, y: y + 24 }, { x: tx, y: to.y }, to]),
      label: { x: box.x + (box.w - w) / 2, y: left ? y - 21 : y + 3, w, h: 18 } };
  });
  const all = [...direct, ...routed];
  // The geometry carries exactly the painted segments so QA can verify gaps,
  // labels and arrowheads without waiving intersection checks.
  const segments = all.flatMap(e => e.points.slice(1).map((b, i) => ({ id: e.id, a: e.points[i], b })));
  let bridges = 0;
  for (const edge of all) {
    edge.paintedSegments = [];
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1], b = edge.points[i];
      if (a.x !== b.x) { edge.paintedSegments.push([a, b]); continue; }
      const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
      const crossings = [...new Set(segments.filter(s => s.id !== edge.id && s.a.y === s.b.y
        && a.x > Math.min(s.a.x, s.b.x) && a.x < Math.max(s.a.x, s.b.x) && s.a.y > lo && s.a.y < hi).map(s => s.a.y))].sort((x, y) => x - y);
      bridges += crossings.length;
      let start = lo;
      const pieces = [];
      for (let j = 0; j < crossings.length; j++) {
        const y = crossings[j], gap = Math.min(3, (y - (crossings[j - 1] ?? lo)) / 3, ((crossings[j + 1] ?? hi) - y) / 3);
        pieces.push([{ x: a.x, y: start }, { x: a.x, y: y - gap }]); start = y + gap;
      }
      pieces.push([{ x: a.x, y: start }, { x: a.x, y: hi }]);
      edge.paintedSegments.push(...(a.y < b.y ? pieces : pieces.reverse().map(([c, d]) => [d, c])));
    }
  }
  return { edges: all, height: pending.length ? baseHeight + pending.length * 54 + 28 : baseHeight, bridges };
}
