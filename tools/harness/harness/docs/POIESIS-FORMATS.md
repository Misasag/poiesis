# Poiesis harness disk formats (v2 extension)

This extends the owner's `FORMATS.md`; the v2 revisions in `docs/HARNESS.md` take precedence where the older format has one goal per ticket. All mutable records live under `<workspace>/.harness/`. Text files are UTF-8, and `hx h` writes ASCII-only stdout by escaping non-ASCII characters. The owner-facing agent and Results skill render Japanese.

## Intent

`intent/root.md` and `intent/<parent-ticket-id>.md` use flat YAML-like frontmatter and Markdown bodies. Required frontmatter fields are `version`, `approved_version`, `approved_at`, and `approved_quote`; feature intents also have `parent_ticket`. `version` is SHA-256 of the exact normalized LF body bytes, including its final newline. `approved_version` must equal the current body hash to be current. Writing a changed body clears all approval fields. `approved_quote` stores the human's approving words verbatim. A hand edit without `hx h intent write` makes an older approval stale, even if the stored `version` was not updated.

The body starts with `## 原依頼`, which contains the user's verbatim request and must not be replaced by an AI summary. Root intent then uses `## 目的`, `## 全体の制約`, `## 用語`, `## 棄却した代替案`. Feature intent uses `## 目的`, `## 制約`, `## 棄却した代替案`, `## 確定した決定`. Code-derived file lists and implementation details do not belong in intent.

`hx h intent write --file <draft> [--parent <id>]` accepts a Markdown body or a file with frontmatter. `hx h intent approve --quote "<human words>" [--parent <id>]` records approval for the current body. A caller must only supply words actually spoken by the human. Existing v1 intent files without these fields remain readable by `h status` as unapproved legacy documents.

## Tickets and criteria

`tickets/<id>.md` frontmatter is flat scalar key/value. Fields are `id`, `parent` (ID or `null`), `title`, `state` (`未着手`, `実行中`, `確定`), `escalation_threshold` (positive integer), `baseline` (`<git HEAD>:<change-set SHA-256>`), `baseline_files` (base64url-encoded JSON map of changed file paths to content hashes at ticket creation), and `allowed_paths` (comma-separated project-relative files or directories). The encoded baseline map is one flat scalar, not nested frontmatter. Paths are compared at directory boundaries; `dir` permits `dir/file`, and `dir/**` permits descendants.

The body has `## /goal`, `## 受け入れ条件`, `## 履歴`, and `## escalation ログ`. Criteria use a numbered Markdown list. Example:

```markdown
## 受け入れ条件
- [1] Tests pass
  - kind: 得意
  - check: "node --test test.mjs"
  - status: 未実行
- [2] Human confirms the flow
  - kind: 苦手
  - human: "Does this match the intended workflow?"
  - status: 未実行
```

Each criterion has `kind` and `status` (`未実行`, `合格`, `不合格`, `障害`, `古い`), plus exactly one of `check` or `human`. A human-approved criterion additionally records `approved_at`, `approved_quote`, and `approved_hash` (the current change-set hash). A machine criterion is `合格` only when its latest recorded check exited 0 against the current change-set hash. Older evidence and human approval become `古い` when that hash changes. `hx h ticket approve <id> --criterion <n> --quote "<human words>"` records an actual human judgment. `hx h ticket state <id> 確定 --reason ...` refuses if a criterion is unmet, a child ticket remains open, HEAD moved, or changes since baseline extend outside allowed paths.

`hx h ticket new --title ... --criteria-file <json> [--parent id] [--allowed-paths a,b]` accepts a JSON array of `{ "text": "...", "kind": "得意", "check": "..." }` or `{ "text": "...", "kind": "苦手", "human": "..." }`; an object with a `criteria` array also works. Tickets receive sequential `T-0001` IDs unless `--id` is supplied. The ticket's baseline records HEAD and the working change set at creation. This lets `h scope` report changes made after the ticket started, including modifications to preexisting dirty files. An omitted allowed path list permits no new changes.

## Journal and evidence

`journal/<id>.md` is append-only. `hx h journal <id> "<text>" --kind tried|failed|decided|open` adds one dated line. `evidence/<id>.jsonl` is append-only and written by `hx h check`, not by the agent. Every line records criterion number, command, exit code, time, change-set hash, HEAD, status, run duration, and a redacted output tail. Checks reuse the existing `verify` command launcher (`shell:false`, hidden subprocess windows, direct Node + npm-cli.js on Windows). A command spawn failure or timeout records `障害`; a nonzero process exit records `不合格`.

The change-set hash is SHA-256 over HEAD and the sorted map of changed tracked and untracked file content hashes. Files under `.harness/` do not affect it, even when tracked, because writing evidence must not invalidate that evidence. `h status` compares disk intent, active tickets, journal, and Git changes and emits a packet under 60 lines. `--json` exposes the same fields without packet-only truncation. Legacy v1 tickets remain visible but have no v2 baseline or per-criterion evidence, so they cannot be confirmed through the v2 gate.
