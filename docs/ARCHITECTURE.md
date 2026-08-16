# ARCHITECTURE.md

## Status

Architecture Draft for First Completion.

この文書では第一完成点に必要な大枠のみを定義する。将来の一般公開や大規模Plugin Platformに必要な抽象化は、必要になるまで追加しない。

## Architectural Goals

- Agent WindowとEditorを同一IDE内に統合する
- Agent RuntimeとUIを疎結合にする
- Agentによる実変更を追跡できる
- Semantic Diffを実コード解析に基づいて生成する
- Semantic Diffから根拠コードへ辿れる
- 将来Agent Runtimeを交換可能にする
- 第一完成点を超える過剰な汎用化を避ける

## High-Level Architecture

```text
┌─────────────────────────────────────────────┐
│                   IDE                       │
│                                             │
│  ┌──────────────────┐  ┌─────────────────┐ │
│  │      Editor      │  │  Agent Window   │ │
│  │ Code / Diff / LSP│  │ Chat            │ │
│  │ Git              │  │ Question        │ │
│  │                  │  │ Semantic Diff   │ │
│  └─────────┬────────┘  └────────┬────────┘ │
│            │                    │          │
│            └────────┬───────────┘          │
│                     │                      │
│              Application Core             │
│                     │                      │
│   ┌─────────────────┼─────────────────┐    │
│   │                 │                 │    │
│ Event Bus     Workspace Service   Task /    │
│                                   Change    │
│                                   Tracking  │
└─────────────────────┬───────────────────────┘
                      │
          ┌───────────┼────────────┐
          │           │            │
   AgentProvider  SemanticDiff   Tool/Process
                  Provider       Services
```

## Core Concepts

### Task

ユーザーがAgentへ依頼し、一定の作業結果が得られるまでの単位。Taskはチャットメッセージ単位ではない。

```text
User: 認証をRedis方式に変更して
Agent: 実装
User: そこは違う
Agent: 再修正
User: OK
```

この一連を一つのTaskとして扱える必要がある。

### Baseline
Task開始時点のWorkspace状態。

### Change Set
BaselineとTask終了時点のWorkspace状態との差。

```text
ChangeSet = Workspace(Before) → Workspace(After)
```

Change SetはSemantic Diffの一次入力になる。

### Intent
ユーザーのPrompt、チャット、Agent Plan等から得られる「何をしようとしたか」。

### Actual Change
実コード、設定、依存、スキーマなどの変化。

### Semantic Change
Actual Changeから抽出された、人間が理解できる意味単位の変化。

```text
AuthServiceがPostgreSQLへ直接Refresh Tokenを書き込む構造
↓
TokenStore経由でRedisへ保存する構造
```

### Evidence
Semantic Changeを裏付けるコード・設定・スキーマ・参照関係など。

## Core Interfaces

第一完成点では、以下の境界を優先して作る。

### AgentProvider

```ts
interface AgentProvider {
  createSession(input: CreateSessionInput): Promise<AgentSession>
  sendMessage(sessionId: string, message: AgentMessage): Promise<void>
  cancel(sessionId: string): Promise<void>
  onEvent(listener: (event: AgentEvent) => void): Disposable
}
```

責務:
- Agent Session
- Prompt送信
- Tool実行イベント
- Agent状態
- Cancel
- Completion

UIは具体的なAgent実装へ直接依存しない。

### SemanticDiffProvider

```ts
interface SemanticDiffProvider {
  analyze(input: SemanticDiffInput): Promise<SemanticDiffResult>
}
```

入力候補:
- Change Set
- AST / Symbol情報
- Reference情報
- Config Diff
- Dependency Diff
- Schema Diff
- Test Diff
- Intent（補助情報）

出力:

```ts
interface SemanticDiffResult {
  changes: SemanticChange[]
  intent?: IntentSummary
  warnings?: SemanticWarning[]
}
```

### SemanticChange

```ts
interface SemanticChange {
  id: string
  title: string
  before?: SemanticState
  after?: SemanticState
  affectedAreas: string[]
  evidence: EvidenceRef[]
  confidence?: number
}
```

### WorkspaceService

責務:
- Repository / Folderを開く
- File read/write
- Workspace snapshot / baseline
- File watch
- Git状態
- Diff

### EditorService

責務:
- File open
- Range navigation
- Diff open
- Reveal evidence
- Agent Windowとの連携

## Event Model

重要な状態変化はEventとして流す。

```text
task/started
agent/message
agent/tool-call
workspace/file-changed
test/started
test/completed
task/completed
semantic-diff/started
semantic-diff/completed
editor/evidence-opened
```

第一完成点では、汎用Event Frameworkを作ること自体を目的にしない。必要なイベントだけ定義する。

## Agent Window

Agent Windowは以下の責務を持つ。

- Chat
- Task result
- Question
- Semantic Diff
- Quick Diff
- Agent status

通常時はChatのみを主表示とする。

Level 1 / Level 2 / Level 3を同時表示しない。

```text
Level 1: Result
↓ user action
Level 2: Semantic Diff
↓ user action
Level 3: Editor / Evidence
```

## Editor

Editorは以下を担当する。

- コード閲覧
- コード編集
- LSP
- Git Diff
- Evidence navigation

Agent Window内にEditorを再実装しない。

## Semantic Diff Pipeline

```text
Task Started
    ↓
Capture Baseline
    ↓
Agent Work
    ↓
Task Completed
    ↓
Build Change Set
    ↓
Static / Structural Analysis
    ↓
Semantic Change Extraction
    ↓
LLM-assisted Human-readable Representation
    ↓
Evidence Validation
    ↓
Semantic Diff UI
```

LLMは説明生成・統合に利用できるが、一次情報にはしない。

## Evidence Principle

Semantic Diffは、可能な限りEvidenceを持つ。

```text
Semantic Change:
Refresh Token保存先がPostgreSQLからRedisへ変更

Evidence:
- src/auth/auth.service.ts:82-103
- src/auth/token-store.ts:1-96
- src/infra/redis/client.ts:12-55
- package.json redis dependency
```

UIではEvidenceを常時表示しなくてよい。必要なときだけEditorで開けるようにする。

## Plugin Philosophy

DeepSeek Harnessの思想を参考に、Capabilityの境界を意識する。

ただし第一完成点では「Everything is a Plugin」を完全実装しない。

優先する交換可能境界:

```text
AgentProvider
SemanticDiffProvider
```

必要になった場合のみ増やす。

## Technology Selection

技術選定は別途確定する。

候補:
- IDE base: Eclipse Theia または Code-OSS
- Editor: Monaco
- Desktop shell: Electron
- Git: underlying git CLI / library
- LSP: IDE baseの既存機構
- Semantic analysis: language-specific AST / LSP / tree-sitter 等
- Agent runtime: Provider abstraction経由

技術はProduct Goalより優先しない。

## Architectural Rule

新しい抽象化・Framework・Plugin機構を追加する前に確認する。

> 第一完成点の機能を実装するために、今この抽象化が本当に必要か？

将来必要になる「かもしれない」だけなら追加しない。
