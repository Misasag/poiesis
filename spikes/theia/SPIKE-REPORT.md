# Theia Technical Spike Report

> Historical note (2026-08-23): このレポートは旧「右Agent Window／下部Changes」構成の技術検証記録である。現在の製品仕様は `docs/FIRST-COMPLETION.md`、`docs/UX.md`、`docs/ui/agent-window-spec.html` を参照する。

## 結論

Theia 1.73.1をNode.js 24.5.0 / npm 11.11.0 / Windows上で再ビルドし、新仕様のコアUXをヘッドレス操作で確認した。

Agent Windowは右側の独立`ReactWidget`としてChat / Task result /「質問」のみに限定した。Changesは別の`ReactWidget`として底部areaへ登録し、起動時には開かず、ユーザーがCommand PaletteまたはView menuから開く。Changesから同じChange SetのCode DiffとSemantic Diffを切り替え、Code Diffは`DiffUris`と`EditorManager`でTheia既存のMonaco Diff Editorへ委譲し、Semantic DiffのEvidenceから通常Editorの12行目へ移動できた。

新チェックリスト1〜6は達成。Terminal / Git / LSPは前回結果を引き継ぎ、一部達成とする。

## 新検証チェックリスト

| # | 項目 | 判定 | 根拠 |
|---:|---|---|---|
| 1 | Repositoryを開ける | **達成** | `browser-app/package.json`のstart commandが`spikes/theia/`をWorkspaceとして開く。HTTP 200とWorkspace内ファイルのEditor表示を再確認した。使用API: `WorkspaceService.tryGetRoots()`、`WorkspaceService.workspace`。 |
| 2 | Editorを表示する | **達成** | `sample-src/auth-service.ts`と既存Diff Editorを表示し、Evidence操作後に`auth-service.ts` tabとMonacoのactive line `12`をCDPで確認した。使用API: `EditorManager.open()`。 |
| 3 |独自Agent Windowを表示する | **達成** | `agent-window-widget.tsx`を右areaへ起動時表示。初期actionは`質問`の1件だけで、Agent Window sourceとDOMにChange Set / Semantic Diff表示がないことを検証した。使用API: `ReactWidget`、`AbstractViewContribution`、`FrontendApplicationContribution`。 |
| 4 | 独自Changes領域をユーザー操作で開ける | **達成** | `changes-widget.tsx`をAgent Windowとは別の底部`ReactWidget`として登録。起動直後はDOMに存在せず、Command Paletteの`Poiesis: Open IDE Changes`を実行後に表示された。使用API: `AbstractViewContribution.openView()`、`CommandRegistry`、ApplicationShell bottom area。 |
| 5 | 同じChange SetをCode Diff / Semantic Diffで確認する | **達成** | Changes内のtabで`task-auth-redis-001`の2表現を切り替えた。Code Diffは`DiffUris.encode()`と`EditorManager.open()`で既存Monaco Diff Editorを開き、CDPでdiff editor DOMと`Change Set: auth-service.ts` tabを確認した。Changes内にEditorは再実装していない。 |
| 6 | Semantic DiffからEvidenceへジャンプする | **達成** | ChangesのSemantic Diffから`sample-src/auth-service.ts`を開き、status、Editor tab、Monaco active line `12`を確認した。使用API: `EditorManager.open(uri, { selection })`。 |
| 7 | Terminal / Git / LSPの既存機能を確認する | **一部達成** | 前回確認を引き継ぐ。Terminal / SCM / Git / TypeScript built-in pluginsを構成・起動し、Terminal tabとSource Control surfaceを確認済み。Terminal command実行、Git stage操作、LSP hover / diagnosticsはTheia側では未実施のため一部達成のままとする。 |

## 実装と使用API

### Agent Window

- `agent-window/src/browser/agent-window-widget.tsx`
  - `ReactWidget`。
  - Task resultと質問UIのみ。
  - Editor / Workspace / Change Setへの依存を持たない。
- `agent-window/src/browser/agent-window-contribution.ts`
  - `AbstractViewContribution`。
  - right areaへ配置。
  - `initializeLayout()`でAgent Windowだけを起動時表示。

### Changes

- `agent-window/src/browser/changes-widget.tsx`
  - Agent Windowとは別の`ReactWidget`。
  - Change Set ID、Code Diff tab、Semantic Diff tabを所有。
  - `DiffUris.encode()`でbefore / after URIをTheia標準diff URIへ変換。
  - `EditorManager.open()`で既存Diff EditorとEvidence Editorを開く。
- `agent-window/src/browser/changes-contribution.ts`
  - bottom areaへ登録。
  - `FrontendApplicationContribution`には登録しないため自動表示しない。
  - View menuのtoggleに加え、`Poiesis: Open IDE Changes` commandを提供。
- `sample-src/auth-service.before.ts` / `auth-service.ts`
  - 同じダミーChange Setのbefore / after。

