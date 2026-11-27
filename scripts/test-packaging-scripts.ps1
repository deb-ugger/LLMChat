$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptNames = @('prepare-sidecar.ps1', 'prepare-speech-tools.ps1', 'make-portable.ps1')

$parseScriptNames = $scriptNames + @('build.ps1', 'stop-project-processes.ps1', 'file-lock.ps1')
foreach ($name in $parseScriptNames) {
    $path = Join-Path $PSScriptRoot $name
    $bytes = [IO.File]::ReadAllBytes($path)
    $hasUtf8Bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $hasNonAscii = @($bytes | Where-Object { $_ -gt 127 }).Count -gt 0
    if ($hasNonAscii -and !$hasUtf8Bom) {
        throw "$name must use UTF-8 with BOM for Windows PowerShell 5.1."
    }

    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
        throw ($errors | ForEach-Object { "${name}:$($_.Extent.StartLineNumber): $($_.Message)" } | Out-String)
    }

    # Also check the CP936 decoding used by Chinese Windows PowerShell 5.1.
    $source = if ($hasUtf8Bom) {
        [Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    } else {
        [Text.Encoding]::GetEncoding(936).GetString($bytes)
    }
    [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { throw "$name does not parse with CP936 defaults." }
    Write-Output "PASS: $name parses (PowerShell $($PSVersionTable.PSVersion))."
}

$readme = Get-Content -LiteralPath (Join-Path $projectRoot 'README.md') -Raw -Encoding UTF8
foreach ($name in $scriptNames) {
    if (!$readme.Contains("powershell -File scripts/$name")) { throw "README is missing the packaging command for $name." }
}
Write-Output 'PASS: README packaging commands match the checked scripts.'

# Exercise the production close dispatcher with native calls replaced by an
# in-memory fixture. Never signal or close a real application during this test.
$closePath = Join-Path $PSScriptRoot 'stop-project-processes.ps1'
$tokens = $null; $errors = $null
$closeAst = [Management.Automation.Language.Parser]::ParseFile($closePath, [ref]$tokens, [ref]$errors)
$nativeSource = $closeAst.Find({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.Contains('public static class LlmChatBuildWindow') }, $true).Value
$nativeSource = $nativeSource.Replace('LlmChatBuildWindow', 'LlmChatCloseFixture')
$nativeSource = $nativeSource.Replace('public static class LlmChatCloseFixture {', @'
public static class LlmChatCloseFixture {
    public static bool HasChannel = true;
    public static uint WindowOwner = 77;
    public static System.Collections.Generic.List<string> Calls = new System.Collections.Generic.List<string>();
'@)
$stubs = @{
    GetLastActivePopup = 'static IntPtr GetLastActivePopup(IntPtr window) { return new IntPtr(11); }'
    IsWindowVisible = 'static bool IsWindowVisible(IntPtr window) { return true; }'
    IsIconic = 'static bool IsIconic(IntPtr window) { return true; }'
    ShowWindowAsync = 'static bool ShowWindowAsync(IntPtr window, int command) { Calls.Add("restore"); return true; }'
    SetForegroundWindow = 'static bool SetForegroundWindow(IntPtr window) { Calls.Add("foreground"); return true; }'
    GetWindowThreadProcessId = 'static uint GetWindowThreadProcessId(IntPtr window, out uint pid) { pid = WindowOwner; return 1; }'
    SetLastError = 'static void SetLastError(uint error) {}'
    OpenEventW = 'static IntPtr OpenEventW(uint access, bool inherit, string name) { Calls.Add("channel"); return HasChannel ? new IntPtr(22) : IntPtr.Zero; }'
    SetEvent = 'static bool SetEvent(IntPtr handle) { Calls.Add("signal"); return true; }'
    CloseHandle = 'static bool CloseHandle(IntPtr handle) { return true; }'
    PostMessageW = 'static bool PostMessageW(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam) { Calls.Add("post"); return true; }'
}
$nativeSource = [regex]::Replace($nativeSource, '(?s)\[DllImport\([^\]]+\)\]\s*static extern [^;]+;', {
    param($match)
    $name = [regex]::Match($match.Value, '(\w+)\([^()]*\);$').Groups[1].Value
    if (!$stubs.ContainsKey($name)) { throw "Missing native fixture for $name" }
    $stubs[$name]
})
Add-Type -TypeDefinition $nativeSource
$null = [LlmChatCloseFixture]::RequestClose([IntPtr]10, 77)
if (([LlmChatCloseFixture]::Calls -join ',') -ne 'restore,foreground,channel,signal') { throw 'Application channel must restore and foreground its own window before signaling.' }
[LlmChatCloseFixture]::Calls.Clear(); [LlmChatCloseFixture]::HasChannel = $false
$null = [LlmChatCloseFixture]::RequestClose([IntPtr]10, 77)
if (([LlmChatCloseFixture]::Calls -join ',') -ne 'restore,foreground,channel,post') { throw 'Older applications must retain foreground and title-bar close behavior.' }
[LlmChatCloseFixture]::Calls.Clear(); [LlmChatCloseFixture]::WindowOwner = 88; [LlmChatCloseFixture]::HasChannel = $true
$null = [LlmChatCloseFixture]::RequestClose([IntPtr]10, 77)
if (([LlmChatCloseFixture]::Calls -join ',') -ne 'channel,signal') { throw 'Never foreground a window owned by another process.' }
Write-Output 'PASS: close channels foreground only the verified project window before requesting save/cancel guards.'
