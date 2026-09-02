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

const CITATION_ASSERTION = '変更ファイルがある場合、本文に根拠引用がある';
const HEADING_ASSERTION = '本文に見出し（h2〜h4）がある';
const EMPTY_HEADING_ASSERTION = '空の見出しがない';
const RETRY_INTRO = '前回の生成は次の必須条件を満たしていませんでした。今回は必ず満たしてください:';

/** Runs the Application-owned checks that apply to every AI-generated Results document. */
export function checkAppResultsAssertions(
    html: string,
    changedFiles: readonly string[]
): ResultsAssertionResult[] {
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? html;
    const headings = [...body.matchAll(/<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)];
    const hasCitation = /\bdata-poiesis-citation\s*=/i.test(body);
    const emptyHeadings = headings.filter(match => !htmlText(match[2]).trim());
    return [
        {
            text: CITATION_ASSERTION,
            source: 'app',
            status: changedFiles.length === 0 || hasCitation ? 'pass' : 'fail',
            evidence: changedFiles.length === 0
                ? '変更ファイルがないため引用は不要です。'
                : hasCitation ? '根拠引用を確認しました。' : '根拠引用がありません。'
        },
        {
            text: HEADING_ASSERTION,
            source: 'app',
            status: headings.length > 0 ? 'pass' : 'fail',
            evidence: headings.length > 0 ? `見出しを${headings.length}件確認しました。` : '見出しがありません。'
        },
        {
            text: EMPTY_HEADING_ASSERTION,
            source: 'app',
            status: emptyHeadings.length === 0 ? 'pass' : 'fail',
            evidence: emptyHeadings.length === 0 ? '空の見出しはありません。' : `空の見出しが${emptyHeadings.length}件あります。`
        }
    ];
}

/** Converts generated HTML to the bounded, text-only representation sent to the assertion judge. */
export function extractResultsAssertionText(html: string, maxChars = 60_000): string {
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? html;
    const text = body
        .replace(/<!--([\s\S]*?)-->/g, ' ')
        .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi, ' ')
        .replace(/<h[2-4]\b[^>]*>([\s\S]*?)<\/h[2-4]\s*>/gi, (_match, heading: string) => `\n## ${htmlText(heading)}\n`)
        .replace(/<br\s*\/?>|<\/(?:p|li|div|section|article|table|tr|ul|ol)>/gi, '\n')
        .replace(/<[^>]*>/g, ' ');
    const normalized = decodeHtmlEntities(text)
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return normalized.slice(0, Math.max(0, maxChars));
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
    return failed.length > 0 ? `${RETRY_INTRO}\n${failed.map(assertion => `- ${assertion.text}`).join('\n')}` : '';
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
    return value
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#(?:39|x27);/gi, "'")
        .replace(/&#(\d+);/g, (match, code: string) => {
            const value = Number(code);
            return validCodePoint(value) ? String.fromCodePoint(value) : match;
        })
        .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => {
            const value = Number.parseInt(code, 16);
            return validCodePoint(value) ? String.fromCodePoint(value) : match;
        });
}

function validCodePoint(value: number): boolean {
    return Number.isInteger(value) && value >= 0 && value <= 0x10FFFF;
}
