param([string]$Proxy = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $projectRoot 'frontend\src-tauri\resources\ffmpeg'
$version = '9.0.2'
if ((Test-Path -LiteralPath (Join-Path $destination 'ffmpeg.exe')) -and
    (Test-Path -LiteralPath (Join-Path $destination 'ffprobe.exe')) -and
    (Test-Path -LiteralPath (Join-Path $destination 'VERSION.txt')) -and
    (Get-Content -LiteralPath (Join-Path $destination 'VERSION.txt') -Raw).Trim() -eq $version) {
    Write-Output "Speech decoding tools already prepared: $version"
    return
}
$taskDirectory = Join-Path ([IO.Path]::GetTempPath()) ('llmchat-speech-tools-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskDirectory | Out-Null
try {
    $url = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-$version-essentials_build.zip"
    $archive = Join-Path $taskDirectory 'ffmpeg.zip'
    $curlOptions = @('--fail','--location','--silent','--show-error','--max-time','300')
    if ($Proxy) { $curlOptions += @('--proxy', $Proxy) }
    $expected = & curl.exe @curlOptions "$url.sha256"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to download FFmpeg checksum' }
    $digest = [regex]::Match([string]$expected, '[0-9a-fA-F]{64}').Value
    if (!$digest) { throw 'FFmpeg checksum response was invalid' }
    & curl.exe @curlOptions --output $archive $url
    if ($LASTEXITCODE -ne 0) { throw 'Failed to download FFmpeg archive' }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $digest) { throw 'FFmpeg archive checksum mismatch' }
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($entry in $zip.Entries) {
            $targetName = if ($entry.FullName.EndsWith('/bin/ffmpeg.exe')) { 'ffmpeg.exe' }
                elseif ($entry.FullName.EndsWith('/bin/ffprobe.exe')) { 'ffprobe.exe' }
                elseif ($entry.Name -eq 'LICENSE') { 'LICENSE' }
                elseif ($entry.Name -eq 'README.txt') { 'README.txt' }
                else { $null }
            if ($targetName) { [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $destination $targetName), $true) }
        }
    } finally { $zip.Dispose() }
    foreach ($name in @('ffmpeg.exe','ffprobe.exe','LICENSE')) {
        if (!(Test-Path -LiteralPath (Join-Path $destination $name))) { throw "FFmpeg package is missing $name" }
    }
    [IO.File]::WriteAllText((Join-Path $destination 'VERSION.txt'), $version)
    [IO.File]::WriteAllText((Join-Path $destination 'SOURCE.txt'), "Windows binaries: $url`nSHA256: $digest`nSource: https://ffmpeg.org/releases/ffmpeg-$version.tar.xz`nBuild information and GPLv3 license: https://www.gyan.dev/ffmpeg/builds/`n")
    Write-Output "Speech decoding tools prepared: $destination"
} finally {
    $resolvedTask = [IO.Path]::GetFullPath($taskDirectory)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolvedTask.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolvedTask -Leaf) -notlike 'llmchat-speech-tools-*') { throw 'Unexpected temporary directory' }
    Remove-Item -LiteralPath $resolvedTask -Recurse -Force
}
