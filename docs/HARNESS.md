# Poiesis ハーネス設計(v2 草案 2026-09-23)

モデルの周りを固める skills・hooks・ディスク・アプリの契約により、(1) 人間の意図を正しく汲み、(2) 長い作業で意図からずれず、(3) 成果を人間が必要な深さで理解・確認でき、(4) 生成を信じず検証で確定する——ための枠組み。基準はオーナーの設計(`~/.claude/harness/harness-design.md`、`FORMATS.md`)。本版は 3 系統の調査(`_codex/research-r1-products.md`、`research-r2-literature.md`、`research-r3-ecosystem.md`)を反映した。

## 0. 調査から得た中心原則(証拠つき)

1. **意図・版・証拠・人間判断を結ぶ小さな永続契約**が中心。巨大な常駐プロンプトや大きな仕様書そのものは理解・合意の証拠にならない。(Augment「現 commit の証拠」、Copilot Memory「引用の再検証」、DeepSeek Harness goal revision、Codex Goals)
2. **確定は外部証拠で決める。** 「テスト合格」「要件を満たす」「人間が納得」「外部操作の許可」を別々に記録し、終了コード 0 や承認クリックで相互代用しない。LLM の自己申告・自己訂正は合格にしない(強い証拠: 自己訂正実験、CodeJudgeBench)。
3. **長文脈の劣化は実在するが、固定の閾値はない**(Lost in the Middle、Chroma Context Rot)。圧縮・再開で必要なのは自由文の要約ではなく、原依頼・承認済み意図・未解決事項・変更対象・検証対象の版・次の行動(Hermes の原文保持、pi の構造化圧縮、Codex Goals の目的再注入、Anthropic の長期エージェント指針)。
4. **重い段取りは難しい仕事だけ。** Kiro の requirements→design→tasks や Factory の事前合意は有効だが、全作業に課すと重い。Anthropic はモデル更新に合わせて段取りを簡素化し、Amp は TODO 機能を削除した。仕組みの費用を測り、効かない部分は外す。
5. **重要な曖昧さは生成前に解消する**(ClarifyGPT 等、中程度の証拠)。聞くのは根幹だけで、他は仮定として記録する。
6. **Results は短い導入から証拠と実コードへ展開できる形**(レビュー理解の研究)。説得的に整えるほど未検証事項が隠れる(説明役のフィクション)ので、主張は引用で裏付け、未検証を明示する。
7. **人間の理解と欠陥発見を、速度や承認率とは別に測る**(Anthropic の AI 支援と技能形成、承認疲れの研究)。

## 1. オーナー設計への修正提案(要承認)

調査はオーナー設計の骨格(意図の保存、生成と検証の分離、説明の実コード裏付け、ディスクを正本、2 つの人間ゲート、fast/ticket)を支持した。一方、次の点は修正を提案する。

| 現行の記述 | 提案 | 根拠 |
|---|---|---|
| 生成は解決済み、ボトルネックは常に検証 | 意図の曖昧さ・情報探索・環境不備も独立した失敗要因として扱う | 失敗分析の研究(R2 §1) |
| 容量 65〜85% で急に崩れる | 固定閾値で切らず、圧縮後の情報保持を測って運用で決める | Context Rot、Lost in the Middle |
| /goal は ticket ごとに得意か苦手のどちらか | **受け入れ条件ごと**に得意・苦手を分類する(1 ticket に両方を持てる) | 実務では条件単位で性質が混在(R2 §5) |
| 途中状態は書かない(遷移ごとのみ) | 状態は遷移ごと、加えて**作業ジャーナル**(試したこと・失敗・判断)を途中でも追記し、再開に使う | Anthropic 長期エージェント、Factory の圧縮評価 |
| 食い違ったらディスクに合わせて巻き戻す | ディスク・会話・**実環境(git の変更)**の 3 者を照合し、盲目的に巻き戻さず人間か作業役に判断させる | R2 §5、planning-with-files issue |
| 人間には要約だけ、確認は二択 | 既定は要約と二択。ただし「コードと実行記録へすぐ展開できる」ことを必須にする | レビュー理解の研究 |
| hook は失敗しても止めない(草案) | **助言系の hook は失敗しても止めない、必須系(確定・ゲート)は失敗したら未検証のまま止める** | Claude Code / Codex / Cline の hook 契約 |

## 2. ハーネスの構成

### 2.1 ディスク(`<workspace>/.harness/`、オーナーの FORMATS を拡張)
- `intent/root.md`、`intent/<親id>.md`: 目的・制約・用語・棄却案・確定した決定。**原依頼の原文**と、AI が書いた要約を分けて保存する。
- `tickets/<id>.md`: 親子、三状態、受け入れ条件の一覧(条件ごとに `kind: 得意|苦手`、得意は `check` コマンド、苦手は照合文)、escalation の閾値とログ。
- `journal/<id>.md`: 作業ジャーナル(試行・失敗・判断・未解決)。再開時の材料。
- `evidence/`: 検証の実行記録(コマンド、終了コード、時刻、対象の版 = 変更集合の hash)。**Poiesis が観測したもの**を正とし、Agent の自己申告は証拠にしない。
- 承認記録: 誰が・いつ・どの版の intent / 成果を承認したか。版が変われば古い承認・合格は「古い」と表示する。

