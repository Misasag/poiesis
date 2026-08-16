# NON-GOALS.md

## Purpose

この文書は、第一完成点のスコープを守るための「やらないこと」を定義する。

ここにある項目は悪いアイデアではない。第一完成点を完成させるために、今はやらない。

## First Completion Non-Goals

### Multi-Agent

第一完成点では複数Agentの協調・役割分担を必須にしない。

```text
Planner
Coder
Reviewer
Tester
```

のようなAgent構成は完成後に検討する。単一Agentで第一完成点の体験を成立させる。

### Team Features

以下は対象外。

- 共有Workspace
- Team Chat
- レビュー承認フロー
- 組織管理
- 権限管理
- Team Knowledge Base

### General Public Product Quality

第一完成点では一般公開品質を完成条件にしない。

以下は将来対応。

- Installer polish
- Auto Update
- Code signing
- Crash reporting
- Telemetry
- Full onboarding
- Public documentation
- Support infrastructure

### Full VS Code Replacement

第一完成点ではVS Code / Cursorの全機能を再実装しない。

特に以下を必須にしない。

- 全VS Code Extension互換
- 全Debugger対応
- 全言語対応
- Remote SSH
- Dev Containers
- WSL完全対応
- Settings同期
- Marketplace互換

### Plugin Marketplace

独自Plugin Marketplaceは作らない。Plugin architecture自体も、第一完成点に必要な範囲だけ実装する。

### Everything Is a Plugin

DeepSeek Harnessの思想は参考にするが、IDEの全機能をPlugin化すること自体を目的にしない。

第一完成点では必要なCapability境界だけ持つ。

### Semantic Diff Perfection

Semantic Diffが全言語・全変更を完全に理解することを完成条件にしない。

第一完成点では、

- 対象言語・構成を限定してよい
- 未解析部分を「不明」と表示してよい
- Confidenceを持たせてもよい

重要なのは、誤った断定を避けること。

### Semantic Diff History

過去すべてのSemantic Diffを高度に検索・比較・可視化する機能は作らない。Task単位で現在の変更を理解できればよい。

### Learning / Education Features

以下は作らない。

- AIから理解度確認の質問
- クイズ
- 学習進捗
- 理解度スコア
- 強制レビュー
- 読むべき報告書
- チュートリアル的な説明UI

このIDEは教育ツールではない。

### Forced Review

すべてのAgent作業後にChangesやSemantic Diffを開かせない。ユーザーが通常のチャットだけで次へ進めることを許容する。

### Duplicate Editor in Agent Window / Changes

Agent WindowやChanges内に本格的なコードEditorを再実装しない。ChangesにはChange Setの表現としてCode Diffを表示する。

本格的なコード閲覧・編集はIDEのEditorへ委譲する。

### AI Self-Report as Source of Truth

Semantic DiffをAgentの「こう変更しました」という文章だけから生成しない。

ChatはIntentや補助情報として使えるが、Actual ChangeはWorkspaceから取得する。

### Framework Development for Its Own Sake

以下を目的化しない。

- 完璧なEvent Bus
- 汎用Workflow Engine
- 汎用Agent Framework
- 汎用Plugin Framework
- 独自UI Framework
- 独自Editor Engine

第一完成点のプロダクト体験に必要ない場合は作らない。

## After First Completion

以下は第一完成点の後で検討する。

- Multi-Agent
- Public Beta
- Plugin Marketplace
- DeepSeek Harness Adapter
- Claude / Codex / その他Agent Provider
- Semantic Diff History
- Team Features
- GitHub Integration
- Remote Development
- Advanced Code Review
- Semantic Change Search
- Knowledge accumulation
- Cross-project understanding
- Public extension ecosystem

## Scope Decision Rule

新しい機能案が出たら、必ず次を問う。

> これがないと、「AIにコードを書かせながら、人間が必要な深さだけシステムを理解できるIDE」の第一完成点が成立しないか？

YES: 第一完成点へ入れる可能性がある。

NO: この文書またはAFTER-FIRST-COMPLETIONへ追加する。

## Final Rule

第一完成点は「これ以上改善できない状態」ではない。

第一完成点は、

> 定義した体験が成立した状態

である。
