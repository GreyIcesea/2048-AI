param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$address = 'http://127.0.0.1:2048'
try {
    $state = Invoke-RestMethod "$address/api/state" -TimeoutSec 2
    if ($state.engine.repository -ne 'https://github.com/game-difficulty/2048EndgameTablebase') { throw 'Port 2048 is occupied by another application.' }
    Write-Host "2048 Lab is ready: $address"
    if (-not $NoBrowser) { Start-Process $address }
    exit 0
} catch {
    if (Get-NetTCPConnection -LocalPort 2048 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 2048 is occupied. Stop the other service first.' }
}
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = & $nodeExe --version
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 24) { throw 'Node.js 24 or newer is required.' }
if (-not (Test-Path -LiteralPath './engine/manifest.json')) { & $nodeExe scripts/build.mjs; if ($LASTEXITCODE -ne 0) { throw 'AI build failed.' } }
New-Item -ItemType Directory -Path './logs' -Force | Out-Null
$serverFile = Join-Path $PSScriptRoot 'server.mjs'
$taskProcess = Start-Process -FilePath $nodeExe -ArgumentList ('"' + $serverFile + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'logs/server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'logs/server-error.log') -PassThru
Set-Content -LiteralPath './logs/server.pid' -Value $taskProcess.Id
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
        $state = Invoke-RestMethod "$address/api/state" -TimeoutSec 1
        if ($state.engine.ready) {
            Write-Host "2048 Lab is ready: $address"
            if (-not $NoBrowser) { Start-Process $address }
            exit 0
        }
    } catch {}
}
throw 'Service did not start. See logs/server-error.log.'
