import * as React from '@theia/core/shared/react';

export interface PoiesisImeValueProps<T extends HTMLInputElement | HTMLTextAreaElement> {
    value: string;
    onValueChange: (value: string) => void;
    elementRef?: (element: T | null) => void;
}

export type PoiesisImeInputProps = PoiesisImeValueProps<HTMLInputElement> & Omit<React.InputHTMLAttributes<HTMLInputElement>,
'value' | 'defaultValue' | 'onChange' | 'onInput' | 'onCompositionStart' | 'onCompositionEnd'>;
export type PoiesisImeTextareaProps = PoiesisImeValueProps<HTMLTextAreaElement> & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>,
'value' | 'defaultValue' | 'onChange' | 'onInput' | 'onCompositionStart' | 'onCompositionEnd'>;
/**
 * Keeps the DOM's in-progress IME composition out of React's value reconciliation.
 * Outside composition, `value` remains the canonical application state and external
 * changes are copied back into the DOM without making the control React-controlled.
 */
export const useImeSafeValue = <T extends HTMLInputElement | HTMLTextAreaElement>(
    value: string,
    onValueChange: (value: string) => void,
    elementRef?: (element: T | null) => void
): {
    ref: (element: T | null) => void;
    onInput: (event: React.FormEvent<T>) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (event: React.CompositionEvent<T>) => void;
} => {
    const input = React.useRef<T | null>(null);
    const composing = React.useRef(false);
    const lastReportedValue = React.useRef(value);
    React.useLayoutEffect(() => {
        const element = input.current;
        if (!composing.current && element && element.value !== value) {
            element.value = value;
        }
        if (!composing.current) {
            lastReportedValue.current = value;
        }
    }, [value]);
    const report = (nextValue: string): void => {
        if (nextValue !== lastReportedValue.current) {
            lastReportedValue.current = nextValue;
            onValueChange(nextValue);
        }
    };
    return {
        ref: element => {
            input.current = element;
            elementRef?.(element);
        },
        onInput: event => {
            const nativeEvent = event.nativeEvent as InputEvent;
            if (!composing.current && !nativeEvent.isComposing) {
                report(event.currentTarget.value);
            }
        },
        onCompositionStart: () => {
            composing.current = true;
        },
        onCompositionEnd: event => {
            composing.current = false;
            report(event.currentTarget.value);
        }
    };
};

export const PoiesisTextInput = ({ value, onValueChange, elementRef, ...props }: PoiesisImeInputProps): React.ReactElement => {
    const ime = useImeSafeValue<HTMLInputElement>(value, onValueChange, elementRef);
    return <input {...props} {...ime} defaultValue={value} />;
};

export const PoiesisTextArea = ({ value, onValueChange, elementRef, ...props }: PoiesisImeTextareaProps): React.ReactElement => {
    const ime = useImeSafeValue<HTMLTextAreaElement>(value, onValueChange, elementRef);
    return <textarea {...props} {...ime} defaultValue={value} />;
};

