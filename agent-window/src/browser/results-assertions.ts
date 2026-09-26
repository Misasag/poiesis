export type ResultsAssertionSource = 'app' | 'skill';
export type ResultsAssertionStatus = 'pass' | 'fail' | 'unknown';

export interface ResultsAssertionDefinition {
    text: string;
    skillId?: string;
}

export interface ResultsAssertionResult extends ResultsAssertionDefinition {
    source: ResultsAssertionSource;
    status: ResultsAssertionStatus;
    evidence?: string;
}

export interface ResultsAssertionCandidate<T> {
    document: T;
    assertions: readonly ResultsAssertionResult[];
}

const RETRY_INTRO = "前回の生成は次の必須条件を満たしていませんでした。今回は必ず満たしてください:";

const ASSERTION_TEXT_MAX_CHARS = 60_000;
const TABLE_MAX_BODY_ROWS = 50;
const TABLE_MAX_COLUMNS = 12;
const TABLE_CELL_MAX_CHARS = 500;

/** Converts generated HTML to bounded Markdown-like evidence without losing document structure. */
export function extractResultsAssertionText(html: string, maxChars = 60_000): string {
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? html;
    const clean = body
        .replace(/<!--([\s\S]*?)-->/g, ' ')
        .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, ' ');
    const parts: string[] = [];
    let offset = 0;
    // Keep structured blocks out of prose whitespace normalization and decode entities only once.
    for (const block of clean.matchAll(/<(table|pre)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
        parts.push(assertionProse(clean.slice(offset, block.index)));
        if (block[1].toLowerCase() === 'table') {
            parts.push(assertionTable(block[2]));
        } else {
            const code = decodeHtmlEntities(block[2].replace(/<[^>]*>/g, '')).trim();
            const fence = '`'.repeat([...code.matchAll(/`+/g)].reduce((length, match) => Math.max(length, match[0].length + 1), 3));
            parts.push(`${fence}\n${code}\n${fence}`);
        }
        offset = block.index! + block[0].length;
    }
    parts.push(assertionProse(clean.slice(offset)));
    return parts.filter(Boolean).join('\n\n').trim().slice(0, Math.max(0, Math.min(maxChars, ASSERTION_TEXT_MAX_CHARS)));
}

function assertionProse(html: string): string {
    const text = html
        .replace(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]\s*>/gi, (_match, heading: string) => `\n## ${heading}\n`)
        .replace(/<(?:ul|ol)\b[^>]*>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '- ')
        .replace(/<br\s*\/?>|<\/(?:p|li|div|section|article|table|tr|ul|ol)>/gi, '\n')
        .replace(/<[^>]*>/g, ' ');
    return decodeHtmlEntities(text)
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function assertionTable(html: string): string {
    const rows: string[][] = [];
    let truncated = false;
    for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
        const cells = [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)];
        if (!cells.length) { continue; }
        if (rows.length === TABLE_MAX_BODY_ROWS + 1) { truncated = true; break; }
        if (cells.length > TABLE_MAX_COLUMNS) { truncated = true; }
        rows.push(cells.slice(0, TABLE_MAX_COLUMNS).map(cell => {
            let text = htmlText(cell[1]).trim();
            if (text.length > TABLE_CELL_MAX_CHARS) {
                text = `${text.slice(0, TABLE_CELL_MAX_CHARS - 1)}…`;
                truncated = true;
            }
            return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
        }));
    }
    if (!rows.length) { return assertionProse(html); }
    const columns = Math.max(...rows.map(row => row.length));
    const pipeRow = (cells: string[]): string => `| ${Array.from({ length: columns }, (_, index) => cells[index] ?? '').join(' | ')} |`;
    const caption = html.match(/<caption\b[^>]*>([\s\S]*?)<\/caption\s*>/i)?.[1];
    return [caption ? htmlText(caption).trim() : '', pipeRow(rows[0]), pipeRow(Array(columns).fill('---')),
        ...rows.slice(1).map(pipeRow), truncated ? '（表の一部を省略しています。）' : ''].filter(Boolean).join('\n');
}

/** Parses the judge's complete JSON response. Any contract violation makes every result unknown. */
export function parseResultsAssertionJudgement(
    output: string,
    definitions: readonly ResultsAssertionDefinition[]
): ResultsAssertionResult[] {
    const unknown = (): ResultsAssertionResult[] => definitions.map(definition => ({
        ...definition,
        source: 'skill',
        status: 'unknown'
    }));
    try {
        const parsed = JSON.parse(output.trim()) as { results?: unknown };
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
            || Object.keys(parsed).length !== 1
            || !Array.isArray(parsed.results)
            || parsed.results.length !== definitions.length) {
            return unknown();
        }
        const byIndex = new Map<number, { pass: boolean; evidence: string }>();
        for (const candidate of parsed.results) {
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
                return unknown();
            }
            const record = candidate as Record<string, unknown>;
            if (Object.keys(record).some(key => !['index', 'pass', 'evidence'].includes(key))
                || !Number.isInteger(record.index)
                || typeof record.pass !== 'boolean'
                || typeof record.evidence !== 'string'
                || record.evidence.length > 120
                || (record.index as number) < 0
                || (record.index as number) >= definitions.length
                || byIndex.has(record.index as number)) {
                return unknown();
            }
            byIndex.set(record.index as number, {
                pass: record.pass,
                evidence: record.evidence
            });
        }
        if (byIndex.size !== definitions.length) {
            return unknown();
        }
        return definitions.map((definition, index) => {
            const result = byIndex.get(index)!;
            return {
                ...definition,
                source: 'skill',
                status: result.pass ? 'pass' : 'fail',
                evidence: result.evidence
            };
        });
    } catch {
        return unknown();
    }
}

/** Chooses the candidate with fewer failures; the second candidate wins a tie. */
export function selectBetterResultsAssertionCandidate<T>(
    first: ResultsAssertionCandidate<T>,
    second: ResultsAssertionCandidate<T>
): ResultsAssertionCandidate<T> {
    const failures = (candidate: ResultsAssertionCandidate<T>): number =>
        candidate.assertions.filter(assertion => assertion.status === 'fail').length;
    return failures(first) < failures(second) ? first : second;
}

export function buildFailedAssertionPromptSection(assertions: readonly ResultsAssertionResult[]): string {
    const failed = assertions.filter(assertion => assertion.status === 'fail');
    return failed.length > 0 ? `${RETRY_INTRO}\n${failed.map(assertion =>
        `- ${assertion.text}${assertion.evidence ? `: ${assertion.evidence}` : ''}`).join('\n')}` : '';
}

/** Produces a stable short fallback when the title AI is unavailable or invalid. */
export function shortRequirementTitleFallback(taskTitle: string): string {
    const compact = taskTitle.replace(/\s+/g, ' ').trim();
    const boundary = [...compact].findIndex(character => character === '。' || character === '、' || character === 'を');
    const end = boundary > 0 ? Math.min(boundary, 24) : Math.min(compact.length, 24);
    return compact.slice(0, end).replace(/[\s。、]+$/g, '') || compact.slice(0, 24) || '要件';
}

function htmlText(value: string): string {
    return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
}

function decodeHtmlEntities(value: string): string {
    const named: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return value.replace(/&(nbsp|amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (match, entity: string) => {
        const lower = entity.toLowerCase();
        if (named[lower] !== undefined) { return named[lower]; }
        const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number(lower.slice(1));
        return validCodePoint(code) ? code === 160 ? ' ' : String.fromCodePoint(code) : match;
    });
}

function validCodePoint(value: number): boolean {
    return Number.isInteger(value) && value >= 0 && value <= 0x10FFFF;
}
