import { join } from 'node:path';
import { AiRole, CliModelOption, CODEX_FALLBACK_MODEL_EFFORTS, KnownCliId } from '../common/agent-runtime-protocol';

export interface KnownCliDefinition {
    id: KnownCliId;
    displayName: string;
    executableNames: readonly string[];
    wellKnownLocations: readonly string[];
    versionProbe: readonly string[];
    executableRoles: readonly AiRole[];
    models: readonly CliModelOption[];
    defaultModel: string;
}

/** Keep Grok's Poiesis role isolated from owner-level Claude/Cursor orchestration and MCP compatibility. */
export function grokExecutionEnvironment(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        GROK_CLAUDE_SKILLS_ENABLED: 'false',
        GROK_CLAUDE_RULES_ENABLED: 'false',
        GROK_CLAUDE_AGENTS_ENABLED: 'false',
        GROK_CLAUDE_MCPS_ENABLED: 'false',
        GROK_CLAUDE_HOOKS_ENABLED: 'false',
        GROK_CLAUDE_SESSIONS_ENABLED: 'false',
        GROK_CURSOR_SKILLS_ENABLED: 'false',
        GROK_CURSOR_RULES_ENABLED: 'false',
        GROK_CURSOR_AGENTS_ENABLED: 'false',
        GROK_CURSOR_MCPS_ENABLED: 'false',
        GROK_CURSOR_HOOKS_ENABLED: 'false',
        GROK_CURSOR_SESSIONS_ENABLED: 'false'
    };
}

/** Fallback entries used only when a CLI cannot provide a live model catalog. */
export function knownCliDefinitions(): readonly KnownCliDefinition[] {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const userProfile = process.env.USERPROFILE;
    const compact = (values: Array<string | undefined>): string[] =>
        values.filter((value): value is string => Boolean(value));
    const cliDefault: CliModelOption = { id: '', label: '既定' };
    return [
        {
            id: 'codex',
            displayName: 'Codex',
            executableNames: ['codex'],
            wellKnownLocations: compact([
                appData && join(appData, 'npm', 'codex.cmd'),
                localAppData && join(localAppData, 'Programs', 'codex', 'codex.exe'),
                userProfile && join(userProfile, '.codex', 'bin', 'codex.exe'),
                userProfile && join(userProfile, '.local', 'bin', 'codex.exe')
            ]),
            versionProbe: ['--version'],
            executableRoles: ['agent', 'results'],
            models: [
                cliDefault,
                {
                    id: 'gpt-6-astra', label: 'GPT-6-Astra',
                    description: 'Our most capable model for complex, demanding work.',
                    isCatalogDefault: true,
                    defaultReasoningEffort: 'medium',
                    supportedReasoningEfforts: [...CODEX_FALLBACK_MODEL_EFFORTS['gpt-6-astra']],
                    inputModalities: ['text', 'image']
                },
                {
                    id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol',
                    description: 'Reliable agentic workhorse for everyday tasks.', defaultReasoningEffort: 'low',
                    supportedReasoningEfforts: [...CODEX_FALLBACK_MODEL_EFFORTS['gpt-5.6-sol']], inputModalities: ['text', 'image']
                },
                {
                    id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra',
                    description: 'Balanced agentic coding model for everyday work.', defaultReasoningEffort: 'medium',
                    supportedReasoningEfforts: [...CODEX_FALLBACK_MODEL_EFFORTS['gpt-5.6-terra']], inputModalities: ['text', 'image']
                },
                {
                    id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna',
                    description: 'Fast and affordable agentic coding model.', defaultReasoningEffort: 'medium',
                    supportedReasoningEfforts: [...CODEX_FALLBACK_MODEL_EFFORTS['gpt-5.6-luna']], inputModalities: ['text', 'image']
                },
                {
                    id: 'gpt-5.5', label: 'GPT-5.5', defaultReasoningEffort: 'medium',
                    supportedReasoningEfforts: [...CODEX_FALLBACK_MODEL_EFFORTS['gpt-5.5']], inputModalities: ['text', 'image']
                },
                {
                    id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', defaultReasoningEffort: 'medium',
                    supportedReasoningEfforts: [...CODEX_FALLBACK_MODEL_EFFORTS['gpt-5.4-mini']], inputModalities: ['text', 'image']
                },
                {
                    id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark',
                    description: 'Ultra-fast coding model.', defaultReasoningEffort: 'high',
                    supportedReasoningEfforts: [...CODEX_FALLBACK_MODEL_EFFORTS['gpt-5.3-codex-spark']], inputModalities: ['text']
                }
            ],
            defaultModel: ''
        },
        {
            id: 'claude',
            displayName: 'Claude',
            executableNames: ['claude'],
            wellKnownLocations: compact([
                appData && join(appData, 'npm', 'claude.cmd'),
                localAppData && join(localAppData, 'Programs', 'claude', 'claude.exe'),
                userProfile && join(userProfile, '.local', 'bin', 'claude.exe')
            ]),
            versionProbe: ['--version'],
            executableRoles: ['agent', 'results'],
            models: [
                cliDefault,
                { id: 'fable', label: 'fable' },
                { id: 'opus', label: 'opus' },
                { id: 'sonnet', label: 'sonnet' },
                { id: 'haiku', label: 'haiku' }
            ],
            defaultModel: ''
        },
        {
            id: 'grok',
            displayName: 'Grok',
            executableNames: ['grok'],
            wellKnownLocations: compact([
                userProfile && join(userProfile, '.grok', 'bin', 'grok.exe'),
                localAppData && join(localAppData, 'Programs', 'grok', 'grok.exe'),
                userProfile && join(userProfile, '.local', 'bin', 'grok.exe')
            ]),
            versionProbe: ['--version'],
            executableRoles: ['agent', 'results'],
            models: [
                cliDefault,
                { id: 'grok-4.6', label: 'Grok 4.6' },
                { id: 'grok-4.5', label: 'Grok 4.5' }
            ],
            defaultModel: ''
        },
        {
            id: 'gemini',
            displayName: 'Gemini',
            executableNames: ['gemini'],
            wellKnownLocations: compact([
                appData && join(appData, 'npm', 'gemini.cmd'),
                localAppData && join(localAppData, 'Programs', 'gemini', 'gemini.exe'),
                userProfile && join(userProfile, '.local', 'bin', 'gemini')
            ]),
            versionProbe: ['--version'],
            executableRoles: [],
            models: [cliDefault],
            defaultModel: ''
        }
    ];
}
