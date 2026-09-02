import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { mergeSkillsByRank, parseSkillDocument } = require(resolve(root, 'agent-window/lib/browser/skill-document.js'));

const document = (frontmatter, body = '# Instructions\n\nFollow this skill.') => `---\n${frontmatter}\n---\n\n${body}\n`;

const topLevel = parseSkillDocument('results-top-level', document([
    'name: Results top level',
    'description: Formats results',
    'kind: results'
].join('\n')), {});
assert.equal(topLevel.kind, 'results');
assert.equal(topLevel.error, undefined);

const metadata = parseSkillDocument('results-metadata', document([
    'name: Results metadata',
    'description: Formats results through metadata',
    'metadata:',
    '  poiesis:',
    '    kind: results'
].join('\n')), {});
assert.equal(metadata.kind, 'results');
assert.equal(metadata.error, undefined);

const defaultKind = parseSkillDocument('default-agent', document([
    'name: Default agent',
    'description: Uses the compatibility default'
].join('\n')), {});
assert.equal(defaultKind.kind, 'agent');
assert(defaultKind.warnings.includes('kind が未指定のため Agent Skill として扱います'));

const missingName = parseSkillDocument('missing-name', document([
    'description: Missing a required name',
    'kind: agent'
].join('\n')), {});
assert.equal(missingName.error, 'frontmatterのname、description、kind（agent／results）を確認してください。');

const merged = mergeSkillsByRank([
    { id: 'same-id', rank: 300, uri: 'file:///home/.poiesis/skills/same-id/SKILL.md' },
    { id: 'same-id', rank: 100, uri: 'file:///workspace/.poiesis/skills/same-id/SKILL.md' },
    { id: 'other-id', rank: 200, uri: 'file:///workspace/.agents/skills/other-id/SKILL.md' }
]);
const userDuplicate = merged.find(skill => skill.rank === 300);
assert.equal(userDuplicate?.shadowedBy, 'file:///workspace/.poiesis/skills/same-id/SKILL.md');
assert.equal(merged.find(skill => skill.rank === 100)?.shadowedBy, undefined);

const quoted = parseSkillDocument('quoted', document([
    'name: "Quoted name"',
    "description: 'Quoted description'",
    "kind: 'results'"
].join('\n')), {});
assert.equal(quoted.name, 'Quoted name');
assert.equal(quoted.description, 'Quoted description');
assert.equal(quoted.kind, 'results');

console.log('skill-document tests passed');
