import { injectable } from '@theia/core/shared/inversify';
import { WorkspaceTrustService } from '@theia/workspace/lib/browser/workspace-trust-service';

/** Opening a folder through Poiesis is the user's trust decision. */
@injectable()
export class PoiesisWorkspaceTrustService extends WorkspaceTrustService {
    protected override calculateWorkspaceTrust(): Promise<boolean | undefined> {
        return Promise.resolve(true);
    }

    override requestWorkspaceTrust(): Promise<boolean | undefined> {
        return Promise.resolve(true);
    }
}
