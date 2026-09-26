import { injectable } from '@theia/core/shared/inversify';
import { KnownCliId } from '../common/agent-runtime-protocol';

export interface AiSelection {
    providerId: KnownCliId;
    model: string;
    effort: string;
}

export function resolveResultsQuestionSelection(state: {
    questionSameAsResults: boolean;
    questionCli: KnownCliId;
    questionModel: string;
    questionEffort: string;
    resultsCli: KnownCliId;
    resultsModel: string;
    resultsEffort: string;
}): AiSelection {
    const selection = state.questionSameAsResults
        ? { providerId: state.resultsCli, model: state.resultsModel, effort: state.resultsEffort }
        : { providerId: state.questionCli, model: state.questionModel, effort: state.questionEffort };
    return { ...selection, model: selection.model.trim() };
}

/** Runtime selection only; orchestration remains a Results Skill concern. */
@injectable()
export class ResultsGenerationContext {
    providerId: KnownCliId = 'codex';
    model = '';
    effort = '';
    /** Undefined follows the Results selection, including subsequent changes. */
    judgeSelection?: AiSelection;

    get judge(): AiSelection {
        const selection = this.judgeSelection ?? this;
        return { providerId: selection.providerId, model: selection.model.trim(), effort: selection.effort };
    }
}
