[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("acquire", "release", "release-all", "renew", "status", "list", "cleanup", "diagnose")]
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
$waitRoot = Join-Path $lockRoot "waiters"
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

function Test-WaiterStale($Record) {
    if (Test-LockExpired $Record) {
        return $true
    }
    if ([string]$Record.machine -ne [System.Environment]::MachineName) {
        return $false
    }
    try {
        $process = Get-Process -Id ([int]$Record.processId) -ErrorAction Stop
        if (-not [string]::IsNullOrWhiteSpace([string]$Record.processStartedAt)) {
            $expected = [System.DateTimeOffset]::Parse([string]$Record.processStartedAt)
            $actual = [System.DateTimeOffset]$process.StartTime
            if ([Math]::Abs(($actual - $expected).TotalSeconds) -gt 2) {
                return $true
            }
        }
        return $false
    }
    catch {
        return $true
    }
}

function Remove-StaleWaitersUnsafe {
    if (-not (Test-Path -LiteralPath $waitRoot)) {
        return 0
    }
    $removed = 0
    foreach ($file in Get-ChildItem -LiteralPath $waitRoot -Filter "*.wait.json" -File -ErrorAction SilentlyContinue) {
        $record = Read-LockFile $file.FullName
        if ($null -eq $record -or (Test-WaiterStale $record)) {
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
            $removed++
        }
    }
    return $removed
}

function Get-ActiveWaitersUnsafe {
    Remove-StaleWaitersUnsafe | Out-Null
    if (-not (Test-Path -LiteralPath $waitRoot)) {
        return @()
    }
    $records = @()
    foreach ($file in Get-ChildItem -LiteralPath $waitRoot -Filter "*.wait.json" -File -ErrorAction SilentlyContinue) {
        $record = Read-LockFile $file.FullName
        if ($null -ne $record -and -not (Test-WaiterStale $record)) {
            $records += $record
        }
    }
    return @($records)
}

function Get-WaiterFile([string]$LockOwner) {
    $key = Get-Sha256Hex ($LockOwner.ToLowerInvariant() + "|" + $PID)
    return Join-Path $waitRoot ($key + ".wait.json")
}

