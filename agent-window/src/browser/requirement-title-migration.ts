import type { Requirement } from './requirement-model';
import { shortRequirementTitleFallback } from './results-assertions';

/** Applies the persisted, one-time shortening rule for legacy task-derived titles. */
export function shortenLegacyRequirementTitle(requirement: Requirement): Requirement {
    if (requirement.titleSource !== 'task'
        || requirement.title.length <= 24
        || requirement.titleShortened === true) {
        return requirement;
    }
    return {
        ...requirement,
        title: shortRequirementTitleFallback(requirement.title),
        titleShortened: true
    };
}
