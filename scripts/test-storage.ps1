param([string]$Backend = (Join-Path $PSScriptRoot '..\backend\build\Release\llmchat-backend.exe'))
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('llmchat-storage-test-' + [guid]::NewGuid().ToString('N'))
$program = Join-Path $testRoot 'program'
$null = New-Item -ItemType Directory -Path $program -Force
$testExe = Join-Path $program 'llmchat-backend.exe'
Copy-Item -LiteralPath $Backend -Destination $testExe
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$endpoint = "http://127.0.0.1:$port"
$utf8 = [Text.UTF8Encoding]::new($false)
$child = $null
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
function Write-Fixture([string]$path, [string]$text) {
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force
    [IO.File]::WriteAllText($path, $text, $utf8)
}
function Call-Api([string]$path, [string]$method = 'GET', $body = $null) {
    $args = @{ Uri = "$endpoint$path"; Method = $method; TimeoutSec = 30 }
    if ($null -ne $body) { $args.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 20)); $args.ContentType = 'application/json' }
    Invoke-RestMethod @args
}
function Start-TestBackend {
    $script:child = Start-Process -FilePath $testExe -ArgumentList '--serve' -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $testRoot 'stdout.log') -RedirectStandardError (Join-Path $testRoot 'stderr.log')
    for ($i = 0; $i -lt 80; $i++) {
        if ($script:child.HasExited) { throw "Backend exited: $(Get-Content (Join-Path $testRoot 'stderr.log') -Raw)" }
        try { if ((Call-Api '/api/health').ok) { return } } catch { Start-Sleep -Milliseconds 100 }
    }
    throw 'Backend did not start'
}
function Stop-TestBackend {
    if ($script:child -and -not $script:child.HasExited) {
        # Only this test's isolated child, never a running portable app.
        Stop-Process -Id $script:child.Id
        $script:child.WaitForExit()
    }
    $script:child = $null
}
try {
    $paths = @{ data = $program }
    foreach ($id in @('projects','ocr','unity','temp','webview')) { $paths[$id] = Join-Path $testRoot "old-$id" }
    Write-Fixture (Join-Path $program 'storage-paths.json') (@{ active = $paths } | ConvertTo-Json)
    Write-Fixture (Join-Path $program 'config.ini') "[General]`nport=$port`nmodel=fixture-model`n"
    Write-Fixture (Join-Path $program 'unity-output.log') 'log-to-clear'
    Write-Fixture (Join-Path $program 'usage-events.jsonl') '{"id":"fixture-usage","date":"2026-10-21","ts":"2026-10-21T12:00:00Z","time":"20:00:00","ok":true,"feature":"chat","channel":"llm","model":"fixture-model","promptTokens":3,"completionTokens":2,"totalTokens":5}'
    Write-Fixture (Join-Path $paths.projects 'managed\project.lcproj') '{"name":"fixture"}'
    Write-Fixture (Join-Path $paths.projects 'managed\source.txt') 'project-source'
    Write-Fixture (Join-Path $paths.projects 'unrelated.txt') 'keep-user-file'
    Write-Fixture (Join-Path $paths.ocr 'model-fixture.bin') 'model-content'
    Write-Fixture (Join-Path $paths.unity 'fonts\fixture.otf') 'font-content'
    Write-Fixture (Join-Path $paths.temp 'fixture.tmp') 'temp-content'
    Write-Fixture (Join-Path $paths.webview 'EBWebView\Default\Cache\fixture') 'web-cache'
    Write-Fixture (Join-Path $paths.webview 'EBWebView\Default\Service Worker\CacheStorage\fixture') 'browser-model-cache'
    Write-Fixture (Join-Path $paths.webview 'EBWebView\Default\Local Storage\fixture') 'keep-credentials'

    & $testExe --prepare-storage $paths.webview
    Assert ($LASTEXITCODE -eq 0) 'Prepare failed'
    Start-TestBackend
    $info = Call-Api '/api/storage'
    Assert ($info.entries.Count -eq 6) 'Expected six storage categories'
    Assert ($info.cleanupOptions.Count -eq 8) 'Expected eight cleanup categories'
    $chat = Call-Api '/api/conversations' 'POST'
    Assert ([bool]$chat.id) 'Could not create fixture chat'
    Call-Api "/api/conversations/$($chat.id)/messages" 'POST' @{ role = 'user'; content = 'migration-preserved-message' } | Out-Null
    $rejected = $false
    try { Call-Api '/api/storage/cleanup' 'PUT' @{ ids = @('arbitrary-path') } | Out-Null } catch { $rejected = $true }
    Assert $rejected 'Unknown cleanup category was accepted'
    $badPaths = $paths.Clone(); $badPaths.ocr = [IO.Path]::GetPathRoot($program)
    $rejected = $false
    try { Call-Api '/api/storage/paths' 'PUT' @{ paths = $badPaths } | Out-Null } catch { $rejected = $true }
    Assert $rejected 'Disk root was accepted'
    $occupied = Join-Path $testRoot 'occupied'
    Write-Fixture (Join-Path $occupied 'user.txt') 'keep'
    $badPaths = $paths.Clone(); $badPaths.ocr = $occupied
    $rejected = $false
    try { Call-Api '/api/storage/paths' 'PUT' @{ paths = $badPaths } | Out-Null } catch { $rejected = $true }
    Assert $rejected 'Non-empty destination was accepted'
    $badPaths = $paths.Clone(); $badPaths.ocr = Join-Path $paths.ocr 'nested'
    $rejected = $false
    try { Call-Api '/api/storage/paths' 'PUT' @{ paths = $badPaths } | Out-Null } catch { $rejected = $true }
    Assert $rejected 'Nested destination was accepted'
    $rejected = $false
    try { Invoke-RestMethod "$endpoint/api/storage/cleanup" -Method PUT -ContentType 'application/json' -Body '{"ids":["chats"]}' -Headers @{ Origin = 'https://example.invalid' } | Out-Null } catch { $rejected = $true }
    Assert $rejected 'Foreign browser origin was accepted'

    $next = @{}
    foreach ($id in $paths.Keys) { $next[$id] = Join-Path $testRoot "迁移目录\$id" }
    $saved = Call-Api '/api/storage/paths' 'PUT' @{ paths = $next }
    Assert ($null -ne $saved.pending) 'Migration was not queued'
    Assert (-not (Test-Path $next.data)) 'Migration ran before restart'
    Call-Api '/api/storage/cleanup' 'PUT' @{ ids = @('logs','webcache','projects') } | Out-Null
    Assert (Test-Path (Join-Path $program 'unity-output.log')) 'Cleanup ran before restart'
    Stop-TestBackend
    & $testExe --prepare-storage $paths.webview
    Assert ($LASTEXITCODE -eq 0) 'Prepare/migrate failed'
    Start-TestBackend
    $info = Call-Api '/api/storage'
    Assert (-not $info.error) "Migration error: $($info.error)"
    Assert ($null -eq $info.pending) 'Pending migration was not committed'
    Assert ($info.cleanup.Count -eq 0) 'Cleanup was not completed'
    Assert ((Call-Api '/api/conversations').items.id -contains $chat.id) 'Chat was lost in migration'
    Assert ((Call-Api '/api/settings').model -eq 'fixture-model') 'Settings were lost in migration'
    Assert ((Call-Api '/api/usage/events?from=2026-10-21&to=2026-10-21').items.id -contains 'fixture-usage') 'Usage was lost in Unicode migration'
    Assert ((Call-Api '/api/settings').textProjectsDirResolved -eq $next.projects) 'Project routing did not change'
    Assert ((Call-Api '/api/text-projects').root -eq $next.projects) 'Project list cannot read Unicode path'
    $newProject = Call-Api '/api/text-projects/save' 'POST' @{ project = @{ name = '中文工程'; folder = '中文工程' } }
    Assert (Test-Path -LiteralPath $newProject.path) 'Could not save project in Unicode path'
    $loadedProject = Call-Api ('/api/text-projects/load?path=' + [Uri]::EscapeDataString($newProject.path))
    Assert ($loadedProject.project.name -eq '中文工程') 'Could not reopen project from Unicode path'
    $exported = Call-Api '/api/text-projects/write-file' 'POST' @{ folder = '中文工程'; fileName = '译文.txt'; content = 'translation' }
    Assert (Test-Path -LiteralPath (Join-Path $next.projects '中文工程\译文.txt')) 'Could not export file into migrated Unicode project'
    Assert ((Call-Api '/api/ocr/models').cacheDir -eq $next.ocr) 'OCR routing did not change'
    Assert (Test-Path (Join-Path $next.data 'conversations.sqlite3')) 'SQLite database not migrated'
    Assert (-not (Test-Path (Join-Path $next.data 'llmchat-backend.exe'))) 'Program binary was migrated as data'
    Assert (Test-Path (Join-Path $next.ocr 'model-fixture.bin')) 'OCR model not migrated'
    Assert (Test-Path (Join-Path $next.unity 'fonts\fixture.otf')) 'Unity cache not migrated'
    Assert (Test-Path (Join-Path $next.temp 'fixture.tmp')) 'Temp path not migrated'
    Assert (-not (Test-Path (Join-Path $next.data 'unity-output.log'))) 'Log was not cleaned'
    Assert (-not (Test-Path (Join-Path $next.webview 'EBWebView\Default\Cache\fixture'))) 'Web cache not cleaned'
    Assert (-not (Test-Path (Join-Path $next.webview 'EBWebView\Default\Service Worker\CacheStorage\fixture'))) 'Browser model cache not cleaned'
    Assert (Test-Path (Join-Path $next.webview 'EBWebView\Default\Local Storage\fixture')) 'WebView credentials were deleted'
    Assert (-not (Test-Path (Join-Path $next.projects 'managed'))) 'Managed project not cleaned'
    Assert (Test-Path (Join-Path $next.projects 'unrelated.txt')) 'Unrelated project-root file was deleted'
    Assert (Test-Path (Join-Path $program 'unity-output.log')) 'Original migration backup was not kept'

    # A destination changed by another program between save and restart must
    # leave the active data and queued deletion untouched.
    $blockedPaths = $next.Clone(); $blockedPaths.data = Join-Path $testRoot 'blocked-data'
    Call-Api '/api/storage/paths' 'PUT' @{ paths = $blockedPaths } | Out-Null
    Call-Api '/api/storage/cleanup' 'PUT' @{ ids = @('chats') } | Out-Null
    Write-Fixture (Join-Path $blockedPaths.data 'external-file.txt') 'must-not-overwrite'
    Stop-TestBackend
    & $testExe --prepare-storage $next.webview
    Assert ($LASTEXITCODE -eq 0) 'Failed migration should keep app usable'
    Start-TestBackend
    $failed = Call-Api '/api/storage'
    Assert ([bool]$failed.error) 'Failed migration did not report an error'
    Assert (($failed.entries | Where-Object id -eq 'data').path -eq $next.data) 'Failed migration changed active data'
    Assert ((Call-Api '/api/conversations').items.id -contains $chat.id) 'Failed migration allowed queued chat deletion'
    Call-Api '/api/storage/paths' 'PUT' @{ paths = $next } | Out-Null

    # Queue cancellation must survive another restart.
    Call-Api '/api/storage/cleanup' 'PUT' @{ ids = @('chats') } | Out-Null
    Call-Api '/api/storage/cleanup' 'PUT' @{ ids = @() } | Out-Null
    Stop-TestBackend
    & $testExe --prepare-storage $next.webview
    Assert ($LASTEXITCODE -eq 0) 'Prepare after cancellation failed'
    Start-TestBackend
    Assert ((Call-Api '/api/conversations').items.id -contains $chat.id) 'Canceled cleanup deleted chats'
    Call-Api '/api/storage/cleanup' 'PUT' @{ ids = @('chats','usage') } | Out-Null
    Stop-TestBackend
    & $testExe --prepare-storage $next.webview
    Assert ($LASTEXITCODE -eq 0) 'Prepare cleanup failed'
    Start-TestBackend
    Assert (-not ((Call-Api '/api/conversations').items.id -contains $chat.id)) 'Chat cleanup did not remove old chat'
    Assert ((Call-Api '/api/settings').model -eq 'fixture-model') 'Cleanup deleted settings'
    Assert (-not ((Call-Api '/api/usage/events?from=2026-10-21&to=2026-10-21').items.id -contains 'fixture-usage')) 'Usage cleanup did not remove old events'
    Write-Output "PASS: storage inventory, validation, CORS, deferred six-category Unicode migration, SQLite/chat preservation, scoped cleanup, cancellation, and original backups. Fixtures: $testRoot"
} finally {
    Stop-TestBackend
    # Leave isolated fixtures for inspection; never recursively delete a computed path.
}
