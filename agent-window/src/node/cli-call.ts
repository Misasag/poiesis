import { CliCallRecord, CliOutput, finishCliCall, parseCliOutput } from '../common/cli-usage';

/** One capture per invocation, including unsuccessful and cancelled calls. */
export class CliCallCapture {
    protected output: CliOutput = { text: '' };
    exitCode?: number;
    constructor(readonly start: Pick<CliCallRecord, 'purpose' | 'providerId' | 'model' | 'effort' | 'attempt'> & { startedAt: string }) { }

    parse(stdout: string): CliOutput {
        this.output = parseCliOutput(this.start.providerId, stdout);
        return this.output;
    }

    finish(): CliCallRecord {
        return finishCliCall({ ...this.start, model: this.output.model ?? this.start.model }, this.output.usage, this.exitCode);
    }
}

export async function captureCliCall<T>(
    scope: Pick<CliCallRecord, 'providerId' | 'model' | 'effort' | 'attempt'>,
    purpose: CliCallRecord['purpose'],
    operation: (call: CliCallCapture) => Promise<T>
): Promise<T & { call: CliCallRecord }> {
    const call = new CliCallCapture({ providerId: scope.providerId, attempt: scope.attempt, purpose, model: scope.model?.trim() || undefined,
        effort: scope.effort?.trim() || undefined, startedAt: new Date().toISOString() });
    const result = await operation(call);
    return { ...result, call: call.finish() };
}
