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
