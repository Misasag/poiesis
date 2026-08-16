# UX.md

## Status

Draft for First Completion.

この文書は第一完成点の情報設計と挙動を定義する。ビジュアルの仕上げ、一般公開向けOnboarding、高度なReview機能は対象にしない。

## 未確定事項リスト

以下はユーザー判断が必要である。推奨案はドラフト上の提案であり、この文書では確定しない。

| ID | 論点 | 案A | 案B | 推奨案 |
|---|---|---|---|---|
| D1 | Agent Windowの配置 | 右側の常設領域 | main areaの主タブ | **案A**。Editorと共存しながら、起動時のfocusと十分な幅でAgent-firstを表現できる。Theia Spikeで実証済みの配置に近い。 |
| D2 | Changesの配置 | bottom areaの独立Widget | main areaの独立Widget | **案A**。Change Setのナビゲーションを残したまま、Code DiffとEvidenceをmain areaの既存Editorへ委譲できる。 |
| D3 | Code Diff / Semantic Diffの切り替え | 2タブ + 必要時だけ並列表示 | Code / Semantic / Parallelの3モード | **案A**。通常操作を単純に保ち、並列表示を常用UIへ混ぜない。 |
| D4 | Task resultの情報量 | 要約・検証結果・未解決事項 | 要約・検証結果・変更ファイル数 | **案A**。Agent WindowにChange Setの表示責務を戻さない。Changesの存在はグローバルな状態で示す。 |
| D5 | Changesへの気付き方 | Status Barに未確認Change Set数を表示 | 通知Toastを一度だけ表示 | **案A**。作業を遮らず、ユーザーが必要なときだけChangesを開ける。 |
| D6 | 「質問」の開始方法 | 対象Task chipをComposerへ付ける | Task result直下へ一時的な入力欄を開く | **案A**。質問を通常のチャットフローへ合流させ、入力欄を重複させない。 |
| D7 | Changesを開いたときの初期表現 | Code Diff | Semantic Diff | **案A**。Actual codeを先に置き、必要なときに意味表現へ移る。 |

決定後は、採用案を本文の規定へ昇格し、代替案を削除またはDecisionへ移す。

## Design Principles

### Agent first

起動直後のfocusはAgent Windowに置く。ユーザーはEditorを操作しなくても依頼を開始できる。

### Depth on demand

通常はAgent Windowだけで進める。ChangesとEvidenceはユーザーが必要なときだけ開く。

### No forced review

Task完了時にChanges、Code Diff、Semantic Diffを自動表示しない。理解確認、強制Review、読むべき報告書を作らない。

### Actual code is the source of truth

Task resultはAgentの報告である。ChangesはWorkspaceから得たActual Changeを扱う。両者を同一視しない。

### One responsibility per area

```text
Agent Window = Chat / Task result / Question
Changes      = Change Set / Code Diff / Semantic Diff
Editor       = Code / Diff Editor / Evidence
Terminal     = Command execution
```

Agent WindowやChanges内に本格的なEditorを再実装しない。

3領域は同じshellに存在するが、一度に主focusを持つのは一つとする。並列表示はユーザーが明示した場合だけ使い、Agent Window、Changes、Editorを常時すべて展開しない。

## Default Layout

### 案A: 右Agent / 下Changes

推奨案。

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Menu / Command Palette                                               │
├──────────┬───────────────────────────────────────┬───────────────────┤
│ Activity │                                       │ Agent Window      │
│ Bar /    │ Editor                                │                   │
│ Explorer │                                       │ Chat              │
│          │                                       │ Task result       │
│          │                                       │ Question          │
│          │                                       │                   │
├──────────┴───────────────────────────────────────┴───────────────────┤
│ Changes または Terminal                                               │
└──────────────────────────────────────────────────────────────────────┘
│ Status Bar                                  Changes: 2               │
└──────────────────────────────────────────────────────────────────────┘
```

- Agent Windowはright areaに置き、起動時に表示する。
- Agent WindowはEditorの補助Sidebarではなく、初期focusを持つ作業入口とする。
- 初期幅は画面の約35%を目安とし、ユーザーがリサイズできる。
- Editorはmain areaに置く。Repositoryを開いた直後はWelcomeまたは最後のEditor状態を表示してよい。
- Changesはbottom areaの独立Widgetとし、起動時は閉じる。
- Terminalもbottom areaを利用する。ChangesとTerminalは別タブとし、同時に高さを奪い合わない。
- Status BarにはChangesの入口と状態だけを置く。Agent完了時にChanges自体を開かない。

TheiaではAgent WindowとChangesを別の`ReactWidget`としてshellへ配置する。Spikeでright area、bottom area、手動open、状態Barからのopenを実証済みである。

### 案B: main area Agent

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Menu / Command Palette                                               │
├──────────┬───────────────────────────────────────────────────────────┤
│ Activity │ Agent Window | Editor tabs                                │
│ Bar /    │                                                           │
│ Explorer │ Chat / Task result / Question                             │
├──────────┴───────────────────────────────────────────────────────────┤
│ Changes または Terminal                                               │
└──────────────────────────────────────────────────────────────────────┘
```

