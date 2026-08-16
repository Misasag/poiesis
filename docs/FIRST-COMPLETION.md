# FIRST-COMPLETION.md

## Purpose

この文書は、第一完成点を明確に定義し、個人開発が無期限に続くことを防ぐための完成契約である。

第一完成点に到達したら、改善余地が残っていても一度「完成」とする。

## First Completion Goal

自分の実プロジェクトをこのIDEで開き、Agentに実装を任せ、普段はチャットだけで進められ、気になった変更だけChanges領域でCode DiffやSemantic Diffとして理解し、さらに必要なら同じIDEのEditorで根拠コードを確認できる。

これを日常開発で実用できる。

## Definition of Done

### Workspace
- [ ] 既存Repositoryを開ける
- [ ] Workspace内のファイルをEditorで閲覧・編集できる
- [ ] Git差分を確認できる
- [ ] Terminalを利用できる

### Agent
- [ ] Agent Windowから自然言語で実装を依頼できる
- [ ] AgentがWorkspace内のファイルを読める
- [ ] Agentがファイルを編集できる
- [ ] Agentがコマンドを実行できる
- [ ] Agentがテスト・ビルド結果を確認できる
- [ ] Agentの作業をキャンセルできる
- [ ] 1つのTaskと、そのTaskによるChange Setを紐付けられる

### Agent Window
- [ ] 通常状態はシンプルなチャットUIである
- [ ] 作業完了時に短い結果を表示できる
- [ ] 作業結果に「質問」アクションがある
- [ ] Agent Windowだけで通常の開発を継続できる
- [ ] Agent WindowはChange Setの表示責務を持たない

### Question
- [ ] 「質問」から、そのTaskを文脈として追加質問できる
- [ ] ユーザーが対象Taskや変更内容を説明し直す必要がない
- [ ] 質問は通常のチャットフローを壊さない

### Change Set
- [ ] Task開始時点の基準状態を取得できる
- [ ] Task終了時点の状態との差分を取得できる
- [ ] 複数ターンにまたがる修正を一つのTask Change Setとして扱える
- [ ] Agentの自己申告ではなく、Workspaceの実差分を取得できる

### Changes
- [ ] ユーザーが必要なときにChanges領域を開ける
- [ ] Changes領域で対象TaskのChange Setを確認できる
- [ ] 同じChange SetのCode DiffとSemantic Diffを切り替えて確認できる
- [ ] 必要な場合はCode DiffとSemantic Diffを並列に表示できる
- [ ] Agentの作業完了時にChanges領域を強制表示しない

### Semantic Diff
- [ ] Change SetからSemantic Diffを生成できる
- [ ] Semantic Diffは実際のコード・設定・スキーマ等を一次情報とする
- [ ] Semantic DiffをChanges領域で表示できる
- [ ] Code DiffとSemantic Diffが同じChange Setを表現していることを識別できる
- [ ] 変更前と変更後の意味の差を表示できる
- [ ] 重要な責務・依存・データフロー等の変化を表現できる
- [ ] Semantic Changeごとに根拠情報を保持できる
- [ ] Semantic Diffから根拠となるコードへ移動できる
- [ ] IntentとActual Changeを区別できる

### Editor Integration
- [ ] Semantic Diff上の項目から該当ファイル・行へ移動できる
- [ ] EditorからChangesやAgent Windowへ自然に戻れる
- [ ] Agent Window、Changes、Editorが別アプリ・別Workspaceとして分離されていない
- [ ] ChangesのCode DiffとEditorでの本格的なコード閲覧の役割が重複しすぎていない

### Practical Use
- [ ] 自分の実プロジェクトで継続利用できる
- [ ] 重大なデータ破壊・作業消失が起きない
- [ ] Agent失敗時に復旧可能である
- [ ] Semantic Diffが明らかな誤情報を頻繁に出さない
- [ ] 「確認のためだけにCursor等へ戻る」ことが頻繁に発生しない

## Completion Trial

Definition of Doneを満たした後、1〜2週間、自分の実開発でメインIDEとして利用する。

この期間に他IDEへ戻った場合は、理由を記録する。

修正対象にするのは、

> 第一完成点の体験を成立させない問題

のみ。

単なる改善案は第一完成点後へ回す。

## Completion Rule

以下の質問にYESなら第一完成とする。

> AIに実装を任せ、普段はAgent Windowだけで進め、気になったときだけChangesでCode DiffやSemantic Diffを見て、さらに必要な場合だけ根拠コードへ降りる開発フローを、自分が実際に使いたいと思えるか？

YESなら完成。

「もっと良くできる」は未完成の理由にしない。

## Development Rule

開発中に新しいアイデアが出た場合、必ず以下を確認する。

> これがないと第一完成点の体験が成立しないか？

YES: 第一完成点へ追加してよい。

NO: AFTER-FIRST-COMPLETIONへ送る。
