import { scanMosaicPixels, sceneSignature } from "./gameMosaicGrid";
export { scanMosaicPixels } from "./gameMosaicGrid";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { runtimeAssetBase } from "./runtimeAssets";
import { measureGameAsync, recordGameCacheHit, recordGameWorkflowTiming } from "./gameModelPerformance";
import type { UnityImage } from "./unityOffline";

export type MosaicBox = [left: number, top: number, right: number, bottom: number];
export type MosaicModel = "2511" | "turbo";
export const mosaicModelLabels: Record<MosaicModel, string> = {
  "2511": "Qwen Image Edit 2511", turbo: "Qwen Image 2.1 Turbo",
};
export type MosaicScan = { boxes: MosaicBox[]; signature: number[]; review?: string; reviewBoxes?: MosaicBox[]; modelBoxes?: MosaicBox[]; quickExcluded?: boolean; presenceScore?: number };
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

export type MosaicSettings = {
  concurrency?: number; refine?: boolean; refineModel?: string; refineGuardModel?: string; refineScope?: "all" | "suspected" | "selected"; refineConcurrency?: number; refineIncludeMissed?: boolean;
  detector: "grid" | "anime"; scope: "scenes" | "all"; model: MosaicModel; steps: number; protect: boolean;
};
export const defaultMosaicSettings: MosaicSettings = { detector: "anime", concurrency: 2, refine: true, refineModel: "qwen3.5:latest", refineGuardModel: "qwen3-vl:8b-instruct", refineScope: "selected", refineConcurrency: 1, refineIncludeMissed: false, scope: "scenes", model: "turbo", steps: 8, protect: true };
const detectorFiles = new Map<string, File>();
export function clearGameDetectorFile(root: string) { detectorFiles.delete(root); }
export function gameDetectorFile(root: string, file?: File) {
  if (file) detectorFiles.set(root, file);
  return detectorFiles.get(root);
}
export function normalizeMosaicSettings(value?: Partial<Omit<MosaicSettings, "detector">> & { detector?: string }): MosaicSettings {
  const legacy = value?.detector === "lada" || value?.detector === "lada-accurate";
  return { ...defaultMosaicSettings, ...value, detector: value?.detector === "grid" ? "grid" : "anime",
    concurrency: legacy ? 2 : value?.concurrency ?? 2,
    refineScope: "selected" };
}
export function readMosaicSettings(root: string): MosaicSettings {
  const saved = localStorage.getItem("llmchat-mosaic-settings:" + root);
  return normalizeMosaicSettings(saved ? JSON.parse(saved) : undefined);
}
export function saveMosaicSettings(root: string, settings: MosaicSettings) {
  localStorage.setItem("llmchat-mosaic-settings:" + root, JSON.stringify(normalizeMosaicSettings(settings)));
  window.dispatchEvent(new CustomEvent("game-mosaic-settings", { detail: root }));
}
export async function openDeploymentDetector(root: string, settings: MosaicSettings, signal: AbortSignal, timingScope?: string) {
  if (settings.detector === "grid") return { scan: scanMosaic, release: async () => {} };
  return loadMosaicDetector(gameDetectorFile(root), { signal, timingScope });
}

const threshold = 0.25;
export const mosaicPresenceThreshold = 0.47;
function overlap(a: MosaicBox, b: MosaicBox) {
  const area = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return area / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - area);
}

// Detection runs on RGB, so validate predictions against the original alpha channel.
export function mosaicVisibleBox(image: ImageData, box: MosaicBox) {
  const [left, top, right, bottom] = box;
  const area = (right - left) * (bottom - top);
  let visible = 0, minX = right, minY = bottom, maxX = left, maxY = top;
  const minimum = [255, 255, 255], maximum = [0, 0, 0];
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset + 3] < 64) continue;
      visible++;
      minX = Math.min(minX,x); minY = Math.min(minY,y); maxX = Math.max(maxX,x+1); maxY = Math.max(maxY,y+1);
      for (let channel = 0; channel < 3; channel++) {
        const value = image.data[offset + channel];
        minimum[channel] = Math.min(minimum[channel], value);
        maximum[channel] = Math.max(maximum[channel], value);
      }
    }
  }
  // Thin sprites can occupy little of their tight box. Reject boxes that extend far beyond their visible content.
  return visible > 0 && (maxX-minX)*(maxY-minY) >= area / 2 && maximum.some((value, channel) => value - minimum[channel] >= 12);
}

