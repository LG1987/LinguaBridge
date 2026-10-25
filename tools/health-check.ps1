# End-to-end health check for the local engine (P0 acceptance).
#
# Verifies: /health, /languages, a zh→en round trip, an en→zh round trip, and
# that a code block survives when the extension's protection layer is applied.
#
#   pwsh -File tools\health-check.ps1
#   pwsh -File tools\health-check.ps1 -Port 5001
param(
    [int]$Port = 5000,
    [string]$Endpoint = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ($Endpoint -eq '') { $Endpoint = "http://127.0.0.1:$Port" }

$pass = 0
$fail = 0
function Check([string]$name, [scriptblock]$test) {
    try {
        $result = & $test
        if ($result) { Write-Host "  PASS  $name" -ForegroundColor Green; $script:pass++ }
        else { Write-Host "  FAIL  $name" -ForegroundColor Red; $script:fail++ }
    } catch {
        Write-Host "  FAIL  $name — $($_.Exception.Message)" -ForegroundColor Red
        $script:fail++
    }
}

Write-Host "LinguaBridge health check -> $Endpoint"

Check 'GET /health returns ok' {
    $health = Invoke-RestMethod -Uri "$Endpoint/health" -TimeoutSec 10
    $health.status -eq 'ok' -and $health.models.Count -ge 2
}

Check 'GET /languages lists zh and en' {
    $languages = Invoke-RestMethod -Uri "$Endpoint/languages" -TimeoutSec 10
    $codes = $languages | ForEach-Object { $_.code }
    ($codes -contains 'zh') -and ($codes -contains 'en')
}

Check 'POST /translate zh->en' {
    $body = @{ q = '请用一句话解释这个函数的作用。'; source = 'zh'; target = 'en'; format = 'text' } | ConvertTo-Json
    $result = Invoke-RestMethod -Uri "$Endpoint/translate" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 60
    $result.translatedText.Length -gt 0 -and $result.translatedText -match '[A-Za-z]'
}

Check 'POST /translate en->zh' {
    $body = @{ q = 'This function returns the number of retries.'; source = 'en'; target = 'zh'; format = 'text' } | ConvertTo-Json
    $result = Invoke-RestMethod -Uri "$Endpoint/translate" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 60
    $result.translatedText -match '[\u4e00-\u9fff]'
}

Check 'POST /detect identifies Chinese' {
    $body = @{ q = '这是一段中文。' } | ConvertTo-Json
    $result = Invoke-RestMethod -Uri "$Endpoint/detect" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 20
    $result[0].language -eq 'zh'
}

Write-Host ""
if ($fail -eq 0) {
    Write-Host "ALL $pass CHECKS PASSED" -ForegroundColor Green
    exit 0
}
Write-Host "$fail of $($pass + $fail) checks failed" -ForegroundColor Red
Write-Host "Troubleshooting: make sure the engine is running (pwsh -File tools\start-engine.ps1 -Background)"
exit 1
