import type { AgentActivity, AgentRunProgress } from '../common/agent-provider';

export function agentLiveStatus(startedAt: string, progress: AgentRunProgress | undefined,
    activity: AgentActivity | undefined, finalizing: boolean | undefined, now: number): string {
    if (finalizing) { return '成果をまとめています'; }
    if (progress?.phase === 'preparing') { return '変更前のファイルを記録しています'; }
    const outputAt = progress?.lastOutputAt ?? activity?.endedAt ?? activity?.startedAt;
    const silentMs = Math.max(0, now - Date.parse(outputAt ?? startedAt));
    if (silentMs >= 10_000) {
        return `応答を待っています · 最終出力 ${Math.floor(silentMs / 1_000)}秒前`;
    }
    if (!activity) { return outputAt ? '応答を受け取っています' : 'Agent を起動しています'; }
    const detail = (activity.detail ?? '').replace(/\s+/g, ' ').trim();
    const short = detail.length > 100 ? `${detail.slice(0, 99)}…` : detail;
    switch (activity.kind) {
        case 'command': return `コマンドを実行しています${short ? `: ${short}` : ''}`;
        case 'file-change': {
            const path = short.split(' · ')[0];
            return path ? `${path} を編集しています` : 'ファイルを編集しています';
        }
        case 'read': return `ファイルを読んでいます${short ? `: ${short}` : ''}`;
        case 'reasoning': return '考えています';
        case 'message': return '応答を受け取っています';
        default: return '作業を進めています';
    }
}
