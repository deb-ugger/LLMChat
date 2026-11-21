# Use the same encoding before capturing native tools in parent and worker shells.
$buildUtf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $buildUtf8
[Console]::OutputEncoding = $buildUtf8
$OutputEncoding = $buildUtf8
# MSBuild's localized banner can otherwise use the Windows ANSI code page.
$env:VSLANG = '1033'
$env:DOTNET_CLI_UI_LANGUAGE = 'en-US'
$env:DOTNET_CLI_FORCE_UTF8_ENCODING = 'true'
# Shared by the build entry points; cache files contain metadata only.
$script:BuildCacheRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'backend\build\incremental'
$script:BuildCopiedFiles = [Collections.Generic.List[string]]::new()
function Get-BuildFiles([string[]]$Paths) {
    foreach ($path in $Paths) {
        if (!(Test-Path -LiteralPath $path)) { continue }
        $item = Get-Item -LiteralPath $path
        if (!$item.PSIsContainer) { $item; continue }
        $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($item.FullName)
        while ($pending.Count) {
            foreach ($child in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
                if ($child.PSIsContainer) { if ($child.Name -notin @('bin','obj','node_modules','.git','target','tests')) { $pending.Push($child.FullName) } }
                else { $child }
            }
        }
    }
}
function Get-BuildInventory([string[]]$Paths, [switch]$Inputs) {
    $hasher = if ($Inputs) { [Security.Cryptography.SHA256]::Create() }
    try {
        $rows = @(foreach ($file in @(Get-BuildFiles $Paths | Sort-Object FullName -Unique)) {
            $digest = ''
            if ($Inputs -and ($file.Name -like '.env*' -or $file.Extension -in @('.ts','.tsx','.js','.mjs','.cjs','.css','.html','.cs','.csproj','.json','.toml','.ps1','.cmd','.py','.txt','.props','.targets'))) {
                $stream = [IO.File]::OpenRead($file.FullName)
                try { $digest = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','') }
                finally { $stream.Dispose() }
            }
            '{0}|{1}|{2}|{3}' -f $file.FullName,$file.Length,$file.LastWriteTimeUtc.Ticks,$digest
        })
        return ($rows -join "`n")
    } finally {
        if ($hasher) { $hasher.Dispose() }
    }
}
function Test-BuildCache([string]$Name, [string[]]$Inputs, [string[]]$Outputs, [string]$Identity) {
    $path = Join-Path $script:BuildCacheRoot "$Name.json"
    if (!(Test-Path -LiteralPath $path)) { return $false }
    try { $saved = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { return $false }
    foreach ($output in $Outputs) { if (!(Test-Path -LiteralPath $output)) { return $false } }
    return $saved.identity -ceq $Identity -and $saved.inputs -ceq (Get-BuildInventory $Inputs -Inputs) -and $saved.outputs -ceq (Get-BuildInventory $Outputs)
}
function Save-BuildCache([string]$Name, [string[]]$Inputs, [string[]]$Outputs, [string]$Identity) {
    foreach ($output in $Outputs) { if (!(Test-Path -LiteralPath $output)) { throw "Missing build output: $output" } }
    New-Item -ItemType Directory -Path $script:BuildCacheRoot -Force | Out-Null
    $value = @{ identity=$Identity; inputs=(Get-BuildInventory $Inputs -Inputs); outputs=(Get-BuildInventory $Outputs) } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $script:BuildCacheRoot "$Name.json"),$value,[Text.UTF8Encoding]::new($false))
}
function Copy-BuildFile([string]$Source, [string]$Destination) {
    $from = Get-Item -LiteralPath $Source
    if (Test-Path -LiteralPath $Destination -PathType Container) { $Destination = Join-Path $Destination $from.Name }
    $to = Get-Item -LiteralPath $Destination -ErrorAction SilentlyContinue
    if ($to -and $to.Length -eq $from.Length -and $to.LastWriteTimeUtc.Ticks -eq $from.LastWriteTimeUtc.Ticks) { return }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    $script:BuildCopiedFiles.Add([IO.Path]::GetFullPath($Destination))
}
function Copy-BuildTree([string]$Source, [string]$Destination) {
    $prefix = (Get-Item -LiteralPath $Source).FullName.TrimEnd('\') + '\'
    foreach ($file in Get-ChildItem -LiteralPath $Source -Recurse -File) { Copy-BuildFile $file.FullName (Join-Path $Destination $file.FullName.Substring($prefix.Length)) }
}
function Get-BuildJobs {
    $cpu = [Environment]::ProcessorCount
    try { $freeGB = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).FreePhysicalMemory / 1MB; return [Math]::Max(1,[Math]::Min(4,[Math]::Min($cpu,[Math]::Floor($freeGB / 3)))) }
    catch { return [Math]::Max(1,[Math]::Min(2,$cpu)) }
}
