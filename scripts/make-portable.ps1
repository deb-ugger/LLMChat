$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "build-incremental.ps1")
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
foreach ($group in @('ocr', 'ort', 'manga-ort', 'wtp', 'mosaic-detector')) {
    if (!(Test-Path -LiteralPath (Join-Path $webAssets $group) -PathType Container)) {
        throw "Run the frontend build before packaging (missing runtime assets: $group)."
    }
}

. (Join-Path $PSScriptRoot 'stop-project-processes.ps1')
$portableExecutables = @('llmchat.exe', 'llmchat-backend.exe', 'llmchat-backend-x86_64-pc-windows-msvc.exe') | ForEach-Object { Join-Path $out $_ }
Stop-ProjectProcesses -ExecutablePaths $portableExecutables -CloseTimeoutSeconds 20

New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-BuildFile (Join-Path $PSScriptRoot 'portable-build.cmd') (Join-Path $out 'build.cmd')

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
Copy-BuildTree $webAssets $webAssetsOutput
# Remove only obsolete bundled detector files from older portable versions.
$oldDetectorDirectory = Join-Path $webAssetsOutput 'lada'
foreach ($name in @('lada-v4-fast.onnx','lada-v4-accurate.onnx','fast.json','accurate.json','manifest.json','LICENSE.txt')) {
    $oldFile = Join-Path $oldDetectorDirectory $name
    if (Test-Path -LiteralPath $oldFile -PathType Leaf) { Remove-Item -LiteralPath $oldFile }
}
if ((Test-Path -LiteralPath $oldDetectorDirectory -PathType Container) -and !(Get-ChildItem -LiteralPath $oldDetectorDirectory -Force)) {
    Remove-Item -LiteralPath $oldDetectorDirectory
}
Copy-BuildFile $exe $out

$speechTools = Join-Path $root 'frontend\src-tauri\resources\ffmpeg'
if (!(Test-Path -LiteralPath (Join-Path $speechTools 'ffmpeg.exe'))) {
    throw 'Run scripts/prepare-speech-tools.ps1 before packaging the speech feature.'
}
$speechToolsOutput = Join-Path $out 'resources\ffmpeg'
New-Item -ItemType Directory -Force -Path $speechToolsOutput | Out-Null
Copy-BuildTree $speechTools $speechToolsOutput

$unityTools = Join-Path $root 'frontend\src-tauri\resources\unity'
$wolfTools = Join-Path $root 'frontend\src-tauri\resources\wolf'
if (Test-Path -LiteralPath $wolfTools) {
    $wolfOutput = Join-Path $out 'resources\wolf'
    New-Item -ItemType Directory -Force -Path $wolfOutput | Out-Null
    Copy-BuildTree $wolfTools $wolfOutput
}
foreach ($name in @('llmchat-unity.exe', 'Il2CppDumper.exe', 'IL2CPPDUMPER-LICENSE.txt')) {
    if (!(Test-Path -LiteralPath (Join-Path $unityTools $name) -PathType Leaf)) {
        throw "Missing Unity component $name. Run scripts/prepare-unity-tools.ps1 before packaging."
    }
}
$unityToolsOutput = Join-Path $out 'resources\unity'
New-Item -ItemType Directory -Force -Path $unityToolsOutput | Out-Null
Get-ChildItem -LiteralPath $unityTools -File | Where-Object { $_.Name -notin @('NotoSansCJKsc-Regular.otf', 'FONT-OFL.txt', 'FONT-SOURCE.txt') } | ForEach-Object { Copy-BuildFile $_.FullName $unityToolsOutput }
$symbolTools = Join-Path $unityTools 'font-symbols'
if (!(Test-Path -LiteralPath (Join-Path $symbolTools 'llmchat-font-symbols.exe'))) { throw 'Run scripts/prepare-font-symbols.ps1 before packaging font supplementation.' }
Copy-BuildTree $symbolTools (Join-Path $unityToolsOutput 'font-symbols')
$fontsOutput = Join-Path $out 'fonts'
New-Item -ItemType Directory -Force -Path $fontsOutput | Out-Null
foreach ($name in @('NotoSansCJKsc-Regular.otf','OFL.txt','SOURCE.txt')) { Copy-BuildFile (Join-Path $root ('assets\fonts\' + $name)) $fontsOutput }
foreach ($name in @('NotoSansCJKsc-Regular.otf', 'FONT-OFL.txt', 'FONT-SOURCE.txt')) {
    $oldFont = Join-Path $unityToolsOutput $name
    if (Test-Path -LiteralPath $oldFont) { Remove-Item -LiteralPath $oldFont }
}

$sidecarRelease = Join-Path $release "llmchat-backend.exe"
$sidecarNamed = Join-Path $root "frontend\src-tauri\binaries\llmchat-backend-x86_64-pc-windows-msvc.exe"

if (Test-Path $sidecarNamed) {
    Copy-BuildFile $sidecarNamed $out
    # Prefer the freshly built named sidecar as llmchat-backend.exe too
    Copy-BuildFile $sidecarNamed (Join-Path $out "llmchat-backend.exe")
} elseif (Test-Path $sidecarRelease) {
    Copy-BuildFile $sidecarRelease (Join-Path $out "llmchat-backend.exe")
    Copy-BuildFile $sidecarRelease (Join-Path $out "llmchat-backend-x86_64-pc-windows-msvc.exe")
}

# Also sync font/tool caches dirs (created on first fix-font download)
New-Item -ItemType Directory -Force -Path (Join-Path $out "resources\bepinex") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $out "resources\fonts") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $out "resources\tools") | Out-Null

# Also sync the fresh exe into the project-local target so future tooling sees it.
$localRelease = Join-Path $root "frontend\src-tauri\target\release"
if ($release -ne $localRelease) {
    New-Item -ItemType Directory -Force -Path $localRelease | Out-Null
    Copy-BuildFile $exe (Join-Path $localRelease "llmchat.exe")
    if (Test-Path $sidecarRelease) {
        Copy-BuildFile $sidecarRelease (Join-Path $localRelease "llmchat-backend.exe")
    }
}

$configDst = Join-Path $out "config.ini"
if (-not (Test-Path $configDst)) {
    Copy-Item (Join-Path $root "config.ini.example") $configDst
}

Write-Output "Portable folder ready: $out"
Get-ChildItem $out | Format-Table Name, Length

New-Item -ItemType Directory -Path $script:BuildCacheRoot -Force | Out-Null
ConvertTo-Json -InputObject @($script:BuildCopiedFiles) | Set-Content -LiteralPath (Join-Path $script:BuildCacheRoot 'portable-updated-files.json') -Encoding UTF8
Write-Output ('Updated {0} program/resource files.' -f $script:BuildCopiedFiles.Count)
