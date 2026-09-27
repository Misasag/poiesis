import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { resolve, extname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import * as acorn from './vendor/acorn.mjs';

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
  const hunks = [], added = new Map(), deleted = new Map();
  let file, oldFile, current, oldLine, newLine, oldRemaining = 0, newRemaining = 0;
  for (const line of diff.split('\n')) {
    // A file or hunk header can never be a hunk line; a miscounted hunk ends there instead of absorbing it.
    if (line.startsWith('diff --git ') || line.startsWith('@@ ')) oldRemaining = newRemaining = 0;
    if (current && (oldRemaining || newRemaining)) {
      if (line[0] === '+' && newRemaining) {
        current.lines.push({ kind: 'add', line: newLine, text: line.slice(1) });
        if (!added.has(file)) added.set(file, new Set());
        added.get(file).add(newLine++); newRemaining--;
      } else if (line[0] === '-' && oldRemaining) {
        current.lines.push({ kind: 'delete', line: oldLine++, newLine, text: line.slice(1) });
        if (!deleted.has(file)) deleted.set(file, new Set());
        deleted.get(file).add(newLine); oldRemaining--;
      } else if (line[0] === ' ' && oldRemaining && newRemaining) {
        current.lines.push({ kind: 'context', line: newLine++, text: line.slice(1) }); oldLine++; oldRemaining--; newRemaining--;
      }
      continue;
    }
    current = undefined;
    if (line.startsWith('diff --git ')) { file = undefined; oldFile = undefined; continue; }
    if (line.startsWith('--- a/')) { oldFile = line.slice(6).replace(/\r$/, ''); continue; }
    if (line.startsWith('+++ b/')) { file = line.slice(6).replace(/\r$/, ''); continue; }
    if (line.replace(/\r$/, '') === '+++ /dev/null') { file = oldFile; continue; }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header && file) {
      current = { file, oldStart: +header[1], oldCount: +(header[2] ?? 1), start: +header[3], count: +(header[4] ?? 1), lines: [] };
      // The identity follows the first changed line, independent of context width.
      current.id = `h-${hash(`${file}\0${current.oldStart}\0${current.start}\0${line}`)}`;
      hunks.push(current); oldLine = current.oldStart; newLine = current.start;
      oldRemaining = current.oldCount; newRemaining = current.count;
      continue;
    }
  }
  // A unified hunk can contain several separate edits when context is present.
  // Split at context lines so assignments retain one edit block per panel.
  const blocks = [];
  for (const hunk of hunks) {
    let block = null, oldAt = hunk.oldStart, newAt = hunk.start;
    const finish = () => {
      if (!block) return;
      block.oldCount = block.lines.filter(line => line.kind === 'delete').length;
      block.count = block.lines.filter(line => line.kind === 'add').length;
      block.id = `h-${hash(`${block.file}\0${block.oldStart}\0${block.start}\0${block.oldCount}\0${block.count}`)}`;
      blocks.push(block); block = null;
    };
    for (const line of hunk.lines) {
      if (line.kind === 'context') { finish(); oldAt++; newAt++; continue; }
      if (!block) block = { file: hunk.file, oldStart: oldAt, start: newAt, lines: [] };
      block.lines.push(line);
      if (line.kind === 'delete') oldAt++;
      else newAt++;
    }
    finish();
  }
  let lineEndingChanges = 0;
  for (const block of blocks) {
    const removals = block.lines.filter(line => line.kind === 'delete');
    const additions = block.lines.filter(line => line.kind === 'add');
    const omitted = new Set();
    for (let i = 0; i < Math.min(removals.length, additions.length); i++) {
      const before = removals[i], after = additions[i];
      if (before.text !== after.text && before.text.replace(/\r$/, '') === after.text.replace(/\r$/, '')) {
        omitted.add(before); omitted.add(after); lineEndingChanges++;
        added.get(block.file)?.delete(after.line); deleted.get(block.file)?.delete(before.newLine);
      }
    }
    block.lines = block.lines.filter(line => !omitted.has(line));
    block.oldCount = block.lines.filter(line => line.kind === 'delete').length;
    block.count = block.lines.filter(line => line.kind === 'add').length;
  }
  return { hunks: blocks.filter(block => block.lines.length), added, deleted, lineEndingChanges };
}

