import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { ContainerModule } from '@theia/core/shared/inversify';
import {
    AgentRuntimeClient,
    AgentRuntimeServer,
    agentRuntimeServerPath
} from '../common/agent-runtime-protocol';
import { AgentRuntimeServerImpl } from './agent-runtime-server';
import { CliDetector } from './cli-detector';
import { CliProviderRegistry } from './cli-provider-registry';
import { ResultsQuestionServer, resultsQuestionServerPath } from '../common/results-question-protocol';
import { ResultsQuestionServerImpl } from './results-question-server';
import { ResultsGenerationServer, resultsGenerationServerPath } from '../common/results-generation-protocol';
import { ResultsGenerationServerImpl } from './results-generation-server';
import {
    RequirementClassificationServer,
    requirementClassificationServerPath
} from '../common/requirement-classification-protocol';
import { RequirementClassificationServerImpl } from './requirement-classification-server';
import { ResultsAssertionServer, resultsAssertionServerPath } from '../common/results-assertion-protocol';
import { ResultsAssertionServerImpl } from './results-assertion-server';

export default new ContainerModule(bind => {
    bind(CliDetector).toSelf().inSingletonScope();
    bind(CliProviderRegistry).toSelf().inSingletonScope();
    bind(ResultsAssertionServer).to(ResultsAssertionServerImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler(resultsAssertionServerPath, () =>
            context.container.get<ResultsAssertionServer>(ResultsAssertionServer)
        )
    ).inSingletonScope();
    bind(RequirementClassificationServer).to(RequirementClassificationServerImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler(requirementClassificationServerPath, () =>
            context.container.get<RequirementClassificationServer>(RequirementClassificationServer)
        )
    ).inSingletonScope();
    bind(ResultsQuestionServer).to(ResultsQuestionServerImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler(resultsQuestionServerPath, () =>
            context.container.get<ResultsQuestionServer>(ResultsQuestionServer)
        )
    ).inSingletonScope();
    bind(ResultsGenerationServer).to(ResultsGenerationServerImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler(resultsGenerationServerPath, () =>
            context.container.get<ResultsGenerationServer>(ResultsGenerationServer)
        )
    ).inSingletonScope();
    bind(AgentRuntimeServer).to(AgentRuntimeServerImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler<AgentRuntimeClient>(agentRuntimeServerPath, client => {
            const server = context.container.get<AgentRuntimeServer>(AgentRuntimeServer);
            server.setClient(client);
            client.onDidCloseConnection(() => server.setClient(undefined));
            return server;
        })
    ).inSingletonScope();
});
