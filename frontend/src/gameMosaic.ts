import { scanMosaicPixels } from "./gameMosaicGrid";
import { validateMosaicLocalModels } from "./gameMosaicCandidateInputs";
import { openMosaicDetectorPool } from "./gameMosaicDetectorPool";
import { defaultMosaicScreening, mosaicScreenZoomPolicy, normalizeMosaicScreening, usesMosaicPresenceProbes, type MosaicScreening } from "./gameMosaicScreening";
export { scanMosaicPixels } from "./gameMosaicGrid";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { runtimeAssetBase } from "./runtimeAssets";
import { recordGameWorkflowTiming } from "./gameModelPerformance";
import type { UnityImage } from "./unityOffline";
import type { MosaicTargetPart } from "./mosaicRegionTargets";

export type MosaicBox = [left: number, top: number, right: number, bottom: number];
export type MosaicModel = "2511" | "2511-lightning" | "turbo" | "diffusion-cream";
export const mosaicModelLabels: Record<MosaicModel, string> = {
  "2511": "Qwen Image Edit 2511", "2511-lightning": "Qwen Image Edit 2511 · Lightning 4 步",
  turbo: "Qwen Image 2.1 Turbo", "diffusion-cream": "DiffusionCreamPy · 动漫局部修复",
};
export const mosaicModelChoices = (["turbo", "2511-lightning", "2511", "diffusion-cream"] as const).map(value => ({ value, label: mosaicModelLabels[value] }));
export const mosaicDefaultSteps: Record<MosaicModel, number> = { turbo: 8, "2511": 20, "2511-lightning": 4, "diffusion-cream": 28 };
export const isMosaicModel = (value: unknown): value is MosaicModel =>
  mosaicModelChoices.some(choice => choice.value === value);
export type MosaicScan = { boxes: MosaicBox[]; signature: number[]; review?: string; reviewBoxes?: MosaicBox[]; modelBoxes?: MosaicBox[]; quickExcluded?: boolean; presenceScore?: number; presenceThreshold?: number; localClear?: boolean };
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
  screening?: Partial<MosaicScreening>;
  concurrency?: number; refine?: boolean; refineModel?: string; refineGuardModel?: string; refineScope?: "all" | "suspected" | "selected"; refineConcurrency?: number; refineIncludeMissed?: boolean;
  detector: "grid" | "anime"; scope: "scenes" | "all"; model: MosaicModel; steps: number; protect: boolean; regionTargeting?: boolean;
};
export const defaultMosaicSettings: MosaicSettings = { detector: "anime", screening: { ...defaultMosaicScreening }, concurrency: 2, refine: true, refineModel: "qwen3.5:latest", refineGuardModel: "qwen3-vl:8b-instruct", refineScope: "selected", refineConcurrency: 1, refineIncludeMissed: false, scope: "scenes", model: "turbo", steps: 8, protect: true };
export const mosaicRefineConcurrencyChoices = [1, 2, 4];

export function mosaicRefineConcurrency(value?: number) {
  return value !== undefined && mosaicRefineConcurrencyChoices.includes(value) ? value : 1;
}

