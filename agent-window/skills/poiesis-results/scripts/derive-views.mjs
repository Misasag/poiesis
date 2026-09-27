// Syntax derived data, ordered entry flows, and read-modify-write evidence.
// This module never takes diagram structure from the agent's draft.
import * as acorn from './vendor/acorn.mjs';

export function deriveViews(source, diff, file) {
source = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
diff = diff.replace(/\r\n/g, '\n');

const added = new Set();
{
  let cur = null, n = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) { cur = line.slice(6); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { n = +h[1]; continue; }
    if (cur !== file || line.startsWith('--- ')) continue;
    if (line[0] === '+') added.add(n++);
    else if (line[0] === ' ') n++;
  }
}

const m = /\.html?$/i.test(file) ? /<script\b[^>]*>([\s\S]*?)<\/script\s*>/i.exec(source) : null;
if (/\.html?$/i.test(file) && !m) return null;
const code = m ? m[1] : source;
const offset = m ? source.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length - 1 : 0;
let ast;
try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true }); }
catch { return null; }
const L = n => n.loc.start.line + offset;
const src = n => code.slice(n.start, n.end).replace(/\s+/g, ' ');

let moduleBody = ast.body;
if (ast.body.length === 1 && ast.body[0].type === 'ExpressionStatement') {
  const e = ast.body[0].expression;
  if (e.type === 'CallExpression' && /Function/.test(e.callee.type)) moduleBody = e.callee.body.body;
}
const functions = new Map(), moduleVars = new Map(), elements = new Map();
for (const st of moduleBody) {
  if (st.type === 'FunctionDeclaration') functions.set(st.id.name, st);
  if (st.type === 'VariableDeclaration') for (const d of st.declarations) {
    if (d.id.type !== 'Identifier') continue;
    moduleVars.set(d.id.name, { kind: st.kind, init: d.init, line: L(d) });
    if (d.init?.type === 'CallExpression' && src(d.init.callee) === 'document.getElementById') elements.set(d.id.name, '#' + d.init.arguments[0].value);
    if (d.init && /querySelectorAll/.test(src(d.init))) elements.set(d.id.name, src(d.init).match(/querySelectorAll\("([^"]+)"\)/)?.[1] ?? 'elements');
  }
}
const isConstData = mv => mv.kind === 'const' && ['Literal', 'ObjectExpression'].includes(mv.init?.type);
const isState = name => moduleVars.has(name) && !elements.has(name) && !isConstData(moduleVars.get(name));

const units = new Map();
const registrations = [];
function unitFor(name, node, kind, parent = null, extra = {}) {
  const u = { name, kind, node, parent, ...extra, params: (node.params ?? []).map(p => p.type === 'AssignmentPattern' ? p.left.name : p.name), steps: [], locals: new Map(), returns: [], line: L(node) };
  units.set(name, u);
  return u;
}
// closure lookup: own locals/params, then enclosing units (not the module page unit for function declarations)
function lookup(u, name) {
  for (let x = u; x; x = x.parent) {
    if (x.locals.has(name)) return { owner: x, local: x.locals.get(name) };
    if (x.params.includes(name)) return { owner: x, param: true };
  }
  return null;
}
const isLocal = (u, name) => !!lookup(u, name) && lookup(u, name).owner.kind !== 'entry';

function walk(node, u, guards) {
  if (!node || typeof node !== 'object') return;
  const g = guards;
  const push = s => u.steps.push({ ...s, line: s.line ?? L(node), guards: g.map(x => x.text) });
  switch (node.type) {
    case 'FunctionDeclaration': return;
    case 'ExpressionStatement': return walk(node.expression, u, g);
    case 'BlockStatement': case 'Program': for (const s of node.body) walk(s, u, g); return;
    case 'VariableDeclaration':
      for (const d of node.declarations) { walk(d.init, u, g); if (d.id.type === 'Identifier') u.locals.set(d.id.name, { init: d.init, line: L(d) }); }
      return;
    case 'ReturnStatement': walk(node.argument, u, g); if (node.argument) u.returns.push(node.argument); return;
    case 'IfStatement':
      walk(node.test, u, g);
      walk(node.consequent, u, [...g, { text: `if ${src(node.test)}` }]);
      if (node.alternate) walk(node.alternate, u, [...g, { text: `else of ${src(node.test)}` }]);
      return;
    case 'TryStatement': walk(node.block, u, [...g, { text: 'try' }]); if (node.handler) walk(node.handler.body, u, [...g, { text: 'catch' }]); return;
    case 'ConditionalExpression': walk(node.test, u, g); walk(node.consequent, u, [...g, { text: `? ${src(node.test)}` }]); walk(node.alternate, u, [...g, { text: `: not ${src(node.test)}` }]); return;
    case 'LogicalExpression': walk(node.left, u, g); walk(node.right, u, [...g, { text: `${node.operator} after ${src(node.left)}` }]); return;
    case 'AssignmentExpression': {
      walk(node.right, u, g);
      const left = node.left;
      if (left.type === 'Identifier') {
        const found = lookup(u, left.name);
        if (found && found.owner.kind !== 'entry') found.owner.locals.set(left.name + '#' + L(node), { init: node.operator === '=' ? node.right : node, line: L(node), assignTo: left.name });
        else if (isState(left.name)) push({ type: 'state', op: 'write', name: left.name, text: src(node).slice(0, 60), node });
      } else if (left.type === 'MemberExpression') {
        walk(left.object, u, g);
        const obj = src(left.object);
        if (elements.has(obj)) push({ type: 'dom', element: elements.get(obj), prop: src(left.property) });
        else if (obj === 'document') push({ type: 'dom', element: 'document', prop: src(left.property) });
      }
      return;
    }
    case 'UpdateExpression': if (node.argument.type === 'Identifier' && isState(node.argument.name)) push({ type: 'state', op: 'write', name: node.argument.name, text: src(node), node }); return;
    case 'Identifier':
      if (isState(node.name) && !isLocal(u, node.name)) push({ type: 'state', op: 'read', name: node.name });
      return;
    case 'MemberExpression': walk(node.object, u, g); if (node.computed) walk(node.property, u, g); return;
    case 'CallExpression': case 'NewExpression': {
      const callee = node.callee, c = src(callee);
      if (callee.type === 'MemberExpression' && !(callee.object.type === 'Identifier' && isState(callee.object.name))) walk(callee.object, u, g);
      const isRegister = /(?:^|\.)addEventListener$/.test(c) || /(?:^|\.)set(?:Interval|Timeout)$/.test(c);
      const isForEach = /\.forEach$/.test(c);
      node.arguments.forEach(a => {
        if (/Function/.test(a.type)) {
          if (isForEach) walk(a.body, u, [...g, { text: `each ${src(callee.object)}` }]);
          else if (!isRegister) {
            // callback of an API we do not model: runs later (or maybe never); keep it as a deferred unit
            const name = `[callback of ${c} ${L(a)}]`;
            const lock = /(?:^|\.)locks\.request$/.test(c) ? src(node.arguments[0]) : null;
            const cu = unitFor(name, a, 'callback', u, { api: c, lock });
            walk(a.body.type === 'BlockStatement' ? a.body : { type: 'ExpressionStatement', expression: a.body, loc: a.body.loc }, cu, []);
            if (a.body.type !== 'BlockStatement') cu.returns.push(a.body);
            push({ type: 'deferred', callee: name, api: c, lock });
          }
          return;
        }
        walk(a, u, g);
      });
      if (functions.has(c)) push({ type: 'call', callee: c, args: node.arguments, text: src(node) });
      else if (/\blocalStorage\.(getItem|setItem|removeItem)$/.test(c)) push({ type: 'storage', op: c.endsWith('getItem') ? 'read' : 'write', keyExpr: node.arguments[0], valueExpr: node.arguments[1], text: src(node) });
      else if (isRegister) {
        const ev = /addEventListener$/.test(c);
        const handler = node.arguments[ev ? 1 : 0];
        const target = ev ? src(callee.object) : 'window';
        const label = ev ? `${elements.get(target) ?? target} ${node.arguments[0].value}` : `${c.split('.').pop()} ${src(node.arguments[1])}ms`;
        let hname;
        if (handler.type === 'Identifier') hname = handler.name;
        else { hname = `[${label} handler ${L(handler)}]`; const hu = unitFor(hname, handler, 'handler', u.kind === 'entry' ? null : u); walk(handler.body, hu, []); }
        registrations.push({ entry: label, target, event: ev ? node.arguments[0].value : 'timer', handler: hname, registeredIn: u.name, line: L(node) });
        push({ type: 'register', entry: label, handler: hname });
      } else if (callee.type === 'MemberExpression' && src(callee.property) === 'click' && node.arguments.length === 0) {
        push({ type: 'emit', target: src(callee.object), event: 'click' });
      } else if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && isState(callee.object.name)) {
        push({ type: 'state', op: /^(get|has)$/.test(src(callee.property)) ? 'read' : 'write', name: callee.object.name, text: src(node) });
      } else if (callee.type === 'MemberExpression' && elements.has(src(callee.object)) && src(callee.property) === 'setAttribute') {
        push({ type: 'dom', element: elements.get(src(callee.object)), prop: `attr ${node.arguments[0]?.value}` });
      }
      return;
    }
    case 'ArrowFunctionExpression': case 'FunctionExpression': return;
    default:
      for (const [k, v] of Object.entries(node)) {
        if (k === 'loc' || k === 'type') continue;
        if (Array.isArray(v)) v.forEach(x => x && typeof x.type === 'string' && walk(x, u, g));
        else if (v && typeof v.type === 'string') walk(v, u, g);
      }
  }
}
const page = unitFor('[page load]', { params: [], loc: moduleBody[0].loc }, 'entry');
for (const [name, fn] of functions) unitFor(name, fn, 'function');
for (const [name, fn] of functions) walk(fn.body, units.get(name), []);
for (const st of moduleBody) walk(st, page, []);

