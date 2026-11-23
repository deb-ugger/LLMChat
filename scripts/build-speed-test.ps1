[CmdletBinding()]
param([string]$Tests = 'wasm-full,wasm-incremental,cargo-cache,frontend-preview,backend-only,parallel')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).ProviderPath
$lock = Join-Path $PSScriptRoot 'file-lock.ps1'
$owner = 'build-speed-test-' + $PID
$workParent = Join-Path $root 'tmp'
$work = Join-Path $workParent ('build-speed-test-' + [guid]::NewGuid().ToString('N'))
$locked = $false
$records = [Collections.Generic.List[object]]::new()
$allowed = @('wasm-full', 'wasm-incremental', 'cargo-cache', 'frontend-preview', 'backend-only', 'parallel')
$selected = @($Tests.Split(',') | Select-Object -Unique)
if (!$selected.Count -or @($selected | Where-Object { $_ -cnotin $allowed }).Count) {
    throw '请选择有效的构建测试项。'
}
$wasmSelected = 'wasm-full' -in $selected -or 'wasm-incremental' -in $selected
$releaseSelected = $wasmSelected -or 'cargo-cache' -in $selected -or 'backend-only' -in $selected -or 'parallel' -in $selected
$pipelineSelected = 'frontend-preview' -in $selected -or 'backend-only' -in $selected -or 'parallel' -in $selected
$executor = (Get-Process -Id $PID).Path

function Copy-Input([string]$InputPath, [string]$Destination) {
    $entry = Get-Item -LiteralPath $InputPath -Force
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($entry.PSIsContainer -and (Get-ChildItem -LiteralPath $InputPath -Recurse -Force |
            Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1))) {
        throw "测速输入含有符号链接或目录联接：$InputPath"
    }
    Copy-Item -LiteralPath $InputPath -Destination $Destination -Recurse
}

# Also invoked by the frontend/backend workers in separate PowerShell processes.
$timedCommand = {
    param([string]$Program, [string[]]$CommandArguments, [string]$Directory, [string]$Log)
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    Push-Location -LiteralPath $Directory
    try {
        $clock = [Diagnostics.Stopwatch]::StartNew()
        & $Program @CommandArguments 2>&1 | ForEach-Object { [string]$_ } |
            Out-File -LiteralPath $Log -Encoding UTF8
        $code = $LASTEXITCODE
        $clock.Stop()
        if ($code -ne 0) {
            $detail = (Get-Content -LiteralPath $Log -Tail 18) -join [Environment]::NewLine
            throw "测速命令失败（退出码 $code）`n$detail"
        }
        [Math]::Round($clock.Elapsed.TotalSeconds, 3)
    } finally { Pop-Location }
}

