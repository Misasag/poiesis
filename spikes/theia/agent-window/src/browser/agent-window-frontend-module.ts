import { ContainerModule } from '@theia/core/shared/inversify';
import {
    bindViewContribution,
    FrontendApplicationContribution,
    WebSocketConnectionProvider
} from '@theia/core/lib/browser';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager';
import { AgentWindowContribution } from './agent-window-contribution';
import { AgentWindowWidget } from './agent-window-widget';
import { ChangesContribution } from './changes-contribution';
import { ChangesWidget } from './changes-widget';
import { AgentRuntimeClientImpl } from './agent-runtime-client';
import { CliAgentProvider } from './cli-agent-provider';
import { DesignShotContribution } from './design-shot-contribution';
import { AgentProvider } from '../common/agent-provider';
import { AgentRuntimeServer, agentRuntimeServerPath } from '../common/agent-runtime-protocol';
import { MockAgentProvider } from './mock-agent-provider';
import { BundledResultsSkill, ResultsService, ResultsSkill } from './results-skill';
import { TaskService } from './task-service';
import '../../src/browser/style/index.css';

export default new ContainerModule(bind => {
    bind(AgentRuntimeClientImpl).toSelf().inSingletonScope();
    bind(AgentRuntimeServer).toDynamicValue(context => {
        const client = context.container.get(AgentRuntimeClientImpl);
        return context.container.get(WebSocketConnectionProvider)
            .createProxy<AgentRuntimeServer>(agentRuntimeServerPath, client);
    }).inSingletonScope();
    bind(TaskService).toSelf().inSingletonScope();
    bind(MockAgentProvider).toSelf().inSingletonScope();
    bind(CliAgentProvider).toSelf().inSingletonScope();
    bind(AgentProvider).toService(CliAgentProvider);
    bind(BundledResultsSkill).toSelf().inSingletonScope();
    bind(ResultsSkill).toService(BundledResultsSkill);
    bind(ResultsService).toSelf().inSingletonScope();

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
