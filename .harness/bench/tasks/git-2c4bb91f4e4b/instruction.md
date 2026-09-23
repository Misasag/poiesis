# Task

feat: group task results by durable requirements

Tasks now belong to an App-owned Requirement chosen from a composer pill (continue current, pick, or start new). The Results rail lists requirements with expandable task history, rename, move-to-requirement and split actions; each multi-task requirement gets a cumulative document and requirement-scoped Q&A built from a range diff over durable snapshots stored as tree objects in a per-workspace shadow git repository, which also makes non-git workspaces work (codex gets --skip-git-repo-check only there). Legacy tasks migrate to one requirement each.

Implement the behavior described above in the existing source. Relevant areas:
- agent-window/src/browser/agent-window-frontend-module.ts
- agent-window/src/browser/agent-window-widget.tsx
- agent-window/src/browser/cli-agent-provider.ts
- agent-window/src/browser/requirement-model.ts
- agent-window/src/browser/requirement-service.ts
- agent-window/src/browser/results-skill.ts
- agent-window/src/browser/style/index.css
- agent-window/src/browser/task-service.ts
- agent-window/src/common/agent-provider.ts
- agent-window/src/common/agent-runtime-protocol.ts
- agent-window/src/common/results-generation-protocol.ts
- agent-window/src/common/results-question-protocol.ts
- agent-window/src/electron-main/poiesis-updater-main-module.ts
- agent-window/src/node/agent-runtime-server.ts
- agent-window/src/node/results-generation-server.ts
- agent-window/src/node/results-question-server.ts
- agent-window/src/node/snapshot-store.ts

Only edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-requirement-model.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-snapshot-store.mjs

Instruction source: commit-message. Source paths are derived from the diff; no solution code is included.
