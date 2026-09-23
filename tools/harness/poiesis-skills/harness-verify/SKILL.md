---
name: harness-verify
description: Record acceptance command exits and request a quick second opinion.
metadata:
  poiesis:
    kind: agent
---

Run each task acceptance command through `{{HX_COMMAND}} verify --project <workspace> --cwd <workspace> --cmd "<command>"` so its exit code is recorded. Use repeated `--cmd` for multiple checks.

When the user asks for a second opinion on your own diff, run `{{HX_COMMAND}} gate --project <workspace> --worker-run <id>` after verification. If no eligible worker run exists, report that the gate cannot evaluate it. Never claim a pass without a recorded exit code.
