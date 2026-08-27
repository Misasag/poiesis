# Results question widget wiring

Inject `ResultsQuestionService` from `src/browser/results-question-service.ts` into `AgentWindowWidget`. Keep the question messages and draft in Results-owned state; do not add them to an `AgentSession`, call `AgentProvider`, or create an execution Task.

On submit, require the selected Task to have status `completed`, `failed`, or `cancelled` and its Results document to be `ready`, then call:

```ts
const changeSetSummary = selectedTask.changeSet?.diff
    || selectedTask.changeSet?.error
    || 'No changes were recorded.';
const resultsHtml = document.html;
const result = await this.resultsQuestionService.ask(question, {
    taskId: selectedTask.id,
    taskMetadata: {
        title: selectedTask.title,
        request: selectedTask.request,
        status: selectedTask.status,
        startedAt: selectedTask.startedAt,
        endedAt: selectedTask.endedAt
    },
    changeSetSummary,
    resultsHtml
});
```

Set a Results-only state to `sending` (質問送信中) before awaiting the call. Map `result.status === 'answered'` to 回答 and render `result.answer`; map `failed` to 失敗 and render `result.error.message` with retry nearby. A `cancelled` result should return the composer to its idle/retryable state. If the UI exposes cancel, call `resultsQuestionService.cancel(selectedTask.id)`.

Only one question per Task may be in flight, and questions are limited to 4,000 characters. The backend truncates Results HTML after 120,000 characters and starts a fresh `codex exec --sandbox read-only` process for every question, so no Agent conversation, draft, execution, or prior Results question state is shared implicitly.
