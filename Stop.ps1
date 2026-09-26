$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'logs/server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No managed server PID found.'; exit 0 }
$taskPid = [int](Get-Content -LiteralPath $pidFile)
$taskInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $taskPid"
$expectedFile = Join-Path $PSScriptRoot 'server.mjs'
if ($taskInfo -and $taskInfo.CommandLine -and $taskInfo.CommandLine.Contains($expectedFile)) {
    Stop-Process -Id $taskPid
    Write-Host '2048 Lab stopped. Active games will resume paused on next launch.'
} elseif ($taskInfo) { throw 'PID does not match this project. Refusing to stop an unrelated process.' }
