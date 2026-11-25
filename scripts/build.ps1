[CmdletBinding()]
param(
    [string]$Owner = "manual-build-$PID",
    [string]$Proxy = '',
    [switch]$NoLaunch,
    [switch]$Distribution,
    [switch]$ForceClose,
    [string]$FrontendPreviewDirectory,
    [switch]$Full,
    [switch]$IntegrationPreview,
    [ValidateRange(1024,65535)][int]$PreviewPort = 17801
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
$logDirectory = Join-Path $script:BuildCacheRoot 'logs'
$logPath = Join-Path $logDirectory ('build-{0:yyyyMMdd-HHmmss-fff}-{1}.log' -f (Get-Date), $PID)
function Write-BuildLog([string]$Message) {
    Write-Host $Message
    [IO.File]::AppendAllText($logPath, $Message + [Environment]::NewLine)
}
function Write-ToolOutput {
    process {
        $line = [string]$_
        if ($line -match '^(Frontend |.*unchanged; reusing |prepare-[^:]+\.ps1: |.*Timing report saved to )') {
            Write-BuildLog $line
        } else {
            Write-Output $_
        }
    }
}
function Complete-BuildStage([string]$Name) { $stageTimes[$Name] = [Math]::Round($stageClock.Elapsed.TotalSeconds,1); $stageClock.Restart() }


function Invoke-BuildScript([string]$Name, [string[]]$ScriptArguments = @()) {
    & $shell -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $Name) @ScriptArguments | Write-ToolOutput
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

function Get-PortableDesktopCacheArguments([string]$TargetRoot) {
    $frontend = Join-Path $projectRoot 'frontend'
    $desktop = Join-Path $frontend 'src-tauri'
    $portable = Join-Path $projectRoot 'dist-portable'
    # Watch the desktop inputs and the shipped files. The sidecar can change
    # independently, and portable settings and caches belong to the user.
    $inputs = @(
        'scripts', 'tools/UnityOffline', 'tools/UnityOffline/obj/project.assets.json', 'tools/FontSymbols',
        'assets', 'config.ini.example', 'build.cmd', '.cargo',
        'frontend/src', 'frontend/public', 'frontend/build', 'frontend/dist', 'frontend/.cargo',
        'frontend/node_modules/.package-lock.json',
        'frontend/src-tauri/src', 'frontend/src-tauri/capabilities', 'frontend/src-tauri/permissions',
        'frontend/src-tauri/icons', 'frontend/src-tauri/resources', 'frontend/src-tauri/.cargo'
    ) | ForEach-Object { Join-Path $projectRoot $_ }
    $inputs += @(Get-ChildItem -LiteralPath $frontend,$desktop -File -Force |
        Where-Object Extension -ne '.tsbuildinfo' | Select-Object -ExpandProperty FullName)

    $outputs = @(Join-Path $portable 'llmchat.exe')
    $outputs += @('build.cmd','resources/web-assets','resources/ffmpeg','resources/unity',
        'resources/wolf','fonts/NotoSansCJKsc-Regular.otf','fonts/OFL.txt','fonts/SOURCE.txt') |
        ForEach-Object { Join-Path $portable $_ } |
        Where-Object { Test-Path -LiteralPath $_ }

    $environment = @(Get-ChildItem Env: | Where-Object {
        $_.Name -like 'VITE_*' -or $_.Name -like 'TAURI_*' -or
        $_.Name -in @('NODE_ENV','NODE_OPTIONS','RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','CARGO_BUILD_TARGET',
            'CARGO_HOME','RUSTUP_TOOLCHAIN','RUSTC','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','LLMCHAT_MODEL_PYTHON')
    } | Sort-Object Name | ForEach-Object { $_.Name + '=' + $_.Value }) -join [Environment]::NewLine
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $identity = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($TargetRoot + [Environment]::NewLine + $environment))) }
    finally { $hash.Dispose() }
    @{
        Name = 'portable-desktop'
        Inputs = @($inputs)
        Outputs = @($outputs)
        Identity = $identity
    }
}