const detectorFiles = new Map<string, File>();
export function clearGameDetectorFile(root: string) { detectorFiles.delete(root); }
export function gameDetectorFile(root: string, file?: File) {
  if (file) detectorFiles.set(root, file);
  return detectorFiles.get(root);
}
export function normalizeMosaicSettings(value?: Partial<Omit<MosaicSettings, "detector">> & { detector?: string }): MosaicSettings {
  const legacy = value?.detector === "lada" || value?.detector === "lada-accurate";
  const model = isMosaicModel(value?.model) ? value.model : defaultMosaicSettings.model;
  return { ...defaultMosaicSettings, ...value, model, steps: model === "2511-lightning" ? 4 : value?.steps ?? mosaicDefaultSteps[model],
    detector: value?.detector === "grid" ? "grid" : "anime",
    screening: normalizeMosaicScreening(value?.screening),
    concurrency: legacy ? 2 : value?.concurrency ?? 2,
    refineConcurrency: mosaicRefineConcurrency(value?.refineConcurrency),
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
export function mosaicDetectorKey(kind: MosaicSettings["detector"], file?: File, options?: Partial<MosaicScreening>) {
  if (kind === "grid") return "grid-v2";
  const { modelConcurrency: _parallelism, ...screening } = normalizeMosaicScreening(options);
  if (!screening.localModels && !screening.localZoom && screening.presenceThreshold === 0.47 && screening.boxThreshold === 0.25)
    return file ? JSON.stringify(["custom-yolo-presence-v2", file.name, file.size, file.lastModified]) : "anime-2d-presence-v2";
  const model = file ? [file.name, file.size, file.lastModified] : "anime-640";
  return JSON.stringify([usesMosaicPresenceProbes(screening) ? mosaicScreenZoomPolicy : "mosaic-screen-v3", model, screening]);
}

export function matchesMosaicDetectorKey(recorded: string | undefined, current: string) {
  if (recorded === current) return true;
  if (current === "grid-v2") return recorded === undefined || recorded === "grid";
  if (current === "anime-2d-presence-v2") return recorded === "anime-2d-presence-v1";
  return current.startsWith('["custom-yolo-presence-v2",') &&
    recorded === current.replace('"custom-yolo-presence-v2"', '"custom-yolo-presence-v1"');
}

export async function openDeploymentDetector(root: string, settings: MosaicSettings, signal: AbortSignal, timingScope?: string) {
  if (settings.detector === "grid") return { scan: scanMosaic, release: async () => {} };
  return loadMosaicDetector(gameDetectorFile(root), { signal, timingScope, initialScreening: true, screening: settings.screening, maxConcurrency: settings.concurrency ?? 2 });
}

export type MosaicDevice = { kind: "gpu" | "cpu"; reason?: string };
export { mosaicVisibleBox, mosaicBoxes, mosaicPresenceThreshold } from "./mosaicDetectorRuntime";

export async function loadMosaicDetector(model: File | undefined, options: {
  signal?: AbortSignal; onDevice?: (device: MosaicDevice) => void; timingScope?: string; initialScreening?: boolean;
  screening?: Partial<MosaicScreening>; maxConcurrency?: number;
} = {}) {
  const { signal } = options;
  const screening = normalizeMosaicScreening(options.screening);
  const localModels = options.initialScreening ? screening.localModels : undefined;
  validateMosaicLocalModels(localModels);
  if (localModels?.mrcnn && model) throw new Error("Mask R-CNN 与自定义 YOLO 定位模型不能同时使用");
  const localBytes = async (path: string) => {
    signal?.throwIfAborted();
    const bytes = await (await import("./localDocFile")).readFileBytes(path);
    signal?.throwIfAborted();
    return bytes;
  };
  const assets = runtimeAssetBase();
  const readModel = async (name: string) => {
    const response = await fetch(new URL("./mosaic-detector/" + name, assets), { signal });
    if (!response.ok) throw new Error("检测模型资源读取失败：" + name);
    return response.arrayBuffer();
  };
  const [bytes, presenceBytes, labelsBytes] = await Promise.all([
    localModels?.mrcnn ? localBytes(localModels.mrcnn.modelPath) : model ? model.arrayBuffer() : readModel("model.onnx"),
    localModels?.eva ? localBytes(localModels.eva.modelPath) : readModel("presence.onnx"),
    localModels?.eva ? localBytes(localModels.eva.labelsPath) : undefined,
  ]);
  signal?.throwIfAborted();
  return openMosaicDetectorPool({ bytes, presenceBytes, labelsBytes, screening, initialScreening: options.initialScreening,
    wasmPaths: { mjs: new URL("./manga-ort/ort-wasm-simd-threaded.asyncify.mjs", assets).href,
      wasm: new URL("./manga-ort/ort-wasm-simd-threaded.asyncify.wasm", assets).href } }, {
    ...options, concurrency: Math.min(screening.modelConcurrency ?? 1, options.maxConcurrency ?? 4),
  });
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
  return JSON.stringify(["mosaic-regions-v2", width, height, Array.from(new Uint8Array(hash)), boxes]);
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
type MosaicRedrawInput = {
  source: Blob; boxes: MosaicBox[]; reference?: Blob; keep: MosaicBox[]; model: MosaicModel; steps: number; seed: number;
  targetParts?: MosaicTargetPart[];
};
export type MosaicComfyWorkflow = { id: string; name: string; path: string; graph: Record<string, unknown> };
export const openMosaicComfyWorkflowEvent = "llmchat-open-mosaic-comfy-workflow";

export async function mosaicRedrawDirectory() {
  const directory = localStorage.getItem("llmchat-comfy-directory") || (await invoke<string[]>("find_redraw_directories"))[0];
  if (!directory) throw new Error("请先在 AI 风格重绘中配置 ComfyUI");
  return directory;
}

async function mosaicWeights(directory: string, model: MosaicModel) {
  if (model === "diffusion-cream") return;
  const fields = ["model", "clip", "vae"] as const;
  let saved: Partial<Weights> = {};
  try { saved = JSON.parse(localStorage.getItem("llmchat-redraw-profiles") || "{}")?.[model === "2511-lightning" ? "2511" : model] || {}; }
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

export async function prepareMosaicComfyWorkflow(input: MosaicRedrawInput & { name: string }): Promise<MosaicComfyWorkflow> {
  if (!isTauri()) throw new Error("移动到 ComfyUI 需要桌面端");
  const directory = await mosaicRedrawDirectory();
  const weights = await mosaicWeights(directory, input.model);
  const graph = await invoke<MosaicComfyWorkflow["graph"]>("run_style_redraw", {
    directory, steps: input.steps, mode: "mosaic-workflow", image: await encoded(input.source), progress: new Channel<string>(),
    regions: input.boxes.map(box => ({ box })),
    profile: { ...weights, kind: input.model,
      referenceImage: input.reference && await encoded(input.reference),
      keep: input.keep, seed: input.seed, name: input.name, targetParts: input.targetParts },
  });
  const name = mosaicModelLabels[input.model] + ".json";
  return { id: crypto.randomUUID(), name, path: "LLMChat - 去码/" + name, graph };
}

export async function cancelMosaicRedraw(promptId: string, model?: MosaicModel) {
  // Match the job identifier in repair_mosaic.
  const namespace = new Uint8Array([0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]);
  const workflow = model === "2511-lightning" ? "aligned-edit-lightning-regions-v2" : model === "2511" ? "aligned-edit-regions-v2"
    : model === "diffusion-cream" ? "diffusion-cream-regions-v2" : "expanded-regions-v2";
  const name = new TextEncoder().encode("urn:llmchat:mosaic:" + workflow + ":" + promptId);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  const comfyJobId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  await invoke("cancel_mosaic_redraw", { promptId, comfyJobId });
}

export async function redrawMosaic(input: MosaicRedrawInput & {
  signal: AbortSignal; progress: (detail: string) => void; keepResultOnStop?: boolean; benchmark?: boolean; timingScope?: string; promptId?: string;
}) {
  if (!isTauri()) throw new Error("图片去码需要桌面端的本地 ComfyUI");
  const directory = await mosaicRedrawDirectory();
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
    profile: { ...weights, kind: input.model, referenceImage, keep: input.keep, seed: input.seed, benchmark: input.benchmark,
      promptId: input.promptId, targetParts: input.targetParts },
  });
  recordGameWorkflowTiming(input.timingScope, result.workflowMs);
  if (!input.keepResultOnStop) input.signal.throwIfAborted();
  return new Blob([Uint8Array.from(atob(result.image), char => char.charCodeAt(0))], { type: "image/png" });
}
