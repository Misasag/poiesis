import type { ResultsGenerationRequest, ResultsGenerationTaskMetadata } from '../common/results-generation-protocol';

export const RESULTS_INPUT_MAX_BYTES = 32 * 1024 * 1024;
export const RESULTS_DIFF_MAX_BYTES = 16 * 1024 * 1024;
const TEXT_LIMIT = 256_000;
const SECRET_NAME = /(?:secret|token|password|passwd|credential|api[_-]?key|authorization|private[_-]?key)/i;

/** Resolve values only for this invocation; never keep credentials in a capture or artifact. */
export function resultsRedactor(env: NodeJS.ProcessEnv = process.env): (text: string) => string {
    const values = Object.entries(env).filter(([key, value]) => SECRET_NAME.test(key) && value && value.length >= 4)
        .map(([, value]) => value!).sort((a, b) => b.length - a.length);
    return text => {
        for (const value of values) { text = text.split(value).join('[REDACTED]'); }
        return text.replace(/((?:[\w.-]*(?:secret|token|password|passwd|credential|api[_-]?key|authorization)[\w.-]*)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
            .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
            .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]');
    };
}

export function resultsRelativePath(value: string): string {
    const path = value.replace(/\\/g, '/');
    if (!path || path.startsWith('/') || /[:\x00-\x1f]/.test(path)
        || path.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('成果の資料に作業場所の外を指すパスが含まれています。');
    }
    return path;
}

/** The diff remains complete. Oversized diffs fail explicitly instead of becoming misleading partial diffs. */
export function buildResultsSkillInput(request: ResultsGenerationRequest, workspace: string, skillDir: string): object {
    const redact = resultsRedactor();
    const text = (value = ''): string => {
        const clean = redact(value);
        return clean.length <= TEXT_LIMIT ? clean : `${clean.slice(0, TEXT_LIMIT)}\n[Truncated: original length ${clean.length} characters]`;
    };
    const files = (values = request.changedFiles ?? []) => values.map(file => ({
        path: resultsRelativePath(file.path), status: file.status, additions: file.additions, deletions: file.deletions
    }));
    const task = (value: ResultsGenerationTaskMetadata) => ({
        title: text(value.title), request: text(value.request), status: value.status, endedAt: value.endedAt ?? '',
        completionSummary: text(value.completionSummary), implementerReport: text(value.implementerReport), failureSummary: text(value.failureSummary)
    });
    if (Buffer.byteLength(request.diff, 'utf8') > RESULTS_DIFF_MAX_BYTES) {
        throw new Error('変更内容が資料の上限（16 MiB）を超えています。省略せずに渡せないため作成を中止しました。');
    }
    const verification = request.verification ?? {
        rows: [], counts: { pass: 0, fail: 0, unknown: 0, outdated: 0, human: 0 }, total: 0, humanCount: 0, summary: '', operationSummary: ''
    };
    // Preserve the table's counts, row order and optional evidence fields.
    const cleanObject = (value: unknown): unknown => {
        if (typeof value === 'string') { return redact(value); }
        if (Array.isArray(value)) { return value.map(cleanObject); }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_NAME.test(key) ? '[REDACTED]' : cleanObject(item)]));
        }
        return value;
    };
    const result = {
        schema: 'poiesis-results-input/1', workspace: workspace.replace(/\\/g, '/'), skillDir: skillDir.replace(/\\/g, '/'), task: task(request.taskMetadata),
        requirement: request.requirement ? { title: text(request.requirement.title),
            tasks: request.requirement.tasks.map(value => ({ ...task(value), changedFiles: files(value.changedFiles ?? []) })) } : null,
        changedFiles: files(), changeCaptureError: request.changeCaptureError ? text(request.changeCaptureError) : null,
        diff: redact(request.diff), executionEvidence: text(request.executionEvidence),
        verification: cleanObject({ ...verification, rows: verification.rows.map(row => ({ ...row,
            ...(row.image ? { image: resultsRelativePath(row.image) } : {}) })) }),
        hookMaterial: text(request.hookMaterial), images: (request.images ?? []).map(image => ({ path: resultsRelativePath(image.path), label: text(image.label) })),
        userGuidance: text(request.workspaceSkillGuidance),
        retry: request.attempt === 2 ? { attempt: 2, reason: text(request.assertionRetryGuidance) } : null
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > RESULTS_INPUT_MAX_BYTES) {
        throw new Error('成果の資料が上限（32 MiB）を超えたため作成を中止しました。');
    }
    return result;
}
