import { join } from 'node:path';
import { AiRole, CliModelOption, KnownCliId } from '../common/agent-runtime-protocol';

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

/**
 * Model entries are deliberately curated from locally verified CLI help/config/cache output.
 * They are not presented as a live provider model-listing API; Custom always accepts an explicit id.
 */
export function knownCliDefinitions(): readonly KnownCliDefinition[] {
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    const userProfile = process.env.USERPROFILE;
    const compact = (values: Array<string | undefined>): string[] =>
        values.filter((value): value is string => Boolean(value));
    const cliDefault: CliModelOption = { id: '', label: '既定 (CLIの設定に従う)' };
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
                { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
                { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
                { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
                { id: 'gpt-5.5', label: 'GPT-5.5' },
                { id: 'gpt-5.4', label: 'GPT-5.4' }
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
                { id: 'fable', label: 'fable (既定)' },
                { id: 'opus', label: 'opus' },
                { id: 'sonnet', label: 'sonnet' },
                { id: 'haiku', label: 'haiku' }
            ],
            defaultModel: 'fable'
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
