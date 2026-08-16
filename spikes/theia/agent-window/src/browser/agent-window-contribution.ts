import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { AgentWindowWidget } from './agent-window-widget';

@injectable()
export class AgentWindowContribution extends AbstractViewContribution<AgentWindowWidget> implements FrontendApplicationContribution {
    constructor() {
        super({
            widgetId: AgentWindowWidget.ID,
            widgetName: AgentWindowWidget.LABEL,
            defaultWidgetOptions: {
                area: 'right',
                rank: 100
            },
            toggleCommandId: 'lens.agentWindow.toggle'
        });
    }

    async initializeLayout(): Promise<void> {
        await this.openView({ reveal: true });
    }
}
