# Theia Technical Spike

Lens のコア UX を Eclipse Theia の browser application と独自 Theia extension で検証する最小構成です。Agent、Change Set、Semantic Diff はモックです。Agent Window と Changes は別の Theia Widget として実装しています。

## 前提

- Windows 10/11
- Node.js 24.5.0
- npm 11.11.0
- Git CLI（Git ビューの確認用）

## インストール

PowerShell でこのディレクトリへ移動して実行します。

```powershell
cd C:\Users\owner\github\lens\spikes\theia
$env:PUPPETEER_SKIP_DOWNLOAD = 'true'
npm install
npm run download:plugins
```

Puppeteer は Theia CLI の推移依存ですが、この browser app の build / start には Puppeteer 管理の Chrome は不要なため、install 時のダウンロードを抑止しています。

## ビルド

```powershell
npm run build
```

依存取得前でも、ファイル構成と Spike の必須実装マーカーだけは次で検査できます。これは実ビルドの代替ではありません。

```powershell
npm run validate:source
```

`npm run build` はネイティブ依存を現在の Node ABI 向けに再構築してから bundle を生成します。再構築だけを明示的に行う場合は次を実行します。

```powershell
npm run rebuild
```

この Spike は managed Windows sandbox でも再現できるよう、Theia が生成する設定を読む `browser-app/webpack.config.js` を使います。native `esbuild.exe` はこの sandbox では workspace 読み取りを拒否されたためです。通常の Windows 環境でも同じ webpack build を利用できます。

## 起動

```powershell
npm start
```

ブラウザで <http://127.0.0.1:3000> を開きます。`spikes/theia/` 自体が Workspace root として開きます。

## コア UX の確認

1. 左の Explorer で `sample-src/auth-service.ts` を選び、Editor が開くことを確認する。
2. 右側の `Agent Window` にモック結果と「質問」だけがあり、Change SetやSemantic Diffが表示されないことを確認する。
3. 「質問」でモック質問欄が展開することを確認する。
4. 起動直後に `IDE Changes` が表示されていないことを確認する。
5. Command Palette の `Lens: Open IDE Changes`、または `View > Views > IDE Changes` で底部のChanges Widgetを開く。
6. `Code Diff`でChange Set ID `task-auth-redis-001`を確認し、「既存 Diff Editor で開く」でTheiaのMonaco Diff Editorが開くことを確認する。
7. `Semantic Diff`へ切り替え、同じChange Set IDの意味表現が表示されることを確認する。
8. 「根拠コードを開く」を押し、`sample-src/auth-service.ts` の12行目がEditorで選択されることを確認する。
9. `View > Terminal`、左Activity BarのSource Control、TypeScriptファイルの言語機能を確認する。

Agent Windowを閉じた場合は`View > Views > Agent Window`から再表示できます。Changesはユーザー操作でのみ開き、Agentの作業完了時には自動表示しません。

## 任意の headless smoke test

ローカルに Google Chrome または Microsoft Edge がある場合、別の PowerShell でサーバを起動したまま実行します。

```powershell
npm run smoke:ui
```

Agent Windowが「質問」だけを持つこと、Changesの初期非表示、Command Paletteからの表示、Code/Semantic切り替え、既存Diff Editor、Evidenceから`auth-service.ts`の12行目への移動を検査します。標準以外の場所にChromeがある場合は`CHROME_PATH`環境変数で指定できます。

## 構成

- `browser-app/`: 既存 Theia extension を組み合わせた browser application
- `agent-window/`: Agent Window Widget、Changes Widget、Editor連携
- `sample-src/`: Change Setのbefore/afterとEvidence navigationの対象
- `scripts/smoke-ui.mjs`: Chrome / Edge を使う任意の UI smoke test
- `SPIKE-REPORT.md`: 実装・動作確認結果と所見