Agent Windowをmain areaの主タブに置く。Agent-firstは強く表現できるが、Editorとの往復がタブ切り替えになり、Evidence確認中に会話が隠れる。第一完成点では案Aより検証量が多い。

### 起動直後

起動直後は次の状態とする。

- Repositoryを一つ開いている。
- Agent Windowを表示し、Composerへfocusする。
- Chatには現在のRepository名と入力可能状態だけを示す。
- Changesは閉じている。
- Terminalは閉じている。
- 未完了Taskがある場合は、会話とTask状態を復元する。自動再実行はしない。
- 未確認Change Setがある場合もChangesは開かず、Status Barだけで状態を示す。

## Agent Window

### 通常時

Agent Windowは一つの時系列Chatと一つのComposerで構成する。

```text
┌─ Agent Window ──────────────────────────┐
│ Repository: lens                        │
├─────────────────────────────────────────┤
│ User                                    │
│ 認証をRedis方式に変更して               │
│                                         │
│ Agent                                   │
│ 認証処理を変更しました。                │
│ [質問]                                  │
│                                         │
│                                         │
├─────────────────────────────────────────┤
│ [メッセージを入力…                 ] [↑] │
└─────────────────────────────────────────┘
```

- User message、Agent message、Task resultを時系列で表示する。
- Composerは通常の依頼と追加質問で共用する。
- Change Set、ファイル一覧、Code Diff、Semantic Diffは表示しない。
- 長い会話でも最新messageと現在Taskの状態へ戻れる。
- 第一完成点では複数Agent、Thread分岐、Team Chatを持たない。

### Task実行中

Task実行中は一つの実行CardをChat内に表示する。

表示順:

1. 現在状態
2. streaming中の短いAgent message
3. 現在のtool実行
4. 完了済みstepの要約
5. Cancel

```text
┌─ Task: 認証をRedis方式へ変更 ──────────┐
│ ● 実行中                               │
│ Token保存処理を確認しています…         │
│                                         │
│ Tool                                    │
│  ✓ src/auth/auth.service.ts を読取      │
│  › npm test を実行中                    │
│                                         │
│ [キャンセル]                            │
└─────────────────────────────────────────┘
```

- streaming textは同じAgent messageへ追記する。token単位の視覚効果は必須にしない。
- tool実行はtool名、対象、状態を一行で示す。
- stdout / stderr全文は既定で畳み、必要時だけ同じCard内で展開する。
- 状態は`待機 / 実行中 / キャンセル中 / 完了 / 失敗`を区別する。
- Cancelは実行中に常時到達可能とする。押下後は二重実行を防ぎ、`キャンセル中`を表示する。
- 実行中も通常Chatの履歴は読める。別Taskの開始は第一完成点では許可しない。
- Changesを実行中に開いてもAgent Windowの実行状態を変えない。

### Task完了時

Task resultは短く、次の順で表示する。

1. 完了または失敗
2. 何を達成したかを一文
3. 重要な結果を最大3項目
4. 検証結果
5. 未解決事項がある場合だけ、その事実
6. 「質問」

```text
Agent
認証処理をRedis方式へ変更しました。

- TokenStoreへ保存責務を分離
- Refresh / Logoutの処理を更新
- 関連テストを追加

検証: 24 tests passed
未解決: なし

[質問]
```

長い実装報告、全変更ファイル、Semantic Diffは表示しない。

#### Task resultの粒度

##### 案A: 結果中心

