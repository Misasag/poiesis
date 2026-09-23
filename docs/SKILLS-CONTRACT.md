# Poiesis Skills bundle contract

## Status

第一完成点におけるSkillsの境界契約。marketplace、配布サーバー、install画面の仕様ではない。

## Purpose

SkillをPoiesis本体へ埋め込まれた条件分岐ではなく、install／remove／enable／disable可能なplugin bundleとして扱うための最小契約を定める。AI providerの選択とSkillの役割を混ぜない。

## Manifest

各bundleは次のmanifestを持つ。

```ts
interface SkillBundleManifest {
  id: string;
  name: string;
  description?: string;
  version: string;
  kind: 'agent' | 'results';
  entry: string;
}
```

- `id`はbundleを一意に識別する安定した値とする。
- `name`は人が読む表示名とする。
- `version`はbundle自身のversionとする。
- `kind`はAgentとResultsの責務を分離する。
- `entry`はbundleの実装entryを指す。第一完成点では読み込み方式を固定しない。

## Skill file bundle

次の4ルート直下のフォルダーをUser Skill bundleとして扱う。小さいrankを優先する。

| rank | root | source |
|---:|---|---|
| 100 | `<workspace>/.poiesis/skills` | `workspace` |
| 200 | `<workspace>/.agents/skills` | `workspace-agents` |
| 300 | `<home>/.poiesis/skills` | `user` |
| 400 | `<home>/.agents/skills` | `user-agents` |

```text
<root>/<skill-id>/
└── SKILL.md
```

entryはAgent Skills標準の`SKILL.md`と従来互換の`skill.md`を大文字小文字を区別せず探索する。同じbundleに両方ある場合は`SKILL.md`を優先し、warningを表示する。entryはYAML frontmatterとMarkdown本文で構成する。frontmatterの値は、Results Skillの`assertions`リストを除き、第一完成点では1行のscalarとする。未知のtop-level keyは無視する。

```markdown
---
name: Review checklist
description: 変更後の確認観点を定義します
metadata:
  poiesis:
    kind: agent
---

# Review checklist

ここにSkillの指示を記述します。
```

```ts
interface SkillDocumentFrontmatter {
  name: string;
  description: string;
  kind?: 'agent' | 'results';
  assertions?: string[];
  metadata?: {
    poiesis?: {
      kind?: 'agent' | 'results';
      assertions?: string[];
    };
  };
}

interface SkillDocumentBundle extends SkillBundle {
  source: 'workspace' | 'workspace-agents' | 'user' | 'user-agents';
  rank: 100 | 200 | 300 | 400;
  rootUri: string;
  skillDocumentUri: string;
  frontmatter: SkillDocumentFrontmatter;
  instructions: string;
  enabled: boolean;
}
```

file bundleのmanifestはファイルから導出する。`id`は`<skill-id>`フォルダー名、`name`／`description`はfrontmatter、`kind`はtop-levelの`kind`または`metadata.poiesis.kind`、`entry`は実際に見つかった`SKILL.md`または`skill.md`とする。`kind`がなければwarningを表示してAgent Skillとして扱う。この導出により、manifest用の別ファイルを要求せず、Agent Skills標準bundleも`SkillBundle`契約へ適合する。

同じ`id`が複数ルートにある場合は最小rankのbundleだけをpromptへ注入する。下位rankのbundleもCustomizeには表示するが、`shadowedBy`に優先bundleのdocument URIを記録し、toggleを無効にする。たとえばユーザーscopeのbundleとWorkspace scopeのbundleが同名ならWorkspaceを優先し、diagnosticsへshadowing理由を残す。

Customizeの「新しいSkill」はWorkspaceまたはユーザーscopeへこの構造をscaffoldし、画面内editorで`SKILL.md`または従来の`skill.md`を開く。保存は通常のファイル保存であり、marketplaceからのinstallではない。`enabled`はentry本文に書き戻さず、WorkspaceをまたぐApplicationのglobal storageへdocument URIをkeyとして保存する。新規作成時の既定値は`true`とする。

## Lifecycle

