# Poiesis development harness v1

Development-only Node 24 ESM. No npm install, Python, uv, or added dependencies.
Run from this checkout with `node tools/harness/harness/bin/hx.mjs` (`hx` below).
The plugin is discovered through `.claude/settings.json` and the directory marketplace at `tools/harness`.
The root is derived from the executable location, not the worker cwd. Keep this harness checkout available while its worktrees run.

## Measured loop

```text
hx status
hx route --role worker-mech --task-class mechanical --ticket T-001 --explain
hx run --model codex:gpt-6-luna --effort medium --cwd <worktree> --brief <file> --role worker-mech --task-class mechanical --ticket T-001
hx verify --cwd <worktree> --run <run-id> --cmd "npm run test:composer"
hx judge --worker-run <run-id> --judge auto
hx outcome --run <run-id> --result pass --note "Acceptance and independent review passed"
hx scoreboard --write
hx tune
```

All commands support `--json`; data commands already emit ASCII-escaped JSON by default. `route` without explain/json prints only the model ID; status has a compact human format.
Exit 0 means command execution succeeded. A judge's fail/uncertain verdict is data, not a CLI transport error; read it before accepting work. Worker/test failures exit nonzero. Budget refusal exits 3. Timeout exits 124 for a worker, and failed verification makes verify exit 1.
The optional `--run` on verify avoids ambiguity when concurrent runs share a cwd. Otherwise verify attaches to the most recent non-judge run for that cwd.
Use repeated `--cmd` arguments for multiple acceptance commands. Commands are tokenized, not passed to cmd.exe. npm uses Node + npm-cli.js. Explicit PowerShell commands must include `-NoProfile`; shell metacharacters outside quotes are rejected.

Each run writes sanitized events, prompt/brief, final, initial working diff, final diff/stat, schema (when applicable), stderr and metadata under `.harness/runs/<id>/`. Every completed invocation appends one run line, including failed invocations. Verification and explicit outcomes append separate `kind` lines. Unknown usage is identified in metadata. The ledger is append-only and intended for version control; raw traces are ignored. Do not commit secrets.
The final diff includes tracked/staged changes and untracked files against the starting HEAD; initial.patch distinguishes preexisting changes for review. The runner does not stage or commit worker changes.
`--resume <run-id>` resolves that run's session ID, validates matching model/cwd, and creates a new measured run. Never use an implicit latest session. Codex resume was exercised in the acceptance smoke. Claude cumulative usage is differenced from the preceding recorded invocation; out-of-band session use invalidates that baseline and must be avoided.

## Providers and isolation

Edit `config/providers.json` only after model/endpoint and data-policy review. Codex/Claude/Grok catalog entries use subscription quota accounting and null USD prices. Disabled compatibility placeholders intentionally fail closed until model, endpoint, secret environment reference and researched prices are supplied.
`${ENV:NAME}` is resolved in the child environment; missing references fail before invocation. Native Claude rejects an inherited custom endpoint/model to prevent a mislabeled family. Secret environment values and secret-named object fields are redacted at artifact/log boundaries.
Codex runs use `--ignore-user-config` (authentication is preserved) so owner MCP startup cannot populate worker checkouts with npm caches. Claude uses safe mode, no inherited settings, and an empty strict MCP configuration. Since both safe-mode and bare disable CLAUDE.md discovery in the installed CLI, the runner explicitly supplies repository AGENTS.md/CLAUDE.md on stdin. See [cli-notes.md](cli-notes.md).
Write defaults: Codex danger-full-access/never approval; Claude auto; Grok acceptEdits. Read-only defaults: Codex read-only; Claude/Grok plan. Claude read-only uses only Read/Grep/Glob; judge sessions have no tools and use an isolated empty repository. Codex judges receive only sanitized evidence in that repository. CLI sandbox modes are provider controls, not an OS-level containment guarantee against malicious code.

## Scores, routing and budgets

