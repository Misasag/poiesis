export type SkillBundleKind = 'agent' | 'results';

export interface SkillBundleManifest<TKind extends SkillBundleKind = SkillBundleKind> {
    id: string;
    name: string;
    version: string;
    kind: TKind;
    entry: string;
}

export interface SkillBundle<TKind extends SkillBundleKind = SkillBundleKind> {
    readonly manifest: SkillBundleManifest<TKind>;
}

export type AgentSkillBundle = SkillBundle<'agent'>;
export type ResultsSkillBundle = SkillBundle<'results'>;

/** Contract boundary only. A marketplace and installer UI are deliberately out of scope. */
export interface SkillBundleLifecycle {
    install(manifest: SkillBundleManifest): Promise<void>;
    remove(id: string): Promise<void>;
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
}