function Write-WaiterUnsafe([string]$LockOwner, [string]$Scope, [string[]]$RequestedPaths, [datetimeoffset]$Deadline) {
    New-Item -ItemType Directory -Path $waitRoot -Force | Out-Null
    $processStartedAt = try { ([System.DateTimeOffset](Get-Process -Id $PID).StartTime).ToString("o") } catch { "" }
    $payload = [ordered]@{
        version = 1
        kind = "waiter"
        scope = $Scope
        paths = @($RequestedPaths)
        owner = $LockOwner
        requestedAt = [System.DateTimeOffset]::UtcNow.ToString("o")
        expiresAt = $Deadline.ToString("o")
        machine = [System.Environment]::MachineName
        processId = $PID
        processStartedAt = $processStartedAt
    } | ConvertTo-Json
    $waiterFile = Get-WaiterFile $LockOwner
    [System.IO.File]::WriteAllText($waiterFile, $payload + [System.Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function Remove-OwnWaiterUnsafe([string]$LockOwner) {
    $waiterFile = Get-WaiterFile $LockOwner
    Remove-Item -LiteralPath $waiterFile -Force -ErrorAction SilentlyContinue
}

function Get-WaiterConflicts($Waiter, $ActiveLocks) {
    if ([string]$Waiter.scope -eq "global") {
        return @($ActiveLocks | Where-Object { $_.owner -ne $Waiter.owner })
    }
    $wanted = @($Waiter.paths)
    return @($ActiveLocks | Where-Object {
        $_.owner -ne $Waiter.owner -and ($_.scope -eq "global" -or $wanted -contains $_.path)
    })
}

function Test-WaitReachable([string]$From, [string]$Target, $Edges) {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $visited = @{}
    $pending.Push($From)
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        if ($current -eq $Target) {
            return $true
        }
        if ($visited.ContainsKey($current)) {
            continue
        }
        $visited[$current] = $true
        foreach ($next in @($Edges | Where-Object { $_.waiter -eq $current } | ForEach-Object { [string]$_.blocker } | Sort-Object -Unique)) {
            if (-not $visited.ContainsKey($next)) {
                $pending.Push($next)
            }
        }
    }
    return $false
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
    $result = Invoke-WithRegistryMutex {
        [pscustomobject]@{
            Locks = Remove-ExpiredLocksUnsafe
            Waiters = Remove-StaleWaitersUnsafe
        }
    }
    Write-Output "已清理 $($result.Locks) 个过期锁、$($result.Waiters) 个失效等待记录。"
    exit 0
}

if ($Action -eq "list") {
    $snapshot = Invoke-WithRegistryMutex {
        [pscustomobject]@{
            Locks = @(Get-ActiveLocksUnsafe)
            Waiters = @(Get-ActiveWaitersUnsafe)
        }
    }
    if ($snapshot.Locks.Count -eq 0) {
        Write-Output "当前没有活动锁。"
    }
    else {
        Write-Output "活动锁："
        $snapshot.Locks |
            Sort-Object scope, path |
            Select-Object scope, path, owner, acquiredAt, expiresAt |
            Format-Table -AutoSize
    }
    if ($snapshot.Waiters.Count -eq 0) {
        Write-Output "当前没有锁等待者。"
    }
    else {
        Write-Output "锁等待者："
        $snapshot.Waiters |
            Sort-Object requestedAt |
            Select-Object scope, @{Name="paths"; Expression={ @($_.paths) -join "," }}, owner, processId, requestedAt, expiresAt |
            Format-Table -AutoSize
    }
    exit 0
}

if ($Action -eq "diagnose") {
    $snapshot = Invoke-WithRegistryMutex {
        [pscustomobject]@{
            Locks = @(Get-ActiveLocksUnsafe)
            Waiters = @(Get-ActiveWaitersUnsafe)
        }
    }
    $edges = @()
    $hazards = @()
    foreach ($waiter in $snapshot.Waiters) {
        $conflicts = @(Get-WaiterConflicts $waiter $snapshot.Locks)
        foreach ($blocker in $conflicts) {
            $edges += [pscustomobject]@{
                waiter = $waiter.owner
                requested = if ($waiter.scope -eq "global") { $globalResource } else { @($waiter.paths) -join "," }
                blocker = $blocker.owner
                blockedBy = $blocker.path
            }
        }
        $held = @($snapshot.Locks | Where-Object { $_.owner -eq $waiter.owner })
        if ($held.Count -gt 0 -and $conflicts.Count -gt 0) {
            $hazards += "owner=$($waiter.owner) 在持有 $($held.Count) 个锁时等待其他 owner；必须先释放自己的锁，再重新一次性申请。"
        }
    }
    foreach ($edge in $edges) {
        $remainingEdges = @($edges | Where-Object { $_ -ne $edge })
        if (Test-WaitReachable $edge.blocker $edge.waiter $remainingEdges) {
            $hazards += "检测到循环等待链，其中包含：$($edge.waiter) -> $($edge.blocker)。"
        }
    }
    if ($edges.Count -gt 0) {
        Write-Output "等待关系："
        $edges | Sort-Object waiter, blocker -Unique | Format-Table -AutoSize
    }
    if ($hazards.Count -gt 0) {
        $hazards | Sort-Object -Unique | ForEach-Object { [System.Console]::Error.WriteLine("锁风险：$_") }
        [System.Console]::Error.WriteLine("处理建议：通知相关 owner 正常 release；不得 -Force。确认 owner 已停止且用户明确同意后，才可强制处理未过期锁。")
        exit 3
    }
    if ($edges.Count -eq 0) {
        Write-Output "未发现锁等待关系或循环等待。"
    }
    else {
        Write-Output "存在正常等待，但未发现持锁等待或双向循环。"
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

if ($Action -eq "release-all") {
    $released = Invoke-WithRegistryMutex {
        $active = @(Get-ActiveLocksUnsafe)
        $records = @($active | Where-Object { $_.owner -eq $Owner })
        foreach ($record in $records) {
            Remove-Item -LiteralPath $record.LockFile -Force
        }
        if (Test-Path -LiteralPath $waitRoot) {
            foreach ($file in Get-ChildItem -LiteralPath $waitRoot -Filter "*.wait.json" -File -ErrorAction SilentlyContinue) {
                $waiter = Read-LockFile $file.FullName
                if ($null -ne $waiter -and $waiter.owner -eq $Owner) {
                    Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
                }
            }
        }
        return $records
    }
    Write-Output "已正常释放 owner=$Owner 的全部 $($released.Count) 个锁。"
    if ($released.Count -gt 0) {
        $released | Select-Object scope, path, acquiredAt | Format-Table -AutoSize
    }
    exit 0
}

if ($Action -eq "acquire") {
    $deadline = [System.DateTimeOffset]::UtcNow.AddSeconds($WaitSeconds)
    while ($true) {
        $attempt = Invoke-WithRegistryMutex {
            $active = @(Get-ActiveLocksUnsafe)
            $ownedFiles = @($active | Where-Object { $_.owner -eq $Owner -and $_.scope -eq "file" })
            $ownedGlobal = @($active | Where-Object { $_.owner -eq $Owner -and $_.scope -eq "global" })
            if ($Global -and $ownedFiles.Count -gt 0 -and $ownedGlobal.Count -eq 0) {
                return [pscustomobject]@{
                    Success = $false
                    InvalidReason = "禁止从文件锁升级为全局锁：owner=$Owner 当前持有 $($ownedFiles.Count) 个文件锁。请先正常 release，再在不持有任何锁时申请全局锁。"
                    Conflicts = @()
                }
            }
            if (-not $Global -and $ownedGlobal.Count -eq 0 -and $ownedFiles.Count -gt 0) {
                $wanted = @($targets | ForEach-Object { $_.Path })
                $ownedPaths = @($ownedFiles | ForEach-Object { $_.path })
                $additional = @($wanted | Where-Object { $ownedPaths -notcontains $_ })
                if ($additional.Count -gt 0) {
                    return [pscustomobject]@{
                        Success = $false
                        InvalidReason = "禁止逐步扩展文件锁集合：owner=$Owner 已持有文件锁，又申请 $($additional -join ', ')。请先正常 release，再一次性申请完整文件集合。"
                        Conflicts = @()
                    }
                }
            }
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
                if ($WaitSeconds -gt 0) {
                    $requestedPaths = if ($Global) { @($globalResource) } else { @($targets | ForEach-Object { $_.Path }) }
                    Write-WaiterUnsafe $Owner $(if ($Global) { "global" } else { "file" }) $requestedPaths $deadline
                }
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
            Remove-OwnWaiterUnsafe $Owner
            return [pscustomobject]@{ Success = $true; Conflicts = @(); ExpiresAt = $expires }
        }

        if (-not [string]::IsNullOrWhiteSpace([string]$attempt.InvalidReason)) {
            Invoke-WithRegistryMutex { Remove-OwnWaiterUnsafe $Owner }
            [System.Console]::Error.WriteLine($attempt.InvalidReason)
            exit 3
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
            Invoke-WithRegistryMutex { Remove-OwnWaiterUnsafe $Owner }
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
