$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-incremental.ps1')
$root = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $root 'frontend'
$clock = [Diagnostics.Stopwatch]::StartNew()
try { & (Join-Path $PSScriptRoot 'prepare-mosaic-detector.ps1') }
finally { Write-Output ('Frontend detector preparation: {0:N1}s' -f $clock.Elapsed.TotalSeconds) }
$clock.Restart()
$inputs = @((Join-Path $frontend 'src'),(Join-Path $frontend 'public'),(Join-Path $frontend 'build'),(Join-Path $frontend 'node_modules\.package-lock.json'),$PSCommandPath,(Join-Path $PSScriptRoot 'build-incremental.ps1')) + @(Get-ChildItem -LiteralPath $frontend -File -Force | Select-Object -ExpandProperty FullName)
$outputs = @((Join-Path $frontend 'dist'),(Join-Path $frontend 'dist\index.html'),(Join-Path $frontend 'src-tauri\resources\web-assets'))
$environment = @(Get-ChildItem Env: | Where-Object { $_.Name -like 'VITE_*' -or $_.Name -like 'TAURI_*' -or $_.Name -eq 'NODE_ENV' } | Sort-Object Name | ForEach-Object { $_.Name + '=' + $_.Value }) -join "`n"
$hasher = [Security.Cryptography.SHA256]::Create()
try { $environmentHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($environment))).Replace('-','') } finally { $hasher.Dispose() }
$identity = "node=$(& node --version);mode=production;environment=$environmentHash"
$cached = Test-BuildCache 'frontend' $inputs $outputs $identity
Write-Output ('Frontend cache {0}: {1:N1}s' -f $(if ($cached) { 'hit' } else { 'miss' }), $clock.Elapsed.TotalSeconds)
if ($cached) { exit 0 }
$clock.Restart()
Push-Location $frontend
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    Save-BuildCache 'frontend' $inputs $outputs $identity
} finally { Pop-Location; Write-Output ('Frontend compile, assets and cache write: {0:N1}s' -f $clock.Elapsed.TotalSeconds) }
