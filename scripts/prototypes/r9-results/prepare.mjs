import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const require = createRequire('C:/Users/owner/github/poiesis/package.json');
const acorn = require('acorn');
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
const walk = (node, visit, ancestors = []) => {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, [...ancestors, node]));
    else if (value && typeof value === 'object') walk(value, visit, [...ancestors, node]);
  }
};
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);

function parseDiff(diff) {
  const hunks = [], added = new Map();
  let file, current, oldLine, newLine;
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header && file) {
      current = { file, oldStart: +header[1], oldCount: +(header[2] ?? 1), start: +header[3], count: +(header[4] ?? 1), lines: [] };
      current.id = `h-${hash(`${file}\0${current.oldStart}\0${current.start}\0${line}`)}`;
      hunks.push(current); oldLine = current.oldStart; newLine = current.start;
      continue;
    }
    if (!current || line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('--- ')) {
      if (line.startsWith('diff --git ')) current = undefined;
      continue;
    }
    if (line[0] === '+') {
      current.lines.push({ kind: 'add', line: newLine, text: line.slice(1) });
      if (!added.has(file)) added.set(file, new Set());
      added.get(file).add(newLine++);
    } else if (line[0] === '-') {
      current.lines.push({ kind: 'delete', line: oldLine++, newLine: current.count ? newLine : newLine + 1, text: line.slice(1) });
    } else if (line[0] === ' ') {
      current.lines.push({ kind: 'context', line: newLine++, text: line.slice(1) }); oldLine++;
    }
  }
  return { hunks, added };
}

