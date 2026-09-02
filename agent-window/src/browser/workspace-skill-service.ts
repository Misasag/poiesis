import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { SkillBundleKind } from '../common/skill-bundle';
import { GlobalStorageService } from './global-storage-service';
import { mergeSkillsByRank, parseSkillDocument } from './skill-document';

export const WORKSPACE_SKILL_INSTRUCTION_MAX_CHARS = 8_000;
export const WORKSPACE_SKILLS_TOTAL_MAX_CHARS = 24_000;
export const WORKSPACE_SKILL_ENABLEMENT_STORAGE_KEY = 'poiesis.workspace-skills.enablement.v1';

interface WorkspaceSkillEnablement {
    [skillDocumentUri: string]: boolean;
}

export type WorkspaceSkillSource = 'workspace' | 'workspace-agents' | 'user' | 'user-agents';

export interface WorkspaceSkillDiscoveryRoot {
    uri: URI;
    source: WorkspaceSkillSource;
    rank: number;
    pathLabel: string;
}

export interface WorkspaceSkillDefinition {
    id: string;
    name: string;
    description: string;
    kind: SkillBundleKind;
    uri: string;
    instructions?: string;
    enabled: boolean;
    error?: string;
    source: WorkspaceSkillSource;
    rank: number;
    shadowedBy?: string;
    warnings: string[];
}

export interface WorkspaceSkillPrompt {
    content: string;
    diagnostics: string[];
    includedSkillIds: string[];
}

export interface WorkspaceSkillPreview {
    prompt: WorkspaceSkillPrompt;
    perSkill: Array<{
        id: string;
        name: string;
        source: WorkspaceSkillSource;
        chars: number;
        included: boolean;
        reason?: string;
    }>;
    limits: {
        perSkill: 8000;
        total: 24000;
    };
}

/** Reads compatible Skill bundles at the execution boundary and keeps only activation state globally. */
@injectable()
export class WorkspaceSkillService {
    constructor(
        @inject(FileService) protected readonly fileService: FileService,
        @inject(GlobalStorageService) protected readonly globalStorageService: GlobalStorageService,
        @inject(EnvVariablesServer) protected readonly envVariablesServer: EnvVariablesServer
    ) { }

    async getDiscoveryRoots(root: URI): Promise<WorkspaceSkillDiscoveryRoot[]> {
        const home = new URI(await this.envVariablesServer.getHomeDirUri());
        return [
            { uri: root.resolve('.poiesis/skills'), source: 'workspace', rank: 100, pathLabel: '.poiesis/skills' },
            { uri: root.resolve('.agents/skills'), source: 'workspace-agents', rank: 200, pathLabel: '.agents/skills' },
            { uri: home.resolve('.poiesis/skills'), source: 'user', rank: 300, pathLabel: '~/.poiesis/skills' },
            { uri: home.resolve('.agents/skills'), source: 'user-agents', rank: 400, pathLabel: '~/.agents/skills' }
        ];
    }

    async list(root: URI): Promise<WorkspaceSkillDefinition[]> {
        const enablement = await this.readEnablement();
        const roots = await this.getDiscoveryRoots(root);
        const discovered = (await Promise.all(roots.map(candidate => this.listRoot(candidate, enablement)))).flat();
        return mergeSkillsByRank(discovered);
    }

    parse(
        id: string,
        uri: URI,
        rawContent: string,
        enabled = true,
        source: WorkspaceSkillSource = 'workspace',
        rank = 100,
        warnings: readonly string[] = []
    ): WorkspaceSkillDefinition {
        const parsed = parseSkillDocument(id, rawContent, { warnings });
        return {
            id,
            name: parsed.name,
            description: parsed.description,
            kind: parsed.kind,
            uri: uri.toString(),
            instructions: parsed.instructions,
            enabled,
            error: parsed.error,
            source,
            rank,
            warnings: parsed.warnings
        };
    }

