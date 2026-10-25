# Start (or stop) the local translation engine.
#
#   pwsh -File tools\start-engine.ps1                 # foreground, port 5000
#   pwsh -File tools\start-engine.ps1 -Background     # detached, waits for /health
#   pwsh -File tools\start-engine.ps1 -Stop           # stop the detached instance
#
# The engine binds 127.0.0.1 only: prompts never leave the machine and nothing is
# reachable from the LAN.
param(
    [int]$Port = 5000,
    [switch]$Background,
    [switch]$Stop,
    [switch]$Preload
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
$logDir = Join-Path $root '.logs'
$pidFile = Join-Path $logDir "engine-$Port.pid"
$logFile = Join-Path $logDir "engine-$Port.log"

function Get-Health([int]$p) {
    foreach ($path in @('/health')) {
        try {
            return Invoke-RestMethod -Uri "http://127.0.0.1:$p$path" -TimeoutSec 3
        } catch { return $null }
    }
    return $null
}

if ($Stop) {
    # venv python.exe forwards to the bundled interpreter, so the pid we stored
    # is not necessarily the listener. Stop whatever owns the port.
    $owners = @()
    foreach ($line in (netstat -ano | Select-String 'LISTENING' | Select-String ":$Port\s")) {
        $owner = (($line -replace '^\s+', '') -split '\s+')[-1]
        if ($owner -match '^\d+$' -and $owner -ne '0') { $owners += [int]$owner }
    }
    $owners = $owners | Sort-Object -Unique
    if ($owners.Count -eq 0) {
        Write-Host "nothing is listening on port $Port"
    }
    foreach ($ownerPid in $owners) {
        try {
            Stop-Process -Id $ownerPid -Force -ErrorAction Stop
            Write-Host "stopped engine (pid $ownerPid)"
        } catch {
            Write-Host "could not stop pid ${ownerPid}: $($_.Exception.Message)"
        }
    }
    if (Test-Path $pidFile) { Remove-Item $pidFile -Force }
    return
}

if (-not (Test-Path $python)) {
    throw "找不到虚拟环境 $python。请先运行: pwsh -File tools\install.ps1"
}

# The sandbox shim keeps pip/uv able to create temporary directories.
$env:PYTHONPATH = Join-Path $root '.pyshim'
$env:PYTHONIOENCODING = 'utf-8'
$env:TEMP = Join-Path $root '.tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

$existing = Get-Health $Port
if ($null -ne $existing) {
    Write-Host "engine already running on http://127.0.0.1:$Port (version $($existing.version))"
    if ($existing.models) { Write-Host ("models: " + ($existing.models -join ', ')) }
    return
}

$engineArgs = @('server.py', '--host', '127.0.0.1', '--port', "$Port")
if ($Preload) { $engineArgs += '--preload' }

if ($Background) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $process = Start-Process -FilePath $python `
        -ArgumentList $engineArgs `
        -WorkingDirectory (Join-Path $root 'service') `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError "$logFile.err" `
        -PassThru
    Set-Content -Path $pidFile -Value $process.Id -Encoding ascii
    Write-Host "starting engine (pid $($process.Id)); log: $logFile"

    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 500
        $health = Get-Health $Port
        if ($null -ne $health) {
            Write-Host "engine ready on http://127.0.0.1:$Port"
            Write-Host ("models: " + ($health.models -join ', '))
            return
        }
        if ($process.HasExited) {
            throw "engine exited early (code $($process.ExitCode)). See $logFile.err"
        }
    }
    throw "engine did not become healthy within 20s. See $logFile"
}

Write-Host "starting engine on http://127.0.0.1:$Port (Ctrl+C to stop)"
Push-Location (Join-Path $root 'service')
try {
    & $python @engineArgs
}
finally {
    Pop-Location
}
