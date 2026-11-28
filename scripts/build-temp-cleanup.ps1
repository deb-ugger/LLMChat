function Invoke-BuildTempCleanup {
    [CmdletBinding()]
    param(
        [string]$Directory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp'),
        [Parameter(Mandatory = $true)][string]$ReportPath
    )

    $temporaryRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp')).TrimEnd('\')
    $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    $prefix = $root + '\'
    if ($root -ne $temporaryRoot -and !$root.StartsWith($temporaryRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Temp cleanup must stay inside $temporaryRoot"
    }
    $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
    if (!$rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Temp cleanup requires a regular directory: $root"
    }
    $report = [IO.Path]::GetFullPath($ReportPath)
    if ($report.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The cleanup report must be saved outside the directory being cleaned.'
    }
    $protected = @(
        [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)),
        [IO.Path]::GetFullPath((Get-Location).ProviderPath)
    )
    $state = [ordered]@{
        directory = $root
        startedAt = [DateTime]::Now.ToString('o')
        deletedFiles = 0L
        deletedDirectories = 0L
        deletedLinks = 0L
        deletedBytes = 0L
        preservedFiles = 0L
    }
    $remaining = [Collections.Generic.List[object]]::new()

    function Remove-BuildTempItem([IO.FileSystemInfo]$Item) {
        $path = [IO.Path]::GetFullPath($Item.FullName)
        if (!$path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Temp cleanup reached an unexpected path: $path"
        }
        foreach ($protectedPath in $protected) {
            if ($path -eq $protectedPath -or $protectedPath.StartsWith($path + '\', [StringComparison]::OrdinalIgnoreCase)) {
                $remaining.Add([pscustomobject]@{ path = $path; reason = 'Current build workspace or working directory' })
                return
            }
        }
        try {
            $Item.Refresh()
            $attributes = $Item.Attributes
            if ([int]$attributes -eq -1) { throw 'The item was removed or its attributes could not be read.' }
            if (!($attributes -band [IO.FileAttributes]::Directory) -and $Item.Name.StartsWith('codex-clipboard-', [StringComparison]::OrdinalIgnoreCase)) {
                $state.preservedFiles++
                $remaining.Add([pscustomobject]@{ path = $path; reason = 'Preserved Codex clipboard attachment'; preserved = $true })
                return
            }
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
                # Delete the link itself without entering its target.
                $Item.Delete()
                $state.deletedLinks++
                return
            }
            if ($attributes -band [IO.FileAttributes]::Directory) {
                foreach ($child in ([IO.DirectoryInfo]$Item).GetFileSystemInfos()) {
                    Remove-BuildTempItem $child
                }
                if (([IO.DirectoryInfo]$Item).GetFileSystemInfos().Length) {
                    $remaining.Add([pscustomobject]@{ path = $path; reason = 'Contains preserved or in-use temporary items' })
                    return
                }
                $Item.Delete()
                $state.deletedDirectories++
            } else {
                $bytes = ([IO.FileInfo]$Item).Length
                if ($attributes -band [IO.FileAttributes]::ReadOnly) {
                    $Item.Attributes = $attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
                }
                $Item.Delete()
                $state.deletedFiles++
                $state.deletedBytes += $bytes
            }
        } catch {
            $remaining.Add([pscustomobject]@{ path = $path; reason = $_.Exception.Message })
        }
    }

    foreach ($item in ([IO.DirectoryInfo]$rootItem).GetFileSystemInfos()) {
        Remove-BuildTempItem $item
    }
    $state.endedAt = [DateTime]::Now.ToString('o')
    $state.remainingCount = $remaining.Count
    $state.remaining = @($remaining.ToArray())
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $report) -Force
    [IO.File]::WriteAllText($report, (ConvertTo-Json -InputObject $state -Depth 5), [Text.UTF8Encoding]::new($false))
    [pscustomobject]@{
        DeletedFiles = $state.deletedFiles
        DeletedDirectories = $state.deletedDirectories
        DeletedLinks = $state.deletedLinks
        DeletedBytes = $state.deletedBytes
        PreservedFiles = $state.preservedFiles
        RemainingCount = $remaining.Count
        ReportPath = $report
    }
}
