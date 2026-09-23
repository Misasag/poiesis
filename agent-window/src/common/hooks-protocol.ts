export const HooksServer = Symbol('HooksServer');
export const hooksServerPath = '/services/poiesis/hooks';
export const HOOK_EVENTS = ['promptSubmit', 'taskStart', 'taskEnd', 'resultsGenerate', 'sessionResume'] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
export type HookScope = 'user' | 'workspace';
export const HOOK_EVENT_LABELS: Record<HookEvent, string> = {
    promptSubmit: '送信前', taskStart: '作業開始前', taskEnd: '作業終了後',
    resultsGenerate: '成果の生成前', sessionResume: '会話の再開時'
};
export interface HookDefinition {
    id: string; command: string[]; timeoutMs: number; policy: 'advisory' | 'required'; enabled: boolean;
}
export interface HookRun {
    id: string; event: HookEvent; scope: HookScope; runId: string;
    status: 'pass' | 'fail'; durationMs: number; time: string;
    stdinBytes: number; stdoutBytes: number; error?: string;
}
export interface HookEvidence {
    hookId: string; runId: string; notes?: string; incomplete?: boolean;
    evidence: { label: string; status: 'pass' | 'fail' | 'unknown'; detail: string; image?: string }[];
}
export interface HookInput {
    schemaVersion: 1; event: HookEvent; workspace: string;
    sessionId: string; taskId: string; requirementId: string; runId: string;
    providerId: string; model: string; data: Record<string, unknown>;
}
export interface HookResult {
    runs: HookRun[]; contexts: { id: string; content: string }[];
    evidence: HookEvidence[]; material: string; blockReason?: string;
}
export interface HookRow extends HookDefinition { event: HookEvent; scope: HookScope; lastRun?: HookRun }
export interface HookConfiguration { rows: HookRow[]; workspaceEnabled: boolean; errors: string[]; errorScopes?: HookScope[] }
export interface HooksServer {
    list(workspace: string): Promise<HookConfiguration>;
    setWorkspaceEnabled(workspace: string, enabled: boolean): Promise<void>;
    setEnabled(workspace: string, scope: HookScope, event: HookEvent, id: string, enabled: boolean): Promise<void>;
    run(input: HookInput): Promise<HookResult>;
}
export function emptyHookResult(): HookResult { return { runs: [], contexts: [], evidence: [], material: '' }; }
export function hookContext(results: readonly HookResult[]): string {
    let remaining = 16_000;
    const sections: string[] = [];
    for (const result of results) {
        for (const context of result.contexts) {
            const content = context.content.slice(0, Math.min(8_000, remaining));
            if (content) { sections.push(`### ${context.id}\n${content}`); remaining -= content.length; }
        }
    }
    return sections.length ? `## Harness context (hooks)\n${sections.join('\n\n')}\n\n` : '';
}
