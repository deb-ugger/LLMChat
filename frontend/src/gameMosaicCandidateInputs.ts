import type { MosaicBox } from "./gameMosaic";
import type { MosaicDetection } from "./gameMosaicScreening";

export type MosaicLocalModels = {
  eva?: { modelPath: string; labelsPath: string };
  mrcnn?: { modelPath: string };
};
export function validateMosaicLocalModels(value: unknown): asserts value is MosaicLocalModels | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本地初筛模型配置无效");
  const models = value as MosaicLocalModels;
  const path = (value: unknown, extension: string) => typeof value === "string" && value.trim() &&
    /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value) && value.toLowerCase().endsWith(extension);
  if (models.eva !== undefined && (!models.eva || !path(models.eva.modelPath, ".onnx") || !path(models.eva.labelsPath, ".csv")))
    throw new Error("EVA02 需要 ONNX 模型和标签 CSV 的绝对路径");
  if (models.mrcnn !== undefined && (!models.mrcnn || !path(models.mrcnn.modelPath, ".onnx")))
    throw new Error("Mask R-CNN 需要 ONNX 模型的绝对路径");
  if (Object.keys(models).some(key => key !== "eva" && key !== "mrcnn")) throw new Error("未知的本地初筛模型类型");
}
export function evaCensorIndexes(csv: string) {
  const rows = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/).slice(1);
  const names = rows.map(line => line.split(",")[1]);
  const indexes = ["censored", "mosaic_censoring", "bar_censor"].map(name => names.indexOf(name));
  if (indexes.some(index => index < 0)) throw new Error("EVA02 标签文件缺少打码分类标签");
  return { indexes, count: rows.length };
}
/** WD EVA02 ONNX takes raw BGR NHWC pixels; normalization is inside the exported graph. */
export function evaPixels(pixels: Uint8ClampedArray) {
  const values = new Float32Array(pixels.length / 4 * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
    values[j] = pixels[i + 2]; values[j + 1] = pixels[i + 1]; values[j + 2] = pixels[i];
  }
  return values;
}
export function mrcnnPixels(pixels: Uint8ClampedArray) {
  const values = new Float32Array(pixels.length / 4 * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
    values[j] = pixels[i] - 123.7; values[j + 1] = pixels[i + 1] - 116.8; values[j + 2] = pixels[i + 2] - 103.9;
  }
  return values;
}
export function mrcnnAnchors() {
  const values = new Float32Array(261888 * 4);
  let index = 0;
  for (const [level, stride] of [4, 8, 16, 32, 64].entries()) {
    const side = 1024 / stride, scale = 32 * 2 ** level;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) for (const ratio of [0.5, 1, 2]) {
      const height = scale / Math.sqrt(ratio), width = scale * Math.sqrt(ratio);
      values[index++] = (y * stride - height / 2) / 1023;
      values[index++] = (x * stride - width / 2) / 1023;
      values[index++] = (y * stride + height / 2 - 1) / 1023;
      values[index++] = (x * stride + width / 2 - 1) / 1023;
    }
  }
  return values;
}
export function mrcnnResize(width: number, height: number) {
  const scale = Math.min(Math.max(1, 800 / Math.min(width, height)), 1024 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  return { scale, width: w, height: h, left: Math.floor((1024 - w) / 2), top: Math.floor((1024 - h) / 2) };
}
export type MrcnnGeometry = { bounds: MosaicBox; left: number; top: number; width: number; height: number; scale?: number };
export function mrcnnMetadata({ bounds, left, top, width, height, scale }: MrcnnGeometry) {
  const w = bounds[2] - bounds[0], h = bounds[3] - bounds[1];
  return new Float32Array([0, h, w, 3, 1024, 1024, 3, top, left, top + height, left + width,
    scale ?? Math.min(width / w, height / h), 0, 0, 0]);
}
export function mrcnnDetections(values: Float32Array, dims: readonly number[], geometry: MrcnnGeometry): MosaicDetection[] {
  if (dims.length !== 3 || dims[0] !== 1 || dims[2] !== 6 || values.length !== dims[1] * 6)
    throw new Error("Mask R-CNN 输出格式无效");
  const { bounds, left, top, width, height } = geometry;
  const w = bounds[2] - bounds[0], h = bounds[3] - bounds[1], result: MosaicDetection[] = [];
  for (let i = 0; i < values.length; i += 6) {
    const [y0, x0, y1, x1, cls, score] = values.slice(i, i + 6);
    if (![y0, x0, y1, x1, cls, score].every(Number.isFinite)) throw new Error("Mask R-CNN 输出包含无效数值");
    if (cls === 0 || score < 0.05) continue;
    if (![1, 2].includes(cls) || score > 1) throw new Error("Mask R-CNN 输出类别或置信度无效");
    const box: MosaicBox = [
      Math.max(bounds[0], Math.floor(bounds[0] + (x0 * 1023 - left) / Math.max(1, width - 1) * (w - 1))),
      Math.max(bounds[1], Math.floor(bounds[1] + (y0 * 1023 - top) / Math.max(1, height - 1) * (h - 1))),
      Math.min(bounds[2], Math.ceil(bounds[0] + (x1 * 1023 - left) / Math.max(1, width - 1) * (w - 1) + 1)),
      Math.min(bounds[3], Math.ceil(bounds[1] + (y1 * 1023 - top) / Math.max(1, height - 1) * (h - 1) + 1)),
    ];
    if (box[2] > box[0] && box[3] > box[1]) result.push({ box, score });
  }
  return result;
}
