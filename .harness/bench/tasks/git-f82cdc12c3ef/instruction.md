# Task

feat(skills): accept agent Skill proposals through an approval gate

The implementer may write new or updated Skill proposals only to the quarantined .poiesis/pending/skills folder; the app records them per task, shows them in Customize as 新規提案 or 更新提案 with a line diff against the active skill, and applies them only on explicit approval (or deletes on rejection). Completion reports link to the proposals. The requirement pill lists 新しい要件として送信 first, and legacy long requirement titles are shortened once.

Implement the behavior described above in the existing source. Relevant areas:
- agent-window/src/browser/agent-window-widget.tsx
- agent-window/src/browser/cli-agent-provider.ts
- agent-window/src/browser/requirement-model.ts
- agent-window/src/browser/requirement-service.ts
- agent-window/src/browser/requirement-title-migration.ts
- agent-window/src/browser/results-skill.ts
- agent-window/src/browser/style/index.css
- agent-window/src/browser/task-service.ts
- agent-window/src/browser/text-diff.ts
- agent-window/src/browser/workspace-skill-service.ts

Only edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-requirement-model.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-text-diff.mjs

Instruction source: commit-message. Source paths are derived from the diff; no solution code is included.