推奨案。要約、検証結果、未解決事項だけを表示する。Change Setの存在はStatus Barの`Changes: 1`で示す。

##### 案B: 変更量を付記

要約に`5 files changed`をテキストで付記する。Changesへのbuttonやlinkにはしない。変更量へ気付きやすい一方、Agent WindowへChange Set情報が入り始める。

いずれもAgent messageにChangesへのbuttonを置かず、Task完了時にChangesを強制表示しない。

#### Changesへの気付き方

##### 案A: Status Bar

推奨案。未確認Change Setがあるときだけ`Changes: N`を表示する。選択するとChangesを開く。色とanimationで注意を強制しない。

##### 案B: Toast

Task完了時に`Change Setを作成しました`を一度だけ表示する。操作buttonは置かない。見落としは減るが、Taskごとにattentionを奪う。

### Question

「質問」は完了済みTaskを文脈にした追加質問を始める。

#### 案A: Composer context chip

推奨案。

```text
┌─────────────────────────────────────────┐
│ [質問: 認証をRedis方式へ変更 ×]         │
│ なぜTokenStoreを分けたの？         [↑]  │
└─────────────────────────────────────────┘
```

- Task resultの「質問」を選ぶとComposerへfocusする。
- Composer上部に対象Taskを示すchipを付ける。
- 送信した質問と回答は通常のChat時系列へ入る。
- chipを外すと、対象Taskを引き継がない通常messageへ戻る。
- ユーザーはTask ID、対象ファイル、変更内容を説明し直さない。
- 質問への回答は新しいTask resultにしない。
- 追加作業が必要になった場合は、Agentが新しい実行を始める前にTask状態を明示する。

#### 案B: Result内入力

Task result直下へ一時的な入力欄を開く。対象は明確だが、複数のComposerが存在し、通常Chatと操作が分かれる。

## Changes

ChangesはTaskによるActual Changeを確認する領域である。Agentの自己申告ではなく、BaselineとWorkspaceの差を表示する。

### Entry

Changesは次の入口からユーザー操作で開く。

- Status Barの`Changes: N`
- Command Paletteの`Lens: Open IDE Changes`
- View menuの`IDE Changes`
- 既に開いている場合はbottom areaの`IDE Changes` tab

Agent完了eventはChange Setを更新するが、Changesを開かず、focusも移さない。

#### Placement

##### 案A: bottom area

推奨案。Changes header、Task selector、表現切り替え、一覧をbottom areaに置く。Code DiffとEvidenceはmain areaのEditorで開く。

##### 案B: main area

Changes全体をmain areaへ置く。Semantic Diffの可読領域は広いが、Code Diffを開くたびにtab構造が増え、Agent Window / Editor / Changesのfocus設計が複雑になる。

### Open時の初期状態

- 選択対象は最新のChange Setを持つTaskとする。
- 同じsessionで前回選んだTaskが存在すれば、その選択を復元してよい。
- 表現は前回選択したCode Diff / Semantic Diffを復元する。初回はD7の決定に従う。
- 並列表示は自動で開始しない。
- 未確認状態はChangesを開いた時点では消さない。対象Change Setを表示できた時点で確認済みとする。
- Task完了順とChange Set更新時刻を混同しない。

### Task / Change Set selector

Headerに一つのselectorを置く。

```text
[ Task: 認証をRedis方式へ変更  · 完了 · 14:32  v ]
```

選択肢は新しい順に表示する。

```text
● 実行中   認証をRedis方式へ変更
✓ 完了     ログアウト処理を修正
! 失敗     セッションテストを追加
```

- 一つのTaskに一つのChange Setを対応させる。
- selectorはTask summary、状態、時刻を示す。
- 内部IDは診断情報として必要な場合だけ表示する。
- Semantic Diff Historyの検索・比較は行わない。
- 第一完成点では複数Taskを横断したChange Set統合を行わない。

### Representation switch

#### 初期表現

- 案AはCode Diffを初期表示する。Actual Changeから入り、Semantic Diffを必要時に開く。
- 案BはSemantic Diffを初期表示する。意味を先に理解しやすいが、解析中や解析不能時の初期状態が不安定になる。
- 推奨は案Aとする。ただしD7が決定するまでは確定しない。

#### 案A: 2タブ + 並列action

推奨案。

