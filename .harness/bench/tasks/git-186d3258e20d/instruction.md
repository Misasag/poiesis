# Task

Discover CLI models and redesign model selection

Load Codex and Grok model catalogs from their CLIs, retain custom selections, and validate model-specific effort settings before execution.

Replace the model selector with a searchable picker shared by Agent and Results, and improve keyboard navigation, positioning, and AI settings.

Implement the behavior described above in the existing source. Relevant areas:
- agent-window/src/browser/agent-window-widget.tsx
- agent-window/src/browser/agent-window/agent-window-host.ts
- agent-window/src/browser/agent-window/settings-part.tsx
- agent-window/src/browser/components/model-picker.tsx
- agent-window/src/browser/components/poiesis-select.tsx
- agent-window/src/browser/model-picker-state.ts
- agent-window/src/browser/style/agent.css
- agent-window/src/browser/style/components.css
- agent-window/src/browser/style/results.css
- agent-window/src/browser/style/settings.css
- agent-window/src/common/agent-runtime-protocol.ts
- agent-window/src/common/cli-detection-lifecycle.ts
- agent-window/src/electron-browser/window-controls.css
- agent-window/src/node/agent-runtime-server.ts
- agent-window/src/node/agent-window-backend-module.ts
- agent-window/src/node/cli-model-discovery.ts
- agent-window/src/node/cli-provider-registry.ts
- agent-window/src/node/hidden-process.ts
- agent-window/src/node/known-cli-registry.ts
- agent-window/src/node/requirement-classification-server.ts
- agent-window/src/node/results-assertion-server.ts
- agent-window/src/node/results-generation-server.ts
- agent-window/src/node/results-question-server.ts

Only edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-cli-detection-lifecycle.mjs
- node scripts/test-agent-send-detection.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-cli-args.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-model-discovery.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-model-selection.mjs

Instruction source: commit-message. Source paths are derived from the diff; no solution code is included.