Application側の境界は次の4操作を提供する。

- `install(manifest)`：bundleを登録する。
- `remove(id)`：登録と保存データを削除する。
- `enable(id)`：実行対象へ戻す。
- `disable(id)`：install状態を保ったまま実行対象から外す。

この段階ではlifecycle interfaceのみを将来の配布bundle向け境界とし、marketplace、検索、download、更新UIは実装しない。Workspace file bundleのscaffold／編集をinstallと装わない。

## Role split

### Agent skill

Agent skillは作業を「どのように行うか」を定義する。prompt構成、検証手順、tool利用方針に加え、将来の委譲やmulti-agent orchestrationもこの層の責務とする。「実装を別エージェントにやらせる」のような作業パターンをAI provider設定やruntime config schemaへ入れない。

Agent skillは成果の正本を自己申告しない。Task、Baseline、Change Setの正本は引き続きApplicationが所有する。

有効でshadowされていないAgent skillはTask開始時に毎回ファイルから読み直す。順序は`rank`、`skill-id`の昇順とし、scopeによって次の二つのモードに分ける。

- Workspace scope（`<workspace>/.poiesis/skills`、`<workspace>/.agents/skills`）は、従来どおりfrontmatterを除いた本文を毎回implementer promptへ加える。
- User scope（`<home>/.poiesis/skills`、`<home>/.agents/skills`）は、frontmatterの名前・説明と絶対SKILL.mdパスだけをカタログへ加える。本文は注入しない。現在の依頼が説明に合う場合だけファイルを読み、指示に従うようimplementerへ伝える。

```text
## Workspace skills (user-defined instructions)
### <skill name>
<SKILL.md または skill.md body>

## User skills catalog (on demand)
Read and follow a listed SKILL.md only when the current request matches its description.
### <skill name>
<frontmatter description>
SKILL.md: <absolute path>
```

Workspace本文は1 Skillあたり8,000文字、Workspace本文とUserカタログ項目の合計は24,000文字を上限とする。Workspaceの個別上限では切り詰めを明記し、Userの長い本文は予算を消費しない。カタログは名前見出し・説明・パスとその改行を含む項目全体の長さを数え、途中で切り詰めない。共通の節見出しと読み込み指示は従来の本文予算の外に置く。合計上限を超える後続Skillはdiagnosticsへ理由を残して除外する。

Taskには常時適用したSkillと提示したカタログを分けて保存する。活動記録でカタログの絶対パスへの成功した読み取りを観測したときだけ、参照したSkill名をTaskへ保存する。Readと、cat／Get-Content等の明示的なファイル読み取りコマンドを対象にする。検索で見つかっただけ、失敗した読み取り、単なるパスへの言及は参照に数えない。Results 詳細は常時適用したSkillを「適用 Skills」に表示し、実際に参照したUser Agent Skillがあれば次の行に「参照: <names>」と表示する。

CustomizeではUser Agent Skillに「必要時に読み込み」を表示する。この境界はprompt contentだけに適用し、Skill本文をcodeとして実行／evalせず、provider、model、sandbox、runtime configを変更する権限を与えない。

### Skill の作成と編集

ユーザーは Customize で Skill を作成・編集します。Agent は、現在の依頼でユーザーが明示的に作成または編集を求めた場合に限り Skill を作成・編集します。

### Results skill

`builtin.ai-results`は冒頭の`<p>`で、利用者にとっての変更、Appの確認表と一致する確認状況、最重要の未確認・失敗、人間の判断事項（あれば）を2〜4文で答える。直前の内容見出しは任意。流れ・構造・状態の変更には12ノード以下の箱と矢印のインラインSVGを使う。提供された入力に実在する画像パスだけを参照し、画像を創作しない。変更前後のスクリーンショットが提供されていれば「変更前」「変更後」とラベルを付ける。コマンド・ログ・差分・依頼全文は`<details><summary>`へ畳み、根拠引用を維持する。summaryは「入力保持を確認した手順」のように内容を名付け、「詳細」だけにはしない。失敗・未確認・以前の結果・人間の判断をdetailsの中だけに隠さない。Workspace Results skillの追加ガイダンスより、このApp所有契約を優先する。