```text
[ Code Diff ] [ Semantic Diff ]                       [並列表示]
```

- Code DiffとSemantic Diffは同じChange Set IDを共有する。
- tab切り替えでTask選択、file選択、Semantic Change選択を可能な範囲で保持する。
- `並列表示`はSemantic DiffをChangesに残し、対応するCode Diffをmain areaの既存Diff Editorで開く。
- 狭いwindowでは並列actionを無効にし、tab切り替えだけを提供してよい。

#### 案B: 3モード

```text
[ Code ] [ Semantic ] [ Parallel ]
```

並列状態は明確になるが、通常の表現選択とshell layout操作が同列になり、状態管理が増える。

### Code Diff

Changes内のCode DiffはChange Setのナビゲーションを担当する。

```text
Code Diff · task-auth-redis-001

3 files changed
 M src/auth/auth.service.ts        +18 -9
 A src/auth/token-store.ts         +64
 M package.json                     +1
```

- headerにファイル数と追加・削除行の概数を示す。
- file listはpath、status、追加・削除行を示す。
- fileを選ぶとTheia既存Diff Editorをmain areaで開く。
- Diff Editorは`DiffUris`と`EditorManager`へ委譲する。
- Changes内にはsource editor、gutter、syntax serviceを再実装しない。
- 未追跡file、rename、deleteを区別する。
- binaryや表示不能fileは、その理由とmetadataだけを示す。
- file listの選択はSemantic Diffの対応Evidenceを絞り込む補助に使ってよい。

### Semantic Diff

Semantic Diffは同じChange Setを意味単位で表現する。各項目は`SemanticChange`に対応する。

#### 一覧

```text
Semantic Diff · task-auth-redis-001

1  Refresh Tokenの保存先をRedisへ変更             高
2  Token保存責務をTokenStoreへ分離                 中
3  Logout時にRefresh Tokenを失効                   不明あり
```

- 重要度順ではなく、理解に必要な因果順を優先する。
- 同順位では、基盤・依存の変化を先に、利用側の変化を後に置く。
- confidenceを品質点数として強調しない。断定可能性を伝える補助表示にする。

#### Semantic Changeの情報順

一つのSemantic Changeは次の順で表示する。

1. `title`
2. `before` → `after`
3. 責務・依存の変化
4. `affectedAreas`
5. `evidence`
6. `confidence`と不明点

```text
┌─ Refresh Tokenの保存先をRedisへ変更 ─────────────┐
│                                                  │
│ Before                                           │
│ AuthService → PostgreSQL                         │
│                                                  │
│ After                                            │
│ AuthService → TokenStore → Redis                 │
│                                                  │
│ 責務・依存                                       │
│ 保存責務をAuthServiceからTokenStoreへ分離        │
│ Redis clientへの依存を追加                       │
│                                                  │
│ 影響範囲                                         │
│ Refresh / Logout / Session                       │
│                                                  │
│ Evidence                                         │
│ auth.service.ts:82                               │
│ token-store.ts:1                                 │
│ package.json                                     │
│                                                  │
│ Confidence: 中                                   │
│ 不明: Session cleanupへの影響は未解析            │
└──────────────────────────────────────────────────┘
```

#### SemanticChange型との対応

```ts
interface SemanticChange {
  id: string
  title: string
  before?: SemanticState
  after?: SemanticState
  affectedAreas: string[]
  evidence: EvidenceRef[]
  confidence?: number
}
```

| UI | Source | 表示規則 |
|---|---|---|
| Title | `title` | 一文で意味の変化を示す。file操作の列挙にしない。 |
| Before | `before` | 存在する場合だけ表示する。構造、責務、依存、data flowを短い状態として示す。 |
| After | `after` | 存在する場合だけ表示し、Beforeと同じ観点・粒度を使う。 |
| 責務・依存 | `before` / `after` | 両状態の差から表示する。第一完成点では必須の新fieldを増やさない。 |
| 影響範囲 | `affectedAreas` | symbol、機能、data flow、設定、schema等を短いlabelで示す。 |
| Evidence | `evidence` | file、range、kindを表示し、Editorへ移動可能にする。 |
| Confidence | `confidence` | 数値を`高 / 中 / 低`へ写像する。閾値はProviderとUIで一箇所に定義する。 |
| 不明 | `warnings`または欠落状態 | 解析不能、Evidence不足、推論を明示する。空欄で断定しない。 |

