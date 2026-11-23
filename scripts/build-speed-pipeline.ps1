# Runs inside the same isolated checkout and global build lock as build-speed-test.ps1.
$checkout = Join-Path $work 'embedded'
$frontend = Join-Path $checkout 'frontend'
$desktop = Join-Path $frontend 'src-tauri'
$pipelineScripts = Join-Path $checkout 'scripts'
$portable = Join-Path $checkout 'dist-portable'
$sidecar = Join-Path $desktop 'binaries/llmchat-backend-x86_64-pc-windows-msvc.exe'
$target = Join-Path $desktop 'target'
$env:CARGO_TARGET_DIR = $target
$env:CARGO_BUILD_BUILD_DIR = $target
$utf8 = [Text.UTF8Encoding]::new($false)
$needsBackend = 'backend-only' -in $selected -or 'parallel' -in $selected

$null = [IO.Directory]::CreateDirectory($frontend)
foreach ($item in @('src','public','build','index.html','package.json','package-lock.json','tsconfig.json','vite.config.ts')) {
    Copy-Input (Join-Path $root "frontend/$item") $frontend
}
Get-ChildItem -LiteralPath (Join-Path $root 'frontend') -File -Force |
    Where-Object { $_.Name -like '.env*' -or $_.Name -like 'tsconfig.*.json' } |
    ForEach-Object { Copy-Input $_.FullName $frontend }
Copy-Input (Join-Path $root 'frontend/node_modules') $frontend
Copy-Input (Join-Path $root 'scripts') $checkout
if ($needsBackend) {
    $backend = Join-Path $checkout 'backend'
    $null = [IO.Directory]::CreateDirectory($backend)
    foreach ($item in @('CMakeLists.txt','src','third_party')) { Copy-Input (Join-Path $root "backend/$item") $backend }
    $assets = Join-Path $checkout 'assets'
    $null = [IO.Directory]::CreateDirectory($assets)
    Copy-Input (Join-Path $root 'assets/fonts') $assets
    Copy-Input (Join-Path $root 'config.ini.example') $checkout
}
. (Join-Path $pipelineScripts 'build-incremental.ps1')

function Get-PipelineArguments([string]$File) {
    @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $pipelineScripts $File))
}

function Measure-PipelineStep([string]$File, [string]$Name) {
    & $timedCommand $executor (Get-PipelineArguments $File) $checkout (Join-Path $checkout "$Name.log")
}

function Set-FrontendProbe([string]$Name) {
    $content = $htmlBaseline.Replace('</head>', ('<meta name="build-timing-probe" content="' + $Name + '"></head>'))
    if ($content -eq $htmlBaseline) { throw '无法写入前端测速标记。' }
    [IO.File]::WriteAllText($htmlPath, $content, $utf8)
}

function Set-BackendProbe([string]$Name) {
    $content = $cppBaseline.Replace('"llmchat-backend"', ('"llmchat-backend-' + $Name + '"'))
    if ($content -eq $cppBaseline) { throw '无法写入后端测速标记。' }
    [IO.File]::WriteAllText($cppPath, $content, $utf8)
}

function Assert-FrontendProbe([string]$Name) {
    if (![IO.File]::ReadAllText((Join-Path $frontend 'dist/index.html')).Contains($Name)) {
        throw '前端产物未包含本轮测速标记。'
    }
}

function Get-ProgramHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($hash.ComputeHash($stream)) }
    finally { $stream.Dispose(); $hash.Dispose() }
}

function Measure-Publish([string]$Name) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Measure-PipelineStep 'make-portable.ps1' "$Name-package" | Out-Null
    $updated = Get-Content -LiteralPath (Join-Path $checkout 'backend/build/incremental/portable-updated-files.json') -Raw | ConvertFrom-Json
    foreach ($item in @(
        @{ source=(Join-Path $target 'release/llmchat.exe'); file='llmchat.exe' },
        @{ source=$sidecar; file='llmchat-backend.exe' }
    )) {
        $destination = Join-Path $portable $item.file
        if ($updated -contains $destination -and (Get-ProgramHash $item.source) -ne (Get-ProgramHash $destination)) {
            throw "构建产物校验失败：$($item.file)"
        }
    }
    [Math]::Round($clock.Elapsed.TotalSeconds, 3)
}

function Measure-Preview([string]$Scenario, [string]$Name) {
    [Console]::WriteLine("PROGRESS frontend-preview $Scenario")
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $front = Measure-PipelineStep 'build-frontend.ps1' "preview-$Scenario"
    Assert-FrontendProbe $Name
    $destination = Join-Path $checkout "preview/versions/$Scenario"
    $null = [IO.Directory]::CreateDirectory($destination)
    Copy-BuildTree (Join-Path $frontend 'dist') $destination
    [IO.File]::WriteAllText((Join-Path $checkout 'preview/active-version'), $Scenario, $utf8)
    $records.Add([pscustomobject]@{ test='frontend-preview'; scenario=$Scenario; seconds=[Math]::Round($clock.Elapsed.TotalSeconds, 3); front=$front })
}

