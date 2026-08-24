# Theia Electron Target 実証レポート

> Historical note (2026-08-23): このレポートのUI検証は旧「Agent Window／Changes」構成に対するものである。Electron基盤の実証結果として保持し、現行Agent／Results／Code shellの合格証跡には使用しない。

## 結論

Theia 1.73.1 の Windows Electron target はビルド、native dependency rebuild、実起動、poiesis Repository の Workspace open、新しいコア UX の操作まで実証できた。ADR 0001 が最初のマイルストーンとした「Electron target を未実証」のリスクは、開発 build と起動の範囲では解消した。

インストーラー生成、署名、配布物からの更新、GitHub Actions 上での実行は未実証である。

## 実測環境

- 実施日: 2026-08-16
- OS: Windows 11 の managed headless 環境
- Node.js: v24.14.1
- npm: 11.11.0
- Theia: 1.73.1
- Electron: 39.8.7
- 起動検証: remote debugging port 9334 と Puppeteer CDP

CI は要求環境に合わせて Node.js 24.5.0 に固定した。ローカル実測は同じ Node 24 系の v24.14.1 である。

## 判定

| 確認項目 | 判定 | 実測と根拠 |
| --- | --- | --- |
| Electron build | 達成 | `npm run build:electron` が exit code 0。frontend、Monaco worker、secondary window、preload、backend の webpack build がすべて成功した。`electron-app/package.json` の `theia.target` は `electron`。 |
| native dependency rebuild | 達成 | `npm run rebuild:electron` が exit code 0。`native-keymap`、`keytar`、`drivelist`、`node-pty` を Electron ABI 向けに処理し、`drivelist`、`keytar`、`native-keymap` の build が完了した。最終 build でも rebuild 済み判定と native assets の bundle を確認した。 |
| Electron 起動 | 達成 | `npm run smoke:electron` が exit code 0。user agent に `Poiesis/0.0.0` と `Electron/39.8.7`、window title に `{workspace} - Poiesis` を取得した。終了後は CDP を閉じ、process tree を停止した。 |
| Repository open | 達成 | Electron にリポジトリルートを Workspace 引数として渡した。window title が Workspace 名と `Poiesis` を示し、Workspace 相対の `spikes/theia/sample-src/auth-service.ts` と before file を開けた。 |
| Agent Window | 達成 | 起動時に独立 Widget を表示した。アクションは「質問」1個だけで、クリック後にモック質問欄を確認した。Change Set 表示責務は持たない。実装は `agent-window/src/browser/agent-window-contribution.ts` と `agent-window-widget.tsx`。 |
| Changes の手動 open | 達成 | 起動直後に `.poiesis-changes` が存在しないことを確認した。Status Bar の `IDE Changes` をユーザー操作相当でクリックし、bottom area の `ChangesWidget` を開いた。Agent 完了時の自動表示はない。実装は `changes-contribution.ts`。 |
| Code Diff / Semantic Diff | 達成 | Change Set ID `task-auth-redis-001` の Code Diff 表現を確認し、`DiffUris.encode` と `EditorManager.open` による Theia 既存 Monaco Diff Editor を開いた。その後 Semantic Diff へ切り替え、同一 Change Set の意味表現を確認した。実装は `changes-widget.tsx`。 |
| Evidence jump | 達成 | Semantic Diff の Evidence をクリックし、`auth-service.ts` タブと active line number `12`、状態文「根拠コードの 12 行目を Editor で開きました。」を確認した。API は `EditorManager.open` の `selection`。 |
| Terminal | 一部達成 | `Ctrl+Backquote` により統合端末の `cmd` タブが生成され、terminal service channel も起動した。CDP から xterm の入力 DOM を取得できず、端末内コマンドの入力と出力ファイル生成は未確認。 |
| Git | 達成 | poiesis の Git 状態を Status Bar から読み取り、branch `main*` と同期状態 `0↓ 1↑` を取得した。Source Control を提供する built-in Git extension と `@theia/scm` の結合が Electron でも動作した。 |
| LSP | 達成 | Evidence で開いた TypeScript ファイル上で hover を実行し、`AuthService.rotateRefreshToken(userId: string, token: string): Promise<void>` を取得した。download 済み `vscode.typescript-language-features` が Electron plugin host で動作した。 |

