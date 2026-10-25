# One-shot setup for a fresh Windows 11 machine.
#
#   pwsh -File tools\install.ps1
#   pwsh -File tools\install.ps1 -SkipModels      # engine code only
#   pwsh -File tools\install.ps1 -SkipExtension   # service only
#
# What it does, and why:
#   1. downloads `uv` into .uvtool (no admin rights, nothing global);
#   2. installs a private CPython 3.12 under .python — LibreTranslate/Argos wheels
#      are built for <=3.12, and this machine ships 3.14 only;
#   3. creates .venv and installs ctranslate2 + sentencepiece (~32 MB, no torch);
#   4. downloads the Argos zh<->en models (~140 MB) into service/models;
#   5. installs the extension build tooling and builds dist/.
#
# Everything stays inside the project directory, so removing the folder undoes it.
param(
    [switch]$SkipModels,
    [switch]$SkipExtension,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$uv = Join-Path $root '.uvtool\bin\uv.exe'
$python = Join-Path $root '.venv\Scripts\python.exe'

# DSH's Windows sandbox blocks pip/uv writing into directories that Python creates
# with mode 0700 (Python 3.13+ turns that into a restrictive DACL). The shim
# ignores restrictive modes; TEMP is redirected so no writes leave the workspace.
$env:PYTHONPATH = Join-Path $root '.pyshim'
$env:TEMP = Join-Path $root '.tmp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:UV_PYTHON_INSTALL_DIR = Join-Path $root '.python'
$env:UV_CACHE_DIR = Join-Path $root '.uv-cache'
$env:UV_PYTHON_DOWNLOADS = 'automatic'
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null

function Step([string]$title) {
    Write-Host ""
    Write-Host "== $title" -ForegroundColor Cyan
}

$systemPython = (Get-Command python -ErrorAction SilentlyContinue)
if ($null -eq $systemPython) { throw "找不到 python。请先安装 Python 3.11+ 并加入 PATH。" }
Write-Host "system python: $($systemPython.Source)"

if (-not (Test-Path $uv)) {
    Step "下载 uv"
    python -m pip install --no-cache-dir --disable-pip-version-check --target (Join-Path $root '.uvtool') uv
}
& $uv --version

Step "安装 Python 3.12（项目内，不污染系统）"
& $uv python install 3.12

if (-not (Test-Path $python) -or $Force) {
    Step "创建虚拟环境 .venv"
    & $uv venv --python 3.12 --seed (Join-Path $root '.venv')
}

Step "安装本地翻译引擎依赖"
& $uv pip install --python $python -r (Join-Path $root 'service\requirements.txt')

if (-not $SkipModels) {
    Step "下载 Argos 中英模型"
    $fetchArgs = @((Join-Path $root 'tools\fetch_argos_models.py'))
    if ($Force) { $fetchArgs += '--force' }
    & $python @fetchArgs
}

if (-not $SkipExtension) {
    Step "安装扩展构建依赖"
    $env:npm_config_cache = Join-Path $root '.npm-cache'
    Push-Location $root
    try {
        # --ignore-scripts: npm's lifecycle scripts spawn child processes with
        # piped stdio, which the DSH sandbox rejects (EPERM). esbuild ships its
        # binary as an optional package, so nothing is actually missing.
        npm install --ignore-scripts --no-audit --no-fund
        Step "构建扩展 dist/"
        & (Join-Path $root 'scripts\build.ps1')
    }
    finally {
        Pop-Location
    }
}

Step "完成"
Write-Host "下一步："
Write-Host "  1) 启动本地服务   pwsh -File tools\start-engine.ps1 -Background"
Write-Host "  2) 健康检查       pwsh -File tools\health-check.ps1"
Write-Host "  3) 加载扩展       浏览器 -> 扩展管理 -> 开发者模式 -> 加载解压缩的扩展 -> $root\dist"
