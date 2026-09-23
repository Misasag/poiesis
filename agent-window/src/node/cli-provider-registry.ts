import { inject, injectable } from '@theia/core/shared/inversify';
import { AiRole, CLI_DISPLAY_NAMES, KnownCliId } from '../common/agent-runtime-protocol';
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
            throw new Error(`${CLI_DISPLAY_NAMES[providerId]} は${role === 'agent' ? '作業の実行' : '成果の作成'}に対応していません。`);
        }
        const report = this.cliDetector.recordedReport ?? await this.cliDetector.detect();
        const detection = report.detections.find(item => item.id === providerId);
        if (detection?.status !== 'found' || !detection.path) {
            throw new Error(`${CLI_DISPLAY_NAMES[providerId]} が見つかりません。インストール状況を確認してください。`);
        }
        const selectedModel = model?.trim();
        if (selectedModel && selectedModel.length > 160) {
            throw new Error('選択したモデル名が長すぎます。');
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