責務・依存を独立fieldとして永続化する必要が生じた場合は、`SemanticChange`の変更としてArchitecture判断を行う。UI都合だけで暗黙fieldを追加しない。

#### Before / After

- 観点と粒度を揃える。
- `before`がない新規追加は`Before: なし`とする。
- `after`がない削除は`After: 削除`とする。
- 値が取得できない場合は`不明`とし、推測で補わない。
- 長いcode snippetを本文へ埋め込まない。

#### Evidence

- EvidenceはSemantic Changeの末尾に置く。
- 主要Evidenceを最大3件まで表示し、残りは展開する。
- 表示labelは`relative/path:line`を基本とする。
- rangeがある場合は開始行をlabelに使い、Editorではrange全体を選択する。
- Evidenceがない場合は`根拠を特定できませんでした`と表示する。
- EvidenceがないSemantic Changeのconfidenceを高として表示しない。

#### Confidence / Unknown

- `confidence`がない場合は`未評価`とする。
- 低confidenceは項目を隠さず、`低`と理由を示す。
- 解析不能部分は`不明`として、対象と理由を示す。
- warningはSemantic Diff全体と個別Semantic Changeを区別する。
- confidenceをユーザー理解度、Agent性能、Review合否へ転用しない。

## Editor Integration

### Evidence jump

Evidenceを選ぶと次を行う。

1. `EditorManager.open()`で対象fileをmain areaへ開く。
2. Evidenceのrangeをrevealする。
3. rangeを選択し、Editorへfocusする。
4. 短時間の非永続highlightで到達位置を示す。
5. Status BarまたはChanges内に`Evidenceを開きました`と表示する。

- fileが既に開いている場合は既存tabを再利用する。
- rangeが無効な場合はfileを開き、`位置を特定できませんでした`と示す。
- fileが存在しない場合はEditorを開かず、Evidenceがstaleであることを示す。
- highlightは通常のselectionを妨げず、数秒または次操作で消える。
- Evidence navigationは閲覧であり、fileを変更しない。

### 戻る導線

- Editor toolbarまたはCommand Paletteに`Lens: Back to Change`を置く。
- 実行すると元のChanges Widget、Task、Semantic Changeへfocusを戻す。
- Changes headerに`Agent Windowへ戻る`actionを置く。
- Agent Windowへ戻ると、対象Task resultまたは質問の位置へscrollする。
- 標準のEditor back navigationも壊さない。
- 戻るstackは直前のLens navigation一件を保証すればよい。高度な閲覧履歴は第一完成点に含めない。

```text
Semantic Change
    └─ Evidence click
          ↓
Editor: file + selected range
    ├─ Lens: Back to Change → 同じSemantic Change
    └─ Agent Windowへ戻る  → 同じTask result
```

## States and Edge Cases

### Empty Change Set

- `このTaskによるWorkspaceの変更はありません`と表示する。
- Code DiffとSemantic Diffの本文は空状態にする。
- Agentの`変更しました`という報告と矛盾する場合は警告する。
- Emptyを成功または失敗の根拠にはしない。

```text
Changes
Task: 調査のみ実施

Workspaceの変更はありません。
```

### Task failure

- Agent Windowは`失敗`、失敗した段階、再試行可能性を短く示す。
- 失敗前にWorkspace変更があればChange Setを保持する。
- Changesは部分変更であることをheaderに明示する。
- 変更の破棄、restore、retryを自動実行しない。
- 復旧操作は実装時に安全性を定義する。第一完成点で高度なrollback UIは作らない。

### Semantic Diff unavailable

- Code Diffは利用可能なままにする。
- Semantic tabは消さず、`解析できませんでした`と理由を示す。
- 一部だけ解析できた場合は、解析済み項目と`不明`領域を同時に示す。
- retry可能なら`再解析`をChanges内に置く。
- AgentのTask resultをSemantic Diffの代替として表示しない。

### Changes during execution

- Baselineから現在Workspaceまでの暫定Change Setを表示する。
- headerに`実行中・内容は更新されます`と示す。
- file変更eventでCode Diff一覧を更新する。
- Semantic Diffは最後に完了した解析結果を`暫定`として示すか、未解析なら待機状態を示す。
- 選択中のfileやSemantic Changeを可能な限り維持する。
- Agent完了時もChangesを勝手に再open、resize、focusしない。

