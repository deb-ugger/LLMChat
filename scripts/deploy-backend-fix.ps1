$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot "prepare-sidecar.ps1")

$src = Join-Path $root "backend\build\Release\llmchat-backend.exe"
$targets = @(
    (Join-Path $root "frontend\src-tauri\binaries\llmchat-backend-x86_64-pc-windows-msvc.exe"),
    (Join-Path $root "frontend\src-tauri\target\release\llmchat-backend.exe"),
    (Join-Path $root "dist-portable\llmchat-backend.exe"),
    (Join-Path $root "dist-portable\llmchat-backend-x86_64-pc-windows-msvc.exe")
)

Write-Output "Stopping llmchat processes so backend files can be replaced..."
Get-Process | Where-Object { $_.ProcessName -match '^llmchat' } | ForEach-Object {
    Write-Output ("  stop PID=$($_.Id) $($_.ProcessName)")
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

foreach ($t in $targets) {
    $dir = Split-Path $t
    if (-not (Test-Path $dir)) { continue }
    Copy-Item $src $t -Force
    Write-Output ("Updated: $t")
}

Write-Output "Done. Restart LLMChat, then click 打开游戏目录 again."
