function Assert-IntegrationPreviewShell([string]$ShellProgram) {
    if (!(Test-Path -LiteralPath $ShellProgram -PathType Leaf)) {
        throw 'Build the portable desktop once before using -IntegrationPreview.'
    }
    if (![Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($ShellProgram)).Contains('LLMCHAT_FRONTEND_PREVIEW')) {
        throw 'The portable desktop is too old for previews. Run build.cmd -Full first.'
    }
}

function Stop-IntegrationPreview([string]$AppDirectory) {
    . (Join-Path $PSScriptRoot 'stop-project-processes.ps1')
    $paths = @('llmchat.exe','llmchat-backend.exe','llmchat-backend-x86_64-pc-windows-msvc.exe') |
        ForEach-Object { Join-Path $AppDirectory $_ }
    Stop-ProjectProcesses -ExecutablePaths $paths -CloseTimeoutSeconds 20 -KillRemaining:$ForceClose
}

function Initialize-IntegrationPreviewData([string]$AppDirectory, [int]$Port) {
    $config = Join-Path $AppDirectory 'config.ini'
    if (!(Test-Path -LiteralPath $config)) {
        [IO.File]::WriteAllLines($config, @('[General]', "port=$Port"))
    } else {
        $ports = @(Select-String -LiteralPath $config -Pattern '^\s*port\s*=(.*)$')
        if ($ports.Count -ne 1 -or $ports[0].Matches[0].Groups[1].Value.Trim() -ne [string]$Port) {
            throw "Preview config.ini must set port=$Port in $AppDirectory"
        }
    }

    $manifest = Join-Path $AppDirectory 'storage-paths.json'
    $paths = @{
        data = $AppDirectory
        projects = Join-Path $AppDirectory 'text-projects'
        ocr = Join-Path $AppDirectory 'ocr-models'
        unity = Join-Path $AppDirectory 'resources'
        temp = Join-Path $AppDirectory 'temp'
        webview = Join-Path $AppDirectory 'webview'
    }
    if (!(Test-Path -LiteralPath $manifest)) {
        $json = ConvertTo-Json -InputObject @{ active = $paths }
        [IO.File]::WriteAllText($manifest, $json, [Text.UTF8Encoding]::new($false))
        return
    }
    $saved = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $prefix = $AppDirectory.TrimEnd('\') + '\'
    foreach ($state in @('active','pending')) {
        if ($state -eq 'pending' -and !$saved.pending) { continue }
        foreach ($key in $paths.Keys) {
            $value = [string]$saved.$state.$key
            if (![IO.Path]::IsPathRooted($value)) { throw "Preview storage is missing a local $key directory." }
            $absolute = [IO.Path]::GetFullPath($value)
            if ($absolute -ne $AppDirectory -and !$absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Preview storage must stay inside $AppDirectory"
            }
        }
    }
}

function Publish-IntegrationPreview([string]$PreviewRoot, [string]$AppDirectory, [string]$ShellProgram, [int]$Port) {
    $compiled = Join-Path $PreviewRoot 'versions'
    if (!(Test-Path -LiteralPath (Join-Path $compiled 'dist/index.html') -PathType Leaf)) {
        throw 'Missing integration preview frontend.'
    }
    $null = New-Item -ItemType Directory -Path $AppDirectory -Force
    Initialize-IntegrationPreviewData $AppDirectory $Port
    Copy-BuildFile $ShellProgram (Join-Path $AppDirectory 'llmchat.exe')
    $backend = Join-Path $projectRoot 'frontend/src-tauri/binaries/llmchat-backend-x86_64-pc-windows-msvc.exe'
    Copy-BuildFile $backend (Join-Path $AppDirectory 'llmchat-backend.exe')
    Copy-BuildTree (Join-Path $compiled 'resources/web-assets') (Join-Path $AppDirectory 'resources/web-assets')
    $portable = Split-Path -Parent $ShellProgram
    foreach ($resource in @('resources/ffmpeg','resources/unity','resources/wolf','fonts')) {
        $source = Join-Path $portable $resource
        if (Test-Path -LiteralPath $source -PathType Container) {
            Copy-BuildTree $source (Join-Path $AppDirectory $resource)
        }
    }
    [IO.File]::WriteAllText((Join-Path $PreviewRoot 'active-version'), 'dist')
}

function Start-IntegrationPreview([string]$PreviewRoot, [string]$AppDirectory, [int]$Port) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() }
    catch { throw "Preview port $Port is already in use. Choose another port with -PreviewPort." }
    finally { $listener.Stop() }

    $previous = [Environment]::GetEnvironmentVariable('LLMCHAT_FRONTEND_PREVIEW', 'Process')
    try {
        $env:LLMCHAT_FRONTEND_PREVIEW = $PreviewRoot
        Start-Process -FilePath (Join-Path $AppDirectory 'llmchat.exe') -WorkingDirectory $AppDirectory -WindowStyle Normal
    } finally { [Environment]::SetEnvironmentVariable('LLMCHAT_FRONTEND_PREVIEW', $previous, 'Process') }
}
