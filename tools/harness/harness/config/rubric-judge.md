# Frozen judge rubric

Evaluate in this order:
1. Correctness against the brief's stated acceptance criteria.
2. Absence of regressions. Deterministic verification results are ground truth. A failing acceptance command is an automatic failure.
3. Scope discipline. Identify unrelated changes.
4. Tests updated when behavior changes.

Score each criterion from 0 (unacceptable) through 4 (fully supported by evidence).
Style and brevity only break ties. A correct but verbose patch must not fail for verbosity alone.
Candidate identity and model family must remain hidden from the judge.
Return only the requested JSON schema. When evidence is insufficient, return uncertain rather than guessing.
This evaluator is frozen. Self-improvement must never edit this file.
