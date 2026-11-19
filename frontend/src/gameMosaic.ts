import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { runtimeAssetBase } from "./runtimeAssets";
import type { UnityImage } from "./unityOffline";

export type MosaicBox = [left: number, top: number, right: number, bottom: number];
export type MosaicModel = "2511" | "turbo";
export const mosaicModelLabels: Record<MosaicModel, string> = {
  "2511": "Qwen Image Edit 2511", turbo: "Qwen Image 2.1 Turbo",
};
export type MosaicScan = { boxes: MosaicBox[]; signature: number[] };
type SceneInput = Pick<UnityImage, "id" | "name" | "file" | "width" | "height"> & { signature: number[] };

function tileStarts(size: number, tile: number) {
  const starts: number[] = [];
  for (let start = 0; start + tile < size; start += tile / 2) starts.push(start);
  starts.push(size - tile);
  return starts;
}

function gridStrength(edges: Float64Array, period: number) {
  let best = 0;
  const total = edges.reduce((sum, edge) => sum + edge, 0);
  for (let phase = 0; phase < period; phase++) {
    let count = 0, strong = 0, sum = 0;
    for (let index = phase; index < edges.length; index += period) {
      const edge = edges[index];
      count++;
      sum += edge;
      if (edge >= 10) strong++;
    }
    if (count < 3 || strong * 4 < count * 3 || sum / count < 14) continue;
    const elsewhere = (total - sum) / (edges.length - count);
    if (sum / count - elsewhere >= 10) best = Math.max(best, (sum / count) / Math.max(3, elsewhere));
  }
  return best;
}

function union(a: MosaicBox, b: MosaicBox): MosaicBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function mergeCandidate(boxes: MosaicBox[], next: MosaicBox) {
  for (let index = 0; index < boxes.length;) {
    const box = boxes[index];
    if (box[0] < next[2] && box[2] > next[0] && box[1] < next[3] && box[3] > next[1]) {
      next = union(box, next);
      boxes.splice(index, 1);
      index = 0;
    } else index++;
  }
  boxes.push(next);
}

function sceneSignature(rgba: Uint8ClampedArray, width: number, height: number) {
  const signature: number[] = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const index = (Math.floor((y + 0.5) * height / 16) * width + Math.floor((x + 0.5) * width / 16)) * 4;
    const luma = (rgba[index] * 54 + rgba[index + 1] * 183 + rgba[index + 2] * 19) / 256;
    signature.push(Math.round((luma - 127) * rgba[index + 3] / 255 + 127));
  }
  return signature;
}

export function scanMosaicPixels(rgba: Uint8ClampedArray, width: number, height: number): MosaicScan {
  const boxes: MosaicBox[] = [];
  const signature = sceneSignature(rgba, width, height);
  if (Math.min(width, height) < 48) return { boxes, signature };

  const size = Math.min(64, width, height);
  const horizontal = new Float64Array(size - 1);
  const vertical = new Float64Array(size - 1);
  const distance = (a: number, b: number) =>
    Math.min(rgba[a + 3], rgba[b + 3]) < 64 ? 0 :
      (Math.abs(rgba[a] - rgba[b]) + Math.abs(rgba[a + 1] - rgba[b + 1]) + Math.abs(rgba[a + 2] - rgba[b + 2])) / 3;

  for (const y of tileStarts(height, size)) for (const x of tileStarts(width, size)) {
    for (let edge = 0; edge < size - 1; edge++) {
      let across = 0, down = 0, samples = 0;
      for (let offset = 0; offset < size; offset += 4) {
        const h = ((y + offset) * width + x + edge) * 4;
        const v = ((y + edge) * width + x + offset) * 4;
        across += distance(h, h + 4);
        down += distance(v, v + width * 4);
        samples++;
      }
      horizontal[edge] = across / samples;
      vertical[edge] = down / samples;
    }
    for (let period = 4; period <= 24; period++) {
      if (gridStrength(horizontal, period) >= 3.2 && gridStrength(vertical, period) >= 3.2) {
        mergeCandidate(boxes, [Math.floor(x), Math.floor(y), Math.floor(x + size), Math.floor(y + size)]);
        break;
      }
    }
  }
  return { boxes, signature };
}

async function bitmapPixels(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) { bitmap.close(); throw new Error("无法读取图片像素"); }
  try {
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } finally { bitmap.close(); }
}

export async function scanMosaic(blob: Blob): Promise<MosaicScan> {
  const image = await bitmapPixels(blob);
  return scanMosaicPixels(image.data, image.width, image.height);
}

const threshold = 0.25;
function overlap(a: MosaicBox, b: MosaicBox) {
  const area = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return area / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - area);
}

