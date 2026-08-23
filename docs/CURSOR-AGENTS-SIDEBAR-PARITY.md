# Cursor Agents Window sidebar parity

Updated: 2026-08-23

この文書は、Cursor Agents Windowのサイドバー相当機能をLensへ導入する作業範囲を明確にする。AutomationsとLocal以外の実行環境統合（Worktree／Cloud／Remote SSH）は今回の対象外とする。「見た目だけ存在するcontrol」は実装済みに数えない。

参照した現行Cursor仕様:

- Cursor 3 Agents Window: local、worktree、cloud、remote SSHを含む複数Repository／環境のAgentを一つのWindowで扱う。
- Sidebar for all Agents: foreground／background Agentを同じSidebarから確認する。
- Worktrees／multi-root workspaces／multitask: 分離環境、複数Repository、並列subagentを扱う。
- Side chats／conversation search: durableな派生会話、transcript検索、会話内検索を扱う。
- Tiled layout: 複数Agentをpaneへ配置し、layoutを復元する。

## Parity matrix

| Capability | Status | Lens evidence | Required next work |
|---|---|---|---|
| New Chat | done | 空Sessionを再利用し、会話済みの場合だけ新規作成してComposerへfocus | shortcutとtarget pickerを統合する |
| Open／rename／pin | done | Session行と三点メニューで操作可能 | command paletteからの操作を追加する |
| Archive／restore／permanent delete | done | 実行中保護と確認付き完全削除がある | archive検索と大量履歴を検証する |
| Collapsible／resizable sidebar | done | 196〜420px、pointer／keyboard、double-click reset、再読み込み復元 | narrow windowとtouchを検証する |
| Conversation search | partial | titleとpersisted transcriptを検索 | Cmd/Ctrl+K palette、会話内検索、indexing、match highlightが必要 |
| Session persistence | partial | Theia StorageServiceで会話、下書き、pin／archive、rail状態を保存 | Agent runtime context、Task、Resultsの復元が必要 |
| Agent status | partial | runningと時刻を表示 | queued、needs-attention、failed、completed、unreadを追加する |
| Workspace grouping | partial | 現在のWorkspace groupだけを表示 | 複数Repository／recent projectを同時表示する |
| New Agent target picker | missing | なし | project／repoとbranchを送信前に選択する。実行環境はLocal固定 |
| Unified environments | deferred | local Codexのみ | Worktree／Cloud／Remote SSH統合は今回行わない |
| Foreground／background Agents | partial | foreground local taskのみ | 同一Local runtime内のbackground lifecycleと一覧状態を実装する。remote同期は対象外 |
| Worktrees and handoff | deferred | なし | 今回行わない |
| Multi-root workspace | missing | なし | 一つのSessionに複数rootを設定・再利用できるようにする |
| Parallel／multitask Agents | missing | なし | parent／subagent階層、parallel status、queueからの分岐を実装する |
| Side chats | missing | なし | main chatのcontextを持つdurableな派生Sessionを実装する |
| Unread／attention state | missing | なし | background completionとユーザー対応待ちをSidebarへ表示する |
| Tile integration | missing | なし | Sessionを複数paneへ開く、drag／keyboard移動、layout復元を実装する |
| Cross-entry synchronization | deferred | なし | Cloud providerと同時に将来検討する |
| Automations | excluded | ユーザー指定 | 実装しない |

## Implementation rule

Local実行を第一の対象とする。外部service、認証、remote executionが未接続のWorktree／Cloud／Remote SSH controlは表示しない。将来はprovider境界と実データを先に実装し、そのcapabilityが利用可能な場合だけcontrolを表示する。