Only runs with a latest explicit pass/fail outcome enter scores. `human` clears automatic scoring until replaced by a definitive outcome. Generic worker runs map mechanical to worker-mech and other classes to worker-design; specifying the routed role directly is preferable.
The posterior is Beta(1 + weighted pass, 1 + weighted fail). Ages 0-14 days weigh 1, 15-45 days 0.5, older 0.25. Costs and times are arithmetic means; median wall time is also recorded. USD stays null for quota models and contributes no metered penalty.
Utility = posterior mean - lambda_cost * mean USD - lambda_time * mean seconds. Tied utilities retain policy order. Exploration uses SHA-256 of `--ticket` (fallback: role:task-class), and a second deterministic draw selects a challenger. Repeat `--exclude-family` as needed. No eligible family is an error; it never falls back to a prohibited family.
Tune uses the central 95% Beta interval's 2.5% lower endpoint, at least min_n_for_promotion observations in both same-class groups, and either superiority or lower-bound noninferiority plus 30% lower measured mean cost. Preview writes `.harness/routing/proposals/<date>.md`; apply updates only the promoted task-class override and increments policy.version. Demoted incumbents remain challengers. Unknown USD does not qualify for cost-saving promotion.
Metered budgets use UTC calendar months/days and last-ten-run mean estimates, falling back to a conservative default. Unknown usage is conservatively charged at the preflight estimate. Prices count uncached input + cached input + output; reasoning is already part of output. Claude-reported total_cost_usd is never used to price third-party calls (or quota calls). Quota models count runs/day with optional caps.
Preflight checks are estimates, not live provider spending limits. Run paid batches serially: v1 does not reserve concurrent spending and cannot halt a provider at an exact mid-turn USD threshold.

## Independent judging

Single verdicts follow the frozen rubric/schema. Verification failure or worker failure forces fail; absent verification prevents pass. Candidate metadata is withheld; preexisting_diff, brief, patch, command results and final answer are evidence. Candidate text is explicitly treated as untrusted data.
Pairwise runs require the same brief, use both label orders, map votes back to the original order, and return tie on disagreement or missing verification. Family exclusion applies to all candidates. Store judge records separately in `.harness/ledger/judge.jsonl`.
Run `hx judge-calibration` monthly. Calibration compares single verdicts with the latest result per command available at the time of judgment, and reports disagreement and uncertainty.

## Bench and dogfood

```text
hx bench mine --limit 5
hx bench run --suite smoke --models codex:gpt-6-luna --repeats 1 --judge none
hx dogfood --model codex:gpt-6-luna --prompt-file <file>
```

Mining scans non-merge history, limits qualifying source+test commits examined, and derives commands from scripts already available at the parent. It rejects missing scripts and incompatible lockfiles. Test-only changes must fail; source+test changes must pass. Instructions contain commit-message requirements and changed paths, never solution code. Review instructions before freezing tasks.
Use text suite files with one task ID per line; blank lines and `#` comments are allowed. Bench runs create a fresh detached worktree per trial, call the measured runner, restore evaluator tests/package scripts, apply hidden tests, verify, record an outcome, optionally judge, and always remove the worktree. Dependencies are a directory junction to the main checkout only when the parent lockfile matches; lock mismatch is never silently overridden.
At the supplied Poiesis history, the latest release changes the workspace version in package-lock.json, so historical parents do not match byte-for-byte. This prevents the requested real-task mining acceptance under the strict equality rule. Missing parent test scripts also reject newly introduced test commands. No tasks are fabricated to meet a count.
Dogfood imports puppeteer-core only on invocation, resolving it from the main checkout. It requires existing Electron output, clones the local source repo and .poiesis into an ignored fixture, allocates fresh user-data/Theia-config/snapshot directories and CDP port, observes rail/Results, records two screenshots, persisted facts and errors, and kills only its own PID tree. `--workspace` is a clone source, never an in-place target. Reports survive failures. Live dogfood requires an available desktop and was not part of the cost-limited acceptance run.

## Validation and self-improvement

Run `node --test tools/harness/harness/test`. The index.js shim is needed because Node 24 does not recursively resolve an explicitly supplied test directory; all actual tests are .test.mjs. Tests never call model CLIs or the network. They cover synthetic stream fixtures, redaction, ledger, budgets, routing, promotion, judge grounding, session facts, tiny git fail-to-pass tasks and packaging guards.
The packaging guard parses the simple YAML files/extraResources sections and fails closed on broad patterns or unknown structures that could admit the harness.
Follow the improve skill: editable surface is skills/templates, routing lambdas/challengers and AGENTS.md. Hash frozen rubric, judge/budget code, limits and bench definitions before/after; stage smoke (3) -> val -> full regression with pinned models. Require improved val, non-inferior regression and median cost growth <=10%. Record the experiment in `.harness/improvements.md`; do not adopt unevaluated changes.
