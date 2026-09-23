import type { AgentActivity } from './agent-provider';

export interface CatalogSkill {
    id: string;
    name: string;
    path: string;
}

export function isOnDemandAgentSkill(skill: { kind: string; source: string }): boolean {
    return skill.kind === 'agent' && (skill.source === 'user' || skill.source === 'user-agents');
}

export function skillCatalogEntry(skill: { name: string; description: string }, path: string): string {
    return `### ${skill.name}\n${skill.description}\nSKILL.md: ${path}`;
}

/** Only successful reads count; search hits, edits, and merely mentioning a file do not. */
export function referencedCatalogSkills(skills: readonly CatalogSkill[], activity: AgentActivity): CatalogSkill[] {
    if (activity.status !== 'completed') { return []; }
    const paths = activity.readPaths ?? [];
    return skills.filter(skill => paths.some(path => comparablePath(path) === comparablePath(skill.path)));
}

function comparablePath(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

/** Recognize explicit file operands of common shell readers without treating arbitrary mentions as reads. */
export function shellReadPaths(command: string): string[] {
    const paths: string[] = [];
    const readers = /(?:^|[;|&\n]|(?:-Command|-c|-lc)\s+["'])\s*(?:Get-Content|cat|head|tail|type|sed)\s+([^;|&\n]+)/gi;
    for (const match of command.matchAll(readers)) {
        const tokens = match[1].match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
        for (const token of tokens) {
            const value = token.replace(/^["']|["']$/g, '');
            if (/^(?:[a-z]:[\\/]|\/)/i.test(value) && /[\\/]skill\.md$/i.test(value)) {
                paths.push(value);
            }
        }
    }
    return paths;
}
