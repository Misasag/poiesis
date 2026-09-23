# Installed CLI verification (2026-09-23)

Local `--help` is the authority for this machine. Commands resolved real executables and exited 0. No `.cmd` shim was executed and no shell:true was used.

| CLI | Version | Executable |
| --- | --- | --- |
| Codex | 0.156.1 | Node + %APPDATA%/npm/node_modules/@openai/codex/bin/codex.js |
| Claude Code | 2.1.280 | %APPDATA%/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe |
| Grok Build | 1.0.40 (eb1a2256660d), stable | %USERPROFILE%/.grok/bin/grok.exe |

## Codex

Verified with root, exec, and exec resume --help:
- Global `--ask-for-approval never` before exec; global `--sandbox read-only|danger-full-access` and `-C <dir>`.
- exec `--json`, `-o`/`--output-last-message`, `--output-schema`, `-m`, `-c model_reasoning_effort=<e>`, and stdin `-`.
- exec resume `<SESSION_ID> -`, model/config/json/output/schema flags; resume does not expose its own -C/--sandbox, so those stay before exec.
- `--ignore-user-config` in exec and resume skips user config while keeping authentication.

The runner sends -o to the OS null device and extracts the final assistant event itself, ensuring only sanitized text is persisted in final.md. It records thread.started.thread_id and turn.completed usage.
Actual gpt-6-luna low smoke succeeded, emitted nonzero input/cached/output tokens, and produced hello.txt. Initial owner MCP configuration spawned a relative npm cache despite a normalized child environment; ignoring user config prevented it. This also reduced the observed smoke from about 49 seconds to 11 seconds, but it is a single-task observation, not a model benchmark.
The initial isolated smoke exposed a BOM despite a trim-based verification passing; the independent judge caught it. A same-session resume fixed it and exercised explicit-ID continuation. The exact-byte check exited 0, and the follow-up Haiku judge returned pass with all four scores 4 and confidence 0.9.

## Claude Code

