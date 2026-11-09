[CmdletBinding()]
param([string]$DxArchiveZipPath = '', [string]$WolfTLPath = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'frontend\src-tauri\resources\wolf'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$target = Join-Path $output 'WolfTL.exe'
if (!(Test-Path -LiteralPath $target)) {
    if ($WolfTLPath) { Copy-Item -LiteralPath $WolfTLPath -Destination $target }
    else { Invoke-WebRequest -Uri 'https://github.com/Sinflower/WolfTL/releases/download/v0.6.2/WolfTL.exe' -OutFile $target }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne 'A66FFCDB8EFA6340B6003CB0AFE0CB2BCF3ABA5C14499D0B67F8FB868BCFC276') { Remove-Item -LiteralPath $target; throw 'WolfTL checksum mismatch.' }
}
$license = Join-Path $output 'WOLFTL-LICENSE.txt'
if (!(Test-Path -LiteralPath $license)) { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/Sinflower/WolfTL/v0.6.2/LICENSE' -OutFile $license }
if ($DxArchiveZipPath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $DxArchiveZipPath).Path)
    try {
        $entry = $zip.Entries | Where-Object { $_.Name -eq 'DxaDecode.exe' } | Select-Object -First 1
        if (!$entry) { throw 'DXArchive package does not contain DxaDecode.exe.' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $output 'DxaDecode.exe'), $true)
    } finally { $zip.Dispose() }
}
@'
WolfTL v0.6.2: https://github.com/Sinflower/WolfTL (MIT)
WolfTL executable SHA256: A66FFCDB8EFA6340B6003CB0AFE0CB2BCF3ABA5C14499D0B67F8FB868BCFC276
DxaDecode.exe is supplied locally by the user from a DXArchive package.
The clean distribution does not redistribute this user-supplied decoder.
'@ | Set-Content -LiteralPath (Join-Path $output 'SOURCE.txt') -Encoding UTF8
Write-Output "WOLF tools prepared: $output"