function Assert-BuildTools([string[]]$Tools) {
    foreach ($tool in $Tools) {
        if (!(Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing $tool. Install the build dependencies first." }
    }
}

function Initialize-FrontendDependencies {
    $frontend = Join-Path $projectRoot 'frontend'
    if (!(Test-Path -LiteralPath (Join-Path $frontend 'node_modules/@tauri-apps/cli/tauri.js'))) {
        & npm.cmd --prefix $frontend ci
        if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    }
}

function Invoke-ParallelPreparation([string[]]$Groups, [string]$PreviewOutput, [string]$PreviewApi) {
    $workers = @()
    try {
        foreach ($group in $Groups) {
            $workers += Start-Job -ArgumentList $shell,$PSScriptRoot,$group,$Proxy,$PreviewOutput,$PreviewApi -ScriptBlock {
                param($executor,$scripts,$names,$proxy,$previewOutput,$previewApi)
                $ErrorActionPreference = 'Stop'
                $PSNativeCommandUseErrorActionPreference = $false
                . (Join-Path $scripts 'build-incremental.ps1')
                foreach ($name in $names.Split('|')) {
                    $clock = [Diagnostics.Stopwatch]::StartNew()
                    $arguments = if ($name -eq 'build-frontend.ps1' -and $previewOutput) {
                        @('-OutputRoot',$previewOutput,'-ApiBase',$previewApi)
                    } elseif ($name -eq 'prepare-speech-tools.ps1' -and $proxy) { @('-Proxy',$proxy) }
                    else { @() }
                    # Native tools can report progress and warnings on stderr.
                    $global:LASTEXITCODE = -1
                    try {
                        $ErrorActionPreference = 'Continue'
                        & $executor -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scripts $name) @arguments 2>&1 | ForEach-Object { [string]$_ }
                    } finally { $ErrorActionPreference = 'Stop' }
                    if ($LASTEXITCODE -ne 0) { throw "$name failed (exit $LASTEXITCODE)." }
                    Write-Output ('{0}: {1:N1}s' -f $name,$clock.Elapsed.TotalSeconds)
                }
            }
        }
        $remaining = @($workers)
        while ($remaining.Count) {
            $finished = Wait-Job -Job $remaining -Any
            Receive-Job -Job $finished -ErrorAction Stop | Write-ToolOutput
            if ($finished.State -ne 'Completed') { throw "Preparation worker failed: $($finished.JobStateInfo.Reason)" }
            $remaining = @($remaining | Where-Object Id -ne $finished.Id)
        }
    } finally {
        # Keep the repository lock until native compiler children have finished.
        if ($workers.Count) { $workers | Wait-Job | Out-Null; $workers | Remove-Job -Force }
    }
}

try {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    Write-BuildLog ('Build started {0:O}' -f (Get-Date))
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
    if ($Distribution -and ($IntegrationPreview -or $FrontendPreviewDirectory)) { throw 'Distribution mode cannot be combined with a frontend or integration preview.' }
    if ($IntegrationPreview) {
        if ($FrontendPreviewDirectory -or $Full -or $PreviewPort -eq 17800) {
            throw 'Use -IntegrationPreview by itself and select a port other than the standard 17800.'
        }
        Assert-BuildTools @('node','cmake')
        . (Join-Path $PSScriptRoot 'build-integration-preview.ps1')
        $previewRoot = Join-Path $projectRoot "backend/build/integration-preview/$PreviewPort"
        $previewApp = Join-Path $previewRoot 'app'
        $previewShell = Join-Path $projectRoot 'dist-portable/llmchat.exe'
        Assert-IntegrationPreviewShell $previewShell
        Stop-IntegrationPreview $previewApp
        Complete-BuildStage 'Prepare integration preview'
        Initialize-FrontendDependencies
        Invoke-ParallelPreparation @('prepare-sidecar.ps1','build-frontend.ps1') (Join-Path $previewRoot 'versions') "http://127.0.0.1:$PreviewPort"
        Complete-BuildStage 'Parallel frontend and backend'
        Publish-IntegrationPreview $previewRoot $previewApp $previewShell $PreviewPort
        Complete-BuildStage 'Publish integration preview'
        if (!$NoLaunch) { Start-IntegrationPreview $previewRoot $previewApp $PreviewPort }
        Write-BuildLog "Integration preview ready: $previewApp (http://127.0.0.1:$PreviewPort)"
        return
    }
    if ($FrontendPreviewDirectory) {
        Assert-BuildTools @('node','npm.cmd')
        $previewRoot = [IO.Path]::GetFullPath($FrontendPreviewDirectory)
        Invoke-BuildScript 'build-frontend.ps1'
        Complete-BuildStage 'Frontend build'
        $version = [guid]::NewGuid().ToString('N')
        $versionDir = Join-Path $previewRoot ("versions\" + $version)
        $dist = Join-Path $projectRoot 'frontend\dist'
        if (!(Test-Path -LiteralPath (Join-Path $dist 'index.html') -PathType Leaf)) { throw 'Missing compiled frontend entry.' }
        New-Item -ItemType Directory -Path $versionDir -Force | Out-Null
        Copy-BuildTree $dist $versionDir
        $pointer = Join-Path $previewRoot 'active-version'
        $pending = Join-Path $previewRoot ("active-" + $version + ".tmp")
        [IO.File]::WriteAllText($pending, $version)
        if ([IO.File]::Exists($pointer)) {
            [IO.File]::Replace($pending, $pointer, (Join-Path $previewRoot 'previous-version'))
        } else { [IO.File]::Move($pending, $pointer) }
        Complete-BuildStage 'Publish frontend preview'
        Write-BuildLog "Frontend preview ready: $previewRoot ($version)"
        return
    }
    $targetRoot = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $projectRoot 'frontend/src-tauri/target' }
    $desktopCache = Get-PortableDesktopCacheArguments $targetRoot
    $backendOnly = !$Distribution -and !$Full -and (Test-BuildCache @desktopCache)
    if ($backendOnly) {
        Assert-BuildTools @('cmake')
        Write-BuildLog 'Build mode: backend only'
    } else {
        Assert-BuildTools @('node','cmake','cargo','dotnet')
        Write-BuildLog 'Build mode: full desktop'
        $publishedDesktop = Join-Path $script:BuildCacheRoot 'portable-desktop.json'
        if (Test-Path -LiteralPath $publishedDesktop) { Remove-Item -LiteralPath $publishedDesktop }
    }
    Complete-BuildStage 'Select build mode'

    Write-Output '[2/6] Closing running build outputs...'
    . (Join-Path $PSScriptRoot 'stop-project-processes.ps1')
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
    if ($backendOnly) {
        Invoke-BuildScript 'prepare-sidecar.ps1'
        Complete-BuildStage 'Backend build'
    } else {
        Write-Output '[3-4/6] Preparing backend and tools in parallel...'
        Initialize-FrontendDependencies
        Invoke-ParallelPreparation @(
            'prepare-sidecar.ps1',
            'prepare-unity-tools.ps1|build-frontend.ps1|prepare-speech-tools.ps1|prepare-wolf-tools.ps1'
        )
        Complete-BuildStage 'Parallel frontend, backend and tools'
        Write-Output '[5/6] Building the desktop application...'
        $frontend = Join-Path $projectRoot 'frontend'
        $cli = Join-Path $frontend 'node_modules\@tauri-apps\cli\tauri.js'
        Push-Location $frontend
        $previousRustStack = [Environment]::GetEnvironmentVariable('RUST_MIN_STACK', 'Process')
        $previousCargoJobs = [Environment]::GetEnvironmentVariable('CARGO_BUILD_JOBS', 'Process')
        try {
            # Defaults used successfully for this checkout's large embedded frontend.
            # Keep explicit caller settings and restore this shell's environment below.
            if ([string]::IsNullOrWhiteSpace($previousRustStack)) { $env:RUST_MIN_STACK = '33554432' }
            if ([string]::IsNullOrWhiteSpace($previousCargoJobs)) { $env:CARGO_BUILD_JOBS = [string](Get-BuildJobs) }
            Write-Output "Rust build settings: CARGO_BUILD_JOBS=$env:CARGO_BUILD_JOBS; RUST_MIN_STACK=$env:RUST_MIN_STACK bytes"
            # The parallel workers already produced frontend/dist and the tools.
            # The direct Tauri entry point keeps its configured hook.
            New-Item -ItemType Directory -Path $script:BuildCacheRoot -Force | Out-Null
            $hookConfig = Join-Path $script:BuildCacheRoot 'prepared-tauri.json'
            $override = @{ build = @{ beforeBuildCommand = '' } } | ConvertTo-Json -Compress
            [IO.File]::WriteAllText($hookConfig,$override,[Text.UTF8Encoding]::new($false))
            & node $cli build --no-bundle --config $hookConfig -- --timings | Write-ToolOutput
            if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed; portable files were not replaced.' }
        } finally {
            [Environment]::SetEnvironmentVariable('RUST_MIN_STACK', $previousRustStack, 'Process')
            [Environment]::SetEnvironmentVariable('CARGO_BUILD_JOBS', $previousCargoJobs, 'Process')
            Pop-Location
        }

        Complete-BuildStage 'Desktop build'
        $cargoTiming = Join-Path $targetRoot 'cargo-timings\cargo-timing.html'
        if (Test-Path -LiteralPath $cargoTiming) {
            $savedTiming = [IO.Path]::ChangeExtension($logPath, '.cargo.html')
            Copy-Item -LiteralPath $cargoTiming -Destination $savedTiming
            Write-BuildLog "Cargo compile timings: $savedTiming"
        }
    }

    Write-Output '[6/6] Updating and verifying the portable application...'
    if ($ForceClose) {
        $portableExecutables = @('llmchat.exe', 'llmchat-backend.exe', 'llmchat-backend-x86_64-pc-windows-msvc.exe') |
            ForEach-Object { Join-Path (Join-Path $projectRoot 'dist-portable') $_ }
        Stop-ProjectProcesses -ExecutablePaths $portableExecutables -CloseTimeoutSeconds 20 -KillRemaining
    }
    if ($backendOnly) {
        Invoke-BuildScript 'make-portable.ps1' @('-BackendOnly')
    } else {
        $portableArguments = if ($Distribution) { @('-Distribution') } else { @() }
        Invoke-BuildScript 'make-portable.ps1' $portableArguments
    }
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
    if (!$backendOnly) {
        $desktopCache = Get-PortableDesktopCacheArguments $targetRoot
        Save-BuildCache @desktopCache
    }
    Complete-BuildStage 'Portable update and verification'
    Write-Output "Build complete: $(Join-Path $projectRoot 'dist-portable\llmchat.exe')"
} catch {
    [Console]::Error.WriteLine("Build failed: $($_.Exception.Message)")
    $buildResult = 1
} finally {
    if ($locked) {
        $release = Invoke-BuildLock @('release', '-Global', '-Owner', $Owner)
        if ($release.Code -ne 0) { [Console]::Error.WriteLine($release.Output); $buildResult = 1 }
    }
    if (Test-Path -LiteralPath $logPath) {
        foreach ($name in $stageTimes.Keys) { Write-BuildLog ('{0}: {1:N1}s' -f $name,$stageTimes[$name]) }
        Write-BuildLog ('Total build time: {0:N1}s' -f $buildClock.Elapsed.TotalSeconds)
        Write-BuildLog "Build result: $buildResult"
        Write-Output "Build log: $logPath"
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
