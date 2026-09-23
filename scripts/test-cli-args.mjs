import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { agentCliArgs, oneShotCliArgs } = require('../agent-window/lib/node/cli-args.js');

const agentBase = { workspace: 'C:\\work', prompt: 'Do the work.', promptFile: 'C:\\temp\\prompt.txt' };
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'claude', model: 'sonnet' }), [
    '-p', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'auto', '--no-session-persistence', '--safe-mode',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'claude', model: 'sonnet', effort: 'max' }), [
    '-p', '--model', 'sonnet', '--effort', 'max', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'auto', '--no-session-persistence', '--safe-mode',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'codex', model: 'gpt-5', skipGitRepositoryCheck: true }), [
    'exec', '-m', 'gpt-5', '-c', 'sandbox_workspace_write.network_access=false', '--skip-git-repo-check', '--json', '--color', 'never',
    '--sandbox', 'workspace-write', '-C', 'C:\\work', '-'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'codex', model: 'gpt-5', effort: 'xhigh', skipGitRepositoryCheck: true }), [
    'exec', '-m', 'gpt-5', '-c', 'model_reasoning_effort=xhigh', '-c', 'sandbox_workspace_write.network_access=false', '--skip-git-repo-check', '--json', '--color', 'never',
    '--sandbox', 'workspace-write', '-C', 'C:\\work', '-'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'codex', model: 'gpt-6-astra', effort: 'max' }), [
    'exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=max', '-c', 'sandbox_workspace_write.network_access=false', '--json', '--color', 'never',
    '--sandbox', 'workspace-write', '-C', 'C:\\work', '-'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'codex', model: 'gpt-6-astra', effort: 'ultra' }), [
    'exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=ultra', '-c', 'sandbox_workspace_write.network_access=false', '--json', '--color', 'never',
    '--sandbox', 'workspace-write', '-C', 'C:\\work', '-'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'codex', model: 'gpt-6-luna', allowCodexAgentNetworkAccess: true }), [
    'exec', '-m', 'gpt-6-luna', '-c', 'sandbox_workspace_write.network_access=true', '--json', '--color', 'never',
    '--sandbox', 'workspace-write', '-C', 'C:\\work', '-'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'grok', model: 'grok-4' }), [
    '--prompt-file', 'C:\\temp\\prompt.txt', '--cwd', 'C:\\work', '--model', 'grok-4', '--output-format', 'plain',
    '--permission-mode', 'acceptEdits', '--sandbox', 'workspace', '--disable-web-search', '--no-subagents', '--no-plan'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'grok', model: 'grok-4', effort: 'high' }), [
    '--prompt-file', 'C:\\temp\\prompt.txt', '--cwd', 'C:\\work', '--model', 'grok-4', '--reasoning-effort', 'high', '--output-format', 'plain',
    '--permission-mode', 'acceptEdits', '--sandbox', 'workspace', '--disable-web-search', '--no-subagents', '--no-plan'
]);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'grok', model: 'grok-4.5', effort: 'medium' }), [
    '--prompt-file', 'C:\\temp\\prompt.txt', '--cwd', 'C:\\work', '--model', 'grok-4.5', '--reasoning-effort', 'medium', '--output-format', 'plain',
    '--permission-mode', 'acceptEdits', '--sandbox', 'workspace', '--disable-web-search', '--no-subagents', '--no-plan'
]);

const piAgent = agentCliArgs({ ...agentBase, providerId: 'pi', model: 'openrouter/z-ai/glm-5.3-flash', effort: 'low' });
assert.deepEqual(piAgent, ['-p', '--mode', 'json', '--model', 'openrouter/z-ai/glm-5.3-flash', '--thinking', 'low',
    '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--offline',
    '--tools', 'read,bash,edit,write']);
assert(!piAgent.includes(agentBase.prompt));