### Stale Evidence

- Change Set生成後にfileが変わりrangeが一致しない場合、Evidenceをstaleとして示す。
- fileを開ける場合は開くが、誤ったrangeを確定的にhighlightしない。
- 再解析で更新できる場合だけ`再解析`を提示する。

## Main Flow

```text
依頼
 ↓
Task実行中
 ↓
短いTask result
 ├─ そのまま次の依頼
 ├─ 質問 → 同じChat flow
 └─ 気になったらChangesを手動open
          ↓
      Change Setを選択
          ↓
      Code Diff / Semantic Diff
          ↓
      Semantic Changeを選択
          ↓
      EvidenceをEditorで開く
          ↓
      ChangesまたはAgent Windowへ戻る
```

1. ユーザーは起動時にfocusされたAgent Windowへ依頼を書く。
2. Agent Windowはstreaming message、tool状態、Cancelを表示する。
3. Task完了後、Agent Windowは短いTask resultと「質問」を表示する。
4. Changesは自動表示されない。ユーザーはそのまま次の依頼へ進める。
5. 変更が気になった場合、Status Bar、Command Palette、View menuからChangesを開く。
6. Changesは最新TaskとCode Diffを初期表示する。
7. ユーザーはfileを選び、既存Diff Editorでコード差分を確認できる。
8. ユーザーはSemantic Diffへ切り替え、意味単位のBefore / After、影響範囲、不明点を見る。
9. 根拠が必要ならEvidenceを選び、Editorの該当rangeへ移動する。
10. `Lens: Back to Change`で元のSemantic Changeへ戻る。
11. 必要ならAgent Windowへ戻り、対象Taskを文脈に質問する。

## Wireframes

### 1. 起動直後

```text
┌──────────────────────────────────────────────────────────────────────┐
│ lens                                                    ─ □ ×       │
├───┬──────────────┬──────────────────────────────┬────────────────────┤
│   │ Explorer     │ Editor                       │ Agent Window       │
│ E │ lens         │                              │                    │
│ S │  docs/       │  Welcome / last editor       │  lens を開いています│
│ G │  src/        │                              │                    │
│   │              │                              │                    │
│   │              │                              ├────────────────────┤
│   │              │                              │ 依頼を入力…    [↑] │
├───┴──────────────┴──────────────────────────────┴────────────────────┤
│ main*                                                    Changes: 0 │
└──────────────────────────────────────────────────────────────────────┘
```

### 2. Task実行中

```text
┌──────────────────────────── Agent Window ────────────────────────────┐
│ User                                                                 │
│ 認証をRedis方式に変更して                                            │
│                                                                      │
│ Agent                                                     ● 実行中  │
│ Token保存処理を確認しています…                                      │
│                                                                      │
│ ✓ auth.service.tsを読取                                             │
│ › npm testを実行中                                                  │
│                                                                      │
│ [キャンセル]                                                         │
├──────────────────────────────────────────────────────────────────────┤
│ 実行中…                                                             │
└──────────────────────────────────────────────────────────────────────┘
```

### 3. Task完了

```text
┌──────────────────────────── Agent Window ────────────────────────────┐
│ Agent                                                     ✓ 完了    │
│ 認証処理をRedis方式へ変更しました。                                 │
│                                                                      │
│ - TokenStoreへ保存責務を分離                                        │
│ - Refresh / Logoutを更新                                             │
│ - 関連テストを追加                                                   │
│                                                                      │
│ 検証: 24 tests passed                                                │
│ [質問]                                                               │
├──────────────────────────────────────────────────────────────────────┤
│ 依頼を入力…                                                    [↑]   │
└──────────────────────────────────────────────────────────────────────┘

Status Bar: main*                                      Changes: 1
```

### 4. Changes / Code Diff

