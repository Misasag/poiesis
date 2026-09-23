import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { productionMethods } from './production-methods.mjs';
const require = createRequire(import.meta.url);
const URI = require('@theia/core/lib/common/uri').default;
const catalog = require('../agent-window/lib/common/skill-catalog.js');
const { createAgentActivityParser } = require('../agent-window/lib/browser/agent-activity-parser.js');
const { parseSkillDocument } = require('../agent-window/lib/browser/skill-document.js');
const service = productionMethods('../agent-window/src/browser/workspace-skill-service.ts', 'WorkspaceSkillService',
    ['preview', 'truncateInstructions'], { URI, ...catalog,
        WORKSPACE_SKILL_INSTRUCTION_MAX_CHARS: 8000, WORKSPACE_SKILLS_TOTAL_MAX_CHARS: 24000 });
const skill = (id, source, kind, body) => ({ id, source, uri: `file:///C:/skills/${id}/SKILL.md`, enabled: true,
    ...parseSkillDocument(id, `---\nname: ${id} display\ndescription: Use for ${id}\nkind: ${kind}\n---\n${body}`) });
let skills = [skill('workspace', 'workspace', 'agent', 'WORKSPACE BODY'),
    skill('workspace-agents', 'workspace-agents', 'agent', 'AGENTS BODY'),
    skill('user', 'user', 'agent', 'NEVER INLINE USER'.repeat(3000)),
    skill('user-agents', 'user-agents', 'agent', 'NEVER INLINE AGENTS'.repeat(3000)),
    skill('results', 'user', 'results', 'INLINE RESULTS BODY')];
service.list = async () => skills;
const preview = await service.preview('file:///C:/workspace', 'agent');
assert(preview.prompt.content.includes('WORKSPACE BODY'));
assert(preview.prompt.content.includes('AGENTS BODY'));
assert(!preview.prompt.content.includes('NEVER INLINE'));
assert(preview.prompt.content.includes('Use for user'));
assert(preview.prompt.content.includes('C:\\skills\\user\\SKILL.md') || preview.prompt.content.includes('C:/skills/user/SKILL.md'));
assert.deepEqual([...preview.prompt.includedSkillIds], ['workspace', 'workspace-agents']);
assert.equal(preview.prompt.catalogSkills.length, 2);
for (const item of preview.perSkill.filter(item => item.source.startsWith('user') && item.id !== 'results')) {
    const original = skills.find(skill => skill.id === item.id);
    assert.equal(item.chars, catalog.skillCatalogEntry(original, new URI(original.uri).path.fsPath()).length);
    assert(item.chars < 200);
}
assert((await service.preview('file:///C:/workspace', 'results')).prompt.content.includes('INLINE RESULTS BODY'));
const entry = skill('catalog', 'user-agents', 'agent', 'X'.repeat(50_000));
const cost = catalog.skillCatalogEntry(entry, new URI(entry.uri).path.fsPath()).length;
for (const extra of [0, 1]) {
    skills = [skill('a', 'workspace', 'agent', 'a'.repeat(8000)), skill('b', 'workspace', 'agent', 'b'.repeat(8000)),
        skill('c', 'workspace', 'agent', 'c'.repeat(8000 - cost + extra)), entry];
    const result = await service.preview('file:///C:/workspace', 'agent');
    assert.equal(result.prompt.catalogSkills.length, extra === 0 ? 1 : 0, 'Catalog text must consume the total budget exactly');
}
const task = productionMethods('../agent-window/src/browser/task-service.ts', 'TaskService',
    ['recordActivity', 'normalizeActivity', 'setCatalogSkills'], { ...catalog,
        TaskService: { MAX_ACTIVITIES_PER_TASK: 200, MAX_ACTIVITY_DETAIL_CHARS: 1000 } });
task.tasks = new Map([['task', { id: 'task' }]]);
task.setCatalogSkills('task', preview.prompt.catalogSkills);
const parser = createAgentActivityParser('claude', 'C:/workspace');
const path = preview.prompt.catalogSkills[0].path;
for (const event of [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: path } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Instructions' }] } }
]) {
    for (const activity of parser.consumeLine(JSON.stringify(event)).activities) { task.recordActivity('task', activity); }
}
assert.deepEqual([...task.tasks.get('task').referencedSkills], ['user display']);
const codex = createAgentActivityParser('codex', 'C:/workspace');
const readEvent = command => codex.consumeLine(JSON.stringify({ type: 'item.completed',
    item: { id: 'shell-read', type: 'command_execution', status: 'completed', exit_code: 0, command } })).activities[0];
assert.equal(catalog.referencedCatalogSkills(preview.prompt.catalogSkills, readEvent(`Get-Content -LiteralPath '${path}'`)).length, 1);
assert.equal(catalog.referencedCatalogSkills(preview.prompt.catalogSkills, readEvent(`echo '${path}'`)).length, 0);
assert.equal(catalog.referencedCatalogSkills(preview.prompt.catalogSkills, readEvent(`cat '${path}.backup'`)).length, 0);
assert.equal(catalog.referencedCatalogSkills(preview.prompt.catalogSkills, { ...readEvent(`cat '${path}'`), status: 'failed' }).length, 0);
assert.equal(catalog.referencedCatalogSkills(preview.prompt.catalogSkills, { ...readEvent(`cat '${path}'`), status: 'running' }).length, 0);
console.log('SKILL_INJECTION_TEST=passed');