Verified `-p`, stream-json + verbose, --json-schema, --model, --effort low|medium|high|xhigh|max, --permission-mode auto|plan (and the other advertised modes), --resume, --session-id, --safe-mode, --bare, --setting-sources, --tools, --strict-mcp-config and --mcp-config.
Important installed-help finding: safe-mode disables CLAUDE.md, skills, plugins, hooks and MCP customizations. Bare also disables CLAUDE.md auto-discovery, and additionally skips keychain reads. Neither flag meets "still auto-loads repo CLAUDE.md" literally.
Chosen behavior: safe-mode + empty setting sources + strict empty MCP. Supply repository AGENTS.md and CLAUDE.md explicitly in the stdin prompt. This retains native authentication, respects repo guidance, and excludes owner global plugin/hook configuration without changing owner files. A real haiku read-only JSON judge call exited 0 and returned schema-valid structured_output.
Reference: [Anthropic CLI reference](https://code.claude.com/docs/en/cli-reference). Installed help takes precedence when descriptions differ.

Usage normalization prefers result.modelUsage (including cache creation/read and subagent totals) when present, otherwise result.usage. Input includes cache-read and cache-creation; cached_in is the read portion. Native/compatible CLI result.total_cost_usd is not used as a price source. Resume counters are treated as cumulative and differenced from the preceding run's stored counters; do not interleave out-of-band calls on that session.

## OpenRouter v1.1 measured smoke (2026-09-23)

Token estimates intentionally pin the owner's measured notes (DeepSeek Flash input 0.094 USD/M versus 0.079 in the independent `.harness/tmp/v11-model-api.json` snapshot), while actual costs reflect the selected host/API.

The first run retained v1 `--permission-mode auto` with a two-minute timeout, safe mode, empty setting sources and strict empty MCP. All OpenRouter model environment overrides used `z-ai/glm-5.3-flash`; effort was `default` (no `--effort`). The key came from HKCU\\Environment and was never persisted. `ANTHROPIC_API_KEY` was explicitly empty. No commit was needed: the disposable repository used the empty tree as its diff baseline.

- Run: `run-2026-09-23T05-21-34-573Z-644148d5`, exit 0, worker wall 22.857 s.
- Workspace: `.harness/tmp/v11-core-smoke/auto`.
- `Write` created `hello.txt` with exact UTF-8 bytes `hello\n`. A real `Bash` tool invocation ran `node -e` with a Buffer deep-equality assertion, returned `hello exact bytes: PASS` and `EXIT_CODE=0`. Result `permission_denials` was empty. The separate `hx verify` byte check also exited 0. Evidence is `.harness/tmp/v11-core-smoke-evidence.json` and the run's events/verify artifacts.
- Auto was neither denied nor stalled, so write permissions remain auto. No bypassPermissions fallback was introduced or tested. This is one measured model/CLI combination, not a guarantee for every provider.
- Three distinct assistant `message.id` values began `gen-`; repeated content blocks shared IDs. `GET /api/v1/generation?id=...` returned actual USD in **`data.total_cost`**. Individual costs were 0.00253085, 0.001065, 0.0011055; sum **0.00470135 USD**, coverage 3/3. The last record returned four 404s before succeeding on attempt 5 (500/1000/2000/4000 ms backoff). The token-price estimate was 0.00516215 USD (47,481 input, 23,040 cached, 688 output).
- Claude's result reported `total_cost_usd=0.150925`; it was retained only as raw evidence and **never used for accounting**. Actual generation costs and their diagnostics are in meta.json and the run ledger.

Jev uses `POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.13`, and actual **`usage.cost`**:

| Gate ID | Evidence | Decision at threshold 0.8 | Actual USD | Input/output |
| --- | --- | --- | --- | --- |
| `gate-2026-09-23T05-24-18-752Z-ac2dc63c` | Before independent verify was recorded | escalate; needs_review, confidence 0.84 | 0.000034944 | 832 / 82 |
| `gate-2026-09-23T05-24-31-702Z-df01c9d7` | After exact-byte verification exit 0 | escalate; acceptance pass, confidence 0.75, scope 0.05 | 0.000037758 | 899 / 81 |

Both gate commands exited 0; exit 0 reports a completed gate, not acceptance. The first verification helper had an incorrect relative import (exit 1); after correction it exited 0. The initial gate is preserved and charged. No paid LLM judge or benchmark was launched by this core worker. Total measured OpenRouter smoke plus both gates: **0.004774052 USD**, below the owner's 0.4 cap. The final low confidence is preserved for parent review; the threshold was not lowered and no further calls were made to obtain pass.

Coverage 3/3 refers to captured assistant IDs. The shared account's usage changed from 0.0318673 to 0.041048702 USD over the measurement interval, a 0.009181402 USD delta. Its 0.00440735 USD excess over the recorded generation/gate sum cannot be attributed from these streams; concurrent or auxiliary traffic is unresolved. Both observed totals are below 0.4 USD. Do not treat account-wide deltas as per-run cost.

## Grok Build

Verified --prompt-file and -p/--single, --cwd, --output-format plain|json|streaming-json|streaming-messages-json, --json-schema, --permission-mode acceptEdits|plan, --resume, --session-id, --model, --reasoning-effort/--effort, --no-subagents and --tools. Do not use -c/--continue (implicit newest session).
The installed help says --json-schema implies --output-format json. The parser also accepts a complete JSON result when a schema call does not emit line-delimited events.
No paid Grok run was launched. test/fixtures/grok.jsonl is explicitly SYNTHETIC and is not evidence of production usage availability. Unknown usage is recorded as unavailable in metadata, not inferred. Real Grok wire output, resume, and structured-output behavior remain to be measured before relying on Grok judging at scale.

## Remaining live checks

- Other catalog aliases/efforts, compatibility endpoints, and researched metered prices (placeholders remain disabled).
- Claude resume cumulative usage behavior and actual Grok usage/session output.
- Two-order live pairwise judge; its reconciliation is tested offline.
- Live Electron dogfood/selectors, screenshots and durable facts on the current built app.
- Real Poiesis bench execution is intentionally not run. Strict lock equality currently prevents historical task mining; see README.
