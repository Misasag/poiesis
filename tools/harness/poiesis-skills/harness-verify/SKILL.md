---
name: harness-verify
description: Record acceptance command exits and request a quick second opinion.
metadata:
  poiesis:
    kind: agent
---

Run each task acceptance command through `{{HX_COMMAND}} verify --project <workspace> --cwd <workspace> --cmd "<command>"` so its exit code is recorded. Use repeated `--cmd` for multiple checks.

First run `{{HX_COMMAND}} h status --project <workspace> --json`. If a ticket is active, defer to `harness-core`: run `h check` for its criteria and use `h scope` before reporting. Standalone `verify` does not establish a ticket criterion's current evidence.

When the user asks for a second opinion on your own diff, run `{{HX_COMMAND}} gate --project <workspace> --worker-run <id>` after verification. If no eligible worker run exists, report that the gate cannot evaluate it. Never claim a pass without a recorded exit code.
