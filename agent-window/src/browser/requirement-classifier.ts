export type RequirementClassificationDecision = 'continue' | 'new';

export interface RequirementClassifierTaskLike {
    id: string;
    status: string;
    startedAt?: string;
    requirementChoice?: 'explicit' | 'default';
    workspaceUri?: string;
    changeSet?: {
        source?: string;
        files: readonly string[];
        diff?: string;
        error?: string;
    };
}

export interface RequirementClassifierRequirementLike {
    taskIds: readonly string[];
    tasks?: readonly Pick<RequirementClassifierTaskLike, 'id' | 'status' | 'startedAt'>[];
}

export interface RequirementClassifierSettings {
    enabled: boolean;
    workspaceIsLocal?: boolean;
}

export interface RequirementHeuristicDecision {
    decision: 'continue';
    reason: 'file-overlap' | 'previous-task-reference';
}

export interface ParsedRequirementClassification {
    decision: RequirementClassificationDecision;
    confidence?: number;
    title?: string;
    reason: string;
}

export const INVALID_CLASSIFICATION_REASON = 'invalid-response';

// Intentionally small: these words explicitly point back to earlier work.
const PREVIOUS_TASK_REFERENCE_WORDS = ['さっき', '先ほど', '前回', '続き', 'same', 'previous'] as const;

export function shouldClassify(
    task: RequirementClassifierTaskLike,
    requirement: RequirementClassifierRequirementLike | undefined,
    settings: RequirementClassifierSettings
): boolean {
    if (!settings.enabled
        || settings.workspaceIsLocal === false
        || task.requirementChoice !== 'default'
        || task.status !== 'completed'
        || task.changeSet?.source === 'empty'
        || task.changeSet?.error
        || !task.changeSet?.files.length
        || !requirement) {
        return false;
    }
    const otherFinishedTasks = requirement.tasks
        ? requirement.tasks.filter(candidate => candidate.id !== task.id
            && candidate.status !== 'running'
            && (!task.startedAt || !candidate.startedAt || candidate.startedAt < task.startedAt))
        : requirement.taskIds.filter(taskId => taskId !== task.id);
    return otherFinishedTasks.length > 0;
}

export function heuristicDecision(
    taskFiles: readonly string[],
    requirementFiles: readonly string[],
    request: string
): RequirementHeuristicDecision | undefined {
    const earlierFiles = new Set(requirementFiles.map(normalizePath).filter(Boolean));
    if (taskFiles.some(file => earlierFiles.has(normalizePath(file)))) {
        return { decision: 'continue', reason: 'file-overlap' };
    }
    const normalizedRequest = request.toLocaleLowerCase();
    if (PREVIOUS_TASK_REFERENCE_WORDS.some(word => normalizedRequest.includes(word))) {
        return { decision: 'continue', reason: 'previous-task-reference' };
    }
    return undefined;
}

export function parseClassification(text: string): ParsedRequirementClassification {
    const jsonBlock = typeof text === 'string' ? text.match(/\{[\s\S]*?\}/)?.[0] : undefined;
    if (!jsonBlock) {
        return invalidClassification();
    }
    try {
        const parsed = JSON.parse(jsonBlock) as Record<string, unknown> | null;
        if (!parsed
            || (parsed.decision !== 'continue' && parsed.decision !== 'new')
            || typeof parsed.confidence !== 'number'
            || !Number.isFinite(parsed.confidence)
            || parsed.confidence < 0
            || parsed.confidence > 1
            || typeof parsed.reason !== 'string'
            || parsed.title !== undefined && typeof parsed.title !== 'string'
            || parsed.decision === 'new' && typeof parsed.title !== 'string') {
            return invalidClassification();
        }
        const confidence = parsed.confidence;
        const reason = parsed.reason.trim().slice(0, 300);
        const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 24) : undefined;
        return {
            decision: parsed.decision === 'new' && confidence >= 0.8 ? 'new' : 'continue',
            confidence,
            title,
            reason
        };
    } catch {
        return invalidClassification();
    }
}

function invalidClassification(): ParsedRequirementClassification {
    return { decision: 'continue', reason: INVALID_CLASSIFICATION_REASON };
}

function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\.\//, '').trim().toLocaleLowerCase();
}