// ---- symbolic key resolution: parts carry instance origin, recomputation signature and family ----
function resolveExpr(expr, u, bind, depth = 0) {
  const opaque = () => [{ hole: src(expr).slice(0, 40), origin: `${u.name}@${L(expr)}`, sig: src(expr), family: '*' }];
  if (!expr || depth > 8) return [{ hole: '?', origin: '?', sig: '?', family: '*' }];
  switch (expr.type) {
    case 'Literal': return [{ lit: String(expr.value) }];
    case 'TemplateLiteral': {
      const out = [];
      expr.quasis.forEach((q, i) => { if (q.value.cooked) out.push({ lit: q.value.cooked }); const e = expr.expressions[i]; if (e) out.push({ hole: src(e).slice(0, 40), origin: `${u.name}@${L(e)}`, sig: src(e), family: '*' }); });
      return out;
    }
    case 'BinaryExpression': if (expr.operator === '+') return [...resolveExpr(expr.left, u, bind, depth + 1), ...resolveExpr(expr.right, u, bind, depth + 1)]; return opaque();
    case 'Identifier': {
      if (bind.has(expr.name)) return bind.get(expr.name);
      const f = lookup(u, expr.name);
      if (f?.local?.init && f.owner.kind !== 'entry') return resolveExpr(f.local.init, f.owner, bind, depth + 1).map(p => p.lit !== undefined ? p : { ...p, origin: `${f.owner.name}.${expr.name}` });
      if (f?.param) return [{ hole: expr.name, origin: `${f.owner.name}.param.${expr.name}`, sig: expr.name, family: `param ${expr.name}` }];
      const mv = moduleVars.get(expr.name);
      if (mv?.kind === 'const' && mv.init?.type === 'Literal') return [{ lit: String(mv.init.value) }];
      if (mv?.kind === 'const' && mv.init) return resolveExpr(mv.init, page, bind, depth + 1).map(p => p.lit !== undefined ? p : { ...p, origin: `module.${expr.name}` });
      return [{ hole: expr.name, origin: `module.${expr.name}`, sig: expr.name, family: '*' }];
    }
    case 'CallExpression': {
      const c = src(expr.callee);
      if (functions.has(c) && units.get(c).returns.length === 1) {
        const callee = units.get(c);
        const b = new Map(callee.params.map((p, i) => [p, expr.arguments[i] ? resolveExpr(expr.arguments[i], u, bind, depth + 1) : [{ hole: `${p} (default)`, origin: `${c}.default.${p}`, sig: 'default', family: '*' }]]));
        const shape = resolveExpr(callee.returns[0], callee, b, depth + 1);
        const argSig = expr.arguments.map(a => resolveExpr(a, u, bind, depth + 1).map(p => p.lit !== undefined ? JSON.stringify(p.lit) : p.sig).join('+')).join(', ');
        return [{ hole: `${c}()`, origin: `${u.name}@${L(expr)}:${c}`, sig: `${c}(${argSig})`, family: `${c}()`, shape: shape.map(p => p.lit ?? '…').join('') }];
      }
      return opaque();
    }
  }
  return opaque();
}
function keyInstance(expr, u, bind) {
  const parts = resolveExpr(expr, u, bind);
  return {
    instance: parts.map(p => p.lit ?? `{${p.origin}}`).join(''),
    sig: parts.map(p => p.lit ?? `{${p.sig}}`).join(''),
    family: parts.map(p => p.lit ?? `{${p.family}}`).join(''),
    shape: parts.map(p => p.lit ?? (p.shape ? `{${p.family} = ${p.shape}}` : `{${p.hole}}`)).join(''),
  };
}
function bindArgs(callee, args, u, bind) {
  return new Map(callee.params.map((p, i) => {
    const a = args[i];
    if (!a) return [p, [{ hole: `${p} (default)`, origin: `${callee.name}.default.${p}`, sig: 'default', family: '*' }]];
    const parts = resolveExpr(a, u, bind);
    if (a.type === 'Identifier') { const f = lookup(u, a.name); if (f?.local && f.owner.kind !== 'entry') return [p, parts.map(x => x.lit !== undefined ? x : { ...x, origin: `${f.owner.name}.${a.name}` })]; }
    return [p, parts];
  }));
}

