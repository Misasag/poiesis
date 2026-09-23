# Task

feat(requirements): classify finished tasks into new requirements only with high confidence

After a task's Results document is stored, a conservative classifier decides whether the task continues the current requirement: explicit pill choices and first tasks are never classified, file overlap or references to earlier work keep the task in place, and only an AI verdict of new with confidence at least 0.8 splits it into a new requirement with a short suggested title. The Agent conversation and the Results rail show the split with a one-click undo that survives reloads, and a default-on setting controls the feature.

Implement the behavior described above in the existing source. Relevant areas:
- agent-window/src/browser/agent-window-frontend-module.ts
- agent-window/src/browser/agent-window-widget.tsx
- agent-window/src/browser/cli-agent-provider.ts
- agent-window/src/browser/requirement-classification-service.ts
- agent-window/src/browser/requirement-classifier.ts
- agent-window/src/browser/results-skill.ts
- agent-window/src/browser/style/index.css
- agent-window/src/browser/task-service.ts
- agent-window/src/common/agent-provider.ts
- agent-window/src/common/requirement-classification-protocol.ts
- agent-window/src/node/agent-window-backend-module.ts
- agent-window/src/node/requirement-classification-server.ts

Only edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-requirement-classifier.mjs

Instruction source: commit-message. Source paths are derived from the diff; no solution code is included.
