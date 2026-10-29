[CmdletBinding()]
param(
    [string]$Owner = "manual-build-$PID",
    [string]$Proxy = ''
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = Split-Path -Parent $PSScriptRoot
$shell = (Get-Process -Id $PID).Path
$lockScript = Join-Path $PSScriptRoot 'file-lock.ps1'
$locked = $false
$buildResult = 0

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
        $attempt = Invoke-BuildLock @('acquire', '-Global', '-Owner', $Owner, '-WaitSeconds', '60')
        if ($attempt.Code -eq 0) { $locked = $true; break }
        if ($attempt.Code -ne 2) { throw "Build lock failed: $($attempt.Output)" }
        $diagnostic = Invoke-BuildLock @('diagnose')
        if ($diagnostic.Code -ne 0) { throw "Build lock diagnostic failed: $($diagnostic.Output)" }
        if (!$waiting) { Write-Output 'Waiting for other repository work to release its locks...'; $waiting = $true }
        Start-Sleep -Seconds 2
    } while ($true)

    Write-Output '[2/6] Closing this checkout and stopping remaining background processes...'
    Write-Warning 'Unsaved changes in this checkout may be lost if its window cannot close normally.'
    . (Join-Path $PSScriptRoot 'stop-project-processes.ps1')
    $targetRoot = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $projectRoot 'frontend\src-tauri\target' }
    $processDirectories = @(
        (Join-Path $projectRoot 'dist-portable'),
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
    Stop-ProjectProcesses -ExecutablePaths $executables -KillRemaining

    Write-Output '[3/6] Building the backend and preparing its sidecar...'
    Invoke-BuildScript 'prepare-sidecar.ps1'
    Write-Output '[4/6] Preparing speech decoding tools...'
    $speechArguments = if ($Proxy) { @('-Proxy', $Proxy) } else { @() }
    Invoke-BuildScript 'prepare-speech-tools.ps1' $speechArguments
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
        if ([string]::IsNullOrWhiteSpace($previousCargoJobs)) { $env:CARGO_BUILD_JOBS = '1' }
        Write-Output "Rust build settings: CARGO_BUILD_JOBS=$env:CARGO_BUILD_JOBS; RUST_MIN_STACK=$env:RUST_MIN_STACK bytes"
        & node $cli build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed; portable files were not replaced.' }
    } finally {
        [Environment]::SetEnvironmentVariable('RUST_MIN_STACK', $previousRustStack, 'Process')
        [Environment]::SetEnvironmentVariable('CARGO_BUILD_JOBS', $previousCargoJobs, 'Process')
        Pop-Location
    }

    Write-Output '[6/6] Updating and verifying the portable application...'
    Invoke-BuildScript 'make-portable.ps1'
    $pairs = @(
        @((Join-Path $targetRoot 'release\llmchat.exe'), (Join-Path $projectRoot 'dist-portable\llmchat.exe')),
        @((Join-Path $projectRoot 'frontend\src-tauri\binaries\llmchat-backend-x86_64-pc-windows-msvc.exe'), (Join-Path $projectRoot 'dist-portable\llmchat-backend.exe'))
    )
    foreach ($pair in $pairs) {
        if ((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $pair[1] -Algorithm SHA256).Hash) {
            throw "Copied program does not match its build: $($pair[1])"
        }
    }
    Write-Output "Build complete: $(Join-Path $projectRoot 'dist-portable\llmchat.exe')"
} catch {
    [Console]::Error.WriteLine("Build failed: $($_.Exception.Message)")
    $buildResult = 1
} finally {
    if ($locked) {
        $release = Invoke-BuildLock @('release', '-Global', '-Owner', $Owner)
        if ($release.Code -ne 0) { [Console]::Error.WriteLine($release.Output); $buildResult = 1 }
    }
}
exit $buildResult
