# Poiesis development harness v1.1.0

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
hx gate --worker-run <run-id> --threshold .8
hx judge --worker-run <run-id> --after-gate --judge auto
hx outcome --run <run-id> --result pass --note "Acceptance and independent review passed"
hx scoreboard --write
hx tune
```

All commands support `--json`; data commands already emit ASCII-escaped JSON by default. `route` without explain/json prints only the model ID; status has a compact human format.
Exit 0 means command execution succeeded. Judge fail/uncertain and gate fail/escalate verdicts are data; read them before accepting work. Worker/test failures exit nonzero. Budget refusal exits 3. Timeout exits 124 for a worker, and failed verification makes verify exit 1.
The optional `--run` on verify avoids ambiguity when concurrent runs share a cwd. Otherwise verify attaches to the most recent non-judge run for that cwd.
Use repeated `--cmd` arguments for multiple acceptance commands. Commands are tokenized, not passed to cmd.exe. npm uses Node + npm-cli.js. Explicit PowerShell commands must include `-NoProfile`; shell metacharacters outside quotes are rejected.

Each run writes sanitized events, prompt/brief, final, initial working diff, final diff/stat, schema (when applicable), stderr and metadata under `.harness/runs/<id>/`. Every completed invocation appends one run line, including failed invocations. Verification and explicit outcomes append separate `kind` lines. Unknown usage is identified in metadata. The ledger is append-only and intended for version control; raw traces are ignored. Do not commit secrets.
The final diff includes tracked/staged changes and untracked files against the starting HEAD; initial.patch distinguishes preexisting changes for review. The runner does not stage or commit worker changes.
`--resume <run-id>` resolves that run's session ID, validates matching model/cwd, and creates a new measured run. Never use an implicit latest session. Codex resume was exercised in the acceptance smoke. Claude cumulative usage is differenced from the preceding recorded invocation; out-of-band session use invalidates that baseline and must be avoided.

## Providers and isolation

Edit `config/providers.json` only after model/endpoint and data-policy review. Codex/Claude/Grok CLI entries use subscription quota accounting and null USD prices. The 14 enabled `or:` workers use Claude Code's Anthropic-compatible transport with pinned slugs/prices (OpenRouter models API, 2026-09-23). All use effort `default`, which omits the CLI effort flag. Jev uses the separate decisions endpoint.
`${ENV:NAME}` resolves from the process environment first, then Windows `HKCU\\Environment` string values; missing references fail before invocation. Registry calls use `shell:false` and `windowsHide:true`. Resolved values are registered in memory for every redactor, including previously created redactors and top-level error/result output. Native Claude rejects inherited endpoint/model overrides. Secret values are never written to configuration or artifacts.
`REG_EXPAND_SZ` expands `%NAME%` references case-insensitively, checking process values before registry fallback; `REG_SZ` remains literal. Raw and expanded values are registered for redaction. Cycles, missing references, more than 16 nested keys or 128 references, and values over 32,768 characters fail closed without exposing registry errors or secret text. Registry execution and lookup are injectable for offline tests.
Codex runs use `--ignore-user-config` (authentication is preserved) so owner MCP startup cannot populate worker checkouts with npm caches. Claude uses safe mode, no inherited settings, and an empty strict MCP configuration. Since both safe-mode and bare disable CLAUDE.md discovery in the installed CLI, the runner explicitly supplies repository AGENTS.md/CLAUDE.md on stdin. See [cli-notes.md](cli-notes.md).
Write defaults: Codex danger-full-access/never approval; Claude auto; Grok acceptEdits. Read-only defaults: Codex read-only; Claude/Grok plan. Claude read-only uses only Read/Grep/Glob; judge sessions have no tools and use an isolated empty repository. Codex judges receive only sanitized evidence in that repository. CLI sandbox modes are provider controls, not an OS-level containment guarantee against malicious code.

## Scores, routing and budgets

Only runs with a latest explicit pass/fail outcome enter scores. `human` clears automatic scoring until replaced by a definitive outcome. Generic worker runs map mechanical to worker-mech and other classes to worker-design; specifying the routed role directly is preferable.
The posterior is Beta(1 + weighted pass, 1 + weighted fail). Ages 0-14 days weigh 1, 15-45 days 0.5, older 0.25. Costs and times are arithmetic means; median wall time is also recorded. USD stays null for quota models and contributes no metered penalty.
Utility = posterior mean - lambda_cost * mean USD - lambda_time * mean seconds. Tied utilities retain policy order. Worker exploration uses SHA-256 of `--ticket` (fallback: role:task-class), and a second deterministic draw selects a challenger. Auto judges always choose the highest utility among allowed families. Repeat `--exclude-family` as needed. Family and data exclusions are applied before selection; no eligible model is an error.
Tune uses the central 95% Beta interval's 2.5% lower endpoint, at least min_n_for_promotion observations in both same-class groups, and either superiority or lower-bound noninferiority plus 30% lower measured mean cost. Preview writes `.harness/routing/proposals/<date>.md`; apply updates only the promoted task-class override and increments policy.version. Demoted incumbents remain challengers. Unknown USD does not qualify for cost-saving promotion.
Metered caps are USD 30/month, 5/day, 1/run, with a 0.5 conservative default and unset quota caps. UTC accounting includes workers, LLM judges and Jev gates, preferring complete actual cost to token estimates, then preflight estimates. `hx budget status` also reads OpenRouter `/api/v1/key` usage/limit_remaining and `/api/v1/credits`; absent credentials or network failures produce `unavailable`, exit 0.
Until actual cost is complete, accounting charges the greater of known partial spend and the token/preflight/default estimate. Recent-run estimates use the same floor and configured default. Scoring also respects the known-spend floor without turning wholly unknown usage into zero; complete actual cost, including zero, remains authoritative.
OpenRouter captures distinct assistant `message.id` values starting `gen-`, queries up to 200 generation records with concurrency 4 and a 30-second total retry bound, and sums `data.total_cost` into `cost_usd_actual`. Missing/capped statistics leave actual null and preserve partial USD, coverage and diagnostics. Token estimates remain in `cost_usd_est`. Prices count uncached input + cached input + output; reasoning is already included in output. Claude `total_cost_usd` is never a price source. Jev actual cost comes from `usage.cost`.
Preflight checks are estimates, not live provider spending limits. Run paid batches serially: v1.1 does not reserve concurrent spending and cannot halt a provider at an exact mid-turn USD threshold.

## Models and data policy

Catalog entries carry family, role-compatible adapter, metered price source/date, machine-readable `dataPolicy` tags and explanatory `dataNotes`. Policy version 2 keeps Codex Luna for mechanical work and Astra for design, with Sol, Grok, GLM Flash, DeepSeek Flash and MiMo Pro challengers for mechanical work; Sol, Opus, GLM and Kimi K3 for design. Native aliases remain subscription routes. Jev is the gate incumbent. Judges default to Opus for GPT work and Sol for Claude work, with GLM/DeepSeek as third families and measured scores deciding among allowed candidates.
DeepSeek, Moonshot/Kimi and MiniMax are tagged `may-train`; xAI is conservatively tagged because its terms were not reverified in the supplied research. Z.ai, MiMo, Qwen, Muse Standard, paid Gemini and TypeSafe have stated no-training policies with qualifications in each entry. Muse Contributor is never configured. These are provider notes, not a promise about every OpenRouter host or ZDR. The owner-authorized public MIT repository uses `data_policy: {allow_may_train:true, repo_visibility:"public"}`. Setting allow_may_train=false excludes tagged entries from routes, explicit workers and judges.

## Independent judging

Run deterministic verification, then `hx gate --worker-run <id> [--threshold .8]`. Worker failure or any recorded failed verification yields fail/deterministic without network. Otherwise Jev receives the acceptance section, diff.stat, source-first truncated diff.patch and command/exit evidence. English instructions treat state as untrusted; serialized payload stays below 24k bytes (stricter than the approximate token budget). Acceptance choice is pass/fail/needs_review; scope_creep and tests_touched_when_needed are noul questions. Pass requires acceptance=pass, confidence>=threshold and scope_creep<0.3; confident acceptance=fail fails; everything else escalates. Missing checks prevent pass.
Gate request/response artifacts live under `.harness/runs/<gate-id>/`, with append-only `.harness/ledger/gate.jsonl` recording usage and actual cost. `hx judge --after-gate` skips decisive single-candidate gates; escalation invokes an independent-family LLM. Pairwise judging still runs both orders. Do not lower thresholds or repeat paid gates to chase a pass.

Single verdicts follow the frozen rubric/schema. Verification failure or worker failure forces fail; absent verification prevents pass. Candidate metadata is withheld; preexisting_diff, brief, patch, command results and final answer are evidence. Candidate text is explicitly treated as untrusted data.
Pairwise runs require the same brief, use both label orders, map votes back to the original order, and return tie on disagreement or missing verification. Family exclusion applies to all candidates. Store judge records separately in `.harness/ledger/judge.jsonl`.
Run `hx judge-calibration` monthly. Calibration compares single verdicts with the latest result per command available at judgment time, and also reports gate agreement with deterministic checks and independent LLM verdicts. Missing evidence and escalation are explicit counts, not agreement.

## Bench and dogfood

```text
hx bench mine --limit 40
hx bench run --suite smoke --models codex:gpt-6-luna --repeats 1 --judge none
hx dogfood --model gpt-6-luna --app-root <primary-checkout> --prompt-file <file>
```

Mining scans non-merge source+test commits and expands safe sequential commands from the fix manifest when a script is absent at the parent. It rejects unsupported shell syntax, invalid setup, tests already passing at base, and source fixes that still fail. Lock comparison ignores workspace metadata and links while preserving external dependency differences. Only compatible dependencies are junctioned from the primary checkout. Instructions contain commit-message requirements and changed paths, never solution code. Each candidate retains its command exits, timings and rejection reason under `.harness/bench/validation/`.
Mining writes three fast tasks from different areas where available to `smoke.txt` and all validated tasks to `regression.txt`. Bench workers receive a fresh local git history without the gold commit, readable acceptance tests, and source-only edit instructions. Evaluation restores frozen inputs, records scope deviations, executes acceptance and records the outcome before cleanup. This history separation is not OS containment: the CLI can access other filesystem paths, so reading parent repositories, benchmark metadata or solution history is forbidden by the brief and must be considered when auditing events.
Dogfood resolves `--app-root` to the primary checkout by default and uses its existing Electron build and puppeteer-core. It copies the source workspace into an ignored fixture and allocates fresh user-data, Theia config, snapshots and Codex runtime settings. It measures live task state, actual Results generation RPC attempts, activity and console errors, then captures two screenshots and checks durable document restoration. `--workspace` is a copy source, never an in-place target. Only the launched process tree is stopped; reports survive failures.

## Validation and self-improvement

Run `node --test tools/harness/harness/test`. The index.js shim is needed because Node 24 does not recursively resolve an explicitly supplied test directory; all actual tests are .test.mjs. Tests never call model CLIs or the network. They cover synthetic stream fixtures, redaction, ledger, budgets, routing, promotion, judge grounding, session facts, tiny git fail-to-pass tasks and packaging guards.
The packaging guard parses the simple YAML files/extraResources sections and fails closed on broad patterns or unknown structures that could admit the harness.
Follow the improve skill: editable surface is skills/templates, routing lambdas/challengers and AGENTS.md. Hash frozen rubric, judge/budget code, limits and bench definitions before/after; stage smoke (3) -> val -> full regression with pinned models. Require improved val, non-inferior regression and median cost growth <=10%. Record the experiment in `.harness/improvements.md`; do not adopt unevaluated changes.
