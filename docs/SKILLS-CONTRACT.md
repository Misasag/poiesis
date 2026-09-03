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

有効でshadowされていないAgent skillはTask開始時に毎回ファイルから読み直し、frontmatterを除いた本文をimplementer promptの末尾へ次の形で加える。順序は`rank`、`skill-id`の昇順とする。

```text
## Workspace skills (user-defined instructions)
### <skill name>
<SKILL.md または skill.md body>
```

本文は1 Skillあたり8,000文字、合計24,000文字を上限とする。個別上限では切り詰めを明記し、合計上限を超える後続Skillはdiagnosticsへ理由を残して除外する。これはprompt contentだけの境界であり、Skill本文をcodeとして実行／evalせず、provider、model、sandbox、runtime configを変更する権限を与えない。

### Skill の提案

Agentは、非自明な検証手順、ビルド手順、または繰り返し使える作業ルールをTask中に見つけた場合だけ、`<workspace>/.poiesis/pending/skills/<skill-id>/SKILL.md`へ新規または更新の提案を書ける。ここは隔離領域であり、Agentは`.poiesis/skills`の有効なSkillを直接編集しない。

ApplicationはTask終了後に提案を走査し、Customizeの「提案された Skill」で内容または既存Skillとの差分を表示する。ユーザーが明示的に承認した提案だけを`.poiesis/skills/<skill-id>/SKILL.md`へ移し、却下した提案は隔離領域から削除する。Applicationが自動承認することはない。

pending Skillはdiscovery rootに含めず、AgentまたはResultsのpromptへ一切注入しない。`.poiesis/pending/`をGit管理から外す場合、ユーザーは自身の方針に応じて`.gitignore`へ追加するか、未追跡のまま扱う。ApplicationはWorkspaceの`.gitignore`を書き換えない。

### Results skill

Results skillは終了済みTaskと確定済みChange Setを入力に、一つの完成HTML本文を生成する。本文の見出し構成、語り口、言語、図解、動作確認手順の粒度はResults skillが所有する。`builtin.ai-results`は既定で番号付きの動作確認手順を求め、有効なWorkspace Results skillは従来どおり追加ガイダンスとして後から本文構成を上書きできる。Agent会話の途中では起動せず、不完全なHTML断片をcanvasへstreamしない。Results内の質問応答は文書生成とは別のResults AI境界であり、Skill HTMLを変更しない。

根拠コードを示す引用はWorkspace相対の`file:line`または`file:start-end`とし、`<a href="#" data-poiesis-citation="file:start-end">…</a>`でクリック可能にする。Applicationはsandboxed canvasからの引用操作だけを受け取り、Workspace内に実在するファイルを検証してからCodeモードのEditorで該当行を開く。旧文書や契約に従わないAI出力のため、`cite`／`code`／`a`内のプレーンな`file:line[-range]`も互換入力として扱える。

Skill HTMLへApplication内部のTask ID、Taskタイトル、状態、完了時刻、集計diffstatを表示しない。これらはApplicationがSkill HTML外の固定ヘッダーへ表示する。

有効でshadowされていないResults skillも生成開始時に毎回読み直し、同じ区切り・rank順・文字数上限でAI Resultsのpromptへ成果文書の追加ガイダンスとして加える。静的な`builtin.results` templateはUser Skillを解釈しないため、AI生成からtemplateへfallbackした場合はこの追加ガイダンスを反映しない。

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

Skill assertionsは、HTMLからタグを除去し見出しだけを`## `で示した最大60,000文字のテキスト、assertions一覧、Change Set summaryを、選択中のResults AIへ1回のread-only判定として渡す。各条件はpass／failと短いevidenceで保存する。応答が不正または判定を開始できない場合はunknownとして記録し、その理由だけで成果文書を失敗扱いにしない。

ApplicationまたはSkillの条件にfailが1件でもあれば、不合格条件をResults prompt末尾へ追加してAI生成を1回だけ再試行し、再度検証する。失敗件数が少ない文書を採用し、同数なら2回目を採用する。再試行は最大1回で、キャンセルは生成と判定の両方へ引き続き適用する。template／fallback文書にはassertionsを付けない。

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

- runtime設定が選ぶのは、Agent／Resultsの各roleを支えるAI providerだけである。
- orchestration、delegation、作業手順はAgent skillが所有する。
- Results本文の見出し構成、語り口、言語、図解、動作確認手順の粒度はResults skillが所有する。
- Taskタイトル、状態、JST完了時刻、変更ファイル数と追加／削除行数はApplicationがSkill HTML外の固定ヘッダーとして所有する。
- ApplicationはTask終了時（完了／失敗／キャンセル）にResults生成を開始し、生成済み文書を所有Taskへ保存してから外部向け完了イベントを確定する。生成中にResultsを開いた場合だけ進捗を表示する。
- Agent会話の完了報告はAgentが返したMarkdown全文をApplicationが省略せず表示する。変更規模は会話本文へ付け足さず、Application所有のdiffstat chipとして表示する。
- ApplicationはTask lifecycle、Change Set、生成タイミング、sandboxed canvasを所有する。
- Agent会話の画像とHTMLプレビューはApplicationが検証したWorkspace内の実在ファイルだけを表示し、外部URLは既定ブロック、生HTML本文は描画しない。この境界をSkillから緩和することはできない。
- bundleはWorkspace外の権限や、選択されたAI providerを暗黙に拡張しない。
- file bundleの画面内editorは、4つのdiscovery rootで見つかった`SKILL.md`または`skill.md`をscopeにかかわらず編集できる。
