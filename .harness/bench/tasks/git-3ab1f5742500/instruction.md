# Task

Bound snapshot capture and preserve cancellation evidence

Bound and isolate workspace snapshots, stop capture process trees on cancellation,
and preserve changes made before Agent cancellation. Keep unavailable change
records distinct from verified empty results and report preparation progress.

Add regression coverage for capture limits, cleanup, cancellation races, and
durable error propagation.

Implement the behavior described above in the existing source. Relevant areas:
- agent-window/src/browser/agent-window/results-part.tsx
- agent-window/src/browser/agent-window/session-store.ts
- agent-window/src/browser/cli-agent-provider.ts
- agent-window/src/browser/components/elapsed.tsx
- agent-window/src/browser/results-skill.ts
- agent-window/src/browser/style/results.css
- agent-window/src/browser/task-service.ts
- agent-window/src/common/agent-provider.ts
- agent-window/src/common/agent-runtime-protocol.ts
- agent-window/src/node/agent-runtime-server.ts
- agent-window/src/node/hidden-process.ts
- agent-window/src/node/snapshot-store.ts

Only edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-deferred-results-completion.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-session-durability.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-snapshot-cancellation.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-snapshot-store.mjs

Instruction source: commit-message. Source paths are derived from the diff; no solution code is included.
