import { inject, injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { Command, CommandRegistry } from '@theia/core/lib/common';
import { ChangesWidget } from './changes-widget';

@injectable()
export class ChangesContribution extends AbstractViewContribution<ChangesWidget> implements FrontendApplicationContribution {
    static readonly OPEN_COMMAND: Command = {
        id: 'lens.changes.open',
        label: 'Lens: Open IDE Changes'
    };

    constructor(@inject(StatusBar) protected readonly statusBar: StatusBar) {
        super({
            widgetId: ChangesWidget.ID,
            widgetName: ChangesWidget.LABEL,
            defaultWidgetOptions: {
                area: 'bottom',
                rank: 80
            },
            toggleCommandId: 'lens.changes.toggle',
            toggleKeybinding: 'ctrlcmd+shift+alt+c'
        });
    }

    onStart(): void {
        this.statusBar.setElement('lens-changes', {
            text: '$(git-compare) IDE Changes',
            name: 'IDE Changes',
            alignment: StatusBarAlignment.LEFT,
            priority: 9,
            onclick: () => void this.openView({ activate: true, reveal: true }),
            tooltip: 'Open IDE Changes manually'
        });
    }

    registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        commands.registerCommand(ChangesContribution.OPEN_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }
}
