[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$commit = '6b931a9172585a07037e96f4d362f3e97a19a603'
$source = "https://codeload.github.com/c01ns/Il2CppDumper/zip/$commit"
$hash = '6E77C5D46ABC1AB32775B9A13BDCA7F55ADCE161D38E00B7B0B088E477855F2B'
$stamp = "Il2CppDumper compatibility commit $commit"
$notice = Join-Path $OutputDirectory 'IL2CPPDUMPER-LICENSE.txt'
$target = Join-Path $OutputDirectory 'Il2CppDumper.exe'
if ((Test-Path -LiteralPath $target -PathType Leaf) -and (Test-Path -LiteralPath $notice -PathType Leaf) -and
    (Get-Content -LiteralPath $notice -TotalCount 1) -eq $stamp) { return }

$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$work = Join-Path $temporaryRoot ('llmchat-dumper-build-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $zip = Join-Path $work 'source.zip'
    Invoke-WebRequest -UseBasicParsing -Uri $source -OutFile $zip -TimeoutSec 60
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $hash) { throw 'Il2CppDumper source checksum mismatch.' }
    Expand-Archive -LiteralPath $zip -DestinationPath $work
    $checkout = Join-Path $work "Il2CppDumper-$commit"
    $project = Join-Path $checkout 'Il2CppDumper/Il2CppDumper.csproj'
    $publish = Join-Path $work 'publish'
    & dotnet publish $project -c Release -f net8.0 -r win-x64 --self-contained true -p:TargetFrameworks=net8.0 -p:PublishSingleFile=true -p:DebugType=None -o $publish
    if ($LASTEXITCODE -ne 0) { throw 'Il2CppDumper build failed.' }
    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    Copy-Item -LiteralPath (Join-Path $publish 'Il2CppDumper.exe') -Destination $target -Force
    $license = Get-Content -LiteralPath (Join-Path $checkout 'LICENSE') -Raw
    @($stamp, 'https://github.com/Perfare/Il2CppDumper/pull/840', '', $license) | Set-Content -LiteralPath $notice -Encoding UTF8
} finally {
    if ((Resolve-Path -LiteralPath $work).ProviderPath -eq $work -and (Split-Path -Parent $work) -eq $temporaryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)) {
        Remove-Item -LiteralPath $work -Recurse -Force
    }
}
