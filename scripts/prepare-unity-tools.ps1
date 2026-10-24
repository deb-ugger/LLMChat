[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'frontend\src-tauri\resources\unity'
$project = Join-Path $root 'tools\UnityOffline\UnityOffline.csproj'
if (!(Get-Command dotnet -ErrorAction SilentlyContinue)) { throw 'Install .NET SDK 8 or later to build the Unity embedding helper.' }
New-Item -ItemType Directory -Force -Path $output | Out-Null
& dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:DebugType=None -o $output
if ($LASTEXITCODE -ne 0) { throw 'Unity embedding helper build failed.' }
$database = Join-Path $output 'classdata.tpk'
if (!(Test-Path -LiteralPath $database)) {
    $download = "$database.download"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/nesrak1/UABEA/057e2f6ae67ebc94a38faca9f946f8577162fa99/ReleaseFiles/classdata.tpk' -OutFile $download
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne '129E1F80F930415DB6779FE6089AFA75280CB51462BCEE812BEAB6CD81A764C6') { throw 'Unity class database checksum mismatch.' }
        Move-Item -LiteralPath $download -Destination $database
    } finally { if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download } }
}
$notice = @'
AssetsTools.NET 3.0.5 - Copyright (c) 2020 nesrak1
https://github.com/nesrak1/AssetsTools.NET
Mono.Cecil 0.11.6 - Copyright (c) 2008 - 2015 Jb Evain; Copyright (c) 2008 - 2011 Novell, Inc.
https://github.com/jbevain/cecil
UABEA classdata.tpk - snapshot 057e2f6ae67ebc94a38faca9f946f8577162fa99
Copyright (c) 2021 nesrak1
https://github.com/nesrak1/UABEA

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
'@
[IO.File]::WriteAllText((Join-Path $output 'THIRD-PARTY.txt'), $notice, [Text.UTF8Encoding]::new($false))
$runtimePackages = Join-Path $env:USERPROFILE '.nuget\packages\microsoft.netcore.app.runtime.win-x64'
$runtime = Get-ChildItem -LiteralPath $runtimePackages -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
foreach ($name in @('LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT')) {
    $path = Join-Path $runtime.FullName $name
    if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination (Join-Path $output "DOTNET-$name") -Force }
}
Write-Output "Unity embedding tools ready: $output"
