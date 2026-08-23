# Lens UX

## Status and source of truth

Decided for First Completion (2026-08-23).

第一完成点の完成条件は [`FIRST-COMPLETION.md`](FIRST-COMPLETION.md)、画面と操作の詳細は [`ui/agent-window-spec.html`](ui/agent-window-spec.html) を正本とする。この文書は、両者を日常的な実装判断へ変換するためのUX原則を定義する。

2026-08-16まで検討していた「右側Agent Window／下部Changes Widget」は採用しない。旧Changes実装と当時のSpike Reportは技術検証の履歴であり、現在の製品導線ではない。

## First Completion experience

Lensは一つのWindow内に次の3モードを持つ。

```text
Agent   作業者AIへ依頼し、実行状態と短い結果を見る
Results 完了・失敗・キャンセルされたTaskの成果を確認し、その成果について質問する
Code    Files／Gitと既存Editorで実コードを確認・編集する
```

AgentとResultsは同じSessionに属する別タブである。Codeは別画面への遷移ではなく、同じWindowのモード切替である。

## Principles

### Agent first

起動後はAgent Composerから作業を始められる。Editor操作を開始条件にしない。

### User-controlled depth

Task終了時にResultsやCodeへ自動遷移せず、focusも移さない。成果や差分を確認する深さはユーザーが選ぶ。

### Actual workspace is the source of truth

Agentの文章ではなく、Task開始時のBaselineと終了時のWorkspaceとの差をChange Setとする。Results skillはこのChange Setを入力に使う。

### One responsibility per mode

- Agentは作業依頼と実行中の会話を扱う。
- Resultsは確定した成果と、その成果に閉じた質問を扱う。
- CodeはFiles、Git、Editor、Settingsを扱う。

同じ機能を複数のモードへ複製しない。

### Honest controls

押しても動かないボタン、利用できないメニュー、実装予定だけの状態表示を製品UIに出さない。第一完成点の対象外の操作は、無効表示ではなく原則として隠す。

### Preserve context

Agent／Results／Codeを切り替えても、選択Session、Composer下書き、選択Task、Results質問、Editor tabと位置を保持する。

## Window structure

### Agent and Results

左サイドバーにはNew Chat、会話検索、Workspace、Session一覧を置く。中央上部にはWorkspace／branchとCode切替、右側にはAgent／Resultsタブを置く。

左サイドバーは折りたためる。折りたたみ時もNew Chat、Search、再展開、Settingsへの入口を残す。

New Chatは、選択中Sessionがまだ未送信なら新しい空Sessionを増やさず、そのAgent Composerへ戻してfocusする。会話済みの場合だけ新しいSessionを作成する。

Session行の三点メニューから、ピン留め／解除、inline rename、archiveを行う。通常一覧からの削除は誤操作防止のためarchiveとし、Archived一覧から復元または確認付きの完全削除を行う。実行中Taskを持つSessionはarchiveできない。

ピン留めSessionはRecentより上にまとめ、実行中Sessionには状態を表示する。Searchはタイトルと会話本文を対象にする。左サイドバーは196〜420pxでpointerまたはkeyboardから幅を変えられ、境界のdouble clickで既定幅へ戻す。幅、折りたたみ状態、Session一覧、タイトル、ピン留め、archive、Composer下書きは再読み込み後も復元する。

### Code

Codeへ入るとSession一覧を隠し、同じ左領域をFiles／Gitへ切り替える。中央にはTheia既存のEditorまたはSettings Widgetを載せる。ApplicationShell全体は埋め込まない。

Codeをもう一度押すと、直前のAgentまたはResultsへ戻る。Editor tabと左ペインの選択は保持する。

### Results

Resultsでアプリが固定するのは次の3点だけである。

1. Sessionに属する終了済みTaskの切替
2. Results skillが返す完成済みHTML文書を一つ表示するキャンバス
3. 選択TaskとHTMLをscopeにする短いComposer

HTML内部の見出し、図、比較、引用はSkillが決める。生成途中のHTML断片を成果として表示しない。

## Required states

第一完成点では、少なくとも次の状態を区別する。

- Workspaceなし
- Agent CLI準備中／利用可能／mock fallback
- Task実行中／完了／失敗／キャンセル
- Change Setなし／あり／取得失敗
- Results生成中／表示可能／生成失敗
- Results質問送信中／回答／失敗
- CodeでEditor未選択／選択済み

エラーを「完了」として表示しない。復旧できる場合は、状態説明の近くに再試行または戻る操作を置く。

## Accessibility and keyboard

- すべての主要操作はキーボードで到達できる。
- focus ringを消さない。
- tab、task selector、sidebar switchは対応するARIA roleと選択状態を持つ。
- streaming更新やTask終了でfocusを奪わない。
- 色だけで状態を表さない。
- 1280×720でもAgent Composer、Results Composer、Code切替が画面内に残る。

## Validation flow

第一完成点のUXは次の一連の操作で判定する。

1. 実Repositoryを開く。
2. Agentへ変更を依頼する。
3. 実行中表示を確認し、必要ならキャンセルする。
4. 完了後もAgentに留まる。
5. Resultsを明示的に開き、確定したHTML成果を見る。
6. Results内で質問し、Agent会話へ混ざらないことを確認する。
7. Codeへ切り替え、Git差分または根拠コードを確認する。
8. AgentまたはResultsへ戻り、以前の状態が保持されていることを確認する。

この流れを成立させない問題を第一完成点の修正対象とする。装飾上の改善や追加機能は、その後に評価する。