function Measure-Release([string]$Variant, [string]$Phase, [int]$Round = 1) {
    [Console]::WriteLine("PROGRESS $Variant $Phase $Round")
    $copy = Join-Path $work $Variant
    $desktop = Join-Path $copy 'frontend/src-tauri'
    $target = Join-Path $desktop 'target'
    $log = Join-Path $copy 'cargo.log'
    $scratch = Join-Path $copy 'temp'
    $null = [IO.Directory]::CreateDirectory($scratch)
    if ($Phase -eq 'incremental') {
        [IO.File]::SetLastWriteTimeUtc((Join-Path $desktop 'src/lib.rs'), [DateTime]::UtcNow)
    }
    $environment = @{
        TEMP = $scratch
        TMP = $scratch
        CARGO_TARGET_DIR = $target
        CARGO_BUILD_BUILD_DIR = $target
        CARGO_LOG = 'cargo::core::compiler::fingerprint=info'
    }
    $previous = @{}
    foreach ($key in $environment.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $environment[$key], 'Process')
    }
    try {
        $seconds = & $timedCommand $cargo @('build','--release','--bins','--features','tauri/custom-protocol','--locked','--offline','--timings','-v') $desktop $log
        $metrics = @{ variant = $Variant; phase = $Phase; round = $Round; seconds = $seconds }
        if ($Phase -eq 'nochange') {
            $report = Get-Content -LiteralPath (Join-Path $target 'cargo-timings/cargo-timing.html') -Raw
            if ($report -match '<td>Dirty units:</td>\s*<td>(\d+)</td>') { $metrics.dirty = [int]$Matches[1] }
            if ($report -match '<td>Fresh units:</td>\s*<td>(\d+)</td>') { $metrics.fresh = [int]$Matches[1] }
            $reason = Select-String -LiteralPath $log -Pattern '^\s*Dirty llmchat .*?:\s+(.*)$' | Select-Object -First 1
            if ($reason) { $metrics.reason = $reason.Matches[0].Groups[1].Value.Replace($copy + '\','') }
        }
        [pscustomobject]$metrics
    } finally {
        foreach ($key in $environment.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
    }
}

try {
    Write-Output 'PROGRESS waiting'
    & $lock acquire -Global -Owner $owner -OwnerProcessId $PID -WaitSeconds 60 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '其他构建正在使用仓库，请等它结束后启动测速。' }
    $locked = $true
    Write-Output 'PROGRESS prepare'
    $null = [IO.Directory]::CreateDirectory($workParent)
    if ((Get-Item -LiteralPath $workParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '测速目录不能是目录联接。' }
    $null = [IO.Directory]::CreateDirectory($work)
    if ($releaseSelected) {
        $cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
        $desktop = Join-Path $root 'frontend/src-tauri'
        $dist = Join-Path $root 'frontend/dist'
        if ($wasmSelected) {
            $wasm = @(Get-ChildItem -LiteralPath (Join-Path $dist 'assets') -File -Filter 'ort-wasm-simd-threaded.asyncify-*.wasm')
            if ($wasm.Count -ne 1) { throw 'WASM 测速需要已准备好的前端产物和唯一的 ORT WASM 文件。' }
        }
        $variants = if ($wasmSelected) { @('embedded','external') } else { @('embedded') }
        foreach ($variant in $variants) {
            $copy = Join-Path $work "$variant/frontend/src-tauri"
            $null = [IO.Directory]::CreateDirectory($copy)
            foreach ($item in @('Cargo.toml','Cargo.lock','build.rs','tauri.conf.json','src','capabilities','permissions','icons','binaries','resources')) {
                Copy-Input (Join-Path $desktop $item) $copy
            }
            $frontend = Split-Path -Parent $copy
            if (Test-Path -LiteralPath $dist -PathType Container) {
                Copy-Input $dist $frontend
            } elseif ($wasmSelected -or 'cargo-cache' -in $selected) {
                throw '桌面构建测速需要先准备前端产物。'
            }
            if ($variant -eq 'external') {
                $external = Join-Path $copy 'resources/web-assets/build-speed-test-wasm'
                $null = [IO.Directory]::CreateDirectory($external)
                $asset = (Resolve-Path -LiteralPath (Join-Path $frontend ('dist/assets/' + $wasm[0].Name))).ProviderPath
                if (!$asset.StartsWith($work + '\', [StringComparison]::OrdinalIgnoreCase) -or
                    !$external.StartsWith($work + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '测速 WASM 路径超出了临时目录。' }
                Move-Item -LiteralPath $asset -Destination $external
            }
        }
        $env:CARGO_BUILD_JOBS = [string][Math]::Min(3, [Environment]::ProcessorCount)
        $env:CMAKE_BUILD_PARALLEL_LEVEL = $env:CARGO_BUILD_JOBS
        $env:RUST_MIN_STACK = '33554432'
        $env:RUSTC_WRAPPER = $null
        $env:RUSTC_WORKSPACE_WRAPPER = $null
        if ($wasmSelected -or 'cargo-cache' -in $selected) {
            foreach ($variant in $variants) {
                $cold = Measure-Release $variant 'full'
                if ('wasm-full' -in $selected) { $records.Add($cold) }
                if ($variant -eq 'embedded' -and 'cargo-cache' -in $selected) {
                    foreach ($round in 1..3) { $records.Add((Measure-Release $variant 'nochange' $round)) }
                } elseif ('wasm-incremental' -in $selected) {
                    Measure-Release $variant 'warmup' | Out-Null
                }
            }
            if ('wasm-incremental' -in $selected) {
                foreach ($variant in $variants) { $records.Add((Measure-Release $variant 'incremental')) }
            }
        }
    }
    if ($pipelineSelected) { . (Join-Path $PSScriptRoot 'build-speed-pipeline.ps1') }
} finally {
    try {
        if (Test-Path -LiteralPath $work) {
            Write-Output 'PROGRESS cleanup'
            $location = (Resolve-Path -LiteralPath $work).ProviderPath
            if ($location -ne $work -or (Split-Path -Parent $location) -ne $workParent -or
                (Split-Path -Leaf $location) -notmatch '^build-speed-test-[a-f0-9]{32}$' -or
                ((Get-Item -LiteralPath $location -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "无法安全清理测速目录：$location"
            }
            Remove-Item -LiteralPath $location -Recurse -Force
            if (Test-Path -LiteralPath $location) { throw '测速目录未清理完。' }
        }
    } finally {
        if ($locked) {
            & $lock release -Global -Owner $owner | Out-Null
            if ($LASTEXITCODE -ne 0) { throw '无法释放构建测速锁。' }
        }
    }
}
Write-Output ('RESULT ' + (ConvertTo-Json -InputObject ($records.ToArray()) -Compress))
