import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAgentActivityParser } = require('../agent-window/lib/browser/agent-activity-parser.js');

function fixtureLines(name) {
    return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);
}

function consumeFixture(parser, lines) {
    const activities = new Map();
    let finalMessage;
    const diagnostics = [];
    let runningCommandObserved = false;
    lines.forEach((line, index) => {
        const result = parser.consumeLine(line, new Date(Date.UTC(2026, 8, 2, 0, 0, index)));
        for (const activity of result.activities) {
            if (activity.kind === 'command' && activity.status === 'running') {
                runningCommandObserved = true;
            }
            activities.set(activity.id, activity);
        }
        if (result.finalMessage !== undefined) {
            finalMessage = result.finalMessage;
        }
        diagnostics.push(...result.diagnostics);
    });
    return { activities: [...activities.values()], finalMessage, diagnostics, runningCommandObserved };
}

const codex = consumeFixture(
    createAgentActivityParser('codex', 'C:\\work\\probe'),
    fixtureLines('codex-exec-events.jsonl')
);
const codexCommands = codex.activities.filter(activity => activity.kind === 'command');
assert.equal(codexCommands.length, 1, 'Codex command events must upsert by id.');
assert.equal(codexCommands[0].detail, 'dir (終了コード 0)', 'Codex command wrapper must be stripped and its exit code retained.');
assert.equal(codexCommands[0].status, 'completed', 'Codex command must complete.');
assert.equal(codex.runningCommandObserved, true, 'Codex command must transition through running.');
assert.equal(codex.activities.filter(activity => activity.kind === 'file-change')[0]?.detail,
    'probe.txt · 追加', 'Codex file path must be workspace-relative.');
assert.equal(codex.activities.filter(activity => activity.kind === 'message').length, 2,
    'Every Codex agent message must become an activity.');
assert.equal(codex.finalMessage, 'done', 'Last Codex agent message must remain the final report.');
assert.deepEqual(codex.diagnostics, [], 'Codex fixture must not produce diagnostics.');

const claudeParser = createAgentActivityParser('claude', 'C:\\work\\probe');
const claudeLines = fixtureLines('claude-stream-events.jsonl');
const claudeSystem = claudeParser.consumeLine(claudeLines[0], new Date('2026-09-02T00:00:00.000Z'));
assert.deepEqual(claudeSystem.activities, [], 'Claude system line must not produce activities.');
assert.deepEqual(claudeSystem.diagnostics, [], 'Claude system line must not produce diagnostics.');
const claude = consumeFixture(claudeParser, claudeLines.slice(1));
const claudeReads = claude.activities.filter(activity => activity.kind === 'read');
assert.equal(claudeReads.length, 1, 'Claude Read must upsert by tool_use_id.');
assert.equal(claudeReads[0].detail, 'probe.txt', 'Claude Read path must be workspace-relative.');
assert.equal(claudeReads[0].status, 'completed', 'Claude tool_result must complete Read.');
assert.equal(claude.finalMessage, 'done', 'Claude result must remain the final report.');
assert.deepEqual(claude.diagnostics, [], 'Claude fixture must not produce diagnostics.');

const malformed = createAgentActivityParser('codex').consumeLine('{not json');
assert.deepEqual(malformed.activities, [], 'Malformed input must not produce activities.');
assert.equal(malformed.diagnostics.length, 1, 'Malformed input must produce one diagnostic.');

const unknown = createAgentActivityParser('codex').consumeLine(JSON.stringify({
    type: 'item.started',
    item: { id: 'unknown-1', type: 'future_item', status: 'in_progress' }
}));
assert.equal(unknown.activities[0]?.kind, 'tool', 'Unknown Codex items must degrade to tool activities.');

const multilineCommand = createAgentActivityParser('codex').consumeLine(JSON.stringify({
    type: 'item.completed',
    item: {
        id: 'multiline-command',
        type: 'command_execution',
        command: 'echo one\necho two',
        exit_code: 0,
        status: 'completed'
    }
}));
assert.equal(multilineCommand.activities[0]?.detail, 'echo one; echo two (終了コード 0)',
    'Multiline commands must retain statement boundaries.');

console.log('AGENT_ACTIVITY_PARSER_TEST=passed');
