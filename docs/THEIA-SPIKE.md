# Poiesis Theia application

This repository contains the current Poiesis first-completion implementation on Eclipse Theia.

The product contract is defined by:

- `FIRST-COMPLETION.md`
- `UX.md`
- `ARCHITECTURE.md`
- `ui/agent-window-spec.html`
- `IMPLEMENTATION-STATUS.md`

## Current structure

- Poiesis owns the outer window and the Agent / Results / Code navigation.
- Agent uses the exchangeable `AgentProvider` boundary. The default provider runs a detected Codex CLI and falls back to the honest chat-only `MockAgentProvider` when Codex is unavailable.
- `TaskService` owns Task start, completion, failure, cancellation, the pre-run Workspace snapshot, and the resulting Change Set.
- `ResultsService` starts one bundled `ResultsSkill` after a Task reaches a terminal state. The skill returns one complete HTML document; partial HTML is not streamed into the canvas.
- Results is user-opened and does not steal focus when a Task ends.
- Code mounts Theia's Files, Search, Git, Editor, and Terminal widgets into Poiesis-owned Cursor-style chrome. It does not attach the full Theia `ApplicationShell`.

The old `ChangesWidget` source and the older Spike Reports are retained only as historical technical experiments. They are not registered in the current product navigation.

## Known first-completion gaps

- Results questions do not yet have a scoped answer service.
- Session, Task, and Result state is not yet restored after restart.
- Only Codex has an execution adapter; Claude is detected but is not selected as an implementer.
- The current Electron shell still needs a fresh end-to-end verification.

See `IMPLEMENTATION-STATUS.md` for the maintained status matrix.

## Prerequisites

- Windows 10 or 11
- Node.js 20–24
- npm 10 or newer
- Git CLI
- Optional: an authenticated Codex CLI installation

## Install and build

```powershell
cd C:\path\to\poiesis
$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm install
npm run download:plugins
npm run build
```

## Validate

```powershell
npm run validate:source
npm run compile --workspace=@poiesis/theia-agent-window
```

To run the browser UI smoke, start the application in one terminal and run the smoke in another:

```powershell
npm start
npm run smoke:ui
```

## Run

Browser target:

```powershell
npm start
```

To keep the browser server running after the launching terminal or automation session ends:

```powershell
npm run start:background
# Stop it later with:
npm run stop:background
```

Background startup writes its PID and server log under the ignored `.run/` directory.

Electron target:

```powershell
npm run build:electron
npm run start:electron
```

## Source layout

- `agent-window/src/common/`: provider and backend protocol boundaries
- `agent-window/src/browser/`: Poiesis window, Agent / Results / Code UI, Task and Results services
- `agent-window/src/node/`: CLI detection and execution, Workspace snapshot and Change Set capture
- `browser-app/`: browser target
- `electron-app/`: Electron target
- `scripts/validate-source.mjs`: source contract checks
- `scripts/smoke-ui.mjs`: current Agent / Results / Code browser smoke
