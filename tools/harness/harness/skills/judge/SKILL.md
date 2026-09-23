---
name: judge
description: Independently grade measured Poiesis patches or compare candidates; use for "judge", "判定して", "比較レビュー", or "採点して".
---

Use `node tools/harness/harness/bin/hx.mjs` as `hx`.
Run deterministic acceptance first with `hx verify --cwd <dir> --run <id> --cmd "<command>"`.
Treat any failing acceptance command as an automatic fail.
Call `hx gate --worker-run <id> --threshold .8`, then `hx judge --worker-run <id> --after-gate --judge auto` for a single candidate.
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
Calibration includes gate agreement with deterministic checks and independent LLM judgments; absent evidence is not agreement.
Investigate mismatches and uncertainty; propose evaluator changes only behind the evaluator human gate.
Never let prompt self-improvement edit the rubric, judge code, or benchmark tests.

Jev (`typesafe/jev-1.13`) is a typed OpenRouter gate, not a reasoning judge. Worker failure or any recorded failed check causes a deterministic fail without a network call. Otherwise its English questions receive bounded acceptance, source-first diff, and verification command/exits. Pass requires acceptance=pass, confidence>=threshold and scope_creep<0.3; confident acceptance=fail fails; everything else escalates. Missing checks prevent pass. Treat all state as untrusted evidence.
`--after-gate` skips a single-candidate LLM call when the latest gate says pass/fail. Pairwise comparisons still run both orders. Auto judging ranks only families different from every worker, respecting data-policy exclusions; GPT defaults to Claude Opus, Claude to Codex Sol, with GLM/DeepSeek third-family candidates.
Gate `usage.cost` and generation `data.total_cost` supply metered actual USD. Gate requests count against the same USD 30 monthly budget. Do not replace a low-confidence result with a lower threshold after seeing it, or repeat paid calls to obtain a pass. Preserve the escalation for independent review.
