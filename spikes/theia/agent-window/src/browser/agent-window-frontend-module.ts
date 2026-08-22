import { ContainerModule } from '@theia/core/shared/inversify';
import {
    bindViewContribution,
    FrontendApplicationContribution
} from '@theia/core/lib/browser';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager';
import { AgentWindowContribution } from './agent-window-contribution';
import { AgentWindowWidget } from './agent-window-widget';
import { ChangesContribution } from './changes-contribution';
import { ChangesWidget } from './changes-widget';
import { DesignShotContribution } from './design-shot-contribution';
import '../../src/browser/style/index.css';

export default new ContainerModule(bind => {
    bind(DesignShotContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(DesignShotContribution);

    bind(AgentWindowWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: AgentWindowWidget.ID,
        createWidget: () => context.container.get(AgentWindowWidget)
    })).inSingletonScope();
    bindViewContribution(bind, AgentWindowContribution);
    bind(FrontendApplicationContribution).toService(AgentWindowContribution);

    bind(ChangesWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: ChangesWidget.ID,
        createWidget: () => context.container.get(ChangesWidget)
    })).inSingletonScope();
    bindViewContribution(bind, ChangesContribution);
    bind(FrontendApplicationContribution).toService(ChangesContribution);
});
