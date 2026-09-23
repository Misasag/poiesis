---
name: harness-delegate
description: Delegate separable work to a measured model through the local harness.
metadata:
  poiesis:
    kind: agent
---

Use when the user requests another model, the harness, or delegation, or when a task has clearly separable mechanical parts.

1. Always select the model with `{{HX_COMMAND}} route --project <workspace> --role worker-mech|worker-design --task-class <cls> --explain`. Choose the role that fits the work; never hard-code a model.
2. Write a concise brief with acceptance commands and expected exit codes under `<workspace>/.harness/tmp/`.
3. Run `{{HX_COMMAND}} run --project <workspace> --model <id> --cwd <workspace> --brief <file> --max-usd 0.3 --timeout-min 20`.
4. Run `{{HX_COMMAND}} verify --project <workspace> --run <id> --cwd <workspace> --cmd "<acceptance command>"` for each acceptance command.
5. Run `{{HX_COMMAND}} gate --project <workspace> --worker-run <id>`. If the gate escalates, run `{{HX_COMMAND}} judge --project <workspace> --worker-run <id> --after-gate`.
6. Integrate the verified work or report the failure. State which model did what, every verification exit code, and its cost from the ledger line.

Never raise budget limits. If a run records `infra:"nested_sandbox"`, run `hx route` again and continue with its next eligible model. If quota is exhausted, rerun `hx route` too. For delegation from a Codex agent, enable Settings > AI 「Codex の Agent にネットワークアクセスを許可」. If budget or routing infrastructure still fails, do the work yourself and tell the user why.
