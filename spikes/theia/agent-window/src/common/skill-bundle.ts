export type SkillBundleKind = 'agent' | 'results';

export interface SkillBundleManifest<TKind extends SkillBundleKind = SkillBundleKind> {
    id: string;
    name: string;
    description?: string;
    version: string;
    kind: TKind;
    entry: string;
}

export interface SkillDocumentFrontmatter<TKind extends SkillBundleKind = SkillBundleKind> {
    name: string;
    description: string;
    kind: TKind;
}

export interface SkillBundle<TKind extends SkillBundleKind = SkillBundleKind> {
    readonly manifest: SkillBundleManifest<TKind>;
}

/** A workspace file bundle whose manifest is derived from its folder and skill.md frontmatter. */
export interface SkillDocumentBundle<TKind extends SkillBundleKind = SkillBundleKind> extends SkillBundle<TKind> {
    readonly source: 'workspace';
    readonly rootUri: string;
    readonly skillDocumentUri: string;
    readonly frontmatter: SkillDocumentFrontmatter<TKind>;
    readonly instructions: string;
    /** App-owned global activation state; it is deliberately not writable from skill.md. */
    readonly enabled: boolean;
}

export interface SkillPromptContribution<TKind extends SkillBundleKind = SkillBundleKind> {
    readonly id: string;
    readonly name: string;
    readonly kind: TKind;
    readonly instructions: string;
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
