---
name: orchestrate
description: Run the Poiesis development loop from findings to verified fixes; use for "orchestrate", "開発を進めて", "不具合を直して", or "ハーネスで進めて".
---

Run commands from the repository root with `node tools/harness/harness/bin/hx.mjs` (abbreviated `hx`).
Keep Claude Code as the orchestrator. Every worker lane, including retries and quota fallbacks, must go through `hx run`; never use ad-hoc worker scripts or direct CLI launches. Otherwise ledger and budget accounting miss the spend.

1. Read `AGENTS.md`, `hx status`, and the current ticket. Start from owner feedback or `hx dogfood` findings.
2. Write one ticket in `.harness/tickets/<id>.md`: problem, scope, task class, allowed paths, `/goal` acceptance commands and expected exit 0. Preserve existing authorization.
3. Call `hx route --role worker-mech|worker-design --task-class <class> --ticket <id> --explain`. Use worker-design when design choices remain.
4. Write a file brief. For GPT, state principles and a concise goal; for Claude, use an explicit checklist. Include absolute paths, commands, expected exits, no-commit and terminal-worker boundaries.
5. Create an isolated git worktree; inspect the output of `git worktree list`. Do not share a writable checkout between workers. Record its starting SHA.
6. Call `hx run --model <id> --effort <effort> --cwd <worktree> --brief <file> --role <routed-role> --task-class <class> --ticket <id>`. For big lanes, explicitly set `--max-usd <cap>` and `--timeout-min <minutes>` within the authorized limits.
7. Call `hx verify --cwd <worktree> --run <run-id> --cmd "<acceptance>"` for each acceptance command.
8. Call `hx gate --worker-run <run-id>` (Jev via OpenRouter), then `hx judge --worker-run <run-id> --after-gate --judge auto`. A decisive gate skips the LLM; escalate invokes the best-scoring allowed family. Reviewers and judges must differ from every candidate. Never waive failing verification.
9. Send concrete failures to `hx run --resume <run-id>` with the same model/cwd and a new brief. Each invocation produces a new run ID. Allow at most two fixes before escalating worker-mech -> worker-design -> Claude. Preserve the latest session ID, not an implicit latest session.
10. Review scope and integrate the accepted diff in the orchestrator lane. Leave integration uncommitted while the no-commit instruction applies. Record `hx outcome --run <id> --result pass|fail|human --note "<evidence>"`.
11. Turn every fixed finding into a regression-bench task candidate. Validate fail-to-pass before adding it to a suite. Remove your worktree in a finally-style cleanup.

Human gates: new provider/data policy, evaluator changes, budget overruns, and release/push. Do not ask again for already authorized work. Keep the frozen evaluator outside all proposed self-improvement diffs.

When quota is exhausted, call `hx route` again and use the next eligible candidate through `hx run`, carrying the current diff and a short handoff. An enabled catalog route can continue from Codex to gpt-6-sol via pi/OpenRouter; the owner measured completion of a half-done app round for USD 2.84 on 2026-09-23. This is one observation, not a price guarantee or permission to exceed caps. Do not invent a model ID if the route is not enabled.
Claude verifies command exit codes and short worker reports, then inspects the relevant diff and independent verdict. Keep reports compact to conserve Claude quota; a favorable narrative never overrides a failed check.

OpenRouter workers use the pinned `or:` catalog through pi, effort `default` or a supported thinking level. Keys resolve at invocation from process environment then Windows user environment; never copy them into briefs or logs. The public MIT repository permits catalog `may-train` entries; `data_policy.allow_may_train=false` excludes them. Call `hx budget status` before metered work: caps are 30/month, 5/day and 1/run; quota caps are unset. Monthly spend uses the greater of ledger and OpenRouter monthly usage, and available OpenRouter credit is a hard ceiling. Network failure explicitly falls back to the ledger.
Routing 404s with `routing_funnel` are `infra: routing_config`, not model failures. Check the reported failing step, `config/pi-agent/models.json` and OpenRouter privacy settings; do not weaken privacy policy merely to make a route pass.
Read `cost_usd_actual` with generation coverage, not Claude's cost estimate. Partial stats retain a token estimate for budgeting. Gate costs count too. Only explicit outcomes train routing; a gate is not permission to mark a ticket confirmed.
