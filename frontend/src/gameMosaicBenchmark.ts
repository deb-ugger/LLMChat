import type { ImageBenchmarkDetails, ImageBenchmarkInput, ImageBenchmarkOutcome, RecordImageBenchmarkOutcome } from "./benchmark/imageBenchmarkHistory";
import { countMosaicResults } from "./benchmark/mosaicScoreCounts";
import { mosaicScoreTitle, scoreMosaicRun, type MosaicScoreStage } from "./benchmark/mosaicScore";
import { API_BASE } from "./api";
import { createMosaicGridScanner, gameDetectorFile, loadMosaicDetector, redrawMosaic, type MosaicBox, type MosaicScan, type MosaicSettings } from "./gameMosaic";
import { mosaicReviewPolicy, readMosaicRows, refineMosaicBatch, reviewMosaicScreen } from "./gameMosaicRefine";
import { mosaicScreenZoomPolicy, usesMosaicPresenceProbes } from "./gameMosaicScreening";
import { mosaicScreeningStatus, mosaicStatusLabels, type MosaicScreeningSnapshot, type MosaicScreeningState } from "./gameMosaicStatus";
import { prepareMosaicReviewModel, requestGameModelJson } from "./gameModelRequest";
import { gameStepSelections, measureGameAsync, rememberBenchmarkExecution } from "./gameModelPerformance";
import type { AnnotatedSampleSet } from "./benchmark/imageSampleSet";
import type { ImageBenchmarkWorkload } from "./gameImageBenchmark";
import type { BenchmarkConfig, BenchmarkStepRunner } from "./gameTextBenchmark";
import type { UnityImage, UnityProgress } from "./unityOffline";

export const mosaicBenchmarkSteps = {
  mosaicScreen: "筛选打码图片",
  mosaicRefine: "复筛打码图片",
  mosaicRedraw: "重绘打码区域",
} as const;
export type MosaicBenchmarkStep = keyof typeof mosaicBenchmarkSteps;
export type MosaicBenchmarkSetup = MosaicSettings & { sampleLimit: number; selection: "checked" | "all"; screenVisionModel?: string };
type RefinePresetModel = "2b" | "4b" | "8b" | "3.5";

const mosaicRefinePresets: readonly [RefinePresetModel, RefinePresetModel, readonly (1 | 2)[]][] = [
  ["3.5", "8b", [1]],
  ["4b", "8b", [1, 2]],
  ["4b", "4b", [1, 2]],
  ["2b", "8b", [1, 2]],
  ["2b", "2b", [1, 2]],
  ["8b", "8b", [1]],
  ["8b", "8b", [2]],
  ["2b", "4b", [1, 2]],
  ["4b", "2b", [1, 2]],
  ["8b", "4b", [1, 2]],
  ["8b", "2b", [1, 2]],
  ["3.5", "8b", [2]],
  ["3.5", "4b", [1, 2]],
  ["3.5", "2b", [1, 2]],
];

const refinePresetModel = (model: RefinePresetModel) =>
  model === "3.5" ? "qwen3.5:latest" : `qwen3-vl:${model}-instruct`;

export function createMosaicRefinePresetConfigs(template: BenchmarkConfig): BenchmarkConfig[] {
  const { mosaic } = template;
  if (!mosaic) return [];
  return mosaicRefinePresets.flatMap(([candidate, guard, lanes]) => lanes.map(refineConcurrency => ({
    ...template,
    id: crypto.randomUUID(),
    label: `候选 ${candidate.toUpperCase()} / 复核 ${guard.toUpperCase()} · 并发 ${refineConcurrency}`,
    mosaic: {
      ...mosaic,
      refineModel: refinePresetModel(candidate),
      refineGuardModel: refinePresetModel(guard),
      refineConcurrency,
    },
  })));
}

export type MosaicBenchmarkWorkload = ImageBenchmarkWorkload & {
  checked: string[];
  boxes: Record<string, MosaicBox[]>;
  categories?: Record<string, string>;
  modelFile?: File;
};

