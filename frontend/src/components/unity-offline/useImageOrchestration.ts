import { useRef, useState } from "react";
import type { Settings, TranslateProvider } from "../../api";
import type { OutputLevel } from "../../appOutput";
import type { GameTestImageOptions } from "../../gameModelPreset";
import type { prepareGameOllamaModels, translateGameWithOllama } from "../../gameOllama";
import { gameImageTranslationProblem, type recognizeGameImage, type renderGameImage } from "../../gameImageModel";
import { reviewGameImageTranslation } from "../../gameImageSemanticReview";
import { createGameImageOcrReuse, defaultGameImageVision, gameImageCleanBase, gameImageRedrawSelected, gameImageVisionForAsset, type redrawGameImages, type StyleRedrawProfileId } from "../../gameImagePlacement";
import { translateNamedImageText, type collectGameImageNames } from "../../gameImageNames";
import { gameImageRegionLanguageFilter, localGameImageScreeningLanes } from "../../gameImageScreening";
import { defaultUnityImageScreening, unityImageRefinementPending, type screenUnityImages, type refineUnityImages,
  type refineUnityImagesLocally, type recognizeUnityReviewCrops, type UnityImageScreeningOptions } from "../../unityImageFiltering";
import type { measureGameAsync, modelConcurrency } from "../../gameModelPerformance";
import type { gameTaskPrompt } from "../../gamePrompts";
import type { loadLocalModelProfiles, resolveFeatureLlm } from "../../modelPresets";
import type { readUnitySourceImage } from "../../unityImagePreview";
import { createUnityImageOcr, unityImageTranslationRegions, type processUnityImages } from "../../unityImages";
import type { UnityProject, UnityImage, UnityProgress } from "../../unityOffline";
import { unityImageWorkDone } from "../../unityWorkflow";
import type { buildUnityTranslateOptions, GameTranslationKind } from "../../unityTranslation";
import { createUnityEnginePool, type UnityEngineChoice } from "../../unityEnginePool";
import type { OcrMode } from "../../api";

type ImageLog = (message: string, level?: OutputLevel) => void;
type ImageProgress = (value: UnityProgress) => void;
type PromptSelection = NonNullable<Parameters<typeof gameTaskPrompt>[1]>;
type ImageTranslationOptions = ReturnType<typeof buildUnityTranslateOptions> & {
  imageReviewOptions?: ReturnType<typeof buildUnityTranslateOptions>;
  engineIds?: TranslateProvider[];
  onlySourceLanguage?: boolean;
  skipTargetLanguage?: boolean;
};
type ImageRun = { source: string; target: string; onlySourceLanguage?: boolean; skipTargetLanguage?: boolean;
  translationKind: GameTranslationKind; engines?: UnityEngineChoice[]; imageTask?: UnityImagePhase;
  imageOcrMode?: OcrMode; imageVisionModel?: string; imageLayoutModel?: string; imageRedrawProfile?: StyleRedrawProfileId;
  imageConfidenceThreshold?: number; imageConcurrency?: number; imageScreeningOptions?: UnityImageScreeningOptions };
type ImageRequestPorts = { translateGameWithOllama: typeof translateGameWithOllama; imageLog: ImageLog };
type ImageBatchPorts<T extends ImageRun> = ImageRequestPorts & {
  root: string;
  settings: Settings;
  picture: NonNullable<GameTestImageOptions["translation"]>;
  promptState: { scope: string; selection: PromptSelection };
  imageTask: () => UnityImagePhase;
  imageConcurrency: number;
  imageConfidenceThreshold: number;
  gameModels: string[];
  setRedrawingId: (id?: string) => void;
  setMessage: (message: string) => void;
  translationOptions: (run: T, forImages: true) => Promise<ImageTranslationOptions>;
  measureGameAsync: typeof measureGameAsync;
  modelConcurrency: typeof modelConcurrency;
  prepareGameOllamaModels: typeof prepareGameOllamaModels;
  loadLocalModelProfiles: typeof loadLocalModelProfiles;
  resolveFeatureLlm: typeof resolveFeatureLlm;
  readUnitySourceImage: typeof readUnitySourceImage;
  collectGameImageNames: typeof collectGameImageNames;
  recognizeGameImage: typeof recognizeGameImage;
  renderGameImage: typeof renderGameImage;
  recognizeUnityReviewCrops: typeof recognizeUnityReviewCrops;
  screenUnityImages: typeof screenUnityImages;
  refineUnityImages: typeof refineUnityImages;
  refineUnityImagesLocally: typeof refineUnityImagesLocally;
  redrawGameImages: typeof redrawGameImages;
  processUnityImages: typeof processUnityImages;
  publishTranslation: (project: UnityProject) => void;
  saveTranslation: (project: UnityProject) => Promise<void>;
  invalidatePatch: () => void;
  writeImage: (project: UnityProject, image: UnityImage, blob: Blob) => Promise<{ path: string; hash: string }>;
  persistImageStates: (project: UnityProject, images: UnityImage[], scope: string) => Promise<unknown>;
  persistRenderedState: (project: UnityProject, image: UnityImage) => Promise<unknown>;
};
type ImagePassPorts = {
  hasRedrawTargets: () => boolean;
  beginPhase: (phase: UnityImagePhase) => void;
  commitConfiguration: (phase: UnityImagePhase) => boolean | Promise<boolean> | undefined;
  executePhase: () => Promise<UnityProject>;
  completePhase: (phase: UnityImagePhase) => void;
};

