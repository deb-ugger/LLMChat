[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$python = if ($env:LLMCHAT_MODEL_PYTHON) { $env:LLMCHAT_MODEL_PYTHON } else { 'python' }
& $python (Join-Path $PSScriptRoot 'convert-mosaic-detector.py')
if ($LASTEXITCODE -ne 0) { throw 'Preparing the 2D detector failed. See the Python error above. Model preparation requires onnx==1.17.0 at build time.' }
