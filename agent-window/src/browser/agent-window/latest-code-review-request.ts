export interface CodeReviewRequestToken {
    isCurrent(): boolean;
}

export class LatestCodeReviewRequest {
    protected generation = 0;

    begin(): CodeReviewRequestToken {
        const generation = ++this.generation;
        return {
            isCurrent: () => generation === this.generation
        };
    }

    cancel(): void {
        this.generation += 1;
    }
}