### 2.2 アプリの汎用機能(配布物)
1. **版と証拠の結び付け**: 要件(= 親)ごとに、原依頼・承認済み意図の版・受け入れ条件・対象 snapshot・検証記録・人間判断をつなぐ。既存の要件・baseline・Results 条件判定を拡張する。
2. **確定の契約**: 各受け入れ条件の状態を「未実行・合格・不合格・検証器の障害・古い」で区別して表示し、得意条件は実行記録でのみ合格、苦手条件は人間の判断でのみ確定。承認は App が版つきで記録する。
3. **Hooks(型と制御権つき、少数)**: `promptSubmit`(文脈追加・保留)、`taskStart`(再固定の注入)、`taskEnd`(証拠の受け渡し。評価や確定はしない)、`resultsGenerate`(材料)、`gateDecision`(App が記録した判断を受けて吸収案を返す)、`sessionResume`(再構成)。各 hook に task ID・baseline hash・run ID・時間上限・schema version を渡し、助言系/必須系の失敗方針を定義で選ぶ。Customize に Hooks タブ。
4. **ゲートの操作**: 意図確認(承認・修正依頼)と親の確定(確定・差し戻し)を会話と Results に置く。承認済みの同じ範囲は再確認しない。
5. **再開と要約**: 会話が長くなったら、上限で切るのではなく構造化した再開パケット(原依頼、承認済み意図、未解決、変更対象、検証対象の版、次の行動)に置き換え、ディスクへの参照を残す。
6. **Results の構成支援**: 要件ごとに「なぜ → 何を → 証拠 → 未検証 → 人間が判断すること」を固定ヘッダーと条件表で示し、各行から Code と実行記録へ展開できるようにする。
7. **適用された規則の見える化**: どの skill・hook・意図の版が使われたかをタスクと Results に表示する(既存の「適用 Skills」を拡張)。

### 2.3 ハーネス本体(この PC のみ・配布物外)
| 優先 | 名前 | 種別 / 契機 | 役割 |
|---|---|---|---|
| P0 | route-work | Skill / 新しい依頼 | 観察可能・可逆・軽いなら fast、それ以外は ticket。膨らんだら昇格 |
| P0 | capture-intent | Skill / ticket 開始 | 根幹の曖昧さだけ質問し、意図を書き起こして「こう理解しました」→承認まで実装しない |
| P0 | ticket-goal | Skill / 意図承認後 | 親子に分け、受け入れ条件ごとに得意・苦手を下書き(分類は人間が確認) |
| P0 | reanchor | Hook / taskStart, sessionResume | 原依頼・承認済み意図・アクティブ ticket・未達条件・次の行動を短く順序固定で注入。ディスク・会話・git を照合してずれを通知 |
| P0 | verify-goal | Hook + 評価 Skill / taskEnd | 得意条件のコマンドを別 context で実行し、App が記録。古い実行・無関係なコマンド・未実行は合格にしない |
| P0 | scope-check | Hook / taskEnd | 許可された範囲外の変更を検出し、昇格か確認を求める |
| P1 | evidence-results | Results Skill | なぜ・何を・証拠・未検証・判断事項の構成。主張は引用と実行記録に限定 |
| P1 | results-claim-check | Hook / resultsGenerate 後 | Results の主要主張をコードと記録に照合し、不支持を指摘 |
| P1 | parent-gate | App + Hook / gateDecision | 子の確定一覧・統合 Results・feature intent を並べて親を確定。苦手を LLM だけで通さない |
| P1 | absorb-decision | Skill / 親の確定 | 確定した決定を intent へ「今どうなっているか」で書き戻す |
| P1 | escalate-stall | Hook / 規定回数の失敗・照合不一致 | 何を試しなぜ詰まったかを短くまとめ、人間の判断を 1 つだけ求める |
| P1 | journal | Skill + Hook / taskEnd | 作業ジャーナルに試行・失敗・判断を追記 |
| P2 | post-edit-check | Hook / 編集後(間引き) | 軽いテストを先に回す |
| P2 | notify-gate | Hook / 判断待ち | 人間判断待ちだけを 1 件に束ねて通知 |
| P2 | skill-eval / improve | Skill / skill 変更時 | 候補 → 凍結ケースで比較 → 採用 → 復元可能。悪化したら採用しない |
| 既存 | delegate / verify / hx | Skill + hx | 作業を別モデルへ、判定は Jev → 別系統、費用は台帳 |

CLI 側のガード(危険操作、凍結ファイル)は、各 CLI の hook(Claude Code / Codex hooks.json / pi 拡張)へ配る。

## 3. 測るもの
誤った確定の件数、再開後の逸脱、人間が見つけた欠陥、人間の理解(確定時の質問・差し戻し率)、総費用・時間、hook の遅延と誤発火。効かない仕組みは外す。

## 4. 段階
1. **P0 契約**: 版と証拠の結び付け・確定の契約(App)と、ディスク形式の拡張。ハーネス側は route-work・capture-intent・ticket-goal。
2. **Hooks 最小集合**: taskStart / taskEnd / resultsGenerate / gateDecision と失敗方針。reanchor・verify-goal・scope-check。
3. **Results と確定ゲート**: evidence-results・results-claim-check・parent-gate・absorb-decision。
4. **再開と記憶**: 再開パケット、journal、escalate-stall。
5. **測定と自己改善**: 上の指標を台帳に取り、skill-eval で改善。

各段階は、実機のドッグフーディングと受け入れテストで確認してから次へ進む。
