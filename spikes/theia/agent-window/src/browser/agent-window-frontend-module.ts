import { ContainerModule } from '@theia/core/shared/inversify';
import {
    FrontendApplication,
    FrontendApplicationContribution,
    WebSocketConnectionProvider
} from '@theia/core/lib/browser';
import { AgentWindowContribution } from './agent-window-contribution';
import { AgentWindowWidget } from './agent-window-widget';
import { AgentRuntimeClientImpl } from './agent-runtime-client';
import { CliAgentProvider } from './cli-agent-provider';
import { DesignShotContribution } from './design-shot-contribution';
import { AgentProvider } from '../common/agent-provider';
import { AgentRuntimeServer, agentRuntimeServerPath } from '../common/agent-runtime-protocol';
import { MockAgentProvider } from './mock-agent-provider';
import { BundledResultsSkill, ResultsService, ResultsSkill } from './results-skill';
import { TaskService } from './task-service';
import { PoiesisFrontendApplication } from './poiesis-frontend-application';
import { CustomizationService } from './customization-service';
import { FolderExplorerService } from './folder-explorer-service';
import { ResultsQuestionServer, resultsQuestionServerPath } from '../common/results-question-protocol';
import { ResultsQuestionService } from './results-question-service';
import '../../src/browser/style/index.css';

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    rebind(FrontendApplication).to(PoiesisFrontendApplication).inSingletonScope();

    bind(AgentRuntimeClientImpl).toSelf().inSingletonScope();
    bind(AgentRuntimeServer).toDynamicValue(context => {
        const client = context.container.get(AgentRuntimeClientImpl);
        return context.container.get(WebSocketConnectionProvider)
            .createProxy<AgentRuntimeServer>(agentRuntimeServerPath, client);
    }).inSingletonScope();
    bind(ResultsQuestionServer).toDynamicValue(context => context.container.get(WebSocketConnectionProvider)
        .createProxy<ResultsQuestionServer>(resultsQuestionServerPath)).inSingletonScope();
    bind(ResultsQuestionService).toSelf().inSingletonScope();
    bind(TaskService).toSelf().inSingletonScope();
    bind(MockAgentProvider).toSelf().inSingletonScope();
    bind(CliAgentProvider).toSelf().inSingletonScope();
    bind(AgentProvider).toService(CliAgentProvider);
    bind(BundledResultsSkill).toSelf().inSingletonScope();
    bind(ResultsSkill).toService(BundledResultsSkill);
    bind(ResultsService).toSelf().inSingletonScope();
    bind(CustomizationService).toSelf().inSingletonScope();
    bind(FolderExplorerService).toSelf().inSingletonScope();

    bind(DesignShotContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(DesignShotContribution);

    bind(AgentWindowWidget).toSelf().inSingletonScope();
    bind(AgentWindowContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(AgentWindowContribution);

});
