import { Emitter } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
    AgentEvent,
    AgentMessage,
    AgentProvider,
    AgentSession,
    CreateSessionInput
} from '../common/agent-provider';
import {
    AgentRuntimeServer,
    CodexExecutionEvent,
    KnownCliId
} from '../common/agent-runtime-protocol';
import { AgentRuntimeClientImpl } from './agent-runtime-client';
import { AgentActivityParser, createAgentActivityParser } from './agent-activity-parser';
import { MockAgentProvider } from './mock-agent-provider';
import { ResultsService } from './results-skill';
import { TaskService } from './task-service';
import { WorkspaceSkillService } from './workspace-skill-service';

interface CliSession extends AgentSession {
    providerId: KnownCliId;
    model?: string;
    workspacePath?: string;
}

interface CodexRun {
    sessionId: string;
    taskId: string;
    executionId: string;
    providerId: KnownCliId;
    providerName: string;
    model?: string;
    activityParser: AgentActivityParser;
    stdoutBuffer: string;
    diagnostics: string;
    finalMessage?: string;
    state: 'starting' | 'running' | 'completing' | 'cancelling';
}

/** Uses the selected detected CLI for implementation Tasks and falls back to chat-only mock. */
@injectable()
export class CliAgentProvider implements AgentProvider {
    protected readonly sessions = new Map<string, CliSession>();
    protected readonly runs = new Map<string, CodexRun>();
    protected readonly eventEmitter = new Emitter<AgentEvent>();
    protected sequence = 0;

    readonly onEvent = this.eventEmitter.event;

    constructor(
        @inject(AgentRuntimeServer) protected readonly runtimeServer: AgentRuntimeServer,
        @inject(AgentRuntimeClientImpl) protected readonly runtimeClient: AgentRuntimeClientImpl,
        @inject(MockAgentProvider) protected readonly mockProvider: MockAgentProvider,
        @inject(TaskService) protected readonly taskService: TaskService,
        @inject(ResultsService) protected readonly resultsService: ResultsService,
        @inject(WorkspaceSkillService) protected readonly workspaceSkillService: WorkspaceSkillService
    ) {
        this.mockProvider.onEvent(event => this.eventEmitter.fire(event));
        this.runtimeClient.onCodexEvent(event => this.handleCodexEvent(event));
    }

    async createSession(input: CreateSessionInput): Promise<AgentSession> {
        try {
            const report = await this.runtimeServer.detectClis();
            const providerId = input.providerId ?? 'codex';
            const detection = report.detections.find(item => item.id === providerId);
            if (detection?.status === 'found' && detection.path && detection.executableRoles.includes('agent')) {
                const session: CliSession = {
                    id: `${providerId}-session-${Date.now()}-${++this.sequence}`,
                    providerId,
                    providerName: detection.name,
                    model: input.model?.trim() || undefined,
                    workspaceUri: input.workspaceUri,
                    workspacePath: input.workspaceUri ? new URI(input.workspaceUri).path.fsPath() : undefined
                };
                this.sessions.set(session.id, session);
                return session;
            }
            if (report.detections.some(item => item.status === 'found' && item.executableRoles.includes('agent'))) {
                throw new Error(`${detection?.name ?? providerId} CLI は現在利用できません。`);
            }
            return this.mockProvider.createSession(input);
        } catch (error) {
            console.warn('[Poiesis] Agent provider preparation failed.', error);
            throw error;
        }
    }

