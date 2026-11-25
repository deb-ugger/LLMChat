[CmdletBinding()]
param(
    [ValidateSet('Review', 'Label', 'TrainAndUse')]
    [string]$Action = 'Review',
    [string]$Comfy = 'E:\ComfyUI_windows_portable',
    [string]$Dataset,
    [string]$Output,
    [string]$Model = 'qwen3-vl:4b-instruct',
    [ValidateRange(0, 100000)]
    [int]$Limit = 0
)
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
if (!$Dataset) { $Dataset = Join-Path $repository 'dist-portable/image-sample-sets/mz-mira-mosaic-20261123' }
if (!$Output) { $Output = Join-Path $repository 'tmp/mosaic-region-training' }
$python = Join-Path $Comfy 'python_embeded/python.exe'
if (!(Test-Path -LiteralPath $python -PathType Leaf)) { throw "找不到 ComfyUI 的 Python，请用 -Comfy 指定目录" }
$trainer = Join-Path $PSScriptRoot 'train-mosaic-region-classifier.py'
$parameters = @($trainer, $Dataset, $Output, '--model', $Model, '--limit', $Limit)
if (Test-Path -LiteralPath (Join-Path $Dataset 'annotations.reviewed-20261124.json') -PathType Leaf) {
    $parameters += @('--annotations', 'annotations.reviewed-20261124.json')
}
switch ($Action) {
    Review { $parameters += '--review-only' }
    Label { $parameters += @('--label-only', '--cpu-teacher') }
    TrainAndUse {
        $review = Join-Path $Output 'review.csv'
        if (!(Test-Path -LiteralPath $review -PathType Leaf)) { throw "请先运行 Review 并填写纠错清单中的 corrected_part" }
        $active = Join-Path $Comfy 'ComfyUI/models/mosaic-region-targets'
        $parameters += @('--train-only', '--review', $review, '--publish-dir', $active)
    }
}
& $python -X utf8 @parameters
exit $LASTEXITCODE