画像は`<img src="rel/path.png">`または`<img data-poiesis-image="rel/path.png">`で参照する。AppはWorkspace内の実ファイル（symlinkの参照先も検査）のみ読み込み、PNG/JPEG/WebP/GIF/SVGの内容・表示可否を検証してdata URLへ埋め込む。上限は1枚2 MiB、文書全体8 MiB、40件（Hook証拠画像を含む）。外部URL、絶対パス、範囲外、形式不一致、破損、上限超過は省略し診断を表示する。SVGファイルはサニタイズして画像としてのみ表示する。文書内と詳細パネルの画像は共通のApp所有ビューアで拡大でき、Escで閉じる。

インラインSVGはスクリプト・foreignObject・外部href・アニメーションを除去する。Mermaid runtimeは使わない。図の色は`--results-bg`、`--results-fg`、`--results-muted`、`--results-border`、`--results-accent`を使用し、明暗テーマへ追従する。`details/summary`はキーボード・フォーカス・印刷に対応する共通スタイルを持つ。

Hooks契約の`taskEnd`出力`evidence[]`に任意の`image?: string`を追加する。例: `{ "label": "変更後の画面", "status": "pass", "detail": "画面を確認", "image": "evidence/after.png" }`。最大1024文字のWorkspace相対パスを保存・Results入力へ伝達し、表示時は本文画像と同じ検証・容量制限を適用する。画像の存在はHookの合格主張そのものを証明しない。

#### Hooks の証拠と確認表

`taskEnd`の`evidence[]`の契約:

```ts
interface HookEvidenceEntry {
  label: string;
  status: 'pass' | 'fail' | 'unknown' | 'human';
  detail: string;
  image?: string;
  changeSetHash?: string;
  runId?: string;
  capturedAt?: string;
}
```

`human`は人間の判断待ちで、`detail`に空でない質問を入れる。`runId`は取得実行、`capturedAt`は取得日時（ISO 8601）で、省略時はAppが実行IDと受信日時を保存する。各任意フィールドは空でない200文字以内の文字列、日時は解釈可能な日時とする。`changeSetHash`はAppが`taskEnd`入力の`data.changeSetHash`へ渡す対象版。新しく取得した証拠はその値を返す。以前の証拠を再利用する場合は取得当時の値を維持する。省略された版をAppが現在版として補完することはない。

版は`sha256:`に続く、UTF-8の`JSON.stringify([1, ソート済みfiles, diff])`のSHA-256。取得時刻は含めず、差分取得に失敗した場合は版を発行しない。タスク表示はタスクの変更、要件表示は累積変更と比較する。異なる版は保守的に「以前の結果」とし、成功へ数えない。累積差分と個別タスク差分が違えば、個別タスクの成功も要件全体の成功へ流用しない。版がない成功や対象版を確認できない成功は「未確認」とする。この版照合はHookの真偽、成果画像の改変、未取得のWorkspace編集を証明するものではない。

Appは固定ヘッダー直下に開閉可能な確認表を表示する。確認の件数と状態にはHook証拠、確認処理の失敗、未完了の作業を数え、作業中のコマンド／ツール操作は表の下へ中立な1行で集計して確認件数に含めない。要件にHook証拠がなければ作業数を添えた「作業後の確認」の未確認行を1行だけ表示し、確認処理の失敗と未完了の作業はそれぞれ行として残す。人間の質問は古くても残し、ヘッダーの「判断待ち N件」へ含める。

確認表と同じ集計を`verificationEvidence`でResultsへ渡す。AI本文は確認表を再生成せず、その内容と矛盾しない要約を書く。冒頭で件数に触れる場合は、Appが渡す集計文（判断待ちがあればその件数も）をそのまま使う。長い入力の省略は行全体で行い、件数と省略行数を保持する。Appは正規化後に冒頭段落の存在と2〜4文、成功件数の過大申告、「すべて確認済み」等の全成功主張、失敗・未確認・古い結果や人間の判断への言及に加え、明示された分母と成功・失敗・未確認件数が表と一致するかを決定的に検査する。不合格は既存の1回再生成へ渡す。復元文書も現在の表と再照合し、本文外に警告する。これは文言・数字の検査であり、変更の意味や全ての言い換えを判定する意味評価ではない。

