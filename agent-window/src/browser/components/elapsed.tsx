import * as React from '@theia/core/shared/react';
import type { AgentActivity, AgentRunProgress } from '../../common/agent-provider';
import { formatTaskElapsedTime } from '../composer-behavior';

export const PoiesisTaskElapsed = ({
    startedAt,
    progress,
    activity,
    finalizing
}: {
    startedAt: string;
    progress?: AgentRunProgress;
    activity?: AgentActivity;
    finalizing?: boolean;
}): React.ReactElement => {
    const [now, setNow] = React.useState(Date.now());
    React.useEffect(() => {
        setNow(Date.now());
        const interval = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(interval);
    }, [startedAt]);
    const outputAge = progress?.lastOutputAt
        ? Math.max(0, Math.floor((now - Date.parse(progress.lastOutputAt)) / 1_000))
        : undefined;
    const silentFor = outputAge ?? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
    const status = finalizing ? '成果を作成しています'
        : activity ? activityStatus(activity)
            : outputAge !== undefined
                ? `応答を待っています · 最終出力 ${outputAge}秒前`
                : 'Agent を起動しています';
    const quiet = !finalizing && silentFor >= 60 ? '（60秒以上出力がありません）' : '';
    return (
        <span className='poiesis-agent-window__run-status' role='timer' aria-live='off' aria-atomic='true'>
            <span className='poiesis-agent-window__run-pulse' aria-hidden='true' />
            <span>{status}{quiet ? ` ${quiet}` : ''} · {formatTaskElapsedTime(startedAt, now)}</span>
        </span>
    );
};

function activityStatus(activity: AgentActivity): string {
    const title = activity.kind === 'command' ? 'コマンド実行中'
        : activity.kind === 'file-change' ? 'ファイル変更中'
            : activity.kind === 'read' ? '読み取り中'
                : activity.kind === 'reasoning' ? '思考中'
                    : `${activity.title} 実行中`;
    return activity.detail ? `${title}: ${activity.detail}` : title;
}

export const PoiesisResultsElapsed = (): React.ReactElement => {
    const [startedAt] = React.useState(Date.now());
    const [now, setNow] = React.useState(startedAt);
    React.useEffect(() => {
        const interval = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(interval);
    }, []);
    return (
        <span role='timer' aria-live='off' aria-atomic='true'>
            成果を作成しています… · {Math.max(0, Math.floor((now - startedAt) / 1_000))}s
        </span>
    );
};
