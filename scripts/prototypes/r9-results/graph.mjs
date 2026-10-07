// Semantic reduction precedes geometry. All IDs and call sites remain traceable.
export function reduceGraph(selected, edges) {
  const byId = new Map(selected.map(n => [n.id, n]));
  const representative = new Map(selected.map(n => [n.id, n.id]));
  const folded = [], merged = new Map();
  const outgoing = id => edges.filter(e => e.from === id);
  for (const entry of selected.filter(n => n.kind === 'entry')) {
    const calls = outgoing(entry.id), target = byId.get(calls[0]?.to);
    if (calls.length !== 1 || entry.outgoing?.length !== 1 || target?.kind !== 'function' || target.status !== 'existing' || merged.has(target.id)) continue;
    representative.set(target.id, entry.id);
    merged.set(target.id, entry.id);
    folded.push({ ...calls[0], owner: entry.id, reason: 'entry' });
  }
  const helperIds = new Set(selected.filter(n => !merged.has(n.id) && n.helper && outgoing(n.id).length === 0).map(n => n.id));
  if ([...helperIds].some(id => !edges.some(e => e.to === id))) throw new Error('補助の関数を畳む呼び出し元がありません。呼び出しを選び、部品を絞るか畳んでください。');
  const visible = selected.filter(n => !merged.has(n.id) && !helperIds.has(n.id)).map(n => {
    const member = selected.find(m => merged.get(m.id) === n.id);
    const ranges = [{ id: n.id, file: n.file, line: n.line, end: n.end }];
    if (member) ranges.push({ id: member.id, file: member.file, line: member.line, end: member.end });
    // Top-level entries own the selected statements, never the whole script.
    if (n.symbol === 'page load') ranges.splice(0, ranges.length, ...outgoing(n.id).map(e => ({ id: n.id, file: e.file, line: e.line, end: e.line })));
    const source = member ?? n;
    const sub = source.kind === 'function' ? `${source.symbol}() ${source.line}-${source.end}行`
      : n.symbol === 'page load' ? `${ranges.map(r => r.line).join('・')}行`
      : n.kind === 'storage' ? [n.symbol.replace(/^localStorage /, ''), `${n.line}行`]
      : `${n.sourceLabel ?? n.symbol} ${n.line}${n.end > n.line ? `-${n.end}` : ''}行`;
    const status = n.symbol === 'page load' && outgoing(n.id).some(e => e.status === 'new')
      ? outgoing(n.id).every(e => e.status === 'new') ? 'new' : 'modified' : n.status;
    return { ...n, status, title: member?.title ?? n.title, caption: member ? `${n.caption}${member.caption}` : n.caption,
      members: member ? [n.id, member.id] : [n.id], ranges, subs: Array.isArray(sub) ? sub : [sub], annotations: [] };
  });
  const visibleById = new Map(visible.map(n => [n.id, n]));
  const drawn = [];
  for (const edge of edges) {
    if (folded.some(e => e.id === edge.id)) continue;
    const from = representative.get(edge.from), to = representative.get(edge.to);
    if (helperIds.has(edge.to) || merged.has(edge.to)) {
      const target = byId.get(edge.to), owner = visibleById.get(from);
      if (!owner) throw new Error('補助の呼び出しを呼ぶ側へ畳めません。');
      const text = `${helperIds.has(edge.to) ? `${target.title} ` : ''}${edge.call ?? `${target.symbol}()`} ${edge.line}行`;
      owner.annotations.push({ edge: edge.id, node: target.id, text, title: helperIds.has(edge.to) ? target.title : '', call: edge.call ?? `${target.symbol}()`, line: edge.line }); owner.subs.push(text);
      folded.push({ ...edge, owner: from, reason: helperIds.has(edge.to) ? 'helper' : 'entry-call' });
    } else {
      const prefix = { read: '読み出し ', write: '書き込み ', display: '表示 ', call: '' }[edge.access];
      if (prefix === undefined) throw new Error('矢印の読み書きの種類を準備し直してください。');
      drawn.push({ ...edge, originalFrom: edge.from, originalTo: edge.to, from, to, text: `${prefix}${edge.line}` });
    }
  }
  for (const n of visible) {
    const reads = drawn.some(e => e.from === n.id && e.access === 'read');
    const callers = new Set(drawn.filter(e => e.to === n.id && visibleById.get(e.from)?.kind === 'function').map(e => e.from));
    n.layer = n.kind === 'entry' ? 0 : ['storage', 'screen'].includes(n.kind) ? 3 : reads && callers.size >= 2 ? 2 : 1;
  }
  return { nodes: visible, edges: drawn, folded, helperIds: [...helperIds] };
}
