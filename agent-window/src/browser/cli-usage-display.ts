import { CLI_DISPLAY_NAMES, KnownCliId } from '../common/agent-runtime-protocol';
import type { CliUsage } from '../common/cli-usage';
import { formatTaskElapsedTime } from './composer-behavior';

export const CLI_COST_TOOLTIP = 'CLI が報告した定価ベースの推定額です。サブスクリプション利用時の実際の請求額とは異なります。';

export function formatCliTokens(value: number): string {
    const scale = value >= 1_000_000 ? 1_000_000 : value >= 1_000 ? 1_000 : 1;
    const number = Number((value / scale).toFixed(scale === 1 ? 0 : 1));
    return `${number}${scale === 1_000_000 ? 'M' : scale === 1_000 ? 'k' : ''}`;
}

export function formatCliDuration(durationMs: number): string {
    return formatTaskElapsedTime(new Date(0).toISOString(), durationMs);
}

export function cliModelLabel(model: string | undefined, providerId?: KnownCliId): string {
    if (model) {
        return model.replace(/^gpt-/, 'GPT-').replace(/-(astra|sol|luna|terra|mini|codex|spark)\b/g,
            (_match, name: string) => `-${name[0].toUpperCase()}${name.slice(1)}`);
    }
    return providerId ? `${CLI_DISPLAY_NAMES[providerId]}（モデルはCLI設定）` : '';
}

export function cliUsageText(usage: CliUsage | undefined): string {
    if (!usage) { return ''; }
    const parts: string[] = [];
    if (usage.inputTokens !== undefined) {
        const cache = usage.cachedInputTokens !== undefined && usage.inputTokens > 0
            && usage.cachedInputTokens <= usage.inputTokens
            ? `（キャッシュ ${Math.round(usage.cachedInputTokens / usage.inputTokens * 100)}%）` : '';
        parts.push(`入力 ${formatCliTokens(usage.inputTokens)} トークン${cache}`);
    }
    if (usage.outputTokens !== undefined) { parts.push(`出力 ${formatCliTokens(usage.outputTokens)}`); }
    return parts.join(' · ');
}