function analyzeFile(file, source, changed, deleted, nodes, edges) {
  const scripts = extname(file).toLowerCase() === '.html'
    ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].filter(m => {
      const attrs = m[0].slice(0, m[0].indexOf('>'));
      const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      return !/\bsrc\s*=/.test(attrs) && (!type || /^(?:module|(?:text|application)\/(?:javascript|ecmascript)(?:\s*;.*)?)$/i.test(type[1] ?? type[2] ?? type[3]));
    }).map(m => ({ code: m[1], offset: source.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length - 1 }))
    : [{ code: source, offset: 0 }];
  const idLines = new Map();
  if (extname(file).toLowerCase() === '.html') {
    source.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) idLines.set(m[1], i + 1);
    });
  }
  const parsedScripts = [];
  for (const [scriptIndex, script] of scripts.entries()) {
    try {
      const code = /\.(?:ts|mts|cts|tsx)$/i.test(file) && nodeModule.stripTypeScriptTypes
        ? nodeModule.stripTypeScriptTypes(script.code, { mode: 'strip' }) : script.code;
      parsedScripts.push({ code, offset: script.offset, scriptIndex, ast: acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true }) });
    } catch { continue; }
  }
  for (const { code, offset, scriptIndex, ast } of parsedScripts) {
    const lineOf = n => n.loc.start.line + offset;
    const endOf = n => n.loc.end.line + offset;
    const src = n => code.slice(n.start, n.end);
    const safeSnippet = value => value.replace(/(["'])([^"'\r\n]*)\1/g, (literal, quote, contents, index) =>
      /(?:secret|token|password|passwd|credential|api[_-]?key|authorization|private[_-]?key)/i.test(value.slice(0, index))
      || contents.length >= 8 && /\d/.test(contents) ? `${quote}[REDACTED]${quote}` : literal);
    const status = (a, b) => {
      const additions = [...changed].filter(n => n >= a && n <= b).length;
      const removals = [...deleted].filter(n => n >= a && n <= b).length;
      return additions + removals === 0 ? 'existing' : additions === b - a + 1 && removals === 0 ? 'new' : 'modified';
    };
    const functions = new Map(), functionNodes = new Set(), elements = new Map(), handlers = new Set();
    const deferred = [];
    const register = (name, fn, boundary = fn, ancestors = [], owner = '') => {
      if (!name || functionNodes.has(fn)) return;
      let id = `n-${hash(`${file}\0function\0${lineOf(boundary)}\0${boundary.start}`)}`;
      if (nodes.some(node => node.id === id)) id = `n-${hash(`${file}\0function\0${lineOf(boundary)}\0${boundary.start}\0${scriptIndex}`)}`;
      const part = { id, kind: 'function', symbol: name, file, line: lineOf(boundary), end: endOf(boundary), status: status(lineOf(boundary), endOf(boundary)) };
      if (!functions.has(name)) functions.set(name, []);
      const scope = [...ancestors].reverse().find(node => node.type === 'ClassBody' && name.startsWith('this.') || node.type === 'BlockStatement' || node.type === 'Program') ?? ast;
      functions.get(name).push({ ast: fn, part, owner, scope }); functionNodes.add(fn); nodes.push(part);
    };
    walk(ast, (n, ancestors) => {
      if (n.type === 'FunctionDeclaration' && n.id) register(n.id.name, n, n, ancestors);
      if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && /FunctionExpression|ArrowFunctionExpression/.test(n.init?.type ?? ''))
        register(n.id.name, n.init, n, ancestors);
      if (n.type === 'AssignmentExpression' && /FunctionExpression|ArrowFunctionExpression/.test(n.right?.type ?? '') && n.left.type === 'Identifier')
        register(n.left.name, n.right, n, ancestors);
      if (n.type === 'Property' && /FunctionExpression|ArrowFunctionExpression/.test(n.value?.type ?? '')) {
        const object = ancestors.at(-1);
        const declarator = ancestors.at(-2);
        const owner = object?.type === 'ObjectExpression' && declarator?.type === 'VariableDeclarator' ? declarator.id?.name : '';
        register(owner ? `${owner}.${src(n.key)}` : src(n.key), n.value, n, ancestors, owner);
      }
      if (n.type === 'MethodDefinition' && n.value) {
        const classNode = [...ancestors].reverse().find(a => /ClassDeclaration|ClassExpression/.test(a.type));
        register(`this.${src(n.key)}`, n.value, n, ancestors, classNode?.id?.name ?? '');
      }
      if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init?.type === 'CallExpression' && src(n.init.callee) === 'document.getElementById' && typeof n.init.arguments[0]?.value === 'string')
        elements.set(n.id.name, n.init.arguments[0].value);
      // Deferred callbacks form a separate processing unit. Synchronous callbacks remain in their owner.
      if (n.type === 'CallExpression') {
        const callee = src(n.callee);
        if (/(?:^|\.)addEventListener$/.test(callee) && n.arguments[1]) handlers.add(n.arguments[1]);
        const delayed = /(?:^|\.)(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask)$/.test(callee)
          || /\.(?:then|catch|finally)$/.test(callee);
        if (delayed && n.arguments[0]) {
          const callback = n.arguments[0];
          if (/FunctionExpression|ArrowFunctionExpression/.test(callback.type) && !functionNodes.has(callback)) {
            handlers.add(callback);
            deferred.push({ call: n, callback, api: callee.split('.').at(-1), delay: n.arguments[1] && /^(?:setTimeout|setInterval)$/.test(callee) ? safeSnippet(src(n.arguments[1])) : '' });
          }
        }
      }
      if (n.type === 'NewExpression' && /^(?:MutationObserver|ResizeObserver|IntersectionObserver)$/.test(src(n.callee)) && n.arguments[0]) {
        const callback = n.arguments[0];
        if (/FunctionExpression|ArrowFunctionExpression/.test(callback.type) && !functionNodes.has(callback)) {
          handlers.add(callback); deferred.push({ call: n, callback, api: src(n.callee), delay: '' });
        }
      }
      if (n.type === 'AssignmentExpression' && n.left?.type === 'MemberExpression' && /^on[a-z]+$/i.test(src(n.left.property))) handlers.add(n.right);
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
      const id = `e-${hash(`${from.id}\0${to.id}\0${file}\0${line}${access === 'trigger' ? '\0trigger' : ''}`)}`;
      if (!edges.some(e => e.id === id)) edges.push({ id, from: from.id, to: to.id, file, line, access,
        ...(access === 'call' ? { call: safeSnippet(src(n)).replace(/\s+/g, ' ') } : {}), status: changed.has(line) ? 'new' : 'existing' });
    };
    const resolveCall = (callee, at) => {
      const matches = (functions.get(callee) ?? []).filter(item => item.scope.start <= at.start && item.scope.end >= at.end);
      if (!matches.length) return undefined;
      const narrowest = Math.min(...matches.map(item => item.scope.end - item.scope.start));
      const visible = matches.filter(item => item.scope.end - item.scope.start === narrowest);
      return visible.length === 1 ? visible[0].part : undefined;
    };
    const deferredOwners = new Map();
    for (const { call, callback, api, delay } of deferred) {
      const symbol = `${api}${delay ? ` ${delay}ms` : ''} の処理`;
      const part = addNode('function', symbol, lineOf(callback), endOf(callback));
      part.deferred = true;
      deferredOwners.set(callback, part);
    }
    const scan = (owner, body) => walk(body, (n, ancestors) => {
      // Named functions are parts and handlers are entries; both are scanned on their own. An anonymous
      // callback (forEach, then, setTimeout, an immediately invoked function) belongs to the code around it.
      if (ancestors.some(a => a !== body && (functionNodes.has(a) || handlers.has(a)))) return;
      if (n.type === 'CallExpression') {
        const callee = src(n.callee);
        const target = resolveCall(callee, n);
        if (target && !/(?:^|\.)(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask)$/.test(callee)) addEdge(owner, target, n);
        if (/\blocalStorage\.(getItem|setItem)$/.test(callee)) addEdge(owner, addNode('storage', `localStorage ${n.arguments[0] ? safeSnippet(src(n.arguments[0])) : ''}`, lineOf(n)), n, callee.endsWith('.getItem') ? 'read' : 'write');
        const event = /(?:^|\.)addEventListener$/.test(callee);
        if (event) {
          const handler = n.arguments[1];
          if (!handler) return;
          const symbol = `${src(n.callee.object)} ${n.arguments[0] ? src(n.arguments[0]) : ''}`;
          const entry = addNode('entry', symbol, lineOf(n), endOf(n));
          entry.sourceLabel = typeof n.arguments[0]?.value === 'string' ? n.arguments[0].value : symbol;
          if (handler.type === 'Identifier') {
            const target = resolveCall(handler.name, n);
            addEdge(entry, target, n, 'trigger');
            const edge = edges.find(e => e.from === entry.id && e.to === target?.id);
            if (edge) edge.call = `${handler.name}()`;
          }
          else if (handler.body) scan(entry, handler.body);
        }
        const delayed = /(?:^|\.)(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask)$/.test(callee)
          || /\.(?:then|catch|finally)$/.test(callee);
        if (delayed && n.arguments[0]) {
          const callback = n.arguments[0];
          const target = deferredOwners.get(callback) ?? (callback.type === 'Identifier' ? resolveCall(callback.name, n) : undefined);
          if (target) addEdge(owner, target, n, 'trigger');
        }
      }
      if (n.type === 'NewExpression' && /^(?:MutationObserver|ResizeObserver|IntersectionObserver)$/.test(src(n.callee))) {
        const callback = n.arguments[0];
        const target = deferredOwners.get(callback) ?? (callback?.type === 'Identifier' ? resolveCall(callback.name, n) : undefined);
        if (target) addEdge(owner, target, n, 'trigger');
      }
      if (n.type === 'AssignmentExpression' && n.left?.type === 'MemberExpression' && /^on[a-z]+$/i.test(src(n.left.property))) {
        const handler = n.right;
        const entry = addNode('entry', `${src(n.left.object)} ${src(n.left.property)}`, lineOf(n));
        entry.sourceLabel = src(n.left.property).slice(2);
        if (handler.type === 'Identifier') addEdge(entry, resolveCall(handler.name, n), n);
        else if (handler.body && !functionNodes.has(handler)) scan(entry, handler.body);
      }
      if (n.type === 'AssignmentExpression' && n.left?.type === 'MemberExpression' && src(n.left.property) === 'textContent') {
        const element = elements.get(src(n.left.object));
        if (element) addEdge(owner, addNode('screen', `#${element}`, idLines.get(element) ?? lineOf(n)), n, 'display');
      }
    });
    for (const entries of functions.values()) for (const { ast: fn, part } of entries) scan(part, fn.body);
    for (const [callback, part] of deferredOwners) scan(part, callback.body);
    const page = addNode('entry', 'page load', offset + 1);
    scan(page, ast);
  }
  return parsedScripts.length > 0;
}