// ---- time flow: inline expansion from each entry ----
function expand(unitName, bind, depth, stack, out, lock) {
  const u = units.get(unitName);
  if (!u || stack.includes(unitName) || depth > 9) return;
  for (const s of u.steps) {
    const base = { depth, unit: unitName, line: s.line, guards: s.guards, changed: added.has(s.line), lock };
    if (s.type === 'call') {
      out.push({ ...base, kind: 'call', text: `${s.callee}()` });
      expand(s.callee, bindArgs(units.get(s.callee), s.args, u, bind), depth + 1, [...stack, unitName], out, lock);
    } else if (s.type === 'deferred') {
      out.push({ ...base, kind: 'deferred', text: `later via ${s.api}${s.lock ? ` (Web Lock ${s.lock})` : ''}` });
      expand(s.callee, bind, depth + 1, [...stack, unitName], out, s.lock ?? lock);
    } else if (s.type === 'storage') {
      const k = keyInstance(s.keyExpr, u, bind);
      out.push({ ...base, kind: `storage-${s.op}`, text: `localStorage ${s.op} ${k.shape}`, key: k });
    } else if (s.type === 'emit') {
      for (const r of registrations.filter(r => r.target === s.target && r.event === s.event)) {
        out.push({ ...base, kind: 'emit', text: `${s.target}.click() -> ${r.entry}` });
        expand(r.handler, new Map(), depth + 1, [...stack, unitName], out, lock);
      }
    } else if (s.type === 'state') out.push({ ...base, kind: `state-${s.op}`, text: `${s.op} ${s.name}` });
    else if (s.type === 'dom') out.push({ ...base, kind: 'dom-write', text: `write ${s.element}.${s.prop}` });
    else if (s.type === 'register') out.push({ ...base, kind: 'register', text: `register ${s.entry}` });
  }
}
const entries = [{ entry: 'page load', handler: '[page load]', line: offset + 1, registeredIn: '-' }, ...registrations];
const flows = entries.map(e => { const out = []; expand(e.handler, new Map(), 0, [], out, null); return { ...e, steps: out, touchesChange: out.some(s => s.changed) }; });

