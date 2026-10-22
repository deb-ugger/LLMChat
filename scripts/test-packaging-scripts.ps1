$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptNames = @('prepare-sidecar.ps1', 'prepare-speech-tools.ps1', 'make-portable.ps1')

foreach ($name in $scriptNames) {
    $path = Join-Path $PSScriptRoot $name
    $bytes = [IO.File]::ReadAllBytes($path)
    $hasUtf8Bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $hasNonAscii = @($bytes | Where-Object { $_ -gt 127 }).Count -gt 0
    if ($hasNonAscii -and !$hasUtf8Bom) {
        throw "$name must use UTF-8 with BOM for Windows PowerShell 5.1."
    }

    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
        throw ($errors | ForEach-Object { "${name}:$($_.Extent.StartLineNumber): $($_.Message)" } | Out-String)
    }

    # Also check the CP936 decoding used by Chinese Windows PowerShell 5.1.
    $source = if ($hasUtf8Bom) {
        [Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    } else {
        [Text.Encoding]::GetEncoding(936).GetString($bytes)
    }
    [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { throw "$name does not parse with CP936 defaults." }
    Write-Output "PASS: $name parses (PowerShell $($PSVersionTable.PSVersion))."
}

$readme = Get-Content -LiteralPath (Join-Path $projectRoot 'README.md') -Raw -Encoding UTF8
foreach ($name in $scriptNames) {
    if (!$readme.Contains("powershell -File scripts/$name")) { throw "README is missing the packaging command for $name." }
}
Write-Output 'PASS: README packaging commands match the checked scripts.'