try {
  const input = JSON.parse(readFileSync(resolve(process.cwd(), process.argv[2] ?? 'input.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (input.schema !== 'poiesis-results-input/1') throw new Error('入力の形式が違います。');
  if (typeof input.workspace !== 'string' || !input.workspace) throw new Error('作業場所のパスが必要です。');
  const workspace = resolve(input.workspace);
  const diff = input.diff;
  if (typeof diff !== 'string') throw new Error('差分が必要です。');
  const { hunks, added, deleted, lineEndingChanges } = parseDiff(diff);
  const nodes = [], edges = [], skipped = [];
  let scriptTouched = false;
  for (const file of [...new Set(hunks.map(h => h.file))]) {
    if (!/\.(?:js|mjs|cjs|ts|mts|cts|jsx|tsx|html)$/i.test(file)) { skipped.push(file); continue; }
    const full = resolve(workspace, file), rel = relative(workspace, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(full)) { skipped.push(file); continue; }
    const actual = realpathSync(full), root = realpathSync(workspace), realRel = relative(root, actual);
    if (!realRel || realRel.startsWith('..') || isAbsolute(realRel)) { skipped.push(file); continue; }
    const source = readFileSync(full, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (/\.html?$/i.test(file)) for (const match of source.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)) {
      const start = source.slice(0, match.index).split('\n').length;
      const end = start + match[0].split('\n').length - 1;
      if ([...(added.get(file) ?? []), ...(deleted.get(file) ?? [])].some(line => line >= start && line <= end)) scriptTouched = true;
    }
    if (!analyzeFile(file, source, added.get(file) ?? new Set(), deleted.get(file) ?? new Set(), nodes, edges)) skipped.push(file);
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
  const initialIds = new Set(edges.filter(e => keepEdges.has(e.id)).flatMap(e => [e.from, e.to]));
  for (const edge of edges) if (edge.access === 'trigger' && initialIds.has(edge.to)) keepEdges.add(edge.id);
  const selectedEdges = edges.filter(e => keepEdges.has(e.id));
  const selectedIds = new Set(selectedEdges.flatMap(e => [e.from, e.to]));
  // Classify against the full syntax graph, before pruning candidates or AI selection.
  for (const node of nodes) {
    const out = outgoing.get(node.id) ?? [];
    node.helper = node.kind === 'function' && out.length === 0;
    node.outgoing = out.map(e => e.id);
  }
  const map = { nodes: nodes.filter(n => selectedIds.has(n.id) || (n.status !== 'existing' && n.kind !== 'entry')), edges: selectedEdges };
  const changedFunctions = nodes.filter(n => n.kind === 'function' && n.status !== 'existing' &&
    [...(added.get(n.file) ?? []), ...(deleted.get(n.file) ?? [])].some(line => line >= n.line && line <= n.end));
  const changedFiles = new Set(hunks.map(h => h.file));
  const unparsed = skipped.some(file => !/\.(?:css|md|txt|json|svg|png|jpe?g|gif|webp)$/i.test(file));
  const visualOnly = hunks.length > 0 && [...changedFiles].every(file => /\.(?:css|html?|md|txt)$/i.test(file))
    && changedFunctions.length === 0 && !scriptTouched && !unparsed;
  const captureError = Boolean(input.changeCaptureError);
  const deletionOnly = hunks.length > 0 && !hunks.some(h => h.lines.some(l => l.kind === 'add'));
  const reportedChange = hunks.length > 0 || lineEndingChanges > 0 || input.changedFiles?.length > 0;
  const mapDecision = captureError ? { kind: 'none', reason: '変更の記録に失敗したため、処理の地図は出しません。' }
    : deletionOnly ? { kind: 'none', reason: '削除だけの変更なので、処理の地図は出しません。' }
    : changedFunctions.length >= 2 ? { kind: 'map', reason: '変更は2つ以上の処理にまたがります。' }
    : visualOnly ? { kind: 'visual', reason: '見た目だけの変更なので、処理の地図は出しません。' }
    : unparsed ? { kind: 'none', reason: '解析できない変更を含むため、処理の地図は出しません。' }
    : changedFunctions.length === 1 ? { kind: 'none', reason: '変更は1つの関数の中だけなので、処理の地図は出しません。' }
    : { kind: 'none', reason: reportedChange ? '処理の単位を取り出せなかったため、処理の地図は出しません。' : '変更はありません。' };
  const brief = { nodes: map.nodes.map(({ id, kind, symbol, file, line, end, status }) => ({ id, kind, symbol, file, line, end, status })), edges: map.edges, hunks: hunks.map(({ id, file, start, count, lines }) => ({ id, file, start, count, excerpt: lines.slice(0, 3).map(l => l.text) })), lineEndingChanges };
  const briefing = JSON.stringify(brief);
  const result = { ok: true, workspace, map, mapDecision, hunks, skipped, lineEndingChanges, aiMaterial: briefing };
  writeFileSync(resolve(process.cwd(), 'prepared.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  output({ ok: true, prepared: 'prepared.json', candidates: map.nodes.length, arrows: map.edges.length, hunks: hunks.length, skipped: skipped.length });
} catch (error) { output({ ok: false, reasons: [`準備に失敗しました: ${error.message}`] }); process.exitCode = 1; }
