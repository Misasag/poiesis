import { LabelProviderContribution } from '@theia/core/lib/browser/label-provider';
import { Resource, ResourceResolver } from '@theia/core/lib/common/resource';
import URI from '@theia/core/lib/common/uri';
import { injectable } from '@theia/core/shared/inversify';

export const TASK_REVIEW_RESOURCE_SCHEME = 'poiesis-task-review';

type TaskReviewSide = 'before' | 'after';

class ReadonlyTaskReviewResource implements Resource {
    readonly readOnly = true;
    readonly autosaveable = false;

    constructor(readonly uri: URI, protected readonly contents: string) { }

    dispose(): void { }

    async readContents(): Promise<string> {
        return this.contents;
    }
}

/** Read-only, application-owned resources used as both sides of a saved Task comparison. */
@injectable()
export class TaskReviewResourceResolver implements ResourceResolver, LabelProviderContribution {
    protected readonly contents = new Map<string, string>();

    register(taskId: string, path: string, side: TaskReviewSide, contents: string): URI {
        const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
        const uri = new URI()
            .withScheme(TASK_REVIEW_RESOURCE_SCHEME)
            .withPath(`/${side}/${normalizedPath}`)
            .withQuery(taskId);
        this.contents.set(uri.toString(), contents);
        return uri;
    }

    resolve(uri: URI): Resource {
        if (uri.scheme !== TASK_REVIEW_RESOURCE_SCHEME || !this.contents.has(uri.toString())) {
            throw new Error('Saved Task content is unavailable.');
        }
        return new ReadonlyTaskReviewResource(uri, this.contents.get(uri.toString())!);
    }

    canHandle(element: object): number {
        return element instanceof URI && element.scheme === TASK_REVIEW_RESOURCE_SCHEME ? 1000 : 0;
    }

    getName(uri: URI): string {
        return `${uri.path.base} (${this.sideLabel(uri)})`;
    }

    getLongName(uri: URI): string {
        const segments = uri.path.toString().split('/').filter(Boolean);
        return `${segments.slice(1).join('/')} (${this.sideLabel(uri)})`;
    }

    protected sideLabel(uri: URI): string {
        return uri.path.toString().split('/').filter(Boolean)[0] === 'before' ? '変更前' : '変更後';
    }
}
