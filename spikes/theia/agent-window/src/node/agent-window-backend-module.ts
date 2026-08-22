import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { ContainerModule } from '@theia/core/shared/inversify';
import {
    AgentRuntimeClient,
    AgentRuntimeServer,
    agentRuntimeServerPath
} from '../common/agent-runtime-protocol';
import { AgentRuntimeServerImpl } from './agent-runtime-server';
import { CliDetector } from './cli-detector';

export default new ContainerModule(bind => {
    bind(CliDetector).toSelf().inSingletonScope();
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
