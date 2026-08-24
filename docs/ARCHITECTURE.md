# Poiesis Architecture

## Status and source of truth

Decided architecture for First Completion (2026-08-23).

完成条件は [`FIRST-COMPLETION.md`](FIRST-COMPLETION.md)、画面契約は [`ui/agent-window-spec.html`](ui/agent-window-spec.html) を正本とする。旧「Agent Window／Changes／Editor」三領域モデルは採用せず、現在はPoiesisが所有する一つのWindow内のAgent／Results／Codeモデルを採用する。

## Goals

- 実RepositoryをWorkspaceとして扱う。
- Agent RuntimeをUIから交換可能な境界の後ろへ置く。
- Task lifecycle、Baseline、Change Setをアプリが所有する。
- Resultsの枠と、Skillが生成するHTML文書を分離する。
- Files、Git、Editor、SettingsはTheia既存Widgetを再利用する。
- Agent／Results／Code間で状態とfocusを保つ。

## High-level structure

```text
Poiesis Window
├─ Session UI
│  ├─ Agent
│  └─ Results
└─ Code
   ├─ Files / Git       (Theia widgets)
   └─ Editor / Settings (Theia widgets)

Application services
├─ AgentProvider
├─ TaskService
├─ ResultsService
├─ ResultsSkill
├─ Workspace adapter
└─ AgentRuntimeServer
```

Poiesisは外枠を所有する。Theia `ApplicationShell`はdocumentへattachせず、Codeが必要とするFiles、Search、Git、Editor、Terminal WidgetだけをPoiesis専用slotへattachする。

## Core concepts

### Session

一つのWorkspace内のAgent会話単位。Agent会話、Agent Composer下書き、選択タブ、タイトル、pin／archive状態を持つ。一つのSessionに複数の実行Taskが属する。

### Execution Task

Agentへの一回の作業依頼に対応するアプリ所有の実行単位。

```ts
type ExecutionTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';
```

Taskは開始時刻、終了時刻、request、Baseline、Change Setを持つ。CLIのprocessやAgentの自己申告をTaskの正本にしない。

### Baseline

Task開始前のWorkspace snapshot。AgentがWorkspaceを書き換える前に確定しなければならない。

### Change Set

BaselineとTask終了時Workspaceの差。Agentの回答文から推測しない。取得失敗と「変更なし」を区別する。

### Result document

Results skillがTaskとChange Setから生成する完成済みHTML文書。生成状態は`generating | ready | failed`で管理し、不完全なHTMLをcanvasへstreamしない。

## Boundaries

### AgentProvider

UIが依存するAgent境界。Session作成、message送信、cancel、stream eventを提供する。UIはCodex、Claude、mockなどの具体的実装を知らない。

第一完成点のdefault compositionは、検出済みで実行adapterがあるCLIを選び、なければchat-only mockへfallbackする。検出だけ実装されたCLIを実行可能として扱わない。

### AgentRuntimeServer

backend processでCLI起動、cancel、Workspace snapshot、Change Set取得を行う。CLIは開いているWorkspaceをworking directoryとして起動し、固定sample directoryへ置き換えない。

CLI固有のmodelやreasoning effortはPoiesisから固定せず、ユーザーのCLI設定を尊重する。Poiesisが指定するのは、非対話実行、Workspace、sandboxなど実行境界に必要な項目だけとする。

### TaskService

Taskの開始、完了、失敗、キャンセルを管理する。終了状態を確定してからChange Setを発行し、ResultsServiceへ通知する。

### ResultsSkill and ResultsService

ResultsSkillは成果HTMLの生成方法を担う。ResultsServiceはTask終了後の起動、生成状態、完成文書の保持を担う。

Resultsの質問スレッドはTaskと表示中のResult documentをscopeに持つが、Agent会話や新しいExecution Taskを作らない。

### Code integration

CodeはTheia Files、SCM、Editor、Settings Widgetを再利用する。Poiesis固有EditorやGit UIを再実装しない。Widgetのattach／detach時は、選択、tab、scroll位置を可能な限り保持する。

## Event flow

```text
User sends message
  → TaskService captures Baseline
  → AgentProvider starts runtime
  → message delta events update Agent
  → runtime exits as completed / failed / cancelled
  → TaskService captures Change Set
  → ResultsService starts ResultsSkill
  → complete HTML becomes available
  → user explicitly opens Results
```

Task終了、Results生成完了、streaming更新は、現在のtabやfocusを変更しない。

## Security

- Agent CLIのworking directoryはユーザーが開いたWorkspaceとする。
- unattended実行ではworkspace-write相当のsandboxを使用する。
- Poiesisからsandbox無効化やunrestricted filesystem accessを要求しない。
- Results HTMLはsandboxed iframeで表示する。
- HTMLからCodeを開く場合は、定義済みmessage schema、Workspace内path検証、line範囲検証を通す。
- CLI path検出は実行と分け、検出時に未知のbinaryを起動しない。

## Persistence

Session一覧、Agent会話、Composer下書き、タイトル、pin／archive状態、サイドバー幅はTheia `StorageService`境界から再読み込み後に復元する。Widgetは`window.localStorage`へ直接依存しない。実行中processは復元せず、Task metadataとResult documentの永続化は別のApplication serviceへ分離する。

## Architectural rules

- 正本となるWorkspace pathをsample pathや開発者固有pathへ置き換えない。
- UIへ未実装機能を装って表示しない。
- process exit失敗をTask完了として記録しない。
- Agent messageをChange SetまたはResult documentの正本にしない。
- 旧Changes WidgetをResultsと並ぶ第二の成果導線として復活させない。
- 第一完成点に不要なplugin platformやAgent wiring UIを先行実装しない。