export function mosaicBoxes(values: Float32Array, dims: readonly number[], classes: number,
  geometry: { left: number; top: number; scaleX: number; scaleY: number; width: number; height: number }, validBox: (box: MosaicBox, score: number) => boolean = () => true, minimumScore = threshold) {
  if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== 4 + classes + 32 || dims[2] <= 0)
    throw new Error("检测模型需使用原始 YOLO11 分割输出（关闭 NMS 导出）");
  const { left, top, scaleX, scaleY, width, height } = geometry;
  const count = dims[2];
  const candidates: { box: MosaicBox; score: number }[] = [];
  for (let index = 0; index < count; index++) {
    let score = 0;
    for (let c = 0; c < classes; c++) score = Math.max(score, values[(4 + c) * count + index]);
    if (score < minimumScore) continue;
    const x = values[index], y = values[count + index], w = values[count * 2 + index], h = values[count * 3 + index];
    const box: MosaicBox = [
      Math.max(0, Math.floor((x - w / 2 - left) / scaleX)), Math.max(0, Math.floor((y - h / 2 - top) / scaleY)),
      Math.min(width, Math.ceil((x + w / 2 - left) / scaleX)), Math.min(height, Math.ceil((y + h / 2 - top) / scaleY)),
    ];
    if (box[2] > box[0] && box[3] > box[1]) candidates.push({ box, score });
  }
  const boxes: MosaicBox[] = [];
  for (const { box, score } of candidates.sort((a, b) => b.score - a.score)) {
    if (!boxes.some(previous => overlap(previous, box) > 0.45) && validBox(box, score)) boxes.push(box);
  }
  return boxes;
}

export type MosaicDevice = { kind: "gpu" | "cpu"; reason?: string };

