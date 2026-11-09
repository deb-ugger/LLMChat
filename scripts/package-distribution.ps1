[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$portable = Join-Path $root 'dist-portable'
$owner = 'codex-distribution-package'
$lockScript = Join-Path $PSScriptRoot 'file-lock.ps1'

# Allowlist application files. Never enumerate the user's portable data folders.
$files = @(
    'llmchat.exe', 'llmchat-backend.exe', 'llmchat-backend-x86_64-pc-windows-msvc.exe',
    'fonts/NotoSansCJKsc-Regular.otf', 'fonts/OFL.txt', 'fonts/SOURCE.txt',
    'resources/wolf/WolfTL.exe', 'resources/wolf/WOLFTL-LICENSE.txt', 'resources/wolf/SOURCE.txt',
    'resources/ffmpeg/ffmpeg.exe', 'resources/ffmpeg/ffprobe.exe',
    'resources/ffmpeg/LICENSE', 'resources/ffmpeg/README.txt',
    'resources/ffmpeg/SOURCE.txt', 'resources/ffmpeg/VERSION.txt',
    'resources/unity/llmchat-unity.exe', 'resources/unity/classdata.tpk',
    'resources/unity/onnxruntime.dll', 'resources/unity/onnxruntime_providers_shared.dll',
    'resources/unity/DOTNET-LICENSE.TXT', 'resources/unity/DOTNET-THIRD-PARTY-NOTICES.TXT',
    'resources/unity/THIRD-PARTY.txt', 'resources/unity/WTP-LICENSE.txt',
    'resources/unity/WTP-manifest.json', 'resources/unity/wtp-model.onnx',
    'resources/web-assets/manga-ort/ort-wasm-simd-threaded.asyncify.mjs',
    'resources/web-assets/manga-ort/ort-wasm-simd-threaded.asyncify.wasm',
    'resources/web-assets/ocr/PP-OCRv6_small_det_onnx_infer.tar',
    'resources/web-assets/ocr/PP-OCRv6_small_rec_onnx_infer.tar',
    'resources/web-assets/ocr/README.md',
    'resources/web-assets/ort/ort-wasm-simd-threaded.jsep.mjs',
    'resources/web-assets/ort/ort-wasm-simd-threaded.jsep.wasm',
    'resources/web-assets/ort/README.md',
    'resources/web-assets/wtp/LICENSE.txt', 'resources/web-assets/wtp/manifest.json',
    'resources/web-assets/wtp/model.onnx'
)
$config = @'
[General]
apiKey=
proxyMode=direct
httpProxy=
translateProvider=bing
translateSource=auto
translateTarget=zh-CN
ocrTranslateProvider=bing
ocrTranslateSource=auto
ocrTranslateTarget=zh-CN
textTranslateProvider=bing
textTranslateSource=auto
textTranslateTarget=zh-CN
'@

& $lockScript acquire -Global -Owner $owner -WaitSeconds 120
if ($LASTEXITCODE -ne 0) { throw 'Cannot acquire the packaging lock.' }
try {
    foreach ($name in $files) {
        if (!(Test-Path -LiteralPath (Join-Path $portable $name) -PathType Leaf)) {
            throw "Missing application resource: $name. Update dist-portable before packaging."
        }
    }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $output = Join-Path $root 'release'
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    $path = Join-Path $output ('LLMChat-Windows-x64-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
    $zip = [System.IO.Compression.ZipFile]::Open($path, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $files) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, (Join-Path $portable $name), ('LLMChat/' + $name),
                [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, (Join-Path $root 'README.md'), 'LLMChat/README.md',
            [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        $writer = [System.IO.StreamWriter]::new($zip.CreateEntry('LLMChat/config.ini').Open(), [System.Text.UTF8Encoding]::new($false))
        try { $writer.Write($config) } finally { $writer.Dispose() }
    } finally { $zip.Dispose() }

    # Confirm the finished archive contains exactly the allowlist and fresh config.
    $archive = [System.IO.Compression.ZipFile]::OpenRead($path)
    try {
        $expected = @($files | ForEach-Object { 'LLMChat/' + $_ }) + @('LLMChat/README.md', 'LLMChat/config.ini')
        if (Compare-Object $expected @($archive.Entries.FullName)) { throw 'Unexpected archive entries.' }
        $reader = [System.IO.StreamReader]::new($archive.GetEntry('LLMChat/config.ini').Open())
        try { if ($reader.ReadToEnd() -cne $config) { throw 'Distribution config does not match the clean defaults.' } }
        finally { $reader.Dispose() }
    } finally { $archive.Dispose() }
    Get-Item -LiteralPath $path | Select-Object FullName, Length
} finally {
    & $lockScript release -Global -Owner $owner
}