export function ladaBoxes(values: Float32Array, dims: readonly number[], classes: number,
  geometry: { left: number; top: number; scaleX: number; scaleY: number; width: number; height: number }) {
  if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== 4 + classes + 32 || dims[2] <= 0)
    throw new Error("Lada ONNX 需使用原始 YOLO11 分割输出（关闭 NMS 导出）");
  const { left, top, scaleX, scaleY, width, height } = geometry;
  const count = dims[2];
  const candidates: { box: MosaicBox; score: number }[] = [];
  for (let index = 0; index < count; index++) {
    let score = 0;
    for (let c = 0; c < classes; c++) score = Math.max(score, values[(4 + c) * count + index]);
    if (score < threshold) continue;
    const x = values[index], y = values[count + index], w = values[count * 2 + index], h = values[count * 3 + index];
    const box: MosaicBox = [
      Math.max(0, Math.floor((x - w / 2 - left) / scaleX)), Math.max(0, Math.floor((y - h / 2 - top) / scaleY)),
      Math.min(width, Math.ceil((x + w / 2 - left) / scaleX)), Math.min(height, Math.ceil((y + h / 2 - top) / scaleY)),
    ];
    if (box[2] > box[0] && box[3] > box[1]) candidates.push({ box, score });
  }
  const boxes: MosaicBox[] = [];
  for (const { box } of candidates.sort((a, b) => b.score - a.score)) {
    if (!boxes.some(previous => overlap(previous, box) > 0.45)) boxes.push(box);
  }
  return boxes;
}

export async function loadLadaDetector(model: File) {
  const ort = await import("onnxruntime-web/webgpu");
  const assets = runtimeAssetBase();
  ort.env.wasm.wasmPaths = {
    mjs: new URL("./ort/ort-wasm-simd-threaded.jsep.mjs", assets).href,
    wasm: new URL("./ort/ort-wasm-simd-threaded.jsep.wasm", assets).href,
  };
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(await model.arrayBuffer(), { executionProviders: ["wasm"] });
  const input = session.inputMetadata[0];
  const output = session.outputMetadata.find(item => item.isTensor && item.shape.length === 3);
  const shape = input?.isTensor ? input.shape : [];
  const size = shape[2];
  const channels = output?.isTensor ? output.shape[1] : undefined;
  if (shape.length !== 4 || shape[0] !== 1 || shape[1] !== 3 || typeof size !== "number" ||
      size < 256 || size > 1024 || size !== shape[3] || typeof channels !== "number" || ![37, 38].includes(channels) || !output) {
    await session.release();
    throw new Error("请选择固定方形输入、未内置 NMS 的 Lada YOLO11 分割 ONNX");
  }
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) { await session.release(); throw new Error("无法读取检测模型输入像素"); }
  return {
    release: () => session.release(),
    scan: async (blob: Blob): Promise<MosaicScan> => {
      const full = await bitmapPixels(blob);
      const source = await createImageBitmap(blob);
      const scale = Math.min(size / full.width, size / full.height);
      const width = Math.max(1, Math.round(scale * full.width)), height = Math.max(1, Math.round(scale * full.height));
      const left = Math.floor((size - width) / 2), top = Math.floor((size - height) / 2);
      try {
        context.fillStyle = "#727272";
        context.fillRect(0, 0, size, size);
        context.drawImage(source, left, top, width, height);
      } finally { source.close(); }
      const { data } = context.getImageData(0, 0, size, size);
      const plane = size * size;
      const values = new Float32Array(3 * plane);
      for (let index = 0; index < plane; index++) {
        values[index] = data[4 * index] / 255;
        values[index + plane] = data[4 * index + 1] / 255;
        values[index + 2 * plane] = data[4 * index + 2] / 255;
      }
      const feeds = new ort.Tensor("float32", values, [1, 3, size, size]);
      let tensors: Awaited<ReturnType<typeof session.run>> | undefined;
      try {
        tensors = await session.run({ [session.inputNames[0]]: feeds }, [output.name]);
        const result = tensors[output.name];
        const data = result.data;
        if (!(data instanceof Float32Array)) throw new Error("请选择 FP32 的 Lada ONNX");
        return { signature: sceneSignature(full.data, full.width, full.height), boxes: ladaBoxes(data, result.dims, channels - 36,
          { left, top, scaleX: width / full.width, scaleY: height / full.height, width: full.width, height: full.height }) };
      } finally {
        feeds.dispose();
        for (const value of Object.values(tensors || {})) value.dispose();
      }
    },
  };
}

