import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { SkillBundleKind } from '../common/skill-bundle';
import { GlobalStorageService } from './global-storage-service';

export const WORKSPACE_SKILL_INSTRUCTION_MAX_CHARS = 8_000;
export const WORKSPACE_SKILLS_TOTAL_MAX_CHARS = 24_000;
export const WORKSPACE_SKILL_ENABLEMENT_STORAGE_KEY = 'poiesis.workspace-skills.enablement.v1';

interface WorkspaceSkillEnablement {
    [skillDocumentUri: string]: boolean;
}

export interface WorkspaceSkillDefinition {
    id: string;
    name: string;
    description: string;
    kind?: SkillBundleKind;
    uri: string;
    instructions?: string;
    enabled: boolean;
    error?: string;
}

export interface WorkspaceSkillPrompt {
    content: string;
    diagnostics: string[];
    includedSkillIds: string[];
}

/** Reads workspace skill.md bundles at the execution boundary and keeps only activation state globally. */
@injectable()
export class WorkspaceSkillService {
    constructor(
        @inject(FileService) protected readonly fileService: FileService,
        @inject(GlobalStorageService) protected readonly globalStorageService: GlobalStorageService
    ) { }

    async list(root: URI): Promise<WorkspaceSkillDefinition[]> {
        const skillsDirectory = root.resolve('.poiesis/skills');
        if (!await this.fileService.exists(skillsDirectory)) {
            return [];
        }
        const enablement = await this.readEnablement();
        const stat = await this.fileService.resolve(skillsDirectory);
        return Promise.all((stat.children ?? [])
            .filter(child => child.isDirectory)
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(async child => {
                const skillUri = child.resource.resolve('skill.md');
                const rawUri = skillUri.toString();
                const enabled = enablement[rawUri] !== false;
                if (!await this.fileService.exists(skillUri)) {
                    return {
                        id: child.name,
                        name: child.name,
                        description: '',
                        uri: rawUri,
                        enabled,
                        error: 'skill.mdがありません。'
                    };
                }
                try {
                    const content = await this.fileService.read(skillUri);
                    return this.parse(child.name, skillUri, content.value, enabled);
                } catch (error) {
                    return {
                        id: child.name,
                        name: child.name,
                        description: '',
                        uri: rawUri,
                        enabled,
                        error: `skill.mdを読み込めませんでした: ${this.errorMessage(error)}`
                    };
                }
            }));
    }

    parse(id: string, uri: URI, rawContent: string, enabled = true): WorkspaceSkillDefinition {
        const content = rawContent.replace(/^\uFEFF/, '');
        const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!frontmatter) {
            return {
                id,
                name: id,
                description: '',
                uri: uri.toString(),
                enabled,
                error: 'frontmatterがありません。name、description、kindを定義してください。'
            };
        }
        const fields = new Map<string, string>();
        for (const line of frontmatter[1].split(/\r?\n/)) {
            const separator = line.indexOf(':');
            if (separator > 0) {
                fields.set(line.slice(0, separator).trim(), this.frontmatterValue(line.slice(separator + 1)));
            }
        }
        const name = fields.get('name');
        const description = fields.get('description');
        const kind = fields.get('kind');
        if (!name || !description || (kind !== 'agent' && kind !== 'results')) {
            return {
                id,
                name: name || id,
                description: description || '',
                uri: uri.toString(),
                enabled,
                error: 'frontmatterのname、description、kind（agent／results）を確認してください。'
            };
        }
        return {
            id,
            name,
            description,
            kind,
            uri: uri.toString(),
            instructions: content.slice(frontmatter[0].length).trim(),
            enabled
        };
    }

    async setEnabled(skillDocumentUri: string, enabled: boolean): Promise<void> {
        const enablement = await this.readEnablement();
        enablement[skillDocumentUri] = enabled;
        await this.globalStorageService.setData(WORKSPACE_SKILL_ENABLEMENT_STORAGE_KEY, enablement);
    }

    async buildPrompt(workspaceUri: string | undefined, kind: SkillBundleKind): Promise<WorkspaceSkillPrompt> {
        if (!workspaceUri) {
            return { content: '', diagnostics: [], includedSkillIds: [] };
        }
        let skills: WorkspaceSkillDefinition[];
        try {
            skills = await this.list(new URI(workspaceUri));
        } catch (error) {
            return {
                content: '',
                diagnostics: [`Workspace Skillsを読み込めないためスキップしました: ${this.errorMessage(error)}`],
                includedSkillIds: []
            };
        }
        const diagnostics: string[] = [];
        const sections: string[] = [];
        const includedSkillIds: string[] = [];
        let instructionCharacters = 0;
        for (const skill of skills) {
            if (!skill.enabled) {
                continue;
            }
            if (skill.error) {
                diagnostics.push(`Workspace Skill「${skill.id}」をスキップしました: ${skill.error}`);
                continue;
            }
            if (skill.kind !== kind) {
                continue;
            }
            const instructions = this.truncateInstructions(skill.instructions ?? '', skill.id, diagnostics);
            if (instructionCharacters + instructions.length > WORKSPACE_SKILLS_TOTAL_MAX_CHARS) {
                diagnostics.push(`Workspace Skill「${skill.id}」以降を合計${WORKSPACE_SKILLS_TOTAL_MAX_CHARS.toLocaleString()}文字の上限によりスキップしました。`);
                break;
            }
            instructionCharacters += instructions.length;
            sections.push(`### ${skill.name}\n${instructions}`);
            includedSkillIds.push(skill.id);
        }
        return {
            content: sections.length > 0
                ? `\n\n## Workspace skills (user-defined instructions)\n${sections.join('\n\n')}`
                : '',
            diagnostics,
            includedSkillIds
        };
    }

    protected truncateInstructions(instructions: string, id: string, diagnostics: string[]): string {
        if (instructions.length <= WORKSPACE_SKILL_INSTRUCTION_MAX_CHARS) {
            return instructions;
        }
        const marker = '\n[このSkillは8,000文字の上限で切り詰められました]';
        diagnostics.push(`Workspace Skill「${id}」を${WORKSPACE_SKILL_INSTRUCTION_MAX_CHARS.toLocaleString()}文字に切り詰めました。`);
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

    protected frontmatterValue(rawValue: string): string {
        const value = rawValue.trim();
        const quote = value[0];
        return value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote
            ? value.slice(1, -1)
            : value;
    }

    protected errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
