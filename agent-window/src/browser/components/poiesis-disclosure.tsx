import * as React from '@theia/core/shared/react';

export interface PoiesisDisclosureSummaryProps {
    children: React.ReactNode;
    className?: string;
}

export function PoiesisDisclosureSummary({ children, className }: PoiesisDisclosureSummaryProps): React.ReactElement {
    return (
        <summary className={`poiesis-disclosure__summary${className ? ` ${className}` : ''}`}>
            <span className='codicon codicon-chevron-right poiesis-disclosure__chevron' aria-hidden='true' />
            <span className='poiesis-disclosure__summary-content'>{children}</span>
        </summary>
    );
}
