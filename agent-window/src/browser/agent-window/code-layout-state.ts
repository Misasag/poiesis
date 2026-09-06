export const CODE_LAYOUT_STORAGE_KEY = 'poiesis.code-layout.v1';

export const DEFAULT_CODE_SIDEBAR_WIDTH = 260;
export const MIN_CODE_SIDEBAR_WIDTH = 180;
export const MAX_CODE_SIDEBAR_WIDTH = 520;

export type CodeSidebarTab = 'files' | 'search' | 'git' | 'extensions';

export interface CodeLayoutState {
    version: 1;
    sidebarWidth: number;
    sidebarCollapsed: boolean;
    sidebarTab: CodeSidebarTab;
    graphExpanded: boolean;
}

export interface CodeSidebarVisibilityState {
    wideCollapsed: boolean;
    narrowViewport: boolean;
    narrowOpen: boolean;
}

export interface CodeSidebarVisibilityTransition {
    state: CodeSidebarVisibilityState;
    persistWidePreference: boolean;
}

export const DEFAULT_CODE_LAYOUT_STATE: CodeLayoutState = {
    version: 1,
    sidebarWidth: DEFAULT_CODE_SIDEBAR_WIDTH,
    sidebarCollapsed: false,
    sidebarTab: 'files',
    graphExpanded: false
};

export function normalizeCodeLayoutState(value: unknown): CodeLayoutState {
    if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
        return { ...DEFAULT_CODE_LAYOUT_STATE };
    }
    const state = value as Partial<CodeLayoutState>;
    const sidebarWidth = typeof state.sidebarWidth === 'number' && Number.isFinite(state.sidebarWidth)
        ? Math.max(MIN_CODE_SIDEBAR_WIDTH, Math.min(MAX_CODE_SIDEBAR_WIDTH, Math.round(state.sidebarWidth)))
        : DEFAULT_CODE_SIDEBAR_WIDTH;
    const sidebarTab = state.sidebarTab === 'files'
        || state.sidebarTab === 'search'
        || state.sidebarTab === 'git'
        || state.sidebarTab === 'extensions'
        ? state.sidebarTab
        : 'files';
    return {
        version: 1,
        sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed === true,
        sidebarTab,
        graphExpanded: state.graphExpanded === true
    };
}

export function isCodeSidebarVisible(state: CodeSidebarVisibilityState): boolean {
    return state.narrowViewport ? state.narrowOpen : !state.wideCollapsed;
}

export function setCodeSidebarViewport(
    state: CodeSidebarVisibilityState,
    narrowViewport: boolean
): CodeSidebarVisibilityState {
    return {
        ...state,
        narrowViewport,
        narrowOpen: narrowViewport ? false : state.narrowOpen
    };
}

export function setCodeSidebarVisibility(
    state: CodeSidebarVisibilityState,
    visible: boolean
): CodeSidebarVisibilityTransition {
    if (state.narrowViewport) {
        return {
            state: { ...state, narrowOpen: visible },
            persistWidePreference: false
        };
    }
    return {
        state: { ...state, wideCollapsed: !visible },
        persistWidePreference: true
    };
}

export function codeSidebarContainsFocus(
    sidebar: Pick<HTMLElement, 'contains'> | undefined,
    focusTarget: Node | undefined
): boolean {
    return !!focusTarget && sidebar?.contains(focusTarget) === true;
}

export function shouldFocusCodeActivity(
    collapsed: boolean,
    explicitActivityFocus: boolean,
    focusWasInSidebar: boolean
): boolean {
    return explicitActivityFocus || collapsed && focusWasInSidebar;
}
