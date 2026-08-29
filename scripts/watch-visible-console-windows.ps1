param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [Parameter(Mandatory = $true)]
    [string]$StopPath,
    [int]$PollMilliseconds = 100
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PoiesisWindowWatcher {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
}
'@

$targetNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($name in @('powershell', 'pwsh', 'cmd', 'conhost')) {
    [void]$targetNames.Add($name)
}

function Get-VisibleConsoleWindows {
    $windows = [System.Collections.Generic.List[object]]::new()
    $callback = [PoiesisWindowWatcher+EnumWindowsProc]{
        param([IntPtr]$windowHandle, [IntPtr]$state)
        if (-not [PoiesisWindowWatcher]::IsWindowVisible($windowHandle)) {
            return $true
        }
        [uint32]$processId = 0
        [void][PoiesisWindowWatcher]::GetWindowThreadProcessId($windowHandle, [ref]$processId)
        try {
            $process = Get-Process -Id $processId -ErrorAction Stop
            if (-not $targetNames.Contains($process.ProcessName)) {
                return $true
            }
            $title = [System.Text.StringBuilder]::new(1024)
            [void][PoiesisWindowWatcher]::GetWindowText($windowHandle, $title, $title.Capacity)
            $windows.Add([pscustomobject]@{
                handle = $windowHandle.ToInt64()
                processId = [int]$processId
                processName = $process.ProcessName
                title = $title.ToString()
            })
        } catch {
            # A process may exit between EnumWindows and Get-Process.
        }
        return $true
    }
    [void][PoiesisWindowWatcher]::EnumWindows($callback, [IntPtr]::Zero)
    return @($windows)
}

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) {
    [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
}
[System.IO.File]::WriteAllText($OutputPath, '', [System.Text.UTF8Encoding]::new($false))
$baseline = [System.Collections.Generic.HashSet[long]]::new()
foreach ($window in @(Get-VisibleConsoleWindows)) {
    [void]$baseline.Add([long]$window.handle)
}
$seen = [System.Collections.Generic.HashSet[long]]::new()
Write-Output 'ROUND16_WATCHER_READY'

while (-not (Test-Path -LiteralPath $StopPath)) {
    foreach ($window in @(Get-VisibleConsoleWindows)) {
        $handle = [long]$window.handle
        if ($baseline.Contains($handle) -or -not $seen.Add($handle)) {
            continue
        }
        $record = [ordered]@{
            observedAt = [DateTime]::UtcNow.ToString('o')
            pollMilliseconds = $PollMilliseconds
            handle = $handle
            processId = $window.processId
            processName = $window.processName
            title = $window.title
        }
        $line = $record | ConvertTo-Json -Compress
        [System.IO.File]::AppendAllText($OutputPath, "$line$([Environment]::NewLine)", [System.Text.UTF8Encoding]::new($false))
    }
    Start-Sleep -Milliseconds $PollMilliseconds
}

Write-Output 'ROUND16_WATCHER_DONE'
