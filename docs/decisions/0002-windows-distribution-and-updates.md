# ADR 0002: Windows配布と自動更新

## Status

Accepted

## Date

2026-08-29

## Context

PoiesisのTheia/Electron targetはdevelopment buildと直接起動まで実証済みだが、インストーラー、インストール済みアプリ、配布物からの更新は未実証だった。第一段階ではper-user Windows配布と、外部サービスなしで反復できるローカル更新経路が必要である。

このWindows環境ではSmart App Control（SAC）が有効であり、未署名のinstaller、exe、DLLが例外設定なしでブロックされうる。Phase Aは署名を導入せず、この制約を実測して証跡を残す。

## Decision

- `electron-builder` 26.xと`electron-updater`を採用し、Windows targetをNSISにする。
- NSISはone-clickではないper-user installとし、既定先を`%LOCALAPPDATA%\Programs\Poiesis`、Start Menu登録ありとする。
- application packageの正本versionは`spikes/theia/electron-app/package.json`とする。`release:local`はpatch bump、Electron build、NSIS build、feed更新を直列実行する。
- Phase Aのpublish providerは`generic`、feedは`http://127.0.0.1:43827/win`、実体はgitignoreした`spikes/theia/.dist-feed/win/`とする。builder自身はuploadしない。
- updaterはTheiaのelectron-main contributionとして組み込む。packaged起動時にcheckとdownloadを開始し、`autoInstallOnAppQuit`で終了時に適用する。download完了時は即時再起動を選べるnative dialogを表示する。
- `asar:true`を維持し、native bindings、shell integrations、prebuildsをunpackする。VS Code builtin pluginsは`extraResources`で`resources/app/plugins`へ同梱し、packaged main wrapperが`THEIA_DEFAULT_PLUGINS`を設定する。
- 配布物には開発用`--electronUserData`や`THEIA_CONFIG_DIR`を設定しない。installed appはElectronの既定userDataを使う。
- 初回のSAC実証までは`win.signAndEditExecutable:false`でrceditを停止した。owner機で未署名installer、installed app、A→B更新がすべて合格したため、`win.signExecutable:false`で署名だけをスキップし、`win.icon`とNSIS icon設定によるPoiesisのicon/metadataリソース編集を行う。

## SACと署名の制約

Phase AのNSIS installerと生成物にはPoiesisのコード署名を行わない。初回実証では、rceditも停止した配布物についてSAC有効のowner機でinstaller、installed app、更新適用がブロックされないことを確認した。この結果に基づき、ownerは署名なし方針を維持したまま実行ファイルのicon/metadataリソース編集を解禁した。

リソース編集後の配布物については、オーケストレーターが`smoke:update`でSACを再確認する。ブロックは合格扱いにも回避対象にもしない。ブロック時は処理を停止し、Code Integrity Operational logのEvent ID 3077/3118と、候補となるinstaller、app exe、DLLのpathを保存して判断を委ねる。`Unblock-File`、policy変更、例外登録は行わず、`signAndEditExecutable:false`へ戻すかはオーケストレーターが判断する。

`signExecutable:false`はbuilderによる署名だけを止め、rceditによるicon/metadata編集は許可する設定である。正式配布前にはcertificate管理、installer/app/native DLLの署名順序、timestamp、更新時の署名検証を別途決定する。

## Public化後のGitHub Releases切り替え

runtime updaterはbuilderが生成する`app-update.yml`を読むため、electron-main実装は維持できる。切り替え時は次を行う。

1. `electron-builder.yml`の`win.publish`を`provider: github`とし、public repositoryの`owner`と`repo`を指定する。
2. release workflowでGitHub tokenをsecretから渡し、同じversionのinstaller、blockmap、`latest.yml`をRelease assetsへpublishする。
3. local HTTP前提のsmokeとは別に、draft/prerelease/channel、asset visibility、更新署名をstaging releaseで検証する。

Phase AではGitHub providerとupload処理を実装しない。

## Consequences

ローカルでA→Bの更新を再現でき、将来providerだけを差し替えられる。一方、固定loopback feedは開発専用であり、serverがない通常起動ではupdate check errorがlogに残る。

## 実測結果(2026-08-29、owner機で実施)

- 未署名NSIS installer(`PoiesisSetup-0.0.2.exe`)のsilent install(`/S`)はSAC有効のowner機で**ブロックされず** exit 0。Code Integrity 3077/3118イベントの採取は不要だった。
- installed app起動smoke(`smoke:installed`)exit 0、title `Poiesis`。Start Menu shortcut生成を確認。
- 更新E2E(`smoke:update`)exit 0: 0.0.2 install → `release:local`で0.0.3をfeedへ → 起動時checkでdownload → 終了時適用 → installed versionが0.0.3。
- 署名なし方針はownerが決定済み(配布規模が小さいため)。SAC適合はowner機での実測のみであり、他のSAC有効機での再現は保証しない。
