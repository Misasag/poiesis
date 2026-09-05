import { AiRole, CliDetectionReport, KnownCliId } from './agent-runtime-protocol';

export type CliDetectionPhase = 'pending' | 'ready' | 'error';
export type CliRoleAvailability = 'pending' | 'available' | 'missing' | 'unsupported' | 'error';

/**
 * Resolves only the current detection attempt. A previous report may still be
 * retained for labels and selections, but never stands in for a pending or
 * failed availability check.
 */
export function cliRoleAvailability(
    phase: CliDetectionPhase,
    report: CliDetectionReport | undefined,
    providerId: KnownCliId,
    role: AiRole
): CliRoleAvailability {
    if (phase === 'pending') {
        return 'pending';
    }
    if (phase === 'error') {
        return 'error';
    }
    const detection = report?.detections.find(candidate => candidate.id === providerId);
    if (!detection || detection.status === 'missing') {
        return 'missing';
    }
    return detection.executableRoles.includes(role) ? 'available' : 'unsupported';
}

export function cliRoleAvailabilityLabel(availability: CliRoleAvailability, detailed = false): string {
    switch (availability) {
        case 'pending': return '検出中…';
        case 'available': return detailed ? '検出済み（実行可）' : '実行可';
        case 'missing': return '未検出';
        case 'unsupported': return detailed ? '検出済み（実行対応は今後）' : '実行対応は今後';
        case 'error': return '検出に失敗';
    }
}
