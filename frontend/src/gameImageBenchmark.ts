
import { API_BASE, type OcrMode, type Settings, type TranslateProvider } from "./api";
import { gameTextMatchesSource, gameTextNeedsNoTranslation } from "./gameDisplayText";
import { classifyGameImagePresence, recognizeGameImage, renderGameImage } from "./gameImageModel";
import { classifyImageText, clearGameImageRefinement, refineGameImages, screenGameImages, createLocalImageRefiner, LOCAL_REFINE_MODELS, type LocalRefineMode } from "./gameImageScreening";
import { measureGameAsync, rememberBenchmarkExecution } from "./gameModelPerformance";
import { translateGameWithOllama, prepareGameOllamaParallel, reportRefinementGpu, type OllamaOutput } from "./gameOllama";
import { gameTaskPrompt, type GamePromptScene } from "./gamePrompts";
import type { BenchmarkConfig } from "./gameTextBenchmark";
import { loadLocalModelProfiles, resolveFeatureLlm } from "./modelPresets";
import { LocalPaddleOcr } from "./ocr/paddleOcr";
import { engineReady, parseEngineKeys } from "./translateEngines";
import { createUnityEnginePool, type UnityEngineChoice } from "./unityEnginePool";
import { createUnityImageOcr, processUnityImages, unityImageParticipates } from "./unityImages";
import { unityTranslationError, type UnityImage, type UnityProgress, type UnityProject } from "./unityOffline";
import { buildUnityTranslateOptions } from "./unityTranslation";

export const imageBenchmarkSteps = {
  filter: { title: "筛选图片", role: "screen" },
  refine: { title: "复筛图片", role: "refine" },
  recognize: { title: "识字与定位", role: "recognize" },
  imageTranslate: { title: "翻译图片文字", role: "image" },
  review: { title: "复核与重译", role: "review" },
  render: { title: "生成译图", role: "layout" },
} as const satisfies Record<string, { title: string; role: GamePromptScene }>;
export type ImageBenchmarkStep = keyof typeof imageBenchmarkSteps;
export type ImageBenchmarkSetup = {
  scope: string; source: string; target: string; skipTarget: boolean;
  prompts: BenchmarkConfig["prompts"]; mode: OcrMode; strategy: "staged" | "full";
  concurrency: number; refineMode?: LocalRefineMode; refineConcurrency?: number; refineConfidence?: number; confidence?: number; engines?: UnityEngineChoice[];
  steps: Partial<Record<ImageBenchmarkStep, string>>;
};
export type ImageBenchmarkWorkload = { project: UnityProject | null; selected: UnityImage[]; embedded: boolean };

const failedRegion = (region: UnityImage["regions"][number]) => region.selected &&
  (!!region.error || !region.translation || !!unityTranslationError(region.text, region.translation));

export function imageBenchmarkRows(step: ImageBenchmarkStep, selected: UnityImage[]) {
  return selected.filter(image => !!image.sourceFile && unityImageParticipates(image) && (
    step === "refine" ? ["candidate", "review"].includes(clearGameImageRefinement(image).screening?.state || "") :
    step === "imageTranslate" ? image.ocrCompleted && image.regions.some(region => region.selected) :
    step === "review" ? image.ocrCompleted && image.regions.some(failedRegion) :
    step === "render" ? image.ocrCompleted && image.regions.some(region => region.selected && !!region.translation.trim()) : true
  ));
}