export async function loadMosaicDetector(model: File | undefined, options: {
  signal?: AbortSignal; onDevice?: (device: MosaicDevice) => void; timingScope?: string;
} = {}) {
  const ort = await import("onnxruntime-web/webgpu");
  const assets = runtimeAssetBase();
  ort.env.wasm.wasmPaths = {
    mjs: new URL("./manga-ort/ort-wasm-simd-threaded.asyncify.mjs", assets).href,
    wasm: new URL("./manga-ort/ort-wasm-simd-threaded.asyncify.wasm", assets).href,
  };
  ort.env.wasm.numThreads = 1;
  const { signal, onDevice, timingScope } = options;
  const readModel = async (name: string) => {
    const response=await fetch(new URL("./mosaic-detector/"+name,assets),{signal});
    if(!response.ok)throw new Error("检测模型资源读取失败："+name);
    return response.arrayBuffer();
  };
  const [bytes,presenceBytes]=await Promise.all([model?model.arrayBuffer():readModel("model.onnx"),readModel("presence.onnx")]);
  const create = (provider: "webgpu" | "wasm") => ort.InferenceSession.create(bytes, { executionProviders: [provider] });
  const createPresence = (provider: "webgpu" | "wasm") => ort.InferenceSession.create(presenceBytes, { executionProviders: [provider] });
  let session: Awaited<ReturnType<typeof create>> | undefined;
  let presenceSession: Awaited<ReturnType<typeof createPresence>> | undefined;
  let device: MosaicDevice = { kind: "gpu" };

  const release = async () => {
    const former = session,formerPresence=presenceSession;
    session = undefined;presenceSession=undefined;
    await former?.release();
    await formerPresence?.release();
  };
  const openCpu = async (reason: string) => {
    signal?.throwIfAborted();
    const cpu = await create("wasm");
    try { presenceSession=await createPresence("wasm"); }
    catch(cause){await cpu.release();throw cause;}
    device = { kind: "cpu", reason };
    return cpu;
  };

  signal?.throwIfAborted();
  const gpu = (globalThis.navigator as (Navigator & { gpu?: unknown }) | undefined)?.gpu;
  if (gpu) {
    try {
      session = await create("webgpu");
      presenceSession=await createPresence("webgpu");
    } catch (cause) {
      await release();
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
    throw new Error("请选择固定方形输入、未内置 NMS 的 YOLO11 分割 ONNX");
  }
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) { await release(); throw new Error("无法读取检测模型输入像素"); }
  onDevice?.(device);
  const outputName = output.name;
  const runSession = (active: NonNullable<typeof session>, feeds: InstanceType<typeof ort.Tensor>, output: string) =>
    measureGameAsync(timingScope, "detectorMs", () => active.run({ [active.inputNames[0]]: feeds }, [output]));
  const runInference = async (feeds: InstanceType<typeof ort.Tensor>) => {
    signal?.throwIfAborted();
    if (!session) throw new Error("检测会话已关闭");
    try {
      return await runSession(session, feeds, outputName);
    } catch (cause) {
      if (device.kind === "cpu") throw cause;
      signal?.throwIfAborted();
      await release();
      session = await openCpu("WebGPU 推理失败：" + (cause instanceof Error ? cause.message : String(cause)));
      signal?.throwIfAborted();
      onDevice?.(device);
      return runSession(session, feeds, outputName);
    }
  };
  let inferenceQueue: Promise<unknown> = Promise.resolve();
  const infer = (feeds: InstanceType<typeof ort.Tensor>) => {
    const pending = inferenceQueue.then(() => runInference(feeds));
    inferenceQueue = pending.catch(() => {});
    return pending;
  };
  const runPresence=async(feeds:InstanceType<typeof ort.Tensor>)=>{
    signal?.throwIfAborted();
    if(!presenceSession)throw new Error("分类检测会话已关闭");
    try {return await runSession(presenceSession, feeds, presenceSession.outputNames[0]);}
    catch(cause){
      if(device.kind==="cpu")throw cause;
      signal?.throwIfAborted();await release();
      session=await openCpu("WebGPU 分类推理失败："+String(cause));
      signal?.throwIfAborted();onDevice?.(device);
      return runSession(presenceSession!, feeds, presenceSession!.outputNames[0]);
    }
  };
  const classify=async(original:HTMLCanvasElement)=>{
    const canvas=document.createElement("canvas");canvas.width=384;canvas.height=384;
    const ctx=canvas.getContext("2d",{willReadFrequently:true});
    if(!ctx)throw new Error("无法读取分类模型输入");
    ctx.fillStyle="#ffffff";ctx.fillRect(0,0,384,384);ctx.drawImage(original,0,0,384,384);
    const pixels=ctx.getImageData(0,0,384,384).data,plane=384*384,values=new Float32Array(plane*3);
    for(let i=0;i<plane;i++){
      values[i]=(pixels[i*4]/255-.5)*2;values[i+plane]=(pixels[i*4+1]/255-.5)*2;values[i+plane*2]=(pixels[i*4+2]/255-.5)*2;
    }
    const feeds=new ort.Tensor("float32",values,[1,3,384,384]);
    let tensors:Awaited<ReturnType<typeof runPresence>>|undefined;
    try {
      const pending=inferenceQueue.then(()=>runPresence(feeds));inferenceQueue=pending.catch(()=>{});
      tensors=await pending;
      const result=Object.values(tensors)[0].data;
      if(!(result instanceof Float32Array)||result.length!==4||!Number.isFinite(result[0]))throw new Error("分类模型输出格式无效");
      return result[0];
    }finally{feeds.dispose();for(const tensor of Object.values(tensors||{}))tensor.dispose();}
  };
  const scanImage = async (blob: Blob): Promise<MosaicScan> => {
    const source = await createImageBitmap(blob);
    const original = document.createElement("canvas");
    original.width = source.width; original.height = source.height;
    const originalContext = original.getContext("2d", { willReadFrequently: true });
    if (!originalContext) { source.close(); throw new Error("无法读取图片像素"); }
    let full: ImageData;
    try {
      originalContext.drawImage(source, 0, 0);
      full = originalContext.getImageData(0, 0, original.width, original.height);
    } finally { source.close(); }
    const signature = sceneSignature(full.data, full.width, full.height);
    let hasVisiblePixel=false,varied=false;
    const minimum=[255,255,255],maximum=[0,0,0];
    for(let i=0;i<full.data.length;i+=4){
      if(full.data[i+3]<64)continue;
      hasVisiblePixel=true;
      for(let channel=0;channel<3;channel++){
        minimum[channel]=Math.min(minimum[channel],full.data[i+channel]);
        maximum[channel]=Math.max(maximum[channel],full.data[i+channel]);
      }
      if(maximum.some((value,channel)=>value-minimum[channel]>=1)){varied=true;break;}
    }
    if(!hasVisiblePixel || !varied)return {signature,boxes:[]};
    const scale = Math.min(size / full.width, size / full.height);
    const width = Math.max(1, Math.round(scale * full.width)), height = Math.max(1, Math.round(scale * full.height));
    const left = Math.floor((size - width) / 2), top = Math.floor((size - height) / 2);
    context.fillStyle = "#727272";
    context.fillRect(0, 0, size, size);
    context.drawImage(original, left, top, width, height);
    const { data } = context.getImageData(0, 0, size, size);
    const plane = size * size;
    const values = new Float32Array(3 * plane);
    for (let index = 0; index < plane; index++) {
      values[index] = data[4 * index] / 255;
      values[index + plane] = data[4 * index + 1] / 255;
      values[index + 2 * plane] = data[4 * index + 2] / 255;
    }
    const presenceScore=await classify(original);
    const feeds = new ort.Tensor("float32", values, [1, 3, size, size]);
    let tensors: Awaited<ReturnType<typeof infer>> | undefined;
    try {
      tensors = await infer(feeds);
      const result = tensors[outputName];
      const data = result.data;
      if (!(data instanceof Float32Array)) throw new Error("请选择输出为 FP32 的检测 ONNX");
      const geometry = { left, top, scaleX: width / full.width, scaleY: height / full.height, width: full.width, height: full.height };
      const boxes: MosaicBox[] = [];
      const candidates = mosaicBoxes(data, result.dims, channels - 36, geometry, (box, score) => {
        if (!mosaicVisibleBox(full, box)) return false;
        if (score >= threshold) boxes.push(box);
        return true;
      }, 0.05);
      // Grid-only evidence remains unselected until the independent review confirms it.
      const grid = scanMosaicPixels(full.data, full.width, full.height, signature).boxes;
      const reviewBoxes = [...candidates];
      for (const box of grid)
        if (!reviewBoxes.some(previous => overlap(previous, box) > 0.2)) reviewBoxes.push(box);
      return { signature, boxes, modelBoxes: candidates, reviewBoxes, presenceScore,
        review: boxes.length && presenceScore<mosaicPresenceThreshold ? "图片分类与区域定位模型存在分歧，请复核"
          : !boxes.length && (reviewBoxes.length || presenceScore>=mosaicPresenceThreshold)
            ? reviewBoxes.length ? "候选区域需要视觉模型复筛确认" : "图片分类提示疑似遮挡，定位模型尚未给出区域"
            : undefined };
    } finally {
      feeds.dispose();
      for (const value of Object.values(tensors || {})) value.dispose();
    }
  };
  const cache = new Map<string, Promise<MosaicScan>>();
  let reused = 0;
  return {
    release: async () => { cache.clear(); await release(); },
    get reused() { return reused; },
    scan: async (blob: Blob): Promise<MosaicScan> => {
      signal?.throwIfAborted();
      const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      signal?.throwIfAborted();
      const key = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2,"0")).join("");
      const existing = cache.get(key);
      if (existing) {
        const result = await existing;
        reused++;
        recordGameCacheHit(timingScope);
        return result;
      }
      const pending = scanImage(blob).catch(cause => { cache.delete(key); throw cause; });
      cache.set(key, pending);
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
      return pending;
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
  signal: AbortSignal; progress: (detail: string) => void; keepResultOnStop?: boolean; benchmark?: boolean; timingScope?: string;
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
  const result = await invoke<{ image: string; workflowMs?: number }>("run_style_redraw", {
    directory, steps: input.steps, mode: "mosaic", image, progress,
    regions: input.boxes.map(box => ({ box })),
    profile: { ...weights, kind: input.model, referenceImage, keep: input.keep, seed: input.seed, benchmark: input.benchmark },
  });
  recordGameWorkflowTiming(input.timingScope, result.workflowMs);
  if (!input.keepResultOnStop) input.signal.throwIfAborted();
  return new Blob([Uint8Array.from(atob(result.image), char => char.charCodeAt(0))], { type: "image/png" });
}
