# First Completion implementation status

Updated: 2026-08-23

この文書は [`FIRST-COMPLETION.md`](FIRST-COMPLETION.md) の完成契約に対する実装状況を記録する。仕様はこの文書では変更しない。

判定は `done`、`partial`、`missing` の三段階とする。`done`には、現行UIを操作する自動検証または手動検証の証跡が必要である。

| Area | Status | Current evidence | Remaining work |
|---|---|---|---|
| Poiesis-owned window | done | 1280×720の現行UI smokeでAgent／Results／Code切替、状態保持、旧Changes非表示を確認 | 現行E2Eを継続する |
| Workspace open | partial | Folder dialogとTheia Workspaceを利用 | 実RepositoryでCompletion Trialを行う |
| Agent chat | partial | Codex実行adapterとmock fallbackがある | 実Repositoryで安全な実行を検証する |
| Runtime selection | partial | Codex／Claudeを検出する | 実行adapterはCodexのみ。provider registryが必要 |
| Task lifecycle | partial | start／complete／failure／cancelとsnapshot差分がある | 実CLIで各終了状態を検証し、再起動後の復元を追加する |
| Results generation | partial | 完成済みHTML一つをsandboxed iframeへ表示 | 汎用的な成果生成とエラー回復を検証する |
| Results question | missing | Composerの見た目だけ存在 | Task＋HTML scopeの独立質問・回答serviceを実装する |
| Code mode | partial | 現行UI smokeでFiles／Git切替、Settings表示、Resultsへの復帰を確認 | file openと実Git diffを追加検証する |
| Cursor Agents sidebar parity | partial | New Chat再利用、本文検索、pin、inline rename、archive／restore／完全削除、実行中表示、196〜420px resizeをUI smokeで操作 | multi-repo、Local target picker、unread、side chat、parallel agent、tile連携が未実装。Worktree／Cloud／Remote SSHはdeferred。`CURSOR-AGENTS-SIDEBAR-PARITY.md`を正とする |
| Session persistence | partial | Theia StorageServiceで一覧、会話、下書き、pin／archive、rail幅を復元 | Agent runtime context、Task metadata、Result documentを保存・復元する |
| Accessibility | partial | ARIA labelとnative controlsを一部利用 | keyboard、focus、screen reader、1280×720を検証する |
| Distribution | partial | Electron development buildの過去実績あり | 現行shellで再検証し、installer／updateを確認する |

## P0: completion blockers

- Results質問をAgent会話やExecution Taskと分離して実装する。
- 開いている実Workspaceで、Codex実行、Change Set取得、Results生成までのE2Eを通す。

## Completed in the 2026-08-23 convergence pass

- 旧Changes中心のUX／ArchitectureをAgent／Results／Code仕様へ統合した。
- Codexのworking directoryから固定`sample-src`を除き、開いているWorkspaceを使用するようにした。
- Agent／Resultsごとにproviderとmodelを選択できる。CLI既定ではmodel flagを省略し、reasoning effortはCLI設定を尊重する。
- CLIの非zero exitと起動失敗をTask failureとして分離した。
- 共通Settings導線をTheia Settings Widgetへ接続した。
- 動作しないComposer context操作をUIから除いた。
- 旧Changes Widgetを製品compositionから除いた。
- 透明なTheia preloadが画面下部の操作を妨げる問題を修正した。
- 現行UI smokeをAgent／Results／Code導線へ更新し、1280×720で通した。
- Cursor Agents Windowへの第一段階として、Sessionのpin／rename／archive／restore／完全削除、New Chatの空Session再利用、サイドバーresizeとUI状態保存を追加した。Sidebar全体のparityは未達である。

## P1: completion trial blockers

- Agent runtime context、Task metadata、Result documentを再起動後に復元する。
- 大きなRepositoryでsnapshotの時間・memory上限を検証する。
- 1280×720、keyboard only、長文stream、Results生成失敗を検証する。
- 現行shellでElectron smokeを再実行する。

## Explicitly deferred

- Composerの＋メニュー
- Plugin marketplace
- Agent wiring UI
- Multi-Agent UI
- Results notification dot

対象外機能は、動作しないcontrolとして第一完成点UIへ残さない。
