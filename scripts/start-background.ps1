$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runDirectory = Join-Path $projectRoot '.run'
$pidFile = Join-Path $runDirectory 'server.pid'
$logFile = Join-Path $runDirectory 'server.log'
$serverUrl = 'http://127.0.0.1:3000/'

function Test-ServerReady {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $serverUrl -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

if (Test-ServerReady) {
    Write-Host "Poiesis is already running at $serverUrl"
    exit 0
}

New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null

if (Test-Path -LiteralPath $pidFile) {
    Remove-Item -LiteralPath $pidFile -Force
}

# Use ProcessStartInfo directly because some Windows environments expose both
# Path and PATH, which makes PowerShell Start-Process fail while copying them.
$commandInterpreter = Join-Path $env:SystemRoot 'System32\cmd.exe'
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $commandInterpreter
$startInfo.Arguments = "/d /c `"npm.cmd run start >> .run\server.log 2>&1`""
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

$serverProcess = [System.Diagnostics.Process]::Start($startInfo)
if (-not $serverProcess) {
    throw 'Failed to start the Poiesis server process.'
}

[System.IO.File]::WriteAllText($pidFile, [string]$serverProcess.Id)

for ($attempt = 0; $attempt -lt 45; $attempt++) {
    Start-Sleep -Seconds 1
    if (Test-ServerReady) {
        Write-Host "Poiesis started at $serverUrl (launcher PID $($serverProcess.Id))."
        Write-Host "Log: $logFile"
        exit 0
    }

    if ($serverProcess.HasExited) {
        break
    }
}

$recentLog = if (Test-Path -LiteralPath $logFile) {
    (Get-Content -LiteralPath $logFile -Tail 80) -join [Environment]::NewLine
} else {
    'No server log was created.'
}

throw "Poiesis did not become ready at $serverUrl`n$recentLog"
