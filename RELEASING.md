# Release guide

## GitHub Releases への公開

公開リリースは `v*` タグの push で `.github/workflows/release.yml` を起動して作成する。タグ名は `electron-app/package.json` の version に `v` を付けた値と一致させる。CI でも不一致を検査し、一致しなければ成果物を公開しない。

リリース前に version と lockfile を更新し、必要なローカル検証を終えて commit する。

```powershell
npm version patch --workspace=@poiesis/theia-electron-app --no-git-tag-version
npm run validate:source
npm run build:electron
npm run dist:win
```

オーナー確認後、commit を push し、リポジトリを public にしてからタグを push する。

```powershell
git push origin main
$version = node -p "require('./electron-app/package.json').version"
git tag "v$version"
git push origin "v$version"
```

CI は Windows x64 の NSIS installer、blockmap、`latest.yml` と、macOS の dmg、zip を同じ GitHub Release へ publish する。macOS は arm64 と x64 を別々に生成する。universal 化すると native addon の 2 architecture を同一 app bundle へ安全に統合する追加検証が必要になるため、署名なし・実機検証中の現段階では採用しない。

macOS ジョブは `macos-latest` の arm64 runner を使い、x64 側は Rosetta と x64 Node.js toolchain で native rebuild する。証明書の自動検出は無効で、`identity: null`、notarize なしで package する。Windows と macOS のいずれも未署名である。

## Windows local release and update

この手順はWindows distribution Phase A用である。固定feed URLは`http://127.0.0.1:43827/win`、feed directoryは`.dist-feed/win/`である。新設Node scriptのconsole出力はASCIIに限定している。

`dist:win` 単体は既定の GitHub publish 設定を app に焼くが、`--publish never` のため upload しない。`release:local` は内部で `dist:win -- --local-feed` を呼び、Windows の publish 設定だけを generic local feed に上書きする。

## Build and local release

PowerShell 5.1でリポジトリルートへ移動する。

```powershell
Set-Location -LiteralPath 'C:\path\to\poiesis'
$env:ELECTRON_BUILDER_CACHE = Join-Path (Get-Location) '.electron-builder-cache'
$env:npm_config_cache = Join-Path (Get-Location) '.npm-cache'
npm run build:electron
npm run dist:win
```

`dist:win`はversionを変更しない。成果物は`electron-app/dist/PoiesisSetup-<version>.exe`、`electron-app/dist/latest.yml`、blockmapである。

patch releaseとfeed更新を一度に行う場合は次を実行する。

```powershell
npm run release:local
```

このcommandは`electron-app/package.json`をpatch bumpし、root `package-lock.json`も更新してからbuild、dist、`.dist-feed/win/`へのcopyを行う。失敗時にversionを自動rollbackしない。

feedだけを配信する常駐serverは次で起動する。停止は`Ctrl+C`。

```powershell
npm run serve:updates
```

## Orchestrator: install and installed smoke

以下はworkspace外への書き込みとinstaller実行を伴うため、Codex sandbox外のorchestratorが実行する。開始前に起動中のPoiesisをすべて終了する。

```powershell
Set-Location -LiteralPath 'C:\path\to\poiesis'
$version = (Get-Content -LiteralPath '.\electron-app\package.json' -Raw -Encoding UTF8 | ConvertFrom-Json).version
$installer = Join-Path (Get-Location) "electron-app\dist\PoiesisSetup-$version.exe"
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Poiesis\Poiesis.exe'

if (-not (Test-Path -LiteralPath $installer)) { throw "Installer not found: $installer" }
$install = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
if ($install.ExitCode -ne 0) { throw "Installer exit code: $($install.ExitCode)" }
if (-not (Test-Path -LiteralPath $exe)) { throw "Installed exe not found: $exe" }

npm run smoke:installed -- --exe "$exe"
if ($LASTEXITCODE -ne 0) { throw "smoke:installed exit code: $LASTEXITCODE" }
```

`smoke:installed`はinstalled exeをCDP port付きで起動するが、`--electronUserData`と`THEIA_CONFIG_DIR`は設定しない。window titleに`Poiesis`を確認して終了する。exeは`--exe`の代わりに`POIESIS_INSTALLED_EXE`でも指定できる。

Start Menu shortcutも機械確認する。

```powershell
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcut = Get-ChildItem -LiteralPath $startMenu -Filter 'Poiesis.lnk' -File -Recurse
if (-not $shortcut) { throw 'Poiesis Start Menu shortcut not found' }
$shortcut | Select-Object -ExpandProperty FullName
```

## Orchestrator: A to B update E2E

このsmokeは現在のsource versionと同じversion Aのinstallerを必要とする。先に`build:electron`と`dist:win`を成功させ、起動中のPoiesisを終了してから実行する。script自身がAをsilent installし、`release:local`でBへpatch bumpし、feed serverを起動し、downloadと終了時適用を検証する。

```powershell
Set-Location -LiteralPath 'C:\path\to\poiesis'
$versionA = (Get-Content -LiteralPath '.\electron-app\package.json' -Raw -Encoding UTF8 | ConvertFrom-Json).version
$installerA = Join-Path (Get-Location) "electron-app\dist\PoiesisSetup-$versionA.exe"
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Poiesis\Poiesis.exe'

if (-not (Test-Path -LiteralPath $installerA)) { throw "Version A installer not found: $installerA" }
npm run smoke:update -- --installer "$installerA" --exe "$exe"
if ($LASTEXITCODE -ne 0) { throw "smoke:update exit code: $LASTEXITCODE" }
```

合格時は`SMOKE_UPDATE_RESULT=ok from=<A> to=<B>`を出力する。updater logは`.electron-runtime/update-smoke/updater.log`、app/server logは同directoryに保存する。installed versionは`resources/app.asar`内の`package.json`から検証する。smoke後はuninstallせずversion Bを残す。

## SAC block handling

installer、app、update installer、native DLLのいずれかがSmart App Controlでブロックされた疑いがある場合、回避せずその場で停止する。smoke scriptsは失敗時に候補pathと直近eventを`_codex/sac-code-integrity.txt`へUTF-8で追記する。manual installで失敗した場合は次を実行する。

```powershell
Set-Location -LiteralPath 'C:\Users\owner\github\poiesis'
$evidence = Join-Path (Get-Location) '_codex\sac-code-integrity.txt'
"Candidate: $installer" | Set-Content -LiteralPath $evidence -Encoding UTF8
wevtutil qe Microsoft-Windows-CodeIntegrity/Operational /q:"*[System[(EventID=3077 or EventID=3118)]]" /c:5 /rd:true /f:text | Add-Content -LiteralPath $evidence -Encoding UTF8
```

Event本文の`File Name`、`Process Name`等からinstaller、`Poiesis.exe`、uninstaller、一時展開されたexe/DLLのどれが対象かを記録する。SAC policy変更、`Unblock-File`、署名検証の無効化は行わない。
