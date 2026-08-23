# ADR 0001: IDE基盤にEclipse Theiaを採用する

## Status

Accepted（Theia採用）

> Update (2026-08-23): Theia採用の決定は有効。旧Agent Window／Changes配置は後続の第一完成点でAgent／Results／Codeへ置き換えた。現行UIは`FIRST-COMPLETION.md`、`UX.md`、`ARCHITECTURE.md`、`ui/agent-window-spec.html`を正本とする。以下のUI記述は選定時の根拠として保持する。

## Date

2026-08-16

## Context

このプロダクトは、EditorへAIチャットを追加するものではない。Agent Windowを通常の開発入口とし、ユーザーが必要なときだけChangesを開き、同じChange SetをCode DiffとSemantic Diffで確認し、EvidenceをEditorで開く。

この構造を第一完成点まで実装するには、既存Editor、Terminal、Git、LSPを再利用しながら、Agent WindowとChangesを製品が所有する第一級UIとして配置できるIDE基盤が必要である。

Theia 1.73.1とCode-OSS系のVSCodium 1.126.04524で、同じダミーChange Setを使ったTechnical Spikeを実施した。両方でRepository、Editor、Agent Window、ユーザー操作で開くChanges、Code Diff / Semantic Diffの切り替え、Evidence navigationを実装した。

検証条件には差がある。

- Theiaはbrowser applicationと独自extensionをNode.js 24.5.0 / Windowsで実ビルドし、HTTP 200とヘッドレスUI操作を確認した。Electron applicationのbuild、package、desktop起動は未検証である。
- Code-OSSは公開Extension APIで実装し、配布済みVSCodium上でElectron workbench、VSIX、ヘッドレスUI操作を確認した。Code-OSS source fork自体はbuildしていない。source forkに必要なBuild Tools、指定Node、package、upstream mergeのコストは未実測である。
- Code Diff / Semantic Diffの切り替えは両方で確認した。並列layout、人間による長時間利用、accessibility、大規模Repositoryは未検証である。
- TheiaのTerminal / Git / LSPはsurfaceと構成までの一部確認である。Code-OSSではTerminal command、Git repository API、TypeScript hoverまで確認した。両方とも実運用に必要な操作全体は未確認である。

したがって、この決定は完成品同士の比較ではない。第一完成点の固有UIをcore forkなしで所有できるかを優先した基盤選定である。

## Decision

IDE基盤にEclipse Theiaを採用する。初期実装はSpikeで確認した1.73.1を固定し、更新は独立した検証作業として扱う。

実装方針は次のとおりとする。

- Agent Windowは独立したnative `ReactWidget`とする。Chat、Task result、Questionだけを扱い、Change Setを表示しない。通常起動時の主入口としてshellへ配置する。
- ChangesはAgent Windowとは別のnative `ReactWidget`とする。Agent完了時には開かず、commandまたはview操作でユーザーが開く。
- Changesは対象TaskとChange Setを保持し、Code DiffとSemantic Diffを同じChange Setの2表現として切り替える。並列表示はTheia shellのlayoutで構成する。
- Code DiffはChanges内にEditorを再実装せず、`DiffUris`と`EditorManager`でTheia標準Diff Editorへ委譲する。
- Semantic ChangeのEvidenceは`EditorManager.open()`へfile URIとrangeを渡し、通常Editorで開く。
- Application Coreに`AgentProvider`と`SemanticDiffProvider`の境界を置く。Widgetは具体的なAgent Runtimeや解析実装へ直接依存しない。
- Workspace、Editor、Terminal、SCM、language機能はTheiaの既存serviceをadapter越しに利用する。製品固有のdomain modelをTheia APIへ流出させない。
- 第一完成点はTheiaのElectron targetで提供する。Electron化の実証を初期milestoneとし、成功するまで配布可能性を確定扱いしない。

## 判断理由

### 製品固有UIをcore forkなしで所有できる

[Theia Spike](../../spikes/theia/SPIKE-REPORT.md)では、Agent Windowをright area、Changesをbottom areaの別Widgetとして登録できた。Changesだけを起動時に閉じ、明示commandで開くlifecycleもContribution側で所有できた。main / left / right / bottomへの配置を製品側で選べる。

