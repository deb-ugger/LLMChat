$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-temp-cleanup.ps1')

function Assert-TempCleanup([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

$testTemp = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp')).TrimEnd('\')
$testId = [Guid]::NewGuid().ToString('N')
$fixture = [IO.Path]::GetFullPath((Join-Path $testTemp ('llmchat-temp-retention-test-' + $testId)))
$report = [IO.Path]::GetFullPath((Join-Path $testTemp ('llmchat-temp-retention-report-' + $testId + '.json')))
$tempPrefix = $testTemp + '\'
foreach ($testPath in @($fixture, $report)) {
    if (!$testPath.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or $testPath -eq $testTemp) {
        throw "Fixture path must stay within Temp: $testPath"
    }
}
$locked = $null
try {
    $nested = Join-Path $fixture 'nested\attachments'
    $prefixedFolder = Join-Path $fixture 'codex-clipboard-empty-folder'
    $null = New-Item -ItemType Directory -Path $nested, $prefixedFolder -Force
    $attachments = @(
        (Join-Path $fixture 'codex-clipboard-root.png'),
        (Join-Path $nested 'codex-clipboard-nested.png'),
        (Join-Path $nested 'CODEX-CLIPBOARD-upper.webp')
    )
    $junk = @((Join-Path $fixture 'discard.tmp'), (Join-Path $nested 'discard.png'), (Join-Path $prefixedFolder 'discard.tmp'))
    foreach ($path in $attachments + $junk) { [IO.File]::WriteAllText($path, 'fixture:' + [IO.Path]::GetFileName($path)) }
    $hashes = @{}; foreach ($path in $attachments) { $hashes[$path] = (Get-FileHash -LiteralPath $path).Hash }
    $readonly = Get-Item -LiteralPath $attachments[0]
    $readonly.Attributes = $readonly.Attributes -bor [IO.FileAttributes]::ReadOnly
    $occupied = Join-Path $fixture 'in-use.tmp'
    [IO.File]::WriteAllText($occupied, 'must report the locked file')
    $locked = [IO.File]::Open($occupied, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)

    $result = Invoke-BuildTempCleanup -Directory $fixture -ReportPath $report
    foreach ($path in $attachments) {
        Assert-TempCleanup (Test-Path -LiteralPath $path) "Deleted clipboard attachment: $path"
        Assert-TempCleanup ((Get-FileHash -LiteralPath $path).Hash -eq $hashes[$path]) "Attachment content changed: $path"
    }
    Assert-TempCleanup ([bool]((Get-Item -LiteralPath $attachments[0]).Attributes -band [IO.FileAttributes]::ReadOnly)) 'Preservation must not change file attributes.'
    foreach ($path in $junk) { Assert-TempCleanup (!(Test-Path -LiteralPath $path)) "Ordinary temporary file was not cleaned: $path" }
    Assert-TempCleanup (Test-Path -LiteralPath $nested) 'The attachment parent directory must remain.'
    Assert-TempCleanup (!(Test-Path -LiteralPath $prefixedFolder)) 'A directory name alone must not preserve unrelated temporary files.'
    Assert-TempCleanup ($result.PreservedFiles -eq $attachments.Count) 'Preserved attachment count is incorrect.'
    $saved = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    Assert-TempCleanup ($saved.preservedFiles -eq $attachments.Count) 'Report must include preserved attachment count.'
    Assert-TempCleanup (@($saved.remaining | Where-Object preserved).Count -eq $attachments.Count) 'Report must identify intentionally preserved attachments.'
    Assert-TempCleanup (@($saved.remaining | Where-Object { $_.path -eq $occupied -and !$_.preserved }).Count -eq 1) 'Locked-file errors must remain visible.'
    Assert-TempCleanup (@($saved.remaining | Where-Object { $_.path -eq $nested -and $_.reason -eq 'Contains preserved or in-use temporary items' }).Count -eq 1) 'Parent directory retention must not be reported as a deletion error.'
    $again = Invoke-BuildTempCleanup -Directory $fixture -ReportPath $report
    Assert-TempCleanup ($again.PreservedFiles -eq $attachments.Count -and $again.DeletedFiles -eq 0) 'A repeated cleanup must keep attachments without reporting them as deleted.'
    Write-Output 'PASS: root/nested/case-insensitive clipboard files and attributes preserved; ordinary files cleaned; locked files and retained directories reported.'
} finally {
    if ($locked) { $locked.Dispose() }
    foreach ($testPath in @($fixture, $report)) {
        $resolved = [IO.Path]::GetFullPath($testPath)
        if (!$resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or $resolved -eq $testTemp) {
            throw "Refusing fixture cleanup outside Temp: $resolved"
        }
        if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
}
