# Task

feat(agent-window): effort per model, no Results for no-change tasks, full agent reports, compact Results canvas, live run status

Owner feedback round 11.

- Effort selectable per AI role and remembered per provider+model (claude --effort,
  codex -c model_reasoning_effort, grok --reasoning-effort); settings v5; single
  argv builder node/cli-args.ts shared by the agent runtime and one-shot servers,
  covered by test:cli-args.
- Completed tasks without workspace changes generate no Results document, no
  requirement rail entry and no classification (isNoChangeTask); requirement
  retitles from its first task with changes; smoke:no-change added.
- Agent conversation shows the implementer's final report in full; the completion
  prompt contract, 140-char truncation and the "変更ファイル / Results" footer are
  removed; changed files appear as a diffstat chip next to "Results で確認".
- Results canvas: tighter margins, one-row fixed header with badges merged into
  the meta row (Skills N chip), App-owned base style caps document top padding,
  removes centered max-width columns and first-heading margins.
- Live run status: heartbeat on any CLI output, phases (starting / waiting with
  last-output age / current activity / finalizing), 60s silence warning, pulse
  indicator, collapsed 診断ログ during runs; Codex stdin notice filtered.

Claude-Session: https://claude.ai/code/session_01C46LZvmQMJrq2y7DC7DoF7

Implement the behavior described above in the existing source. Relevant areas:
- agent-window/src/browser/agent-activity-parser.ts
- agent-window/src/browser/agent-window-widget.tsx
- agent-window/src/browser/agent-window/agent-part.tsx
- agent-window/src/browser/agent-window/agent-window-host.ts
- agent-window/src/browser/agent-window/results-part.tsx
- agent-window/src/browser/agent-window/session-store.ts
- agent-window/src/browser/agent-window/settings-part.tsx
- agent-window/src/browser/cli-agent-provider.ts
- agent-window/src/browser/components/elapsed.tsx
- agent-window/src/browser/components/poiesis-select.tsx
- agent-window/src/browser/requirement-classification-service.ts
- agent-window/src/browser/requirement-service.ts
- agent-window/src/browser/results-generation-context.ts
- agent-window/src/browser/results-skill.ts
- agent-window/src/browser/style/agent.css
- agent-window/src/browser/style/components.css
- agent-window/src/browser/style/responsive.css
- agent-window/src/browser/style/results.css
- agent-window/src/browser/task-service.ts
- agent-window/src/common/agent-provider.ts
- agent-window/src/common/agent-runtime-protocol.ts
- agent-window/src/common/requirement-classification-protocol.ts
- agent-window/src/common/results-assertion-protocol.ts
- agent-window/src/common/results-generation-protocol.ts
- agent-window/src/common/results-question-protocol.ts
- agent-window/src/node/agent-runtime-server.ts
- agent-window/src/node/cli-args.ts
- agent-window/src/node/requirement-classification-server.ts
- agent-window/src/node/results-assertion-server.ts
- agent-window/src/node/results-generation-server.ts
- agent-window/src/node/results-question-server.ts

Only edit source files under agent-window/src/. You may read and run tests. Do not edit tests, helpers, manifests, configuration or dependencies. Do not commit or inspect external repositories, benchmark metadata or solution history. Acceptance runs these commands (expected exit 0):
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-agent-activity-parser.mjs
- npm run compile --workspace=@poiesis/theia-agent-window
- node scripts/test-cli-args.mjs

Instruction source: commit-message. Source paths are derived from the diff; no solution code is included.
