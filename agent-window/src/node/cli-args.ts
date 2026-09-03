import { CLI_EFFORT_LEVELS, KnownCliId } from '../common/agent-runtime-protocol';

export interface AgentCliArgsInput {
    providerId: KnownCliId;
    model?: string;
    effort?: string;
    workspace: string;
    prompt: string;
    skipGitRepositoryCheck?: boolean;
}

export interface OneShotCliArgsInput {
    providerId: KnownCliId;
    model?: string;
    effort?: string;
    workspace: string;
    prompt: string;
    promptFile?: string;
    promptViaStdin?: boolean;
    skipGitRepositoryCheck?: boolean;
}

export function agentCliArgs(input: AgentCliArgsInput): string[] {
    const model = input.model?.trim();
    const effort = effortArgs(input.providerId, input.effort);
    if (input.providerId === 'claude') {
        return [
            '-p', input.prompt,
            ...(model ? ['--model', model] : []),
            ...effort,
            '--output-format', 'stream-json',
            '--verbose',
            '--permission-mode', 'acceptEdits',
            '--no-session-persistence',
            '--safe-mode',
            '--disable-slash-commands',
            '--strict-mcp-config',
            '--mcp-config', '{"mcpServers":{}}'
        ];
    }
    if (input.providerId === 'grok') {
        return [
            '-p', input.prompt,
            '--cwd', input.workspace,
            ...(model ? ['--model', model] : []),
            ...effort,
            '--output-format', 'plain',
            '--permission-mode', 'acceptEdits',
            '--sandbox', 'workspace',
            '--disable-web-search',
            '--no-subagents',
            '--no-plan'
        ];
    }
    if (input.providerId === 'codex') {
        return [
            'exec',
            ...(model ? ['-m', model] : []),
            ...effort,
            ...(input.skipGitRepositoryCheck ? ['--skip-git-repo-check'] : []),
            '--json',
            '--color', 'never',
            '--sandbox', 'workspace-write',
            '-C', input.workspace,
            '--', input.prompt
        ];
    }
    throw new Error('Gemini CLI execution is not supported.');
}

export function oneShotCliArgs(input: OneShotCliArgsInput): string[] {
    const model = input.model?.trim();
    const effort = effortArgs(input.providerId, input.effort);
    if (input.providerId === 'claude') {
        return [
            '-p',
            ...(!input.promptViaStdin ? [input.prompt] : []),
            ...(model ? ['--model', model] : []),
            ...effort,
            '--output-format', 'text',
            '--permission-mode', 'plan',
            '--tools=',
            '--no-session-persistence',
            '--safe-mode',
            '--disable-slash-commands',
            '--strict-mcp-config',
            '--mcp-config', '{"mcpServers":{}}'
        ];
    }
    if (input.providerId === 'grok') {
        if (input.promptViaStdin && !input.promptFile) {
            throw new Error('Grok one-shot execution requires a prompt file for stdin transport.');
        }
        return [
            ...(input.promptFile ? ['--prompt-file', input.promptFile] : ['-p', input.prompt]),
            '--cwd', input.workspace,
            ...(model ? ['--model', model] : []),
            ...effort,
            '--output-format', 'plain',
            '--permission-mode', 'plan',
            '--sandbox', 'read-only',
            '--disable-web-search',
            '--no-subagents',
            '--max-turns', '1'
        ];
    }
    if (input.providerId === 'codex') {
        return [
            'exec',
            ...(model ? ['-m', model] : []),
            ...effort,
            ...(input.skipGitRepositoryCheck ? ['--skip-git-repo-check'] : []),
            '--sandbox', 'read-only',
            '-C', input.workspace,
            ...(input.promptViaStdin ? ['-'] : ['--', input.prompt])
        ];
    }
    throw new Error('Gemini CLI execution is not supported.');
}

export function validateCliEffort(providerId: KnownCliId, rawEffort: string | undefined): string {
    const effort = rawEffort?.trim() ?? '';
    if (effort && !CLI_EFFORT_LEVELS[providerId].includes(effort)) {
        throw new Error(`Unsupported effort for ${providerId}: ${JSON.stringify(effort)}.`);
    }
    return effort;
}

function effortArgs(providerId: KnownCliId, rawEffort: string | undefined): string[] {
    const effort = validateCliEffort(providerId, rawEffort);
    if (!effort) {
        return [];
    }
    if (providerId === 'claude') {
        return ['--effort', effort];
    }
    if (providerId === 'codex') {
        return ['-c', `model_reasoning_effort=${effort}`];
    }
    if (providerId === 'grok') {
        return ['--reasoning-effort', effort];
    }
    throw new Error(`Unsupported effort for ${providerId}: ${JSON.stringify(effort)}.`);
}