    async setEnabled(skillDocumentUri: string, enabled: boolean): Promise<void> {
        const enablement = await this.readEnablement();
        enablement[skillDocumentUri] = enabled;
        await this.globalStorageService.setData(WORKSPACE_SKILL_ENABLEMENT_STORAGE_KEY, enablement);
    }

    async buildPrompt(workspaceUri: string | undefined, kind: SkillBundleKind): Promise<WorkspaceSkillPrompt> {
        return (await this.preview(workspaceUri, kind)).prompt;
    }

    async preview(workspaceUri: string | undefined, kind: SkillBundleKind): Promise<WorkspaceSkillPreview> {
        const limits = {
            perSkill: WORKSPACE_SKILL_INSTRUCTION_MAX_CHARS,
            total: WORKSPACE_SKILLS_TOTAL_MAX_CHARS
        } as const;
        if (!workspaceUri) {
            return {
                prompt: { content: '', diagnostics: [], includedSkillIds: [] },
                perSkill: [],
                limits
            };
        }

        let skills: WorkspaceSkillDefinition[];
        try {
            skills = await this.list(new URI(workspaceUri));
        } catch (error) {
            return {
                prompt: {
                    content: '',
                    diagnostics: [`Workspace Skillsを読み込めないためスキップしました: ${this.errorMessage(error)}`],
                    includedSkillIds: []
                },
                perSkill: [],
                limits
            };
        }

        const diagnostics: string[] = [];
        const sections: string[] = [];
        const includedSkillIds: string[] = [];
        const perSkill: WorkspaceSkillPreview['perSkill'] = skills.map(skill => ({
            id: skill.id,
            name: skill.name,
            source: skill.source,
            chars: (skill.instructions ?? '').length,
            included: false
        }));
        const skillByUri = new Map(skills.map(skill => [skill.uri, skill]));
        for (const skill of skills) {
            if (!skill.shadowedBy) {
                continue;
            }
            const winner = skillByUri.get(skill.shadowedBy);
            diagnostics.push(
                `Skill「${skill.id}」(${this.sourceLabel(skill.source)}) は ${winner ? this.sourceLabel(winner.source) : '上位'} の同名 Skill に隠れています`
            );
        }

        let instructionCharacters = 0;
        let totalLimitReached = false;
        for (let index = 0; index < skills.length; index++) {
            const skill = skills[index];
            const item = perSkill[index];
            if (skill.shadowedBy) {
                item.reason = '同名Skillに隠れています';
                continue;
            }
            if (!skill.enabled) {
                item.reason = '無効';
                continue;
            }
            if (skill.error) {
                item.reason = skill.error;
                diagnostics.push(`Skill「${skill.id}」をスキップしました: ${skill.error}`);
                continue;
            }
            if (skill.kind !== kind) {
                item.reason = kind === 'agent' ? 'Results Skill' : 'Agent Skill';
                continue;
            }
            for (const warning of skill.warnings) {
                diagnostics.push(`Skill「${skill.id}」: ${warning}`);
            }
            if (totalLimitReached) {
                item.reason = '合計上限により未注入';
                continue;
            }
            const instructions = this.truncateInstructions(skill.instructions ?? '', skill.id, diagnostics);
            if (instructionCharacters + instructions.length > WORKSPACE_SKILLS_TOTAL_MAX_CHARS) {
                item.reason = '合計上限により未注入';
                totalLimitReached = true;
                diagnostics.push(
                    `Skill「${skill.id}」以降を合計${WORKSPACE_SKILLS_TOTAL_MAX_CHARS.toLocaleString('ja-JP')}文字の上限によりスキップしました。`
                );
                continue;
            }
            instructionCharacters += instructions.length;
            item.included = true;
            if (item.chars > WORKSPACE_SKILL_INSTRUCTION_MAX_CHARS) {
                item.reason = `${WORKSPACE_SKILL_INSTRUCTION_MAX_CHARS.toLocaleString('ja-JP')} 文字で切り詰め`;
            }
            sections.push(`### ${skill.name}\n${instructions}`);
            includedSkillIds.push(skill.id);
        }
        return {
            prompt: {
                content: sections.length > 0
                    ? `\n\n## Workspace skills (user-defined instructions)\n${sections.join('\n\n')}`
                    : '',
                diagnostics,
                includedSkillIds
            },
            perSkill,
            limits
        };
    }