function analyzeFile(file, source, changed, nodes, edges) {
  const scripts = extname(file).toLowerCase() === '.html'
    ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].filter(m => !/\bsrc\s*=/.test(m[0].slice(0, m[0].indexOf('>')))).map(m => ({ code: m[1], offset: source.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length - 1 }))
    : [{ code: source, offset: 0 }];
  const idLines = new Map();
  if (extname(file).toLowerCase() === '.html') {
    source.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) idLines.set(m[1], i + 1);
    });
  }
  const parsedScripts = [];
  for (const { code, offset } of scripts) {
    try { parsedScripts.push({ code, offset, ast: acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true }) }); }
    catch { return false; }
  }
  for (const { code, offset, ast } of parsedScripts) {
    const lineOf = n => n.loc.start.line + offset;
    const endOf = n => n.loc.end.line + offset;
    const src = n => code.slice(n.start, n.end);
    const status = (a, b) => {
      const hits = [...changed].filter(n => n >= a && n <= b).length;
      return hits === 0 ? 'existing' : hits === b - a + 1 ? 'new' : 'modified';
    };
    const functions = new Map(), elements = new Map(), handlers = new Set();
    walk(ast, n => {
      if (n.type === 'FunctionDeclaration' && n.id) {
        const name = n.id.name;
        const part = { id: `n-${hash(`${file}\0function\0${name}`)}`, kind: 'function', symbol: name, file, line: lineOf(n), end: endOf(n), status: status(lineOf(n), endOf(n)) };
        functions.set(name, { ast: n, part }); nodes.push(part);
      }
      if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init?.type === 'CallExpression' && src(n.init.callee) === 'document.getElementById' && typeof n.init.arguments[0]?.value === 'string')
        elements.set(n.id.name, n.init.arguments[0].value);
      if (n.type === 'CallExpression') {
        const callee = src(n.callee);
        if (/(?:^|\.)addEventListener$/.test(callee) && n.arguments[1]) handlers.add(n.arguments[1]);
        if (/(?:^|\.)setInterval$/.test(callee) && n.arguments[0]) handlers.add(n.arguments[0]);
      }
    });
    const byId = new Map(nodes.map(n => [n.id, n]));
    const addNode = (kind, symbol, line, end = line) => {
      const id = `n-${hash(`${file}\0${kind}\0${symbol}${kind === 'storage' ? '' : `\0${line}`}`)}`;
      if (!byId.has(id)) { const part = { id, kind, symbol, file, line, end, status: status(line, end) }; nodes.push(part); byId.set(id, part); }
      return byId.get(id);
    };
    const addEdge = (from, to, n, access = 'call') => {
      if (!from || !to) return;
      const line = lineOf(n);
      const id = `e-${hash(`${from.id}\0${to.id}\0${file}\0${line}`)}`;
      if (!edges.some(e => e.id === id)) edges.push({ id, from: from.id, to: to.id, file, line, access,
        ...(access === 'call' ? { call: src(n).replace(/\s+/g, ' ') } : {}), status: changed.has(line) ? 'new' : 'existing' });
    };
    const scan = (owner, body) => walk(body, (n, ancestors) => {
      if (ancestors.some(a => a !== body && a.body !== body && (a.type === 'FunctionDeclaration' || handlers.has(a)))) return;
      if (n.type === 'CallExpression') {
        const callee = src(n.callee);
        const target = functions.get(callee)?.part;
        if (target) addEdge(owner, target, n);
        if (/\blocalStorage\.(getItem|setItem)$/.test(callee)) addEdge(owner, addNode('storage', `localStorage ${n.arguments[0] ? src(n.arguments[0]) : ''}`, lineOf(n)), n, callee.endsWith('.getItem') ? 'read' : 'write');
        const event = /(?:^|\.)addEventListener$/.test(callee), timer = /(?:^|\.)setInterval$/.test(callee);
        if (event || timer) {
          const handler = n.arguments[event ? 1 : 0];
          if (!handler) return;
          const symbol = event ? `${src(n.callee.object)} ${n.arguments[0] ? src(n.arguments[0]) : ''}` : `setInterval ${n.arguments[1] ? src(n.arguments[1]) : ''}ms`;
          const entry = addNode('entry', symbol, lineOf(n), endOf(n));
          entry.sourceLabel = event && typeof n.arguments[0]?.value === 'string' ? n.arguments[0].value : timer ? 'setInterval' : symbol;
          if (handler.type === 'Identifier') {
            addEdge(entry, functions.get(handler.name)?.part, n);
            const edge = edges.find(e => e.from === entry.id && e.to === functions.get(handler.name)?.part.id);
            if (edge) edge.call = `${handler.name}()`;
          }
          else if (handler.body) scan(entry, handler.body);
        }
      }
      if (n.type === 'AssignmentExpression' && n.left?.type === 'MemberExpression' && src(n.left.property) === 'textContent') {
        const element = elements.get(src(n.left.object));
        if (element) addEdge(owner, addNode('screen', `#${element}`, idLines.get(element) ?? lineOf(n)), n, 'display');
      }
    });
    for (const { ast: fn, part } of functions.values()) scan(part, fn.body);
    const page = addNode('entry', 'page load', offset + 1);
    scan(page, ast);
  }
  return parsedScripts.length > 0;
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (typeof input.workspace !== 'string' || !input.workspace) throw new Error('作業場所のパスが必要です。');
  const workspace = resolve(input.workspace);
  let diff = execFileSync('git', ['-C', workspace, 'diff', 'HEAD', '--no-ext-diff', '--no-color', '-U0', '--'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const other = execFileSync('git', ['-C', workspace, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  for (const file of other) {
    if (file.split(/[\\/]/).some(part => part.startsWith('.') || part === 'node_modules')) continue;
    const full = resolve(workspace, file);
    if (statSync(full).size > 512 * 1024) continue;
    if (readFileSync(full).includes(0)) continue;
    try { execFileSync('git', ['-C', workspace, 'diff', '--no-index', '--no-color', '-U0', '--', '/dev/null', full], { encoding: 'utf8', windowsHide: true }); }
    catch (error) {
      if (error.status !== 1 || typeof error.stdout !== 'string') throw error;
      const marker = error.stdout.indexOf('+++ ');
      const end = error.stdout.indexOf('\n', marker);
      if (marker < 0 || end < 0) throw new Error(`新しいファイルの差分を読めません: ${file}`);
      diff += error.stdout.slice(0, marker) + `+++ b/${file}` + error.stdout.slice(end);
    }
  }
  const { hunks, added } = parseDiff(diff);
  if (hunks.some(h => h.lines.some(l => /\b(?:api[_-]?key|secret|token|password|credential|private[_-]?key)\b\s*[:=]/i.test(l.text))))
    throw new Error('差分に秘密情報を示す項目があります。事実データを消毒してから準備をやり直してください。');
  const nodes = [], edges = [], skipped = [];
  for (const file of [...new Set(hunks.map(h => h.file))]) {
    if (!/\.(?:js|mjs|cjs|html)$/i.test(file)) { skipped.push(file); continue; }
    const source = readFileSync(resolve(workspace, file), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (!analyzeFile(file, source, added.get(file) ?? new Set(), nodes, edges)) skipped.push(file);
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  const outgoing = new Map();
  for (const edge of edges) { if (!outgoing.has(edge.from)) outgoing.set(edge.from, []); outgoing.get(edge.from).push(edge); }
  const keepEdges = new Set(edges.filter(e => e.status === 'new' || byId.get(e.to)?.status !== 'existing').map(e => e.id));
  const entries = nodes.filter(n => n.kind === 'entry');
  const changedTargets = nodes.filter(n => n.status !== 'existing' && n.kind === 'function');
  for (const target of changedTargets) {
    let shortest = Infinity, paths = [];
    for (const entry of entries) {
      const queue = [{ id: entry.id, path: [] }], seen = new Set([entry.id]);
      while (queue.length) {
        const item = queue.shift();
        if (item.path.length > shortest) break;
        if (item.id === target.id) {
          if (item.path.length < shortest) { shortest = item.path.length; paths = []; }
          paths.push(item.path); break;
        }
        for (const edge of outgoing.get(item.id) ?? []) if (!seen.has(edge.to)) { seen.add(edge.to); queue.push({ id: edge.to, path: [...item.path, edge.id] }); }
      }
    }
    for (const path of paths) for (const id of path) keepEdges.add(id);
  }
  const selectedEdges = edges.filter(e => keepEdges.has(e.id));
  const selectedIds = new Set(selectedEdges.flatMap(e => [e.from, e.to]));
  // Classify against the full syntax graph, before pruning candidates or AI selection.
  for (const node of nodes) {
    const out = outgoing.get(node.id) ?? [];
    node.helper = node.kind === 'function' && out.length === 0;
    node.outgoing = out.map(e => e.id);
  }
  const map = { nodes: nodes.filter(n => selectedIds.has(n.id) || (n.status !== 'existing' && n.kind !== 'function' && n.kind !== 'entry')), edges: selectedEdges };
  const brief = { nodes: map.nodes.map(({ id, kind, symbol, file, line, end, status }) => ({ id, kind, symbol, file, line, end, status })), edges: map.edges, hunks: hunks.map(({ id, file, start, count, lines }) => ({ id, file, start, count, excerpt: lines.slice(0, 3).map(l => l.text) })) };
  let briefing = JSON.stringify(brief);
  if (briefing.length > 16000) { for (const h of brief.hunks) delete h.excerpt; briefing = JSON.stringify(brief); }
  if (briefing.length > 16000) throw new Error('地図の候補と差分が16000字を超えました。対象を小さく分けてください。');
  output({ ok: true, workspace, map, hunks, skipped, aiMaterial: briefing });
} catch (error) { output({ ok: false, reasons: [`準備に失敗しました: ${error.message}`] }); process.exitCode = 1; }
