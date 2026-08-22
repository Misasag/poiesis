# Lens Theia technical spike

This directory contains the focused Eclipse Theia spike for Lens. The current implementation is the first, narrow August 2026 slice: a live `AgentProvider`-driven chat, application-owned execution Tasks, Windows CLI detection, and a separate Results frame. The existing Changes widget remains available, but it is not the Results implementation.

## Implemented in this slice

- `AgentProvider` is the UI boundary from `docs/ARCHITECTURE.md`. The widget imports that interface and the frontend composition binds it to `MockAgentProvider`.
- `CliDetector` checks `PATH` and well-known Windows locations for Codex and Claude. The Agent header reports each CLI as found or missing and shows the detected name. Detection never launches either CLI.
- `MockAgentProvider` creates one execution Task per sent message, streams a short reply, supports cancellation, and never reads or writes workspace files.
- `TaskService` owns start, end, cancel, a baseline placeholder, and a captured change set. The backend uses a read-only real `git diff` when possible and otherwise records an empty change set.
- One `BundledResultsSkill` runs only after a Task ends or is cancelled. It returns one complete HTML document; generation does not stream document fragments.
- Lens owns the outer window and its Agent / Results tabs. They are not Theia dock tabs. Results contains a finished-Task switcher, one iframe canvas that hosts the complete skill document, and its own short composer. Task completion does not select Results or steal focus.
- Code mode mounts the Theia application shell inside the Lens window, retaining Theia's Editor, Files, Git, settings, and editor file tabs without creating an `Agent Window` tab.
- The pre-existing IDE Changes widget can still open code and semantic mock representations. It is separate from Results.

This slice intentionally has no real agent execution, marketplace, agent-wiring settings screen, or full Code-mode chrome.

## Prerequisites

- Windows 10 or 11
- Node.js 24.5.0
- npm 11.11.0
- Git CLI for change-set capture and the existing Changes demonstrations

## Install

From PowerShell:

```powershell
cd C:\Users\owner\github\lens\spikes\theia
$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm install
npm run download:plugins
```

Puppeteer is a Theia CLI dependency, but this browser application does not need Puppeteer to build or start. Skipping its browser download keeps installation smaller.

## Validate

The source contract validator covers the provider boundary, detector, TaskService, bundled skill, backend bridge, and Agent / Results separation:

```powershell
npm run validate:source
```

For a targeted extension typecheck without a full Theia bundle:

```powershell
npm run compile --workspace=@lens/theia-agent-window
```

A full browser application build remains available when needed:

```powershell
npm run build
```

## Try the slice

Start the browser target:

```powershell
npm start
```

Then open `http://127.0.0.1:3000` manually. The spike opens `spikes/theia` as its workspace.

1. In the Agent header, confirm Codex and Claude each report `found` or `missing`. Even when one is found, the header also says `MockAgentProvider active for this slice`.
2. Type a request in the Agent composer and send it. The reply arrives in several short chunks while one Task is running.
3. Let the Task finish, or use Cancel while it is running. The Agent tab remains selected.
4. Select Results yourself. Choose the finished or cancelled Task in the switcher and inspect the bundled HTML document in the single canvas.
5. Type into the Results composer. It stays scoped to Results and does not start a Task or post into Agent chat.
6. If desired, open `IDE Changes` from the status bar or command palette to confirm the older Changes spike still works independently.

## Other targets

The Electron target uses the same extension composition:

```powershell
npm run build:electron
npm run start:electron
```

Existing optional UI and Electron smoke scripts remain under `scripts/`, but they are outside this source-only slice and require a local browser or Electron session.

## Layout

- `agent-window/src/common/`: `AgentProvider` and backend runtime protocol
- `agent-window/src/browser/`: Agent / Results widget, `MockAgentProvider`, `TaskService`, bundled Results skill, and Changes widget
- `agent-window/src/node/`: Windows `CliDetector`, read-only Git diff capture, and backend RPC binding
- `browser-app/`: browser target
- `electron-app/`: Electron target
- `scripts/validate-source.mjs`: focused source contract validation
- `sample-src/`: existing Changes mock and evidence-navigation fixture
