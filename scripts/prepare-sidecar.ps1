$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root "backend\build"
$exe = Join-Path $buildDir "Release\llmchat-backend.exe"
$binDir = Join-Path $root "frontend\src-tauri\binaries"
$target = Join-Path $binDir "llmchat-backend-x86_64-pc-windows-msvc.exe"

if (-not (Test-Path $buildDir)) {
    New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
    cmake -S (Join-Path $root "backend") -B $buildDir | Out-Null
}

Write-Output "Building backend..."
cmake --build $buildDir --config Release
if (-not (Test-Path $exe)) {
    Write-Error "Backend exe not found after build: $exe"
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item $exe $target -Force

$configSrc = Join-Path $root "config.ini.example"
$configDst = Join-Path $binDir "config.ini"
if (-not (Test-Path $configDst)) {
    Copy-Item $configSrc $configDst
}

$releaseCfg = Join-Path (Split-Path $exe) "config.ini"
if (-not (Test-Path $releaseCfg)) {
    Copy-Item $configSrc $releaseCfg
}

Write-Output "Sidecar ready: $target"
