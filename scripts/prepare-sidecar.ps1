$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "backend\build\Release\llmchat-backend.exe"
$binDir = Join-Path $root "frontend\src-tauri\binaries"
$target = Join-Path $binDir "llmchat-backend-x86_64-pc-windows-msvc.exe"

if (-not (Test-Path $exe)) {
    Write-Error "Backend exe not found: $exe`nBuild backend first."
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item $exe $target -Force

$configSrc = Join-Path $root "config.ini.example"
$configDst = Join-Path $binDir "config.ini"
if (-not (Test-Path $configDst)) {
    Copy-Item $configSrc $configDst
}

# Also place next to Release for direct backend runs
$releaseCfg = Join-Path (Split-Path $exe) "config.ini"
if (-not (Test-Path $releaseCfg)) {
    Copy-Item $configSrc $releaseCfg
}

Write-Output "Sidecar ready: $target"
