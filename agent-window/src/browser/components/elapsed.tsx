import * as React from '@theia/core/shared/react';
import { formatTaskElapsedTime } from '../composer-behavior';

export const PoiesisTaskElapsed = ({ startedAt }: { startedAt: string }): React.ReactElement => {
    const [now, setNow] = React.useState(Date.now());
    React.useEffect(() => {
        setNow(Date.now());
        const interval = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(interval);
    }, [startedAt]);
    return (
        <span role='timer' aria-live='off' aria-atomic='true'>
            作業中 · {formatTaskElapsedTime(startedAt, now)}
        </span>
    );
};

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

