import { inject, injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { Command, CommandRegistry, MessageService } from '@theia/core/lib/common';
import { ChangesWidget } from './changes-widget';
import { isDesignVariant } from './design-variant';

@injectable()
export class ChangesContribution extends AbstractViewContribution<ChangesWidget> implements FrontendApplicationContribution {
    static readonly OPEN_COMMAND: Command = {
        id: 'poiesis.changes.open',
        label: 'Poiesis: Open IDE Changes'
    };

    constructor(
        @inject(StatusBar) protected readonly statusBar: StatusBar,
        @inject(MessageService) protected readonly messageService: MessageService
    ) {
        super({
            widgetId: ChangesWidget.ID,
            widgetName: ChangesWidget.LABEL,
            defaultWidgetOptions: {
                area: isDesignVariant('d2-b') ? 'main' : 'bottom',
                rank: 80
            },
            toggleCommandId: 'poiesis.changes.toggle',
            toggleKeybinding: 'ctrlcmd+shift+alt+c'
        });
    }

    onStart(): void {
        this.statusBar.setElement('poiesis-changes', {
            text: isDesignVariant('d5-b') ? '$(git-compare) IDE Changes' : '$(git-compare) Changes: 1',
            name: 'IDE Changes',
            alignment: StatusBarAlignment.LEFT,
            priority: 9,
            onclick: () => void this.openView({ activate: true, reveal: true }),
            tooltip: 'Open IDE Changes manually'
        });
        if (isDesignVariant('d5-b')) {
            void this.messageService.info('Change Setを作成しました。', { timeout: 0 });
        }
    }

    registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        commands.registerCommand(ChangesContribution.OPEN_COMMAND, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }
}
