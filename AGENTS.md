# Poiesis repository conventions

## Scope and ownership
- Do not commit. Leave reviewable changes and report every acceptance command with its exit code.
- Respect the ticket's allowed paths and concurrent lanes. Do not overwrite another lane's changes.
- Implement directly when assigned as the terminal worker; do not recursively delegate implementation.
- Read the current code before assuming a selector, protocol, or file format.

## Code map
- `agent-window/src/browser/`: Poiesis UI, task/session state, Results, model picker.
- `agent-window/src/common/`: shared protocols, normalization, persistence contracts.
- `agent-window/src/node/`: CLI processes, storage, snapshots, backend services.
- `browser-app/` and `electron-app/`: Theia application composition and desktop packaging.
- `scripts/test-*.mjs`: deterministic regression checks; `scripts/smoke-*.mjs`: UI checks.

## Commands (from the root package.json)
- `npm run validate:source`: source contract pins and integration invariants.
- `npm run build`: compile the extension and build the browser app.
- `npm run build:electron`: compile the extension and build the desktop app.
- `npm run test:composer`
- `npm run test:agent-activity`
- `npm run test:cli-args`
- `npm run test:model-discovery`
- `npm run test:model-selection`
- `npm run test:hidden-process-env`
- `npm run test:cli-detection`
- `npm run test:results-normalizer`
- `npm run test:results-assertions`
- `npm run test:results-prompt-transport`
- `npm run test:requirements`
- `npm run test:requirement-classifier`
- `npm run test:snapshot-store`
- `npm run test:snapshot-cancellation`
- `npm run test:outcome-semantics`
- `npm run test:conversation-transport`
- `npm run test:session-durability`
- `npm run test:durable-storage`
- `npm run test:results-generation-events`
- `npm run test:deferred-results-completion`
- `npm run test:session-restore-background-results`
- `npm run test:skill-document`
- `npm run test:customize-editor`
- `npm run smoke:electron`: desktop smoke; requires built output.
- `npm run smoke:composer`, `npm run smoke:task-feedback`, `npm run smoke:no-change`: focused desktop scenarios.
- `npm run smoke:ui`, `npm run smoke:results-document`, `npm run smoke:results-continuity`: UI/Results checks.
- `npm run smoke:installed`: installed-app check; use only when that target is authorized.
- Read package.json for other smoke commands; some smokes build or touch runtime fixtures.

## Source validation pins
- `scripts/validate-source.mjs` intentionally pins source fragments, labels, and selectors.
- When an authorized behavior change replaces a pinned contract, update the matching pin and behavioral test together.
- Do not weaken or delete a pin solely to obtain a green check. Explain the intentional contract change.

## Owner UI rules
- Use Japanese user-facing UI text. Do not use emoji.
- Never expose internal operation names, table/column names, IDs, JSON keys, or implementation jargon as UI copy, including Admin screens.
- Controls must perform the stated action. Do not ship dead buttons, fake state, or misleading progress.
- Use the established custom selects/model pickers rather than native select controls.
- Express status with text and numbers as well as color. Preserve existing keyboard and focus behavior.

## Windows and subprocesses
- Windows 11, Smart App Control ON: never disable it.
- Use `spawn` with `shell:false` and `windowsHide:true`. Resolve `.cmd` shims to the real executable/JS entry point.
- Codex: Node + `%APPDATA%/npm/node_modules/@openai/codex/bin/codex.js`.
- Claude: the native `claude.exe`; Grok: `%USERPROFILE%/.grok/bin/grok.exe`.
- Use Node + npm-cli.js for npm acceptance commands; never use `cmd.exe /d /s /c`.
- Keep npm caches outside worker workspaces. Use explicit UTF-8 file I/O and BOM-aware reads.
- Resolve environment secrets only at spawn time. Redact secret values and secret-named fields from artifacts and logs.
- Resume only an explicitly recorded session ID; never use implicit latest/continue flags.
- Stop only PIDs started by this run. Never kill installed apps by image name.

## Evidence and evaluation
- Verify first. A failing acceptance command overrides a favorable model judgment.
- Report what was executed, exit codes, unresolved limitations, and measured evidence; do not infer a pass from prose.