```text
┌──────────────────────────────────── Editor ──────────────────────────┐
│ Change Set: auth-service.ts                                          │
│ ┌ Before ───────────────────┬ After ───────────────────────────────┐ │
│ │ PostgreSQLへ直接保存      │ TokenStore経由でRedisへ保存         │ │
│ └───────────────────────────┴──────────────────────────────────────┘ │
├────────────────────────────────── IDE Changes ───────────────────────┤
│ [認証をRedis方式へ変更 · 完了 v]                                    │
│ [Code Diff] [Semantic Diff]                             [並列表示]  │
│ 3 files changed                                                     │
│ > M src/auth/auth.service.ts                         +18 -9          │
│   A src/auth/token-store.ts                          +64             │
│   M package.json                                      +1             │
└──────────────────────────────────────────────────────────────────────┘
```

### 5. Changes / Semantic Diff

```text
┌────────────────────────────────── IDE Changes ───────────────────────┐
│ [認証をRedis方式へ変更 · 完了 v]                                    │
│ [Code Diff] [Semantic Diff]                             [並列表示]  │
│                                                                      │
│ Refresh Tokenの保存先をRedisへ変更                         [中]     │
│ Before  AuthService → PostgreSQL                                    │
│ After   AuthService → TokenStore → Redis                            │
│                                                                      │
│ 責務    保存処理をTokenStoreへ分離                                  │
│ 影響    Refresh / Logout / Session                                  │
│ 不明    Session cleanupへの影響                                     │
│                                                                      │
│ Evidence                                                             │
│ > auth.service.ts:82                                                 │
│   token-store.ts:1                                                   │
│   package.json                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### 6. Evidence

```text
┌──────────────────────────────────── Editor ──────────────────────────┐
│ auth.service.ts                                           [戻る: Change]│
│                                                                      │
│ 80  async rotateRefreshToken(...) {                                 │
│ 81    ...                                                            │
│ 82  > await this.tokenStore.save(userId, token);  <                  │
│ 83    ...                                                            │
│                                                                      │
├────────────────────────────────── IDE Changes ───────────────────────┤
│ Refresh Tokenの保存先をRedisへ変更                                  │
│ Evidence: auth.service.ts:82                                         │
│ 根拠コードの82行目をEditorで開きました。                            │
└──────────────────────────────────────────────────────────────────────┘
```

## Accessibility and Keyboard

第一完成点でも主要操作はkeyboardで到達可能にする。

- Agent Window、Changes、Editor、Terminalへcommandでfocusを移せる。
- tab、Task selector、Semantic Change、Evidenceは意味のあるlabelを持つ。
- 実行状態、失敗、不明、confidenceを色だけで表現しない。
- streaming更新でfocusとscrollを奪わない。
- Cancel、質問、Evidence jumpはbuttonとして識別可能にする。
- focus orderは画面上の情報順と一致させる。

完全なaccessibility auditと一般公開品質は第一完成点の完成条件にしない。ただしkeyboardで主要フローを完遂できない状態は許容しない。

## First Completion Boundary

この設計に含める。

- 単一AgentのChat、実行状態、Cancel、Task result、Question
- TaskとChange Setの対応
- 手動で開くChanges
- Code Diff / Semantic Diffの切り替えと必要時の並列表示
- Evidence navigationと戻る導線
- 空、失敗、不明、実行中の状態

この設計に含めない。

- 複数Agentの協調
- Team review / approval
- Semantic Diffの履歴検索・横断比較
- 強制Review、理解度確認、教育UI
- 独自Editor、独自Diff engine
- 全言語、全extension、Remote開発への対応
- 一般公開向けOnboarding、Telemetry、Marketplace

## Validation Scenarios

第一完成点では少なくとも次を実操作で確認する。

1. 起動後、Editorへ移動せずAgent Windowから依頼できる。
2. streaming、tool実行、Cancelの状態を区別できる。
3. Task完了時に短い結果と「質問」が表示され、Changesは開かない。
4. 「質問」から対象Taskを説明し直さず通常Chatへ追加質問できる。
5. Status Bar、Command Palette、View menuからChangesを開ける。
6. 複数Taskから対象Change Setを選べる。
7. 同じChange SetのCode DiffとSemantic Diffを切り替えられる。
8. Code Diffのfileから既存Diff Editorを開ける。
9. Semantic ChangeがBefore / After、影響範囲、Evidence、confidence / 不明を表示する。
10. EvidenceからEditorのrangeへ移動し、ChangesとAgent Windowへ戻れる。
11. Empty、Task失敗、解析不能、実行中Change Setが誤解を招かない。
12. Agent完了やstreaming更新がユーザーのfocusを奪わない。
