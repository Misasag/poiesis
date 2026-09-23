import * as React from '@theia/core/shared/react';
import type { CliUsage } from '../../common/cli-usage';
import { CLI_COST_TOOLTIP, cliUsageText, formatCliDuration } from '../cli-usage-display';

export function CliUsageLine({ usage, durationMs, partial }: {
    usage?: CliUsage; durationMs?: number; partial?: boolean;
}): React.ReactElement | null {
    const text = [durationMs === undefined ? '' : formatCliDuration(durationMs), cliUsageText(usage)].filter(Boolean).join(' · ');
    const cost = usage?.costUsd;
    if (!text && cost === undefined) { return null; }
    return <div className='poiesis-cli-usage'>
        {partial && <span>記録分 · </span>}{text}
        {cost !== undefined && <span title={CLI_COST_TOOLTIP}>{text ? ' · ' : ''}推定 ${cost.toFixed(cost < 0.01 ? 4 : 2)}</span>}
    </div>;
}
