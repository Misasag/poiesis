import type { AgentActivity, AgentActivityKind, AgentActivityStatus } from '../common/agent-provider';

const AI_RESULTS_HTML_MAX_CHARS = 280_000;
const MESSAGE_EVIDENCE_MAX_CHARS = 200;
const TRUNCATED_EVIDENCE_MARKER = '[古い実行記録を省略しました]';

export interface NormalizeAiResultsHtmlOptions {
    taskTitle: string;
}

export interface NormalizedAiResultsHtml {
    html: string;
    notes: string[];
}

/** Normalizes recoverable AI output while preserving the Application-owned Results boundary. */
export function normalizeAiResultsHtml(
    output: string,
    options: NormalizeAiResultsHtmlOptions
): NormalizedAiResultsHtml {
    let html = output.trim();
    const notes: string[] = [];
    const fenced = html.match(/```(?:html)?\s*([\s\S]*?)```/i);
    if (fenced) {
        html = fenced[1].trim();
        notes.push('Markdown code fence was removed.');
    }
    if (html.length > AI_RESULTS_HTML_MAX_CHARS) {
        throw new Error(`AI Results HTML exceeded ${AI_RESULTS_HTML_MAX_CHARS} characters.`);
    }
    const completeDocument = /^(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s|>)[\s\S]*<\/html\s*>\s*$/i;
    if (!completeDocument.test(html) || (html.match(/<html(?:\s|>)/gi)?.length ?? 0) !== 1) {
        throw new Error('AI Results did not return one complete HTML document.');
    }
    if (/<script\b|<link\b|\son\w+\s*=|(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i.test(html)) {
        throw new Error('AI Results HTML contained scripts or external resources.');
    }

    html = removeLeadingTaskTitleHeading(html, options.taskTitle, notes);
    if (/<h1\b/i.test(html)) {
        html = html
            .replace(/<h1\b/gi, '<h2')
            .replace(/<\/h1\s*>/gi, '</h2>');
        notes.push('Remaining h1 elements were demoted to h2.');
    }
    return {
        html: html.replace(/\bTASK-\d+(?:-\d+)+\b/gi, '完了したタスク'),
        notes
    };
}

/** Formats Application-observed activities as compact evidence, ordered oldest to newest. */
export function formatExecutionEvidence(
    activities: readonly AgentActivity[] | undefined,
    maxChars: number
): string {
    if (!activities?.length || maxChars <= 0) {
        return '';
    }
    const lines = activities
        .map((activity, index) => ({ activity, index }))
        .filter(({ activity }) => activity.kind !== 'reasoning')
        .sort((left, right) => activityTime(left.activity).localeCompare(activityTime(right.activity))
            || left.index - right.index)
        .flatMap(({ activity }) => {
            const line = evidenceLine(activity);
            return line ? [line] : [];
        });
    if (!lines.length) {
        return '';
    }
    const complete = lines.join('\n');
    if (complete.length <= maxChars) {
        return complete;
    }
    while (lines.length > 0 && `${TRUNCATED_EVIDENCE_MARKER}\n${lines.join('\n')}`.length > maxChars) {
        lines.shift();
    }
    if (!lines.length) {
        return TRUNCATED_EVIDENCE_MARKER.slice(0, maxChars);
    }
    return `${TRUNCATED_EVIDENCE_MARKER}\n${lines.join('\n')}`;
}

function removeLeadingTaskTitleHeading(html: string, taskTitle: string, notes: string[]): string {
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
    const heading = body?.[1].match(/<h([12])\b[^>]*>([\s\S]*?)<\/h\1\s*>/i);
    if (!body || !heading || heading.index === undefined) {
        return html;
    }
    const preceding = body[1].slice(0, heading.index)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(?:main|section|article|header|div)\b[^>]*>/gi, '')
        .trim();
    if (preceding || !sameTaskTitle(textContent(heading[2]), taskTitle)) {
        return html;
    }
    notes.push('Leading heading duplicated the Application-owned task title and was removed.');
    const bodyWithoutHeading = `${body[1].slice(0, heading.index)}${body[1].slice(heading.index + heading[0].length)}`;
    return html.replace(body[1], bodyWithoutHeading);
}

function sameTaskTitle(heading: string, taskTitle: string): boolean {
    const normalizedHeading = normalizeTitle(heading);
    const normalizedTaskTitle = normalizeTitle(taskTitle);
    if (!normalizedHeading || !normalizedTaskTitle) {
        return false;
    }
    if (normalizedHeading === normalizedTaskTitle) {
        return true;
    }
    const headingPrefix = normalizedHeading.endsWith('…') ? normalizedHeading.slice(0, -1) : undefined;
    const taskPrefix = normalizedTaskTitle.endsWith('…') ? normalizedTaskTitle.slice(0, -1) : undefined;
    return Boolean(headingPrefix && normalizedTaskTitle.startsWith(headingPrefix)
        || taskPrefix && normalizedHeading.startsWith(taskPrefix));
}

function normalizeTitle(value: string): string {
    return decodeBasicEntities(value).replace(/\s+/g, '').trim();
}

function textContent(value: string): string {
    return value.replace(/<[^>]*>/g, '');
}

function decodeBasicEntities(value: string): string {
    return value
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#(?:39|x27);/gi, "'");
}

function evidenceLine(activity: AgentActivity): string | undefined {
    const detail = activity.detail?.replace(/\s+/g, ' ').trim();
    if (activity.kind === 'message') {
        return detail ? `[メッセージ] ${truncate(detail, MESSAGE_EVIDENCE_MAX_CHARS)}` : undefined;
    }
    const label = activityKindLabel(activity.kind, activity.title);
    return `[${activityStatusLabel(activity.status)}] ${label}${detail ? `: ${detail}` : ''}`;
}

function activityKindLabel(kind: AgentActivityKind, title: string): string {
    if (kind === 'command') {
        return 'コマンド実行';
    }
    if (kind === 'file-change') {
        return 'ファイル変更';
    }
    if (kind === 'read') {
        return title === '検索' ? '検索' : 'ファイル読み取り';
    }
    return kind === 'tool' ? `ツール実行${title && title !== 'tool' ? ` (${title})` : ''}` : title;
}

function activityStatusLabel(status: AgentActivityStatus): string {
    return status === 'completed' ? '完了' : status === 'failed' ? '失敗' : '実行中';
}

function activityTime(activity: AgentActivity): string {
    return activity.endedAt ?? activity.startedAt;
}

function truncate(value: string, maxChars: number): string {
    return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
