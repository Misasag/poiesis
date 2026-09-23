---
name: improve
description: Propose and evaluate Poiesis harness improvements against a frozen evaluator; use for "improve harness", "ハーネスを改善", "プロンプトを最適化", or "自己改善".
---

Use Claude as the proposer. Read raw `.harness/runs/*/events.jsonl`, briefs, finals, diffs, and the ledger; do not optimize from a score summary alone.
State one concrete observed failure and a falsifiable hypothesis before editing.

Allow candidate changes ONLY to:
- Skills text in tools/harness/harness/skills/.
- Brief templates embedded in those skills.
- policy.json lambdas/challengers (preserve all other policy fields).
- AGENTS.md.

Forbid changes to the frozen evaluator:
- config/rubric-judge.md.
- Bench task definitions, hidden tests, and suite membership during evaluation.
- Budget limits.
- bin/lib/judge.mjs and bin/lib/budget.mjs.

Create an isolated candidate checkout. Hash every frozen file before and after the experiment; reject any mismatch. Keep evaluation outputs in the ledger and raw run directories.
Pin the same catalog IDs, effort, task IDs, repetitions, and routing choices for baseline and candidate. Do not expose holdout tasks to the proposer.
Evaluate in stages with `hx bench run`: smoke (3 tasks) -> val -> full regression.
Stop on smoke failure, exhausted budget, or evaluator drift. Never edit tests to help a candidate pass.
Adopt only if val pass rate improves, full regression is non-inferior within the predeclared margin, and median measured cost grows by at most 10%.
For quota models with unknown USD cost, compare token usage and wall time separately; do not claim that the USD gate was measured. Obtain measured prices or retain the candidate as unadopted.
Record hypothesis, allowed diff, frozen hashes, pinned models, suites, run IDs, baseline/candidate metrics, and adopt/reject decision in `.harness/improvements.md`.
Integrate only after this evidence is complete. Preserve the no-commit instruction.
Escalate evaluator changes, provider/data policy, budget overrun, and release/push to the owner. Do not add other approval gates to routine reversible work.
