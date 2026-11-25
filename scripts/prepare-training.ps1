[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$destination = Join-Path $root 'frontend/src-tauri/resources/training'
$weights = Join-Path $destination 'torch/hub/checkpoints/mobilenet_v3_small-047dcff4.pth'
New-Item -ItemType Directory -Force -Path (Split-Path $weights -Parent) | Out-Null
if (!(Test-Path -LiteralPath $weights)) {
    $cache = Join-Path $env:USERPROFILE '.cache/torch/hub/checkpoints/mobilenet_v3_small-047dcff4.pth'
    if (Test-Path -LiteralPath $cache) { Copy-Item -LiteralPath $cache -Destination $weights }
    else { Invoke-WebRequest -Uri 'https://download.pytorch.org/models/mobilenet_v3_small-047dcff4.pth' -OutFile $weights }
}
if (!(Get-FileHash -LiteralPath $weights -Algorithm SHA256).Hash.StartsWith('047DCFF4')) {
    throw '训练预训练权重校验失败'
}
foreach ($name in @('mosaic-region-training.ps1', 'train-mosaic-region-classifier.py', 'training-results.py')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $destination $name)
}