export function useImageOrchestration() {
  const [redrawingId, setRedrawingId] = useState<string>();
  const imageTask = useRef<UnityImagePhase>("filter");
  return { redrawingId, setRedrawingId, imageTask };
}

export const unityImagePhaseNames = { filter: "筛选图片", refine: "复筛图片", recognize: "识字与定位", translate: "翻译图片文字",
  review: "复核与重译", render: "生成译图", redraw: "AI 风格重绘" } as const;
export type UnityImagePhase = keyof typeof unityImagePhaseNames;
export const unityImagePhases = Object.keys(unityImagePhaseNames) as UnityImagePhase[];

export async function runImageRegionTranslation(options: ImageTranslationOptions, provider: string, text: string,
  parentSignal: AbortSignal, phase: "translate" | "review" | undefined, { translateGameWithOllama, imageLog }: ImageRequestPorts) {
  const { imageReviewOptions, ...primary } = options;
  const translate = async (config: ReturnType<typeof buildUnityTranslateOptions>) => {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(provider === "llm" ? 120000 : 30000)]);
    const response = await translateGameWithOllama(text, { signal }, { ...config, provider }, imageLog);
    if (!response.ok) throw Object.assign(new Error(response.error || response.code || "图片文字翻译失败"), { code: response.code });
    return response.translation;
  };
  if (phase === "translate") return translate(primary);
  if (phase === "review") {
    if (!imageReviewOptions) throw new Error("请选择图片译文复核模型");
    return translate(imageReviewOptions);
  }
  let primaryError: unknown;
  try {
    const translated = await translate(primary);
    const issue = gameImageTranslationProblem(text, translated, options.target);
    if (!issue) return translated;
    primaryError = new Error(issue);
  } catch (error) {
    primaryError = error;
  }
  parentSignal.throwIfAborted();
  if (provider !== "llm" || !imageReviewOptions) throw primaryError;
  try {
    const reviewed = await translate(imageReviewOptions);
    const issue = gameImageTranslationProblem(text, reviewed, options.target);
    if (issue) throw new Error(issue);
    return reviewed;
  }
  catch (reviewError) {
    parentSignal.throwIfAborted();
    const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
    throw new Error(`图片初译失败（${describe(primaryError)}），复核重译失败（${describe(reviewError)}）`);
  }
}

