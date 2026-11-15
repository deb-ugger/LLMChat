[CmdletBinding()]
param(
    [string]$Owner = "manual-build-$PID",
    [string]$Proxy = '',
    [switch]$NoLaunch,
    [switch]$ForceClose
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = Split-Path -Parent $PSScriptRoot
$shell = (Get-Process -Id $PID).Path
$lockScript = Join-Path $PSScriptRoot 'file-lock.ps1'
$locked = $false
$buildResult = 0
. (Join-Path $PSScriptRoot 'build-incremental.ps1')
$buildClock = [Diagnostics.Stopwatch]::StartNew()
$stageClock = [Diagnostics.Stopwatch]::StartNew()
$stageTimes = [ordered]@{}
function Complete-BuildStage([string]$Name) { $stageTimes[$Name] = [Math]::Round($stageClock.Elapsed.TotalSeconds,1); $stageClock.Restart() }


function Invoke-BuildScript([string]$Name, [string[]]$ScriptArguments = @()) {
    & $shell -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $Name) @ScriptArguments
    if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit $LASTEXITCODE)." }
}
function Invoke-BuildLock([string[]]$LockArguments) {
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell turns stderr into error records, including a normal
        # lock-conflict report. Preserve the exit code and inspect it explicitly.
        $ErrorActionPreference = 'Continue'
        $output = & $shell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $lockScript @LockArguments 2>&1 | Out-String
        return [pscustomobject]@{ Code = $LASTEXITCODE; Output = $output }
    } finally { $ErrorActionPreference = $previousPreference }
}