    protected async listRoot(
        root: WorkspaceSkillDiscoveryRoot,
        enablement: WorkspaceSkillEnablement
    ): Promise<WorkspaceSkillDefinition[]> {
        if (!await this.fileService.exists(root.uri)) {
            return [];
        }
        const stat = await this.fileService.resolve(root.uri);
        return Promise.all((stat.children ?? [])
            .filter(child => child.isDirectory)
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(child => this.readSkillDirectory(child.name, child.resource, root, enablement)));
    }

    protected async readSkillDirectory(
        id: string,
        skillDirectory: URI,
        root: WorkspaceSkillDiscoveryRoot,
        enablement: WorkspaceSkillEnablement
    ): Promise<WorkspaceSkillDefinition> {
        const stat = await this.fileService.resolve(skillDirectory);
        const entries = (stat.children ?? [])
            .filter(child => !child.isDirectory && child.name.toLowerCase() === 'skill.md')
            .sort((left, right) => left.name.localeCompare(right.name));
        const preferred = entries.find(entry => entry.name === 'SKILL.md') ?? entries[0];
        const skillUri = preferred?.resource ?? skillDirectory.resolve('SKILL.md');
        const rawUri = skillUri.toString();
        const enabled = enablement[rawUri] !== false;
        const warnings = entries.length > 1
            ? ['skill.md と SKILL.md の両方があるため SKILL.md を使用します']
            : [];
        if (!preferred) {
            return {
                id,
                name: id,
                description: '',
                kind: 'agent',
                uri: rawUri,
                enabled,
                error: 'skill.mdまたはSKILL.mdがありません。',
                source: root.source,
                rank: root.rank,
                warnings
            };
        }
        try {
            const content = await this.fileService.read(skillUri);
            return this.parse(id, skillUri, content.value, enabled, root.source, root.rank, warnings);
        } catch (error) {
            return {
                id,
                name: id,
                description: '',
                kind: 'agent',
                uri: rawUri,
                enabled,
                error: `${preferred.name}を読み込めませんでした: ${this.errorMessage(error)}`,
                source: root.source,
                rank: root.rank,
                warnings
            };
        }
    }

    protected truncateInstructions(instructions: string, id: string, diagnostics: string[]): string {
        if (instructions.length <= WORKSPACE_SKILL_INSTRUCTION_MAX_CHARS) {
            return instructions;
        }
        const marker = '\n[このSkillは8,000文字の上限で切り詰められました]';
        diagnostics.push(`Skill「${id}」を${WORKSPACE_SKILL_INSTRUCTION_MAX_CHARS.toLocaleString('ja-JP')}文字に切り詰めました。`);
        return `${instructions.slice(0, WORKSPACE_SKILL_INSTRUCTION_MAX_CHARS - marker.length)}${marker}`;
    }

    protected async readEnablement(): Promise<WorkspaceSkillEnablement> {
        try {
            return await this.globalStorageService.getData<WorkspaceSkillEnablement>(WORKSPACE_SKILL_ENABLEMENT_STORAGE_KEY) ?? {};
        } catch (error) {
            console.warn('[Poiesis] Workspace Skill enablement could not be read; using enabled defaults.', error);
            return {};
        }
    }

    protected sourceLabel(source: WorkspaceSkillSource): string {
        switch (source) {
            case 'workspace': return 'Workspace';
            case 'workspace-agents': return 'Workspace (.agents/skills)';
            case 'user': return 'ユーザー';
            case 'user-agents': return 'ユーザー (.agents/skills)';
        }
    }

    protected errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
