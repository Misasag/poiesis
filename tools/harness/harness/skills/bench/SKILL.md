---
name: bench
description: Mine and run validated regression tasks and inspect measured routing; use for "benchmark", "ベンチを回して", "回帰課題を採掘", or "モデルを比較".
---

Use `node tools/harness/harness/bin/hx.mjs` as `hx`.
Run `hx bench mine --limit 5` or add `--since <sha>`.
Keep only tasks whose hidden test patch fails at the parent and passes after the source patch.
Read every rejection reason. Do not call a task validated when dependencies, commands, or tests are missing.
Do not weaken the package-lock equality check to obtain more tasks.
Worktrees use detached heads and a junction to the main checkout's node_modules only with identical lockfiles. Cleanup runs even after errors.
Review commit-message instructions; remove accidental answer leakage before freezing a suite.

Put one task ID per line in `.harness/bench/suites/<name>.txt`; use disjoint smoke, val, and regression selections.
Run `hx budget status`, then explicitly pin models:
```text
hx bench run --suite smoke --models codex:gpt-6-luna,grok:default --repeats 1 --judge none
hx bench run --tasks <a>,<b> --models <id> --repeats 1 --judge auto
```
Each worker starts without hidden tests. The evaluator restores and applies hidden tests after execution, records verification and outcome, then removes the worktree.
The budget is checked before each run. Do not launch extra real runs merely to fill a scoreboard.
Read `hx scoreboard --write`; human outcomes are excluded from the pass/fail posterior.
Use `hx tune` to preview task-class-specific promotions, and `hx tune --apply` only after reviewing the evidence.
Keep quota usage distinct from metered USD; null prices do not mean free API calls.
