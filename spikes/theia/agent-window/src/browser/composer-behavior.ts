export interface ComposerKeyEvent {
    key: string;
    shiftKey: boolean;
    isComposing?: boolean;
    keyCode?: number;
}

/** Shared submit policy for the Agent and Results composers. */
export function shouldSubmitComposer(event: ComposerKeyEvent, value: string): boolean {
    return event.key === 'Enter'
        && !event.shiftKey
        && !event.isComposing
        && event.keyCode !== 229
        && Boolean(value.trim());
}

export function formatTaskElapsedTime(startedAt: string, now = Date.now()): string {
    const parsedStartedAt = Date.parse(startedAt);
    const elapsedSeconds = Number.isFinite(parsedStartedAt)
        ? Math.max(0, Math.floor((now - parsedStartedAt) / 1_000))
        : 0;
    const hours = Math.floor(elapsedSeconds / 3_600);
    const minutes = Math.floor(elapsedSeconds % 3_600 / 60);
    const seconds = elapsedSeconds % 60;
    return `${hours ? `${hours}時間` : ''}${minutes ? `${minutes}分` : ''}${seconds}秒`;
}