Results skillは終了済みTaskと確定済みChange Setを入力に、一つの完成HTML本文を生成する。本文の見出し構成、語り口、言語、図解、動作確認手順の粒度はResults skillが所有する。`builtin.ai-results`は既定で番号付きの動作確認手順を求め、有効なWorkspace Results skillは従来どおり追加ガイダンスとして後から本文構成を上書きできる。Agent会話の途中では起動せず、不完全なHTML断片をcanvasへstreamしない。Results内の質問応答は文書生成とは別のResults AI境界であり、Skill HTMLを変更しない。

根拠コードを示す引用はWorkspace相対の`file:line`または`file:start-end`とし、`<a href="#" data-poiesis-citation="file:start-end">…</a>`でクリック可能にする。Applicationはsandboxed canvasからの引用操作だけを受け取り、Workspace内に実在するファイルを検証してからCodeモードのEditorで該当行を開く。旧文書や契約に従わないAI出力のため、`cite`／`code`／`a`内のプレーンな`file:line[-range]`も互換入力として扱える。

Skill HTMLへApplication内部のTask ID、Taskタイトル、状態、完了時刻、集計diffstatを表示しない。これらはApplicationがSkill HTML外の固定ヘッダーへ表示する。

有効でshadowされていないResults skillも生成開始時に毎回読み直し、scopeにかかわらず本文を同じ区切り・rank順・文字数上限（1 Skill 8,000文字、合計24,000文字）でAI Resultsのpromptへ成果文書の追加ガイダンスとして加える。静的な`builtin.results` templateはUser Skillを解釈しないため、AI生成からtemplateへfallbackした場合はこの追加ガイダンスを反映しない。

Results Skillは、期待する成果文書を検証可能な必須条件としてfrontmatterのtop-level `assertions:`、または`metadata.poiesis.assertions:`へ宣言できる。値は`- `で始まる1行文字列（引用符付きも可）とし、1 Skillあたり最大12件、1件160文字までとする。上限を超える項目はwarningを表示して無視する。Agent Skillに宣言されたassertionsはwarningを表示してすべて無視する。

```yaml
metadata:
  poiesis:
    kind: results
    assertions:
      - "変更の要点が短く説明されている"
      - "読者が実行できる確認手順がある"
```

ApplicationはAI成果文書を正規化した後、Skill assertionsとは別に次の決定的な条件を必ず検証する。

- Change Setに変更ファイルがある場合、本文に`data-poiesis-citation`が1件以上ある。
- 本文に`h2`〜`h4`の見出しが1件以上ある。
- 空の見出しがない。
- 画像がある場合、すべての参照先が解決し、画像として表示できる。
- SVGがある場合、安全でない内容が含まれない。除去が必要だった候補は不合格として再生成の対象にする。画像や図のない文書には追加を強制しない。

Skill assertionsは、HTMLの見出しを`## `、表をヘッダー・区切り行・データ行のあるパイプ表、リスト項目を`- `、コードブロックをコードフェンスで示した最大60,000文字のテキスト、assertions一覧、Change Set summaryを、選択中の判定 AIへ1回のtool-less判定として渡す（既定は「Results の AI と同じ」）。表はヘッダーと最大50データ行・12列、セル本文は前後の空白を除いた最大500文字とし、省略がある場合は明記する。各条件はpass／failと短いevidenceで保存する。応答が不正または判定を開始できない場合はunknownとして記録し、その理由だけで成果文書を失敗扱いにしない。

ApplicationまたはSkillの条件にfailが1件でもあれば、不合格条件をResults prompt末尾へ追加してAI生成を1回だけ再試行し、再度検証する。失敗件数が少ない文書を採用し、同数なら2回目を採用する。再試行は最大1回で、キャンセルは生成と判定の両方へ引き続き適用する。template／fallback文書にはassertionsを付けない。

