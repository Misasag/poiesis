# Task

fix(agent-window): stabilize CLI detection and compact Results headers

Preserve chat and draft ownership while waiting for CLI and model detection, prevent duplicate or removed-chat sends, and distinguish pending detection from failures. Add Grok medium effort and responsive Results headers with regression and UI coverage.

Implement the behavior described above in the existing source. Relevant areas:
- agent-window/src/browser/agent-window-widget.tsx
- agent-window/src/browser/agent-window/agent-part.tsx
- agent-window/src/browser/agent-window/agent-window-host.ts
- agent-window/src/browser/agent-window/results-part.tsx
- agent-window/src/browser/agent-window/settings-part.tsx
- agent-window/src/browser/style/responsive.css
- agent-window/src/browser/style/results.css
- agent-window/src/browser/style/settings.css
- agent-window/src/common/agent-runtime-protocol.ts
- agent-window/src/common/cli-detection-lifecycle.ts
- agent-window/src/node/cli-detector.ts

Only edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-cli-detection-lifecycle.mjs
- node scripts/test-agent-send-detection.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-cli-args.mjs

Instruction source: commit-message. Source paths are derived from the diff; no solution code is included.
