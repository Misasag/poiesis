import URI from '@theia/core/lib/common/uri';
import { ScmService } from '@theia/scm/lib/browser/scm-service';

export function liveWorkspaceBranch(
    scmService: Pick<ScmService, 'findRepository'>,
    workspaceUri: string | undefined
): string | undefined {
    if (!workspaceUri) {
        return undefined;
    }
    const provider = scmService.findRepository(new URI(workspaceUri))?.provider;
    if (provider?.id.toLowerCase() !== 'git') {
        return undefined;
    }
    const ref = provider.historyProvider?.currentHistoryItemRef;
    if (!ref) {
        return undefined;
    }
    const name = ref.name.trim();
    if (ref.id.startsWith('refs/heads/')) {
        return name || ref.id.slice('refs/heads/'.length).trim() || undefined;
    }
    const revision = ref.revision?.trim() || ref.id.trim();
    const detachedRevision = revision && /^[0-9a-f]{7,64}$/i.test(revision)
        ? revision.slice(0, 7)
        : undefined;
    const detachedName = name && name.toLowerCase() !== 'head' ? name : undefined;
    return `detached HEAD${detachedRevision ? ` ${detachedRevision}` : detachedName ? ` ${detachedName}` : ''}`;
}
