import type { AgentActivity, AgentActivityKind, AgentActivityStatus } from '../common/agent-provider';

const MESSAGE_EVIDENCE_MAX_CHARS = 200;
const TRUNCATED_EVIDENCE_MARKER = "[古い実行記録を省略しました]";

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
