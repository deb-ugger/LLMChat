import { API_BASE } from "./api";
import { createMosaicGridScanner, gameDetectorFile, loadMosaicDetector, redrawMosaic, type MosaicBox, type MosaicScan, type MosaicSettings } from "./gameMosaic";
import { clearMosaicReviews, refineMosaicBatch } from "./gameMosaicRefine";
import { requestGameModelJson } from "./gameModelRequest";
import { measureGameAsync, rememberBenchmarkExecution } from "./gameModelPerformance";
import { mosaicBoxScore, presenceScore, type AnnotatedSampleSet } from "./benchmark/imageSampleSet";
import type { ImageBenchmarkWorkload } from "./gameImageBenchmark";
import type { BenchmarkStepRunner } from "./gameTextBenchmark";
import type { UnityImage, UnityProgress } from "./unityOffline";

export const mosaicBenchmarkSteps = {
  mosaicScreen: "筛选打码图片",
  mosaicRefine: "复筛打码图片",
  mosaicRedraw: "重绘打码区域",
} as const;
export type MosaicBenchmarkStep = keyof typeof mosaicBenchmarkSteps;
export type MosaicBenchmarkSetup = MosaicSettings & { sampleLimit: number; selection: "checked" | "all" };
export type MosaicBenchmarkWorkload = ImageBenchmarkWorkload & {
  checked: string[];
  boxes: Record<string, MosaicBox[]>;
  modelFile?: File;
};

export function captureMosaicBenchmark(workload: ImageBenchmarkWorkload, root: string): MosaicBenchmarkWorkload {
  const saved = localStorage.getItem("llmchat-game-mosaic:" + root);
  const rows = (saved ? JSON.parse(saved) : {}) as Record<string, { source: string; checked: boolean; boxes: MosaicBox[] }>;
  const images = (workload.project?.images || []).filter(image => !!image.sourceFile && image.width > 0 && image.height > 0);
  const checked: string[] = [];
  const boxes: Record<string, MosaicBox[]> = {};
  for (const image of images) {
    const row = rows[image.id];
    const current = row?.source === image.sourceHash ? row : undefined;
    if (current?.checked ?? true) checked.push(image.id);
    if (current?.boxes.length) boxes[image.id] = current.boxes;
  }
  return { ...workload, selected: images, checked, boxes, modelFile: gameDetectorFile(root) };
}

export async function readEmbeddedBenchmarkImage(root: string, image: UnityImage, signal: AbortSignal) {
  const response = await fetch(API_BASE + "/api/game-images/preview?" + new URLSearchParams({ gamePath: root, id: image.id }), { signal });
  if (!response.ok) throw new Error((await response.json()).error || "图片读取失败");
  return response.blob();
}

export function runMosaicBenchmark(step: MosaicBenchmarkStep, images: UnityImage[], workload: MosaicBenchmarkWorkload,
  signal: AbortSignal, read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>,
  onProgress: (value: UnityProgress) => void, annotated?: AnnotatedSampleSet): BenchmarkStepRunner {
  return async (config, settings, scope) => {
    const options = config.mosaic!;
    const expected = annotated ? new Map(annotated.images.map(image => [image.id,image.annotation])) : undefined;
    const measureAccuracy = (results: ReadonlyMap<string,MosaicScan>) => {
      if (!expected) return "";
      const pairs = Array.from(results, ([id, result]) => [expected.get(id)!, result] as const);
      const presence = presenceScore(pairs.map(([label, scan]) => [label, scan.review ? "uncertain" : scan.boxes.length ? "present" : "none"]),"mosaic");
      const localization = mosaicBoxScore(pairs.filter(([,scan]) => !scan.review).map(([label, scan]) => [label,scan.boxes]));
      return " · " + presence + (localization ? " · " + localization : "");
    };
    const readSample = (image: UnityImage, signal: AbortSignal) => measureGameAsync(scope, "processingMs", () => read(image, signal));
    if (step === "mosaicRefine") {
      // The production runner checkpoints its work. Give each benchmark run its own key.
      const root = "benchmark:" + crypto.randomUUID();
      const selection = { ...config.prompts };
      rememberBenchmarkExecution(selection, scope, step, options.refineConcurrency ?? 1);
      try {
        const result = await refineMosaicBatch(images, {
          root, settings: { ...options, refineScope: "all" }, signal, modelFile: workload.modelFile, read: readSample,
          request: (model, prompt, image, signal) => requestGameModelJson(settings, model, prompt, signal, image, "game-images", undefined, { role: "mosaic", selection }),
          onProgress: (completed, detail) => onProgress({ completed, total: images.length, detail }),
        });
        const located = [...result.results.values()].filter(scan => scan.boxes.length > 0 && !scan.review).length;
        const review = [...result.results.values()].filter(scan => !!scan.review).length;
        return { translated: result.results.size, failed: result.failed, summary: "已确认 " + located + " 张 · 待人工复核 " + review + " 张" + measureAccuracy(result.results) };
      } finally { clearMosaicReviews(root); }
    }
    let cursor = 0, completed = 0, failed = 0, located = 0, review = 0, regions = 0;
    let firstFailure = "";
    const results = new Map<string, MosaicScan>();
    const detector = step === "mosaicScreen" && options.detector !== "grid" ? await loadMosaicDetector(workload.modelFile, { signal }) : undefined;
    const lane = async () => {
      const grid = step === "mosaicScreen" && !detector ? createMosaicGridScanner() : undefined;
      try {
        while (cursor < images.length) {
          signal.throwIfAborted();
          const image = images[cursor++];
          try {
            const source = await readSample(image, signal);
            if (step === "mosaicRedraw") {
              const keep: MosaicBox[] = options.protect ? image.regions.filter(region => region.selected && region.text)
                .map(region => [region.x0, region.y0, region.x1, region.y1]) : [];
              await redrawMosaic({ source, boxes: workload.boxes[image.id], keep, model: options.model, steps: options.steps,
                seed: 1, signal, progress: detail => onProgress({ completed, total: images.length, detail: image.name + " · " + detail }) });
            } else {
              const scan = await (detector ?? grid!).scan(source);
              if (expected) results.set(image.id,scan);
              if (scan.boxes.length) located++;
              if (scan.review) review++;
              regions += scan.boxes.length;
            }
          } catch (cause) {
            signal.throwIfAborted();
            failed++;
            firstFailure ||= image.name + " · " + (cause instanceof Error ? cause.message : String(cause));
          }
          onProgress({ completed: ++completed, total: images.length, detail: image.name });
        }
      } finally { grid?.release(); }
    };
    try {
      const lanes = step === "mosaicRedraw" ? 1 : Math.min(4, Math.max(1, options.concurrency ?? 2));
      const settled = await Promise.allSettled(Array.from({ length: Math.min(lanes, images.length) }, lane));
      for (const result of settled) if (result.status === "rejected") throw result.reason;
    } finally { await detector?.release(); }
    const summary = step === "mosaicScreen" ? "检出区域 " + regions + " 个 · " + located + " 张有定位 · " + review + " 张待复核" + measureAccuracy(results)
      : "已生成 " + (completed - failed) + " 张测试结果";
    return { translated: completed - failed, failed, summary: summary + (firstFailure ? " · 首个失败 " + firstFailure : "") };
  };
}
