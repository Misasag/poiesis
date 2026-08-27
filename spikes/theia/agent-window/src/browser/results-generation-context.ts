import { injectable } from '@theia/core/shared/inversify';
import { KnownCliId } from '../common/agent-runtime-protocol';

/** Runtime selection only; orchestration remains a Results Skill concern. */
@injectable()
export class ResultsGenerationContext {
    providerId: KnownCliId = 'codex';
}
