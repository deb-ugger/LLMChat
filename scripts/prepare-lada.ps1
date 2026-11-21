[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = if ($env:LLMCHAT_MODEL_PYTHON) { $env:LLMCHAT_MODEL_PYTHON } else { 'python' }
& $python (Join-Path $PSScriptRoot 'convert-lada.py')
if ($LASTEXITCODE -ne 0) { throw 'Preparing Lada failed. See the Python error above. Build-time dependencies are torch, ultralytics==8.3.243 and onnx==1.17.0.' }
