export interface ResultsHeaderText {
    title: string;
    secondaryTitle?: string;
}

/**
 * The label for one task in Results: the classifier's phrase for what the task did, otherwise the request text.
 * A follow-up request is often only a reply (an approval), which says nothing about the work it started.
 */
export function taskDisplayTitle(task: { title: string; requirementClassification?: { taskTitle?: string } }): string {
    return task.requirementClassification?.taskTitle?.trim() || task.title;
}

/** The requirement names the result; a distinct, substantive task may add context. */
export function resultsHeaderText(requirementTitle: string, taskTitle?: string): ResultsHeaderText {
    const title = requirementTitle.trim();
    const secondary = taskTitle?.trim();
    if (!secondary || secondary === title
        || /^(?:(?:その理解|その内容|それ|これ)で[、\s]*)?(?:進めてください|お願いします|問題ありません|大丈夫です)[。.!！\s]*$/.test(secondary)) {
        return { title };
    }
    return { title, secondaryTitle: secondary };
}
