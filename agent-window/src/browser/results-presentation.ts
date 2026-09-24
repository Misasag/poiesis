import type { VerificationTable } from './results-evidence';

export interface ResultsHeaderText {
    title: string;
    secondaryTitle?: string;
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

/** Show evidence immediately whenever a person needs to inspect a result. */
export function verificationTableExpanded(table: VerificationTable, userChoice?: boolean): boolean {
    return userChoice ?? table.rows.some(row => row.status !== 'pass' || row.human === true);
}
