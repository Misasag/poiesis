# PRODUCT.md

## Product Vision

AIにコードを書かせながら、人間が必要な深さだけシステムを理解できるIDEを作る。

このIDEは、従来の「Editor中心 + AIチャット」ではなく、Agentとの対話を開発の主な入口にする。普段はコードを深く見なくても開発を進められ、必要になったときだけ、

1. AIの作業結果
2. システム上の意味の変化
3. 根拠となる実コード

の順に深く入れる。

## Problem

AIによる開発では、コード生成速度が人間の理解速度を上回りやすい。

その結果、

- AIが誤った設計・実装をしても気付きにくい
- 生成されたコードを毎回すべて読むのは現実的ではない
- AIの報告書を読むだけでは人間が受動的になりやすい
- チャットによる説明は一時的で、理解がプロジェクト知識として残りにくい
- Agent、成果確認、Editorの文脈が別画面へ分断されやすい
- 「理解のための専用画面」は教育的になり、使われなくなる

という問題が起こる。

## Core Idea

第一完成点の現行契約は[「First Completion Goal」](FIRST-COMPLETION.md#first-completion-goal)を正とする。

人間に理解を強制しない。

通常時はAgentだけを使う。AIが作業を終えても、現在のfocusを奪わず、短い結果だけを会話へ残す。

```text
Agent  作業を依頼する
  ↓ user opens Results
Results 確定した成果を見ながら質問する
  ↓ user opens Code
Code   Git差分や根拠コードを確認する
```

Taskが終了・失敗・キャンセルされたら、アプリが実WorkspaceのBaselineとの差からChange Setを確定し、Results skillを開始する。Skillは完成済みHTML文書を一つ返し、Resultsはその文書を表示する枠だけを持つ。

ユーザーは必要なときだけResultsを開く。成果について質問したい場合はResults Composerを使い、その質問と回答をAgent会話や新しい実行Taskへ混ぜない。

実コードを確認したい場合は、同じWindowのCodeモードへ切り替える。左サイドバーはFiles／Git、中央はTheia既存Editorになる。Agent／Resultsへ戻っても状態を保持する。

## Results

Resultsは、終了した実行Taskを手掛かりに成果を確認するSession内の画面である。

アプリが固定するのは次の要素だけとする。

- Task切替リスト
- 完成済みHTML文書を一つ表示するキャンバス
- 表示中のTaskとHTMLをscopeにする短いComposer

HTML文書の見出し、図、比較、引用などの内部構成はResults skillが決める。Before／After、Semantic Diff、Confidenceなどをアプリの固定UI契約にしない。

## Actual Change and evidence

Agentの回答は作業報告であり、変更の正本ではない。

アプリはTask開始前のBaselineと終了時のWorkspaceからChange Setを取得する。Results skillはChange Setを材料に成果を説明できるが、存在しない変更や根拠を作らない。

Skillが根拠を示す場合は、Workspace内のファイルと位置を引用する。引用からCodeへ移動し、Theia Editorで実コードを確認できるようにする。

## IDE Structure

Lensは一つのWindowを所有する。

```text
Lens Window
├ Agent / Results
│  ├ Workspace / Session sidebar
│  └ Agent conversation or Results canvas
└ Code
   ├ Files / Git
   └ Editor / Settings
```

CodeはTheia ApplicationShell全体をhostせず、必要なFiles／Search／Git／Editor／Terminal WidgetだけをCursor型のLens専用レイアウトへ載せる。

## Interaction Principles

### 1. Simple by default
通常時はAgentだけでよい。

### 2. Depth on demand
成果を見たいときだけResultsを開き、さらに必要ならCodeでGit差分や根拠コードを開く。

### 3. No forced education
AIから理解確認の質問をしない。理解度テストをしない。報告書を読ませない。

### 4. Human initiative
人間が「気になる」と思った瞬間の深掘りコストを下げる。

### 5. Actual code is the source of truth
AIの説明より、実際の変更を優先する。

### 6. Evidence-backed understanding
Results skillの引用から根拠コードへ辿れるようにする。

## Architecture Philosophy

DeepSeek Harnessは参照にとどめ、以下の思想だけを参考にする。

- Plugin-oriented
- Event-driven
- Capabilityごとに境界を作る
- Agent実装を交換可能にする
- UIとAgent Runtimeを疎結合にする

DeepSeek Harness、Cordis、`dsh`には依存しない。

Skillは、Grok Botのpluginと同じ発想で、bundleをinstall / removeするinstallable pluginとする。pluginはファイルを含んでよいが、disk上にlooseな`SKILL.md` filesが置かれているだけのものではない。

Skillの仕事は二つに分け、混ぜない。Agent skillはworkerがある種類の仕事をどう行うかを定める。Results skillはexecution Taskが終了した後のHTML canvasを生成する。appはTaskが完了またはcancelされたときにResults skillを開始し、Agent chatの会話途中ではResults skillを実行しない。

Orcaも参照にとどめ、Orca productをembedまたはwrapしない。第一完成点でOrcaから借りるのは、installed Agent CLIの検出方法だけとする。

Agent internalsは交換可能なままにし、UIは特定のCLIと直接話さない。第一完成点では、Agentをrewireするsettings screenを設けず、単一のruntimeをhardcodeしない。PATHとwell-known install locationsから既知のAgent CLI（例: Codex、Claude Code）を検出して一つのdefault compositionを自動で決め、見つかったCLIをimplementerとして使用する。既知のCLIが見つからない場合は、chatをstreamするだけのmockを使用する。coordinatorとimplementerをcomposeするUIは第一完成点の後に扱う。

第一完成点では、plugin install、Agent wiring、team assemblyのための新しいscreenを追加しない。既存のAgent / Results / Code frameは`docs/ui/agent-window-spec.html`の指定を維持する。

第一完成点にmarketplaceは不要である。pluginは将来local installできれば十分であり、この文書ではそのためのUIを定義しない。

## Primary User for First Completion

第一完成点では開発者本人を第一ユーザーとする。

一般公開は将来的に行うが、第一完成点の目的は、

> 自分が実際の開発で日常的に使いたいと思えるIDE

を完成させることである。

## Product Success

このIDEが成功している状態は、ユーザーが大量のコードを読むことではない。

ユーザーが必要なときに、

- 今回何が変わったか
- システムとして何が変化したか
- どこに影響するか
- なぜそう判断できるか
- 必要ならどのコードを確認すればよいか

を短時間で把握できることである。