[Code-OSS Spike](../../spikes/code-oss/SPIKE-REPORT.md)でも、ChangesはActivity Barの独自View ContainerとWebview Viewで成立した。Webview Panelだけが選択肢ではない。一方、Agent WindowはEditor groupのWebview Panelであり、既定container以外の恒久領域やAgent-firstの固定layoutにはCode-OSS source forkが必要である。

Agent WindowとChangesは補助機能ではなくプロダクトの情報構造そのものである。この部分を拡張APIの配置制約に合わせるより、Theiaのapplication shell上で所有する方が設計意図に合う。

### コアUXの接続が素直である

Theiaでは`ReactWidget`から`EditorManager`、`WorkspaceService`等をDIで利用できた。Code Diffは`DiffUris`、Evidenceはselection付き`EditorManager.open()`へ直接接続でき、iframeのmessage bridgeを必要としなかった。

Code-OSSでも`vscode.diff`と`showTextDocument()`は強力だった。ただしWebview UIではHTML生成、CSP、message dispatch、extension hostとの状態同期が必要になる。主要ソースの単純な行数は構成差が大きいため判断材料にしないが、UIからIDE serviceまでの境界数はTheiaの方が少なかった。

### 更新後の責務分担と一致する

Theia SpikeではAgent WindowからChange Setの責務を除き、Changesを別Widgetとして実装できた。Changesが同一Change Setの表現選択を持ち、本格的なDiffとEvidence閲覧をEditorへ委譲する構造は、`ARCHITECTURE.md`のAgent Window / Changes / Editor分離と一致する。

`AgentProvider`と`SemanticDiffProvider`はTheia extensionのDI境界として実装できる。将来Agent Runtimeや解析方式を交換しても、WidgetとTheia service adapterを維持できる。

### core forkの長期コストを避ける

Code-OSSの公開Extension APIだけを使う場合、build、VSIX分離、Electron実動、既存機能統合は優位である。しかし第一級UIを得るためにsource forkへ進むと、workbench変更、product設定、Electron / Node、security update、installer、upstream mergeを継続管理する必要がある。この経路は今回buildしておらず、費用を過小評価できない。

Theiaにもversion追従コストはあるが、製品固有UIをextensionとapplication compositionに留め、upstream coreを直接forkしない方針を取れる。この差を優先する。

### 既存機能と配布の優位だけではCode-OSSを選ばない

Code-OSS SpikeはTerminal command、Git API、TypeScript hover、Electron workbenchを実測し、Theiaより確認範囲が広い。これはCode-OSSの明確な優位である。

一方、第一完成点は全VS Code互換、Marketplace互換、installer polishを要求しない。Theia側にもTerminal、SCM、Git、Monaco、language機能の既存構成があり、不足分を早期に実証する余地がある。差別化要素であるUI構造を妥協して既存機能の確認量だけを優先しない。

### ライセンスとextension供給を管理可能な範囲に限定できる

検証したTheia core packageは`EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0`である。Code-OSS sourceはMITだが、Microsoft配布のVisual Studio Code binaryは別製品ライセンスであり、Code-OSS forkはVisual Studio Marketplaceの利用を前提にできない。

Theia採用でもMicrosoft Marketplaceを前提にしない。Open VSXまたは再配布可能なVSIXから第一完成点に必要な言語extensionだけを固定し、Theia本体、extension、native dependencyを個別にライセンス監査する。広いMarketplace互換は第一完成点のNon-Goalとする。

## 却下した案とその理由

### Code-OSS + 公開Extension API

Changesは独自View Containerとして成立し、既存Diff、Terminal、Git、LSP、Electronの再利用性も高い。しかしAgent WindowはEditor tabのWebview Panelに留まり、Agent WindowとChangesを製品固有の恒久領域として一体設計できない。Webviewのiframe / message境界もApplication Coreとの接続を増やす。

第一完成点を短期に作るだけなら有力だが、開発の主入口を拡張機能の配置モデルへ従属させるため却下する。

### Code-OSS source fork

Workbench sourceを変更すれば、Agent Window、Changes、固定layoutを第一級Partとして実装できる。しかしsource buildを今回実測していない。独自Partの差分はupstreamのWorkbench変更と衝突し続け、product build、security update、extension gallery、installer、signingまで所有範囲が広がる。

