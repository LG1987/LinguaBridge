# Package the DSH native plugin as a distributable zip.
#
#   pwsh -File scripts\package-plugin.ps1
#
# Output (release/):
#   LinguaBridge-dsh-plugin-<version>.zip    one top-level folder, ready to feed
#                                            to plugin_manager install_bundle
#   LinguaBridge-dsh-plugin-<version>.json   file list, sizes, SHA-256
#
# The plugin has no build step (plain JS served by the client module loader), so
# this only validates the manifest, stages, zips and verifies the archive.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$pluginDir = Join-Path $root 'dsh-plugin\linguabridge-send'
$releaseDir = Join-Path $root 'release'

$manifestPath = Join-Path $pluginDir 'package.json'
if (-not (Test-Path $manifestPath)) { throw "插件清单不存在：$manifestPath" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
$stageName = "LinguaBridge-dsh-plugin-$version"
$stage = Join-Path $root ".tmp\release\$stageName"

if ($manifest.dsh.bundle.patch -ne './cordis.patch.yml') { throw 'dsh.bundle.patch 必须是 ./cordis.patch.yml' }
if (-not $manifest.dsh.client) { throw '缺少 dsh.client 段' }

$required = @('index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json')
foreach ($file in $required) {
    if (-not (Test-Path (Join-Path $pluginDir $file))) { throw "插件缺少文件：$file" }
}
foreach ($requiredFile in @('index.js', 'client.js', 'cordis.patch.yml', 'icon.svg')) {
    if ($manifest.files -notcontains $requiredFile) { throw "files 未包含 $requiredFile" }
}

Write-Host "== stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Get-ChildItem $pluginDir -Recurse -File |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.Extension -ne '.map' } |
    ForEach-Object {
        $relative = $_.FullName.Substring($pluginDir.Length).TrimStart('\')
        $target = Join-Path $stage $relative
        New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
        Copy-Item $_.FullName $target
    }

Write-Host "== zip"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$zipPath = Join-Path $releaseDir "$stageName.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $stage -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host "== verify archive"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $names = $archive.Entries | Where-Object { $_.Name -ne '' } | ForEach-Object { $_.FullName }
    foreach ($needed in @('package.json', 'index.js', 'client.js', 'cordis.patch.yml')) {
        if ($names -notcontains "$stageName/$needed") { throw "压缩包缺少 $needed（根目录应为 $stageName/）" }
    }
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
$totalBytes = 0
foreach ($file in $files) { $totalBytes += [long]$file['bytes'] }
$metadata = [ordered]@{
    name          = $manifest.name
    component     = 'dsh-plugin'
    version       = $version
    kind          = 'dsh-cordis-bundle'
    builtAt       = (Get-Date).ToString('o')
    files         = @($files)
    totalBytes    = $totalBytes
    archiveBytes  = (Get-Item $zipPath).Length
    archiveSha256 = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
    installTarget = "解压后把 $stageName 目录作为 plugin_manager install_bundle 的 target"
}
$metaPath = Join-Path $releaseDir "$stageName.json"
$metadata | ConvertTo-Json -Depth 6 | Set-Content $metaPath -Encoding utf8

Write-Host ""
Write-Host "release: $zipPath" -ForegroundColor Green
Write-Host ("  files: {0}  unpacked: {1:N1} KB  archive: {2:N1} KB" -f $files.Count, ($totalBytes / 1KB), ($metadata.archiveBytes / 1KB))
Write-Host "  sha256: $($metadata.archiveSha256)"
Write-Host "  meta:   $metaPath"
