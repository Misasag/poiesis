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
    operationSummary?: string;
    counts: Record<VerificationStatus, number>;
    total: number;
    humanCount: number;
    summary: string;
}

/** A single projection for chrome, generation input and deterministic assertions. */
export function buildVerificationTable(tasks: readonly ExecutionTask[], current: TaskChangeSet | undefined): VerificationTable {
    const rows: VerificationRow[] = [];
    let evidenceCount = 0;
    let operationCount = 0;
    let failedOperations = 0;
    let unfinishedOperations = 0;
    const versionStatus = (hash: string | undefined, status: VerificationStatus): VerificationStatus => {
        if (hash && current?.changeSetHash && !current.error) {
            return hash === current.changeSetHash ? status : 'outdated';
        }
        return status === 'pass' ? 'unknown' : status;
    };
    for (const [taskIndex, task] of tasks.entries()) {
        if (task.status === 'failed' || task.status === 'cancelled') {
            rows.push({ label: `作業 ${taskIndex + 1} が完了していません`, status: 'fail',
                detail: task.failure?.summary || (task.status === 'cancelled' ? '作業がキャンセルされました。' : '作業に失敗しました。') });
        }
        for (const run of task.hookRuns ?? []) {
            if (run.event === 'taskEnd' && run.status === 'fail') {
                rows.push({ label: '作業後の確認', status: 'unknown', detail: run.error || '確認処理を完了できませんでした。' });
            }
        }
        for (const report of task.hookEvidence ?? []) {
            if (report.incomplete && !task.hookRuns?.some(run => run.event === 'taskEnd' && run.status === 'fail'
                && report.hookId === run.id && report.runId === run.runId)) {
                rows.push({ label: '作業後の確認', status: 'unknown', detail: report.notes || '確認処理を完了できませんでした。' });
            }
            for (const entry of report.evidence) {
                evidenceCount++;
                const status = versionStatus(entry.changeSetHash, entry.status);
                rows.push({ ...entry, status, human: entry.status === 'human', runId: entry.runId ?? report.runId,
                    detail: `${entry.detail}${status === 'outdated' ? '（現在の変更に対応していません）'
                        : status === 'unknown' && entry.status === 'pass' ? '（対象の変更版を確認できません）' : ''}` });
            }
        }
        // Operations describe work, not verification outcomes.
        const operations = (task.activities ?? []).filter(activity => activity.kind === 'command' || activity.kind === 'tool');
        operationCount += operations.length;
        failedOperations += operations.filter(activity => activity.status === 'failed').length;
        unfinishedOperations += operations.filter(activity => activity.status === 'running').length;
    }
    if (!evidenceCount) {
        rows.push({ label: '作業後の確認', status: 'unknown', detail: `確認の記録がありません（${tasks.length}件の作業）` });
    }
    const operationNotes = [failedOperations ? `失敗 ${failedOperations}件` : '',
        unfinishedOperations ? `未完了 ${unfinishedOperations}件` : ''].filter(Boolean);
    const operationSummary = tasks.length
        ? `作業の記録: ${tasks.length}件の作業で操作 ${operationCount}件${operationNotes.length ? `（うち${operationNotes.join('・')}）` : ''}`
        : undefined;
    const counts = { pass: 0, fail: 0, unknown: 0, outdated: 0, human: 0 };
    for (const row of rows) { counts[row.status]++; }
    const summary = `確認 ${rows.length}件中 ` + (Object.keys(counts) as VerificationStatus[])
        .filter(status => counts[status] > 0).map(status => `${counts[status]}件${VERIFICATION_LABELS[status]}`).join('・');
    return { rows, operationSummary, counts, total: rows.length, humanCount: rows.filter(row => row.human).length, summary };
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
        humanCount: table.humanCount, rows, omittedRows: table.rows.length - rows.length,
        operationSummary: table.operationSummary });
}