// ---- data/state view ----
const keyTable = new Map();
for (const f of flows) for (const s of f.steps) if (s.kind.startsWith('storage-')) {
  const row = keyTable.get(s.key.family) ?? { family: s.key.family, shape: s.key.shape, writers: new Set(), readers: new Set(), writeEntries: new Set(), readEntries: new Set(), changed: false };
  (s.kind === 'storage-write' ? row.writers : row.readers).add(`${s.unit} ${s.line}`);
  (s.kind === 'storage-write' ? row.writeEntries : row.readEntries).add(f.entry);
  row.changed ||= s.changed; keyTable.set(s.key.family, row);
}
// storage sites never reached from any entry (e.g. callbacks we could not attach): report instead of dropping
const reachedSites = new Set(flows.flatMap(f => f.steps.filter(s => s.kind.startsWith('storage-')).map(s => s.line)));
const unreached = [...units.values()].flatMap(u => u.steps.filter(s => s.type === 'storage' && !reachedSites.has(s.line)).map(s => `${u.name} L${s.line} ${s.op}`));
const stateTable = new Map();
for (const u of units.values()) for (const s of u.steps) if (s.type === 'state') {
  const mv = moduleVars.get(s.name);
  const row = stateTable.get(s.name) ?? { name: s.name, declaredLine: mv.line, declaredNew: added.has(mv.line), initReadsStorage: /localStorage\.getItem/.test(mv.init ? src(mv.init) : ''), writers: new Set(), readers: new Set(), touchedByChange: false };
  (s.op === 'write' ? row.writers : row.readers).add(`${u.name} ${s.line}`);
  row.touchedByChange ||= added.has(s.line) || row.declaredNew; stateTable.set(s.name, row);
}

