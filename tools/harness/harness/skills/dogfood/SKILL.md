---
name: dogfood
description: Exercise built Poiesis with an isolated workspace and CDP evidence; use for "dogfood", "ドッグフード", "実アプリを試して", or "操作して不具合を探して".
---

Run `node tools/harness/harness/bin/hx.mjs dogfood --model codex:gpt-6-luna --prompt-file <file>`.
Require existing build:electron output in the main checkout; this command never builds.
Use `--workspace <source-repo>` to clone a different local fixture. Never drive the source workspace in place.
The runner clones pomodoro-web by default, copies .poiesis, isolates user data/config/snapshots, selects the composer model, waits for the rail and Results, records screenshots and persisted session facts, then kills only its own PID tree.

Read `.harness/dogfood/<timestamp>/report.json` and `report.md`.
Turn each observed failure into a finding containing: action, expected/actual behavior, screenshot, console evidence, task/Results timings, and persisted activity/assertion/generatedAt facts.
Distinguish missing evidence from zero counts. Do not call a timed-out or failed task successful.
Create a ticket with a deterministic `/goal`; nominate a regression bench task after the fix.

For manual CDP inspection of a deliberately launched harness instance:
```text
node scripts/dev/drive-installed.mjs text --port <p>
node scripts/dev/drive-installed.mjs list ".poiesis-agent-window__session-row" --port <p>
node scripts/dev/drive-installed.mjs click "#poiesis-results-tab" --port <p>
node scripts/dev/drive-installed.mjs shot <output.png> --port <p>
```
Use only the port recorded for your isolated instance. Do not use this driver's launch/stop commands: its stop uses an image-wide kill and its launch targets the installed application.
For interactive timing exploration, record actions alongside evidence rather than changing app internals through page.evaluate.
