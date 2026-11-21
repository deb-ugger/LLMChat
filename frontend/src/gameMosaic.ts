import { scanMosaicPixels, sceneSignature } from "./gameMosaicGrid";
export { scanMosaicPixels } from "./gameMosaicGrid";
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

export function createMosaicGridScanner() {
  const worker = new Worker(new URL("./gameMosaicGridWorker.ts", import.meta.url), { type: "module" });
  return {
    // Each screening lane owns a worker and sends one image at a time.
    scan: (blob: Blob) => new Promise<MosaicScan>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<MosaicScan | { error: string }>) =>
        "error" in data ? reject(new Error(data.error)) : resolve(data);
      worker.onerror = event => reject(new Error(event.message || "方格检测线程出错"));
      worker.postMessage(blob);
    }),
    release: () => worker.terminate(),
  };
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

export type LadaDevice = { kind: "gpu" | "cpu"; reason?: string };

export async function loadLadaDetector(model: File, options: {
  signal?: AbortSignal; onDevice?: (device: LadaDevice) => void;
} = {}) {
  const ort = await import("onnxruntime-web/webgpu");
  const assets = runtimeAssetBase();
  ort.env.wasm.wasmPaths = {
    mjs: new URL("./manga-ort/ort-wasm-simd-threaded.asyncify.mjs", assets).href,
    wasm: new URL("./manga-ort/ort-wasm-simd-threaded.asyncify.wasm", assets).href,
  };
  ort.env.wasm.numThreads = 1;
  const bytes = await model.arrayBuffer();
  const { signal, onDevice } = options;
  const create = (provider: "webgpu" | "wasm") => ort.InferenceSession.create(bytes, { executionProviders: [provider] });
  let session: Awaited<ReturnType<typeof create>> | undefined;
  let device: LadaDevice = { kind: "gpu" };

  const release = async () => {
    const former = session;
    session = undefined;
    await former?.release();
  };
  const openCpu = async (reason: string) => {
    signal?.throwIfAborted();
    const cpu = await create("wasm");
    device = { kind: "cpu", reason };
    return cpu;
  };

  signal?.throwIfAborted();
  const gpu = (globalThis.navigator as (Navigator & { gpu?: unknown }) | undefined)?.gpu;
  if (gpu) {
    try {
      session = await create("webgpu");
    } catch (cause) {
      session = await openCpu("WebGPU 启动失败：" + (cause instanceof Error ? cause.message : String(cause)));
    }
  } else {
    session = await openCpu("当前运行环境不支持 WebGPU");
  }
  if (signal?.aborted) {
    await release();
    signal.throwIfAborted();
  }
  const input = session.inputMetadata[0];
  const output = session.outputMetadata.find(item => item.isTensor && item.shape.length === 3);
  const shape = input?.isTensor ? input.shape : [];
  const size = shape[2];
  const channels = output?.isTensor ? output.shape[1] : undefined;
  if (shape.length !== 4 || shape[0] !== 1 || shape[1] !== 3 || typeof size !== "number" ||
      size < 256 || size > 1024 || size !== shape[3] || typeof channels !== "number" || ![37, 38].includes(channels) || !output) {
    await release();
    throw new Error("请选择固定方形输入、未内置 NMS 的 Lada YOLO11 分割 ONNX");
  }
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) { await release(); throw new Error("无法读取检测模型输入像素"); }
  onDevice?.(device);
  const outputName = output.name;
  const infer = async (feeds: InstanceType<typeof ort.Tensor>) => {
    signal?.throwIfAborted();
    if (!session) throw new Error("Lada 检测会话已关闭");
    try {
      return await session.run({ [session.inputNames[0]]: feeds }, [outputName]);
    } catch (cause) {
      if (device.kind === "cpu") throw cause;
      signal?.throwIfAborted();
      await release();
      session = await openCpu("WebGPU 推理失败：" + (cause instanceof Error ? cause.message : String(cause)));
      signal?.throwIfAborted();
      onDevice?.(device);
      return session.run({ [session.inputNames[0]]: feeds }, [outputName]);
    }
  };
  return {
    release,
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
      let tensors: Awaited<ReturnType<typeof infer>> | undefined;
      try {
        tensors = await infer(feeds);
        const result = tensors[outputName];
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

function similarScene(a: SceneInput, b: SceneInput, limit: number) {
  if (a.signature.length !== 256 || b.signature.length !== 256) return false;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    sum += Math.abs(a.signature[i] - b.signature[i]);
    if (sum > limit * 256) return false;
  }
  return true;
}

export function groupMosaicScenes<T extends SceneInput>(images: readonly T[]): T[][] {
  const groups: T[][] = [];
  const families: string[] = [];
  const names = new Intl.Collator(undefined, { numeric: true });
  const sorted = [...images].sort((a, b) => names.compare(a.name, b.name));
  for (const image of sorted) {
    const family = sceneFamily(image);
    const aspect = image.width / image.height;
    const match = groups.find(([reference], i) =>
      Math.abs(aspect / (reference.width / reference.height) - 1) <= 0.04 &&
      similarScene(reference, image, family === families[i] ? 22 : 7));
    if (match) match.push(image);
    else {
      groups.push([image]);
      families.push(family);
    }
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
