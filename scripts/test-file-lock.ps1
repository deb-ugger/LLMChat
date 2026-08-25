[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$sourceScript = Join-Path $PSScriptRoot "file-lock.ps1"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("llmchat-file-lock-test-" + [guid]::NewGuid().ToString("N"))
$testScriptDir = Join-Path $testRoot "scripts"
$testScript = Join-Path $testScriptDir "file-lock.ps1"
$pwsh = (Get-Process -Id $PID).Path

function Invoke-Lock([string[]]$Arguments) {
    $output = & $pwsh -NoProfile -File $testScript @Arguments 2>&1 | Out-String
    [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -ne $Actual) {
        throw "$Message；expected=$Expected actual=$Actual"
    }
}

function Assert-Match([string]$Pattern, [string]$Actual, [string]$Message) {
    if ($Actual -notmatch $Pattern) {
        throw "$Message；output=$Actual"
    }
}

try {
    New-Item -ItemType Directory -Path $testScriptDir -Force | Out-Null
    Copy-Item -LiteralPath $sourceScript -Destination $testScript

    $result = Invoke-Lock @("acquire", "-Owner", "owner-a", "-Paths", "file-a.txt")
    Assert-Equal 0 $result.ExitCode "首次文件锁申请应成功"

    $result = Invoke-Lock @("acquire", "-Global", "-Owner", "owner-a", "-WaitSeconds", "10")
    Assert-Equal 3 $result.ExitCode "持有文件锁时的全局锁升级应立即失败"
    Assert-Match "禁止从文件锁升级" $result.Output "应说明锁升级被禁止"

    $result = Invoke-Lock @("acquire", "-Owner", "owner-a", "-Paths", "file-b.txt")
    Assert-Equal 3 $result.ExitCode "逐步扩展文件锁集合应失败"
    Assert-Match "禁止逐步扩展" $result.Output "应说明逐步扩锁被禁止"

    $job = Start-Job -ScriptBlock {
        param($PwshPath, $ScriptPath)
        $text = & $PwshPath -NoProfile -File $ScriptPath acquire -Owner owner-b -Paths file-a.txt -WaitSeconds 10 2>&1 | Out-String
        [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $text }
    } -ArgumentList $pwsh, $testScript

    Start-Sleep -Milliseconds 800
    $result = Invoke-Lock @("list")
    Assert-Equal 0 $result.ExitCode "list 应成功"
    Assert-Match "owner-b" $result.Output "list 应显示等待者"

    $result = Invoke-Lock @("diagnose")
    Assert-Equal 0 $result.ExitCode "无持锁等待时 diagnose 应成功"
    Assert-Match "正常等待" $result.Output "diagnose 应区分正常等待"

    $result = Invoke-Lock @("release-all", "-Owner", "owner-a")
    Assert-Equal 0 $result.ExitCode "owner-a 应能正常释放全部锁"
    Assert-Match "全部 1 个锁" $result.Output "release-all 应报告释放数量"

    $jobResult = Receive-Job -Job $job -Wait
    Assert-Equal 0 $jobResult.ExitCode "owner-b 应在释放后取得锁"
    Remove-Job -Job $job -Force

    $result = Invoke-Lock @("list")
    Assert-Match "当前没有锁等待者" $result.Output "成功取得锁后应清除等待记录"

    $result = Invoke-Lock @("release", "-Owner", "owner-b", "-Paths", "file-a.txt")
    Assert-Equal 0 $result.ExitCode "owner-b 应能正常释放"

    Write-Output "file-lock regression tests passed"
}
finally {
    if (Get-Job -ErrorAction SilentlyContinue) {
        Get-Job | Stop-Job -ErrorAction SilentlyContinue
        Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
