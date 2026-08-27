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

## Lifecycle

Application側の境界は次の4操作を提供する。

- `install(manifest)`：bundleを登録する。
- `remove(id)`：登録と保存データを削除する。
- `enable(id)`：実行対象へ戻す。
- `disable(id)`：install状態を保ったまま実行対象から外す。

この段階ではinterfaceのみを契約とし、marketplace、検索、download、更新UIは実装しない。存在しないinstall機能を設定画面に装わない。

## Role split

### Agent skill

Agent skillは作業を「どのように行うか」を定義する。prompt構成、検証手順、tool利用方針に加え、将来の委譲やmulti-agent orchestrationもこの層の責務とする。「実装を別エージェントにやらせる」のような作業パターンをAI provider設定やruntime config schemaへ入れない。

Agent skillは成果の正本を自己申告しない。Task、Baseline、Change Setの正本は引き続きApplicationが所有する。

### Results skill

Results skillは終了済みTaskと確定済みChange Setを入力に、一つの完成HTML文書を生成する。Agent会話の途中では起動せず、不完全なHTML断片をcanvasへstreamしない。Results内の質問応答は文書生成とは別のResults AI境界であり、Skill HTMLを変更しない。

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

```ts
{
  id: 'builtin.ai-results',
  name: 'AI Results',
  version: '1.0.0',
  kind: 'results',
  entry: 'builtin:ai-results'
}
```

現在の設定画面は、このResults生成chainをenable／disableする既存操作だけを表示する。install／remove UIや架空のAgent skill一覧は追加しない。

## Boundary rules

- runtime設定が選ぶのは、Agent／Resultsの各roleを支えるAI providerだけである。
- orchestration、delegation、作業手順はAgent skillが所有する。
- 完成HTMLの内部構成はResults skillが所有する。
- ApplicationはTask lifecycle、Change Set、Skill起動時点、sandboxed canvasを所有する。
- bundleはWorkspace外の権限や、選択されたAI providerを暗黙に拡張しない。
