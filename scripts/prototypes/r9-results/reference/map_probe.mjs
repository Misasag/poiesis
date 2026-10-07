// Feasibility probe: derive a change map (entry -> function -> storage/DOM) from AST + git diff.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire('C:/Users/owner/github/poiesis/package.json');
const acorn = require('acorn');
// Minimal walker (acorn-walk is not installed): visits every node with its ancestor chain.
function visit(node, fn, anc = []) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, anc);
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach(c => visit(c, fn, [...anc, node]));
    else if (v && typeof v.type === 'string') visit(v, fn, [...anc, node]);
  }
}
const walk = {
  full: (root, fn) => visit(root, n => fn(n)),
  ancestor: (root, handlers) => visit(root, (n, anc) => handlers[n.type]?.(n, null, [...anc, n]))
};

const repo = process.argv[2];
const file = 'index.html';
const html = readFileSync(`${repo}/${file}`, 'utf8').replace(/\r\n/g, '\n');
const open = html.lastIndexOf('<script>');
const close = html.indexOf('</script>', open);
const code = html.slice(open + 8, close);
const lineOffset = html.slice(0, open + 8).split('\n').length - 1;
const L = n => n.loc.start.line + lineOffset;

// Added lines (new side) from git diff.
const diff = execFileSync('git', ['-C', repo, 'diff', '-U0', '--', file], { encoding: 'utf8' });
const added = new Set();
for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
  const start = Number(m[1]), count = m[2] === undefined ? 1 : Number(m[2]);
  for (let i = 0; i < count; i++) added.add(start + i);
}
const status = (a, b) => {
  let hit = 0; for (let i = a; i <= b; i++) if (added.has(i)) hit++;
  return hit === 0 ? 'existing' : hit === b - a + 1 ? 'new' : 'modified';
};

const ast = acorn.parse(code, { ecmaVersion: 'latest', locations: true });
const src = n => code.slice(n.start, n.end);
const functions = new Map();
walk.full(ast, n => { if (n.type === 'FunctionDeclaration') functions.set(n.id.name, n); });

// const x = document.getElementById("id")
const elementIds = new Map();
walk.full(ast, n => {
  if (n.type === 'VariableDeclarator' && n.init?.type === 'CallExpression' && src(n.init.callee) === 'document.getElementById')
    elementIds.set(n.id.name, { id: n.init.arguments[0].value, line: L(n) });
});

// Functions registered as handlers are scanned as their own entries; skip them elsewhere.
const handlerNodes = new Set();
walk.full(ast, n => {
  if (n.type !== 'CallExpression') return;
  const c = src(n.callee);
  if (c.endsWith('addEventListener') && n.arguments[1]) handlerNodes.add(n.arguments[1]);
  if (c.endsWith('setInterval') && n.arguments[0]) handlerNodes.add(n.arguments[0]);
});
const skip = (a, body) => a !== body && (a.type === 'FunctionDeclaration' || handlerNodes.has(a) || (a.body === body ? false : false));
const edges = [];
function scan(fromLabel, body) {
  walk.ancestor(body, {
    CallExpression(n, _s, anc) {
      if (anc.some(a => a !== body && a.body !== body && (a.type === 'FunctionDeclaration' || handlerNodes.has(a)))) return;
      const callee = src(n.callee);
      if (functions.has(callee)) edges.push([fromLabel, `fn:${callee}`, L(n)]);
      if (/localStorage\.(getItem|setItem)$/.test(callee))
        edges.push([fromLabel, `store:${callee.split('.').pop()} ${src(n.arguments[0])}`, L(n)]);
      if (callee.endsWith('addEventListener') || callee.endsWith('setInterval')) {
        const handler = callee.endsWith('setInterval') ? n.arguments[0] : n.arguments[1];
        const what = callee.endsWith('setInterval') ? `timer:setInterval ${src(n.arguments[1])}ms` : `event:${src(n.callee.object)} ${src(n.arguments[0])}`;
        const label = `entry:${what}`;
        if (handler.type === 'Identifier') edges.push([label, `fn:${handler.name}`, L(n)]);
        else scan(label, handler.body);
      }
    },
    AssignmentExpression(n, _s, anc) {
      if (anc.some(a => a !== body && a.body !== body && (a.type === 'FunctionDeclaration' || handlerNodes.has(a)))) return;
      if (n.left.type === 'MemberExpression' && src(n.left.property) === 'textContent' && elementIds.has(src(n.left.object)))
        edges.push([fromLabel, `dom:#${elementIds.get(src(n.left.object)).id}`, L(n)]);
    }
  });
}
for (const [name, fn] of functions) scan(`fn:${name}`, fn.body);
scan('entry:page load (top level)', ast);

// Keep only paths touching changed code: nodes that are changed, or reach a changed node.
const nodeStatus = label => {
  if (label.startsWith('fn:')) { const f = functions.get(label.slice(3)); return status(L(f), f.loc.end.line + lineOffset); }
  return 'n/a';
};
const changedEdge = e => added.has(e[2]);
const succ = new Map(); for (const e of edges) (succ.get(e[0]) ?? succ.set(e[0], []).get(e[0])).push(e);
const memo = new Map();
const relevant = label => {
  if (memo.has(label)) return memo.get(label); memo.set(label, false);
  const s = nodeStatus(label);
  const r = s === 'new' || s === 'modified' || (succ.get(label) ?? []).some(e => changedEdge(e) || relevant(e[1]));
  memo.set(label, r); return r;
};
const keep = edges.filter(e => (changedEdge(e) || relevant(e[1])) && (e[0].startsWith('entry:') || relevant(e[0])));
// Drop top-level entries that are not changed and do not lead to changes.
const out = keep.filter(e => !(e[0].startsWith('entry:') && !changedEdge(e) && !relevant(e[1])));
const nodes = new Set(out.flatMap(e => [e[0], e[1]]));
console.log('NODES');
for (const n of nodes) {
  const f = n.startsWith('fn:') ? functions.get(n.slice(3)) : undefined;
  console.log(`  ${n}  ${f ? `${file}:${L(f)}-${f.loc.end.line + lineOffset} [${nodeStatus(n)}]` : ''}`);
}
console.log('EDGES (from -> to @line [edge added?])');
for (const e of out) console.log(`  ${e[0]} -> ${e[1]} @${file}:${e[2]} ${added.has(e[2]) ? '[added]' : ''}`);
console.log('DOM ids', [...elementIds].filter(([, v]) => added.has(v.line)).map(([k, v]) => `${k}=#${v.id}@${v.line}`).join(', '));
if (process.argv[3] === '--json') {
  const fns = {};
  for (const [name, fn] of functions) fns[name] = { start: L(fn), end: fn.loc.end.line + lineOffset, status: nodeStatus(`fn:${name}`) };
  const json = { functions: fns, allEdges: edges.map(e => ({ from: e[0], to: e[1], line: e[2], added: added.has(e[2]) })),
    mapEdges: out.map(e => ({ from: e[0], to: e[1], line: e[2], added: added.has(e[2]) })), added: [...added].sort((a, b) => a - b) };
  (await import('node:fs')).writeFileSync(process.argv[4], JSON.stringify(json, null, 1));
}
