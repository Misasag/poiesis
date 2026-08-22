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
- Agent Window、Changes、Editorの往復が思考を分断する
- 「理解のための専用画面」は教育的になり、使われなくなる

という問題が起こる。

## Core Idea

第一完成点の現行契約は[「First Completion Goal」](FIRST-COMPLETION.md#first-completion-goal)を正とする。

人間に理解を強制しない。

通常時はシンプルなAgent Windowだけを使う。AIが作業を終えたとき、基本表示は簡潔な結果だけにする。

```text
AI
認証処理を変更しました。

- Refresh Tokenの保存先をRedisへ変更
- TokenStoreを追加
- Logout時の失効処理を変更

[質問]
```

変更を確認したいときは、ユーザーがIDEのChanges領域を開く。Changes領域では、同じChange SetをCode DiffとSemantic Diffの2つの表現で確認する。

ユーザーが気になったときだけ深く入る。

```text
Level 1: Agent Window / AIの作業結果・質問
    ↓ user opens Changes
Level 2: Changes / Code Diff・Semantic Diff
    ↓ user opens Evidence
Level 3: Editor / Evidence・Code
```

ChangesはAgentの作業完了時に自動表示しない。ユーザーが必要な深さまで開く。

Changes内では、Code DiffとSemantic Diffを切り替えるか、必要に応じて並列に表示できる。

## Semantic Diff

Semantic Diffは、AIの自己申告ではなく、実際の変更を根拠に生成する。

### Intent

ユーザーの依頼・チャット・Agentの計画から得られる「何をしようとしたか」。

### Actual Change

作業前後のWorkspaceから得られる「実際に何が変わったか」。

### Semantic Diff

Actual Changeを解析し、

> 変更前と変更後で、システムの意味がどう変化したのか

を人間が理解しやすい形で表現する。

チャットはIntentの補助情報として利用できるが、Semantic Diffの一次情報にはしない。

## Semantic Diff Example

```text
変更前

AuthService
    ↓
PostgreSQL
    ↓
Refresh Token

変更後

AuthService
    ↓
TokenStore
    ↓
Redis
    ↓
Refresh Token
```

意味として変わったこと:

```text
保存場所
PostgreSQL → Redis

責務
AuthServiceが直接保存
→ TokenStoreに分離

影響
Refresh / Logout / Session
```

各Semantic Changeは、可能な限り根拠となるコード・設定・スキーマ・参照関係を保持する。

## IDE Structure

IDE内にAgent Window、Changes、Editorを共存させる。

```text
IDE
├ Agent Window
│  ├ Chat
│  ├ Task Result
│  └ Question
│
├ Changes
│  ├ Change Set
│  ├ Code Diff
│  └ Semantic Diff
│
└ Editor
   ├ Code
   ├ LSP
   ├ Git
   └ Evidence
```

Agent Windowの中にもう一つEditorを作らない。

Agent Windowは「Intent / Result / Question」を扱う場所。ChangesはActual ChangeをCode DiffとSemantic Diffで確認する場所。Editorは「Evidence / Implementation」を見る場所。

すべて同じIDE内に存在し、別の画面・アプリへ移動しなくて済むようにする。

## Interaction Principles

### 1. Simple by default
通常時はチャットだけでよい。

### 2. Depth on demand
深く知りたいときだけChangesでCode DiffやSemantic Diffを開き、さらに必要ならEditorでコードを開く。

### 3. No forced education
AIから理解確認の質問をしない。理解度テストをしない。報告書を読ませない。

### 4. Human initiative
人間が「気になる」と思った瞬間の深掘りコストを下げる。

### 5. Actual code is the source of truth
AIの説明より、実際の変更を優先する。

### 6. Evidence-backed understanding
Semantic Diffから根拠コードへ辿れるようにする。

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
