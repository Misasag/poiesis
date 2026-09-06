import { inject, injectable } from '@theia/core/shared/inversify';
import { AiRole, KnownCliId } from '../common/agent-runtime-protocol';
import { CliDetector } from './cli-detector';
import { CliModelDiscoveryService } from './cli-model-discovery';
import { knownCliDefinitions } from './known-cli-registry';

export interface ResolvedCliProvider {
    role: AiRole;
    id: KnownCliId;
    name: string;
    path: string;
    model?: string;
}

/** Resolves the executable CLI at the boundary for each independent AI role. */
@injectable()
export class CliProviderRegistry {
    constructor(
        @inject(CliDetector) protected readonly cliDetector: CliDetector,
        @inject(CliModelDiscoveryService) protected readonly modelDiscovery: CliModelDiscoveryService
    ) { }

    async resolve(role: AiRole, providerId: KnownCliId, model?: string, effort?: string): Promise<ResolvedCliProvider> {
        const definition = knownCliDefinitions().find(candidate => candidate.id === providerId);
        if (!definition?.executableRoles.includes(role)) {
            throw new Error(`${providerId} is not executable for the ${role} role yet.`);
        }
        const report = this.cliDetector.recordedReport ?? await this.cliDetector.detect();
        const detection = report.detections.find(item => item.id === providerId);
        if (detection?.status !== 'found' || !detection.path) {
            throw new Error(`${providerId} CLI is not installed.`);
        }
        const selectedModel = model?.trim();
        if (selectedModel && selectedModel.length > 160) {
            throw new Error('The selected model id is too long.');
        }
        this.modelDiscovery.assertEffortSupported({
            providerId,
            command: detection.path,
            version: detection.version,
            model: selectedModel,
            effort
        });
        return {
            role,
            id: providerId,
            name: detection.name,
            path: detection.path,
            model: selectedModel || undefined
        };
    }
}
