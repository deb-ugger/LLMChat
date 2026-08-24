[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("acquire", "release", "renew", "status", "list", "cleanup")]
    [string]$Action,

    [Alias("Path")]
    [string[]]$Paths = @(),

    [string]$Owner = "",

    [ValidateRange(0, 86400)]
    [int]$WaitSeconds = 0,

    [ValidateRange(1, 1440)]
    [int]$LeaseMinutes = 240,

    [switch]$Global,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$lockRoot = Join-Path $repoRoot ".agent-locks"
$globalResource = ".agent-resources/build-and-portable"

function Get-Sha256Hex([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

$mutexName = "Local\LLMChatAgentFileLocks_" + (Get-Sha256Hex $repoRoot.ToLowerInvariant()).Substring(0, 24)

function Invoke-WithRegistryMutex([scriptblock]$Body) {
    $mutex = New-Object System.Threading.Mutex($false, $mutexName)
    $taken = $false
    try {
        try {
            $taken = $mutex.WaitOne([TimeSpan]::FromSeconds(15))
        }
        catch [System.Threading.AbandonedMutexException] {
            $taken = $true
        }
        if (-not $taken) {
            throw "等待文件锁注册表超时。请稍后重试。"
        }
        & $Body
    }
    finally {
        if ($taken) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}

function Convert-ToLockTarget([string]$InputPath) {
    if ([string]::IsNullOrWhiteSpace($InputPath)) {
        throw "锁定路径不能为空。"
    }
    $candidate = if ([System.IO.Path]::IsPathRooted($InputPath)) {
        $InputPath
    }
    else {
        Join-Path $repoRoot $InputPath
    }
    $fullPath = [System.IO.Path]::GetFullPath($candidate)
    $rootPrefix = $repoRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "只能锁定当前仓库内的文件：$InputPath"
    }
    $relative = $fullPath.Substring($rootPrefix.Length).Replace('\', '/')
    $key = Get-Sha256Hex $relative.ToLowerInvariant()
    [pscustomobject]@{
        Path = $relative
        FullPath = $fullPath
        Key = $key
        LockFile = Join-Path $lockRoot ($key + ".lock.json")
    }
}

function Read-LockFile([string]$LockFile) {
    if (-not (Test-Path -LiteralPath $LockFile)) {
        return $null
    }
    try {
        $record = Get-Content -Raw -LiteralPath $LockFile | ConvertFrom-Json
        Add-Member -InputObject $record -NotePropertyName LockFile -NotePropertyValue $LockFile -Force
        return $record
    }
    catch {
        return [pscustomobject]@{
            path = "<损坏的锁文件>"
            owner = "<未知>"
            scope = "file"
            acquiredAt = ""
            expiresAt = "1970-01-01T00:00:00Z"
            LockFile = $LockFile
        }
    }
}

function Test-LockExpired($Record) {
    try {
        return [System.DateTimeOffset]::Parse([string]$Record.expiresAt) -le [System.DateTimeOffset]::UtcNow
    }
    catch {
        return $true
    }
}

function Remove-ExpiredLocksUnsafe {
    if (-not (Test-Path -LiteralPath $lockRoot)) {
        return 0
    }
    $removed = 0
    foreach ($file in Get-ChildItem -LiteralPath $lockRoot -Filter "*.lock.json" -File -ErrorAction SilentlyContinue) {
        $record = Read-LockFile $file.FullName
        if ($null -eq $record -or (Test-LockExpired $record)) {
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
            $removed++
        }
    }
    return $removed
}

function Get-ActiveLocksUnsafe {
    Remove-ExpiredLocksUnsafe | Out-Null
    if (-not (Test-Path -LiteralPath $lockRoot)) {
        return @()
    }
    $records = @()
    foreach ($file in Get-ChildItem -LiteralPath $lockRoot -Filter "*.lock.json" -File -ErrorAction SilentlyContinue) {
        $record = Read-LockFile $file.FullName
        if ($null -ne $record -and -not (Test-LockExpired $record)) {
            $records += $record
        }
    }
    return @($records)
}

function Write-LockFileUnsafe([string]$LockFile, [string]$Path, [string]$Scope, [string]$LockOwner, [datetimeoffset]$ExpiresAt, $Existing) {
    New-Item -ItemType Directory -Path $lockRoot -Force | Out-Null
    $acquiredAt = if ($null -ne $Existing -and -not [string]::IsNullOrWhiteSpace([string]$Existing.acquiredAt)) {
        [string]$Existing.acquiredAt
    }
    else {
        [System.DateTimeOffset]::UtcNow.ToString("o")
    }
    $payload = [ordered]@{
        version = 1
        scope = $Scope
        path = $Path
        owner = $LockOwner
        acquiredAt = $acquiredAt
        expiresAt = $ExpiresAt.ToString("o")
        machine = [System.Environment]::MachineName
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText($LockFile, $payload + [System.Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function Assert-OwnerRequired {
    if ([string]::IsNullOrWhiteSpace($Owner)) {
        throw "操作 '$Action' 必须提供稳定且唯一的 -Owner，例如 cursor-pricing-742。"
    }
}

$targets = @()
if (-not $Global -and $Paths.Count -gt 0) {
    $targets = @($Paths | ForEach-Object { Convert-ToLockTarget $_ } | Sort-Object Key -Unique)
}
if ($Global -and $Paths.Count -gt 0) {
    throw "使用 -Global 时不要再传 -Paths。"
}
if (-not $Global -and $Action -in @("acquire", "release", "renew", "status") -and $targets.Count -eq 0) {
    throw "操作 '$Action' 至少需要一个 -Paths。"
}

$globalLockFile = Join-Path $lockRoot "global.lock.json"

if ($Action -eq "cleanup") {
    $count = Invoke-WithRegistryMutex { Remove-ExpiredLocksUnsafe }
    Write-Output "已清理 $count 个过期锁。"
    exit 0
}

if ($Action -eq "list") {
    $active = Invoke-WithRegistryMutex { @(Get-ActiveLocksUnsafe) }
    if ($active.Count -eq 0) {
        Write-Output "当前没有活动锁。"
    }
    else {
        $active |
            Sort-Object scope, path |
            Select-Object scope, path, owner, acquiredAt, expiresAt |
            Format-Table -AutoSize
    }
    exit 0
}

if ($Action -eq "status") {
    $active = Invoke-WithRegistryMutex { @(Get-ActiveLocksUnsafe) }
    $wanted = @($targets | ForEach-Object { $_.Path })
    $result = @($active | Where-Object { $_.scope -eq "global" -or $wanted -contains $_.path })
    if ($result.Count -eq 0) {
        Write-Output "指定文件当前未被锁定。"
    }
    else {
        $result |
            Select-Object scope, path, owner, acquiredAt, expiresAt |
            Format-Table -AutoSize
    }
    exit 0
}

Assert-OwnerRequired

if ($Action -eq "acquire") {
    $deadline = [System.DateTimeOffset]::UtcNow.AddSeconds($WaitSeconds)
    while ($true) {
        $attempt = Invoke-WithRegistryMutex {
            $active = @(Get-ActiveLocksUnsafe)
            $conflicts = @()
            if ($Global) {
                $conflicts = @($active | Where-Object { $_.owner -ne $Owner })
            }
            else {
                $wanted = @($targets | ForEach-Object { $_.Path })
                $conflicts = @($active | Where-Object {
                    $_.owner -ne $Owner -and ($_.scope -eq "global" -or $wanted -contains $_.path)
                })
            }

            if ($conflicts.Count -gt 0) {
                return [pscustomobject]@{ Success = $false; Conflicts = $conflicts }
            }

            $expires = [System.DateTimeOffset]::UtcNow.AddMinutes($LeaseMinutes)
            if ($Global) {
                $existing = $active | Where-Object { $_.scope -eq "global" -and $_.owner -eq $Owner } | Select-Object -First 1
                Write-LockFileUnsafe $globalLockFile $globalResource "global" $Owner $expires $existing
            }
            else {
                foreach ($target in $targets) {
                    $existing = $active | Where-Object { $_.scope -eq "file" -and $_.path -eq $target.Path -and $_.owner -eq $Owner } | Select-Object -First 1
                    Write-LockFileUnsafe $target.LockFile $target.Path "file" $Owner $expires $existing
                }
            }
            return [pscustomobject]@{ Success = $true; Conflicts = @(); ExpiresAt = $expires }
        }

        if ($attempt.Success) {
            if ($Global) {
                Write-Output "已取得全局构建锁：owner=$Owner；到期=$($attempt.ExpiresAt.ToString('o'))"
            }
            else {
                Write-Output "已取得 $($targets.Count) 个文件锁：owner=$Owner；到期=$($attempt.ExpiresAt.ToString('o'))"
                $targets | ForEach-Object { Write-Output ("  " + $_.Path) }
            }
            exit 0
        }

        if ([System.DateTimeOffset]::UtcNow -ge $deadline) {
            $conflictTable = $attempt.Conflicts |
                Select-Object scope, path, owner, acquiredAt, expiresAt |
                Format-Table -AutoSize | Out-String
            [System.Console]::Error.WriteLine("文件锁冲突，未修改任何锁。占用情况：")
            [System.Console]::Error.WriteLine($conflictTable.TrimEnd())
            exit 2
        }
        Start-Sleep -Milliseconds 250
    }
}

if ($Action -eq "renew") {
    $renewed = Invoke-WithRegistryMutex {
        $active = @(Get-ActiveLocksUnsafe)
        $expires = [System.DateTimeOffset]::UtcNow.AddMinutes($LeaseMinutes)
        $records = if ($Global) {
            @($active | Where-Object { $_.scope -eq "global" })
        }
        else {
            $wanted = @($targets | ForEach-Object { $_.Path })
            @($active | Where-Object { $_.scope -eq "file" -and $wanted -contains $_.path })
        }
        foreach ($record in $records) {
            if ($record.owner -ne $Owner -and -not $Force) {
                throw "不能续期其他所有者的锁：$($record.path)，owner=$($record.owner)"
            }
            Write-LockFileUnsafe $record.LockFile $record.path $record.scope $Owner $expires $record
        }
        return $records.Count
    }
    Write-Output "已续期 $renewed 个锁：owner=$Owner"
    exit 0
}

if ($Action -eq "release") {
    $released = Invoke-WithRegistryMutex {
        $active = @(Get-ActiveLocksUnsafe)
        $records = if ($Global) {
            @($active | Where-Object { $_.scope -eq "global" })
        }
        else {
            $wanted = @($targets | ForEach-Object { $_.Path })
            @($active | Where-Object { $_.scope -eq "file" -and $wanted -contains $_.path })
        }
        foreach ($record in $records) {
            if ($record.owner -ne $Owner -and -not $Force) {
                throw "不能释放其他所有者的锁：$($record.path)，owner=$($record.owner)"
            }
            Remove-Item -LiteralPath $record.LockFile -Force
        }
        return $records.Count
    }
    Write-Output "已释放 $released 个锁：owner=$Owner"
    exit 0
}

throw "未知操作：$Action"
