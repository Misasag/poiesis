export type SkillDocumentKind = 'agent' | 'results';

export interface ParseSkillDocumentOptions {
    warnings?: readonly string[];
}

export interface ParsedSkillDocument {
    name: string;
    description: string;
    kind: SkillDocumentKind;
    instructions: string;
    error?: string;
    warnings: string[];
}

export interface RankedSkill {
    id: string;
    rank: number;
    uri: string;
    shadowedBy?: string;
}

const MISSING_FRONTMATTER_ERROR = 'frontmatterがありません。name、description、kindを定義してください。';
const INVALID_FRONTMATTER_ERROR = 'frontmatterのname、description、kind（agent／results）を確認してください。';
const DEFAULT_KIND_WARNING = 'kind が未指定のため Agent Skill として扱います';

/** Parses the compatible subset of Agent Skills frontmatter without browser or Theia dependencies. */
export function parseSkillDocument(
    id: string,
    rawContent: string,
    options: ParseSkillDocumentOptions = {}
): ParsedSkillDocument {
    const content = rawContent.replace(/^\uFEFF/, '');
    const warnings = [...(options.warnings ?? [])];
    const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) {
        return {
            name: id,
            description: '',
            kind: 'agent',
            instructions: '',
            error: MISSING_FRONTMATTER_ERROR,
            warnings
        };
    }

    const lines = frontmatter[1].split(/\r?\n/);
    const fields = new Map<string, string>();
    for (const line of lines) {
        const match = line.match(/^([^\s:#][^:]*)\s*:(.*)$/);
        if (match) {
            fields.set(match[1].trim(), frontmatterScalar(match[2]));
        }
    }

    const name = fields.get('name');
    const description = fields.get('description');
    const rawKind = fields.get('kind') || metadataPoiesisKind(lines);
    let kind: SkillDocumentKind = 'agent';
    if (!rawKind) {
        warnings.push(DEFAULT_KIND_WARNING);
    } else if (rawKind === 'agent' || rawKind === 'results') {
        kind = rawKind;
    }

    const error = !name || !description || (rawKind !== undefined && rawKind !== 'agent' && rawKind !== 'results')
        ? INVALID_FRONTMATTER_ERROR
        : undefined;
    return {
        name: name || id,
        description: description || '',
        kind,
        instructions: content.slice(frontmatter[0].length).trim(),
        error,
        warnings
    };
}

/** Sorts every candidate and marks lower-priority duplicate ids with the winning document URI. */
export function mergeSkillsByRank<T extends RankedSkill>(skills: readonly T[]): T[] {
    const sorted = skills.map(skill => ({ ...skill, shadowedBy: undefined } as T))
        .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id) || left.uri.localeCompare(right.uri));
    const winners = new Map<string, string>();
    return sorted.map(skill => {
        const winner = winners.get(skill.id);
        if (winner) {
            return { ...skill, shadowedBy: winner };
        }
        winners.set(skill.id, skill.uri);
        return skill;
    });
}

function metadataPoiesisKind(lines: readonly string[]): string | undefined {
    let inMetadata = false;
    let inPoiesis = false;
    for (const line of lines) {
        if (/^metadata\s*:\s*(?:#.*)?$/.test(line)) {
            inMetadata = true;
            inPoiesis = false;
            continue;
        }
        if (inMetadata && /^\S/.test(line)) {
            return undefined;
        }
        if (!inMetadata) {
            continue;
        }
        if (/^ {2}poiesis\s*:\s*(?:#.*)?$/.test(line)) {
            inPoiesis = true;
            continue;
        }
        if (inPoiesis && /^ {2}\S/.test(line)) {
            inPoiesis = false;
        }
        if (inPoiesis) {
            const kind = line.match(/^ {4}kind\s*:(.*)$/);
            if (kind) {
                return frontmatterScalar(kind[1]);
            }
        }
    }
    return undefined;
}

function frontmatterScalar(rawValue: string): string {
    const value = rawValue.trim();
    const quote = value[0];
    return value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote
        ? value.slice(1, -1)
        : value;
}
