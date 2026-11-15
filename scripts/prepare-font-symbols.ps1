[CmdletBinding()]
param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (!$OutputDirectory) { $OutputDirectory = Join-Path $root 'frontend/src-tauri/resources/unity/font-symbols' }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$revision = 'c30b221beb0c1da59d563feb91ec8656a1fa972a'
$fonts = @(
    @('notosanssymbols2','NotoSansSymbols2-Regular.ttf','7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21'),
    @('notosanssymbols','NotoSansSymbols[wght].ttf','f7e7e04b4a24b6c78893d50cbfd2b2f6cae49617ab047bfef668d252adb128f7'),
    @('notosansmath','NotoSansMath-Regular.ttf','3f495fe933c06786e4d5f6d86b8ee70b6753a68ee3b9d87528726de0f6e2c47d')
)
foreach ($font in $fonts) {
    $target = Join-Path $OutputDirectory $font[1]
    if (!(Test-Path -LiteralPath $target) -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $font[2]) {
        $url = "https://raw.githubusercontent.com/google/fonts/$revision/ofl/$($font[0])/$([uri]::EscapeDataString($font[1]))"
        Invoke-WebRequest -Uri $url -OutFile $target
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $font[2]) { throw "Font checksum mismatch: $target" }
    }
    $license = Join-Path $OutputDirectory "$($font[0])-OFL.txt"
    if (!(Test-Path -LiteralPath $license)) { Invoke-WebRequest -Uri "https://raw.githubusercontent.com/google/fonts/$revision/ofl/$($font[0])/OFL.txt" -OutFile $license }
}
$source = Join-Path $root 'tools/FontSymbols/font_symbols.py'
$tool = Join-Path $OutputDirectory 'llmchat-font-symbols.exe'
$buildRoot = Join-Path $root 'tools/UnityOffline/obj/font-symbols'
$python = Join-Path $buildRoot 'venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $tool) -or !(Test-Path -LiteralPath (Join-Path $OutputDirectory 'FONTTOOLS-LICENSE.txt')) -or (Get-Item -LiteralPath $source).LastWriteTimeUtc -gt (Get-Item -LiteralPath $tool).LastWriteTimeUtc) {
    if (!(Test-Path -LiteralPath $python)) {
        & python -m venv (Join-Path $buildRoot 'venv')
        if ($LASTEXITCODE -ne 0) { throw 'Unable to create isolated font helper build environment' }
    }
    & $python -c 'import fontTools, PyInstaller'
    if ($LASTEXITCODE -ne 0) { & $python -m pip install fonttools==4.55.3 pyinstaller==6.21.0; if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare font helper build dependencies' } }
    & $python -m PyInstaller --noconfirm --clean --onefile --console --name llmchat-font-symbols --collect-submodules fontTools.ttLib.tables --exclude-module numpy --exclude-module scipy --exclude-module matplotlib --exclude-module PIL --exclude-module lxml --exclude-module tkinter --distpath $OutputDirectory --workpath (Join-Path $buildRoot 'work') --specpath $buildRoot $source
    if ($LASTEXITCODE -ne 0) { throw 'Font symbol helper build failed. Build environment requires fonttools and PyInstaller.' }
}
@'
from importlib.metadata import distribution
from pathlib import Path
import sys

output = Path(sys.argv[1])
for package, source_name, target_name in (
    ("fonttools", "LICENSE", "FONTTOOLS-LICENSE.txt"),
    ("pyinstaller", "COPYING.txt", "PYINSTALLER-COPYING.txt"),
):
    installed = distribution(package)
    license_file = next(file for file in installed.files if file.name == source_name)
    (output / target_name).write_bytes(installed.locate_file(license_file).read_bytes())
'@ | & $python - $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Unable to include font helper licenses' }
$version = & $python -c 'import platform; print(platform.python_version())'
$pythonLicense = Join-Path $OutputDirectory "PYTHON-$version-LICENSE.txt"
if (!(Test-Path -LiteralPath $pythonLicense)) { Invoke-WebRequest -Uri "https://raw.githubusercontent.com/python/cpython/v$version/LICENSE" -OutFile $pythonLicense }
