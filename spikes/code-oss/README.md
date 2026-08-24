# Code-OSS / VSCodium Technical Spike

Code-OSS 系 workbench 上で、Agent Window を開発の主入口にする UX を検証するための自己完結した VS Code extension spike です。

この spike は Code-OSS 本体を fork / build せず、MIT ライセンスの Code-OSS 再配布ビルドである VSCodium と組み込み想定の拡張を採用しています。Agent Window はコードEditorと横並びのWebview Panel、ChangesはActivity Barの独自View Container内に置くWebview Viewです。

## 必要環境

- Windows 10 / 11 x64
- Node.js 24.5.0（今回の実測環境。他の現行 Node でも動く見込み）
- npm 11.11.0
- VSCodium のダウンロード用ネットワーク接続

Visual Studio Build Tools は不要です。

## インストール、ビルド、パッケージング

PowerShell でこのディレクトリへ移動して実行します。

```powershell
cd C:\Users\owner\github\poiesis\spikes\code-oss
npm install
npm run validate:source
npm run build
npm run package
```

`npm run package` はビルド済み拡張を `artifacts/poiesis-code-oss-spike.vsix` に作成します。`artifacts/` は生成物のため Git 管理対象外です。

## VSCodium host の取得

```powershell
npm run download:host
```

GitHub の最新 VSCodium Windows x64 ZIP を取得して `.runtime/vscodium/` へ展開します。今回の実測では VSCodium 1.126.04524 を取得しました。`.runtime/` は Git 管理対象外です。

既に host が存在する場合、このコマンドは再ダウンロードしません。別バージョンを試す場合は `.runtime/vscodium/` を削除してから再実行してください。

## 起動

```powershell
npm start
```

`poiesis` Repository を新しい VSCodium Extension Development Host で開きます。起動後、拡張が次を自動的に行います。

1. `spikes/code-oss/sample-src/auth-service.ts` を左側の Editor group に開く。
2. Agent Window を右側の Webview Panel に開く。

Changesは起動時に開きません。Activity Barの`IDE Changes`またはCommand Paletteの`Poiesis: Changes を開く`からユーザーが明示的に開きます。

終了するには VSCodium ウィンドウを閉じます。`npm start` はウィンドウが閉じるまで待機します。

## 手動確認

1. Window title に `poiesis` が表示され、Explorer で Repository が開いていることを確認する。
2. `auth-service.ts` の Editor と `Agent Window` が横並びであることを確認する。
3. Agent Windowに「質問」だけがあり、Change SetやSemantic Diffがないことを確認する。
4. 「質問」でモック質問欄が展開することを確認する。
5. 起動直後にChanges Viewが開いていないことを確認し、Activity Barの`IDE Changes`またはCommand Paletteから開く。
6. `Code Diff`でChange Set ID `task-auth-redis-001`を確認し、「既存 Diff Editor で開く」で`vscode.diff`のDiff Editorが開くことを確認する。
7. `Semantic Diff`へ切り替え、同じChange Setの意味表現を確認する。
8. 「根拠コードを開く」で`auth-service.ts`の12行目が選択されることを確認する。
9. Terminal、Source Control、TypeScript hover / completion が既存UIから利用できることを確認する。

Command Palette の `Poiesis: Agent Window を開く` で Agent Window を再表示できます。

## ヘッドレス UI スモークテスト

VSCodium host の取得と build の後に実行します。

```powershell
npm run smoke:ui
```

このスクリプトは専用 profile で VSCodium を起動し、Chrome DevTools Protocol 経由で次を検証します。

- `poiesis` Repository、コード Editor、Agent Window の表示。
- Agent Windowが「質問」だけを持つことと、質問欄の展開。
- Changesの初期非表示、Command PaletteからのWebview View表示。
- 同一Change SetのCode Diff / Semantic Diff切り替えと`vscode.diff`の起動。
- Evidence から `auth-service.ts` 12 行目へのジャンプ。
- 統合 Terminal で `POIESIS_TERMINAL_OK` をファイルへ出力する実コマンド。
- built-in Git extension の起動、Repository と working tree changes の取得。
- built-in TypeScript language-features extension の起動と hover provider の応答。

テスト終了時に VSCodium のプロセスツリーを停止します。証跡は `.runtime/smoke-proof/` に保存されます。

## 構成

```text
spikes/code-oss/
├─ src/extension.ts              # Agent Window、Changes、Editor / Terminal / Git / LSP接続
├─ media/changes.svg             # Changes View ContainerのActivity Bar icon
├─ sample-src/                   # Change Setのbefore/afterとEvidence対象
├─ scripts/
│  ├─ download-vscodium.mjs      # 最新 VSCodium host の取得
│  ├─ start-host.mjs             # 開発 host 起動
│  ├─ smoke-ui.mjs               # Electron UI と built-in 機能の実測
│  └─ validate-source.mjs        # 最小ソース契約検証
├─ package.json                  # extension manifest とコマンド
└─ SPIKE-REPORT.md               # 実測結果と基盤適性の所見
```

## 補足

- Webview には nonce 付き Content Security Policy を設定し、外部 resource を許可していません。
- VSCodium の portable data、profile、extension directory はすべて `.runtime/` 配下に固定します。
- 管理対象のヘッドレス Windows 環境では Electron の GPU / sandbox が起動できなかったため、起動スクリプトは `--disable-gpu`、`--disable-software-rasterizer`、`--no-sandbox` を指定します。通常のローカル環境で製品化する際は `--no-sandbox` を外して再検証してください。
- 詳細なアプローチ判断と、Extension API で十分な部分 / workbench ソース改変が必要な部分は `SPIKE-REPORT.md` を参照してください。
