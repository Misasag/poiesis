import { inject, injectable } from '@theia/core/shared/inversify';
import { AgentRuntimeServer, FolderBrowserResult } from '../common/agent-runtime-protocol';

@injectable()
export class FolderExplorerService {
    constructor(@inject(AgentRuntimeServer) protected readonly server: AgentRuntimeServer) { }

    browse(path?: string): Promise<FolderBrowserResult> {
        return this.server.browseFolders({ path });
    }

    create(parentPath: string, name: string): Promise<string> {
        return this.server.createFolder({ parentPath, name });
    }
}
