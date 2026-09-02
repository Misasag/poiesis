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
import { AiResultsSkill, BundledResultsSkill, ResultsService, ResultsSkill } from './results-skill';
import { TaskService } from './task-service';
import { PoiesisFrontendApplication } from './poiesis-frontend-application';
import { FolderExplorerService } from './folder-explorer-service';
import { ResultsQuestionServer, resultsQuestionServerPath } from '../common/results-question-protocol';
import { ResultsQuestionService } from './results-question-service';
import { WorkspaceTrustService } from '@theia/workspace/lib/browser/workspace-trust-service';
import { PoiesisWorkspaceTrustService } from './poiesis-workspace-trust-service';
import { BrowserGlobalStorageService, GlobalStorageService } from './global-storage-service';
import { ResultsGenerationServer, resultsGenerationServerPath } from '../common/results-generation-protocol';
import { ResultsGenerationContext } from './results-generation-context';
import { FileResourceResolver } from '@theia/filesystem/lib/browser/file-resource';
import { PoiesisFileResourceResolver } from './poiesis-file-resource-resolver';
import { WorkspaceSkillService } from './workspace-skill-service';
import { RequirementService } from './requirement-service';
import {
    RequirementClassificationServer,
    requirementClassificationServerPath
} from '../common/requirement-classification-protocol';
import { RequirementClassificationService } from './requirement-classification-service';
import { ResultsAssertionServer, resultsAssertionServerPath } from '../common/results-assertion-protocol';
import '../../src/browser/style/base.css';
import '../../src/browser/style/components.css';
import '../../src/browser/style/rail.css';
import '../../src/browser/style/header.css';
import '../../src/browser/style/agent.css';
import '../../src/browser/style/results.css';
import '../../src/browser/style/code.css';
import '../../src/browser/style/customize.css';
import '../../src/browser/style/settings.css';
import '../../src/browser/style/responsive.css';

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    rebind(FrontendApplication).to(PoiesisFrontendApplication).inSingletonScope();
    bind(PoiesisWorkspaceTrustService).toSelf().inSingletonScope();
    rebind(WorkspaceTrustService).toService(PoiesisWorkspaceTrustService);
    bind(PoiesisFileResourceResolver).toSelf().inSingletonScope();
    rebind(FileResourceResolver).toService(PoiesisFileResourceResolver);

    bind(AgentRuntimeClientImpl).toSelf().inSingletonScope();
    bind(AgentRuntimeServer).toDynamicValue(context => {
        const client = context.container.get(AgentRuntimeClientImpl);
        return context.container.get(WebSocketConnectionProvider)
            .createProxy<AgentRuntimeServer>(agentRuntimeServerPath, client);
    }).inSingletonScope();
    bind(ResultsQuestionServer).toDynamicValue(context => context.container.get(WebSocketConnectionProvider)
        .createProxy<ResultsQuestionServer>(resultsQuestionServerPath)).inSingletonScope();
    bind(ResultsAssertionServer).toDynamicValue(context => context.container.get(WebSocketConnectionProvider)
        .createProxy<ResultsAssertionServer>(resultsAssertionServerPath)).inSingletonScope();
    bind(RequirementClassificationServer).toDynamicValue(context => context.container.get(WebSocketConnectionProvider)
        .createProxy<RequirementClassificationServer>(requirementClassificationServerPath)).inSingletonScope();
    bind(ResultsGenerationServer).toDynamicValue(context => context.container.get(WebSocketConnectionProvider)
        .createProxy<ResultsGenerationServer>(resultsGenerationServerPath)).inSingletonScope();
    bind(ResultsGenerationContext).toSelf().inSingletonScope();
    bind(ResultsQuestionService).toSelf().inSingletonScope();
    bind(TaskService).toSelf().inSingletonScope();
    bind(RequirementService).toSelf().inSingletonScope();
    bind(RequirementClassificationService).toSelf().inSingletonScope();
    bind(MockAgentProvider).toSelf().inSingletonScope();
    bind(CliAgentProvider).toSelf().inSingletonScope();
    bind(AgentProvider).toService(CliAgentProvider);
    bind(BundledResultsSkill).toSelf().inSingletonScope();
    bind(AiResultsSkill).toSelf().inSingletonScope();
    bind(ResultsSkill).toService(AiResultsSkill);
    bind(ResultsService).toSelf().inSingletonScope();
    bind(FolderExplorerService).toSelf().inSingletonScope();
    bind(BrowserGlobalStorageService).toSelf().inSingletonScope();
    bind(GlobalStorageService).toService(BrowserGlobalStorageService);
    bind(WorkspaceSkillService).toSelf().inSingletonScope();

    bind(DesignShotContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(DesignShotContribution);

    bind(AgentWindowWidget).toSelf().inSingletonScope();
    bind(AgentWindowContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(AgentWindowContribution);

});
