import type { ExecutionTask, TaskChangeSet } from './task-service';

export type VerificationStatus = 'pass' | 'fail' | 'unknown' | 'outdated' | 'human';
export const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
    pass: '成功', fail: '失敗', unknown: '未確認', outdated: '以前の結果', human: '人間の判断待ち'
};
export interface VerificationRow {
    label: string; status: VerificationStatus; detail: string; image?: string;
    human?: boolean; runId?: string; capturedAt?: string;
}
export interface VerificationTable {
    rows: VerificationRow[];
    counts: Record<VerificationStatus, number>;
    total: number;
    humanCount: number;
    summary: string;
}

/** A single projection for chrome, generation input and deterministic assertions. */
export function buildVerificationTable(tasks: readonly ExecutionTask[], current: TaskChangeSet | undefined): VerificationTable {
    const rows: VerificationRow[] = [];
    const versionStatus = (hash: string | undefined, status: VerificationStatus): VerificationStatus => {
        if (hash && current?.changeSetHash && !current.error) {
            return hash === current.changeSetHash ? status : 'outdated';
        }
        return status === 'pass' ? 'unknown' : status;
    };
    for (const [taskIndex, task] of tasks.entries()) {
        for (const run of task.hookRuns ?? []) {
            if (run.event === 'taskEnd' && run.status === 'fail'
                && !task.hookEvidence?.some(report => report.hookId === run.id && report.runId === run.runId)) {
                rows.push({ label: '作業後の確認', status: 'unknown', detail: run.error || '確認処理を完了できませんでした。' });
            }
        }
        for (const report of task.hookEvidence ?? []) {
            if (report.incomplete || !report.evidence.length) {
                rows.push({ label: '作業後の確認', status: 'unknown', detail: report.notes || '検証記録がありません。' });
            }
            for (const entry of report.evidence) {
                const status = versionStatus(entry.changeSetHash, entry.status);
                rows.push({ ...entry, status, human: entry.status === 'human', runId: entry.runId ?? report.runId,
                    detail: `${entry.detail}${status === 'outdated' ? '（現在の変更に対応していません）'
                        : status === 'unknown' && entry.status === 'pass' ? '（対象の変更版を確認できません）' : ''}` });
            }
        }
        // Only command/tool completion is execution evidence. Prose and file reads cannot prove a test passed.
        const operations = (task.activities ?? []).filter(activity => activity.kind === 'command' || activity.kind === 'tool');
        const passed = operations.filter(activity => activity.status === 'completed').length;
        const failed = operations.filter(activity => activity.status === 'failed').length;
        const unknown = operations.length - passed - failed;
        const status = operations.length ? versionStatus(task.changeSet?.changeSetHash,
            failed ? 'fail' : unknown ? 'unknown' : 'pass') : 'unknown';
        rows.push({ label: tasks.length > 1 ? `作業 ${taskIndex + 1} の実行` : '作業の実行', status,
            detail: `操作 ${operations.length}件中 ${passed}件完了・${failed}件失敗・${unknown}件未完了。操作の完了は動作確認の合格を意味しません。`
                + (status === 'outdated' ? '現在の変更に対応していません。' : status === 'unknown' && passed ? '対象の変更版を確認できません。' : '') });
    }
    if (!rows.length) { rows.push({ label: '作業の実行', status: 'unknown', detail: '実行記録がありません。' }); }
    const counts = { pass: 0, fail: 0, unknown: 0, outdated: 0, human: 0 };
    for (const row of rows) { counts[row.status]++; }
    const summary = `確認 ${rows.length}件中 ` + (Object.keys(counts) as VerificationStatus[])
        .filter(status => counts[status] > 0).map(status => `${counts[status]}件${VERIFICATION_LABELS[status]}`).join('・');
    return { rows, counts, total: rows.length, humanCount: rows.filter(row => row.human).length, summary };
}

/** Keep the counts intact even when long evidence details exceed the prompt budget. */
export function verificationPrompt(table: VerificationTable): string {
    let remaining = 20_000;
    const rows = [];
    for (const row of table.rows) {
        const record = JSON.stringify(row);
        if (record.length > remaining) { break; }
        rows.push(row); remaining -= record.length;
    }
    return JSON.stringify({ summary: table.summary, counts: table.counts, total: table.total,
        humanCount: table.humanCount, rows, omittedRows: table.rows.length - rows.length });
}
