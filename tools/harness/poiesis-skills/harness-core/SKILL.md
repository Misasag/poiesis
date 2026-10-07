---
name: harness-core
description: Re-anchor every development task, capture intent for substantial work, and verify ticket criteria against recorded evidence.
metadata:
  poiesis:
    kind: agent
---

Start every task with `{{HX_COMMAND}} h status --project <workspace> --json`. Read its original request, approved intent version, active tickets, unmet criteria, journal, change set, and mismatches. Resolve mismatches against the disk, conversation, and actual Git changes before continuing. Never silently roll back a user's work.

Route the task. If it is observable, reversible, and light, use the fast lane: do the work and report it without creating intent, tickets, or journal entries. If it grows beyond that, switch to the ticket lane.

For a new ticket lane:

1. Ask only root-level questions that change the goal, constraints, or consequential naming. Decide routine implementation details yourself.
2. Write an intent Markdown draft with `## 原依頼` containing the user's exact request, separate from your summary. Add the root sections `## 目的`, `## 全体の制約`, `## 用語`, `## 棄却した代替案`; for a feature add `## 目的`, `## 制約`, `## 棄却した代替案`, `## 確定した決定`. Use `{{HX_COMMAND}} h intent write --project <workspace> --file <draft> [--parent <parent-id>]`.
3. Reply 「こう理解しました」 and a short, scannable summary of the intended outcome, scope, acceptance, and assumptions. Stop before changing code until the human approves. Carry forward an approval already given for the same purpose and scope; do not ask twice.
4. On the human's approving words, run `{{HX_COMMAND}} h intent approve --project <workspace> --quote "<exact approving words>" [--parent <parent-id>]`.
5. Draft a JSON array of criteria. Every item has `text`, `kind` (`得意` or `苦手`), and either `check` (one executable command) or `human` (one human judgment question). Keep both kinds in the same ticket when needed. Create it with `{{HX_COMMAND}} h ticket new --project <workspace> --title "<title>" --criteria-file <json> [--parent <id>] [--allowed-paths a,b]`.
6. Start work with `{{HX_COMMAND}} h ticket state <id> 実行中 --project <workspace> --reason "<reason>"`. Keep changes within allowed paths.
7. After implementation, run `{{HX_COMMAND}} h check <id> --project <workspace>` and `{{HX_COMMAND}} h scope <id> --project <workspace>`. A failed check requires fixing and rerunning. Record decisions and failures with `{{HX_COMMAND}} h journal <id> "<text>" --kind decided|failed|tried|open --project <workspace>`.
8. After the ticket's escalation threshold of failures, summarize what was tried and why it failed; ask the human one question. Do not loop indefinitely.
9. Treat each 苦手 criterion as a human gate. Only after an actual human judgment, run `{{HX_COMMAND}} h ticket approve <id> --criterion <n> --quote "<exact approving words>" --project <workspace>`. Confirm with `{{HX_COMMAND}} h ticket state <id> 確定 --reason "<reason>" --project <workspace>`. If it refuses, report the reason and continue only when the missing evidence or judgment is available.

Never claim a criterion passed without current recorded evidence. Evidence from an earlier change set is 古い. Never treat a model's prose as the human's approval. End the final report with this fixed block:

ハーネス状況
- チケット: <id and state>
- 条件: <each condition, status, command exit code or human judgment>
- 未検証: <items or なし>
- 人間が判断すること: <items or なし>
