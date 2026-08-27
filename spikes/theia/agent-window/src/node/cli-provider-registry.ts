import { inject, injectable } from '@theia/core/shared/inversify';
import { AiRole, KnownCliId } from '../common/agent-runtime-protocol';
import { CliDetector } from './cli-detector';

export interface ResolvedCliProvider {
    role: AiRole;
    id: KnownCliId;
    name: string;
    path: string;
}

/** Resolves the executable CLI at the boundary for each independent AI role. */
@injectable()
export class CliProviderRegistry {
    protected readonly executableProviders: Record<AiRole, readonly KnownCliId[]> = {
        agent: ['codex'],
        results: ['codex']
    };

    constructor(@inject(CliDetector) protected readonly cliDetector: CliDetector) { }

    async resolve(role: AiRole, providerId: KnownCliId): Promise<ResolvedCliProvider> {
        if (!this.executableProviders[role].includes(providerId)) {
            throw new Error(`${providerId} is not executable for the ${role} role yet.`);
        }
        const report = this.cliDetector.recordedReport ?? await this.cliDetector.detect();
        const detection = report.detections.find(item => item.id === providerId);
        if (detection?.status !== 'found' || !detection.path) {
            throw new Error(`${providerId} CLI is not installed.`);
        }
        return {
            role,
            id: providerId,
            name: detection.name,
            path: detection.path
        };
    }
}