export async function runGameImageSample(step: ImageBenchmarkStep, sample: UnityImage[], workload: ImageBenchmarkWorkload,
  config: BenchmarkConfig, setup: ImageBenchmarkSetup, settings: Settings, scope: string, signal: AbortSignal,
  readUnity: (image: UnityImage) => Promise<Blob>, report: OllamaOutput, progress: (value: UnityProgress) => void) {
  if (!workload.project) throw new Error("请先读取图片工程");
  const { source, target, skipTarget } = config;
  const prompts = { ...config.prompts };
  const { id: model, lanes } = config.models.text;
  const role = imageBenchmarkSteps[step].role;
  rememberBenchmarkExecution(prompts, scope, step, lanes);
  const project = { ...workload.project, entries: [], images: structuredClone(sample).map(image => {
    const initial = step === "refine" ? clearGameImageRefinement(image) : image;
    return { ...initial, selected: true, completed: false, renderedFile: "", renderedHash: "", error: "",
      ...(step === "refine" ? { ocrCompleted: false } : {}),
      ...(step === "filter" || step === "recognize" ? { screening: undefined, ocrCompleted: false, regions: [] } : {}),
      ...(step === "imageTranslate" ? { regions: initial.regions.map(region => ({ ...region, translation: "", error: "" })) } : {}),
    };
  }) };
  const read = (image: UnityImage) => measureGameAsync(scope, "processingMs", async () => {
    if (!workload.embedded) return readUnity(image);
    const query = new URLSearchParams({ gamePath: project.root, id: image.id, cache: "0" });
    const response = await fetch(API_BASE + "/api/game-images/preview?" + query, { signal });
    if (!response.ok) throw new Error((await response.json()).error || "图片读取失败");
    return response.blob();
  });
  const vision = async (blob: Blob, scene: "screen" | "refine" | "recognize") => {
    const lines = await recognizeGameImage(settings, model, blob, signal, scene, prompts, { source, target }, report);
    return { lines, detectedBoxes: lines.length };
  };
  if (step === "refine") {
    const concurrency = model ? lanes : config.localLanes || setup.refineConcurrency || 2;
    const mode = LOCAL_REFINE_MODELS.find(item => item.id === config.imageMode)?.id || setup.refineMode || "precise";
    const local = model ? undefined : createLocalImageRefiner(mode, concurrency, scope);
    const connection = model ? { ...resolveFeatureLlm(settings, model), localModel: !!loadLocalModelProfiles()[model] } : undefined;
    let gpuChecked = false;
    try {
      if (local) { await local.prepare(); signal.throwIfAborted(); }
      if (connection) await prepareGameOllamaParallel(connection, concurrency, signal, report);
      const result = await refineGameImages(project.images, signal, { source, target, concurrency, timingScope: scope, refineKey: "benchmark", local: !!local, confidenceThreshold: setup.refineConfidence },
        { read, recognize: async (blob, worker) => {
          if (local) return local.recognize(blob, worker);
          const presence = await classifyGameImagePresence(settings, model, blob, signal, prompts, { source, target }, report, setup.refineConfidence);
          if (!gpuChecked && connection) { gpuChecked = true; await reportRefinementGpu(connection, signal, report); }
          return { lines: [], detectedBoxes: 0, presence };
        }, persist: async () => {} }, progress);
      const { completed, counts, changed, unchanged } = result;
      return { translated: completed - counts.failed, failed: counts.failed,
        summary: `复筛样本 ${completed} 张 · 分类变化 ${changed} · 未变化 ${unchanged} · 待正式识别 ${counts.candidate} · 待复核 ${counts.review} · 无文字 ${counts["no-text"]} · 无需翻译 ${counts["not-needed"]} · 失败 ${counts.failed}。本轮结果归入测试记录。` };
    } finally { await local?.dispose(); }
  }
  if (step === "filter") {
    const strategy = model ? "full" : config.imageStrategy || setup.strategy;
    const count = model ? lanes : config.localLanes || setup.concurrency;
    const workers = model ? [] : Array.from({ length: count }, () => new LocalPaddleOcr("fast", { upscale: false, maxSide: 1280, boxThresh: .3 }));
    let prepare: Promise<void> | undefined;
    try {
      const result = await screenGameImages(project, signal, { source, target, strategy, concurrency: count, model: model || "fast", timingScope: scope }, {
        read, persist: async () => {},
        recognize: (blob, stage, index = 0) => model ? vision(blob, "screen") : measureGameAsync(scope, "processingMs", async () => {
          await (prepare ??= workers[0].prepare());
          const worker = workers[workers[0].isGpu ? index % Math.min(2, workers.length) : index];
          if (strategy === "full") return worker.recognize(blob, stage, { maxSide: 1280, boxThresh: .3 });
          const rough = await worker.recognize(blob, stage, { maxSide: 768, boxThresh: .5 });
          signal.throwIfAborted();
          return classifyImageText(rough, { source, target }).state === "review" ? worker.recognize(blob, stage, { maxSide: 1280, boxThresh: .3 }) : rough;
        }),
      }, progress);
      return { translated: sample.length - result.failed, failed: result.failed };
    } finally { await Promise.all(workers.map(worker => worker.dispose())); }
  }

  const localLanes = config.localLanes || setup.concurrency;
  const workers = step === "recognize" && !model ? Array.from({ length: localLanes }, () => createUnityImageOcr(config.imageMode || setup.mode)) : [];
  const request = async (provider: TranslateProvider, text: string) => {
    if (!gameTextMatchesSource(text, source) || skipTarget && gameTextNeedsNoTranslation(text, target)) return text;
    const options = buildUnityTranslateOptions(settings, provider, source, target, model, false, !!loadLocalModelProfiles()[model],
      gameTaskPrompt(role, prompts, { source, target }), "keep", { selection: prompts, role });
    const result = await translateGameWithOllama(text, { signal }, { ...options, autoFallback: false }, report);
    if (!result.ok) throw new Error(result.error || result.code || "图片文字翻译失败");
    return result.translation;
  };
  const engines = step === "imageTranslate" && !model ? (config.engines || setup.engines || []).filter(choice => choice.enabled && engineReady(parseEngineKeys(settings.translateEngineKeys), choice.id)) : [];
  if (step === "imageTranslate" && !model && !engines.length) throw new Error("请先启用可用的图片翻译引擎");
  const pool = engines.length ? createUnityEnginePool(engines, signal, request, { timingScope: scope }) : null;
  let processed = 0, failed = 0;
  try {
    if (workers.length) {
      await workers[0].prepare();
      await Promise.all(workers.slice(1, workers[0].isGpu ? 2 : workers.length).map(worker => worker.prepare()));
    }
    await processUnityImages(project, signal, {
      timingScope: scope, concurrency: model ? lanes : localLanes, translationConcurrency: pool?.concurrency || lanes,
      regionConcurrency: pool ? 1 : lanes, reuseTranslations: false, read,
      recognize: (blob, stage, index = 0) => model ? vision(blob, "recognize").then(result => result.lines) :
        measureGameAsync(scope, "processingMs", () => workers[workers[0].isGpu ? index % Math.min(2, workers.length) : index].recognize(blob, stage)),
      translate: text => pool ? pool.translate(text) : request("llm", text),
      render: (blob, regions) => renderGameImage(settings, model, blob, regions, signal, prompts, { source, target }, report),
      write: async () => ({ path: "benchmark", hash: "" }), validate: unityTranslationError,
      persist: async (_project, image) => { processed++; if (image.error || image.regions.some(region => !!region.error)) failed++; },
    }, progress, config.imageConfidence ?? setup.confidence ?? 50, step === "recognize" || step === "render" ? step : "translate-only");
  } catch (error) {
    if (signal.aborted || !failed) throw error;
  } finally {
    pool?.dispose();
    await Promise.all(workers.map(worker => worker.dispose()));
  }
  return { translated: processed - failed, failed };
}

