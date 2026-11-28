import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { UnityImage, UnityImageRegion, UnityProgress } from "./unityOffline";
import type { OllamaOutput } from "./gameOllama";
import { recordGameCacheHit, recordGameWorkflowTiming } from "./gameModelPerformance";
import { gameImageDigest, readImageCheckpoint, saveImageCheckpoint } from "./gameImageCheckpoints";
import type { PaddleOcrLine } from "./ocr/paddleOcr";
import { UnityImageLayoutError } from "./unityImages";

type Box = [number, number, number, number];
export type StyleRedrawProfileId = "2511" | "turbo" | "custom";
type StyleRedrawProfile = { model: string; clip: string; vae: string; graph?: string; output?: string };
export const styleRedrawProfilesKey = "llmchat-redraw-profiles";
export const styleRedrawDirectoryKey = "llmchat-comfy-directory";
export const styleRedrawLabels: Record<StyleRedrawProfileId, string> = {
  "2511": "Qwen Image Edit 2511", turbo: "Qwen Image 2.1 Turbo · INT8 ConvRot", custom: "自定义 API 工作流",
};
export function loadStyleRedrawProfiles(): Record<StyleRedrawProfileId, StyleRedrawProfile> {
  const defaults = {
    "2511": { model: "qwen-image-edit-2511-Q4_K_M.gguf", clip: "qwen_2.5_vl_7b_fp8_scaled.safetensors", vae: "qwen_image_vae.safetensors" },
    turbo: { model: "qwen_image_2.1_turbo_int8_convrot.safetensors", clip: "qwen3vl_8b_int8_convrot.safetensors", vae: "qwen_image_2.1_vae_bf16.safetensors" },
    custom: { model: "", clip: "", vae: "", graph: "", output: "" },
  };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(styleRedrawProfilesKey) || "{}") }; }
  catch { return defaults; }
}
export type { StyleRedrawProfile };
export type GameImagePlacement = { assetName?: string; cleanBase?: () => Promise<Blob> };
type OcrSheet = { kind?: "lettering" | "annotated"; image?: string; contextImage?: string; regions: { box: Box; angle: number; tile?: Box }[] };
let detectedDirectory: Promise<string> | undefined;
let programQueue: Promise<unknown> = Promise.resolve();

export function defaultGameImageVision(models: string[]) {
  return models.find(model => model === "qwen3-vl:8b-instruct");
}

export function isGameLogoName(name = "") {
  return /logo|title|wordmark/i.test(name);
}

export function gameImageVisionForAsset(standard: string, name: string, models: string[]) {
  return isGameLogoName(name) && standard === "qwen3-vl:8b-instruct" && models.includes("qwen3-vl:4b-instruct")
    ? "qwen3-vl:4b-instruct" : standard;
}

export function createGameImageOcrReuse(timingScope?: string) {
  const records = new Map<string, Promise<PaddleOcrLine[]>>();
  let hits = 0;
  return {
    get hits() { return hits; },
    async read(blob: Blob, model: string, placement: GameImagePlacement, signal: AbortSignal, recognize: () => Promise<PaddleOcrLine[]>) {
      if (placement.cleanBase || !globalThis.crypto?.subtle) return recognize();
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
      signal.throwIfAborted();
      const key = model + ":" + isGameLogoName(placement.assetName) + ":" +
        Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
      const existing = records.get(key);
      if (existing) {
        const result = await existing;
        hits++;
        recordGameCacheHit(timingScope);
        return result.map(region => ({ ...region }));
      }
      const pending = recognize().catch(error => { records.delete(key); throw error; });
      records.set(key, pending);
      return (await pending).map(region => ({ ...region }));
    },
  };
}

export function defaultGameImageTranslation(models: string[]) {
  return models.find(model => /hy-mt2-7b.*q8_0/i.test(model));
}

export function defaultGameImageReview(models: string[]) {
  return models.find(model => /^qwen3\.5:(?:latest|9b(?:-q4_k_m)?)$/i.test(model));
}

