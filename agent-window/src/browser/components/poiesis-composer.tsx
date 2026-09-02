import * as React from '@theia/core/shared/react';
import { shouldSubmitComposer } from '../composer-behavior';
import { PoiesisImeValueProps, useImeSafeValue } from './poiesis-inputs';

export type PoiesisComposerProps = PoiesisImeValueProps<HTMLTextAreaElement>
    & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    'value' | 'defaultValue' | 'onChange' | 'onInput' | 'onCompositionStart' | 'onCompositionEnd' | 'onSubmit'>
    & { onSubmit: () => void };

export const PoiesisComposer = ({
    value,
    onValueChange,
    elementRef,
    onSubmit,
    onKeyDown,
    ...props
}: PoiesisComposerProps): React.ReactElement => {
    const ime = useImeSafeValue<HTMLTextAreaElement>(value, onValueChange, elementRef);
    return (
        <textarea
            {...props}
            {...ime}
            defaultValue={value}
            onKeyDown={event => {
                onKeyDown?.(event);
                if (event.defaultPrevented) {
                    return;
                }
                const nativeEvent = event.nativeEvent as KeyboardEvent;
                if (shouldSubmitComposer({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: nativeEvent.isComposing,
                    keyCode: nativeEvent.keyCode
                }, event.currentTarget.value)) {
                    event.preventDefault();
                    onSubmit();
                }
            }}
        />
    );
};

