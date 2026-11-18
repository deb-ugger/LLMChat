import { LocalPaddleOcr } from "./ocr/paddleOcr";
import type { OcrMode } from "./api";
import { measureGameAsync, measureGameWork } from "./gameModelPerformance";
import {applyImageTextRules, IMAGE_TEXT_RULE_VERSION} from "./imageTextRules";
import type { PaddleOcrLine } from "./ocr/paddleOcr";
import type { UnityImage, UnityProject } from "./unityOffline";
import { gameTextMatchesSource, gameTextNeedsNoTranslation } from "./gameDisplayText";

export const IMAGE_PRESENCE_CONFLICT = "复筛结果同时包含无文字判断和文字证据";
export const IMAGE_PRESENCE_REVIEW_HINT = "可将「复筛方式」切换为「本地筛选」，选择 PP-OCRv6 Medium，保存后运行复筛；也可打开原图手动确认，有字移到「待正式识别」，无字移到「未检测到文字」，再继续复筛。";

export type ImageScreening = {
  rules?:number; strategy?: "staged"|"full"; model?: string; version: 1; sourceHash: string; source: string; target: string;
  state: "candidate" | "no-text" | "review" | "not-needed" | "failed";
  recognition?:{profile:string;lines:PaddleOcrLine[];detectedBoxes:number};
  boxes: number; reason: string;
  refineKey?: string; refineFailed?: boolean;
  manualGroup?: boolean;
  presence?: ImagePresence;
  beforeRefine?: Pick<ImageScreening, "state" | "reason" | "boxes">;
  sourceSkip?: string;
};
type Options = { timingScope?: string; resume?:boolean; source:string;target:string;strategy?:"staged"|"full";concurrency?:number;model?:string; confidenceThreshold?: number };
export type ImagePresence = { textProbability: number };
export function imagePresenceThresholds(threshold: number) {
  return { text: Math.max(50, threshold), noText: Math.min(50, 100 - threshold) };
}
type Recognition = { profile?:string;lines:PaddleOcrLine[];detectedBoxes:number; presence?: ImagePresence };
const language=(value:string)=>value.trim().toLowerCase().replace(/_/g,"-");

export function classifyImageText(result:Recognition,options:Options):Pick<ImageScreening,"state"|"reason"> {
  const text=result.lines.map(line=>line.text.trim()).filter(Boolean).join(" ");
  if(!result.detectedBoxes&&!text)return {state:"no-text",reason:"未检测到文字区域"};
  if(!text)return {state:"review",reason:"检测到区域，但未识别出文字"};
  if(!/\p{L}/u.test(text))return {state:"not-needed",reason:"仅数字或符号"};
  const threshold = options.confidenceThreshold ?? 50;
  const confident=result.lines.filter(line=>line.confidence>=threshold&&/\p{L}/u.test(line.text)).map(line=>line.text).join(" ");
  if(!confident)return {state:"review",reason:`文字置信度低于 ${threshold}%`};
  const source=language(options.source),target=language(options.target),src=source.split("-")[0],dst=target.split("-")[0];
  if(src!=="auto"&&source===target)return {state:"not-needed",reason:"源语言与目标语言相同"};
  const kana=/[\u3040-\u30ff]/u.test(confident),hangul=/[\uac00-\ud7af]/u.test(confident),han=/\p{Script=Han}/u.test(confident),latin=/\p{Script=Latin}/u.test(confident);
  if((dst==="ja"&&kana&&/^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{N}\p{P}\p{S}\p{M}\s]+$/u.test(confident))||(dst==="ko"&&hangul&&/^[\p{Script=Hangul}\p{N}\p{P}\p{S}\p{M}\s]+$/u.test(confident)))return {state:"not-needed",reason:"文字已属于目标语言"};
  if(dst==="zh"&&han&&!kana&&!hangul&&!latin){
    if(src==="ja"||src==="ko")return {state:"candidate",reason:"按指定源语言识别的文字"};
    if(src==="zh"&&source!==target)return {state:"candidate",reason:"按指定中文变体转换"};
    return {state:"review",reason:"纯汉字无法可靠区分中文与日文"};
  }
  if(dst==="en"&&latin&&!han&&!kana&&!hangul){
    if(src!=="auto"&&src!=="en")return {state:"candidate",reason:"按指定源语言翻译"};
    return {state:"review",reason:"拉丁文字需确认是否已是目标语言"};
  }
  return {state:"candidate",reason:"检测到可翻译文字"};
}

