# Build the MV3 extension by calling the esbuild binary directly.
#
# Why not `npm run build` / `node scripts/build.mjs`? Both need a child process
# with piped stdio, which the DSH Windows sandbox rejects with EPERM. Invoking
# esbuild as a native process from PowerShell is allowed and produces byte-for-
# byte the same bundles. `scripts/build.mjs` remains the portable entry point.
#
#   pwsh -File scripts\build.ps1            # one-shot build
#   powershell -File scripts\build.ps1      # same
param(
    [switch]$Watch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$esbuild = Join-Path $root 'node_modules\@esbuild\win32-x64\esbuild.exe'

if (-not (Test-Path $esbuild)) {
    throw "esbuild binary not found at $esbuild. Run: npm install --ignore-scripts"
}

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$common = @(
    '--bundle'
    '--target=chrome116'
    '--sourcemap'
    '--log-level=info'
    '--define:process.env.NODE_ENV="production"'
)

Push-Location $root
try {
    & $esbuild 'src/background/index.ts' @common '--format=esm' "--outfile=dist/background.js"
    if ($LASTEXITCODE -ne 0) { throw "background bundle failed ($LASTEXITCODE)" }

    & $esbuild 'src/content/index.ts' @common '--format=iife' "--outfile=dist/content.js"
    if ($LASTEXITCODE -ne 0) { throw "content bundle failed ($LASTEXITCODE)" }

    # Copy the manifest and stamp the package version into it.
    $manifest = Get-Content (Join-Path $root 'src\manifest.json') -Raw | ConvertFrom-Json
    $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $manifest.version = $pkg.version
    $manifest | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $dist 'manifest.json') -Encoding utf8

    if (Test-Path (Join-Path $root 'src\assets')) {
        Copy-Item (Join-Path $root 'src\assets') $dist -Recurse -Force
    }
}
finally {
    Pop-Location
}

Write-Host "built -> $dist"
Get-ChildItem $dist | Select-Object Name, Length | Format-Table -AutoSize
