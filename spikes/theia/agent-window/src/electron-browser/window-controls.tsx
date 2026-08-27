import * as React from '@theia/core/shared/react';
import { Disposable } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import type { TheiaCoreAPI } from '@theia/core/lib/electron-common/electron-api';
import { injectable } from '@theia/core/shared/inversify';
import { Widget } from '@theia/core/shared/@lumino/widgets';

const INTERACTIVE_HEADER_SELECTOR = [
    'button',
    'select',
    'input',
    'textarea',
    '[role="tab"]',
    'a',
    '[contenteditable="true"]',
    '.poiesis-window-controls'
].join(', ');

@injectable()
export class WindowControls extends ReactWidget implements FrontendApplicationContribution {
    protected maximized = false;

    constructor() {
        super();
        this.id = 'poiesis-window-controls';
        this.addClass('poiesis-window-controls');
        this.node.setAttribute('role', 'group');
        this.node.setAttribute('aria-label', 'ウィンドウ操作');
        this.scrollOptions = undefined;
    }

    onStart(): void {
        this.maximized = this.electron.isMaximized();
        this.toDispose.pushAll([
            this.electron.onWindowEvent('maximize', () => this.setMaximized(true)),
            this.electron.onWindowEvent('unmaximize', () => this.setMaximized(false)),
            Disposable.create(() => document.removeEventListener('dblclick', this.handleHeaderDoubleClick, true))
        ]);
        document.addEventListener('dblclick', this.handleHeaderDoubleClick, true);
        Widget.attach(this, document.body);
        this.update();
    }

    onStop(): void {
        if (this.isAttached) {
            Widget.detach(this);
        }
        this.dispose();
    }

    protected get electron(): TheiaCoreAPI {
        return window.electronTheiaCore;
    }

    protected readonly handleHeaderDoubleClick = (event: MouseEvent): void => {
        if (event.button !== 0 || !(event.target instanceof Element)) {
            return;
        }
        const header = event.target.closest('.poiesis-agent-window__header');
        if (!header || event.target.closest(INTERACTIVE_HEADER_SELECTOR)) {
            return;
        }
        this.toggleMaximized();
    };

    protected setMaximized(maximized: boolean): void {
        if (this.maximized !== maximized) {
            this.maximized = maximized;
            this.update();
        }
    }

    protected toggleMaximized(): void {
        if (this.electron.isMaximized()) {
            this.electron.unMaximize();
        } else {
            this.electron.maximize();
        }
    }

    protected render(): React.ReactNode {
        const maximizeLabel = this.maximized ? '元に戻す' : '最大化';
        const maximizeIcon = this.maximized ? 'chrome-restore' : 'chrome-maximize';
        return (
            <>
                <button
                    type='button'
                    className='poiesis-window-controls__button'
                    data-window-action='minimize'
                    aria-label='最小化'
                    title='最小化'
                    onClick={() => this.electron.minimize()}
                >
                    <span className='codicon codicon-chrome-minimize' aria-hidden='true' />
                </button>
                <button
                    type='button'
                    className='poiesis-window-controls__button'
                    data-window-action={this.maximized ? 'restore' : 'maximize'}
                    aria-label={maximizeLabel}
                    title={maximizeLabel}
                    onClick={() => this.toggleMaximized()}
                >
                    <span className={`codicon codicon-${maximizeIcon}`} aria-hidden='true' />
                </button>
                <button
                    type='button'
                    className='poiesis-window-controls__button poiesis-window-controls__close'
                    data-window-action='close'
                    aria-label='閉じる'
                    title='閉じる'
                    onClick={() => this.electron.close()}
                >
                    <span className='codicon codicon-chrome-close' aria-hidden='true' />
                </button>
            </>
        );
    }
}