type MosaicReviewSource = MosaicScreeningSnapshot & { checked: boolean };
type MosaicSourceRow = MosaicReviewSource & MosaicScreeningState & { source: string; beforeRefine?: MosaicReviewSource };
const liveSources = new Map<string, Record<string, MosaicSourceRow>>();

export function publishMosaicBenchmarkSource(root: string, rows?: Record<string, MosaicSourceRow>) {
  if (rows) liveSources.set(root,rows);
  else liveSources.delete(root);
}

export function captureMosaicBenchmark(workload: ImageBenchmarkWorkload, root: string, initialSnapshot = false, requireScreened = false): MosaicBenchmarkWorkload {
  const rows = liveSources.get(root) ?? readMosaicRows(root);
  const images = (workload.project?.images || []).filter(image => !!image.sourceFile && image.width > 0 && image.height > 0);
  const checked: string[] = [];
  const boxes: Record<string, MosaicBox[]> = {};
  const categories: Record<string, string> = {};
  const useSnapshot = initialSnapshot && (requireScreened || images.some(image => {
    const row = rows[image.id];
    return row?.source === image.sourceHash && (row.beforeRefine || row.refined || row.refineError);
  }));
  for (const image of images) {
    const row = rows[image.id];
    const saved = row?.source === image.sourceHash ? row : undefined;
    const current = useSnapshot ? saved?.beforeRefine ?? (saved?.refined || saved?.refineError ? undefined : saved) : saved;
    if (useSnapshot ? Boolean(current?.scanned && current.checked) : current?.checked ?? true) checked.push(image.id);
    if (current?.boxes.length) boxes[image.id] = current.boxes;
    categories[image.id] = mosaicStatusLabels[mosaicScreeningStatus(current)];
  }
  return { ...workload, selected: images, checked, boxes, categories, modelFile: gameDetectorFile(root) };
}

export function archivedMosaicSamples(available: readonly UnityImage[], archived: ImageBenchmarkDetails) {
  const sources = new Map(available.map(image => [image.id, image]));
  const images: UnityImage[] = [];
  const recovered = new Map<string, ImageBenchmarkOutcome>();
  for (const [index, sample] of archived.samples.entries()) {
    const image = sources.get(sample.id);
    if (!image || image.sourceHash !== sample.sourceHash || image.width !== sample.width || image.height !== sample.height)
      throw new Error("原测试样本已更换或未加载 · " + sample.file);
    images.push(image);
    const result: (ImageBenchmarkOutcome & { sampleId?: string; sourceHash?: string }) | undefined = archived.results[index];
    if ((result?.sampleId !== undefined && result.sampleId !== sample.id) ||
        (result?.sourceHash !== undefined && result.sourceHash !== sample.sourceHash))
      throw new Error("原测试逐图结果身份不一致 · " + sample.file);
    if (result && result.status !== "失败") recovered.set(image.id, result);
  }
  return { images, recovered };
}

export async function readEmbeddedBenchmarkImage(root: string, image: UnityImage, signal: AbortSignal) {
  const response = await fetch(API_BASE + "/api/game-images/preview?" + new URLSearchParams({ gamePath: root, id: image.id }), { signal });
  if (!response.ok) throw new Error((await response.json()).error || "图片读取失败");
  return response.blob();
}

export function mosaicBenchmarkScoreSummary(stage: MosaicScoreStage, samples: readonly ImageBenchmarkInput[],
  results: Record<string, ImageBenchmarkOutcome>, run: Pick<Parameters<typeof scoreMosaicRun>[1], "status" | "runFailures" | "elapsedMs" | "freeze" | "timing" | "issues">) {
  const counts = countMosaicResults(samples, results);
  const score = scoreMosaicRun(stage, { ...counts, ...run });
  const title = mosaicScoreTitle(stage);
  const value = score.displayScore === null ? title + " —" :
    title + " " + (score.provisional ? "暂定 " : "") + score.displayScore.toFixed(1) + " 分（权重 " + score.effectiveWeight + "/100）";
  const coverage = score.delivery === null ? "" : " · 交付覆盖 " + counts.foundBoxes + "/" + counts.expectedBoxes;
  return value + (stage === "mosaicRefine" ? coverage : "") +
    (score.speed === null ? "" : " · 每百张 " + score.speed.toFixed(1) + " 秒");
}

