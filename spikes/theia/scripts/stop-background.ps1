$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runDirectory = Join-Path $projectRoot '.run'
$pidFile = Join-Path $runDirectory 'server.pid'
$serverUrl = 'http://127.0.0.1:3000/'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'No Lens background server PID was recorded.'
    exit 0
}

$serverPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$serverProcess = Get-Process -Id $serverPid -ErrorAction SilentlyContinue

if ($serverProcess) {
    if ($serverProcess.ProcessName -notin @('cmd', 'npm', 'node')) {
        throw "Refusing to stop unexpected process $serverPid ($($serverProcess.ProcessName))."
    }

    & taskkill.exe /PID $serverPid /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to stop Lens launcher process $serverPid."
    }
}

Remove-Item -LiteralPath $pidFile -Force
Write-Host "Lens background server stopped ($serverUrl)."