export function coarseImageReason(image:UnityImage):string|null {
  if(image.selectionManual)return null;
  const file=image.file.replace(/\\/g,"/").toLowerCase();
  const group=file.match(/(?:^|\/)img\/(animations|characters|sv_actors|sv_enemies|tilesets)\//)?.[1];
  return group?`粗筛跳过 ${group} 素材，可手动改选或使用完整筛选`:null;
}
export function needsGameImageRefinement(image: UnityImage, key: string) {
  const screening = image.screening;
  const state = screening?.beforeRefine?.state ?? screening?.state;
  return !!image.sourceFile && !image.completed && !image.ocrCompleted && !imageManuallyExcluded(image) && !screening?.manualGroup &&
    selectedScreeningState(state) && (!imageRefinementKeyMatches(screening?.refineKey, key) || !!screening?.refineFailed);
}

export function imageRefinementKeyMatches(saved: string | undefined, current: string) {
  if (!saved || saved === current) return saved === current;
  try {
    const legacy = JSON.parse(saved);
    return Array.isArray(legacy) && legacy.length === 6 &&
      JSON.stringify([legacy[0], ...legacy.slice(3)]) === current;
  } catch { return false; }
}

export function gameImageMatchesSource(text: string, source: string) {
  return gameTextMatchesSource(text, source) ||
    (source === "ja" && /\p{Script=Han}/u.test(text) &&
      !/[\p{Script=Hangul}\p{Script=Latin}\p{Script=Cyrillic}]/u.test(text) &&
      !gameImageAlreadyTarget(text, "zh-CN") && !gameImageAlreadyTarget(text, "zh-TW"));
}

export function gameImageAlreadyTarget(text: string, target: string) {
  if (gameTextNeedsNoTranslation(text, target)) return true;
  // Common simplified forms whose Japanese counterparts use a different character.
  return target === "zh-CN" && /[缚敌两弹术击伤败获归战迟]/u.test(text) &&
    !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

export function gameImageRegionLanguageFilter(source: string, target: string, onlySource: boolean, skipTarget: boolean) {
  return (text: string) => (!onlySource || gameImageMatchesSource(text, source)) &&
    (!skipTarget || !gameImageAlreadyTarget(text, target));
}

export function skipGameImageOutsideSource(image: UnityImage, matches: (text: string) => boolean, source: string, skipTarget?: string) {
  const screening = image.screening;
  if (!screening || !image.ocrCompleted || image.renderedKind === "imported" || (!source && !skipTarget)) return image;
  const recognized = image.regions.filter(region => region.text.trim());
  if (!recognized.length || recognized.some(region => matches(region.text) &&
      (!skipTarget || !gameImageAlreadyTarget(region.text, skipTarget)))) return image;
  return { ...image, selected: false, error: "", screening: { ...screening, sourceSkip: source || skipTarget } };
}

export function restoreGameImageSourceSkip(image: UnityImage) {
  if (!image.screening?.sourceSkip) return image;
  const { sourceSkip, ...screening } = image.screening;
  return { ...image, selected: true, screening };
}

export function gameImageTranslationReadiness(recognitionReady: boolean, initialPending: boolean, hasUntranslated: boolean, reviewConfigured: boolean) {
  const initialReady = recognitionReady && !initialPending;
  return { textDone: initialReady && !hasUntranslated, reviewReady: initialReady && hasUntranslated && reviewConfigured };
}

export const imageManuallyExcluded = (image: UnityImage) => image.selectionManual === true && !image.selected;
export const needsGameImageScreening = (image: UnityImage) => !!image.sourceFile && !image.completed &&
  (!image.screening || image.screening.state === "failed" && !imageManuallyExcluded(image));
const selectedScreeningState = (state: ImageScreening["state"] | undefined) => state === "candidate" || state === "review";

export type ManualImageGroup = Exclude<ImageScreening["state"], "failed">;

export function moveScreenedImageToGroup(image: UnityImage, state: ManualImageGroup): UnityImage {
  if (!image.sourceFile || !image.screening || image.completed && !image.ocrCompleted) return image;
  const hasRecognizedText = image.regions.some(region => !!region.text.trim());
  if (state === "candidate" && image.ocrCompleted && !hasRecognizedText) return image;
  const { beforeRefine, refineKey, refineFailed, presence, sourceSkip, ...screening } = image.screening;
  return { ...image, selected: selectedScreeningState(state) && (!image.ocrCompleted || hasRecognizedText), selectionManual: true,
    error: screening.state === "failed" ? "" : image.error,
    screening: { ...screening, state, reason: "手动调整分组", manualGroup: true } };
}

export function restoreReviewSelection(image: UnityImage): UnityImage {
  if (image.sourceFile && image.screening?.state === "review" && !image.selected && !image.selectionManual && !image.ocrCompleted && !image.completed) {
    return { ...image, selected: true };
  }
  return image;
}

export function clearGameImageRefinement(image: UnityImage): UnityImage {
  const screening = image.screening;
  if (!screening?.refineKey) return image;
  const { beforeRefine, refineKey, refineFailed, presence, ...result } = screening;
  const initial = beforeRefine ? { ...result, ...beforeRefine } : result;
  return { ...image, screening: initial, selected: image.selectionManual ? image.selected : selectedScreeningState(initial.state) };
}

function classifyGameImage(image: UnityImage, result: Recognition, options: Options, reuse = false) {
  return measureGameWork(options.timingScope, "processingMs", () => {
    const threshold = options.confidenceThreshold ?? 50;
    if (result.presence) {
      const { textProbability } = result.presence;
      const limits = imagePresenceThresholds(threshold);
      if (textProbability < 50 && textProbability <= limits.noText) {
        return { state: "no-text" as const, reason: `未发现可读文字（文字存在概率 ${textProbability}%）` };
      }
      if (textProbability > 50 && textProbability >= limits.text) {
        return { state: "candidate" as const, reason: `存在可读文字（概率 ${textProbability}%）` };
      }
      return { state: "review" as const, reason: `判断不明确，文字存在概率 ${textProbability}%（复筛阈值 ${threshold}%）` };
    }
    const regions = applyImageTextRules(reuse ? image.regions : result.lines.map(line => ({ ...line, translation: "", selected: true, error: "" })), threshold, image);
    const initial = classifyImageText(result, options);
    return initial.state === "candidate" && regions.every(region => !region.selected)
      ? { state: "review" as const, reason: "文字区域疑似误检，需人工确认" } : initial;
  });
}

export class ScreeningModelError extends Error {}

/** Share successful results only for byte-identical inputs within the current stage. */
function reuseScreenRecognition(images: UnityImage[], signal: AbortSignal, timingScope?: string) {
  const dimensions = (image: UnityImage) => `${image.width}x${image.height}`;
  const sizes = new Map<string, number>();
  for (const image of images) {
    const key = dimensions(image);
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  const results = new Map<string, Promise<Recognition>>();
  return async (image: UnityImage, blob: Blob, recognize: () => Promise<Recognition>) => {
    if ((sizes.get(dimensions(image)) ?? 0) < 2 || !globalThis.crypto?.subtle) return recognize();
    const digest = await measureGameAsync(timingScope, "processingMs", async () =>
      crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    signal.throwIfAborted();
    const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const existing = results.get(key);
    if (existing) {
      try { return await existing; }
      catch (error) {
        // A failed request must not turn identical files into failed matches.
        signal.throwIfAborted();
        if (error instanceof ScreeningModelError) throw error;
        return recognize();
      }
    }
    const pending = Promise.resolve().then(recognize).catch(error => {
      results.delete(key);
      throw error;
    });
    results.set(key, pending);
    return pending;
  };
}

export async function screenGameImages(project:UnityProject,signal:AbortSignal,options:Options,services:{
  read:(image:UnityImage)=>Promise<Blob>;
  recognize:(image:Blob,stage:(value:string)=>void,worker?:number)=>Promise<Recognition>;
  persist:(images:UnityImage[])=>Promise<void>;
},progress:(value:{completed:number;total:number;detail:string;etaMs?:number})=>void) {
  const images=(project.images||[]).filter(image=>image.sourceFile&&!image.completed),strategy=options.strategy||"full";
  const pending:UnityImage[]=[];let completed=0,writeQueue=Promise.resolve(),next=0,deepDone=0;
  const counts={candidate:0,"no-text":0,review:0,"not-needed":0,failed:0},work:UnityImage[]=[];
  const flush=()=>{if(pending.length){const rows=pending.splice(0);writeQueue=writeQueue.then(()=>services.persist(rows));}return writeQueue;};
  const policy=(image:UnityImage,state:ImageScreening["state"],reason:string,boxes=0):ImageScreening=>({version:1,rules:IMAGE_TEXT_RULE_VERSION,strategy,model:options.model||"fast",sourceHash:image.sourceHash,source:options.source,target:options.target,state,reason,boxes});
  const samples:Array<{time:number;done:number}>=[];
  const eta=()=>{if(deepDone===work.length)return 0;if(samples.length<3)return undefined;const first=samples[0],last=samples[samples.length-1],rate=(last.done-first.done)/(last.time-first.time);return rate>0?Math.max(0,(work.length-deepDone)/rate):undefined;};
  const report=(detail:string)=>progress({completed,total:images.length,detail,etaMs:eta()});
  // Cheap resource-type pass before any image decoding or model initialization.
  for(const image of images){signal.throwIfAborted();const old=image.screening;
    if (old?.state === "failed" && imageManuallyExcluded(image)) { counts["not-needed"]++; completed++; continue; }
    if (old?.manualGroup && old.sourceHash === image.sourceHash) { counts[old.state]++; completed++; continue; }
    if (old?.version === 1 && old.rules === IMAGE_TEXT_RULE_VERSION && old.sourceHash === image.sourceHash &&
        old.source === options.source && old.target === options.target && old.state !== "failed" &&
        (old.strategy || "full") === strategy && (old.model || "fast") === (options.model || "fast")) {
      counts[old.state]++; completed++; continue;
    }
    const reason=strategy==="staged"?measureGameWork(options.timingScope, "processingMs", () => coarseImageReason(image)):null;
    if(reason){pending.push({...image,selected:false,screening:policy(image,"not-needed",reason)});counts["not-needed"]++;completed++;if(pending.length>=128)await flush();}
    else work.push(image);
  }
  report(`素材粗筛完成 · ${work.length} 张进入文字检测`);await flush();
  const recognizeBytes = reuseScreenRecognition(work, signal, options.timingScope);
  let failure:unknown;
  const take=()=>{if(failure||signal.aborted||next>=work.length)return null;const original=work[next++];return {original,read:original.ocrCompleted?null:services.read(original).then(blob=>({blob,error:undefined}),error=>({blob:undefined,error}))};};
  const worker=async(workerId:number)=>{let item=take();while(!failure&&item){signal.throwIfAborted();const {original,read}=item;item=take();let image:UnityImage={...original};report(`检测文字：${image.name}`);
    try {
      const reuse = image.ocrCompleted && (!image.screening || image.selectionManual ||
        (image.screening.sourceHash === image.sourceHash && image.screening.source === options.source &&
          image.screening.target === options.target && (image.screening.strategy || "full") === strategy &&
          (image.screening.model || "fast") === (options.model || "fast")));
      const blobForImage = () => !read ? services.read(image) : read.then(value => {
        if (value.error) throw value.error;
        return value.blob!;
      });
      const stage = (detail: string) => report(image.name + " · " + detail);
      let result: Recognition;
      if (reuse) result = { lines: image.regions, detectedBoxes: image.screening?.boxes ?? image.regions.length };
      else {
        const blob = await blobForImage();
        result = await recognizeBytes(image, blob, () => services.recognize(blob, stage, workerId));
      }
      signal.throwIfAborted();
      const classification = classifyGameImage(image, result, options, reuse);
      const screening = policy(image, classification.state, classification.reason, result.detectedBoxes);
      if (result.profile && (classification.state === "candidate" || classification.state === "review")) {
        screening.recognition = { profile: result.profile, lines: result.lines, detectedBoxes: result.detectedBoxes };
      }
      image = { ...image, error: "", screening };
      if (!image.selectionManual) image.selected = selectedScreeningState(classification.state);
    }catch(error){if(signal.aborted||error instanceof ScreeningModelError)throw error;image={...image,screening:policy(image,"failed",String(error)),error:String(error)};if(!image.selectionManual)image.selected=false;}
    counts[image.screening!.state]++;pending.push(image);completed++;deepDone++;samples.push({time:performance.now(),done:deepDone});if(samples.length>64)samples.shift();if(pending.length>=16)await flush();report(`文字筛选 ${completed} / ${images.length}`);
  }};
  const concurrency = Math.max(1, Math.min(8, options.concurrency || 1));
  const runWorkers = async (count: number, run: (index: number) => Promise<void>) => {
    try {
      const results = await Promise.allSettled(Array.from({ length: count }, (_, index) => run(index).catch(error => {
        failure = error;
        throw error;
      })));
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) throw rejected.reason;
    } finally { await flush(); }
  };
  await runWorkers(concurrency, worker);
  return counts;
}

export type LocalRefineMode = Extract<OcrMode, "fast" | "precise" | "english">;
export const LOCAL_REFINE_MODELS: { id: LocalRefineMode; title: string; description: string }[] = [
  { id: "fast", title: "PP-OCRv6 Small", description: "轻量中英日混合文字，适合普通菜单和界面。" },
  { id: "precise", title: "PP-OCRv6 Medium", description: "适合细小文字、复杂底图或低清晰度截图。" },
  { id: "english", title: "PP-OCRv5 Mobile（英文增强）", description: "使用 PP-OCRv6 Medium 检测，适合纯英文菜单、缩写和标签。" },
];

export function createLocalImageRefiner(mode: LocalRefineMode, concurrency: number, timingScope?: string,
  onDevice?: (message: string, fallback: boolean) => void) {
  const workers = Array.from({ length: concurrency }, () => new LocalPaddleOcr(mode, {
    upscale: false, maxSide: 1600, boxThresh: .3, onDevice,
  }));
  return {
    prepare: () => workers[0].prepare(),
    recognize: (blob: Blob, index: number) => {
      const worker = workers[workers[0].isGpu ? index % Math.min(2, workers.length) : index];
      return measureGameAsync(timingScope, "processingMs", () => worker.recognize(blob));
    },
    dispose: async () => { await Promise.all(workers.map(worker => worker.dispose())); },
  };
}

export async function refineGameImages(images: UnityImage[], signal: AbortSignal, options: Omit<Options, "source" | "target"> & Partial<Pick<Options, "source" | "target">> & { refineKey: string; local?: boolean }, services: {
  read: (image: UnityImage) => Promise<Blob>;
  recognize: (blob: Blob, worker: number) => Promise<Recognition>;
  persist: (images: UnityImage[]) => Promise<void>;
}, progress: (value: { completed: number; total: number; detail: string }) => void) {
  const queue = images.filter(image => needsGameImageRefinement(image, options.refineKey));
  const recognizeBytes = reuseScreenRecognition(queue, signal, options.timingScope);
  const total = queue.length;
  let next = 0, completed = 0;
  let pending: UnityImage[] = [], writes = Promise.resolve();
  const flush = () => {
    if (pending.length) {
      const batch = pending;
      pending = [];
      writes = writes.then(() => services.persist(batch));
    }
    return writes;
  };
  const counts = { candidate: 0, review: 0, "no-text": 0, "not-needed": 0, failed: 0 };
  let promoted = 0, removed = 0, changed = 0, unchanged = 0;
  const method = options.local ? "本地复筛" : "视觉模型复筛";
  progress({ completed, total, detail: "正在复筛待复核和待正式识别的图片" });
  try {
    const results = await Promise.allSettled(Array.from({ length: Math.min(options.concurrency || 1, total) }, async (_, worker) => {
      while (next < total) {
        signal.throwIfAborted();
        const image = clearGameImageRefinement(queue[next++]);
        const initial = image.screening!;
        let screening: ImageScreening;
        try {
          const blob = await services.read(image);
          const result = await recognizeBytes(image, blob, () => services.recognize(blob, worker));
          signal.throwIfAborted();
          const classification = classifyGameImage(image, result, { ...options, source: options.source ?? initial.source, target: options.target ?? initial.target });
          screening = { ...initial, ...classification, presence: result.presence, boxes: result.presence ? initial.boxes : result.detectedBoxes, reason: method + "：" + classification.reason,
            beforeRefine: { state: initial.state, reason: initial.reason, boxes: initial.boxes }, refineKey: options.refineKey };
        } catch (error) {
          signal.throwIfAborted();
          screening = { ...initial, refineKey: options.refineKey, refineFailed: true,
            beforeRefine: { state: initial.state, reason: initial.reason, boxes: initial.boxes },
            reason: method + "未完成：" + (error instanceof Error ? error.message : String(error)) };
        }
        pending.push({ ...image, screening, selected: image.selectionManual ? image.selected : selectedScreeningState(screening.state) });
        const state = screening.state;
        counts[screening.refineFailed ? "failed" : state]++;
        if (!screening.refineFailed && initial.state !== state) {
          changed++;
          if (state === "candidate") promoted++;
          else if (initial.state === "candidate") removed++;
        } else if (!screening.refineFailed) unchanged++;
        completed++;
        progress({ completed, total, detail: method + " " + completed + " / " + total });
        if (pending.length >= 16) await flush();
      }
    }));
    const rejected = results.find(result => result.status === "rejected");
    if (rejected) throw rejected.reason;
  } finally { await flush(); }
  return { completed, counts, promoted, removed, changed, unchanged };
}
