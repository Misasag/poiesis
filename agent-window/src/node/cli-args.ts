import { CLI_DISPLAY_NAMES, CLI_EFFORT_LEVELS, KnownCliId } from '../common/agent-runtime-protocol';

export interface AgentCliArgsInput {
    providerId: KnownCliId;
    model?: string;
    effort?: string;
    workspace: string;
    prompt: string;
    promptFile?: string;
    skipGitRepositoryCheck?: boolean;
    allowCodexAgentNetworkAccess?: boolean;
}

export interface OneShotCliArgsInput {
    providerId: KnownCliId;
    model?: string;
    effort?: string;
    workspace: string;
    prompt: string;
    promptFile?: string;
    promptViaStdin?: boolean;
    readOnlyFileTools?: boolean;
    skipGitRepositoryCheck?: boolean;
}

export function assertBoundedCliArgs(args: readonly string[]): void {
    if (args.some(argument => argument.length > 1_000)) {
        throw new Error('AIの起動設定が長すぎます。設定を短くしてください。');
    }
}

export function agentCliArgs(input: AgentCliArgsInput): string[] {
    const args = buildAgentCliArgs(input);
    assertBoundedCliArgs(args);
    return args;
}

function buildAgentCliArgs(input: AgentCliArgsInput): string[] {
    const model = input.model?.trim();
    const effort = effortArgs(input.providerId, input.effort);
    if (input.providerId === 'pi') {
        return [...piBaseArgs(model, effort), '--tools', 'read,bash,edit,write'];
    }
    if (input.providerId === 'claude') {
        return [
            '-p',
            ...(model ? ['--model', model] : []),
            ...effort,
            '--output-format', 'stream-json',
            '--verbose',
            '--permission-mode', 'auto',
            '--no-session-persistence',
            '--safe-mode',
            '--disable-slash-commands',
            '--strict-mcp-config',
            '--mcp-config', '{"mcpServers":{}}'
        ];
    }
    if (input.providerId === 'grok') {
        if (!input.promptFile) { throw new Error('Grok の依頼ファイルを準備できませんでした。'); }
        return [
            '--prompt-file', input.promptFile,
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
            '-c', `sandbox_workspace_write.network_access=${input.allowCodexAgentNetworkAccess === true}`,
            ...(input.skipGitRepositoryCheck ? ['--skip-git-repo-check'] : []),
            '--json',
            '--color', 'never',
            '--sandbox', 'workspace-write',
            '-C', input.workspace,
            '-'
        ];
    }
    throw new Error('Gemini CLI の実行には対応していません。');
}

export function oneShotCliArgs(input: OneShotCliArgsInput): string[] {
    const args = buildOneShotCliArgs(input);
    assertBoundedCliArgs(args);
    return args;
}

function buildOneShotCliArgs(input: OneShotCliArgsInput): string[] {
    const model = input.model?.trim();
    const effort = effortArgs(input.providerId, input.effort);
    if (input.providerId === 'pi') {
        return [...piBaseArgs(model, effort), ...(input.readOnlyFileTools ? ['--tools', 'read'] : ['--no-tools'])];
    }
    if (input.providerId === 'claude') {
        return [
            '-p',
            ...(model ? ['--model', model] : []),
            ...effort,
            '--output-format', 'json',
            '--permission-mode', 'plan',
            ...(input.readOnlyFileTools ? ['--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob'] : ['--tools=']),
            '--no-session-persistence',
            '--safe-mode',
            '--disable-slash-commands',
            '--strict-mcp-config',
            '--mcp-config', '{"mcpServers":{}}'
        ];
    }
    if (input.providerId === 'grok') {
        if (!input.promptFile) {
            throw new Error('Grok の依頼ファイルを準備できませんでした。');
        }
        return [
            '--prompt-file', input.promptFile,
            '--cwd', input.workspace,
            ...(model ? ['--model', model] : []),
            ...effort,
            '--output-format', 'plain',
            '--permission-mode', 'plan',
            '--sandbox', 'read-only',
            '--disable-web-search',
            '--no-subagents',
            '--max-turns', input.readOnlyFileTools ? '8' : '1'
        ];
    }
    if (input.providerId === 'codex') {
        return [
            'exec',
            ...(model ? ['-m', model] : []),
            ...effort,
            ...(input.skipGitRepositoryCheck ? ['--skip-git-repo-check'] : []),
            '--json',
            '--sandbox', 'read-only',
            '-C', input.workspace,
            '-'
        ];
    }
    throw new Error('Gemini CLI の実行には対応していません。');
}

function piBaseArgs(model: string | undefined, effort: string[]): string[] {
    return ['-p', '--mode', 'json', ...(model ? ['--model', model] : []), ...effort,
        '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
        '--no-themes', '--no-approve', '--offline'];
}

export function validateCliEffort(providerId: KnownCliId, rawEffort: string | undefined): string {
    const effort = rawEffort?.trim() ?? '';
    if (effort && !CLI_EFFORT_LEVELS[providerId].includes(effort)) {
        throw new Error(`${CLI_DISPLAY_NAMES[providerId]} では選択した思考の強度を利用できません。`);
    }
    return effort;
}

function effortArgs(providerId: KnownCliId, rawEffort: string | undefined): string[] {
    const effort = validateCliEffort(providerId, rawEffort);
    if (!effort) {
        return [];
    }
    if (providerId === 'pi') {
        return ['--thinking', effort];
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
    throw new Error(`${CLI_DISPLAY_NAMES[providerId]} では選択した思考の強度を利用できません。`);
}