最終の `npm run smoke:electron` は 16.8 秒、exit code 0 だった。OS credential store、Crashpad、OS crypt に managed session 固有の警告が出たが、Workbench と検証項目の動作は継続した。

## 実装構成

- `electron-app/package.json`: browser app と同じ Theia extension 群に `@theia/electron` を加えた application package
- `electron-app/webpack.config.js`: 生成 webpack config の利用、parallelism 2、`@vscode/windows-ca-certs` fallback
- `scripts/run-electron-rebuild.mjs`: Electron ABI 向け rebuild の再現可能な入口
- `scripts/build-electron.mjs`: rebuild と Theia development bundle の直列実行、Node heap 4 GB
- `scripts/local-electron-homedir.cjs`: node-gyp home と Electron download cache を workspace 配下へ限定
- `scripts/smoke-electron.mjs`: Electron executable の直接起動、CDP UI 操作、結果出力、process cleanup

## native rebuild とビルドで詰まった点

### Electron download cache

Electron 39 の installer は `ELECTRON_CACHE` ではなく `electron_config_cache` を参照する。既定の `C:\Users\owner\AppData\Local\electron\Cache` は managed 環境で利用できなかったため、`.electron-cache/` に固定した。

### node-gyp home

`@electron/rebuild` は `os.homedir()/.electron-gyp` を利用し、既存 `.npmrc` の `devdir` だけでは workspace 外への書き込みを避けられなかった。preload script で rebuild process の `os.homedir()` と `@electron/get` の cache root を workspace 配下へ限定した。

### Windows bundler

browser target と同様に、この managed 環境では native `esbuild.exe` の workspace 読み取りに制約があるため webpack を使用した。`@vscode/windows-ca-certs` の native build は Visual Studio Spectre library を要求したため bundle では無効化し、Electron / Node の CA handling を使う。Electron でも browser target と同じ回避が必要だった。

中断時の高メモリ疑いに対して、webpack `parallelism` を 2、Node heap を 4 GB に制限した。最終 build は 17.9 秒で exit code 0 となり、OOM は再現しなかった。

### Electron の起動と user data

Theia の user data option は `--electronUserData` である。さらに single-instance lock は Theia がこの値を設定する前に取得されるため、スモークでは Chromium の `--user-data-dir` も同じ一意パスへ指定した。`theia start` の fork を介さず Electron executable を直接起動することで、CDP と process tree の寿命を確実に管理した。

## CI

`.github/workflows/theia-electron-windows.yml` を追加した。`windows-latest` で次を実行する。

1. Node.js 24.5.0 を設定する。
2. npm cache と Electron 39.8.7 download cache を復元する。
3. `npm ci` と `npm run download:plugins` を実行する。
4. `npm run validate:source` を実行する。
5. `npm run build:electron` で native rebuild と bundle を実行する。
6. `npm run smoke:electron` で Electron 起動とコア UX を検証する。

ローカルでは同じ npm script 列の build と smoke が成功した。GitHub Actions 自体はこのセッションから実行していない。CI は Node 24.5.0、cold runner、cache restore、GitHub-hosted Windows の desktop session という差がある。特に Electron window と CDP が hosted runner session で利用できるかは初回 Actions 実行で確認する必要がある。job timeout は 45 分とした。

## ADR 0001 のリスク解消状況

- Windows Electron development build: 解消
- native dependency rebuild: 解消
- Electron 実起動: 解消
- Repository open: 解消
- Agent Window / Changes / Diff / Evidence の Electron 上の結合: 解消
- Git と TypeScript language feature: 解消
- Terminal 表示: 解消
- Terminal コマンド実行: 未解消
- GitHub Actions 上の実行: 定義済み、未実行
- installer、署名、更新、配布: 未解消

第一完成点の機能実装を Electron 未実証のまま進めるリスクは下げられた。次の基盤マイルストーンは CI 初回実行の安定化と、配布 artifact の生成・署名方針の検証である。
