$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).ProviderPath
$lock = Join-Path $PSScriptRoot 'file-lock.ps1'
$owner = 'build-speed-test-' + $PID
$workParent = Join-Path $root 'tmp'
$work = Join-Path $workParent ('build-speed-test-' + [guid]::NewGuid().ToString('N'))
$locked = $false
$records = @()

function Copy-Input([string]$InputPath, [string]$Destination) {
    $entry = Get-Item -LiteralPath $InputPath -Force
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        ($entry.PSIsContainer -and (Get-ChildItem -LiteralPath $InputPath -Recurse -Force |
            Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1))) {
        throw "测速输入含有符号链接或目录联接：$InputPath"
    }
    Copy-Item -LiteralPath $InputPath -Destination $Destination -Recurse
}

function Measure-Release([string]$Variant, [string]$Phase) {
    [Console]::WriteLine("PROGRESS $Variant $Phase")
    $copy = Join-Path $work $Variant
    $desktop = Join-Path $copy 'frontend\src-tauri'
    $target = Join-Path $copy 'target'
    $log = Join-Path $copy 'cargo.log'
    $scratch = Join-Path $copy 'temp'
    $null = [IO.Directory]::CreateDirectory($scratch)
    if ($Phase -eq 'incremental') {
        [IO.File]::SetLastWriteTimeUtc((Join-Path $desktop 'src\lib.rs'), [DateTime]::UtcNow)
    }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Push-Location -LiteralPath $desktop
    $previousTemp = $env:TEMP
    $previousTmp = $env:TMP
    $previousTarget = $env:CARGO_TARGET_DIR
    $previousBuildDirectory = $env:CARGO_BUILD_BUILD_DIR
    try {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $env:TEMP = $scratch
        $env:TMP = $scratch
        $env:CARGO_TARGET_DIR = $target
        $env:CARGO_BUILD_BUILD_DIR = $target
        & $cargo build --release --bins --features tauri/custom-protocol --locked --offline --target-dir $target 2>&1 |
            ForEach-Object { [string]$_ } | Set-Content -LiteralPath $log -Encoding UTF8
        $code = $LASTEXITCODE
    } finally {
        $env:TEMP = $previousTemp
        $env:TMP = $previousTmp
        $env:CARGO_TARGET_DIR = $previousTarget
        $env:CARGO_BUILD_BUILD_DIR = $previousBuildDirectory
        $ErrorActionPreference = $previousPreference
        Pop-Location
        $clock.Stop()
    }
    if ($code -ne 0) {
        $detail = (Get-Content -LiteralPath $log -Tail 18) -join [Environment]::NewLine
        throw "Release 测速失败（$Variant / $Phase，退出码 $code）`n$detail"
    }
    [pscustomobject]@{ variant = $Variant; phase = $Phase; seconds = [Math]::Round($clock.Elapsed.TotalSeconds, 2) }
}

try {
    Write-Output 'PROGRESS waiting'
    & $lock acquire -Global -Owner $owner -OwnerProcessId $PID -WaitSeconds 60 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '其他构建正在使用仓库，请等它结束后启动测速。' }
    $locked = $true
    Write-Output 'PROGRESS prepare'
    $cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
    $desktop = Join-Path $root 'frontend\src-tauri'
    $dist = Join-Path $root 'frontend\dist'
    $wasm = @(Get-ChildItem -LiteralPath (Join-Path $dist 'assets') -File -Filter 'ort-wasm-simd-threaded.asyncify-*.wasm')
    if ($wasm.Count -ne 1) { throw '测速需要已准备好的前端 dist 和唯一的 ORT WASM 文件。' }
    $null = [IO.Directory]::CreateDirectory($workParent)
    if ((Get-Item -LiteralPath $workParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '测速目录不能是目录联接。' }
    $null = [IO.Directory]::CreateDirectory($work)
    foreach ($variant in @('embedded', 'external')) {
        $copy = Join-Path $work "$variant\frontend\src-tauri"
        $null = [IO.Directory]::CreateDirectory($copy)
        foreach ($item in @('Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json', 'src', 'capabilities', 'permissions', 'icons', 'binaries', 'resources')) {
            Copy-Input (Join-Path $desktop $item) $copy
        }
        $frontend = Split-Path -Parent $copy
        Copy-Input $dist $frontend
        if ($variant -eq 'external') {
            $external = Join-Path $copy 'resources\web-assets\build-speed-test-wasm'
            $null = [IO.Directory]::CreateDirectory($external)
            $asset = (Resolve-Path -LiteralPath (Join-Path $frontend ('dist\assets\' + $wasm[0].Name))).ProviderPath
            if (!$asset.StartsWith($work + '\', [StringComparison]::OrdinalIgnoreCase) -or
                !$external.StartsWith($work + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '测速 WASM 路径超出了临时目录。' }
            Move-Item -LiteralPath $asset -Destination $external
        }
    }
    $env:CARGO_BUILD_JOBS = [string][Math]::Min(3, [Environment]::ProcessorCount)
    $env:RUST_MIN_STACK = '33554432'
    $env:RUSTC_WRAPPER = $null
    $env:RUSTC_WORKSPACE_WRAPPER = $null
    foreach ($phase in @('full', 'incremental')) {
        foreach ($variant in @('embedded', 'external')) {
            $records += Measure-Release $variant $phase
        }
    }
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
            if (Test-Path -LiteralPath $location) { throw "测速目录未清理完：$location" }
        }
    } finally {
        if ($locked) {
            & $lock release -Global -Owner $owner | Out-Null
            if ($LASTEXITCODE -ne 0) { throw '无法释放构建测速锁。' }
        }
    }
}
Write-Output ('RESULT ' + (ConvertTo-Json -InputObject $records -Compress))