export function runMosaicBenchmark(step: MosaicBenchmarkStep, images: UnityImage[], workload: MosaicBenchmarkWorkload,
  signal: AbortSignal, read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>,
  onProgress: (value: UnityProgress) => void, annotated?: AnnotatedSampleSet,
  recovered?: ReadonlyMap<string, ImageBenchmarkOutcome>): BenchmarkStepRunner {
  return async (config, settings, scope, record?: RecordImageBenchmarkOutcome, runId?: string, preceding?: ReadonlyMap<string, ImageBenchmarkOutcome>) => {
    const sources = new Map(images.map(image => [image.id, image.sourceHash]));
    const isReview = step === "mosaicRefine";
    const options = config.mosaic!;
    const screenPolicy = step === "mosaicScreen" && options.detector === "anime" && usesMosaicPresenceProbes(options.screening) ? mosaicScreenZoomPolicy : undefined;
    const saveResult = (id: string, outcome: ImageBenchmarkOutcome) => {
      const row = { sampleId: id, sourceHash: sources.get(id), ...outcome,
        ...(isReview && { mosaicReviewPolicy }), ...(screenPolicy && { mosaicScreenPolicy: screenPolicy }) };
      record?.(id, row);
    };
    const recordScan = (image: UnityImage, scan: MosaicScan) => saveResult(image.id, {
      category: mosaicStatusLabels[mosaicScreeningStatus({
        ...scan, scanned: true, refined: step === "mosaicRefine" ? step : undefined, refineQuickExcluded: scan.quickExcluded,
      })],
      boxes: scan.review ? scan.reviewBoxes || scan.boxes : scan.boxes, checked: !!scan.boxes.length && !scan.review, reason: scan.review,
    });
    const restored = new Map([...(recovered ?? []), ...(isReview ? [] : preceding ?? [])]
      .filter(([, outcome]) => (!isReview || outcome.mosaicReviewPolicy === mosaicReviewPolicy) &&
        (!screenPolicy || outcome.mosaicScreenPolicy === screenPolicy)));
    for (const [id, result] of restored) saveResult(id, result);
    const prior = restored.size;
    const pending = prior ? images.filter(image => !restored.has(image.id)) : images;
    const readSample = (image: UnityImage, signal: AbortSignal) => measureGameAsync(scope, "processingMs", () => read(image, signal));
    if (step === "mosaicRefine") {
      if (!runId) throw new Error("缺少复筛测试编号");
      // Use the same isolated review checkpoint when a paused configuration resumes.
      const root = "benchmark:" + runId;
      const selections = gameStepSelections(scope, step);
      let completed = prior;
      const result = await refineMosaicBatch(pending, {
        root, settings: { ...options, refineScope: "all" }, signal, modelFile: workload.modelFile, read: readSample, timingScope: scope,
        initialScreening: image => {
          if (annotated) return;
          const category = workload.categories?.[image.id];
          if (category === mosaicStatusLabels.candidate || category === mosaicStatusLabels.clear || category === mosaicStatusLabels.review)
            return { scanned: true, boxes: workload.boxes[image.id] ?? [], review: category === mosaicStatusLabels.review ? category : undefined };
        },
        prepareRequest: (model, lanes) => prepareMosaicReviewModel(settings, model, lanes, signal,
          detail => onProgress({ completed, total: images.length, detail })),
        request: (model, prompt, image, signal, lanes) => requestGameModelJson(settings, model, prompt, signal, image,
          "game-images", undefined, { role: "mosaic", selection: selections(lanes) }),
        onResult: (image, scan) => { completed++; recordScan(image, scan); },
        onError: (image, reason) => saveResult(image.id,{ category:mosaicStatusLabels.failed,status:"失败",reason }),
        onProgress: (completed, detail) => onProgress({ completed: prior + completed, total: images.length, detail }),
      });
      const located = [...result.results.values()].filter(scan => scan.boxes.length > 0 && !scan.review).length;
      const review = [...result.results.values()].filter(scan => !!scan.review).length;
      const summary = mosaicStatusLabels.refinedCandidate + " " + located + " 张 · 待人工复核 " + review + " 张";
      return { translated: prior + result.results.size, failed: result.failed,
        summary: prior ? "复用 " + prior + " 张归档结果 · 续跑结果 · " + summary : summary };
    }
    let cursor = 0, completed = prior, failed = 0, located = 0, review = 0, regions = 0;
    let firstFailure = "";
    if (step === "mosaicScreen" && preceding && !recovered) {
      for (const result of preceding.values()) {
        const uncertain = result.category === mosaicStatusLabels.review;
        const boxes = result.boxes ?? [];
        if (uncertain) review++;
        else if (boxes.length) located++;
        regions += uncertain ? 0 : boxes.length;
      }
    }
    if (prior) onProgress({ completed, total: images.length, detail: "已恢复 " + prior + " 张样本结果" });
    const detector = pending.length && step === "mosaicScreen" && options.detector !== "grid"
      ? await loadMosaicDetector(workload.modelFile, { signal, timingScope: scope, initialScreening: true, screening: options.screening, maxConcurrency: Math.min(pending.length, options.concurrency ?? 2) }) : undefined;
    const screenModel = step === "mosaicScreen" ? options.screenVisionModel : undefined;
    const selection = { ...config.prompts };
    if (screenModel) rememberBenchmarkExecution(selection, scope, step, Math.max(1, Math.min(4, options.concurrency ?? 2)));
    const lane = async () => {
      const grid = step === "mosaicScreen" && !detector ? createMosaicGridScanner() : undefined;
      try {
        while (cursor < pending.length) {
          signal.throwIfAborted();
          const image = pending[cursor++];
          try {
            const source = await readSample(image, signal);
            if (step === "mosaicRedraw") {
              const keep: MosaicBox[] = options.protect ? image.regions.filter(region => region.selected && region.text)
                .map(region => [region.x0, region.y0, region.x1, region.y1]) : [];
              await redrawMosaic({ source, boxes: workload.boxes[image.id], keep, model: options.model, steps: options.steps,
                seed: 1, signal, timingScope: scope, benchmark: true, progress: detail => onProgress({ completed, total: images.length, detail: image.name + " · " + detail }) });
              saveResult(image.id,{category:"已生成去码候选",boxes:workload.boxes[image.id]});
            } else {
              const initial = await (detector ?? grid!).scan(source);
              const scan = screenModel && !initial.boxes.length
                ? await reviewMosaicScreen(source, initial, signal, (prompt, crop) =>
                    requestGameModelJson(settings, screenModel, prompt, signal, crop, "game-images", undefined, { role: "mosaic", selection }))
                : initial;
              recordScan(image,scan);
              if (scan.boxes.length) located++;
              if (scan.review) review++;
              regions += scan.boxes.length;
            }
          } catch (cause) {
            signal.throwIfAborted();
            failed++;
            saveResult(image.id,{category:mosaicStatusLabels.failed,status:"失败",reason:String(cause)});
            firstFailure ||= image.name + " · " + (cause instanceof Error ? cause.message : String(cause));
          }
          onProgress({ completed: ++completed, total: images.length, detail: image.name });
        }
      } finally { grid?.release(); }
    };
    try {
      const lanes = step === "mosaicRedraw" ? 1 : Math.min(4, Math.max(1, options.concurrency ?? 2));
      const settled = await Promise.allSettled(Array.from({ length: Math.min(lanes, pending.length) }, lane));
      for (const result of settled) if (result.status === "rejected") throw result.reason;
    } finally { await detector?.release(); }
    const summary = step === "mosaicScreen"
      ? (recovered ? "续跑阶段 · " : "") + "检出区域 " + regions + " 个 · " + located + " 张有定位 · " + review + " 张待复核"
      : "已生成 " + (completed - failed) + " 张测试结果";
    return { translated: completed - failed, failed, summary: summary + (firstFailure ? " · 首个失败 " + firstFailure : "") };
  };
}