export function gameImageCleanBase(image: UnityImage, images: UnityImage[], read: (source: UnityImage) => Promise<Blob>) {
  const path = image.file.toLowerCase();
  const stem = path.replace(/\.[^.\\/]+$/, "");
  const paired = stem.replace(/[_-](?:b|annotated|text)$/i, "");
  const names = [paired !== stem ? paired : "", stem + "_clean", stem + "_notext", stem + "-no-text"].filter(Boolean);
  const alternative = images.find(item => item.id !== image.id && item.sourceFile &&
    item.width === image.width && item.height === image.height && item.container === image.container &&
    names.includes(item.file.toLowerCase().replace(/\.[^.\\/]+$/, "")));
  return alternative ? () => read(alternative) : undefined;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("无法读取图片数据"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}
async function toBase64(blob: Blob) {
  return (await dataUrl(blob)).split(",", 2)[1];
}

function redrawProgramDirectory() {
  return localStorage.getItem(styleRedrawDirectoryKey) || (detectedDirectory ??=
    invoke<string[]>("find_redraw_directories").then(paths => paths[0] || "").catch(() => ""));
}

async function runProgram<T>(blob: Blob, mode: "layout" | "ocr-prepare" | "model", profile: object,
  regions: { box: Box; text?: string; translation: string }[], signal: AbortSignal, report?: OllamaOutput, steps = 1,
  directory?: string): Promise<T | undefined> {
  if (!isTauri()) return undefined;
  const programDirectory = directory ?? await redrawProgramDirectory();
  if (!programDirectory) return undefined;
  const image = await toBase64(blob);
  const task = programQueue.then(async () => {
    signal.throwIfAborted();
    const progress = new Channel<string>();
    progress.onmessage = message => { if (!signal.aborted) report?.(message, "info"); };
    const result = await invoke<T>("run_style_redraw", { directory: programDirectory, image, steps, regions, mode, profile, progress });
    if (mode !== "model") signal.throwIfAborted();
    return result;
  });
  programQueue = task.catch(() => {});
  return task;
}

export function gameImageRedrawSelected(image: UnityImage) {
  return image.ocrCompleted && image.screening?.state === "candidate" && !image.screening.sourceSkip &&
    !image.noTranslationNeeded && !!image.screening.redrawSelected;
}

export function gameImageRedrawScreening(image: UnityImage) {
  return image.screening ?? { version: 1 as const, sourceHash: image.sourceHash, source: "", target: "",
    state: "candidate" as const, reason: "正式识别完成", boxes: image.regions.length };
}

export function savedGameImageRedraw(image: UnityImage, hash: string) {
  return { ...gameImageRedrawScreening(image), redrawResultHash: hash, redrawSelected: false, redrawError: undefined };
}

export function gameImageRedrawStatus(image: UnityImage, runningId?: string) {
  if (image.id === runningId) return "重绘中";
  if (image.screening?.redrawError || image.error?.startsWith("AI 风格重绘失败：")) return "失败";
  if (gameImageRedrawSelected(image)) return "待重绘";
  if (image.renderedFile && image.renderedHash && image.renderedHash === image.screening?.redrawResultHash) return "已完成";
}

export function gameImageRedrawSummary(progress: Partial<Pick<UnityProgress, "completed" | "total" | "redrawFailed">> | null, errored: boolean) {
  if (!progress?.total || progress.completed === undefined || progress.redrawFailed === undefined) return;
  const { total, redrawFailed: failed } = progress;
  const succeeded = progress.completed - failed;
  return {
    count: `已完成 ${succeeded} / ${total} 张${failed ? ` · 失败 ${failed} 张` : ""}`,
    percent: Math.floor(succeeded / total * 100),
    label: errored && failed > 0 && succeeded > 0 ? "部分失败" : undefined,
  };
}

export async function redrawGameImages(images: UnityImage[], profileId: StyleRedrawProfileId, target: string,
  signal: AbortSignal, io: {
    onStart?: (id: string) => void;
    timingScope?: string;
    regions: (image: UnityImage) => UnityImageRegion[];
    read: (image: UnityImage) => Promise<Blob>;
    write: (image: UnityImage, blob: Blob) => Promise<{ path: string; hash: string }>;
    persist: (image: UnityImage) => Promise<void>;
  }, progress: (value: UnityProgress) => void, report: OllamaOutput) {
  const queue = images.filter(gameImageRedrawSelected);
  let failed = 0;
  const update = (completed: number, detail: string) => progress({ completed, total: queue.length, detail, redrawFailed: failed });
  update(0, "正在准备重绘");
  const profile = loadStyleRedrawProfiles()[profileId];
  if (profileId === "custom" && !profile.graph) throw new Error("请先在 AI 风格重绘中配置自定义 API 工作流");
  const steps = profileId === "turbo" ? 8 : 20;
  for (const [index, image] of queue.entries()) {
    signal.throwIfAborted();
    io.onStart?.(image.id);
    update(index, image.name);
    let saved: { path: string; hash: string };
    try {
      const regions = io.regions(image).filter(region => region.selected && !region.error && region.translation.trim() &&
        (!region.translationTarget || region.translationTarget === target)).map(region => ({
        box: [Math.max(0, Math.round(region.x0)), Math.max(0, Math.round(region.y0)),
          Math.min(image.width, Math.round(region.x1)), Math.min(image.height, Math.round(region.y1))] as Box,
        translation: region.translation.trim(),
      }));
      if (!regions.length) throw new Error("没有可用的已翻译文字区域");
      if (regions.some(({ box }) => box[0] >= box[2] || box[1] >= box[3])) throw new Error("请检查重绘文字区域的范围");
      const directory = isTauri() && await redrawProgramDirectory();
      if (!directory) throw new Error("请先在 AI 风格重绘中设置 ComfyUI 目录");
      const input = await io.read(image);
      const digest = await gameImageDigest(await input.arrayBuffer());
      // Identical built-in tasks must submit the same seed as well as the same input.
      const key = await gameImageDigest(new TextEncoder().encode(JSON.stringify([
        "style-redraw-v1", directory, profileId, profile, steps, target, digest, regions,
      ])));
      let blob = await readImageCheckpoint("redraw", key);
      signal.throwIfAborted();
      if (blob) {
        recordGameCacheHit(io.timingScope);
        report(image.name + " · 已复用相同输入和配置的重绘结果", "info");
      } else {
        const seed = Number.parseInt(key.slice(0, 12), 16);
        const result = await runProgram<{ image: string; workflowMs?: number }>(input, "model", { ...profile, kind: profileId, seed }, regions,
          signal, (message, level) => report(image.name + " · " + message, level), steps, directory);
        if (!result) throw new Error("请先在 AI 风格重绘中设置 ComfyUI 目录");
        recordGameWorkflowTiming(io.timingScope, result.workflowMs);
        const bytes = Uint8Array.from(atob(result.image), char => char.charCodeAt(0));
        blob = new Blob([bytes], { type: "image/png" });
        const bitmap = await createImageBitmap(blob);
        try {
          if (bitmap.width !== image.width || bitmap.height !== image.height) throw new Error("重绘译图与原图尺寸不一致");
        } finally { bitmap.close(); }
        await saveImageCheckpoint("redraw", key, blob);
      }
      signal.throwIfAborted();
      saved = await io.write(image, blob);
    } catch (error) {
      signal.throwIfAborted();
      const reason = error instanceof Error ? error.message : String(error);
      await io.persist({ ...image, screening: { ...image.screening!, redrawError: reason } });
      report(image.name + " · " + reason, "error");
      failed++;
      update(index + 1, image.name);
      continue;
    }
    await io.persist({ ...image, renderedFile: saved.path, renderedHash: saved.hash, renderedKind: "generated",
      renderedTarget: target, noTranslationNeeded: false, completed: true, error: "",
      screening: savedGameImageRedraw(image, saved.hash) });
    update(index + 1, image.name);
  }
  return { total: queue.length, failed };
}

export async function prepareGameOcrSheet(blob: Blob, placement: GameImagePlacement, signal: AbortSignal) {
  const clean = await placement.cleanBase?.();
  return runProgram<OcrSheet>(blob, "ocr-prepare",
    { assetName: placement.assetName, cleanImage: clean && await toBase64(clean) }, [], signal);
}

export async function gameOcrMissingTile(sheet: OcrSheet, index: number) {
  const tile = sheet.regions[index]?.tile;
  if (!sheet.image || !tile) return;
  const bytes = Uint8Array.from(atob(sheet.image), char => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  try {
    const [x, y, right, bottom] = tile;
    const width = right - x, height = bottom - y;
    const zoom = Math.min(2, 640 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * zoom);
    canvas.height = Math.ceil(height * zoom);
    canvas.getContext("2d")!.drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally { bitmap.close(); }
}

export async function renderPlacedGameImage(blob: Blob, regions: UnityImageRegion[], placement: GameImagePlacement,
  signal: AbortSignal, report?: OllamaOutput) {
  const box = (region: UnityImageRegion): Box => [Math.floor(region.x0), Math.floor(region.y0), Math.ceil(region.x1), Math.ceil(region.y1)];
  const logo = isGameLogoName(placement.assetName);
  const protect = (region: UnityImageRegion) => logo && /^(?:[&＆+]|[A-Z]{1,5})$/.test(region.text.trim()) &&
    (!region.selected || region.translation.trim() === region.text.trim());
  const selected = regions.flatMap((region, index) => region.selected && !protect(region) ? [{
    index, box: box(region), text: region.text, translation: region.translation,
  }] : []);
  if (!selected.length) return blob;
  const clean = await placement.cleanBase?.();
  signal.throwIfAborted();
  const protectedRegions=regions.filter(protect);
  let result: { image: string } | undefined;
  try {
    result = await runProgram<{ image: string }>(blob, "layout",
      { assetName: placement.assetName, cleanImage: clean && await toBase64(clean), protectBoxes: protectedRegions.map(box),
        protectSymbols: protectedRegions.filter(region=>/^[&＆+]$/.test(region.text.trim())).map(box),
        occupiedBoxes: logo ? undefined : regions.filter(region=>region.text.trim()).map(box) },
      selected, signal, report);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failed = /区域 (\d+)：(.*可读字号.*)/.exec(detail);
    const region = failed && selected[Number(failed[1]) - 1];
    if (region) throw new UnityImageLayoutError([{ index: region.index, message: failed[2] }]);
    throw error;
  }
  if (!result) return undefined;
  const bytes = Uint8Array.from(atob(result.image), char => char.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}
