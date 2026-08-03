$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
# Prefer CARGO_TARGET_DIR when set (Cursor sandbox may redirect builds).
$targetRoot = if ($env:CARGO_TARGET_DIR -and (Test-Path $env:CARGO_TARGET_DIR)) {
    $env:CARGO_TARGET_DIR
} else {
    Join-Path $root "frontend\src-tauri\target"
}
$release = Join-Path $targetRoot "release"
$out = Join-Path $root "dist-portable"
$exe = Join-Path $release "llmchat.exe"

if (-not (Test-Path $exe)) {
    Write-Error "Build Tauri first: cd frontend; npm run tauri -- build (missing $exe)"
}
Write-Output "Using release binary: $exe ($(Get-Item $exe | Select-Object -ExpandProperty LastWriteTime))"

# Free locks if the portable app is still running
Get-Process -Name "llmchat", "llmchat-backend" -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item $exe $out -Force

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

# Optional BepInEx download cache (created on first loader install if missing)
New-Item -ItemType Directory -Force -Path (Join-Path $out "resources\bepinex") | Out-Null

# Also sync the fresh exe into the project-local target so future tooling sees it.
$localRelease = Join-Path $root "frontend\src-tauri\target\release"
if ($release -ne $localRelease) {
    New-Item -ItemType Directory -Force -Path $localRelease | Out-Null
    Copy-Item $exe (Join-Path $localRelease "llmchat.exe") -Force
    if (Test-Path $sidecarRelease) {
        Copy-Item $sidecarRelease (Join-Path $localRelease "llmchat-backend.exe") -Force
    }
}

$configDst = Join-Path $out "config.ini"
if (-not (Test-Path $configDst)) {
    Copy-Item (Join-Path $root "config.ini.example") $configDst
}

Write-Output "Portable folder ready: $out"
Get-ChildItem $out | Format-Table Name, Length