// ---- concurrency view ----
// read taint per unit: which storage reads flow into locals / return value; module vars initialised from storage are "read at load"
const readTaint = new Map();
const tokenOf = o => JSON.stringify(o);
function exprReads(expr, u, t) {
  const out = new Set();
  const visit = n => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'Identifier') {
      const f = lookup(u, n.name);
      if (f && f.owner.kind !== 'entry') readTaint.get(f.owner.name)?.vars.get(n.name)?.forEach(x => out.add(x));
      else if (moduleVars.has(n.name)) readTaint.get('[page load]')?.vars.get(n.name)?.forEach(x => out.add(tokenOf({ ...JSON.parse(x), atLoad: true })));
    }
    if (n.type === 'CallExpression') {
      const c = src(n.callee);
      if (/\blocalStorage\.getItem$/.test(c)) out.add(tokenOf({ unit: u.name, keyExpr: [n.arguments[0].start, n.arguments[0].end] }));
      if (functions.has(c)) for (const r of (readTaint.get(c)?.ret ?? [])) out.add(tokenOf({ via: c, callUnit: u.name, callArgs: n.arguments.map(a => [a.start, a.end]), inner: r }));
    }
    for (const [k, v] of Object.entries(n)) { if (k === 'loc') continue; if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === 'string' && !/Function/.test(v.type)) visit(v); }
  };
  visit(expr);
  return out;
}
for (let iter = 0; iter < 8; iter++) for (const u of units.values()) {
  const t = readTaint.get(u.name) ?? { vars: new Map(), ret: new Set() };
  readTaint.set(u.name, t);
  for (const [k, v] of u.locals) {
    const name = v.assignTo ?? k;
    const s = exprReads(v.init, u, t);
    if (s.size) { const cur = t.vars.get(name) ?? new Set(); s.forEach(x => cur.add(x)); t.vars.set(name, cur); }
  }
  for (const r of u.returns) exprReads(r, u, t).forEach(x => t.ret.add(x));
}
function findNode([s, e]) { let found; const v = n => { if (!n || typeof n !== 'object' || found) return; if (n.start === s && n.end === e && n.type) { found = n; return; } for (const [k, x] of Object.entries(n)) { if (k === 'loc') continue; if (Array.isArray(x)) x.forEach(v); else if (x && typeof x.type === 'string') v(x); } }; v(ast); return found; }
function tokenKey(tok) {
  const o = JSON.parse(tok);
  if (o.keyExpr) return { key: keyInstance(findNode(o.keyExpr), units.get(o.unit), new Map()), atLoad: !!o.atLoad, via: 'direct' };
  const callee = units.get(o.via), cu = units.get(o.callUnit);
  const b = bindArgs(callee, o.callArgs.map(findNode), cu, new Map());
  const inner = JSON.parse(o.inner);
  return { key: keyInstance(findNode(inner.keyExpr), units.get(inner.unit), b), atLoad: !!o.atLoad, via: o.via };
}
function incrementIn(expr, u, depth = 0) {
  if (!expr || depth > 4) return false;
  if (/(\+\s*1\b|\+\+|\+=\s*1\b)/.test(src(expr))) return true;
  let hit = false;
  const visit = n => { if (!n || typeof n !== 'object' || hit) return; if (n.type === 'Identifier') { const f = lookup(u, n.name); const defs = f ? [...f.owner.locals.entries()].filter(([k, v]) => k === n.name || v.assignTo === n.name).map(([, v]) => v.init) : []; if (moduleVars.has(n.name) && !f) defs.push(...[...units.values()].flatMap(x => x.steps.filter(s => s.type === 'state' && s.op === 'write' && s.name === n.name).map(s => s.node))); if (defs.some(d => d && incrementIn(d, f?.owner ?? u, depth + 1))) hit = true; } for (const [k, v] of Object.entries(n)) { if (k === 'loc') continue; if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === 'string') visit(v); } };
  visit(expr);
  return hit;
}
const rmw = [];
for (const u of units.values()) for (const s of u.steps) if (s.type === 'storage' && s.op === 'write') {
  const wk = keyInstance(s.keyExpr, u, new Map());
  const seen = new Set();
  for (const tok of exprReads(s.valueExpr, u, readTaint.get(u.name))) {
    const r = tokenKey(tok);
    const tier = r.key.instance === wk.instance ? 'same variable' : r.key.sig === wk.sig ? 'same expression (recomputed)' : r.key.family === wk.family && !wk.family.includes('{*}') ? 'same key family' : null;
    if (!tier || seen.has(tier + r.atLoad)) continue;
    seen.add(tier + r.atLoad);
    let lock = null; for (let x = u; x; x = x.parent) if (x.lock) lock = x.lock;
    rmw.push({ unit: u.name, writeLine: s.line, key: wk, readVia: r.via, tier, pattern: r.atLoad ? 'value read at page load, written back later' : 'read and write in one run', increment: incrementIn(s.valueExpr, u), lock });
  }
}
for (const r of rmw) {
  r.entries = flows.filter(f => f.steps.some(s => s.unit === r.unit && s.line === r.writeLine)).map(f => ({ entry: f.entry, registeredIn: f.registeredIn, path: pathTo(f, r) }));
  r.crossTabStorageListeners = registrations.filter(x => x.event === 'storage').map(x => `${x.entry} -> ${x.handler}`);
}
function pathTo(f, r) {
  const i = f.steps.findIndex(s => s.unit === r.unit && s.line === r.writeLine);
  const chain = []; let d = f.steps[i].depth;
  for (let j = i; j >= 0; j--) if (f.steps[j].depth < d && ['call', 'emit', 'deferred'].includes(f.steps[j].kind)) { chain.unshift(`${f.steps[j].text}@${f.steps[j].line}${f.steps[j].guards.length ? ` [${f.steps[j].guards.filter(x => x !== 'try').join(' / ')}]` : ''}`); d = f.steps[j].depth; }
  return chain.join(' > ');
}