function sceneFamily(image: SceneInput) {
  const name = image.name.replace(/\.[^.]+$/, "");
  const match = name.match(/^(.*?)[_-]?(\d{2,})$/);
  return match ? (match[1] + ":" + match[2].slice(0, Math.max(0, match[2].length - 2))).toLowerCase() : name.toLowerCase();
}

function sceneDistance(a: SceneInput, b: SceneInput) {
  if (a.signature.length !== 256 || b.signature.length !== 256) return Infinity;
  return a.signature.reduce((sum, value, index) => sum + Math.abs(value - b.signature[index]), 0) / 256;
}

export function groupMosaicScenes<T extends SceneInput>(images: readonly T[]): T[][] {
  const groups: T[][] = [];
  const sorted = [...images].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const image of sorted) {
    const family = sceneFamily(image);
    const aspect = image.width / image.height;
    const match = groups.find(([reference]) => {
      if (Math.abs(aspect / (reference.width / reference.height) - 1) > 0.04) return false;
      const sameFamily = family === sceneFamily(reference);
      return sceneDistance(reference, image) <= (sameFamily ? 22 : 7);
    });
    if (match) match.push(image);
    else groups.push([image]);
  }
  return groups;
}

export function mapMosaicBoxes(boxes: MosaicBox[], from: { width: number; height: number }, to: { width: number; height: number }) {
  return boxes.map(([left, top, right, bottom]): MosaicBox => [
    Math.floor(left * to.width / from.width), Math.floor(top * to.height / from.height),
    Math.ceil(right * to.width / from.width), Math.ceil(bottom * to.height / from.height),
  ]);
}

export async function mosaicInputKey(blob: Blob, boxes: MosaicBox[]) {
  const { data, width, height } = await bitmapPixels(blob);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return JSON.stringify([width, height, Array.from(new Uint8Array(hash)), boxes]);
}

async function encoded(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });
}

type Weights = { model: string; clip: string; vae: string };
async function mosaicWeights(directory: string, model: MosaicModel) {
  const fields = ["model", "clip", "vae"] as const;
  let saved: Partial<Weights> = {};
  try { saved = JSON.parse(localStorage.getItem("llmchat-redraw-profiles") || "{}")?.[model] || {}; }
  catch { /* The available models can be selected from the local inventory. */ }
  if (saved.model && saved.clip && saved.vae) return saved as Weights;
  const files = await invoke<Record<keyof Weights, string[]>>("inspect_redraw_directory", { directory });
  const patterns = model === "turbo"
    ? { model: /qwen.image.2[._]1.turbo.*convrot/i, clip: /qwen3vl.*8b.*convrot/i, vae: /qwen.image.2[._]1.vae/i }
    : { model: /qwen.image.edit.2511.*q4.*\.gguf$/i, clip: /qwen.2[._]5.vl.*fp8/i, vae: /^qwen.image.vae/i };
  const profile = { model: "", clip: "", vae: "" };
  for (const field of fields) profile[field] = saved[field] || files[field].find(name => patterns[field].test(name)) || "";
  if (fields.some(field => !profile[field])) throw new Error("缺少 " + mosaicModelLabels[model] + " 的本地权重，请在 AI 风格重绘中选择模型文件");
  return profile;
}

export async function redrawMosaic(input: {
  source: Blob; boxes: MosaicBox[]; reference?: Blob; keep: MosaicBox[]; model: MosaicModel; steps: number; seed: number;
  signal: AbortSignal; progress: (detail: string) => void;
}) {
  if (!isTauri()) throw new Error("图片去码需要桌面端的本地 ComfyUI");
  const saved = localStorage.getItem("llmchat-comfy-directory");
  const directory = saved || (await invoke<string[]>("find_redraw_directories"))[0];
  if (!directory) throw new Error("请先在 AI 风格重绘中配置 ComfyUI");
  const image = await encoded(input.source);
  const referenceImage = input.reference && await encoded(input.reference);
  input.signal.throwIfAborted();
  const progress = new Channel<string>();
  progress.onmessage = detail => { if (!input.signal.aborted) input.progress(detail); };
  const weights = await mosaicWeights(directory, input.model);
  input.signal.throwIfAborted();
  const result = await invoke<{ image: string }>("run_style_redraw", {
    directory, steps: input.steps, mode: "mosaic", image, progress,
    regions: input.boxes.map(box => ({ box })),
    profile: { ...weights, kind: input.model, referenceImage, keep: input.keep, seed: input.seed },
  });
  input.signal.throwIfAborted();
  return new Blob([Uint8Array.from(atob(result.image), char => char.charCodeAt(0))], { type: "image/png" });
}
