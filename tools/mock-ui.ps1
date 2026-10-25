# Serve the DSH-shaped mock page so the extension can be exercised in a real
# browser without a DSH login (the desktop app's Web UI only accepts the
# ?token= URL it printed, and Electron windows cannot load extensions).
#
#   pwsh -File tools\mock-ui.ps1          # serves http://127.0.0.1:8765 until Ctrl+C
#   pwsh -File tools\mock-ui.ps1 -Stop    # stops an instance started detached earlier
#
# Deliberately a foreground server: backgrounding python from PowerShell proved
# unreliable under the DSH sandbox (the launching shell waits on redirected
# handles). Open a second terminal, or pair it with tools\start-engine.ps1.
param(
    [int]$Port = 8765,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
$pidFile = Join-Path $root ".logs\mock-ui-$Port.pid"
$mockDir = Join-Path $root 'test\fixtures'

if ($Stop) {
    # The venv's python.exe is a forwarding launcher: the process that actually
    # listens has a different pid, so stop whatever owns the port.
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
            Write-Host "stopped mock UI (pid $ownerPid)"
        } catch {
            Write-Host "could not stop pid ${ownerPid}: $($_.Exception.Message)"
        }
    }
    if (Test-Path $pidFile) { Remove-Item $pidFile -Force }
    return
}

if (-not (Test-Path $python)) {
    throw "找不到 $python。请先运行: pwsh -File tools\install.ps1 -SkipModels"
}
if (-not (Test-Path (Join-Path $mockDir 'dsh-mock.html'))) {
    throw "找不到自测页 $mockDir\dsh-mock.html"
}

Write-Host "LinguaBridge 自测页: http://127.0.0.1:$Port/dsh-mock.html"
Write-Host "  1) 先在扩展页加载解压缩的扩展 dist"
Write-Host "  2) 打开上面的地址，约 2 秒后英文回复下方应出现「本地译文」卡片"
Write-Host "  3) 点「填入示例中文提示词」，再按 Ctrl+Alt+T 验证对比面板"
Write-Host "  Ctrl+C 停止"
Write-Host ""

& $python -m http.server $Port --bind 127.0.0.1 --directory $mockDir