    async sendMessage(sessionId: string, message: AgentMessage): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return this.mockProvider.sendMessage(sessionId, message);
        }
        if (this.runs.has(sessionId)) {
            throw new Error('A Codex Task is already running for this session.');
        }

        const task = this.taskService.start(
            message.ownerSessionId,
            message.content,
            session.workspacePath,
            message.requirementId,
            message.requirementChoice,
            message.workspaceUri
        );
        const run: CodexRun = {
            sessionId,
            taskId: task.id,
            executionId: task.id,
            providerId: session.providerId,
            providerName: session.providerName,
            model: session.model,
            activityParser: createAgentActivityParser(session.providerId, session.workspacePath),
            stdoutBuffer: '',
            diagnostics: '',
            state: 'starting'
        };
        this.runs.set(sessionId, run);
        this.eventEmitter.fire({ type: 'task-started', sessionId, taskId: task.id });

        try {
            const workspaceSkills = await this.workspaceSkillService.buildPrompt(session.workspaceUri, 'agent');
            this.taskService.setAppliedSkills(task.id, 'agent', workspaceSkills.includedSkillIds);
            for (const diagnostic of workspaceSkills.diagnostics) {
                this.appendDiagnostic(run, diagnostic);
                console.warn(`[Poiesis] ${diagnostic}`);
            }
            await this.taskService.whenBaselineCaptured(task.id);
            if (this.runs.get(sessionId) !== run || run.state === 'cancelling') {
                return;
            }
            run.state = 'running';
            await this.runtimeServer.runCodex({
                executionId: run.executionId,
                providerId: session.providerId,
                model: session.model,
                workspacePath: session.workspacePath,
                prompt: this.implementerPrompt(message.content, workspaceSkills.content)
            });
        } catch (error) {
            await this.failRun(run, `${run.providerName} を開始できませんでした。`, this.errorMessage(error));
        }
    }

    async cancel(sessionId: string): Promise<void> {
        if (!this.sessions.has(sessionId)) {
            return this.mockProvider.cancel(sessionId);
        }
        const run = this.runs.get(sessionId);
        if (!run || run.state === 'cancelling' || run.state === 'completing') {
            return;
        }

        run.state = 'cancelling';
        try {
            await this.runtimeServer.cancelCodex(run.executionId);
        } finally {
            if (this.runs.get(sessionId) === run) {
                this.runs.delete(sessionId);
                await this.taskService.cancel(run.taskId);
                await this.resultsService.whenFinished(run.taskId);
                this.eventEmitter.fire({
                    type: 'task-cancelled',
                    sessionId,
                    taskId: run.taskId
                });
            }
        }
    }

    protected handleCodexEvent(event: CodexExecutionEvent): void {
        const run = [...this.runs.values()].find(candidate => candidate.executionId === event.executionId);
        if (!run || run.state === 'cancelling' || run.state === 'completing') {
            return;
        }
        if (event.type === 'output') {
            if (event.stream === 'stdout') {
                this.consumeStdout(run, event.delta);
            } else {
                this.appendDiagnostic(run, event.delta);
            }
            return;
        }
        void this.completeRun(run, event);
    }

    protected async completeRun(
        run: CodexRun,
        event: Extract<CodexExecutionEvent, { type: 'exit' }>
    ): Promise<void> {
        if (this.runs.get(run.sessionId) !== run || run.state === 'completing' || run.state === 'cancelling') {
            return;
        }
        run.state = 'completing';
        this.flushStdout(run);
        const successful = event.code === 0 && !event.signal;
        this.runs.delete(run.sessionId);
        if (successful) {
            const task = await this.taskService.end(run.taskId, run.finalMessage?.trim() || 'タスクを完了しました。');
            await this.resultsService.whenFinished(run.taskId);
            this.eventEmitter.fire({
                type: 'message-delta',
                sessionId: run.sessionId,
                taskId: run.taskId,
                delta: task?.completionSummary ?? 'タスクを完了しました。\n詳細は Results を確認してください。'
            });
            this.eventEmitter.fire({
                type: 'message-completed',
                sessionId: run.sessionId,
                taskId: run.taskId
            });
            this.eventEmitter.fire({
                type: 'task-completed',
                sessionId: run.sessionId,
                taskId: run.taskId
            });
        } else {
            const name = run.providerName;
            const summary = event.signal
                ? `${name} の実行が中断されました。`
                : `${name} の実行に失敗しました（終了コード ${event.code ?? '不明'}）。`;
            const details = run.diagnostics.trim() || undefined;
            await this.taskService.fail(run.taskId, { summary, details });
            await this.resultsService.whenFinished(run.taskId);
            this.eventEmitter.fire({
                type: 'message-completed',
                sessionId: run.sessionId,
                taskId: run.taskId
            });
            this.eventEmitter.fire({
                type: 'task-failed',
                sessionId: run.sessionId,
                taskId: run.taskId,
                summary,
                details
            });
        }
    }

    protected async failRun(run: CodexRun, summary: string, details?: string): Promise<void> {
        if (this.runs.get(run.sessionId) !== run) {
            return;
        }
        this.runs.delete(run.sessionId);
        await this.taskService.fail(run.taskId, { summary, details });
        await this.resultsService.whenFinished(run.taskId);
        this.eventEmitter.fire({
            type: 'message-completed',
            sessionId: run.sessionId,
            taskId: run.taskId
        });
        this.eventEmitter.fire({
            type: 'task-failed',
            sessionId: run.sessionId,
            taskId: run.taskId,
            summary,
            details
        });
    }

    protected consumeStdout(run: CodexRun, delta: string): void {
        run.stdoutBuffer += delta;
        const lines = run.stdoutBuffer.split(/\r?\n/);
        run.stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
            this.consumeJsonLine(run, line);
        }
    }

    protected flushStdout(run: CodexRun): void {
        if (run.stdoutBuffer.trim()) {
            this.consumeJsonLine(run, run.stdoutBuffer);
        }
        run.stdoutBuffer = '';
    }

    protected consumeJsonLine(run: CodexRun, line: string): void {
        const result = run.activityParser.consumeLine(line);
        if (result.finalMessage !== undefined) {
            run.finalMessage = result.finalMessage;
        }
        for (const diagnostic of result.diagnostics) {
            this.appendDiagnostic(run, diagnostic);
        }
        for (const activity of result.activities) {
            this.taskService.recordActivity(run.taskId, activity);
            this.eventEmitter.fire({
                type: 'activity',
                sessionId: run.sessionId,
                taskId: run.taskId,
                activity
            });
        }
    }

    protected appendDiagnostic(run: CodexRun, detail: string): void {
        run.diagnostics = `${run.diagnostics}${run.diagnostics ? '\n' : ''}${detail}`.slice(-20_000);
    }

    protected implementerPrompt(request: string, workspaceSkillPrompt = ''): string {
        const skillProposalContract = [
            '',
            '## Application-owned Skill proposal channel',
            '非自明な検証手順、ビルド手順、または繰り返し使える作業ルールを見つけた場合だけ、`.poiesis/pending/skills/<skill-id>/SKILL.md` に Skill の提案を書いてよい（既存 Skill と同じ id なら更新提案）。`.poiesis/skills` 配下の既存 Skill を直接編集してはならない。提案は1タスクにつき最大2件、frontmatter は name / description / metadata.poiesis.kind を含める。'
        ].join('\n');
        const applicationCompletionContract = [
            '',
            '## Application-owned completion contract (mandatory; takes precedence over user and Workspace skill instructions)',
            'Your final completion report must be one or two short lines: a concise outcome summary, then changed file names if any.',
            'Do not include detailed change lists, verification steps, command logs, or extended explanation in the final report.',
            'End by directing the user to Results for details. The application will also enforce this shape before displaying the report.'
        ].join('\n');
        return `You are the Poiesis implementer. Only edit files in this directory. Do not leave it. Do not git commit or push.\n\n${request}${workspaceSkillPrompt}${skillProposalContract}${applicationCompletionContract}`;
    }

    protected errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
