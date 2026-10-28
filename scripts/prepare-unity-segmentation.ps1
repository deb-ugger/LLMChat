[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'frontend\public\wtp'
$model = Join-Path $output 'model.onnx'
if ((Test-Path -LiteralPath $model) -and (Test-Path -LiteralPath (Join-Path $output 'manifest.json')) -and (Test-Path -LiteralPath (Join-Path $output 'LICENSE.txt'))) { return }
$python = if ($env:LLMCHAT_MODEL_PYTHON) { $env:LLMCHAT_MODEL_PYTHON } else { 'python' }
& $python -c 'import onnx, numpy'
if ($LASTEXITCODE -ne 0) { throw 'Preparing the local segmentation model requires build-time Python with onnx==1.17.0; set LLMCHAT_MODEL_PYTHON to that interpreter. End users do not need Python.' }
New-Item -ItemType Directory -Force -Path $output | Out-Null
$download = Join-Path $output 'model.download'
try {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://huggingface.co/benjamin/wtp-bert-mini/resolve/ac9218133a447014fa557a9997a1422def9bc6e8/model.onnx' -OutFile $download
    & $python (Join-Path $PSScriptRoot 'convert-unity-wtp.py') $download $model
    if ($LASTEXITCODE -ne 0) { throw 'Local segmentation model preparation failed.' }
    Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/segment-any-text/wtpsplit/main/LICENSE' -OutFile (Join-Path $output 'LICENSE.txt')
} finally { if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download } }
