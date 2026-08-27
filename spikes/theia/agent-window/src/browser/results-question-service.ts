import { inject, injectable } from '@theia/core/shared/inversify';
import {
    ResultsQuestionResult,
    ResultsQuestionScope,
    ResultsQuestionServer
} from '../common/results-question-protocol';

/** Browser-side Results-only proxy. It owns no Agent conversation state. */
@injectable()
export class ResultsQuestionService {
    constructor(
        @inject(ResultsQuestionServer) protected readonly server: ResultsQuestionServer
    ) { }

    ask(question: string, scope: ResultsQuestionScope): Promise<ResultsQuestionResult> {
        return this.server.ask(question, scope);
    }

    cancel(taskId: string): Promise<void> {
        return this.server.cancel(taskId);
    }
}
