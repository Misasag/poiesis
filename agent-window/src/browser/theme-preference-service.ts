import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { Disposable, Emitter, Event } from '@theia/core/lib/common';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { inject, injectable } from '@theia/core/shared/inversify';
import { GlobalStorageService } from './global-storage-service';

export type PoiesisThemePreference = 'light' | 'dark' | 'system';
export type PoiesisColorMode = 'light' | 'dark';

interface PersistedThemePreference {
    version: 1;
    preference: PoiesisThemePreference;
}

const THEME_STORAGE_KEY = 'poiesis.theme-preference.v1';

@injectable()
export class ThemePreferenceService implements FrontendApplicationContribution {
    protected currentPreference: PoiesisThemePreference = 'dark';
    protected mediaQuery?: MediaQueryList;
    protected initialized = false;
    protected disposed = false;
    protected mutationRevision = 0;
    protected readonly changeEmitter = new Emitter<PoiesisThemePreference>();
    protected readonly disposables: Disposable[] = [];

    readonly onDidChange: Event<PoiesisThemePreference> = this.changeEmitter.event;

    constructor(
        @inject(ThemeService) protected readonly themeService: ThemeService,
        @inject(PreferenceService) protected readonly preferenceService: PreferenceService,
        @inject(GlobalStorageService) protected readonly storageService: GlobalStorageService,
        @inject(FrontendApplicationStateService) protected readonly applicationState: FrontendApplicationStateService
    ) { }

    get preference(): PoiesisThemePreference {
        return this.currentPreference;
    }

    get effectiveMode(): PoiesisColorMode {
        return this.currentPreference === 'system'
            ? this.mediaQuery?.matches ? 'dark' : 'light'
            : this.currentPreference;
    }

    onStart(): void {
        // PreferenceService finishes initialization as part of the same frontend
        // startup. Do not make application attachment wait on that dependency.
        void this.restoreTheme();
    }

    onStop(): void {
        this.dispose();
    }

    async restoreTheme(): Promise<void> {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const onSystemThemeChange = (): void => {
            if (this.currentPreference === 'system') {
                this.applyEffectiveTheme();
            }
        };
        this.mediaQuery.addEventListener('change', onSystemThemeChange);
        this.disposables.push(Disposable.create(() => this.mediaQuery?.removeEventListener('change', onSystemThemeChange)));
        this.disposables.push(this.themeService.onDidColorThemeChange(event => {
            document.documentElement.dataset.poiesisDesignTheme = event.newTheme.id;
        }));

        // Poiesis historically opened dark. Apply that stable fallback while the profile is read.
        this.applyEffectiveTheme();
        const restoreRevision = this.mutationRevision;
        try {
            const [, , stored] = await Promise.all([
                this.themeService.initialized,
                this.preferenceService.ready,
                this.storageService.getData<unknown>(THEME_STORAGE_KEY),
                this.applicationState.reachedState('ready')
            ]);
            if (this.disposed) {
                return;
            }
            if (restoreRevision !== this.mutationRevision) {
                this.applyEffectiveTheme();
                return;
            }
            this.currentPreference = this.restorePreference(stored);
            this.applyEffectiveTheme();
            this.changeEmitter.fire(this.currentPreference);
        } catch (error) {
            console.warn('[Poiesis] Could not restore the display theme.', error);
            if (!this.disposed && restoreRevision === this.mutationRevision) {
                this.currentPreference = 'dark';
                this.applyEffectiveTheme();
            }
        }
    }

    setPreference(preference: PoiesisThemePreference): void {
        if (this.disposed || !this.isPreference(preference)) {
            return;
        }
        this.mutationRevision += 1;
        const changed = this.currentPreference !== preference;
        this.currentPreference = preference;
        this.applyEffectiveTheme();
        if (changed) {
            this.changeEmitter.fire(preference);
        }
        void this.storageService.setData<PersistedThemePreference>(THEME_STORAGE_KEY, {
            version: 1,
            preference
        }).catch(error => console.warn('[Poiesis] Could not save the display theme.', error));
    }

    dispose(): void {
        this.disposed = true;
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
        this.changeEmitter.dispose();
    }

    protected restorePreference(value: unknown): PoiesisThemePreference {
        if (!value || typeof value !== 'object') {
            return 'dark';
        }
        const stored = value as Partial<PersistedThemePreference>;
        return stored.version === 1 && this.isPreference(stored.preference) ? stored.preference : 'dark';
    }

    protected isPreference(value: unknown): value is PoiesisThemePreference {
        return value === 'light' || value === 'dark' || value === 'system';
    }

    protected applyEffectiveTheme(): void {
        const mode = this.effectiveMode;
        const root = document.documentElement;
        root.dataset.poiesisThemePreference = this.currentPreference;
        root.dataset.poiesisColorMode = mode;
        root.style.colorScheme = mode;
        if (this.themeService.getCurrentTheme().id !== mode) {
            // This is an application display choice, not a permanent override of Code's
            // advanced workbench.colorTheme setting. Apply again only on a user or OS change.
            this.themeService.setCurrentTheme(mode, false);
        }
        root.dataset.poiesisDesignTheme = this.themeService.getCurrentTheme().id;
    }
}
