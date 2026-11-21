import type { Settings } from "./api";
import { requestGameModelJson } from "./gameModelRequest";
import { measureGameAsync, recordGameCacheHit } from "./gameModelPerformance";
import { classifyImageText, createLocalImageRefiner, needsGameImageRefinement, refineGameImages, screenGameImages, type ImageScreening, type LocalRefineMode } from "./gameImageScreening";
import type { OllamaOutput } from "./gameOllama";
import type { GamePromptSelection } from "./gamePrompts";
import { applyImageTextRules, IMAGE_TEXT_RULE_VERSION, usesUnityImageTextEvidence } from "./imageTextRules";
import { LocalPaddleOcr, type PaddleOcrLine } from "./ocr/paddleOcr";
import type { UnityImage, UnityImageRegion, UnityProject } from "./unityOffline";

const screenModel = "unity-fast";
export const UNITY_IMAGE_REFINE_KEY = "unity-region-review-v1";
export type UnityImageScreeningOptions = {
  strategy: "staged" | "full"; filterModel?: string;
  refine: { method: "off" | "local" | "llm"; model?: string; mode: LocalRefineMode; concurrency: number; confidence: number };
};
export const defaultUnityImageScreening: UnityImageScreeningOptions = {
  strategy: "staged", refine: { method: "llm", mode: "precise", concurrency: 2, confidence: 70 },
};
type ImageProgress = (state: { completed: number; total: number; detail: string; etaMs?: number }) => void;
type ImageServices = {
  read: (image: UnityImage) => Promise<Blob>;
  persist: (images: UnityImage[]) => Promise<void>;
};
type ScreenOptions = { source: string; target: string; concurrency: number; timingScope?: string; strategy?: "staged" | "full"; model?: string };

export function needsUnityImageScreening(image: UnityImage, source: string, target: string, options = defaultUnityImageScreening) {
  if (!usesUnityImageTextEvidence(image) || !image.sourceFile || image.renderedFile || image.noTranslationNeeded ||
      image.screening?.manualGroup || image.regions.some(region => region.manualSelected && region.selected)) return false;
  const old = image.screening;
  return !old || old.sourceHash !== image.sourceHash || old.source !== source || old.target !== target || old.state === "failed" ||
    (old.model || screenModel) !== (options.filterModel || screenModel) || (old.strategy || "staged") !== (options.filterModel === undefined ? options.strategy : "full");
}

export function unityImageReviewCrops(image: UnityImage) {
  const area = image.width * image.height;
  return image.regions.filter(region => {
    const letters = region.text.normalize("NFKC").match(/\p{L}/gu) || [];
    const eastAsian = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(letters.join(""));
    const confidence = eastAsian ? (letters.length >= 2 ? 65 : 83) : (letters.length >= 2 ? 70 : 90);
    const width = region.x1 - region.x0, height = region.y1 - region.y0;
    return letters.length > 0 && Math.min(width, height) >= 7 && width * height <= area * .12 && region.confidence >= confidence;
  }).sort((first, second) => second.confidence - first.confidence).slice(0, 8);
}

function screenUnityResult(image: UnityImage, regions: UnityImageRegion[], options: ScreenOptions) {
  const checked = applyImageTextRules(regions, 50, image);
  const accepted = checked.some(region => region.selected);
  const needsCheck = !accepted && unityImageReviewCrops({ ...image, regions }).length > 0;
  const state: ImageScreening["state"] = accepted ? "candidate" : needsCheck ? "review" : "no-text";
  const reason = accepted ? "检测到可信的文字" : needsCheck ? "检测到疑似文字，待自动复筛" : "未发现可确认的文字迹象";
  const initial = { state, reason, boxes: regions.length };
  const recognition = image.screening?.recognition ?? (regions.length && state !== "no-text"
    ? initialEvidence(checked) : undefined);
  return { ...image, selected: accepted && (!image.selectionManual || image.selected),
    regions: checked,
    screening: { version: 1 as const, rules: IMAGE_TEXT_RULE_VERSION, strategy: options.strategy || "staged", model: options.model || screenModel,
      sourceHash: image.sourceHash, source: options.source, target: options.target, ...initial, initial,
      recognition, reviewSelected: image.screening?.reviewSelected } };
}

function initialEvidence(regions: readonly UnityImageRegion[]): NonNullable<ImageScreening["recognition"]> {
  return { profile: "unity-initial-screen", detectedBoxes: regions.length,
    lines: regions.map(({ text, confidence, x0, y0, x1, y1 }) => ({ text, confidence, x0, y0, x1, y1 })) };
}

