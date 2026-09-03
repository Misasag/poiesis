import { Emitter } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
    AgentEvent,
    AgentMessage,
    AgentProvider,
    AgentRunProgress,
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

const CODEX_STDIN_NOTICE = /^Reading additional input from stdin\.\.\.\s*$/;

interface CliSession extends AgentSession {
    providerId: KnownCliId;
    model?: string;
    effort?: string;
    workspacePath?: string;
}

interface CodexRun {
    sessionId: string;
    taskId: string;
    executionId: string;
    providerId: KnownCliId;
    providerName: string;
    model?: string;
    effort?: string;
    activityParser: AgentActivityParser;
    stdoutBuffer: string;
    diagnostics: string;
    failureDiagnostics: string;
    finalMessage?: string;
    phase: AgentRunProgress['phase'];
    lastOutputAt?: string;
    lastProgressEmittedAt?: number;
    progressTimer?: ReturnType<typeof setTimeout>;
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
                    effort: input.effort?.trim() || undefined,
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
            message.workspaceUri,
            session.providerId,
            session.model,
            session.effort
        );
        const run: CodexRun = {
            sessionId,
            taskId: task.id,
            executionId: task.id,
            providerId: session.providerId,
            providerName: session.providerName,
            model: session.model,
            effort: session.effort,
            activityParser: createAgentActivityParser(session.providerId, session.workspacePath),
            stdoutBuffer: '',
            diagnostics: '',
            failureDiagnostics: '',
            phase: 'starting',
            state: 'starting'
        };
        this.runs.set(sessionId, run);
        this.eventEmitter.fire({ type: 'task-started', sessionId, taskId: task.id });
        this.emitProgress(run, true);

        try {
            const workspaceSkills = await this.workspaceSkillService.buildPrompt(session.workspaceUri, 'agent');
            this.taskService.setAppliedSkills(task.id, 'agent', workspaceSkills.includedSkillIds);
            for (const diagnostic of workspaceSkills.diagnostics) {
                this.appendDiagnostic(run, diagnostic);
                console.warn(`[Poiesis] ${diagnostic}`);
            }
            if (workspaceSkills.diagnostics.length > 0) {
                this.emitProgress(run);
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
                effort: session.effort,
                workspacePath: session.workspacePath,
                prompt: this.implementerPrompt(message.content, workspaceSkills.content)
            });
            if (this.runs.get(sessionId) === run) {
                run.phase = 'waiting';
                this.emitProgress(run);
            }
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
                this.clearProgressTimer(run);
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
            run.lastOutputAt = new Date().toISOString();
            run.phase = 'waiting';
            if (event.stream === 'stdout') {
                this.consumeStdout(run, event.delta);
            } else {
                this.appendDiagnostic(run, event.delta);
            }
            this.emitProgress(run);
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
        this.clearProgressTimer(run);
        this.runs.delete(run.sessionId);
        if (successful) {
            const task = await this.taskService.end(run.taskId, run.finalMessage?.trim() || 'タスクを完了しました。');
            await this.resultsService.whenFinished(run.taskId);
            this.eventEmitter.fire({
                type: 'message-delta',
                sessionId: run.sessionId,
                taskId: run.taskId,
                delta: task?.completionSummary ?? 'タスクを完了しました。'
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
            const details = run.failureDiagnostics.trim() || undefined;
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
        this.clearProgressTimer(run);
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
        if (result.heartbeat) {
            run.phase = 'waiting';
        }
        if (result.finalMessage !== undefined) {
            run.finalMessage = result.finalMessage;
        }
        for (const diagnostic of result.diagnostics) {
            this.appendDiagnostic(run, diagnostic);
        }
        for (const activity of result.activities) {
            run.phase = activity.status === 'running' ? 'activity' : 'waiting';
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
        run.failureDiagnostics = `${run.failureDiagnostics}${run.failureDiagnostics ? '\n' : ''}${detail}`.slice(-20_000);
        const visibleDetail = run.providerId === 'codex'
            ? detail.split(/\r?\n/).filter(line => !CODEX_STDIN_NOTICE.test(line)).join('\n')
            : detail;
        if (visibleDetail.trim()) {
            run.diagnostics = `${run.diagnostics}${run.diagnostics ? '\n' : ''}${visibleDetail}`.slice(-20_000);
        }
    }

    protected emitProgress(run: CodexRun, immediate = false): void {
        const now = Date.now();
        const elapsed = now - (run.lastProgressEmittedAt ?? 0);
        if (!immediate && elapsed < 1_000) {
            if (!run.progressTimer) {
                run.progressTimer = setTimeout(() => {
                    run.progressTimer = undefined;
                    if (this.runs.get(run.sessionId) === run) {
                        this.emitProgress(run, true);
                    }
                }, 1_000 - elapsed);
            }
            return;
        }
        if (run.progressTimer) {
            clearTimeout(run.progressTimer);
            run.progressTimer = undefined;
        }
        run.lastProgressEmittedAt = now;
        this.eventEmitter.fire({
            type: 'progress',
            sessionId: run.sessionId,
            taskId: run.taskId,
            progress: {
                phase: run.phase,
                lastOutputAt: run.lastOutputAt,
                diagnostics: run.diagnostics.trim() || undefined
            }
        });
    }

    protected clearProgressTimer(run: CodexRun): void {
        if (run.progressTimer) {
            clearTimeout(run.progressTimer);
            run.progressTimer = undefined;
        }
    }

    protected implementerPrompt(request: string, workspaceSkillPrompt = ''): string {
        const skillProposalContract = [
            '',
            '## Application-owned Skill proposal channel',
            '非自明な検証手順、ビルド手順、または繰り返し使える作業ルールを見つけた場合だけ、`.poiesis/pending/skills/<skill-id>/SKILL.md` に Skill の提案を書いてよい（既存 Skill と同じ id なら更新提案）。`.poiesis/skills` 配下の既存 Skill を直接編集してはならない。提案は1タスクにつき最大2件、frontmatter は name / description / metadata.poiesis.kind を含める。'
        ].join('\n');
        const finalReportRequest = '\nReturn the final report in the user\'s language.';
        return `You are the Poiesis implementer. Only edit files in this directory. Do not leave it. Do not git commit or push.\n\n${request}${workspaceSkillPrompt}${skillProposalContract}${finalReportRequest}`;
    }

    protected errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
