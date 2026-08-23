# Lens UI specifications

`agent-window-spec.html`は、Agent／Results／Codeの画面モック、番号付き注釈、操作結果、状態保持、画面遷移を一緒にレビューするための自己完結型HTMLである。

表示は1600×900を基準にしたベージュ系の一枚絵とし、ページと項目一覧のどちらにもスクロールを発生させない。補足情報はHTML内に保持しても、レビュー画面では番号を選択した項目だけを展開する。

## 開き方

`agent-window-spec.html`をブラウザで直接開く。Web serverやpackage installは不要。

## 更新方法

1. 採用候補の画面画像を`assets/`へ置く。
2. `agent-window-spec.html`末尾の`SCREENS`へ画面を追加する。
3. 各項目の番号、画像上の座標`x`/`y`（%）、操作、結果、状態保持を記載する。
4. 未確定の画面は`status: "planned"`、確定後は`decided`とする。

画像は生成時の一時ディレクトリや`_codex/`を参照せず、設計書と一緒に版管理できる`docs/ui/assets/`へコピーする。

## 画像の来歴

`assets/agent-default.png`は実装済み画面のスクリーンショットではなく、設計検討用の生成モックである。

現在のAgent画面仕様はこの画像を表示に使用せず、`agent-window-spec.html`内のHTML/CSSで直接描画している。画像は初期検討時の参照資料としてのみ残している。

左サイドバーはCursor Agents Windowを参考に、通常の`Agent`／`Results`では`New Chat`、Agent会話の横断`Search`、`Workspaces`と配下のSessionを配置する。Window単位で折りたため、折りたたみ時も`New Chat`、`Search`、再展開操作をアイコンレールに残す。`Agent`と`Results`は同じSessionから開ける独立タブとして隣接配置し、会話を共有しない。Agentは人間が作業者AIへ指示する場、Resultsは終了またはキャンセルされた実行Taskを手掛かりに成果を確認する場とする。実行Taskの開始・終了・キャンセル、Baseline、Change Setはアプリが管理する。Resultsでアプリが固定するのは実行Taskの切替リスト、本体キャンバス1つ、その下の短いComposerだけで、第一完成ではキャンバスにSkillsが返すHTML文書を1つ表示する。何を一つの見どころとして分類するかとHTML文書の内部構成はSkillsが決め、実行Taskとの1対1を要求しない。Markdownは必須形式にせず、将来の入力形式またはHTMLへ変換するSkillとして追加できる。`Code`は別画面への遷移ではなく同じWindowのモード切替とし、押すと左サイドバーの一つの席をFiles／Source Control（コード検索を含む）へ、中央をEditorへ切り替える。Session一覧とファイルツリーは同時に表示せず、`Code`をもう一度押すか`Agent`を押すまで自動では戻らない。選択Session、Editorのtab、Resultsの状態は切替後も保持する。

- 出発点: Theia browser appで実際に描画したD1-Bスクリーンショット
- 作成方法: Codexの組み込み画像生成機能による複数回の編集生成
- モデル指定: CLI/APIの`gpt-image-2`は明示指定していない。組み込み機能の内部モデル名は今回の生成結果では公開されていない
- 用途: 情報設計と操作導線のレビュー。ピクセル精度や実装済み状態の証拠には使用しない
