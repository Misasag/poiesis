# Poiesis

Poiesis is an experimental desktop IDE for working with coding agents while keeping the underlying changes understandable. It lets you move from Agent to Results to Code only as deeply as the task requires.

Poiesis は、AI にコードを書かせながら、人間が必要な深さだけシステムを理解できるようにする IDE です。開発の入口となる `Agent`、作業結果と意味の変化を確認する `Results`、根拠となる実コードを調べる `Code` の 3 層を、同じウィンドウ内で行き来できます。

## 現在の状態

個人で開発しているプロジェクトです。Windows を優先して開発・検証しています。macOS 向けビルドも GitHub Releases で提供しますが、現在は実機検証中です。

## インストール

[GitHub Releases](https://github.com/Misasag/poiesis/releases) から利用する OS と CPU アーキテクチャに合うファイルをダウンロードしてください。

配布バイナリにはコード署名を行っていません。

- Windows: 初回起動時に Microsoft Defender SmartScreen が表示された場合は、「詳細情報」から「実行」を選ぶ必要があります。Smart App Control が有効な環境では実行できません。自動更新は Windows 版のみ対応しています。

- macOS: 未署名かつ未公証のため、そのままでは Gatekeeper に止められます。「システム設定」→「プライバシーとセキュリティ」から対象アプリの「このまま開く」を選ぶ必要があります。macOS 版は自動更新に対応していません。

これらの警告を避けるために OS のセキュリティ機能を無効化することは推奨しません。

## 開発ビルド

Node.js 24 と npm 10 以降を用意し、リポジトリのルートで次を実行します。built-in VS Code extensions の取得にはネットワーク接続が必要です。

```powershell
npm install
npm run download:plugins
npm run build:electron
npm run start:electron
```

公開リリースとローカル更新 feed の手順は [RELEASING.md](RELEASING.md) を参照してください。

## ライセンス

[MIT License](LICENSE)
