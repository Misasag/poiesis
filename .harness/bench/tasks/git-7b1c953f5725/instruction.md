# Task

fix(results): finish tasks before requirement documents and polish Results/Skills details

Requirement documents now generate in the background after the task document so completion is not delayed by a second AI call; rename no longer regenerates; split opens inline rename with the text selected; the fixed header keeps at least 45% for the title and wraps its metadata and badges (with a full applied-skills tooltip); AI documents record the provider and model used; the normalizer appends a missing closing html tag instead of rejecting; Customize collapses empty skill scopes into one line; the browser UI smoke waits for virtualized Explorer rows.

Implement the behavior described above in the existing source. Relevant areas:
- agent-window/src/browser/agent-window-widget.tsx
- agent-window/src/browser/results-document-normalizer.ts
- agent-window/src/browser/results-skill.ts
- agent-window/src/browser/style/index.css
- agent-window/src/browser/task-service.ts

Only edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-results-normalizer.mjs

Instruction source: commit-message. Source paths are derived from the diff; no solution code is included.
