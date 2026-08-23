import { StorageService } from '@theia/core/lib/browser';
import { Emitter, Event } from '@theia/core/lib/common';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';

const CUSTOMIZATION_STORAGE_KEY = 'lens.customization.v1';

export type LensSkillId = 'results';

interface PersistedCustomizationState {
    version: 1;
    disabledSkills: LensSkillId[];
}

@injectable()
export class CustomizationService {
    protected readonly disabledSkills = new Set<LensSkillId>();
    protected readonly onDidChangeEmitter = new Emitter<void>();
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    constructor(@inject(StorageService) protected readonly storageService: StorageService) { }

    @postConstruct()
    protected init(): void {
        void this.restore();
    }

    protected async restore(): Promise<void> {
        const state = await this.storageService.getData<Partial<PersistedCustomizationState>>(CUSTOMIZATION_STORAGE_KEY);
        if (state?.version === 1 && Array.isArray(state.disabledSkills)) {
            for (const skill of state.disabledSkills) {
                if (skill === 'results') {
                    this.disabledSkills.add(skill);
                }
            }
        }
        this.onDidChangeEmitter.fire();
    }

    isSkillEnabled(skill: LensSkillId): boolean {
        return !this.disabledSkills.has(skill);
    }

    setSkillEnabled(skill: LensSkillId, enabled: boolean): void {
        if (enabled) {
            this.disabledSkills.delete(skill);
        } else {
            this.disabledSkills.add(skill);
        }
        void this.storageService.setData<PersistedCustomizationState>(CUSTOMIZATION_STORAGE_KEY, {
            version: 1,
            disabledSkills: [...this.disabledSkills]
        });
        this.onDidChangeEmitter.fire();
    }
}
