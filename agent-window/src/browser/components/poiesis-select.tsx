import * as React from '@theia/core/shared/react';
import * as ReactDOM from '@theia/core/shared/react-dom';

export interface PoiesisSelectOption {
    value: string;
    label: string;
    triggerLabel?: string;
    group?: string;
    disabled?: boolean;
    keepOpen?: boolean;
}

export interface PoiesisSelectProps {
    value: string;
    options: PoiesisSelectOption[];
    ariaLabel: string;
    onChange: (value: string) => void;
    className?: string;
    disabled?: boolean;
    popoverClassName?: string;
    popoverFooter?: React.ReactNode;
    popoverMinWidth?: number;
    leadingIconClass?: string;
}

interface PoiesisSelectPosition {
    left: number;
    width: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
}

/** A select-only ARIA combobox whose listbox is portaled so modal and panel overflow cannot clip it. */
export const PoiesisSelect = ({
    value,
    options,
    ariaLabel,
    onChange,
    className = '',
    disabled = false,
    popoverClassName = '',
    popoverFooter,
    popoverMinWidth = 180,
    leadingIconClass
}: PoiesisSelectProps): React.ReactElement => {
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const popoverRef = React.useRef<HTMLDivElement>(null);
    const listboxId = `poiesis-select-${React.useId().replace(/:/g, '')}`;
    const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
    const [open, setOpen] = React.useState(false);
    const [activeIndex, setActiveIndex] = React.useState(selectedIndex);
    const [position, setPosition] = React.useState<PoiesisSelectPosition>();
    const selectedOption = options[selectedIndex];

    const enabledIndex = React.useCallback((start: number, direction: 1 | -1): number => {
        if (!options.length) {
            return -1;
        }
        let index = start;
        for (let count = 0; count < options.length; count++) {
            index = (index + direction + options.length) % options.length;
            if (!options[index].disabled) {
                return index;
            }
        }
        return -1;
    }, [options]);

    const updatePosition = React.useCallback((): void => {
        const trigger = triggerRef.current;
        if (!trigger) {
            return;
        }
        const rect = trigger.getBoundingClientRect();
        const margin = 8;
        const gap = 4;
        const width = Math.min(Math.max(rect.width, popoverMinWidth), window.innerWidth - margin * 2);
        const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
        const availableBelow = window.innerHeight - rect.bottom - gap - margin;
        const availableAbove = rect.top - gap - margin;
        const flipAbove = availableBelow < 160 && availableAbove > availableBelow;
        const maxHeight = Math.max(72, Math.min(280, flipAbove ? availableAbove : availableBelow));
        const nextPosition: PoiesisSelectPosition = flipAbove
            ? { left, width, maxHeight, bottom: Math.max(margin, window.innerHeight - rect.top + gap) }
            : { left, width, maxHeight, top: rect.bottom + gap };
        setPosition(current => current
            && Math.abs(current.left - nextPosition.left) < 0.5
            && Math.abs(current.width - nextPosition.width) < 0.5
            && Math.abs(current.maxHeight - nextPosition.maxHeight) < 0.5
            && Math.abs((current.top ?? -1) - (nextPosition.top ?? -1)) < 0.5
            && Math.abs((current.bottom ?? -1) - (nextPosition.bottom ?? -1)) < 0.5
            ? current
            : nextPosition);
    }, [popoverMinWidth]);

    const close = React.useCallback((restoreFocus = true): void => {
        setOpen(false);
        if (restoreFocus) {
            requestAnimationFrame(() => triggerRef.current?.focus());
        }
    }, []);

    const openList = React.useCallback((direction?: 1 | -1): void => {
        if (disabled || !options.length) {
            return;
        }
        const initial = options[selectedIndex]?.disabled
            ? enabledIndex(selectedIndex, direction ?? 1)
            : selectedIndex;
        setActiveIndex(initial);
        updatePosition();
        setOpen(true);
    }, [disabled, enabledIndex, options, selectedIndex, updatePosition]);

    React.useEffect(() => {
        if (!open) {
            return undefined;
        }
        const reposition = (): void => updatePosition();
        let trackingFrame = requestAnimationFrame(function trackAnchor(): void {
            updatePosition();
            trackingFrame = requestAnimationFrame(trackAnchor);
        });
        const closeOutside = (event: PointerEvent): void => {
            const target = event.target as Node | null;
            if (target && !triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
                close();
            }
        };
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        document.addEventListener('pointerdown', closeOutside, true);
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
            }
        };
        document.addEventListener('keydown', closeOnEscape, true);
        return () => {
            window.removeEventListener('resize', reposition);
            window.removeEventListener('scroll', reposition, true);
            document.removeEventListener('pointerdown', closeOutside, true);
            document.removeEventListener('keydown', closeOnEscape, true);
            cancelAnimationFrame(trackingFrame);
        };
    }, [close, open, updatePosition]);

    React.useEffect(() => {
        if (open) {
            setActiveIndex(selectedIndex);
        }
    }, [open, selectedIndex]);

    const choose = (index: number): void => {
        const option = options[index];
        if (!option || option.disabled) {
            return;
        }
        if (option.value !== value) {
            onChange(option.value);
        }
        if (!option.keepOpen) {
            close();
        }
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
        if (!open) {
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                openList(event.key === 'ArrowUp' ? -1 : 1);
            }
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next = enabledIndex(activeIndex, event.key === 'ArrowDown' ? 1 : -1);
            if (next >= 0) {
                setActiveIndex(next);
            }
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            choose(activeIndex);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        } else if (event.key === 'Tab' && !popoverFooter) {
            close(false);
        }
    };

    const rootClass = `poiesis-select${className ? ` ${className}` : ''}`;
    return (
        <div className={rootClass} data-value={value} data-option-count={options.length}>
            <button
                ref={triggerRef}
                type='button'
                className='poiesis-select__trigger'
                data-value={value}
                role='combobox'
                aria-label={ariaLabel}
                aria-haspopup='listbox'
                aria-controls={listboxId}
                aria-expanded={open}
                aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
                disabled={disabled}
                onClick={() => open ? close(false) : openList()}
                onKeyDown={handleKeyDown}
            >
                {leadingIconClass && <span className={`codicon ${leadingIconClass}`} aria-hidden='true' />}
                <span className='poiesis-select__trigger-label'>{selectedOption?.triggerLabel ?? selectedOption?.label ?? value}</span>
                <span className={`codicon codicon-chevron-${open ? 'up' : 'down'}`} aria-hidden='true' />
            </button>
            {open && position && ReactDOM.createPortal(
                <div
                    ref={popoverRef}
                    id={listboxId}
                    className={`poiesis-select__listbox${popoverClassName ? ` ${popoverClassName}` : ''}`}
                    role='listbox'
                    aria-label={ariaLabel}
                    style={position}
                >
                    {options.map((option, index) => (
                        <React.Fragment key={option.value}>
                            {option.group && option.group !== options[index - 1]?.group && (
                                <div className='poiesis-select__group' role='presentation'>{option.group}</div>
                            )}
                            <div
                                id={`${listboxId}-option-${index}`}
                                className={`poiesis-select__option${index === activeIndex ? ' active' : ''}${option.disabled ? ' disabled' : ''}`}
                                data-value={option.value}
                                role='option'
                                aria-selected={option.value === value}
                                aria-disabled={option.disabled || undefined}
                                onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => choose(index)}
                            >
                                <span>{option.label}</span>
                                {option.value === value && <span className='codicon codicon-check' aria-hidden='true' />}
                            </div>
                        </React.Fragment>
                    ))}
                    {popoverFooter && <div className='poiesis-select__footer' role='presentation'>{popoverFooter}</div>}
                </div>,
                document.body
            )}
        </div>
    );
};