export async function runImageTranslation<T extends ImageRun>(p: UnityProject, controller: AbortController, run: T, onProgress: ImageProgress,
  ports: ImageBatchPorts<T>) {
  const { root, settings, picture, promptState, imageTask, imageConcurrency, imageConfidenceThreshold, gameModels, translationOptions,
    setRedrawingId, setMessage, imageLog, measureGameAsync, modelConcurrency, loadLocalModelProfiles, resolveFeatureLlm, prepareGameOllamaModels,
    readUnitySourceImage, collectGameImageNames, recognizeGameImage, renderGameImage, recognizeUnityReviewCrops, screenUnityImages, refineUnityImages,
    refineUnityImagesLocally, redrawGameImages, processUnityImages, publishTranslation, saveTranslation, invalidatePatch, writeImage,
    persistImageStates, persistRenderedState } = ports;
  if ((p.scanRevision || 0) < 5) throw new Error("当前工程尚未扫描图片，请更新扫描，或跳过步骤 2.2");
  run = { ...run, source: picture.source, target: picture.target, onlySourceLanguage: picture.onlySourceLanguage,
    skipTargetLanguage: picture.skipTargetLanguage, translationKind: picture.kind, engines: picture.engines };
  const phase = run.imageTask || imageTask();
  if (phase === "redraw") {
    const images = p.images || [];
    if (!images.some(gameImageRedrawSelected)) return p;
    const scope = promptState.scope + ":images";
    const include = gameImageRegionLanguageFilter(run.source, run.target, run.onlySourceLanguage !== false, run.skipTargetLanguage !== false);
    let next = p;
    try {
      const result = await redrawGameImages(images, run.imageRedrawProfile ?? "turbo", run.target, controller.signal, {
        onStart: setRedrawingId,
        timingScope: scope,
        regions: image => unityImageTranslationRegions(image.regions, run.imageConfidenceThreshold ?? imageConfidenceThreshold, image)
          .filter(region => include(region.text)),
        read: image => readUnitySourceImage(p, image, controller.signal),
        write: (image, blob) => measureGameAsync(scope, "saveMs", () => writeImage(p, image, blob)),
        persist: async image => {
          await persistImageStates(p, [image], scope);
          next = { ...next, images: (next.images || []).map(previous => previous.id === image.id ? image : previous) };
          publishTranslation(next);
          invalidatePatch();
        },
      }, onProgress, imageLog).finally(() => setRedrawingId(undefined));
      if (result.failed) throw new Error(`${result.failed} / ${result.total} 张重绘失败，失败项仍可重试`);
      imageLog(`AI 风格重绘完成 · ${result.total} 张`, "success");
    } finally {
      if (next !== p) await saveTranslation(next);
    }
    return next;
  }
  if (phase === "filter" || phase === "refine") {
    const signal = controller.signal;
    const scope = promptState.scope + ":images";
    const working = [...(p.images || [])];
    const indexes = new Map(working.map((image, index) => [image.id, index]));
    let current = p, lastPublish = 0;
    const io = {
      read: (image: UnityImage) => measureGameAsync(scope, "processingMs", () => readUnitySourceImage(p, image, signal)),
      persist: async (rows: UnityImage[]) => {
        await persistImageStates(p, rows, scope);
        for (const row of rows) working[indexes.get(row.id)!] = row;
        current = { ...p, images: working };
        if (performance.now() - lastPublish >= 350) {
          lastPublish = performance.now();
          publishTranslation({ ...current, images: working.slice() });
        }
      },
    };
    try {
      const screening = run.imageScreeningOptions ?? defaultUnityImageScreening;
      if (phase === "filter") {
        const model = screening.filterModel;
        if (model === "") throw new Error("请选择筛选视觉模型");
        const lanes = model ? modelConcurrency(promptState.scope,"screen",model) : localGameImageScreeningLanes(run.imageConcurrency || imageConcurrency);
        if (model) await prepareGameOllamaModels([{ connection: { ...resolveFeatureLlm(settings, model), localModel: !!loadLocalModelProfiles()[model] }, lanes }], signal, imageLog);
        const result = await screenUnityImages(p, signal, { source: run.source, target: run.target,
          concurrency: lanes, timingScope: scope, model, strategy: model ? "full" : screening.strategy },
        { ...io, recognize: model ? blob => recognizeGameImage(settings, model, blob, signal, "screen", promptState.selection, { source: run.source, target: run.target }, imageLog) : undefined }, onProgress,
        (message, fallback) => imageLog(message, fallback ? "warning" : "info"));
        imageLog("筛选完成 · 检测到字 " + result.candidate + " · 待复核 " + result.review + " · 未检测到字 " + result.noText + " · 失败 " + result.failed, result.failed ? "warning" : "success");
        if (result.failed) throw new Error("部分图片筛选失败，已保存结果，可继续");
      } else {
        const refine = screening.refine;
        if (refine.method === "off") return p;
        const selected = working.filter(image => unityImageRefinementPending(image, refine));
        if (!selected.length) { onProgress({ completed: 0, total: 0, detail: "没有待复筛图片" }); return p; }
        let result;
        if (refine.method === "local") result = await refineUnityImagesLocally(p, signal, scope, refine, io, onProgress,
          (message, fallback) => imageLog(message, fallback ? "warning" : "info"));
        else {
          const model = refine.model ?? defaultGameImageVision(gameModels);
          if (!model) throw new Error("请选择复筛视觉模型");
          const lanes = modelConcurrency(promptState.scope, "refine", model);
          await prepareGameOllamaModels([{ connection: { ...resolveFeatureLlm(settings, model), localModel: !!loadLocalModelProfiles()[model] }, lanes }], signal, imageLog);
          result = await refineUnityImages(p, signal, lanes, { ...io,
            recognize: (blob, regions) => recognizeUnityReviewCrops(settings, model, blob, regions, signal, promptState.selection, imageLog, refine.confidence) }, onProgress);
        }
        imageLog("自动复筛完成 · 确认有字 " + result.candidate + " · 未检测到字 " + result.noText + " · 仍有疑问 " + result.review +
          " · 视觉请求 " + result.modelRequests + " · 失败 " + result.failed, result.failed ? "warning" : "success");
        if (result.failed) throw new Error("部分图片复筛失败，已保存结果，可继续");
      }
      return current;
    } finally {
      if (current !== p) await saveTranslation({ ...current, images: working.slice() });
    }
  }
  if(phase==="recognize"&&run.imageVisionModel!==undefined&&!run.imageVisionModel)throw new Error("请选择识字视觉模型");
  if(phase==="render"&&run.imageLayoutModel!==undefined&&!run.imageLayoutModel)throw new Error("请选择断行排版模型");
  if (!(p.images || []).some(image => image.selected && (phase === "recognize" ? !image.ocrCompleted : image.ocrCompleted && !unityImageWorkDone(image, run.target)))) { onProgress({ completed: 0, total: 0, detail: "图片已完成或没有选中的图片" }); return p; }
  const visionModel = phase === "recognize" ? run.imageVisionModel : undefined;
  const recognitionGroup = visionModel ? (image: UnityImage) => gameImageVisionForAsset(visionModel, image.name, gameModels) : undefined;
  const localMode = run.imageOcrMode || "fast";
  const fastLocalOcr = !visionModel && localMode === "fast";
  const configuredOcrLanes = Math.max(1, Math.min(8, run.imageConcurrency || imageConcurrency));
  const ocrCount = visionModel ? modelConcurrency(promptState.scope, "recognize", visionModel)
    : fastLocalOcr ? localGameImageScreeningLanes(configuredOcrLanes) : configuredOcrLanes;
  const options: ImageTranslationOptions = phase === "translate" || phase === "review" ? await translationOptions(run, true) :
    { provider: "llm", source: run.source, target: run.target, onlySourceLanguage: run.onlySourceLanguage, skipTargetLanguage: run.skipTargetLanguage }, deviceMessages=new Set<string>(),
    ocr=Array.from({length:ocrCount},()=>createUnityImageOcr(localMode,"auto",(message)=>{if(!deviceMessages.has(message)){deviceMessages.add(message);setMessage(message);}}));
  const activeLocalOcr = () => ocr[0].isGpu && !fastLocalOcr ? Math.min(2, ocrCount) : ocrCount;
  const primaryProvider = options.provider; if (!primaryProvider) throw new Error("未选择图片翻译引擎");
  const imageNames = collectGameImageNames(p.entries, root, options.target || run.target, settings.textGlossary);
  const ocrReuse = createGameImageOcrReuse(promptState.scope + ":images");
  const request = (provider: string, text: string) => translateNamedImageText(text,
    input => runImageRegionTranslation(options, provider, input, controller.signal, phase === "review" ? "review" : "translate", ports), options.target || "", imageNames);
  const translationLanes = Math.max(options.llmConcurrency || 1, options.imageReviewOptions?.llmConcurrency || 1);
  const layoutLanes = run.imageLayoutModel ? modelConcurrency(promptState.scope, "layout", run.imageLayoutModel) : 1;
  const pool = options.provider !== "llm" && options.engineIds?.length ? createUnityEnginePool(options.engineIds.map(id => ({ id, enabled: true })), controller.signal, request, { timingScope: promptState.scope + ":images" }) : null;
  let current = p;
  const cancelOcr = () => { void Promise.all(ocr.map(engine=>engine.dispose())); }; controller.signal.addEventListener("abort", cancelOcr, { once: true });
  let lastPublish=0;
  try {
    if (visionModel && ocrCount > 1) {
      await prepareGameOllamaModels([{
        connection: { ...resolveFeatureLlm(settings, visionModel), localModel: !!loadLocalModelProfiles()[visionModel] },
        lanes: ocrCount,
      }], controller.signal, imageLog);
    } else if ((phase === "translate" || phase === "review") && primaryProvider === "llm") {
      const connections = [phase === "review" ? options.imageReviewOptions : options].flatMap(connection =>
        connection?.llmConcurrency && connection.llmConcurrency > 1 ? [{ connection, lanes: connection.llmConcurrency }] : []);
      await prepareGameOllamaModels(connections, controller.signal, imageLog);
    }
    if(phase==="recognize"&&run.imageVisionModel===undefined){await ocr[0].prepare();await Promise.all(ocr.slice(1,activeLocalOcr()).map(engine=>engine.prepare()));}
    current = await processUnityImages(p, controller.signal, {
      trackReview: phase === "review",
      timingScope: promptState.scope + ":images",
      concurrency: ocrCount,
      recognitionGroup,
      translationConcurrency: Math.max(translationLanes, layoutLanes), regionConcurrency: translationLanes,
      targetLanguage: options.target,
      reviewModel: options.imageReviewOptions?.model,
      review: phase === "review" && options.imageReviewOptions?.model ? (image, region) =>
        reviewGameImageTranslation(settings, options.imageReviewOptions!.model!, image, region, options.target || run.target,
          controller.signal, promptState.selection, imageLog) : undefined,
      includeRegion: phase !== "recognize" ? gameImageRegionLanguageFilter(options.source || "auto", options.target || "zh-CN",
        !!options.onlySourceLanguage, !!options.skipTargetLanguage) : undefined,
      cachedRecognition: phase === "recognize" && !visionModel && localMode === "fast" ?
        image => image.screening?.recognition?.profile === "fast:1280:0.3:false" ? image.screening.recognition.lines : undefined : undefined,
      onTranslationFailures: phase === "translate" && options.imageReviewOptions ?
        count => imageLog(count + " 张图片有待复核的区域，已保存成功译文", "warning") : undefined,
      read: image => measureGameAsync(promptState.scope + ":images", "processingMs", () => readUnitySourceImage(p, image, controller.signal)),
      recognize: (blob, stage, worker = 0, image) => {
        if (!visionModel) return measureGameAsync(promptState.scope + ":images", "ocrMs",
          () => ocr[worker % activeLocalOcr()].recognize(blob, stage));
        const model = gameImageVisionForAsset(visionModel, image?.name || "", gameModels);
        const placement = { assetName: image?.name, cleanBase: image && gameImageCleanBase(image, p.images || [],
          candidate => readUnitySourceImage(p, candidate, controller.signal)) };
        return ocrReuse.read(blob, model, placement, controller.signal, () => ocr[worker % ocr.length].recognizeVision(blob, stage, controller.signal,
          fallback => recognizeGameImage(settings, model, blob, controller.signal, "recognize", promptState.selection,
            { source: run.source, target: run.target, ...placement, names: imageNames }, imageLog, fallback),
          message => imageLog(message, "warning")));
      },
      translate: text => pool ? pool.translate(text) : request(primaryProvider, text), render: (blob,regions,image)=>renderGameImage(settings,run.imageLayoutModel||"",blob,regions,controller.signal,promptState.selection,{source:run.source,target:run.target},(text,level)=>imageLog(`${image.name} · ${text}`,level),{assetName:image.name,cleanBase:gameImageCleanBase(image,p.images||[],candidate=>readUnitySourceImage(p,candidate,controller.signal))}),
      write: (project, image, blob) => measureGameAsync(promptState.scope + ":images", "saveMs", () => writeImage(project, image, blob)),
      persist: async (next, image) => { current = next;if(performance.now()-lastPublish>=100){lastPublish=performance.now();publishTranslation({ ...next, images: [...(next.images || [])] });} const snapshot = structuredClone(image); await persistRenderedState(next, snapshot); },
      validate: (source, translated) => gameImageTranslationProblem(source, translated, options.target),
    }, onProgress, run.imageConfidenceThreshold ?? 50, phase === "translate" || phase === "review" ? "translate-only" : phase);
    if (ocrReuse.hits) imageLog(`已复用 ${ocrReuse.hits} 张相同图片的正式识别结果`, "info");
    return current;
  } finally { pool?.dispose(); controller.signal.removeEventListener("abort", cancelOcr); await Promise.all(ocr.map(engine=>engine.dispose())); await saveTranslation(current); }
}

export async function runImagePasses(phases: readonly UnityImagePhase[], signal: AbortSignal, ports: ImagePassPorts) {
  for (const phase of phases) {
    signal.throwIfAborted();
    if (phase === "redraw" && !ports.hasRedrawTargets()) continue;
    ports.beginPhase(phase);
    if (await ports.commitConfiguration(phase) === false) throw new Error(unityImagePhaseNames[phase] + "配置保存失败");
    signal.throwIfAborted();
    await ports.executePhase();
    ports.completePhase(phase);
  }
}