## 実施した確認

| 操作 | 結果 |
|---|---|
| `npm run validate:source` | exit code 0 |
| `npm run build` | exit code 0。frontend、Monaco worker、secondary window、backendのwebpack compilationが成功 |
| `npm start` | Theia backendが`127.0.0.1:3000`で起動 |
| HTTP request | status 200 |
| `npm run smoke:ui` | exit code 0。新しいChanges導線をCDPで操作 |
| 終了処理 | server processを停止 |

新スモークテストの主要実測値:

```text
changesVisibleBeforeOpen: false
initialAgentButtonLabels: [質問]
questionVisible: true
changeSetId: task-auth-redis-001
initialCodeDiffVisible: true
native Monaco Diff Editor: true
semanticDiffVisible: true
evidenceStatus: 根拠コードの 12 行目を Editor で開きました。
editorTabs: Change Set: auth-service.ts / auth-service.ts / IDE Changes / Agent Window
activeLineNumbers: 12
```

## Changes領域の表現力に関する所見

TheiaではChangesを通常EditorともAgent Windowとも異なるshell Widgetとして素直に表現できた。`AbstractViewContribution`の配置先をmain / left / right / bottomから選べるため、今回のbottom areaから製品レイアウトへ発展させやすい。表示 lifecycleもContribution側が所有し、Agentの完了イベントから独立させられる。

Code DiffをChanges Widget内へ埋め込まず、`DiffUris`で既存Monaco Diff Editorへ委譲できた。Changes WidgetはChange Setの選択と表現切り替えを担当し、本格的なコード比較はEditor側へ残せる。この責務分担は更新後のArchitectureと一致する。

一方、Code DiffとSemantic Diffを完全に同じ矩形内で並列表示する場合は、既存diff Widgetを子Widgetとして組み込むかshell layoutを構成する追加検証が必要である。今回達成したのは、Changesから同じChange Setの2表現を切り替え、Code Diffだけ既存Editorへ開く経路である。

## Terminal / Git / LSP

### Terminal

`@theia/terminal`と`@theia/terminal-search`を利用し、`cmd` tabの生成まで前回確認済み。実コマンド入出力は未検証。

### Git

`@theia/scm`、`@theia/scm-extra`、`@theia/git`と`vscode.git` built-in pluginを構成し、Source Control surfaceまで前回確認済み。diff / stage / unstageは未検証。

### LSP

`@theia/monaco`、`@theia/languages`、TypeScript built-in pluginsを構成している。TypeScript Editorは開けたがhover / diagnostics / completionは未検証。

## 詰まった点と回避

- Native esbuildは管理対象sandboxでWorkspaceを読めなかったため、前回追加したwebpack build pathを継続利用した。
- `@vscode/windows-ca-certs`はSpectre libraries不足でrebuildできないため、optional moduleをwebpack aliasで無効化した。
- npm / node-gyp / Theia configの書き込み先はspike配下へ固定した。
- Changesの自動生成toggle command名はCommand Palette automationで安定しなかった。製品としても明示的な入口になる`Poiesis: Open IDE Changes` commandを追加して解決した。
- Evidence操作後はbottom Widgetがfocusを持つ場合があり、Monacoのactive-line classとEditor tabの両方をスモーク証跡として確認した。

npm auditの52件は前回から未解消であり、採用時はdependency更新とproduction dependencyの監査が必要。

## 未確認範囲

- 人間によるレイアウト、リサイズ、keyboard navigation、accessibilityの評価。
- Code Diff / Semantic Diffの並列layout。
- Terminal / Git / LSPの未実施操作。
- Electron packageとdesktop起動。
- 大規模Repository、長時間運用、Theia / VS Code plugin更新互換性。

## Electron化の見通し

TheiaはbrowserとElectron targetを持ち、今回のfrontend Widgetは概ね共有できる。Electron application composition、native ABI rebuild、installer / signing、Windows filesystem / CA / proxyは未検証である。

## 基盤適性の一次所見

新仕様では適性がさらに明確になった。Agent WindowとChangesを別々のnative Widgetとして定義し、一方だけを自動表示できる。ReactWidgetからWorkspace / Editor serviceへ直接依存注入でき、iframe message bridgeなしでChange Set UIとEvidence navigationを接続できた。

弱点は重いdependency tree、Node / native module / bundlerの組み合わせ管理、Electron未検証、VS Code extension compatibilityの差である。Phase 3では、Changesのshell配置自由度をTheiaの強みとして、Code-OSSのView Containerの安定API・既存機能実測・配布容易性と比較する。

## 再現手順

```powershell
cd C:\Users\owner\github\poiesis\spikes\theia
$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm install
npm run download:plugins
npm run build
npm start
```

server起動中に別PowerShellで:

```powershell
npm run smoke:ui
```