const oneShotBase =  { workspace: 'C:\\work', prompt: 'Answer.', promptViaStdin: true };
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'claude', model: 'haiku' }), [
    '-p', '--model', 'haiku', '--output-format', 'json', '--permission-mode', 'plan', '--tools=',
    '--no-session-persistence', '--safe-mode', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'
]);
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'claude', model: 'haiku', effort: 'low' }), [
    '-p', '--model', 'haiku', '--effort', 'low', '--output-format', 'json', '--permission-mode', 'plan', '--tools=',
    '--no-session-persistence', '--safe-mode', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'
]);
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'codex', model: 'gpt-5', skipGitRepositoryCheck: true }), [
    'exec', '-m', 'gpt-5', '--skip-git-repo-check', '--json', '--sandbox', 'read-only', '-C', 'C:\\work', '-'
]);
assert(!oneShotCliArgs({ ...oneShotBase, providerId: 'codex', allowCodexAgentNetworkAccess: true })
    .some(argument => argument.includes('sandbox_workspace_write.network_access')));
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'codex', model: 'gpt-5', effort: 'minimal', skipGitRepositoryCheck: true }), [
    'exec', '-m', 'gpt-5', '-c', 'model_reasoning_effort=minimal', '--skip-git-repo-check', '--json', '--sandbox', 'read-only', '-C', 'C:\\work', '-'
]);
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'codex', model: 'gpt-6-astra', effort: 'ultra' }), [
    'exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=ultra', '--json', '--sandbox', 'read-only', '-C', 'C:\\work', '-'
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

const piOneShot = oneShotCliArgs({ ...oneShotBase, providerId: 'pi', model: 'openrouter/z-ai/glm-5.3-flash' });
assert(piOneShot.includes('--no-tools'));
assert(!piOneShot.includes(oneShotBase.prompt));
assert.deepEqual(oneShotCliArgs({ ...oneShotBase, providerId: 'pi', readOnlyFileTools: true }).slice(-2), ['--tools', 'read']);

for (const [providerId, effort] of [['claude', 'minimal'], ['codex', 'extreme'], ['grok', 'max'], ['gemini', 'low']]) {
    assert.throws(
        () => agentCliArgs({ ...agentBase, providerId, effort }),
        error => error instanceof Error && error.message.endsWith('では選択した思考の強度を利用できません。')
    );
}
assert.throws(
    () => agentCliArgs({ ...agentBase, providerId: 'codex', model: 'unknown-custom', effort: 'extreme' }),
    /Codex では選択した思考の強度を利用できません/,
    'Unknown custom models must still enforce the provider-wide effort boundary.'
);
assert.deepEqual(agentCliArgs({ ...agentBase, providerId: 'codex', model: '', effort: 'minimal' }).slice(0, 3), [
    'exec', '-c', 'model_reasoning_effort=minimal'
], 'A blank model must remain the CLI-configured default and keep a provider-valid effort.');
console.log('CLI_ARGS_TEST=passed');

for (const providerId of ['codex', 'claude', 'grok']) {
    for (const build of [agentCliArgs, oneShotCliArgs]) {
        const prompt = '日本語の長い依頼'.repeat(20_000);
        const args = build({ ...agentBase, providerId, prompt });
        assert(args.every(argument => argument.length <= 1_000));
        assert(!args.includes(prompt));
        if (providerId === 'codex') assert.equal(args.at(-1), '-');
        if (providerId === 'claude') assert.equal(args[0], '-p');
        if (providerId === 'grok') assert(args.includes('--prompt-file'));
        assert.throws(() => build({ ...agentBase, providerId, model: 'x'.repeat(1_001) }), /起動設定が長すぎます/);
    }
}

for (const providerId of ['codex', 'claude', 'grok']) {
    const args = oneShotCliArgs({ ...agentBase, providerId, readOnlyFileTools: true });
    const value = flag => args[args.indexOf(flag) + 1];
    if (providerId === 'claude') {
        assert.equal(value('--permission-mode'), 'plan');
        assert.equal(value('--tools'), 'Read,Grep,Glob');
        assert.equal(value('--allowedTools'), 'Read,Grep,Glob');
        assert(!args.includes('--tools='));
    } else {
        assert.equal(value('--sandbox'), 'read-only');
        if (providerId === 'grok') {
            assert.equal(value('--permission-mode'), 'plan');
            assert.equal(value('--max-turns'), '8');
        }
    }
}
