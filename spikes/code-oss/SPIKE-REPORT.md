# Code-OSS Technical Spike Report

## 結論

VSCodium 1.126.04524上で組み込み想定extensionを新仕様へ改修し、Node.js 24.5.0 / npm 11.11.0 / Windowsでbuild、Electron workbench起動、CDP UI操作を実施した。

Agent Windowは従来どおりEditor groupのWebview Panelだが、Chat / Task result /「質問」のみに限定した。ChangesはAgent Windowから分離し、Activity Barの独自View ContainerにWebview Viewとして実装した。起動時には開かず、ユーザーがActivity BarまたはCommand Paletteから開く。同じChange SetのCode Diff / Semantic Diffを切り替え、Code Diffは`vscode.diff`で既存Diff Editorへ委譲し、Semantic DiffのEvidenceから通常Editorの12行目へ移動できた。

新チェックリスト1〜7は達成と判定する。

## 採用した検証経路

- Host: VSCodium 1.126.04524。Code-OSSのMITライセンス再配布build。
- Agent Window: `vscode.window.createWebviewPanel()`、`ViewColumn.Two`。
- Changes container: `contributes.viewsContainers.activitybar`。
- Changes view: `type: webview`と`registerWebviewViewProvider()`。
- User entry: Activity Barの`IDE Changes`と`Poiesis: Changes を開く` command。
- Code Diff: built-in command `vscode.diff`。
- Evidence: `workspace.openTextDocument()`と`window.showTextDocument()`。

Code-OSS本体のsource forkは今回もbuildしていない。Windows C++ Build Tools / SDK / upstream指定Nodeが必要であり、今回の新UXは公開Extension APIの範囲で検証できたためである。

## 新検証チェックリスト

| # | 項目 | 判定 | 根拠 |
|---:|---|---|---|
| 1 | Repositoryを開ける | **達成** | `scripts/host-utils.mjs`が`poiesis` Repository rootをfolder argumentとして渡す。CDP titleは`[Extension Development Host] auth-service.ts - poiesis - VSCodium`、built-in GitもRepository 1件を認識した。 |
| 2 | Editorを表示する | **達成** | `openSampleEditor()`とEvidence操作で`auth-service.ts`を`ViewColumn.One`に表示。CDPでEditor tabとactive line `12`を確認した。使用API: `workspace.openTextDocument()`、`window.showTextDocument()`。 |
| 3 | 独自Agent Windowを表示する | **達成** | `createWebviewPanel()`で`ViewColumn.Two`へ表示。CDPの初期buttonは`質問`1件だけで、Agent Webview DOMにChange Set / Semantic Diffがないことを検証した。 |
| 4 | 独自Changes領域をユーザー操作で開ける | **達成** | Activity Barに`IDE Changes` containerが存在することをCDPで確認。起動直後はChanges Webview targetがなく、Command Paletteから`Poiesis: Changes を開く`を実行後に`poiesis.changesView`が表示された。使用API: `viewsContainers`、`views`、`registerWebviewViewProvider()`。 |
| 5 | 同じChange SetをCode Diff / Semantic Diffで確認する | **達成** | Changes Webview Viewで`task-auth-redis-001`の2表現を切り替えた。Code Diffは`vscode.diff`へbefore / after URIを渡し、CDPでnative diff editor DOMと`Change Set: auth-service.ts` tabを確認した。Changes内にEditorは再実装していない。 |
| 6 | Semantic DiffからEvidenceへジャンプする | **達成** | Semantic Diffのbuttonからextension hostへmessageを送り、`auth-service.ts`の12行目を選択。Changes status、Editor tab、active line `12`をCDPで確認した。使用API: `Webview.onDidReceiveMessage()`、`Position`、`Range`、`showTextDocument()`。 |
| 7 | Terminal / Git / LSPの既存機能を確認する | **達成** | 新スモークでも再確認。Terminalで`POIESIS_TERMINAL_OK`を生成。built-in Gitはactive、Repository 1件、working tree changes 38件。TypeScript language-featuresはactive、hover result 1件。stage / unstage、completion / diagnosticsは未実施。 |

## 実装ファイルとAPI

### Agent Window

- `src/extension.ts`の`openAgentWindow()` / `renderAgentWindow()`。
- `createWebviewPanel()`を使用。
- Task resultと質問だけを表示。
- Change Set、Code Diff、Semantic Diff、Evidence message handlerを持たない。

### Changes

- `package.json`
  - `viewsContainers.activitybar`に`poiesisChanges`。
  - `views.poiesisChanges`にwebview typeの`poiesis.changesView`。
  - `poiesis.openChanges` command。
- `src/extension.ts`の`ChangesViewProvider`。
  - `registerWebviewViewProvider()`。
  - Code / Semantic tabと同一Change Set ID。
  - `vscode.diff`で既存Diff Editorを起動。
  - Evidence URIとselectionを通常Editorへ渡す。
- `media/changes.svg`
  - Activity Bar icon。
- `sample-src/auth-service.before.ts` / `auth-service.ts`
  - ダミーChange Setのbefore / after。

## 実施した確認

| 操作 | 結果 |
|---|---|
| `npm run validate:source` | exit code 0 |
| `npm run build` | exit code 0 |
| `npm run smoke:ui` | exit code 0。VSCodiumを起動して新UXと既存機能をCDP操作 |
| 終了処理 | VSCodium process treeを停止 |

新スモークテストの主要実測値:

```text
changesVisibleBeforeOpen: false
activityBarEntryVisible: true
initialAgentButtonLabels: [質問]
questionVisible: true
changeSetId: task-auth-redis-001
codeDiffVisible: true
nativeDiffEditorVisible: true
semanticDiffVisible: true
changesStatus: 根拠コードの 12 行目を Editor で開きました。
activeLineNumbers: 12
Terminal: POIESIS_TERMINAL_OK
Git: active, repositories=1, workingTreeChanges=38
TypeScript: active, hoverResults=1
```

## Changes領域の表現力に関する所見

Code-OSS Extension APIでもWebview Panelしか選べないわけではない。`viewsContainers`とwebview typeの`views`により、SCMなどと同じActivity Bar / Side Barモデルに独自Changes領域を追加できた。ChangesはEditor tabではなく、Agent Windowとも独立したViewとして表示・非表示を管理できる。新仕様の第一完成点には現実的な選択肢である。

Code DiffはWebview ViewへEditorを埋め込まず、`vscode.diff`で標準Diff Editorに委譲できた。ChangesはChange Setと表現選択を保持し、コード比較はEditor側に任せる責務分担を実現できる。

制約は、contribution可能なcontainer locationがActivity Bar / Panelなど既定workbenchモデルに限られ、任意の恒久Partは作れないこと、Webview Viewがiframeとmessage bridgeを必要とすること、Side Barでは横幅が狭いこと。ユーザーはViewを移動できるが、製品が新しいshell areaを定義するにはsource forkが必要である。

今回達成したのはCode / Semanticの切り替えである。完全な並列表示や複数Change Setの高度なlayoutは未検証。

## Extension APIで十分なこと / source変更が必要なこと

| Extension APIで十分 | Code-OSS source / product build変更が必要 |
|---|---|
| Agent messageと質問のWebview Panel | Agent Windowをeditor tabでない恒久Partにする |
| Activity Bar / Side Bar / Panelの独自Changes View Container | 既定container以外の新しいWorkbench Part |
| Code / Semantic切り替えWebview | workbench全体の固定Agent-first layout |
| `vscode.diff`とEvidence navigation | product branding、built-in allow-list、gallery、distribution設定 |
| Terminal、SCM、language provider利用 | updater、signing、installerの製品pipeline |

## Terminal / Git / LSP

### Terminal

`createTerminal()` / `sendText()`でWindows cmdを実行し、proof fileへ`POIESIS_TERMINAL_OK`を書き込んだ。表示とcommand送信は公開APIで再利用できる。構造化output取得は別のprocess境界が必要。

### Git

bundled `vscode.git` extensionをactivateし、Repositoryとworking tree changesを取得した。Source Control UIを再利用できるが、exported Git APIはcore `vscode` namespaceの安定APIではないためversion固定またはgit CLI adapterが必要。

### LSP

bundled TypeScript language-featuresをactivateし、`vscode.executeHoverProvider`の実応答を確認した。言語ごとのextension配布可否とlicense確認は必要。

## 詰まった点と回避

- Code-OSS source buildに必要なVisual Studio Build ToolsがないためVSCodium binaryを利用した。source forkのbuild / merge costは未実測。
- VSCodium profileは`VSCODE_PORTABLE`とCLI optionsで`.runtime/`へ固定した。
- 管理対象headless WindowsではElectron rendererに`--disable-gpu` / `--no-sandbox`が必要だった。製品既定にすべき設定ではない。
- PowerShell / curlのGitHub downloadはSchannelで失敗し、Node.js `fetch`へ切り替えた。
- Puppeteerの複合key入力はmodifier keyを個別に送る必要があった。

npm auditのhigh 3件はdevelopment packaging toolchainを含む。採用時はruntime dependencyと分離して監査する。

## 未確認範囲

- 人間によるSide Bar幅、移動、リサイズ、accessibility、長時間利用の評価。
- Code Diff / Semantic Diffの並列layout。
- Git stage / unstage / commit。
- TypeScript completion / diagnostics / definition navigation。
- production profileでのVSIX update / migration。
- Code-OSS source forkのbuild / package / upstream merge。
- 通常sandboxを有効にした製品build。

## ライセンス・Marketplace・運用

- Code-OSS sourceはMIT。Microsoft配布のVisual Studio Code binaryは別ライセンス製品。
- Code-OSS fork / VSCodiumはVisual Studio Marketplaceを標準galleryとして利用できない。今回のVSCodiumはOpen VSXを使用。
- Open VSXの収録範囲と各extension licenseを確認し、必要ならcurated VSIXまたはprivate registryを用意する。
- forkを選ぶ場合はElectron / Node / native module、security update、extension blocklist、installer / signingを継続管理する。

## 基盤適性の一次所見

新仕様のChangesは公開Extension APIだけで独立View Containerとして成立したため、旧仕様よりCode-OSS適性は高い。Agent Windowのeditor tab制約は残るが、ChangesまでWebview Panelにする必要はなく、SCMに近い情報領域として配置できる。

強みはElectron実動、`vscode.diff`、Terminal / Git / language機能の確認範囲、VSIX分離開発である。弱点はWebview message境界、container配置制約、Marketplace / proprietary extension制約、source fork時の保守負担である。

## 再現手順

```powershell
cd C:\Users\owner\github\poiesis\spikes\code-oss
npm install
npm run validate:source
npm run build
npm run package
npm run download:host
npm start
```

自動確認:

```powershell
npm run smoke:ui
```
