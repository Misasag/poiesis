import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../bin/lib/util.mjs';

// Deliberately fail closed for new YAML constructs. The current builder file
// uses simple scalar files entries and from/to resource mappings. A changed
// packaging grammar requires a reviewed guard, not an optimistic regex pass.
function assertPackagingSafe(yaml) {
  const sections = new Map(); let section;
  for (const raw of yaml.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const heading = /^([A-Za-z]+):\s*(.*)$/.exec(raw);
    if (heading) { section = heading[1]; sections.set(section, []); if (['files', 'extraResources'].includes(section)) assert.equal(heading[2].trim(), '', 'Inline packaging collections require explicit review'); }
    else if (section) sections.get(section).push(raw.trim());
  }
  const files = sections.get('files'); assert.ok(files?.length, 'Default broad packaging is forbidden');
  for (const raw of files) {
    assert.match(raw, /^- /, 'Unsupported files mapping');
    const value = raw.slice(2).replace(/^['"]|['"]$/g, '');
    if (value.startsWith('!')) continue;
    assert.ok(['src-gen', 'lib', 'scripts', 'product.json'].includes(value), `Unsafe files include: ${value}`);
  }
  const resources = sections.get('extraResources'); assert.ok(resources?.length);
  for (const raw of resources) {
    if (raw.startsWith('- from: ')) assert.equal(raw.slice(8).replace(/^['"]|['"]$/g, ''), '../plugins', 'Unsafe resource source');
    else assert.match(raw, /^to:\s+app\/plugins$/, 'Unsupported resource mapping');
  }
}
test('Packaged app cannot contain the development harness', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'electron-app/electron-builder.yml'), 'utf8'); assertPackagingSafe(yaml);
  for (const forbidden of ['../tools', '../.harness', '../.claude', '../AGENTS.md', '../CLAUDE.md', '**/*', '..']) {
    assert.throws(() => assertPackagingSafe(yaml.replace('  - src-gen', `  - ${forbidden}`)));
    assert.throws(() => assertPackagingSafe(yaml.replace('from: ../plugins', `from: ${forbidden}`)));
  }
});
