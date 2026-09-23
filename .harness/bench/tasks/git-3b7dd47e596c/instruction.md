# Task

feat(results): verify Results Skill assertions, suggest short requirement titles, calm preview cards

Results skills can declare assertions in their frontmatter; every AI document is checked by deterministic app rules (citations, headings) plus one read-only AI judge, regenerated at most once with the failed conditions appended, and the fixed header shows a Skill 条件 pass badge with details. After a requirement's first task completes, a short Japanese title is suggested by the Results AI (heuristic fallback, never overriding user renames). Inline HTML preview cards expand only for the latest agent message.

Implement the behavior described above in the existing source. Relevant areas:
- agent-window/src/browser/agent-window-frontend-module.ts
- agent-window/src/browser/agent-window-widget.tsx
- agent-window/src/browser/requirement-classification-service.ts
- agent-window/src/browser/requirement-classifier.ts
- agent-window/src/browser/requirement-model.ts
- agent-window/src/browser/requirement-service.ts
- agent-window/src/browser/results-assertions.ts
- agent-window/src/browser/results-skill.ts
- agent-window/src/browser/skill-document.ts
- agent-window/src/browser/style/index.css
- agent-window/src/browser/task-service.ts
- agent-window/src/browser/workspace-skill-service.ts
- agent-window/src/common/requirement-classification-protocol.ts
- agent-window/src/common/results-assertion-protocol.ts
- agent-window/src/common/results-generation-protocol.ts
- agent-window/src/node/agent-window-backend-module.ts
- agent-window/src/node/requirement-classification-server.ts
- agent-window/src/node/results-assertion-server.ts
- agent-window/src/node/results-generation-server.ts

Only edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-requirement-classifier.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-requirement-model.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-results-assertions.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-skill-document.mjs

Instruction source: commit-message. Source paths are derived from the diff; no solution code is included.
