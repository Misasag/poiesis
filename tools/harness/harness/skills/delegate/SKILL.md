---
name: delegate
description: Delegate one Poiesis ticket through hx with measured verification; use for "delegate", "実装を委任", "Codexに実装", or "Grokに実装".
---

Use `node tools/harness/harness/bin/hx.mjs` as `hx` below.
Read the ticket and AGENTS.md. Resolve code-derived questions yourself before briefing.
Call `hx route --role worker-mech|worker-design --task-class <class> --ticket <id> --explain`.
Create one isolated worktree and record its base SHA. Never reuse another lane's checkout.

Embed this brief template in a UTF-8 file:

```text
Ticket: <id and absolute ticket path>
Workspace: <absolute worktree path>, base <sha>
Goal: <observable behavior and reason>
Principles: preserve existing contracts; keep changes inside <allowed paths>.
Read: <specific evidence paths>
Acceptance (/goal):
- <exact command>; expected exit 0
Deliver: implementation, verification command/exits, remaining risks.
You are the terminal worker. Implement directly; do not re-delegate.
Do not commit. Preserve other lanes' changes. Report all exit codes.
```

For GPT, keep the goal/principles prominent and omit micromanaged steps.
For Claude, turn required behavior and acceptance into a concrete checklist.
For Grok, remove design ambiguity and give exact files, edits, and commands.

Run `hx run --model <id> --effort <effort> --cwd <worktree> --brief <file> --role <routed-role> --task-class <class> --ticket <id>`.
Read the returned run ID and `.harness/runs/<id>/final.md`, diff, and events.
Run `hx verify --cwd <worktree> --run <id> --cmd "<command>"` before judging.
Call `hx gate --worker-run <id>`, then `hx judge --worker-run <id> --after-gate --judge auto`; an uncertain gate escalates to a different family.
On failure, write a correction brief and call the same `hx run` with `--resume <id>`.
Limit fixes to two, then return evidence for tier escalation. Do not recurse or use `--last`.
Record the final accepted outcome with `hx outcome`; leave integration/merge to the orchestrator.

For OpenRouter choose an enabled `or:` ID from the catalog and effort `default` (or a pi `--thinking` level for reasoning-heavy work).
Adapter rule: OpenAI models run through Codex on the ChatGPT quota; Anthropic models run through Claude on the Anthropic quota; everything else runs as `or:*` through pi via OpenRouter. The `orc:*` anthropic-compat path is for A/B comparison only, never production.
OpenRouter workers run in an isolated harness-managed workspace; pi has no permission system, so never point it at owner checkouts. Provider pinning and runtime isolation come from the committed pi-agent template.
Call `hx budget status` before spending; USD caps are 30/month, 5/day and 1/run. Credentials resolve from process environment then HKCU\\Environment without being persisted. Never put their values in a brief.
Inspect `cost_usd_actual`, `cost_usd_est`, and `generation_stats.coverage`; incomplete stats are unknown actual cost, not zero. Never use Claude `total_cost_usd` for OpenRouter. pi's `usage.cost.total` is a catalog estimate recorded as `pi_cost_estimate_usd`, not accounting. Catalog data notes identify models tagged `may-train`; routing and explicit worker runs obey the repository data policy.
If a run fails with a usage-limit message or OpenRouter HTTP 402/429, it is infrastructure, not a model failure: the ledger marks `infra:"quota_exhausted"`, `hx route` skips the exhausted family, and bench cells become `skipped_quota`. Check `hx status` for reset times.
