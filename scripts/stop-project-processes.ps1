function Get-ProjectProcesses {
    param([string[]]$ExecutablePaths)
    $expected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $ExecutablePaths) { $null = $expected.Add([IO.Path]::GetFullPath($path)) }
    Get-CimInstance Win32_Process -Filter "Name = 'llmchat.exe' OR Name = 'llmchat-backend.exe' OR Name = 'llmchat-backend-x86_64-pc-windows-msvc.exe'" -ErrorAction Stop |
        Where-Object { $_.ExecutablePath -and $expected.Contains([IO.Path]::GetFullPath($_.ExecutablePath)) }
}

function Stop-ProjectProcesses {
    param(
        [Parameter(Mandatory = $true)][string[]]$ExecutablePaths,
        [switch]$KillRemaining,
        [ValidateRange(0, 60)][int]$CloseTimeoutSeconds = 10
    )
    $owned = @(Get-ProjectProcesses -ExecutablePaths $ExecutablePaths)
    if (!$owned.Count) { return }
    $apps = @($owned | Where-Object Name -eq 'llmchat.exe')
    foreach ($app in $apps) {
        $process = Get-Process -Id $app.ProcessId -ErrorAction SilentlyContinue
        if ($process) { $null = $process.CloseMainWindow() }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($CloseTimeoutSeconds)
    if ($apps.Count) {
        do {
            $alive = @($owned | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
            if (!$alive.Count -or [DateTime]::UtcNow -ge $deadline) { break }
            Start-Sleep -Milliseconds 250
        } while ($true)
    }
    # Re-read executable paths before any forced stop; never kill by name alone.
    $remaining = @(Get-ProjectProcesses -ExecutablePaths $ExecutablePaths)
    if ($remaining.Count -and !$KillRemaining) {
        throw 'This checkout is still running. Close its LLMChat window/backend before updating.'
    }
    foreach ($process in $remaining) {
        Write-Output "Stopping PID=$($process.ProcessId): $($process.ExecutablePath)"
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        Wait-Process -Id $process.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
    if (@(Get-ProjectProcesses -ExecutablePaths $ExecutablePaths).Count) {
        throw 'A process from this checkout restarted; build stopped without replacing its files.'
    }
}
