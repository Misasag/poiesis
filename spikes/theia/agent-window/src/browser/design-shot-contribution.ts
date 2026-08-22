import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { PreferenceService } from '@theia/core/lib/common/preferences';

@injectable()
export class DesignShotContribution implements FrontendApplicationContribution {
    protected applyingTheme = false;

    @inject(ThemeService)
    protected readonly themeService!: ThemeService;

    @inject(PreferenceService)
    protected readonly preferenceService!: PreferenceService;

    onStart(): void {
        this.themeService.onDidColorThemeChange(event => {
            document.documentElement.dataset.lensDesignTheme = event.newTheme.id;
            if (!this.applyingTheme && event.newTheme.id !== 'dark') {
                queueMicrotask(() => this.applyDarkTheme());
            }
        });
        void this.preferenceService.ready.then(() => {
            queueMicrotask(() => this.applyDarkTheme());
        });
    }

    protected applyDarkTheme(): void {
        this.applyingTheme = true;
        try {
            if (this.themeService.getCurrentTheme().id === 'dark') {
                this.themeService.setCurrentTheme('light', false);
            }
            this.themeService.setCurrentTheme('dark', false);
            document.documentElement.dataset.lensDesignTheme = this.themeService.getCurrentTheme().id;
        } finally {
            this.applyingTheme = false;
        }
    }
}