export async function screenUnityImages(project: UnityProject, signal: AbortSignal, options: ScreenOptions,
  io: ImageServices & { recognize?: (blob: Blob) => Promise<PaddleOcrLine[]> },
  progress: ImageProgress, onDevice?: (message: string, fallback: boolean) => void) {
  const settings = { ...defaultUnityImageScreening, strategy: options.strategy || "staged", filterModel: options.model };
  const pending = (project.images || []).filter(image => needsUnityImageScreening(image, options.source, options.target, settings));
  const canReuse = (image: UnityImage) => !options.model && (image.ocrCompleted || !image.screening && image.regions.length > 0);
  const reused = pending.filter(canReuse);
  const fresh = pending.filter(image => !canReuse(image));
  let completed = 0;
  const counts = { candidate: 0, noText: 0, review: 0, failed: 0 };
  const persist = async (rows: UnityImage[]) => {
    signal.throwIfAborted();
    await io.persist(rows);
    for (const row of rows) {
      const state = row.screening?.state;
      counts[state === "candidate" || state === "review" || state === "failed" ? state : "noText"]++;
    }
    completed += rows.length;
    progress({ completed, total: pending.length, detail: "筛选图片 · " + completed + " / " + pending.length });
  };
  for (let i = 0; i < reused.length; i += 64) {
    const batch = reused.slice(i, i + 64);
    await persist(batch.map(image => screenUnityResult(image, image.regions, options)));
    for (const _image of batch) recordGameCacheHit(options.timingScope);
  }
  if (!fresh.length) return { completed, reused: reused.length, ...counts };
  const lanes = Math.max(1, Math.min(4, options.concurrency));
  const workers = options.model ? [] : Array.from({ length: lanes }, () => new LocalPaddleOcr("fast", {
    upscale: false, maxSide: 1280, boxThresh: .3, onDevice,
  }));
  try {
    await screenGameImages({ ...project, images: fresh.map(image => ({ ...image, screening: undefined, ocrCompleted: false })) }, signal,
      { ...options, model: options.model || screenModel, strategy: options.strategy || "staged", concurrency: lanes }, {
      read: io.read,
      recognize: async (image, stage, worker = 0) => {
        if (io.recognize) {
          const lines = await io.recognize(image);
          return { lines, detectedBoxes: lines.length, profile: "unity-vision-screen" };
        }
        const recognize = (maxSide: number, boxThresh: number) => measureGameAsync(options.timingScope, "ocrMs",
          () => workers[worker].recognize(image, stage, { maxSide, boxThresh }));
        if (options.strategy === "full") return recognize(1280, .3);
        const rough = await recognize(768, .5);
        signal.throwIfAborted();
        return classifyImageText(rough, options).state === "review" ? recognize(1280, .3) : rough;
      },
      persist: rows => persist(rows.map(image => {
        if (image.screening?.state === "failed") return image;
        const lines = image.screening?.recognition?.lines || [];
        const screened = screenUnityResult(image, lines.map(line => ({ ...line, translation: "", selected: true, error: "" })), options);
        if (image.screening?.state !== "not-needed") return screened;
        const initial = { state: image.screening.state, reason: image.screening.reason, boxes: image.screening.boxes };
        return { ...screened, selected: false, screening: { ...screened.screening, ...initial, initial } };
      })),
    }, state => {
      if (state.detail.includes("·")) progress({ completed, total: pending.length, detail: state.detail });
    });
    return { completed, reused: reused.length, ...counts };
  } finally { await Promise.all(workers.map(worker => worker.dispose())); }
}

export function isUnityImageReviewable(image: UnityImage) {
  if (!usesUnityImageTextEvidence(image) || image.renderedFile || image.completed || !image.sourceFile || image.screening?.manualGroup ||
      image.regions.some(region => region.selected && region.manualSelected)) return false;
  return image.screening?.state === "review" && !image.ocrCompleted &&
    (!image.screening.refineKey || image.screening.refineFailed === true);
}

export function unityImageReviewChecked(image: UnityImage) {
  if (!isUnityImageReviewable(image)) return false;
  return image.screening?.reviewSelected ?? true;
}

const localRefinementKey = (options: UnityImageScreeningOptions["refine"]) => `unity-local:${options.mode}:${options.confidence}`;

export function unityImageRefinementPending(image: UnityImage, options: UnityImageScreeningOptions["refine"]) {
  if (options.method === "off") return false;
  return options.method === "local"
    ? usesUnityImageTextEvidence(image) && !image.renderedFile && needsGameImageRefinement(image, localRefinementKey(options))
    : unityImageReviewChecked(image);
}

