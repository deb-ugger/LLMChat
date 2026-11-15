$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'build-incremental.ps1')
$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root "backend\build"
$exe = Join-Path $buildDir "Release\llmchat-backend.exe"
$binDir = Join-Path $root "frontend\src-tauri\binaries"
$target = Join-Path $binDir "llmchat-backend-x86_64-pc-windows-msvc.exe"

if (-not (Test-Path (Join-Path $buildDir 'CMakeCache.txt'))) {
    cmake -S (Join-Path $root "backend") -B $buildDir | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Backend CMake configuration failed (exit $LASTEXITCODE)." }
}

Write-Output "Building backend..."
$jobs = if ($env:CMAKE_BUILD_PARALLEL_LEVEL) { $env:CMAKE_BUILD_PARALLEL_LEVEL } else { Get-BuildJobs }
$previousCl = $env:CL
try {
    $env:CL = ($previousCl + " /MP$jobs").Trim()
    cmake --build $buildDir --config Release --parallel $jobs
    if ($LASTEXITCODE -ne 0) { throw "Backend build failed (exit $LASTEXITCODE)." }
} finally { $env:CL = $previousCl }
if (-not (Test-Path $exe)) {
    Write-Error "Backend exe not found after build: $exe"
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-BuildFile $exe $target

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
