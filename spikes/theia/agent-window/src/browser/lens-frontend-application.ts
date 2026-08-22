import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplication } from '@theia/core/lib/browser';

/**
 * Lens owns the document chrome and mounts the few Theia widgets it needs in
 * dedicated slots. The workbench shell remains an off-document widget host.
 */
@injectable()
export class LensFrontendApplication extends FrontendApplication {
    protected override attachShell(_host: HTMLElement): void {
        // Intentionally empty: ApplicationShell must never enter the document.
    }
}