第一完成点で必要な抽象化と運用範囲を超えるため却下する。

## 想定される長期的な弱点とその緩和策

| 弱点 | 緩和策 |
|---|---|
| Electron targetを実証していない | 最初の基盤milestoneでWindows Electron build、起動、Repository open、native dependency rebuildをCI化する。失敗を機能実装後まで持ち越さない。 |
| Node / native module / bundlerの組み合わせが重い | Node、npm、Theia、Electronを固定する。Spikeで必要だったwebpack fallbackとWindows CA module回避を暫定措置として記録し、upgradeごとに削除可否を確認する。 |
| Terminal / Git / LSPの実測がCode-OSSより浅い | Agent実装前にTerminal command、Git diff / stage / restore、対象言語のhover / diagnostics / definitionを自動smoke化する。未達なら機能別に既存Theia extension、VS Code extension、CLI adapterを選ぶ。 |
| VS Code extension互換が完全ではない | 第一完成点の言語とextensionを限定し、Open VSX / curated VSIXをversion固定する。互換性試験を配布物に対して実行する。 |
| Theia APIとshell内部への結合が増える | `WorkspaceService` / `EditorService` adapterとApplication Coreを境界にする。可能な限り公開APIを使い、UI layoutとdomain logicを分離する。 |
| Code Diff / Semantic Diffの並列layoutが未検証 | Changesの次のvertical sliceで、標準Diff EditorとSemantic Diff Widgetをshell上に並べ、同じChange Set IDと選択状態を共有する試験を先に行う。 |
| dependency treeと脆弱性対応の負担がある | production dependencyとbuild toolを分離し、lockfile、license inventory、脆弱性scan、定期upgrade cadenceを持つ。Spikeで残ったaudit結果を無視して出荷しない。 |
| Theia ecosystemが必要な言語・debuggerを満たさない可能性がある | 第一完成点の対象言語を先に固定する。満たせない機能が中核なら、このADRを再評価し、Code-OSS extension経路を代替候補とする。 |

## 第一完成点までの実装上の影響

| DoDカテゴリ | すぐ利用できるもの | 作る・追加検証するもの |
|---|---|---|
| Workspace | Theia Workspace、File、Monaco Editor、Terminal、SCMの既存UI | Electron上のRepository open、編集、Terminal実行、Git操作を実証し、Application Core向けadapterを作る。 |
| Agent | Terminal / process、Workspace file service | `AgentProvider`、session、tool event、cancel、権限制御、失敗時の復旧、Taskとの紐付けを作る。 |
| Agent Window | Spikeの独立`ReactWidget`、shell配置、起動lifecycle | 実チャット、streaming、Task result、cancel状態、永続化を`AgentProvider`へ接続する。Change Set表示は追加しない。 |
| Question | Agent Window内の既存actionと表示枠 | 対象Task / session contextを保持し、追加質問を通常chat flowへ戻す。 |
| Change Set | Workspace、file watch、Git diffの基盤機能 | Task開始時Baseline、終了時snapshot、複数turnの集約、未追跡fileを含むActual Change取得を作る。 |
| Changes | Spikeの独立Widget、手動open、Code / Semantic切り替え、標準Diff起動 | Task / Change Set選択、実データ接続、並列layout、表示状態保持を作る。Agent完了から自動openしない。 |
| Semantic Diff | EvidenceからEditorへ移動するUI経路 | `SemanticDiffProvider`、構造解析、IntentとActual Changeの分離、Evidence validation、不明 / confidence表現を作る。 |
| Editor Integration | `DiffUris`、`EditorManager.open()`、range navigation | Changes / Agent Windowへ戻る導線、focus管理、Code Diffと本格Editorの役割分離を仕上げる。 |
| Practical Use | browser applicationのbuildと新UX smoke | Electron package、Workspace recovery、data loss対策、長時間smoke、1〜2週間の実プロジェクト試用を完了する。 |

この決定により、第一完成点ではIDE基盤の再実装を避け、Agent Window、Task / Change Set、Changes、Semantic Diffに実装を集中する。
