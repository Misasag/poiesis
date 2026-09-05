import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { agentCliArgs, oneShotCliArgs } = require('../agent-window/lib/node/cli-args.js');

const agentBase = { workspace: 'C:\\work', prompt: 'Do the work.' };
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'claude', model: 'sonnet' }), [
    '-p', 'Do the work.', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits', '--no-session-persistence', '--safe-mode',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'claude', model: 'sonnet', effort: 'max' }), [
    '-p', 'Do the work.', '--model', 'sonnet', '--effort', 'max', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits', '--no-session-persistence', '--safe-mode',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'codex', model: 'gpt-5', skipGitRepositoryCheck: true }), [
    'exec', '-m', 'gpt-5', '--skip-git-repo-check', '--json', '--color', 'never',
    '--sandbox', 'workspace-write', '-C', 'C:\\work', '--', 'Do the work.'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'codex', model: 'gpt-5', effort: 'xhigh', skipGitRepositoryCheck: true }), [
    'exec', '-m', 'gpt-5', '-c', 'model_reasoning_effort=xhigh', '--skip-git-repo-check', '--json', '--color', 'never',
    '--sandbox', 'workspace-write', '-C', 'C:\\work', '--', 'Do the work.'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'grok', model: 'grok-4' }), [
    '-p', 'Do the work.', '--cwd', 'C:\\work', '--model', 'grok-4', '--output-format', 'plain',
    '--permission-mode', 'acceptEdits', '--sandbox', 'workspace', '--disable-web-search', '--no-subagents', '--no-plan'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'grok', model: 'grok-4', effort: 'high' }), [
    '-p', 'Do the work.', '--cwd', 'C:\\work', '--model', 'grok-4', '--reasoning-effort', 'high', '--output-format', 'plain',
    '--permission-mode', 'acceptEdits', '--sandbox', 'workspace', '--disable-web-search', '--no-subagents', '--no-plan'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'grok', model: 'grok-4.5', effort: 'medium' }), [
    '-p', 'Do the work.', '--cwd', 'C:\\work', '--model', 'grok-4.5', '--reasoning-effort', 'medium', '--output-format', 'plain',
    '--permission-mode', 'acceptEdits', '--sandbox', 'workspace', '--disable-web-search', '--no-subagents', '--no-plan'
]);

const oneShotBase = { workspace: 'C:\\work', prompt: 'Answer.', promptViaStdin: true };
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'claude', model: 'haiku' }), [
    '-p', '--model', 'haiku', '--output-format', 'text', '--permission-mode', 'plan', '--tools=',
    '--no-session-persistence', '--safe-mode', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'
]);
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'claude', model: 'haiku', effort: 'low' }), [
    '-p', '--model', 'haiku', '--effort', 'low', '--output-format', 'text', '--permission-mode', 'plan', '--tools=',
    '--no-session-persistence', '--safe-mode', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'
]);
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'codex', model: 'gpt-5', skipGitRepositoryCheck: true }), [
    'exec', '-m', 'gpt-5', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', 'C:\\work', '-'
]);
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'codex', model: 'gpt-5', effort: 'minimal', skipGitRepositoryCheck: true }), [
    'exec', '-m', 'gpt-5', '-c', 'model_reasoning_effort=minimal', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', 'C:\\work', '-'
]);
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'grok', model: 'grok-4', promptFile: 'C:\\temp\\prompt.txt' }), [
    '--prompt-file', 'C:\\temp\\prompt.txt', '--cwd', 'C:\\work', '--model', 'grok-4', '--output-format', 'plain',
    '--permission-mode', 'plan', '--sandbox', 'read-only', '--disable-web-search', '--no-subagents', '--max-turns', '1'
]);
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'grok', model: 'grok-4', effort: 'low', promptFile: 'C:\\temp\\prompt.txt' }), [
    '--prompt-file', 'C:\\temp\\prompt.txt', '--cwd', 'C:\\work', '--model', 'grok-4', '--reasoning-effort', 'low', '--output-format', 'plain',
    '--permission-mode', 'plan', '--sandbox', 'read-only', '--disable-web-search', '--no-subagents', '--max-turns', '1'
]);
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'grok', model: 'grok-4.5', effort: 'medium', promptFile: 'C:\\temp\\prompt.txt' }), [
    '--prompt-file', 'C:\\temp\\prompt.txt', '--cwd', 'C:\\work', '--model', 'grok-4.5', '--reasoning-effort', 'medium', '--output-format', 'plain',
    '--permission-mode', 'plan', '--sandbox', 'read-only', '--disable-web-search', '--no-subagents', '--max-turns', '1'
]);

for (const [providerId, effort] of [['claude', 'minimal'], ['codex', 'max'], ['grok', 'max'], ['gemini', 'low']]) {
    assert.throws(
        () => agentCliArgs({ ...agentBase, providerId, effort }),
        error => error instanceof Error && error.message.startsWith(`Unsupported effort for ${providerId}:`)
    );
}

console.log('CLI_ARGS_TEST=passed');