export async function refineUnityImagesLocally(project: UnityProject, signal: AbortSignal, scope: string,
  options: UnityImageScreeningOptions["refine"], io: ImageServices, progress: ImageProgress,
  onDevice?: (message: string, fallback: boolean) => void) {
  const images = (project.images || []).filter(image => unityImageRefinementPending(image, options));
  if (!images.length) return { completed: 0, failed: 0, candidate: 0, noText: 0, review: 0, modelRequests: 0 };
  const local = createLocalImageRefiner(options.mode, options.concurrency, scope, onDevice, signal);
  try {
    await local.prepare();
    const { completed, counts } = await refineGameImages(images, signal, {
      local: true, concurrency: options.concurrency, confidenceThreshold: options.confidence, refineKey: localRefinementKey(options), timingScope: scope,
    }, { ...io, recognize: local.recognize }, progress);
    return { completed, failed: counts.failed, candidate: counts.candidate, noText: counts["no-text"], review: counts.review, modelRequests: 0 };
  } finally { await local.dispose(); }
}

const noText = /^(?:∅|无字|无文字|没有文字|none|no text|empty)$/iu;
const cropPrompt = "Transcribe each numbered crop independently. Copy only legible printed or handwritten letters, Japanese kana and kanji, including sound effects. Ignore the index tag, art, motion scratches, patterns, highlights, icons and decorations. For each crop with no readable text, return the symbol ∅ instead of a word. Do not invent writing from context. Return one result per numbered crop, preserving the index, with confidence from 0 to 100.";
type ReviewCrops = { lines: PaddleOcrLine[]; resolved: boolean };

export function normalizeUnityReviewReading(text: string, earlier: string) {
  const copied = /^([\p{Script=Katakana}]+)[=＝]$/u.exec(text);
  const baseline = /^([\p{Script=Katakana}]+)ー$/u.exec(earlier.trim());
  if (!copied || !baseline) return text;
  const sizeIndependent = (reading: string) => reading.replace(/[ァィゥェォッャュョヮ]/gu, kana => String.fromCodePoint(kana.codePointAt(0)! + 1));
  return sizeIndependent(copied[1]) === sizeIndependent(baseline[1]) ? copied[1] + "ー" : text;
}

