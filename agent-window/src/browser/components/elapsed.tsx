import * as React from '@theia/core/shared/react';
import type { AgentActivity, AgentRunProgress } from '../../common/agent-provider';
import { formatTaskElapsedTime } from '../composer-behavior';
import type { ResultsGenerationProgress } from '../../common/results-generation-protocol';
import { cliModelLabel } from '../cli-usage-display';

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
    const preparing = progress?.phase === 'preparing';
    const status = finalizing ? '成果をまとめています'
        : preparing ? '変更前のファイルを記録しています'
        : activity ? activityStatus(activity)
            : outputAge !== undefined
                ? `応答を待っています · 最終出力 ${outputAge}秒前`
                : 'Agent を起動しています';
    const quiet = !finalizing && !preparing && silentFor >= 60 ? '（60秒以上出力がありません）' : '';
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

export const PoiesisResultsElapsed = ({ progress, generationStartedAt }: {
    progress?: ResultsGenerationProgress; generationStartedAt?: string;
}): React.ReactElement => {
    const [now, setNow] = React.useState(Date.now());
    React.useEffect(() => {
        const interval = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(interval);
    }, []);
    const status = progress?.phase === 'regeneration'
        ? `条件を満たさなかった ${progress.failedAssertions ?? 0} 件を直して作り直しています（${progress.attempt}回目）`
        : progress?.phase === 'judge' ? '成果文書の条件を確認しています'
            : progress ? '成果文書を作成しています' : '成果文書の作成を準備しています';
    const model = progress ? cliModelLabel(progress.model, progress.providerId) : '';
    const clock = (startedAt: string): string => {
        const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    };
    return (
        <span role='timer' aria-live='off' aria-atomic='true'>
            <span>{status}{model ? ` · ${model}` : ''}{progress ? ` · ${clock(progress.startedAt)}` : ''}</span>
            {generationStartedAt && <span className='poiesis-cli-usage poiesis-results__total-elapsed'>
                全体 {formatTaskElapsedTime(generationStartedAt, now)}
            </span>}
        </span>
    );
};
