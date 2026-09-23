# Task

feat(results): pass execution evidence to Results and make AI documents resilient

Tasks now own the observed activity log and the applied skill ids per role. Results generation and Results Q&A receive the execution evidence (and Q&A the diff) so documents can separate verified operations from unverified steps. AI documents are normalized (title heading removed, h1 demoted) instead of being discarded, the fixed header shows the generator and applied skills, every document gets the unified scrollbar base style, the generation timeout is 240s with an elapsed indicator, and the activity log hides the duplicated final report.

Implement the behavior described above in the existing source. Relevant areas:
- agent-window/src/browser/agent-activity-parser.ts
- agent-window/src/browser/agent-window-widget.tsx
- agent-window/src/browser/cli-agent-provider.ts
- agent-window/src/browser/results-document-normalizer.ts
- agent-window/src/browser/results-skill.ts
- agent-window/src/browser/style/index.css
- agent-window/src/browser/task-service.ts
- agent-window/src/common/results-generation-protocol.ts
- agent-window/src/common/results-question-protocol.ts
- agent-window/src/node/results-generation-server.ts
- agent-window/src/node/results-question-server.ts

Only edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-agent-activity-parser.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-results-normalizer.mjs

Instruction source: commit-message. Source paths are derived from the diff; no solution code is included.