try {
    foreach ($tool in @('node', 'cmake', 'cargo', 'dotnet')) {
        if (!(Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing $tool. Install the build dependencies first." }
    }
    Write-Output '[1/6] Acquiring the repository build lock...'
    $waiting = $false
    do {
        $attempt = Invoke-BuildLock @('acquire', '-Global', '-Owner', $Owner, '-OwnerProcessId', [string]$PID, '-WaitSeconds', '60')
        if ($attempt.Code -eq 0) { $locked = $true; break }
        if ($attempt.Code -ne 2) { throw "Build lock failed: $($attempt.Output)" }
        $diagnostic = Invoke-BuildLock @('diagnose')
        if ($diagnostic.Code -ne 0) { throw "Build lock diagnostic failed: $($diagnostic.Output)" }
        if (!$waiting) { Write-Output 'Waiting for other repository work to release its locks...'; $waiting = $true }
        Start-Sleep -Seconds 2
    } while ($true)

    Complete-BuildStage 'Lock wait'
    Write-Output '[2/6] Closing running build outputs...'
    . (Join-Path $PSScriptRoot 'stop-project-processes.ps1')
    $targetRoot = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $projectRoot 'frontend\src-tauri\target' }
    $processDirectories = @(
        (Join-Path $projectRoot 'backend\build\Release'),
        (Join-Path $projectRoot 'backend\build\Debug'),
        (Join-Path $projectRoot 'frontend\src-tauri\binaries'),
        (Join-Path $projectRoot 'frontend\src-tauri\target\release'),
        (Join-Path $projectRoot 'frontend\src-tauri\target\debug'),
        (Join-Path $targetRoot 'release'), (Join-Path $targetRoot 'debug')
    ) | Select-Object -Unique
    $executables = foreach ($directory in $processDirectories) {
        foreach ($name in @('llmchat.exe', 'llmchat-backend.exe', 'llmchat-backend-x86_64-pc-windows-msvc.exe')) { Join-Path $directory $name }
    }
    if ($ForceClose) { Write-Warning 'ForceClose enabled: remaining processes from this checkout may be stopped after normal shutdown is attempted. Unsaved changes may be lost.' }
    Stop-ProjectProcesses -ExecutablePaths $executables -CloseTimeoutSeconds 60 -KillRemaining:$ForceClose

    Complete-BuildStage 'Close build outputs'
    Write-Output '[3-4/6] Preparing backend and tools in parallel...'
    $workers = @()
    try {
        foreach ($group in @(@('prepare-sidecar.ps1'), @('prepare-unity-tools.ps1','prepare-speech-tools.ps1','prepare-wolf-tools.ps1'))) {
            $workers += Start-Job -ArgumentList $shell,$PSScriptRoot,($group -join '|'),$Proxy -ScriptBlock {
                param($executor,$scripts,$names,$proxy)
                $ErrorActionPreference = 'Stop'
                . (Join-Path $scripts 'build-incremental.ps1')
                foreach ($name in $names.Split('|')) {
                    $clock = [Diagnostics.Stopwatch]::StartNew()
                    $arguments = if ($name -eq 'prepare-speech-tools.ps1' -and $proxy) { @('-Proxy',$proxy) } else { @() }
                    & $executor -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts $name) @arguments
                    if ($LASTEXITCODE -ne 0) { throw "$name failed (exit $LASTEXITCODE)." }
                    Write-Output ('{0}: {1:N1}s' -f $name,$clock.Elapsed.TotalSeconds)
                }
            }
        }
        $remaining = @($workers)
        while ($remaining.Count) {
            $finished = Wait-Job -Job $remaining -Any
            Receive-Job -Job $finished -ErrorAction Stop
            if ($finished.State -ne 'Completed') { throw "Preparation worker failed: $($finished.JobStateInfo.Reason)" }
            $remaining = @($remaining | Where-Object Id -ne $finished.Id)
        }
    } finally {
        # Keep the repository lock until native compiler children have finished.
        if ($workers.Count) { $workers | Wait-Job | Out-Null; $workers | Remove-Job -Force }
    }
    Complete-BuildStage 'Parallel backend and tools'
    Write-Output '[5/6] Building the desktop application...'
    $frontend = Join-Path $projectRoot 'frontend'
    $cli = Join-Path $frontend 'node_modules\@tauri-apps\cli\tauri.js'
    if (!(Test-Path -LiteralPath $cli)) {
        & npm.cmd --prefix $frontend ci
        if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    }
    Push-Location $frontend
    $previousRustStack = [Environment]::GetEnvironmentVariable('RUST_MIN_STACK', 'Process')
    $previousCargoJobs = [Environment]::GetEnvironmentVariable('CARGO_BUILD_JOBS', 'Process')
    try {
        # Defaults used successfully for this checkout's large embedded frontend.
        # Keep explicit caller settings and restore this shell's environment below.
        if ([string]::IsNullOrWhiteSpace($previousRustStack)) { $env:RUST_MIN_STACK = '33554432' }
        if ([string]::IsNullOrWhiteSpace($previousCargoJobs)) { $env:CARGO_BUILD_JOBS = [string](Get-BuildJobs) }
        Write-Output "Rust build settings: CARGO_BUILD_JOBS=$env:CARGO_BUILD_JOBS; RUST_MIN_STACK=$env:RUST_MIN_STACK bytes"
        # Tool preparation already succeeded in the workers. Direct Tauri builds
        # retain the full hook declared in tauri.conf.json.
        New-Item -ItemType Directory -Path $script:BuildCacheRoot -Force | Out-Null
        $hookConfig = Join-Path $script:BuildCacheRoot 'prepared-tauri.json'
        $override = @{ build = @{ beforeBuildCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File ../scripts/build-frontend.ps1' } } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($hookConfig,$override,[Text.UTF8Encoding]::new($false))
        & node $cli build --no-bundle --config $hookConfig
        if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed; portable files were not replaced.' }
    } finally {
        [Environment]::SetEnvironmentVariable('RUST_MIN_STACK', $previousRustStack, 'Process')
        [Environment]::SetEnvironmentVariable('CARGO_BUILD_JOBS', $previousCargoJobs, 'Process')
        Pop-Location
    }

    Complete-BuildStage 'Desktop build'
    Write-Output '[6/6] Updating and verifying the portable application...'
    if ($ForceClose) {
        $portableExecutables = @('llmchat.exe', 'llmchat-backend.exe', 'llmchat-backend-x86_64-pc-windows-msvc.exe') |
            ForEach-Object { Join-Path (Join-Path $projectRoot 'dist-portable') $_ }
        Stop-ProjectProcesses -ExecutablePaths $portableExecutables -CloseTimeoutSeconds 20 -KillRemaining
    }
    Invoke-BuildScript 'make-portable.ps1'
    $pairs = @(
        @((Join-Path $targetRoot 'release\llmchat.exe'), (Join-Path $projectRoot 'dist-portable\llmchat.exe')),
        @((Join-Path $projectRoot 'frontend\src-tauri\binaries\llmchat-backend-x86_64-pc-windows-msvc.exe'), (Join-Path $projectRoot 'dist-portable\llmchat-backend.exe'))
    )
    $updated = @(Get-Content -LiteralPath (Join-Path $script:BuildCacheRoot 'portable-updated-files.json') -Raw | ConvertFrom-Json)
    foreach ($pair in $pairs) {
        if ($updated -notcontains $pair[1]) { continue }
        if ((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $pair[1] -Algorithm SHA256).Hash) {
            throw "Copied program does not match its build: $($pair[1])"
        }
    }
    Complete-BuildStage 'Portable update and verification'
    Write-Output "Build complete: $(Join-Path $projectRoot 'dist-portable\llmchat.exe')"
} catch {
    [Console]::Error.WriteLine("Build failed: $($_.Exception.Message)")
    $buildResult = 1
} finally {
    foreach ($name in $stageTimes.Keys) { Write-Output ('{0}: {1:N1}s' -f $name,$stageTimes[$name]) }
    Write-Output ('Total build time: {0:N1}s' -f $buildClock.Elapsed.TotalSeconds)
    if ($locked) {
        $release = Invoke-BuildLock @('release', '-Global', '-Owner', $Owner)
        if ($release.Code -ne 0) { [Console]::Error.WriteLine($release.Output); $buildResult = 1 }
    }
}
if ($buildResult -eq 0 -and !$NoLaunch) {
    try {
        $portableDirectory = Join-Path $projectRoot 'dist-portable'
        Start-Process -FilePath (Join-Path $portableDirectory 'llmchat.exe') -WorkingDirectory $portableDirectory -WindowStyle Normal
        Write-Output 'Opened the updated portable application.'
    } catch {
        [Console]::Error.WriteLine("Build complete, but reopening failed: $($_.Exception.Message)")
        $buildResult = 1
    }
}
exit $buildResult
