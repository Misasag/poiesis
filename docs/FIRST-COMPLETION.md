# FIRST-COMPLETION.md

## Purpose

この文書は、2026年8月に確定したLensの第一完成点を定義する完成契約である。個人開発が無期限に続くことを防ぎ、ここに書かれた条件を満たしたら、改善余地が残っていても一度「完成」とする。

## First Completion Goal

実RepositoryをLensで開き、Agentと会話し、発見したAgent CLIを実装者として動かす。CLIが見つからなければchat-only mockで会話を成立させる。実行Taskの開始・終了・キャンセル、Baseline、実Workspace差分によるChange Setはアプリが所有する。

Taskが終了またはキャンセルされたら、アプリがResults skillを開始し、Resultsの一つのキャンバスに完成したHTML文書を表示する。ユーザーはその確定済みのデザインを見ながらResults Composerで質問でき、その会話はAgentと混ぜない。ヘッダの`Code`はモード切替であり、左サイドバーをFiles／Gitへ、中央をEditorへ切り替える。設定は左サイドバーの歯車からTheia settingsを開く。

これを自分の実開発で日常的に使える。

## Definition of Done

### Workspace

- [ ] 既存RepositoryをWorkspaceとして開ける
- [ ] Workspace内のファイルをEditorで閲覧・編集できる
- [ ] `Code`モードの左サイドバーでGitを開き、実際の差分を確認できる
- [ ] Theiaに既存のTerminal機能がある場合はそれを利用でき、Lens固有の新しいTerminal productを作らない

### Agent

- [ ] `Agent`タブから自然言語で作業を依頼し、応答を受け取れる
- [ ] 発見したAgent CLIをimplementerとして使い、見つからない場合はchat-only mockで会話できる
- [ ] 実CLIを使う場合、Agentが対象Workspaceのファイルを読み、編集し、コマンドを実行できる
- [ ] 実行中の作業をキャンセルできる
- [ ] アプリが一つの実行Taskの開始・終了・キャンセル、Baseline、Change Setを管理できる
- [ ] 実行Taskを、Agentの自己申告ではなく実WorkspaceのBaselineとの差から得たChange Setに紐付けられる

### Agent Window Chrome

- [ ] `Agent`と`Results`は同じSession内の別タブであり、会話、Composer、下書き、スレッドを共有しない
- [ ] Taskの終了やキャンセルで`Results`へ自動遷移せず、ユーザーが選んだタブのfocusを奪わない
- [ ] `Code`は別のdestinationではなく、同じWindowのヘッダで切り替えるモードである
- [ ] `Code`モードでは`Agent`／`Results`タブを隠し、`Code`をもう一度押すと直前の`Agent`または`Results`へ戻る
- [ ] `Code`モードへの切替で、左サイドバーはFiles／Git、中央はEditorになる
- [ ] 共通の左サイドバー下部に設定の歯車があり、中央にTheia／Workspace settingsを開ける
- [ ] `New Chat`は未送信の空Sessionを重複作成せず、そのComposerへ戻してfocusする。会話済みなら新しいSessionを作る
- [ ] Sessionをピン留め、rename、archiveでき、Archivedから復元または確認付きで完全削除できる
- [ ] Session一覧とComposer下書きは再読み込み後も復元できる
- [ ] 左サイドバーは196〜420pxでpointer／keyboard resizeでき、double clickで既定幅へ戻せる

Code does not host ApplicationShell; Lens hosts Files/Git/Editor widgets only.

- [ ] plugin install screenとAgent wiring screenを追加しない

### Results

- [ ] アプリが固定するResultsの枠は、実行Taskの切替リスト、本体キャンバス一つ、その下の短いComposerだけである
- [ ] 本体キャンバスにはResults skillが返した完成済みのHTML文書を一つ表示する
- [ ] アプリはHTMLをSemantic Diffの節やカードへ分解して積み重ねず、文書の内部構成をSkillsに任せる
- [ ] Before／After比較はResultsの必須契約ではない
- [ ] Taskの終了やHTML生成完了でResultsを自動表示しない
- [ ] HTML生成中は進行状態をアプリ枠で示し、不完全な文書断片を成果としてキャンバスへstreamしない
- [ ] Results Composerから、選択中の実行Taskと表示中の確定済みSkill HTMLをscopeとして質問できる
- [ ] Resultsの質問と回答はResults内だけに保持し、Agent会話、実行Task、Change Set、Skill HTMLを変更しない

### Skills

- [ ] Skillをinstall／remove可能なplugin bundleとする契約がある
- [ ] Agent skillとResults skillを分離し、Agent skillは作業方法、Results skillは成果のHTML canvas生成を担う
- [ ] アプリが実行Taskの終了またはキャンセル時にResults skillを開始し、Agent会話の途中では開始しない
- [ ] 第一完成点ではResults skillを一つbundledで提供すればよく、marketplaceやinstall UIを実装しなくてよい

### Agent Runtime

- [ ] PATHとwell-known install locationsから既知のAgent CLIを検出できる
- [ ] CodexやClaude Codeを検出対象の例とし、単一runtimeをhardcodeしない
- [ ] 検出したCLIをimplementerとして選ぶdefault compositionをアプリが決められる
- [ ] 既知のCLIが見つからない場合はchatをstreamするだけのmockへfallbackし、Workspaceのread／edit／runを装わない
- [ ] UIは特定のCLIと直接結合せず、Agent runtimeを交換可能な境界の後ろに置く
- [ ] Orca product、DeepSeek Harness、Cordis、`dsh`をembed、wrap、runtime依存しない

## Out of First Completion

以下は第一完成点の外に置き、Definition of Doneには含めない。

- 実行中Taskがある状態でのWorkspace切替
- Composerの「＋」メニュー
- Resultsのnotification dot
- Explorerのsingle click／double clickとEditor tab固定のpolicy
- Plugin Marketplace
- Agent wiring UI
- Multi-Agent compose UI

## Completion Trial

Definition of Doneを満たした後、1〜2週間、自分の実RepositoryでメインIDEとして利用する。

この期間に、Agentへ依頼し、必要な結果をResultsで見ながら質問し、必要なときだけCodeでGit差分や根拠コードを確認する一連の流れを実際に使う。他IDEへ戻った場合は理由を記録する。

修正対象にするのは、

> 第一完成点のAgent＋Results＋Code体験を成立させない問題

のみ。単なる改善案は第一完成点の後へ回す。

## Completion Rule

以下の質問にYESなら第一完成とする。

> 実RepositoryでAgentに作業を依頼し、必要なときだけResultsで確定した成果を見ながら質問し、さらに必要なときだけCodeでGit差分や根拠コードを確認する流れを、自分が日常開発に使いたいと思えるか？

YESなら完成。

「もっと良くできる」は未完成の理由にしない。

## Development Rule

開発中に新しいアイデアが出た場合、必ず以下を確認する。

> これがないと第一完成点のAgent＋Results＋Code体験が成立しないか？

YES: 第一完成点へ追加してよい。

NO: 第一完成点の後へ送る。