export async function recognizeUnityReviewCrops(settings: Settings, model: string, image: Blob, regions: UnityImageRegion[],
  signal: AbortSignal, selection?: GamePromptSelection, report?: OllamaOutput, threshold = 70): Promise<ReviewCrops> {
  if (!regions.length) return { lines: [], resolved: true };
  const bitmap = await createImageBitmap(image);
  try {
    const tiles = regions.map(region => {
      const px = Math.max(4, Math.round((region.x1 - region.x0) * .15)), py = Math.max(4, Math.round((region.y1 - region.y0) * .15));
      const left = Math.max(0, Math.floor(region.x0 - px)), top = Math.max(0, Math.floor(region.y0 - py));
      const right = Math.min(bitmap.width, Math.ceil(region.x1 + px)), bottom = Math.min(bitmap.height, Math.ceil(region.y1 + py));
      const w = right - left, h = bottom - top;
      if (w < 1 || h < 1) throw new Error("复筛裁区超出原图范围");
      const scale = Math.min(2.5, 410 / w, 275 / h);
      return { left, top, w, h, width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
    });
    const columns = tiles.length > 1 ? 2 : 1;
    const columnWidth = Math.max(...tiles.map(tile => tile.width)) + 22;
    const rowHeight = Math.max(...tiles.map(tile => tile.height)) + 37;
    const canvas = document.createElement("canvas");
    canvas.width = columns * columnWidth; canvas.height = Math.ceil(tiles.length / columns) * rowHeight;
    const context = canvas.getContext("2d", { alpha: false })!;
    context.fillStyle = "#adafb1"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = "13px sans-serif"; context.textBaseline = "top";
    for (const [index, tile] of tiles.entries()) {
      const x = (index % columns) * columnWidth + 10, y = Math.floor(index / columns) * rowHeight + 27;
      context.fillStyle = "#101010"; context.fillText("[" + (index + 1) + "]", x, y - 22);
      context.fillStyle = "#d5d5d6"; context.fillRect(x, y, tile.width, tile.height);
      context.drawImage(bitmap, tile.left, tile.top, tile.w, tile.h, x, y, tile.width, tile.height);
    }
    const raw = await requestGameModelJson(settings, model, cropPrompt, signal, canvas.toDataURL("image/png"),
      "game-images", report, { selection, role: "refine", groupedImageOcr: true });
    const rows = raw && typeof raw === "object" && "regions" in raw && Array.isArray(raw.regions) ? raw.regions : [];
    const resolved = new Set<number>();
    const lines: PaddleOcrLine[] = [];
    for (const row of rows) {
      const index = Number(row.index) - 1;
      if (!Number.isInteger(index) || !regions[index] || resolved.has(index) || typeof row.text !== "string") continue;
      const text = normalizeUnityReviewReading(row.text.trim(), regions[index].text);
      const letters = (text.normalize("NFKC").match(/\p{L}/gu) || []).join("");
      if (!letters || noText.test(text) || /^([a-z])\1+$/iu.test(letters)) { resolved.add(index); continue; }
      const confidence = Number(row.confidence);
      if (!Number.isFinite(confidence) || confidence < threshold || confidence > 100 || [...letters].length < 2 ||
          /^[a-z]{2,3}$/iu.test(letters)) continue;
      const region = regions[index];
      lines.push({ text, confidence, x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1 });
      resolved.add(index);
    }
    return { lines, resolved: resolved.size === regions.length };
  } finally { bitmap.close(); }
}

export async function refineUnityImages(project: UnityProject, signal: AbortSignal, concurrency: number, io: ImageServices & {
  recognize: (blob: Blob, regions: UnityImageRegion[]) => Promise<ReviewCrops>;
}, progress: ImageProgress) {
  const images = (project.images || []).filter(image => image.screening?.state === "review" && unityImageReviewChecked(image));
  const pending: UnityImage[] = [];
  let cursor = 0, completed = 0, writes = Promise.resolve();
  const counts = { candidate: 0, noText: 0, review: 0, failed: 0, modelRequests: 0 };
  const flush = () => {
    if (pending.length) { const rows = pending.splice(0); writes = writes.then(() => io.persist(rows)); }
    return writes;
  };
  const worker = async () => {
    let local: LocalPaddleOcr | undefined;
    try {
      while (cursor < images.length) {
        signal.throwIfAborted();
        const image = images[cursor++];
        const { reviewEvidenceMissing, ...screening } = image.screening!;
        const old = { ...screening, beforeRefine: screening.beforeRefine ??
          { state: screening.state, reason: screening.reason, boxes: screening.boxes } };
        let next: UnityImage;
        try {
          let blob: Blob | undefined;
          let proposals = unityImageReviewCrops(image);
          if (!proposals.length && reviewEvidenceMissing) {
            blob = await io.read(image);
            local ??= new LocalPaddleOcr("fast", { upscale: false, maxSide: 1280, boxThresh: .3 });
            const { lines } = await local.recognize(blob, () => {});
            signal.throwIfAborted();
            const recovered = lines.map(line => ({ ...line, selected: false, translation: "", error: "" }));
            old.recognition = initialEvidence(recovered);
            proposals = unityImageReviewCrops({ ...image, regions: recovered });
          } else if (!old.recognition && image.regions.length) old.recognition = initialEvidence(image.regions);
          if (proposals.length) counts.modelRequests++;
          const result = proposals.length ? await io.recognize(blob ?? await io.read(image), proposals) : { lines: [], resolved: true };
          signal.throwIfAborted();
          if (result.lines.length) {
            const regions = result.lines.map(line => ({ ...line, selected: true, ocrConfirmed: true, translation: "", error: "" }));
            next = { ...image, regions, selected: true, ocrCompleted: true, error: "",
              screening: { ...old, state: "candidate", reason: "自动复筛确认有字", refineKey: UNITY_IMAGE_REFINE_KEY, refineFailed: false, reviewSelected: false } };
            counts.candidate++;
          } else {
            next = { ...image, selected: false, error: "", screening: { ...old, state: result.resolved ? "no-text" : "review",
              reason: result.resolved ? "复筛未发现可读文字" : "复筛仍无法确认文字", refineKey: UNITY_IMAGE_REFINE_KEY,
              refineFailed: false, reviewSelected: false } };
            counts[result.resolved ? "noText" : "review"]++;
          }
        } catch (error) {
          signal.throwIfAborted();
          next = { ...image, selected: false, error: error instanceof Error ? error.message : String(error),
            screening: { ...old, reviewEvidenceMissing: reviewEvidenceMissing && !old.recognition, refineKey: UNITY_IMAGE_REFINE_KEY, refineFailed: true } };
          counts.failed++;
        }
        pending.push(next);
        completed++;
        if (pending.length >= 16) await flush();
        progress({ completed, total: images.length, detail: "复筛图片 · " + completed + " / " + images.length });
      }
    } finally { await local?.dispose(); }
  };
  try {
    const result = await Promise.allSettled(Array.from({ length: Math.min(images.length, Math.max(1, Math.min(4, concurrency))) }, worker));
    const failure = result.find((row): row is PromiseRejectedResult => row.status === "rejected");
    if (failure) throw failure.reason;
  } finally { await flush(); }
  return { completed, ...counts };
}