生成・条件判定・再生成はそれぞれ呼び出し記録として文書へ保存する。使用量と推定費用はCLI報告値だけを保持し、Skillの自己申告や価格表から補完しない。Applicationは現在の段階、モデル選択、再生成回数、不合格件数と段階ごと／全体の経過時間を文書の外で表示する。完成HTML本文へ使用量や内部の呼び出し識別子を埋め込む必要はない。

Skillを含む依頼本文はCodex／Claudeへ標準入力、Grokへ一時ファイルで渡す。単発呼び出しはCodexのJSONイベント／ClaudeのJSON結果から完成本文を取り出し、Grokは従来のテキスト応答を使う。

assertionsは成果文書の検証条件だけを表し、AI provider、model、sandbox、Application所有の出力契約を変更できない。

Execution evidenceは、ApplicationがTask実行中に観測して保存したコマンド、ファイル変更、読み取り、tool、messageの記録である。Applicationはこの記録をApplication-owned inputとしてResults skillとResults Q&Aへ渡し、Skillは記録にある実行結果だけを検証済みとして扱う。記録がない確認は未検証であり、Skillによる自己申告で補完しない。

## Conforming bundles

`builtin.results`は最初の適合bundleである。

```ts
{
  id: 'builtin.results',
  name: 'Bundled Results',
  version: '1.0.0',
  kind: 'results',
  entry: 'builtin:results'
}
```

`builtin.ai-results`は2番目の適合bundleである。選択されたResults roleのAIへ、終了済みTask metadataと確定済みChange Setをread-only境界で渡し、一つの完成HTML文書を生成する。AIを実行できない場合、または生成結果が契約を満たさない場合は`builtin.results`へfallbackする。

fallback文書は、AI生成に失敗したため簡易表示であることを内部エラー詳細なしで明示し、同じTaskのAI生成を再試行できる操作を持つ。失敗理由の詳細はApplication diagnosticsへ記録する。

```ts
{
  id: 'builtin.ai-results',
  name: 'AI Results',
  version: '1.0.0',
  kind: 'results',
  entry: 'builtin:ai-results'
}
```

Customizeは組み込みbundleを説明し、WorkspaceのUser Skillを走査・scaffold・編集できる。有効なUser Skillは上記のprompt境界でAgent／AI Results実行へ反映し、行ごとのswitchでglobalな有効状態を変更できる。読み取り／parseに失敗したSkillは行へエラーを表示し、diagnosticsへ理由を残して実行から除外する。marketplace向けinstall／remove UIは追加しない。

## Boundary rules

- runtime設定が選ぶのは、Agent／Results／判定の各roleを支えるAI providerだけである。
- orchestration、delegation、作業手順はAgent skillが所有する。
- Results本文の見出し構成、語り口、言語、図解、動作確認手順の粒度はResults skillが所有する。
- Taskタイトル、状態、JST完了時刻、変更ファイル数と追加／削除行数はApplicationがSkill HTML外の固定ヘッダーとして所有する。
- ApplicationはTask終了時（完了／失敗／キャンセル）にResults生成を開始し、生成済み文書を所有Taskへ保存してから外部向け完了イベントを確定する。生成中にResultsを開いた場合だけ進捗を表示する。
- Agent会話の完了報告はAgentが返したMarkdown全文をApplicationが省略せず表示する。変更規模は会話本文へ付け足さず、Application所有のdiffstat chipとして表示する。
- ApplicationはTask lifecycle、Change Set、生成タイミング、sandboxed canvasを所有する。
- Agent会話の画像とHTMLプレビューはApplicationが検証したWorkspace内の実在ファイルだけを表示し、外部URLは既定ブロック、生HTML本文は描画しない。この境界をSkillから緩和することはできない。
- bundleはWorkspace外の権限や、選択されたAI providerを暗黙に拡張しない。
- file bundleの画面内editorは、4つのdiscovery rootで見つかった`SKILL.md`または`skill.md`をscopeにかかわらず編集できる。