$htmlPath = Join-Path $frontend 'index.html'
$htmlBaseline = [IO.File]::ReadAllText($htmlPath)
[Console]::WriteLine('PROGRESS pipeline-warmup')
Measure-PipelineStep 'build-frontend.ps1' 'pipeline-warmup-frontend' | Out-Null
if ($needsBackend) {
    $cppPath = Join-Path $backend 'src/http/SystemRoutes.cpp'
    $cppBaseline = [IO.File]::ReadAllText($cppPath)
    Measure-PipelineStep 'prepare-sidecar.ps1' 'pipeline-warmup-backend' | Out-Null
    Measure-Release 'embedded' 'pipeline-warmup' | Out-Null
    Measure-Publish 'pipeline-warmup' | Out-Null
}
if ('backend-only' -in $selected) {
    [Console]::WriteLine('PROGRESS backend-only')
    $fastOutput = Join-Path $checkout 'backend-only-portable'
    $null = [IO.Directory]::CreateDirectory($fastOutput)
    foreach ($file in @('llmchat-backend.exe','llmchat-backend-x86_64-pc-windows-msvc.exe')) {
        Copy-BuildFile (Join-Path $portable $file) $fastOutput
    }
    Set-BackendProbe 'backend-only'
    $backendTime = Measure-PipelineStep 'prepare-sidecar.ps1' 'backend-only'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Copy-BuildFile $sidecar $fastOutput
    $primary = Join-Path $fastOutput 'llmchat-backend.exe'
    Copy-BuildFile $sidecar $primary
    if ((Get-ProgramHash $sidecar) -ne (Get-ProgramHash $primary)) { throw '仅后端更新校验失败。' }
    $publish = [Math]::Round($clock.Elapsed.TotalSeconds, 3)
    $records.Add([pscustomobject]@{ test='backend-only'; scenario='sidecar'; seconds=$backendTime + $publish; backend=$backendTime; package=$publish })

    $front = Measure-PipelineStep 'build-frontend.ps1' 'backend-only-standard-frontend'
    $desktopBuild = Measure-Release 'embedded' 'backend-only-standard'
    $publish = Measure-Publish 'backend-only-standard'
    $records.Add([pscustomobject]@{ test='backend-only'; scenario='standard'; seconds=$backendTime + $front + $desktopBuild.seconds + $publish; backend=$backendTime; front=$front; cargo=$desktopBuild.seconds; package=$publish })
}
if ('parallel' -in $selected) {
    foreach ($name in @('serial-1','parallel-1','parallel-2','serial-2')) {
        $scenario, $round = $name.Split('-')
        [Console]::WriteLine("PROGRESS $name")
        Set-BackendProbe $name
        Set-FrontendProbe $name
        $clock = [Diagnostics.Stopwatch]::StartNew()
        if ($scenario -eq 'parallel') {
            $jobs = @()
            try {
                foreach ($step in @('backend','frontend')) {
                    $file = if ($step -eq 'backend') { 'prepare-sidecar.ps1' } else { 'build-frontend.ps1' }
                    $scriptPath = Join-Path $pipelineScripts $file
                    $logPath = Join-Path $checkout "$name-$step.log"
                    $jobs += Start-Job -ArgumentList @($timedCommand.ToString(),$executor,$scriptPath,$checkout,$logPath) -ScriptBlock {
                        param($run,$executor,$scriptPath,$checkout,$logPath)
                        & ([scriptblock]::Create($run)) $executor @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$scriptPath) $checkout $logPath
                    }
                }
                $jobs | Wait-Job | Out-Null
                $backendTime = [double](Receive-Job -Job $jobs[0] -ErrorAction Stop)
                $front = [double](Receive-Job -Job $jobs[1] -ErrorAction Stop)
                if ($jobs.Where({ $_.State -ne 'Completed' })) { throw '并行构建准备失败。' }
            } finally {
                if ($jobs.Count) { $jobs | Wait-Job | Out-Null; $jobs | Remove-Job }
            }
        } else {
            $backendTime = Measure-PipelineStep 'prepare-sidecar.ps1' "$name-backend"
            $front = Measure-PipelineStep 'build-frontend.ps1' "$name-frontend"
        }
        $preparation = [Math]::Round($clock.Elapsed.TotalSeconds, 3)
        Assert-FrontendProbe $name
        $desktopBuild = Measure-Release 'embedded' $scenario ([int]$round)
        $publish = Measure-Publish $name
        $records.Add([pscustomobject]@{ test='parallel'; scenario=$scenario; round=[int]$round; seconds=[Math]::Round($clock.Elapsed.TotalSeconds,3); preparation=$preparation; backend=$backendTime; front=$front; cargo=$desktopBuild.seconds; package=$publish })
    }
}
if ('frontend-preview' -in $selected) {
    Set-FrontendProbe 'preview-change'
    Measure-Preview 'changed' 'preview-change'
    Measure-Preview 'cached' 'preview-change'
}