// Prune each route to changed steps, storage actions, and the calls needed to reach them.
function prune(steps) {
  const keep = new Set();
  steps.forEach((s, i) => { if ((s.changed && s.kind !== 'state-read') || s.kind.startsWith('storage-')) keep.add(i); });
  for (const i of [...keep]) { let d = steps[i].depth; for (let j = i - 1; j >= 0 && d > 0; j--) if (steps[j].depth < d && ['call', 'emit', 'deferred'].includes(steps[j].kind)) { keep.add(j); d = steps[j].depth; } }
  return [...keep].sort((a, b) => a - b);
}
// A state view is selected from string-valued module state and the guarded route
// to a changed call. Calls into a setter supply destinations; guards supply origins.
function deriveStateMachines() {
  const machines = [];
  const literalValues = (expr, u, depth = 0) => {
    if (!expr || depth > 5) return [];
    if (expr.type === 'Literal' && typeof expr.value === 'string') return [expr.value];
    if (expr.type === 'ConditionalExpression') return [...new Set([
      ...literalValues(expr.consequent, u, depth + 1), ...literalValues(expr.alternate, u, depth + 1)])];
    if (expr.type === 'Identifier') {
      const local = lookup(u, expr.name);
      if (local?.local?.init) return literalValues(local.local.init, local.owner, depth + 1);
    }
    return [];
  };
  for (const [name, variable] of moduleVars) {
    if (variable.init?.type !== 'Literal' || typeof variable.init.value !== 'string') continue;
    const setters = [...units.values()].filter(u => u.steps.some(s => s.type === 'state' && s.op === 'write' && s.name === name));
    if (!setters.length) continue;
    const calls = [...units.values()].flatMap(u => u.steps.filter(s => s.type === 'call' && setters.some(setter => setter.name === s.callee))
      .map(step => ({ unit: u, step })));
    const values = new Set([variable.init.value]);
    for (const setter of setters) for (const step of setter.steps.filter(s => s.type === 'state' && s.op === 'write' && s.name === name))
      literalValues(step.node?.right, setter).forEach(value => values.add(value));
    for (const { unit, step } of calls) literalValues(step.args?.[0], unit).forEach(value => values.add(value));
    if (values.size < 2) continue;
    const guardedChange = flows.some(flow => flow.steps.some(step => step.changed &&
      step.guards.some(guard => guard.includes(name) && /===|!==/.test(guard))));
    if (!guardedChange) continue;
    const stateValues = [...values];
    const fromGuard = guards => {
      for (const guard of guards) {
        const match = new RegExp(`\\b${name}\\s*(===|!==)\\s*(["'])(.*?)\\2`).exec(guard);
        if (!match || !values.has(match[3])) continue;
        const equal = (match[1] === '===') !== guard.startsWith('else of ');
        return equal ? [match[3]] : stateValues.filter(value => value !== match[3]);
      }
      return stateValues;
    };
    const transitions = calls.map(({ unit, step }) => {
      const targets = literalValues(step.args?.[0], unit);
      const sources = fromGuard(step.guards);
      const earlier = unit.steps.filter(other => other.type === 'call' && other.line < step.line && added.has(other.line) &&
        other.guards.some(guard => guard.includes(name) && /===|!==/.test(guard)) &&
        fromGuard(other.guards).some(value => sources.includes(value)));
      const entries = flows.filter(flow => flow.steps.some(item => item.kind === 'call' && item.line === step.line &&
        item.text === `${step.callee}()`)).map(flow => ({ entry: flow.entry, line: flow.line }));
      return { line: step.line, setterLine: setters.find(setter => setter.name === step.callee)?.line,
        from: sources, to: targets.length ? targets : stateValues,
        dynamicTarget: !targets.length, main: earlier.length > 0,
        throughLine: earlier[0]?.line ?? null, entries };
    }).filter(item => item.from.length && item.to.length);
    if (transitions.length) machines.push({ variable: name, declarationLine: variable.line,
      states: stateValues.map(value => ({ value, line: variable.line })), transitions });
  }
  return machines;
}
const stateMachines = deriveStateMachines();
return {
  registrations,
  entries: flows.map(f => ({ entry: f.entry, handler: f.handler, line: f.line, registeredIn: f.registeredIn,
    touchesChange: f.touchesChange, steps: f.touchesChange ? prune(f.steps).map(i => {
      const { key, ...step } = f.steps[i]; return { ...step, key: key?.shape };
    }) : [] })),
  keys: [...keyTable.values()].map(r => ({ shape: r.shape, family: r.family, writers: [...r.writers], readers: [...r.readers],
    writeEntries: [...r.writeEntries], readEntries: [...r.readEntries], changed: r.changed })),
  unreached,
  state: [...stateTable.values()].filter(r => r.touchedByChange).map(r => ({ ...r, writers: [...r.writers], readers: [...r.readers] })),
  rmw,
  stateMachines,
};
}
