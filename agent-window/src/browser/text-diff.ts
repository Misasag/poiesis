export type TextDiffLineKind = 'unchanged' | 'added' | 'removed';

export interface TextDiffLine {
    kind: TextDiffLineKind;
    text: string;
}

/** Produces a stable line diff using the longest common subsequence. */
export function diffTextLines(before: string, after: string): TextDiffLine[] {
    const left = lines(before);
    const right = lines(after);
    const lengths = Array.from({ length: left.length + 1 }, () =>
        new Uint32Array(right.length + 1));

    for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex--) {
        for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex--) {
            lengths[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex]
                ? lengths[leftIndex + 1][rightIndex + 1] + 1
                : Math.max(lengths[leftIndex + 1][rightIndex], lengths[leftIndex][rightIndex + 1]);
        }
    }

    const diff: TextDiffLine[] = [];
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < left.length && rightIndex < right.length) {
        if (left[leftIndex] === right[rightIndex]) {
            diff.push({ kind: 'unchanged', text: left[leftIndex] });
            leftIndex++;
            rightIndex++;
        } else if (lengths[leftIndex + 1][rightIndex] >= lengths[leftIndex][rightIndex + 1]) {
            diff.push({ kind: 'removed', text: left[leftIndex++] });
        } else {
            diff.push({ kind: 'added', text: right[rightIndex++] });
        }
    }
    while (leftIndex < left.length) {
        diff.push({ kind: 'removed', text: left[leftIndex++] });
    }
    while (rightIndex < right.length) {
        diff.push({ kind: 'added', text: right[rightIndex++] });
    }
    return diff;
}

function lines(value: string): string[] {
    if (!value) {
        return [];
    }
    return value.replace(/\r\n?/g, '\n').split('\n');
}
