import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser';
import { Command, CommandRegistry } from '@theia/core/lib/common';
import { ChangesWidget } from './changes-widget';

@injectable()
export class ChangesContribution extends AbstractViewContribution<ChangesWidget> {
    static readonly OPEN_COMMAND: Command = {
        id: 'lens.changes.open',
        label: 'Lens: Open IDE Changes'
    };

    constructor() {
        super({
            widgetId: ChangesWidget.ID,
            widgetName: ChangesWidget.LABEL,
            defaultWidgetOptions: {
                area: 'bottom',
                rank: 80
            },
            toggleCommandId: 'lens.changes.toggle'
        });
    }

    registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        commands.registerCommand(ChangesContribution.OPEN_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }
}
