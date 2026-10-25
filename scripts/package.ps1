# Cut a release artifact for the extension: build → validate → stage → zip.
#
#   pwsh -File scripts\package.ps1
#   pwsh -File scripts\package.ps1 -Version 0.1.1   # bumps package.json first
#   pwsh -File scripts\package.ps1 -SkipBuild       # reuse current dist/
#
# Output (release/):
#   LinguaBridge-<version>.zip    load-unpacked ready, sourcemaps excluded
#   LinguaBridge-<version>.json   metadata: file list, sizes, SHA-256
#
# The script refuses to produce a zip when the manifest and dist disagree, when a
# referenced bundle is missing, or when development files leak into the package.
param(
    [string]$Version = '',
    [switch]$SkipBuild,
    # Component identifier embedded in the artifact name, e.g. LinguaBridge-extension-0.2.0.zip
    [string]$Tag = 'extension'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pkgPath = Join-Path $root 'package.json'
$dist = Join-Path $root 'dist'
$releaseDir = Join-Path $root 'release'

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
if ($Version -ne '') {
    if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
        throw "版本号不合法：$Version（需要 semver，例如 0.1.1）"
    }
    $pkg.version = $Version
    ($pkg | ConvertTo-Json -Depth 20) + "`n" | Set-Content $pkgPath -Encoding utf8
    Write-Host "package.json version -> $Version"
}
$version = $pkg.version
$stageName = "LinguaBridge-$Tag-$version"
$stage = Join-Path $root ".tmp\release\$stageName"

if (-not $SkipBuild) {
    Write-Host "== build"
    & (Join-Path $root 'scripts\build.ps1') | Out-Host
}

if (-not (Test-Path (Join-Path $dist 'manifest.json'))) {
    throw "dist/manifest.json 不存在，先构建或去掉 -SkipBuild"
}

Write-Host "== validate manifest"
$manifest = Get-Content (Join-Path $dist 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.manifest_version -ne 3) { throw "manifest_version 必须是 3" }
if ($manifest.version -ne $version) {
    throw "manifest 版本 ($($manifest.version)) 与 package.json ($version) 不一致；重新构建即可"
}

$required = @($manifest.background.service_worker) + @($manifest.content_scripts | ForEach-Object { $_.js })
foreach ($file in $required) {
    if (-not (Test-Path (Join-Path $dist $file))) { throw "manifest 引用了不存在的文件：$file" }
}
foreach ($permission in @($manifest.permissions)) {
    if ($permission -notin @('storage', 'contextMenus', 'activeTab')) {
        Write-Warning "仍声明了权限 '$permission'，确认是否必需（最小权限原则）"
    }
}

Write-Host "== stage (exclude sourcemaps)"
if (Test-Path (Split-Path $stage -Parent)) { Remove-Item (Split-Path $stage -Parent) -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$copied = 0
Get-ChildItem $dist -Recurse -File | Where-Object { $_.Extension -ne '.map' } | ForEach-Object {
    $relative = $_.FullName.Substring($dist.Length).TrimStart('\')
    $target = Join-Path $stage $relative
    New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
    Copy-Item $_.FullName $target
    $script:copied++
}

# Nothing but the extension may ship: no TypeScript, no tests, no maps.
$leaks = Get-ChildItem $stage -Recurse -File | Where-Object {
    $_.Extension -in @('.ts', '.map', '.md') -or $_.Name -like '*.test.*'
}
if ($leaks) { throw "打包内容包含开发文件：$($leaks.Name -join ', ')" }

Write-Host "== zip"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$zipPath = Join-Path $releaseDir "$stageName.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $stage -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host "== verify archive"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $entries = $archive.Entries | Where-Object { $_.Name -ne '' }
    $names = $entries | ForEach-Object { $_.FullName }
    foreach ($needed in @('manifest.json', 'background.js', 'content.js')) {
        if ($names -notcontains "$stageName/$needed") { throw "压缩包缺少 $needed（根目录应为 $stageName/）" }
    }
    $badEntries = $entries | Where-Object { $_.FullName -match '\.(ts|map)$' -or $_.Name -like '*.test.*' }
    if ($badEntries) { throw "压缩包包含开发文件：$($badEntries.Name -join ', ')" }
    if ($entries.Count -lt 3) { throw "压缩包条目过少（$($entries.Count)）" }
} finally {
    $archive.Dispose()
}

Write-Host "== write metadata"
$files = Get-ChildItem $stage -Recurse -File | ForEach-Object {
    [ordered]@{
        path   = $_.FullName.Substring($stage.Length).TrimStart('\').Replace('\', '/')
        bytes  = $_.Length
        sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
    }
}
# Measure-Object cannot read a key from an ordered dictionary, so sum directly.
$totalBytes = 0
foreach ($file in $files) { $totalBytes += [long]$file['bytes'] }
$metadata = [ordered]@{
    name         = 'LinguaBridge'
    component    = $Tag
    version      = $version
    kind         = 'chrome-mv3-unpacked'
    builtAt      = (Get-Date).ToString('o')
    files        = @($files)
    totalBytes   = $totalBytes
    archiveBytes = (Get-Item $zipPath).Length
    archiveSha256 = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
    loadUnpacked = "解压后选择 $stageName 目录（其中应包含 manifest.json）"
}
$metaPath = Join-Path $releaseDir "$stageName.json"
$metadata | ConvertTo-Json -Depth 6 | Set-Content $metaPath -Encoding utf8

Write-Host ""
Write-Host "release: $zipPath" -ForegroundColor Green
Write-Host ("  files: {0}  extension: {1:N0} KB  archive: {2:N0} KB" -f $files.Count, ($metadata.totalBytes / 1KB), ($metadata.archiveBytes / 1KB))
Write-Host "  sha256: $($metadata.archiveSha256)"
Write-Host "  meta:   $metaPath"
