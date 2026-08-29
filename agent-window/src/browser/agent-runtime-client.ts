import { Emitter, Event } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AgentRuntimeClient, CodexExecutionEvent } from '../common/agent-runtime-protocol';

@injectable()
export class AgentRuntimeClientImpl implements AgentRuntimeClient {
    protected readonly onCodexEventEmitter = new Emitter<CodexExecutionEvent>();
    readonly onCodexEvent: Event<CodexExecutionEvent> = this.onCodexEventEmitter.event;

    notifyCodexEvent(event: CodexExecutionEvent): void {
        this.onCodexEventEmitter.fire(event);
    }
}
