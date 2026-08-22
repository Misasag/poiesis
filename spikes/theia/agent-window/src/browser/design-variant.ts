export type DesignVariant =
    | 'd1-a' | 'd1-b'
    | 'd2-a' | 'd2-b'
    | 'd3-a' | 'd3-b'
    | 'd4-a' | 'd4-b'
    | 'd5-a' | 'd5-b'
    | 'd6-a' | 'd6-b'
    | 'd7-a' | 'd7-b'
    | 'semantic-card-closeup';

const DESIGN_VARIANTS = new Set<DesignVariant>([
    'd1-a', 'd1-b',
    'd2-a', 'd2-b',
    'd3-a', 'd3-b',
    'd4-a', 'd4-b',
    'd5-a', 'd5-b',
    'd6-a', 'd6-b',
    'd7-a', 'd7-b',
    'semantic-card-closeup'
]);

export function getDesignVariant(): DesignVariant | undefined {
    const value = new URLSearchParams(window.location.search).get('variant');
    if (value && DESIGN_VARIANTS.has(value as DesignVariant)) {
        document.documentElement.dataset.lensDesignVariant = value;
        return value as DesignVariant;
    }
    return undefined;
}

export function isDesignVariant(...variants: DesignVariant[]): boolean {
    const current = getDesignVariant();
    return current !== undefined && variants.includes(current);
}
