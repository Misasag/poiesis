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

## pi as the OpenRouter worker (v1.2, measured 2026-09-23)

pi (`@earendil-works/pi-coding-agent@0.87.1`) is the default runtime for OpenRouter-served models. It runs as `node %APPDATA%/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` (signed node.exe; the standalone pi.exe is unsigned). The Claude Code path (`anthropic-compat`) stays only as the `orc:glm-5.3-flash` A/B sibling.

Measured invocation (hello.txt task, `z-ai/glm-5.3-flash`, pinned host, exit 0, wall 10.1 s):

```
node cli.js -p --mode json --provider openrouter --model z-ai/glm-5.3-flash
  --session-dir <run>/sessions --session-id <uuid>
  --no-extensions --no-skills --no-prompt-templates --no-themes --no-approve --offline
  --tools read,bash,edit,write @<abs path>/prompt.md
```

Verified against installed `--help` and docs (`cli.md`, `json.md`, `message-types.md`):
- `@path` prompt references work with absolute paths in print mode; the prompt never becomes a multi-KB argv string. Piped stdin also prepends to the first prompt; `@file` is used instead.
- Built-in tools are read, bash, powershell, edit, write, grep, find, ls. Read-only workers use `--tools read,grep,find,ls`; judges use `--no-tools`.
- `--thinking` accepts off, minimal, low, medium, high, xhigh, max and is clamped to the model's capabilities; `default` omits the flag. All 14 catalog models advertise the `reasoning` parameter on OpenRouter.
- Events: session, agent_start, turn_start/end, message_start/update/end, tool_execution_*, compaction_*, agent_end, agent_settled. Usage is summed over assistant `message_end` (`message.usage.{input,output,cacheRead,cacheWrite,cost.total}`; `input` excludes cache reads, `output` includes reasoning) plus `compaction_end.result.usage`. Success requires the last assistant `stopReason == "stop"`; the exit code alone is not trusted. `message.responseId` is the OpenRouter `gen-` id, so v1.1 generation-API cost reconciliation applies unchanged and no key-delta fallback is needed.
- pi's `usage.cost.total` is a catalog-price estimate (it matched our catalog math to the cent on the measured run: 0.00102455 USD); it is recorded as `pi_cost_estimate_usd` and never used for accounting.
- Sessions: `--session-id` works for creation, but pi stores files as `<timestamp>_<id>.jsonl` and **cannot reopen them by the bare id**; verified resume opens the recorded file by path (`--session <file>`) inside the same `--session-dir`. The ledger stores `session_id` plus `session_file_rel`.
- Isolation: `PI_CODING_AGENT_DIR` points at `.harness/pi-agent/`, regenerated each run from the committed template `tools/harness/harness/config/pi-agent/` (settings.json `cacheWarming: "off"`; models.json `modelOverrides` per slug). `.harness/pi-agent/` and `.harness/budget/quota-state.json` are gitignored runtime state. Context files stay enabled (workers get AGENTS.md), and the harness additionally supplies guidance in the prompt.

Measured pitfall: pi's own catalog requests `max_tokens` up to 943,718 for glm-5.3-flash, which makes OpenRouter's routing funnel remove nearly every endpoint (its "Filter by Context Length" step) before the pinned host is reached, producing `stopReason:"error"` with a 404 routing-funnel body and exit code 0. The template therefore caps `maxTokens` per model to the pinned endpoints' `max_completion_tokens` (bounded by 131,072; deepseek-v4-pro is capped to 16,384 to keep its DeepInfra/SiliconFlow pins routable). Quantization filters also silently remove hosts that declare no quantization, so the filter is only set where the pinned endpoint declares one.

### Provider pinning (template `models.json`, per model; all entries set `allow_fallbacks:false`, `require_parameters:true`)

Chosen 2026-09-23 from `GET /api/v1/models/<slug>/endpoints`: prefer the model developer's own endpoint, else verified fp8/bf16 hosts; `quantizations` only where the pinned endpoint declares one (fp8/bf16 floor, native-lower exceptions mxfp4/int4); `data_collection:"deny"` only where a deny route exists.

| Model (slug) | Pinned order | Endpoint quantization | maxTokens cap | data_collection |
| --- | --- | --- | --- | --- |
| z-ai/glm-5.3 | Z.AI | fp8 | 131072 | deny |
| z-ai/glm-5.3-flash | Z.AI | fp8 | 131072 | deny |
| deepseek/deepseek-v4.1-flash | Fireworks, Together, DeepInfra | fp8/bf16 filter in current template | 131072 | none (may-train catalog class) |
| deepseek/deepseek-v4-pro | DeepInfra, SiliconFlow | fp8, fp8 | 16384 | none (host terms unverified; catalog classifies may-train) |
| moonshotai/kimi-k3 | Moonshot AI, DeepInfra | mxfp4, bf16 | 131072 | none (may-train catalog class) |
| moonshotai/kimi-k2.7-code | Moonshot AI, GMICloud | int4, fp8 | 131072 | none (may-train catalog class) |
| xiaomi/mimo-v2.6-pro | Xiaomi | fp8 | 131072 | deny |
| xiaomi/mimo-v2.6-flash | Xiaomi | fp8 | 131072 | deny |
| qwen/qwen3.8-max-0902 | Alibaba | unknown | 131072 | none (no ZDR route) |
| qwen/qwen3.8-flash | Alibaba | unknown | 131072 | none (no ZDR route) |
| minimax/minimax-m3 | Minimax | fp8 | 131072 | none (may-train catalog class) |
| meta/muse-spark-1.3 | Meta | unknown | 131072 | none (no ZDR route) |
| google/gemini-3.8-flash | Google | unknown | 65536 | deny (paid Google route, not AI Studio) |
| x-ai/grok-4.7 | xAI | unknown | 131072 | none (may-train catalog class) |

### Quota exhaustion (infrastructure, not model failure)

Detected per adapter from stderr/events: Codex "You've hit your usage limit ... try again at 7:06 PM" (local wall-clock reset time parsed to the next occurrence), Claude usage-limit/rate_limit messages, and OpenRouter HTTP 402/429. A 402 can be an in-flight credit reservation on a new account: the runner retries pi runs twice with backoff before classifying, and a persistent 402 is recorded as credits exhausted. State is `.harness/budget/quota-state.json` (gitignored, no secrets): `{"<family>": {"exhausted_until", "source", "seen_at"}}` with keys `openai` (Codex login), `anthropic` (Claude plan), `openrouter` (key credits). Affected runs are ledgered `infra:"quota_exhausted"`, excluded from scoreboard/tune statistics, skipped by `hx route` (explain line names the reset time), shown by `hx status`, and bench cells become `skipped_quota`, never `fail`.
