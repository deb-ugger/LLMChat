import { imageScreenOutcome, type RecordImageBenchmarkOutcome } from "./benchmark/imageBenchmarkHistory";

import { API_BASE, type OcrMode, type Settings, type TranslateProvider } from "./api";
import { gameTextMatchesSource, gameTextNeedsNoTranslation } from "./gameDisplayText";
import { classifyGameImagePresence, gameImageTranslationProblem, recognizeGameImage, renderGameImage } from "./gameImageModel";
import { recognizeLocalGameImage } from "./gameImageRecognitionInput";
import { classifyImageText, clearGameImageRefinement, refineGameImages, screenGameImages, createLocalImageRefiner, LOCAL_REFINE_MODELS, localGameImageScreeningLanes, type LocalRefineMode } from "./gameImageScreening";
import { measureGameAsync, rememberBenchmarkExecution } from "./gameModelPerformance";
import { translateGameWithOllama, prepareGameOllamaParallel, reportRefinementGpu, type OllamaOutput } from "./gameOllama";
import { gameTaskPrompt, type GamePromptScene } from "./gamePrompts";
import { annotatedTextInput, presenceScore, sampleTextMatchesScope, textBoxScore, type AnnotatedSampleSet, type PresenceVerdict } from "./benchmark/imageSampleSet";
import type { BenchmarkConfig } from "./gameTextBenchmark";
import { loadLocalModelProfiles, resolveFeatureLlm } from "./modelPresets";
import { LocalPaddleOcr } from "./ocr/paddleOcr";
import { engineReady, parseEngineKeys } from "./translateEngines";
import { createUnityEnginePool, type UnityEngineChoice } from "./unityEnginePool";
import { createUnityImageOcr, processUnityImages, unityImageParticipates } from "./unityImages";
import type { UnityImage, UnityProgress, UnityProject } from "./unityOffline";
import { recognizeUnityReviewCrops, refineUnityImages, refineUnityImagesLocally, screenUnityImages } from "./unityImageFiltering";
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
  (!!region.error || !region.translation || !!gameImageTranslationProblem(region.text, region.translation, region.translationTarget));

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
  readUnity: (image: UnityImage) => Promise<Blob>, report: OllamaOutput, progress: (value: UnityProgress) => void,
  onSample?: (sample: string) => void, annotated?: AnnotatedSampleSet, record?: RecordImageBenchmarkOutcome) {
  if (!workload.project) throw new Error("请先读取图片工程");
  const { source, target, skipTarget } = config;
  const prompts = { ...config.prompts };
  const { id: model, lanes } = config.models.text;
  const role = imageBenchmarkSteps[step].role;
  rememberBenchmarkExecution(prompts, scope, step, lanes);
  const labeledInputs = annotated ? new Map(annotated.images.map(image => [image.id, image])) : undefined;
  const observed = new Map<string, PresenceVerdict>();
  const recognized = new Map<string,UnityImage["regions"]>();
  const recordScreening = async (rows: UnityImage[]) => {
    for (const image of rows) {
      record?.(image.id,imageScreenOutcome(image));
      if (!labeledInputs) continue;
      const state = image.screening?.state;
      if (image.screening?.refineFailed || state === "failed") observed.set(image.id, "failed");
      else if (image.screening?.sourceSkip || state === "not-needed") observed.set(image.id, "skip");
      else if (state === "no-text") observed.set(image.id, "none");
      else if (state === "review") observed.set(image.id, "uncertain");
      else if (state === "candidate") observed.set(image.id, "present");
    }
  };
  const scoring = () => labeledInputs ? presenceScore(Array.from(observed, ([id, verdict]) => {
    const expected = labeledInputs.get(id)!;
    const comparable = (verdict === "none" || verdict === "uncertain") && !sampleTextMatchesScope(expected,source,target,skipTarget)
      ? "skip" : verdict;
    return [expected.annotation, comparable] as const;
  }),"text") : undefined;
  const inputSample = labeledInputs ? sample.map(image => annotatedTextInput(labeledInputs.get(image.id)!,step,source,target,skipTarget)) : sample;
  const project = { ...workload.project, entries: [], images: structuredClone(inputSample).map(image => {
    let initial = step === "refine" ? clearGameImageRefinement(image) : image;
    if (step === "refine" && !workload.embedded && initial.screening) {
      const screening = initial.screening;
      const state = image.screening?.refineKey === "unity-region-review-v1" ? "review" : screening.state;
      const evidence = screening.recognition?.lines;
      initial = { ...initial, screening: { ...screening, state, reviewSelected: true,
        reviewEvidenceMissing: state === "review" && !evidence?.length && initial.regions.every(region => region.ocrConfirmed) },
        regions: evidence?.map(line => ({ ...line, translation: "", selected: false, error: "" })) ?? initial.regions };
    }
    return { ...initial, selected: true, completed: false, renderedFile: "", renderedHash: "", error: "",
      noTranslationNeeded: false,
      ...(step === "refine" ? { ocrCompleted: false } : {}),
      ...(step === "filter" || step === "recognize" ? { screening: undefined, ocrCompleted: false, regions: [] } : {}),
      ...(step === "imageTranslate" ? { regions: initial.regions.map(region => ({ ...region, translation: "", error: "" })) } : {}),
    };
  }) };
  const read = (image: UnityImage) => measureGameAsync(scope, "processingMs", async () => {
    onSample?.(image.name);
    if (annotated) return annotated.read(image, signal);
    if (!workload.embedded) return readUnity(image);
    const query = new URLSearchParams({ gamePath: project.root, id: image.id });
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
    if (!workload.embedded) {
      const confidence = config.imageConfidence ?? setup.refineConfidence ?? (model ? 70 : 50);
      const io = { read, persist: recordScreening };
      if (model) {
        const connection = { ...resolveFeatureLlm(settings, model), localModel: !!loadLocalModelProfiles()[model] };
        await prepareGameOllamaParallel(connection, concurrency, signal, report);
      }
      const result = model ? await refineUnityImages(project, signal, concurrency, { ...io,
        recognize: (blob, regions) => recognizeUnityReviewCrops(settings, model, blob, regions, signal, prompts, report, confidence) }, progress)
        : await refineUnityImagesLocally(project, signal, scope, { method: "local", mode, confidence, concurrency }, io, progress);
      if (!result.completed) throw new Error(model ? "选择有初筛疑似文字区域的图片后，再测试 Unity 视觉复筛" : "没有可复筛的 Unity 样本图片");
      return { translated: result.completed - result.failed, failed: result.failed, summary: scoring() };
    }
    const local = model ? undefined : createLocalImageRefiner(mode, concurrency, scope);
    const connection = model ? { ...resolveFeatureLlm(settings, model), localModel: !!loadLocalModelProfiles()[model] } : undefined;
    let gpuChecked = false;
    try {
      if (local) { await local.prepare(); signal.throwIfAborted(); }
      if (connection) await prepareGameOllamaParallel(connection, concurrency, signal, report);
      const confidence = config.imageConfidence ?? setup.refineConfidence;
      const result = await refineGameImages(project.images, signal, { source, target, concurrency, timingScope: scope, refineKey: "benchmark", local: !!local, confidenceThreshold: confidence },
        { read, recognize: async (blob, worker) => {
          if (local) return local.recognize(blob, worker);
          const presence = await classifyGameImagePresence(settings, model, blob, signal, prompts, { source, target }, report, confidence);
          if (!gpuChecked && connection) { gpuChecked = true; await reportRefinementGpu(connection, signal, report); }
          return { lines: [], detectedBoxes: 0, presence };
        }, persist: recordScreening }, progress);
      const { completed, counts, changed, unchanged } = result;
      return { translated: completed - counts.failed, failed: counts.failed,
        summary: `复筛样本 ${completed} 张 · 分类变化 ${changed} · 未变化 ${unchanged} · 待正式识别 ${counts.candidate} · 待复核 ${counts.review} · 无文字 ${counts["no-text"]} · 无需翻译 ${counts["not-needed"]} · 失败 ${counts.failed}。本轮结果归入测试记录。${labeledInputs ? " · " + scoring() : ""}` };
    } finally { await local?.dispose(); }
  }
  if (step === "filter") {
    const strategy = model ? "full" : config.imageStrategy || setup.strategy;
    const count = model ? lanes : localGameImageScreeningLanes(config.localLanes || setup.concurrency);
    if (!workload.embedded) {
      const result = await screenUnityImages(project, signal, { source, target, strategy, model: model || undefined, concurrency: count, timingScope: scope },
        { read, persist: recordScreening, recognize: model ? async blob => (await vision(blob, "screen")).lines : undefined }, progress);
      return { translated: result.completed - result.failed, failed: result.failed, summary: scoring() };
    }
    const workers = model ? [] : Array.from({ length: count }, () => new LocalPaddleOcr("fast", { upscale: false, maxSide: 1280, boxThresh: .3 }));
    let prepare: Promise<void> | undefined;
    try {
      const result = await screenGameImages(project, signal, { source, target, strategy, concurrency: count, model: model || "fast", timingScope: scope }, {
        read, persist: recordScreening,
        recognize: async (blob, stage, index = 0) => {
          if (model) return vision(blob, "screen");
          await (prepare ??= measureGameAsync(scope, "processingMs", () => workers[0].prepare()));
          const recognize = (maxSide: number, boxThresh: number) => measureGameAsync(scope, "ocrMs",
            () => workers[index].recognize(blob, stage, { maxSide, boxThresh }));
          if (strategy === "full") return recognize(1280, .3);
          const rough = await recognize(768, .5);
          signal.throwIfAborted();
          return classifyImageText(rough, { source, target }).state === "review" ? recognize(1280, .3) : rough;
        },
      }, progress);
      return { translated: sample.length - result.failed, failed: result.failed, summary: scoring() };
    } finally { await Promise.all(workers.map(worker => worker.dispose())); }
  }

  const localLanes = config.localLanes || setup.concurrency;
  const mode = config.imageMode || setup.mode;
  const workers = step === "recognize" && (!model || mode === "manga") ? Array.from({ length: model ? lanes : localLanes }, () => createUnityImageOcr(mode)) : [];
  const request = async (provider: TranslateProvider, text: string) => {
    const options = buildUnityTranslateOptions(settings, provider, source, target, model, false, !!loadLocalModelProfiles()[model],
      gameTaskPrompt(role, prompts, { source, target }), "keep", { selection: prompts, role });
    const result = await translateGameWithOllama(text, { signal }, { ...options, autoFallback: false }, report);
    if (!result.ok) throw new Error(result.error || result.code || "图片文字翻译失败");
    return result.translation;
  };
  const engines = step === "imageTranslate" && !model ? (config.engines || setup.engines || []).filter(choice => choice.enabled && engineReady(parseEngineKeys(settings.translateEngineKeys), choice.id)) : [];
  if (step === "imageTranslate" && !model && !engines.length) throw new Error("请先启用可用的图片翻译引擎");
  const pool = engines.length ? createUnityEnginePool(engines, signal, request, { timingScope: scope }) : null;
  let processed = 0, failed = 0, skipped = 0;
  try {
    if (workers.length && !model) {
      await workers[0].prepare();
      await Promise.all(workers.slice(1, workers[0].isGpu ? 2 : workers.length).map(worker => worker.prepare()));
    }
    await processUnityImages(project, signal, {
      timingScope: scope, concurrency: model ? lanes : localLanes, translationConcurrency: pool?.concurrency || lanes,
      regionConcurrency: pool ? 1 : lanes, reuseTranslations: false, read, targetLanguage: target,
      includeRegion: labeledInputs ? undefined : text => gameTextMatchesSource(text,source) && (!skipTarget || !gameTextNeedsNoTranslation(text,target)),
      recognize: (blob, stage, index = 0) => {
        if (!model) return measureGameAsync(scope, "ocrMs", () => recognizeLocalGameImage(blob,
          input => workers[workers[0].isGpu ? index % Math.min(2, workers.length) : index].recognize(input, stage), signal));
        const worker = workers[index];
        return worker ? worker.recognizeVision(blob, stage, signal,
          fallback => recognizeGameImage(settings, model, blob, signal, "recognize", prompts, { source, target }, report, fallback),
          message => report(message, "error")) : vision(blob, "recognize").then(result => result.lines);
      },
      translate: text => pool ? pool.translate(text) : request("llm", text),
      render: (blob, regions) => renderGameImage(settings, model, blob, regions, signal, prompts, { source, target }, report),
      write: async () => ({ path: "benchmark", hash: "" }), validate: (source, translation) => gameImageTranslationProblem(source, translation, target),
      persist: async (_project, image) => {
        if (record) {
          const failed = image.error || image.regions.some(region => region.selected && !!region.error);
          const category = failed ? "处理失败" : step === "recognize"
            ? image.regions.some(region => region.text.trim()) ? "识别到文字" : "未检测到文字"
            : image.noTranslationNeeded ? "无需翻译" : step === "render" ? "已生成译图" : "已翻译文字";
          record(image.id,{ category, checked:image.selected, reason:image.error || (image.noTranslationNeeded ? "按语言或保留规则跳过" : undefined),
            status:failed ? "失败" : image.noTranslationNeeded && step !== "recognize" ? "跳过" : "完成",
            regions:image.regions.map(region => ({ box:[region.x0,region.y0,region.x1,region.y1],text:region.text,
              translation:region.translation || undefined, reason:region.error || undefined })) });
        }
        processed++;
        if (image.error || image.regions.some(region => region.selected && !!region.error)) {
          failed++;
          if (labeledInputs && step === "recognize") observed.set(image.id,"failed");
        } else if (labeledInputs && step === "recognize") {
          const regions = image.regions.filter(region => region.text.trim());
          observed.set(image.id, regions.length ? "present" : "none");
          if (sampleTextMatchesScope(labeledInputs.get(image.id)!,source,target,skipTarget)) recognized.set(image.id,regions);
        } else if (image.noTranslationNeeded) skipped++;
      },
    }, progress, config.imageConfidence ?? setup.confidence ?? 50, step === "recognize" || step === "render" ? step : "translate-only");
  } catch (error) {
    if (signal.aborted || !failed) throw error;
  } finally {
    pool?.dispose();
    await Promise.all(workers.map(worker => worker.dispose()));
  }
  const localization = labeledInputs && step === "recognize"
    ? textBoxScore(Array.from(recognized, ([id, regions]) => [labeledInputs.get(id)!.annotation, regions] as const),source,target,skipTarget) : "";
  return { translated: processed - failed, failed,
    summary: step === "recognize" ? [scoring(),localization].filter(Boolean).join(" · ") || undefined
      : skipped ? "按语言或保留规则跳过 " + skipped + " 张" : undefined };
}

