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

$webAssets = Join-Path $root 'frontend\src-tauri\resources\web-assets'
foreach ($group in @('ocr', 'ort', 'manga-ort', 'wtp')) {
    if (!(Test-Path -LiteralPath (Join-Path $webAssets $group) -PathType Container)) {
        throw "Run the frontend build before packaging (missing runtime assets: $group)."
    }
}

. (Join-Path $PSScriptRoot 'stop-project-processes.ps1')
$portableExecutables = @('llmchat.exe', 'llmchat-backend.exe', 'llmchat-backend-x86_64-pc-windows-msvc.exe') | ForEach-Object { Join-Path $out $_ }
Stop-ProjectProcesses -ExecutablePaths $portableExecutables -CloseTimeoutSeconds 20

New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable-build.cmd') -Destination (Join-Path $out 'build.cmd') -Force

# Only refresh binaries/resources. Never wipe user data next to the portable app:
# usage-events.jsonl, conversations.json, config.ini, vendor-models.json, text-projects/, etc.
$preserveHint = @(
    "usage.db",
    "conversations.sqlite3",
    "storage-paths.json",
    "usage-events.jsonl",
    "conversations.json",
    "config.ini",
    "vendor-models.json",
    "pricing.json",
    "text-projects",
    "ocr-models"
)
Write-Output ("Preserving portable data if present: " + ($preserveHint -join ", "))
foreach ($name in $preserveHint) {
    $p = Join-Path $out $name
    if (Test-Path $p) {
        Write-Output ("  keep: $p")
    }
}

$webAssetsOutput = Join-Path $out 'resources\web-assets'
New-Item -ItemType Directory -Force -Path $webAssetsOutput | Out-Null
Copy-Item (Join-Path $webAssets '*') $webAssetsOutput -Recurse -Force
Copy-Item $exe $out -Force

$speechTools = Join-Path $root 'frontend\src-tauri\resources\ffmpeg'
if (!(Test-Path -LiteralPath (Join-Path $speechTools 'ffmpeg.exe'))) {
    throw 'Run scripts/prepare-speech-tools.ps1 before packaging the speech feature.'
}
$speechToolsOutput = Join-Path $out 'resources\ffmpeg'
New-Item -ItemType Directory -Force -Path $speechToolsOutput | Out-Null
Copy-Item (Join-Path $speechTools '*') $speechToolsOutput -Force

$unityTools = Join-Path $root 'frontend\src-tauri\resources\unity'
if (!(Test-Path -LiteralPath (Join-Path $unityTools 'llmchat-unity.exe'))) {
    throw 'Run scripts/prepare-unity-tools.ps1 before packaging the Unity embedding feature.'
}
$unityToolsOutput = Join-Path $out 'resources\unity'
New-Item -ItemType Directory -Force -Path $unityToolsOutput | Out-Null
Copy-Item (Join-Path $unityTools '*') $unityToolsOutput -Force

$sidecarRelease = Join-Path $release "llmchat-backend.exe"
$sidecarNamed = Join-Path $root "frontend\src-tauri\binaries\llmchat-backend-x86_64-pc-windows-msvc.exe"

if (Test-Path $sidecarNamed) {
    Copy-Item $sidecarNamed $out -Force
    # Prefer the freshly built named sidecar as llmchat-backend.exe too
    Copy-Item $sidecarNamed (Join-Path $out "llmchat-backend.exe") -Force
} elseif (Test-Path $sidecarRelease) {
    Copy-Item $sidecarRelease (Join-Path $out "llmchat-backend.exe") -Force
    Copy-Item $sidecarRelease (Join-Path $out "llmchat-backend-x86_64-pc-windows-msvc.exe") -Force
}

# Also sync font/tool caches dirs (created on first fix-font download)
New-Item -ItemType Directory -Force -Path (Join-Path $out "resources\bepinex") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $out "resources\fonts") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $out "resources\tools") | Out-Null

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
