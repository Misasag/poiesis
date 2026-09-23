---
name: orchestrate
description: Run the Poiesis development loop from findings to verified fixes; use for "orchestrate", "開発を進めて", "不具合を直して", or "ハーネスで進めて".
---

Run commands from the repository root with `node tools/harness/harness/bin/hx.mjs` (abbreviated `hx`).
Keep Claude Code as the orchestrator; delegate implementation through measured CLI runs.

1. Read `AGENTS.md`, `hx status`, and the current ticket. Start from owner feedback or `hx dogfood` findings.
2. Write one ticket in `.harness/tickets/<id>.md`: problem, scope, task class, allowed paths, `/goal` acceptance commands and expected exit 0. Preserve existing authorization.
3. Call `hx route --role worker-mech|worker-design --task-class <class> --ticket <id> --explain`. Use worker-design when design choices remain.
4. Write a file brief. For GPT, state principles and a concise goal; for Claude, use an explicit checklist. Include absolute paths, commands, expected exits, no-commit and terminal-worker boundaries.
5. Create an isolated git worktree; inspect the output of `git worktree list`. Do not share a writable checkout between workers. Record its starting SHA.
6. Call `hx run --model <id> --effort <effort> --cwd <worktree> --brief <file> --role <routed-role> --task-class <class> --ticket <id>`.
7. Call `hx verify --cwd <worktree> --run <run-id> --cmd "<acceptance>"` for each acceptance command.
8. Select a reviewer with `hx route --role reviewer --exclude-family <worker-family> --task-class <class>`. Run the review read-only, and call `hx judge --worker-run <run-id>` where needed. Never waive a failing verification result.
9. Send concrete failures to `hx run --resume <run-id>` with the same model/cwd and a new brief. Each invocation produces a new run ID. Allow at most two fixes before escalating worker-mech -> worker-design -> Claude. Preserve the latest session ID, not an implicit latest session.
10. Review scope and integrate the accepted diff in the orchestrator lane. Leave integration uncommitted while the no-commit instruction applies. Record `hx outcome --run <id> --result pass|fail|human --note "<evidence>"`.
11. Turn every fixed finding into a regression-bench task candidate. Validate fail-to-pass before adding it to a suite. Remove your worktree in a finally-style cleanup.

Human gates: new provider/data policy, evaluator changes, budget overruns, and release/push. Do not ask again for already authorized work. Keep the frozen evaluator outside all proposed self-improvement diffs.
