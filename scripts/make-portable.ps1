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

# Close only this portable checkout, allowing the app to stop its own sidecar.
$portableRoot = [IO.Path]::GetFullPath($out).TrimEnd('\') + '\'
$portableProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('llmchat.exe', 'llmchat-backend.exe', 'llmchat-backend-x86_64-pc-windows-msvc.exe') -and
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($portableRoot, [StringComparison]::OrdinalIgnoreCase)
})
foreach ($appProcess in @($portableProcesses | Where-Object Name -eq 'llmchat.exe')) {
    $process = Get-Process -Id $appProcess.ProcessId -ErrorAction SilentlyContinue
    if ($process) { $null = $process.CloseMainWindow() }
}
$exitDeadline = [DateTime]::UtcNow.AddSeconds(20)
do {
    $remaining = @($portableProcesses | Where-Object {
        Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $exitDeadline)
if ($remaining.Count -gt 0) {
    throw '本仓库便携版未正常退出，已停止更新。请处理未保存提示或退出对应主程序/后端后重试。'
}

New-Item -ItemType Directory -Force -Path $out | Out-Null

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

Copy-Item $exe $out -Force

$speechTools = Join-Path $root 'frontend\src-tauri\resources\ffmpeg'
if (!(Test-Path -LiteralPath (Join-Path $speechTools 'ffmpeg.exe'))) {
    throw 'Run scripts/prepare-speech-tools.ps1 before packaging the speech feature.'
}
$speechToolsOutput = Join-Path $out 'resources\ffmpeg'
New-Item -ItemType Directory -Force -Path $speechToolsOutput | Out-Null
Copy-Item (Join-Path $speechTools '*') $speechToolsOutput -Force

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
