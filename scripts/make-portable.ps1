$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root "frontend\src-tauri\target\release"
$out = Join-Path $root "dist-portable"

if (-not (Test-Path (Join-Path $release "llmchat.exe"))) {
    Write-Error "Build Tauri first: cd frontend; npm run tauri -- build"
}

New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item (Join-Path $release "llmchat.exe") $out -Force

$sidecarRelease = Join-Path $release "llmchat-backend.exe"
$sidecarNamed = Join-Path $root "frontend\src-tauri\binaries\llmchat-backend-x86_64-pc-windows-msvc.exe"

if (Test-Path $sidecarRelease) {
    Copy-Item $sidecarRelease (Join-Path $out "llmchat-backend.exe") -Force
}
if (Test-Path $sidecarNamed) {
    Copy-Item $sidecarNamed $out -Force
} elseif (Test-Path $sidecarRelease) {
    Copy-Item $sidecarRelease (Join-Path $out "llmchat-backend-x86_64-pc-windows-msvc.exe") -Force
}

$configDst = Join-Path $out "config.ini"
if (-not (Test-Path $configDst)) {
    Copy-Item (Join-Path $root "config.ini.example") $configDst
}

Write-Output "Portable folder ready: $out"
Get-ChildItem $out | Format-Table Name, Length
