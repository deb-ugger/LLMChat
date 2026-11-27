function Get-ProjectExecutableKey([string]$Path) {
    if ($Path.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { $Path = '\\' + $Path.Substring(8) }
    elseif ($Path.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) { $Path = $Path.Substring(4) }
    [IO.Path]::GetFullPath($Path)
}

function Request-ProjectCloseWindow($Process) {
    $handle = $Process.MainWindowHandle
    if (!('LlmChatBuildWindow' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LlmChatBuildWindow {
    [DllImport("user32.dll")] static extern IntPtr GetLastActivePopup(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool PostMessageW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("kernel32.dll")]
    static extern void SetLastError(uint error);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenEventW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetEvent(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static string RequestClose(IntPtr window, uint expectedProcessId) {
        uint owner;
        bool ownedWindow = window != IntPtr.Zero && GetWindowThreadProcessId(window, out owner) != 0 && owner == expectedProcessId;
        if (ownedWindow) {
            if (IsIconic(window)) ShowWindowAsync(window, 9);
            var popup = GetLastActivePopup(window);
            SetForegroundWindow(popup != IntPtr.Zero && IsWindowVisible(popup) ? popup : window);
        }
        const uint EVENT_MODIFY_STATE = 0x0002;
        var signal = OpenEventW(EVENT_MODIFY_STATE, false, "Local\\LLMChat.Close." + expectedProcessId);
        if (signal != IntPtr.Zero) {
            try {
                if (SetEvent(signal)) return "application close signal delivered; waiting for save/cancel guards and exit";
                return "application close signal failed (Win32 " + Marshal.GetLastWin32Error() + ")";
            } finally { CloseHandle(signal); }
        }
        if (window == IntPtr.Zero) return "application close channel unavailable; no main window";
        if (!ownedWindow) return "window unavailable";
        // Existing binaries without the application channel use the standard
        // title-bar command. Queueing it is not proof the app started shutdown.
        const uint WM_SYSCOMMAND = 0x0112;
        const uint SC_CLOSE = 0xF060;
        SetLastError(0);
        if (PostMessageW(window, WM_SYSCOMMAND, new UIntPtr(SC_CLOSE), IntPtr.Zero))
            return "application close channel unavailable (older app); title-bar close queued; waiting for application exit";
        return "close command could not be queued (Win32 " + Marshal.GetLastWin32Error() + ")";
    }
}
'@
    }
    [LlmChatBuildWindow]::RequestClose($handle, $Process.Id)
}

function Get-ProjectCloseDiagnostic($Process, [DateTimeOffset]$Since) {
    $directory = Split-Path -Parent $Process.ExecutablePath
    $storageFile = Join-Path $directory 'storage-paths.json'
    if (Test-Path -LiteralPath $storageFile) {
        try {
            $storage = Get-Content -LiteralPath $storageFile -Raw | ConvertFrom-Json
            if ($storage.active.data) { $directory = $storage.active.data }
        } catch { return "PID=$($Process.ProcessId): cannot read storage paths: $($_.Exception.Message)" }
    }
    $log = Join-Path $directory 'logs\runtime.log'
    $events = @()
    if (Test-Path -LiteralPath $log) {
        foreach ($line in (Get-Content -LiteralPath $log -Tail 160)) {
            try {
                $entry = $line | ConvertFrom-Json
                if ($entry.pid -eq $Process.ProcessId -and $entry.time -ge $Since.ToUnixTimeMilliseconds() -and
                    ($entry.kind -like 'app-close*' -or $entry.kind -like 'shutdown*' -or $entry.kind -like 'backend-stop*' -or $entry.kind -like 'build-close*')) { $events += $entry }
            } catch { continue }
        }
    }
    if (!$events.Count) { return "PID=$($Process.ProcessId): no application close event recorded. Log: $log" }
    $stages = ($events | Select-Object -Last 6 | ForEach-Object { $_.kind }) -join ' -> '
    return "PID=$($Process.ProcessId): recorded shutdown stages: $stages. Log: $log"
}

function Get-ProjectProcesses {
    param([string[]]$ExecutablePaths)
    $expected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $ExecutablePaths) { $null = $expected.Add((Get-ProjectExecutableKey $path)) }
    Get-CimInstance Win32_Process -Filter "Name = 'llmchat.exe' OR Name = 'llmchat-backend.exe' OR Name = 'llmchat-backend-x86_64-pc-windows-msvc.exe'" -ErrorAction Stop |
        Where-Object { $_.ExecutablePath -and $expected.Contains((Get-ProjectExecutableKey $_.ExecutablePath)) }
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
    $closeStarted = [DateTimeOffset]::UtcNow
    foreach ($app in $apps) {
        $process = Get-Process -Id $app.ProcessId -ErrorAction SilentlyContinue
        if ($process) {
            $status = Request-ProjectCloseWindow $process
            Write-Output "Normal close request: PID=$($app.ProcessId); $status"
        }
    }
    if ($apps.Count) { Write-Output "Waiting up to $CloseTimeoutSeconds seconds. Check LLMChat for save/cancel prompts or shutdown progress." }
    $waitSeconds = if ($apps.Count) { $CloseTimeoutSeconds } else { [Math]::Min(3, $CloseTimeoutSeconds) }
    $deadline = [DateTime]::UtcNow.AddSeconds($waitSeconds)
    if ($owned.Count) {
        do {
            $alive = @($owned | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
            if (!$alive.Count -or [DateTime]::UtcNow -ge $deadline) { break }
            Start-Sleep -Milliseconds 250
        } while ($true)
    }
    # Re-read executable paths before any forced stop; never kill by name alone.
    $remaining = @(Get-ProjectProcesses -ExecutablePaths $ExecutablePaths)
    if ($remaining.Count -and !$KillRemaining) {
        foreach ($app in $apps) { Write-Output (Get-ProjectCloseDiagnostic $app $closeStarted) }
        $details = ($remaining | ForEach-Object { "$($_.Name) PID=$($_.ProcessId) [$($_.ExecutablePath)]" }) -join '; '
        throw "Normal shutdown has not finished: $details. Resolve any save/cancel prompt, or use build.cmd -ForceClose only to discard unsaved changes and force this checkout to stop."
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
