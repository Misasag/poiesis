import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { command, fail, git, inside, json, read, redactor, required, safeId, write } from './util.mjs';

const states = ['未着手', '実行中', '確定'];
const sha = value => createHash('sha256').update(value).digest('hex');
const iso = () => new Date().toISOString();
const rel = value => value.replaceAll('\\', '/');
const scalar = value => value === null ? 'null' : JSON.stringify(String(value));

function parseDocument(file) {
  const source = read(file).replaceAll('\r\n', '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const field = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!field) fail(`Invalid frontmatter field: ${file}`);
    let value = field[2];
    if (value === 'null') value = null;
    else if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { fail(`Invalid frontmatter value: ${file}`); }
    }
    meta[field[1]] = value;
  }
  return { meta, body: match[2] };
}

function document(meta, body) {
  return `---\n${Object.entries(meta).map(([key, value]) => `${key}: ${scalar(value)}`).join('\n')}\n---\n${body.replace(/^\n*/, '')}`;
}

function section(body, name) {
  const lines = body.split('\n'), start = lines.findIndex(line => line.trim() === `## ${name}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

function paths(ctx) {
  return {
    intent: path.join(ctx.data, 'intent'),
    tickets: path.join(ctx.data, 'tickets'),
    journal: path.join(ctx.data, 'journal'),
    evidence: path.join(ctx.data, 'evidence')
  };
}

function ticketFile(ctx, id) { return inside(paths(ctx).tickets, `${safeId(id)}.md`); }
function journalFile(ctx, id) { return inside(paths(ctx).journal, `${safeId(id)}.md`); }
function evidenceFile(ctx, id) { return inside(paths(ctx).evidence, `${safeId(id)}.jsonl`); }

function criteriaFromBody(body) {
  const block = section(body, '受け入れ条件');
  const result = [];
  let current;
  for (const line of block.split('\n')) {
    const heading = /^- \[(\d+)\] (.+)$/.exec(line);
    if (heading) {
      current = { number: Number(heading[1]), text: heading[2] };
      result.push(current);
      continue;
    }
    const field = /^  - (kind|check|human|status|approved_at|approved_quote|approved_hash|approved_criterion_hash): (.*)$/.exec(line);
    if (field && current) {
      let value = field[2];
      if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { fail('Invalid criterion value'); } }
      current[field[1]] = value;
    }
  }
  return result;
}

function criteriaBody(criteria) {
  return criteria.map((criterion, index) => {
    const lines = [`- [${index + 1}] ${criterion.text}`, `  - kind: ${criterion.kind}`];
    if (criterion.kind === '得意') lines.push(`  - check: ${scalar(criterion.check)}`);
    else lines.push(`  - human: ${scalar(criterion.human)}`);
    lines.push(`  - status: ${criterion.status}`);
    for (const key of ['approved_at', 'approved_quote', 'approved_hash', 'approved_criterion_hash']) if (criterion[key]) lines.push(`  - ${key}: ${scalar(criterion[key])}`);
    return lines.join('\n');
  }).join('\n');
}

function readTicket(ctx, id) {
  const file = ticketFile(ctx, id);
  if (!fs.existsSync(file)) fail(`Ticket unavailable: ${id}`);
  const ticket = parseDocument(file);
  ticket.criteria = criteriaFromBody(ticket.body);
  ticket.file = file;
  return ticket;
}

function saveTicket(ticket) {
  const lines = ticket.body.split('\n'), start = lines.findIndex(line => line.trim() === '## 受け入れ条件');
  if (start < 0) fail('Ticket has no acceptance criteria section');
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const before = lines.slice(0, start).join('\n').trimEnd();
  const after = end < 0 ? '' : lines.slice(end).join('\n').trimStart();
  write(ticket.file, document(ticket.meta, `${before}\n\n## 受け入れ条件\n${criteriaBody(ticket.criteria)}\n\n${after}`));
}

async function changeSet(ctx) {
  const head = (await git(ctx.root, ['rev-parse', 'HEAD'])).stdout.trim();
  const tracked = await git(ctx.root, ['diff', '--name-only', '--no-renames', '-z', 'HEAD']);
  const untracked = await git(ctx.root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const names = [...new Set((tracked.stdout + untracked.stdout).split('\0').filter(name => name && !rel(name).startsWith('.harness/')))].sort();
  const files = {};
  for (const name of names) {
    const file = path.join(ctx.root, name);
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      files[rel(name)] = stat.isSymbolicLink() ? sha(fs.readlinkSync(file)) : stat.isFile() ? sha(fs.readFileSync(file)) : 'directory';
    } else files[rel(name)] = 'deleted';
  }
  return { head, files, hash: sha(JSON.stringify({ head, files })) };
}

function baselineFiles(ticket) {
  try { return JSON.parse(Buffer.from(ticket.meta.baseline_files ?? '', 'base64url').toString('utf8')); }
  catch { return {}; }
}

function delta(ticket, change) {
  const before = baselineFiles(ticket);
  return [...new Set([...Object.keys(before), ...Object.keys(change.files)])].filter(name => before[name] !== change.files[name]).sort();
}

function allowed(name, patterns) {
  return patterns.some(pattern => {
    const p = rel(pattern).replace(/^\.\//, '').replace(/\/$/, '');
    return p === '.' || name === p || name.startsWith(`${p}/`) || (p.endsWith('/**') && name.startsWith(p.slice(0, -3) + '/'));
  });
}

function scope(ticket, change) {
  const patterns = (ticket.meta.allowed_paths ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const changed = ticket.meta.baseline ? delta(ticket, change) : [];
  return { id: ticket.meta.id, baseline: ticket.meta.baseline, current: `${change.head}:${change.hash}`,
    head_changed: Boolean(ticket.meta.baseline) && !ticket.meta.baseline.startsWith(`${change.head}:`),
    changed, outside: changed.filter(name => !allowed(name, patterns)), allowed_paths: patterns };
}

function evidence(ctx, id) {
  const file = evidenceFile(ctx, id);
  if (!fs.existsSync(file)) return [];
  return read(file).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function criterionHash(c) { return sha(JSON.stringify({ text: c.text, kind: c.kind, check: c.check ?? null, human: c.human ?? null })); }

function effective(criterion, records, hash) {
  if (criterion.kind === '苦手') return criterion.approved_hash ? criterion.approved_hash === hash && criterion.approved_criterion_hash === criterionHash(criterion) ? '合格' : '古い' : '未実行';
  const last = records.filter(record => record.criterion === criterion.number).at(-1);
  if (!last) return '未実行';
  if (last.change_set_hash !== hash || last.criterion_hash !== criterionHash(criterion)) return '古い';
  return last.status;
}

function listTickets(ctx) {
  const dir = paths(ctx).tickets;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.md')).sort().map(name => readTicket(ctx, name.slice(0, -3)));
}

function brief(value, limit = 420) { return value.replace(/\s+/g, ' ').trim().slice(0, limit); }

async function status(ctx) {
  const change = await changeSet(ctx), all = listTickets(ctx), active = all.filter(t => t.meta.state !== '確定');
  const rootFile = path.join(paths(ctx).intent, 'root.md');
  const candidate = active.map(t => path.join(paths(ctx).intent, `${t.meta.parent ?? t.meta.id}.md`)).find(file => fs.existsSync(file));
  const intentFile = candidate ?? rootFile;
  const selected = fs.existsSync(intentFile) ? parseDocument(intentFile) : null;
  const root = fs.existsSync(rootFile) ? parseDocument(rootFile) : null;
  const request = selected ? section(selected.body, '原依頼') : '';
  const intent = selected ? { file: intentFile, version: selected.meta.version ?? null, approved_version: selected.meta.approved_version ?? null,
    approved: Boolean(selected.meta.approved_version) && selected.meta.approved_version === sha(selected.body),
    stale: Boolean(selected.meta.approved_version) && selected.meta.approved_version !== sha(selected.body) } : null;
  const mismatches = [];
  if (intent?.stale) mismatches.push('intent approval is older than its body');
  if (intent?.version && intent.version !== sha(selected.body)) mismatches.push('intent version differs from its body');
  if (candidate && root?.meta.approved_version && root.meta.approved_version !== sha(root.body)) mismatches.push('root intent approval is older than its body');
  const tickets = active.map(ticket => {
    const s = scope(ticket, change), records = evidence(ctx, ticket.meta.id);
    if (s.outside.length) mismatches.push(`${ticket.meta.id}: outside allowed paths: ${s.outside.join(', ')}`);
    if (s.head_changed) mismatches.push(`${ticket.meta.id}: git HEAD differs from baseline`);
    const featureFile = path.join(paths(ctx).intent, `${ticket.meta.parent ?? ticket.meta.id}.md`);
    if (fs.existsSync(featureFile)) {
      const feature = parseDocument(featureFile);
      if (feature.meta.approved_version && feature.meta.approved_version !== sha(feature.body)) mismatches.push(`${ticket.meta.id}: feature intent approval is stale`);
    }
    return { id: ticket.meta.id, title: ticket.meta.title, state: ticket.meta.state, escalation_threshold: ticket.meta.escalation_threshold,
      unmet: ticket.criteria.map(c => ({ number: c.number, text: c.text, status: effective(c, records, change.hash), exit_code: records.filter(r => r.criterion === c.number).at(-1)?.exit ?? null })).filter(c => c.status !== '合格'), scope: s };
  });
  const lines = [];
  for (const ticket of active) {
    const file = journalFile(ctx, ticket.meta.id);
    if (fs.existsSync(file)) lines.push(...read(file).split('\n').filter(line => line.startsWith('- ')).map(line => `${ticket.meta.id} ${line}`));
  }
  const packet = [
    `Original request: ${brief(request || '(missing)')}`,
    `Intent: ${intent ? `version=${intent.version ?? 'missing'} approval=${intent.approved ? 'current' : intent.stale ? 'stale' : 'unapproved'}` : 'missing'}`,
    `Git: HEAD=${change.head.slice(0, 12)} change=${change.hash.slice(0, 12)} files=${Object.keys(change.files).length}`,
    ...tickets.slice(0, 6).flatMap(t => [`Ticket ${t.id}: ${brief(t.title, 80)} (${t.state}, escalation=${t.escalation_threshold ?? 'legacy'})`, `  baseline=${t.scope.baseline ?? 'legacy'} changed=${brief(t.scope.changed.join(', ') || 'none', 240)}`,
      ...t.unmet.slice(0, 4).map(c => `  criterion ${c.number}: ${c.status} exit=${c.exit_code ?? 'none'} ${brief(c.text, 100)}`),
      ...(t.unmet.length > 4 ? [`  ${t.unmet.length - 4} more unmet criteria`] : [])]),
    ...(tickets.length > 6 ? [`${tickets.length - 6} more active tickets; use --json for all`] : []),
    `Journal (last 5):`, ...lines.slice(-5).map(line => `  ${brief(line, 180)}`),
    `Mismatches: ${mismatches.length ? mismatches.join('; ') : 'none'}`
  ].join('\n');
  return { original_request: request, intent, active_tickets: tickets, journal: lines.slice(-5), change_set: change, mismatches, packet };
}

async function intent(ctx, o) {
  const action = o._[1];
  if (action === 'write') {
    required(o, 'file');
    const incoming = read(path.resolve(o.file)).replaceAll('\r\n', '\n');
    const parsed = incoming.startsWith('---\n') ? parseDocument(path.resolve(o.file)) : { meta: {}, body: incoming };
    const body = parsed.body.endsWith('\n') ? parsed.body : `${parsed.body}\n`;
    if (!section(body, '原依頼')) fail('Intent requires a nonempty ## 原依頼 section');
    const parent = o.parent ?? parsed.meta.parent_ticket;
    if (parent) safeId(parent);
    const requiredSections = parent ? ['目的', '制約', '棄却した代替案', '確定した決定'] : ['目的', '全体の制約', '用語', '棄却した代替案'];
    for (const name of requiredSections) if (!body.split('\n').some(line => line.trim() === `## ${name}`)) fail(`Intent requires ## ${name}`);
    const file = path.join(paths(ctx).intent, `${parent ?? 'root'}.md`);
    const prior = fs.existsSync(file) ? parseDocument(file).meta : {};
    const version = sha(body), same = prior.version === version;
    const meta = { ...(parent ? { parent_ticket: parent } : {}), version,
      approved_version: same ? prior.approved_version ?? '' : '', approved_at: same ? prior.approved_at ?? '' : '',
      approved_quote: same ? prior.approved_quote ?? '' : '' };
    write(file, document(meta, body));
    return { file, version, approval_preserved: same && Boolean(meta.approved_version) };
  }
  if (action === 'approve') {
    required(o, 'quote');
    if (!o.quote.trim()) fail('Approval quote must contain the human words');
    const id = o.parent ? safeId(o.parent) : 'root', file = path.join(paths(ctx).intent, `${id}.md`);
    if (!fs.existsSync(file)) fail(`Intent unavailable: ${id}`);
    const parsed = parseDocument(file), version = sha(parsed.body);
    parsed.meta.version = version;
    parsed.meta.approved_version = version;
    parsed.meta.approved_at = iso();
    parsed.meta.approved_quote = o.quote;
    write(file, document(parsed.meta, parsed.body));
    return { file, approved_version: version, approved_at: parsed.meta.approved_at };
  }
  fail('Usage: hx h intent write --file md [--parent id] | approve --quote words [--parent id]');
}

async function ticket(ctx, o) {
  const action = o._[1], id = o._[2];
  if (action === 'new') {
    required(o, 'title', 'criteria-file');
    const input = json(path.resolve(o['criteria-file']));
    const raw = Array.isArray(input) ? input : input.criteria;
    if (!Array.isArray(raw) || !raw.length) fail('Criteria file must contain a nonempty array');
    const criteria = raw.map((item, index) => {
      if (!item || typeof item.text !== 'string' || !item.text.trim() || !['得意', '苦手'].includes(item.kind)) fail(`Invalid criterion ${index + 1}`);
      const field = item.kind === '得意' ? 'check' : 'human';
      if (typeof item[field] !== 'string' || !item[field].trim() || item[item.kind === '得意' ? 'human' : 'check']) fail(`Invalid ${field} for criterion ${index + 1}`);
      return { number: index + 1, text: item.text.trim(), kind: item.kind, [field]: item[field], status: '未実行' };
    });
    const all = listTickets(ctx);
    const next = Math.max(0, ...all.map(t => Number(/^T-(\d+)$/.exec(t.meta.id)?.[1] ?? 0))) + 1;
    const ticketId = o.id ? safeId(o.id) : `T-${String(next).padStart(4, '0')}`;
    if (fs.existsSync(ticketFile(ctx, ticketId))) fail(`Ticket already exists: ${ticketId}`);
    const parent = o.parent ? safeId(o.parent) : null;
    if (parent) readTicket(ctx, parent);
    const threshold = Number(o['escalation-threshold'] ?? 2);
    if (!Number.isSafeInteger(threshold) || threshold < 1) fail('Invalid escalation threshold');
    const allowedPaths = o['allowed-paths'] ? String(o['allowed-paths']).split(',').map(p => rel(p.trim())).filter(Boolean) : [];
    if (allowedPaths.some(p => path.isAbsolute(p) || p === '..' || p.startsWith('../') || p.includes('/../'))) fail('Allowed paths must be relative to the project');
    const change = await changeSet(ctx);
    const meta = { id: ticketId, parent, title: o.title, state: '未着手', escalation_threshold: threshold,
      baseline: `${change.head}:${change.hash}`, baseline_files: Buffer.from(JSON.stringify(change.files)).toString('base64url'),
      allowed_paths: allowedPaths.join(',') };
    const body = `## /goal\n${o.title}\n\n## 受け入れ条件\n${criteriaBody(criteria)}\n\n## 履歴\n\n## escalation ログ\n`;
    write(ticketFile(ctx, ticketId), document(meta, body));
    return { id: ticketId, file: ticketFile(ctx, ticketId), baseline: meta.baseline, criteria: criteria.length };
  }
  if (action === 'list') return { tickets: listTickets(ctx).map(t => ({ id: t.meta.id, parent: t.meta.parent, title: t.meta.title, state: t.meta.state, criteria: t.criteria.length })) };
  if (action === 'approve') {
    safeId(id); required(o, 'quote');
    if (!o.quote.trim()) fail('Approval quote must contain the human words');
    const current = readTicket(ctx, id), n = Number(o.criterion), c = current.criteria.find(x => x.number === n);
    if (!c || c.kind !== '苦手') fail('Specify a human criterion with --criterion n');
    c.approved_at = iso(); c.approved_quote = o.quote; c.approved_hash = (await changeSet(ctx)).hash;
    c.approved_criterion_hash = criterionHash(c); c.status = '合格';
    saveTicket(current);
    return { id, criterion: n, status: '合格', approved_at: c.approved_at };
  }
  if (action === 'state') {
    safeId(id); required(o, 'reason');
    const next = o._[3];
    if (!states.includes(next)) fail('Invalid ticket state');
    const current = readTicket(ctx, id), previous = current.meta.state;
    if (previous === next) fail('Ticket is already in that state');
    if (next === '確定') {
      const change = await changeSet(ctx), records = evidence(ctx, id);
      const unmet = current.criteria.map(c => ({ number: c.number, status: effective(c, records, change.hash) })).filter(c => c.status !== '合格');
      if (!current.criteria.length) fail('Cannot confirm: no acceptance criteria');
      if (unmet.length) fail(`Cannot confirm: ${unmet.map(c => `criterion ${c.number} is ${c.status}`).join(', ')}`);
      const children = listTickets(ctx).filter(t => t.meta.parent === id && t.meta.state !== '確定');
      if (children.length) fail(`Cannot confirm: child tickets unfinished: ${children.map(t => t.meta.id).join(', ')}`);
      const s = scope(current, change);
      if (s.head_changed) fail('Cannot confirm: git HEAD changed since the ticket baseline');
      if (s.outside.length) fail(`Cannot confirm: changed files outside allowed paths: ${s.outside.join(', ')}`);
    }
    current.meta.state = next;
    current.body = current.body.replace(/(## 履歴\n)/, `$1- ${iso()}: ${previous} -> ${next}; ${o.reason}\n`);
    saveTicket(current);
    return { id, previous, state: next, reason: o.reason };
  }
  fail('Usage: hx h ticket new|list|state|approve');
}

async function check(ctx, o) {
  const id = safeId(o._[1]), current = readTicket(ctx, id);
  const selected = o.criterion ? current.criteria.filter(c => c.number === Number(o.criterion)) : current.criteria.filter(c => c.kind === '得意');
  if (!selected.length || selected.some(c => c.kind !== '得意')) fail('No matching machine criterion');
  const results = [];
  for (const c of selected) {
    const before = await changeSet(ctx);
    let run;
    try { run = await command(c.check, ctx.root); }
    catch (error) { run = { exit_code: 1, wall_s: 0, stderr: error.message, spawn_error: true }; }
    const change = await changeSet(ctx);
    const status = run.spawn_error || run.exit_code === 124 ? '障害' : before.hash !== change.hash ? '古い' : run.exit_code === 0 ? '合格' : '不合格';
    const record = redactor()({ criterion: c.number, criterion_hash: criterionHash(c), command: c.check, exit: run.exit_code, time: iso(), change_set_hash: change.hash,
      head: change.head, status, wall_s: run.wall_s, tail: ((run.stdout ?? '') + (run.stderr ?? '')).slice(-3000) });
    fs.mkdirSync(path.dirname(evidenceFile(ctx, id)), { recursive: true });
    fs.appendFileSync(evidenceFile(ctx, id), `${JSON.stringify(record)}\n`, 'utf8');
    c.status = status;
    results.push({ criterion: c.number, status, exit_code: run.exit_code, change_set_hash: change.hash });
  }
  saveTicket(current);
  return { id, results, exit_code: results.some(r => r.status !== '合格') ? 1 : 0 };
}

function journal(ctx, o) {
  const id = safeId(o._[1]), message = o._[2], kind = o.kind ?? 'tried';
  readTicket(ctx, id);
  if (!message || !['tried', 'failed', 'decided', 'open'].includes(kind)) fail('Usage: hx h journal id text [--kind tried|failed|decided|open]');
  const file = journalFile(ctx, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# Journal ${id}\n`, 'utf8');
  fs.appendFileSync(file, `- ${iso()} ${kind}: ${message.replaceAll('\n', ' ')}\n`, 'utf8');
  return { id, kind, recorded: true };
}

export async function h(ctx, o) {
  switch (o._[0]) {
    case 'status': return status(ctx);
    case 'intent': return intent(ctx, o);
    case 'ticket': return ticket(ctx, o);
    case 'check': return check(ctx, o);
    case 'journal': return journal(ctx, o);
    case 'scope': { const id = safeId(o._[1]); return scope(readTicket(ctx, id), await changeSet(ctx)); }
    default: fail('Usage: hx h status|intent|ticket|check|journal|scope');
  }
}
