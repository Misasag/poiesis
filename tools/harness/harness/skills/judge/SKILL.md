---
name: judge
description: Independently grade measured Poiesis patches or compare candidates; use for "judge", "判定して", "比較レビュー", or "採点して".
---

Use `node tools/harness/harness/bin/hx.mjs` as `hx`.
Run deterministic acceptance first with `hx verify --cwd <dir> --run <id> --cmd "<command>"`.
Treat any failing acceptance command as an automatic fail.
Call `hx judge --worker-run <id> --judge auto` for a single candidate.
Call `hx judge --worker-run <id-a> --vs <id-b> --judge auto` for two candidates sharing the same brief.
Choose an explicit judge only when its catalog family differs from every candidate.

The command blinds model metadata, supplies brief/diff/final/verification evidence, and uses the frozen rubric only.
Pairwise judging runs both A/B orders; disagreement becomes a tie.
Read correctness, regressions, scope, and tests in that order. Never reject a correct patch solely for verbosity.
Treat uncertain as missing evidence: run the missing check or request the specific human judgment.
Return blocker/major issues as a correction brief. Do not modify worker code while judging.
Do not translate a judge verdict directly into a final outcome without deterministic evidence and orchestrator acceptance.

Monthly, run `hx judge-calibration` (also `hx scoreboard judge-calibration`).
Compare verdicts with the verification outcomes available at judgment time.
Investigate mismatches and uncertainty; propose evaluator changes only behind the evaluator human gate.
Never let prompt self-improvement edit the rubric, judge code, or benchmark tests.
