import { isBenchmarkRunning } from "../benchmark/benchmarkRunner";
import { readMosaicSettings, saveMosaicSettings } from "../gameMosaic";
import { GameMosaicWorkbench, type GameMosaicDeploymentHandle } from "./GameMosaicWorkbench";
import { matchImagePatchConflicts, resetImageGroupHistory } from "../gameImageGroupChanges";
import { showAppNotice } from "./AppNotice";
import type { BenchmarkImageSource } from "./GameTextBenchmarkDialog";
import { beginGameStep, finishGameStep, modelConcurrency, clearGamePerformance, measureGameAsync, reportGameStepItems } from "../gameModelPerformance";
import { UnityProjectLoading } from "./UnityProjectLoading";
import { translateGameWithOllama, prepareGameOllamaModels, prepareGameOllamaParallel, reportRefinementGpu } from "../gameOllama";
import { GamePromptContext, useGamePromptSelection, gameTaskPrompt } from "../gamePrompts";
import { classifyGameImagePresence, gameImageTranslationProblem, mergeGameImageFieldLines, recognizeGameImage, renderGameImage } from "../gameImageModel";
import { recognizeLocalGameImage } from "../gameImageRecognitionInput";
import { createGameImageOcrReuse, savedGameImageRedraw, defaultGameImageReview, defaultGameImageTranslation, defaultGameImageVision, gameImageCleanBase, gameImageRedrawSelected, gameImageRedrawSummary, gameImageVisionForAsset, redrawGameImages, styleRedrawLabels, type StyleRedrawProfileId } from "../gameImagePlacement";
import { readRpgGameImageNames, translateNamedImageText, type ImageNameMemory } from "../gameImageNames";
import { applyGameTestRoles, captureGameTestRoles, loadGameWorkflowEngines, saveGameWorkflowEngines, type GameTestConfiguration, type GameTestConfigurationAccess } from "../gameModelPreset";
import { GameFlowSequence, type GameFlowStep, type GameStepConfigurationCommit } from "./GameFlowSequence";
import { GameStepProgress } from "./GameStepProgress";
import { gameAvailableModels, GameModelSelect, GameProcessingTabs, GameTranslationTabs } from "./GameTranslationTabs";
import { logRuntimeError } from "../runtimeLog";
import { useGameActionConfirm } from "./GameActionConfirm";
import { registerAppCloseGuard } from "../appClose";
import { isTauri } from "@tauri-apps/api/core";
import { ClosingProgress,useClosingProgress } from "./ClosingProgress";
import { imageImportPng,type GameImportSource } from "../gameImageImport";
import type { ImageArchiveReplacement } from "../gameImageArchive";
import { createPortal } from "react-dom";
import { UnityDescriptionSelect } from "./UnityDescriptionSelect";
import {useGameImageTask,imageTaskDuration,type GameImageTask} from "../hooks/useGameImageTask";
import { LocalPaddleOcr } from "../ocr/paddleOcr";
import { classifyImageText, screenGameImages, ScreeningModelError, needsGameImageScreening, needsGameImageRefinement, restoreReviewSelection, clearGameImageRefinement, refineGameImages, createLocalImageRefiner, LOCAL_REFINE_MODELS, imagePresenceThresholds, imageRefinementKeyMatches, gameImageAlreadyTarget, gameImageMatchesSource, skipGameImageOutsideSource, restoreGameImageSourceSkip, restoreGameImageRecognition, gameImageTranslationReadiness, GAME_IMAGE_SCREENING_LANES, localGameImageScreeningLanes } from "../gameImageScreening";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { API_BASE, type OcrMode, type Settings } from "../api";
import { engineReady, parseEngineKeys } from "../translateEngines";
import { loadLocalModelProfiles, resolveFeatureLlm } from "../modelPresets";
import { buildUnityTranslateOptions, UNITY_LANGUAGES } from "../unityTranslation";
import { createUnityEnginePool, normalizeUnityEngines } from "../unityEnginePool";
import { UnityEngineList } from "./UnityEngineList";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { normalizeUnityImageSelection, createUnityImageOcr, translateCurrentUnityImage, mergeUnityOcrLines, processUnityImages, unityImageResultGroup, unityImageTranslationRegions } from "../unityImages";
import type { UnityImage, UnityImageRegion, UnityProgress, UnityProject } from "../unityOffline";
import { unityImageReadyForTarget, unityImageWorkDone, tagLegacyImageTargets, tagEditedImageTranslations, rememberLegacyGameTarget, measureDeploymentStage } from "../unityWorkflow";
import { ImagePreviewReaderContext, UnityImageWorkbench } from "./UnityImageWorkbench";
import { reconcileImageEdit } from "../unityImageEdits";
import "../unityOffline.css";

type ReviewedRegion = UnityImageRegion & {beforeReview?:{translation:string;error:string}};
const EMPTY_GAME_IMAGES:UnityImage[]=[];
type ImageScanTiming = { parsed:number; reused:number; loadMs:number; listMs:number; parseMs:number };
export type GameImageInfo = {scanTiming?:ImageScanTiming;state:string;stage:string;complete:boolean;count:number|null;folder:string;exists:boolean|null;loaded:boolean;selected:number;valid:number;
  operation?: { label: string; detail?: string; completed?: number; total?: number }};
const imageOperationLabels = {
  filter: "筛选图片", refine: "复筛图片", recognize: "识字与定位", translate: "翻译图片文字",
  review: "复核与重译", render: "生成译图", redraw: "AI 风格重绘", restore: "应用译图", other: "图片工程",
};
type ImageTestConfiguration = NonNullable<GameTestConfiguration["images"]>;
export type GameImageHandle = {
  benchmark: () => BenchmarkImageSource;
  automatic: (signal: AbortSignal) => Promise<boolean>;
  stop: () => void;
  ensureIndex: (signal: AbortSignal) => Promise<number>;
  saveChanges: () => Promise<void>;
  prepare: () => Promise<boolean>;
  generate: (signal: AbortSignal) => Promise<string[]>;
  outputIds: () => string[];
  apply: (ids: string[]) => Promise<boolean>;
  uninstall: () => Promise<boolean>;
  captureTestConfiguration: () => ImageTestConfiguration;
  applyTestConfiguration: (preset: ImageTestConfiguration) => Promise<void>;
};
export function GameImageWorkbench({ handle, gamePath, settings, backupMode, mosaicDeployment, mosaicActive, mosaicDisabled, onMosaicBusy, backupScopes, workflowStage,onTaskStateChange,patchConflictPaths,onMatchedPatchConflicts,leaveGuard,workspaceTargets,scanRequest=0,skipped,onSkip,onResetSkipped,active, disabled, onBusy, onMessage, testConfigurations, testConfigurationDisabled }: { handle?: {current: GameImageHandle | null}; workspaceTargets:{controls:HTMLElement|null;results:HTMLElement|null};scanRequest?:number;skipped:boolean;onSkip:()=>void;onResetSkipped:()=>void;leaveGuard?:{current:((change:()=>void)=>void)|null};onTaskStateChange?:(value:GameImageInfo)=>void;patchConflictPaths:readonly string[];onMatchedPatchConflicts?:(paths:ReadonlySet<string>)=>void;backupScopes:string[];workflowStage?:"images"|"apply";gamePath:string;settings:Settings;backupMode:string;mosaicDeployment?:{current:GameMosaicDeploymentHandle|null};mosaicActive?:boolean;mosaicDisabled?:boolean;onMosaicBusy?:(value:boolean)=>void;active:boolean;disabled:boolean;onBusy:(value:boolean)=>void;onMessage:(value:string,level?:"info"|"warning"|"error"|"success")=>void;testConfigurations?:GameTestConfigurationAccess;testConfigurationDisabled?:boolean }) {
  const promptState=useGamePromptSelection(gamePath + ":images");
  const {phase:closingPhase,show:showClosing,clear:clearClosing}=useClosingProgress();
  const operationWork=useRef<Promise<boolean>|null>(null),reading=useRef(false);
  const task=useGameImageTask(gamePath);
  const pendingKind = task.task?.kind;
  const pendingPhase = pendingKind === "scan" || pendingKind === "screen" ? "filter" : pendingKind;
  const confirmation = useGameActionConfirm(text => onMessage(text)); const confirm = confirmation.confirm;
  const [imagePhaseStarted, setImagePhaseStarted] = useState<"initial" | "filter" | "recognize" | "translate" | "cache">(() => task.task?.kind === "translate" ? "translate" : task.task?.kind === "screen" ? "filter" : task.task?.kind === "recognize" ? "recognize" : "initial");
  const etaUpdate=useRef({time:0,value:undefined as number|undefined});
  const lastProgressPaint=useRef(0),operationActive=useRef(false);
  const publishProgress=(value:Pick<UnityProgress,"detail"|"completed"|"total"|"redrawFailed">&{etaMs?:number})=>{
    if(!operationActive.current)return;
    if (value.total !== null) reportGameStepItems(promptState.scope + ":images", operationStep.current, value.completed, value.redrawFailed);
    const now=performance.now();if(value.etaMs!==undefined&&(now-etaUpdate.current.time>=1000||value.etaMs===0))etaUpdate.current={time:now,value:value.etaMs};if(now-lastProgressPaint.current>=100||value.completed===value.total){lastProgressPaint.current=now;setProgress({...value,etaMs:etaUpdate.current.value,state:"working"});}};
  const [existing,setExisting]=useState<boolean|null>(null);
  const [project,setProject]=useState<UnityProject|null>(null),current=useRef(project);current.current=project;
  const [busy,setBusy]=useState(""),[dirty,setDirty]=useState(false);
  const operationStep=useRef<"filter"|"refine"|"recognize"|"translate"|"review"|"render"|"redraw"|"restore"|"other">(pendingPhase || "other");
  const [progress,setProgress]=useState<{detail:string;etaMs?:number;completed?:number;total?:number|null;redrawFailed?:number;state:"working"|"done"|"error"|"stopped"}|null>(null);
  const operationEpoch=useRef(0);const [clearing,setClearing]=useState(false);
  const originals = useRef(new Map<string,UnityImage>());
  const edits=useRef(new Map<string,UnityImage>()),abort=useRef<AbortController|null>(null);
  const [step,setStep]=useState<"filter"|"refine"|"recognize"|"translate"|"restore">(()=>pendingPhase==="review"||pendingPhase==="render"||pendingPhase==="redraw"?"translate":pendingPhase||"filter");
  const configurationCommit = useRef<GameStepConfigurationCommit | null>(null);
  const [configured, setConfigured] = useState<string | null>(null);
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const backend="auto" as const;
  const deviceMessages=useRef(new Set<string>());
  const reportDevice=(text:string,fallback:boolean)=>{if(!deviceMessages.current.has(text)){deviceMessages.current.add(text);onMessage(text,fallback?"warning":"info");}};
  useEffect(()=>{if(workflowStage==="apply")setStep("restore");else if(workflowStage==="images")setStep(previous=>previous==="restore"?"filter":previous);},[workflowStage]);
  const [savedOptions] = useState<Partial<NonNullable<GameImageTask["options"]>>>(()=>{try{return JSON.parse(localStorage.getItem("llmchat-game-image-options:"+gamePath)||"{}");}catch{return {};}});
  const [strategy,setStrategy]=useState<"staged"|"full">(task.task?.options?.strategy||savedOptions.strategy||"staged"),[concurrency,setConcurrency]=useState(()=>task.task?.options?.concurrency||savedOptions.concurrency||(navigator.hardwareConcurrency>=4?GAME_IMAGE_SCREENING_LANES:1));
  const [mode,setMode]=useState<OcrMode>(task.task?.options?.mode||savedOptions.mode||settings.imageOcrMode as OcrMode||"fast");
  const [provider,setProvider]=useState(task.task?.options?.provider||savedOptions.provider||settings.ocrTranslateProvider),[source,setSource]=useState(savedOptions.source||task.task?.options?.source||settings.ocrTranslateSource||"auto"),[target,setTarget]=useState(savedOptions.target||task.task?.options?.target||settings.ocrTranslateTarget||"zh-CN");
  const models = gameAvailableModels(settings);
  const recommendedTranslation = defaultGameImageTranslation(models);
  const [translationKind,setTranslationKind]=useState<"llm"|"local"|"engine">(task.task?.options?.translationKind||savedOptions.translationKind||(recommendedTranslation?"local":provider==="llm"?"llm":"engine"));
  const [translationModel,setTranslationModel]=useState(task.task?.options?.translationModel??savedOptions.translationModel??recommendedTranslation??"");
  const [engines,setEngines]=useState(() => loadGameWorkflowEngines(promptState.scope)),[engineExpanded,setEngineExpanded]=useState(false);
  useEffect(() => { saveGameWorkflowEngines(promptState.scope, engines); }, [engines, promptState.scope]);
  const [onlySourceLanguage,setOnlySourceLanguage]=useState(savedOptions.onlySourceLanguage??false),[skipTargetLanguage,setSkipTargetLanguage]=useState(savedOptions.skipTargetLanguage??true);
  const sourceFilter = onlySourceLanguage && source !== "auto" ? source : "";
  const includesSource = (text: string) => !sourceFilter || gameImageMatchesSource(text, sourceFilter);
  const targetFilter = skipTargetLanguage ? target : "";
  const includesRegion = (text: string) => includesSource(text) && (!targetFilter || !gameImageAlreadyTarget(text, targetFilter));
  const validateImageTranslation = (original: string, translated: string) => gameImageTranslationProblem(original, translated, target);
  const committedSource = useRef({ source, onlySourceLanguage, filter: sourceFilter, targetFilter, target });
  const groupByLanguage = (image: UnityImage) => skipGameImageOutsideSource(image, includesSource, sourceFilter, targetFilter);
  const mergeRecognizedRegions = (image: UnityImage) => {
    if (!image.ocrCompleted || image.completed || image.regions.length < 2) return image;
    const unedited = (region: UnityImageRegion) => !region.manualSelected && !region.translation && !region.error && !region.reviewReason;
    const regions = mergeGameImageFieldLines(image.regions, (a, b) => a.selected === b.selected && unedited(a) && unedited(b));
    return regions.length === image.regions.length ? image : { ...image, regions };
  };
  const [stageModels,setStageModels] = useState<Record<string,string>>(()=>{
    const saved = localStorage.getItem("llmchat-image-stage-models:"+gamePath);
    if (saved) { try { return JSON.parse(saved); } catch { /* Use initial settings after an invalid value. */ } }
    const recognize = defaultGameImageVision(models);
    return recognize ? { recognize } : {};
  });
  useEffect(()=>{localStorage.setItem("llmchat-image-stage-models:"+gamePath,JSON.stringify(stageModels));},[gamePath,stageModels]);
  const [redrawingId, setRedrawingId] = useState<string>();
  const confidence = Number(stageModels.confidence ?? 50);
  const redrawProfile = (stageModels.redraw || "turbo") as StyleRedrawProfileId;
  const [reviewModel, setReviewModel] = useState(() => task.task?.options?.reviewModel ?? savedOptions.reviewModel ?? defaultGameImageReview(models) ?? "");
  useEffect(()=>{try{localStorage.setItem("llmchat-game-image-options:"+gamePath,JSON.stringify({strategy,concurrency,mode,provider,source:committedSource.current.source,target:committedSource.current.target,translationKind,translationModel,reviewModel,onlySourceLanguage:committedSource.current.onlySourceLanguage,skipTargetLanguage}));}catch(error){onMessage(`图片参数自动保存失败：${String(error)}`,"error");}},[gamePath,strategy,concurrency,mode,provider,source,target,translationKind,translationModel,reviewModel,onlySourceLanguage,skipTargetLanguage]);
  const imageSettings = () => ({ backend, strategy, concurrency, mode, provider, source, target, translationKind, translationModel, reviewModel, onlySourceLanguage, skipTargetLanguage });
  const saveConfiguration = async (options = imageSettings(), stages = stageModels) => {
    const filter = options.onlySourceLanguage && options.source !== "auto" ? options.source : "";
    const targetLanguageFilter = options.skipTargetLanguage ? options.target : "";
    if (current.current && (filter !== committedSource.current.filter || targetLanguageFilter !== committedSource.current.targetFilter)) {
      await save(true);
      flushImages();
      const previous = committedSource.current;
      const includesNext = (text: string) => (!filter || gameImageMatchesSource(text, filter)) && (!targetLanguageFilter || !gameImageAlreadyTarget(text, targetLanguageFilter));
      const rows = (current.current?.images || []).filter(image => image.selected || image.screening?.sourceSkip);
      const restored = rows.map(image => image.regions.some(region => includesNext(region.text)) ? restoreGameImageSourceSkip(image) : image);
      const rerender = restored.filter(image => options.target === previous.target && image.selected && (image.completed || image.renderedFile) && image.renderedKind !== "imported" &&
        unityImageTranslationRegions(image.regions, confidence, image).some(region => region.selected &&
          includesNext(region.text) !== ((!previous.filter || gameImageMatchesSource(region.text, previous.filter)) &&
            (!previous.targetFilter || !gameImageAlreadyTarget(region.text, previous.targetFilter)))));
      const rerenderIds = new Set(rerender.map(image => image.id));
      const reselected = restored.filter((image, index) => image !== rows[index] && !rerenderIds.has(image.id));
      for (let offset = 0; offset < rerender.length; offset += 64) await persistMany(rerender.slice(offset, offset + 64), true);
      for (let offset = 0; offset < reselected.length; offset += 64) await persistMany(reselected.slice(offset, offset + 64));
      flushImages();
    }
    localStorage.setItem("llmchat-game-image-options:" + gamePath, JSON.stringify(options));
    localStorage.setItem("llmchat-image-stage-models:" + gamePath, JSON.stringify(stages));
    committedSource.current = { source: options.source, onlySourceLanguage: options.onlySourceLanguage, filter, targetFilter: targetLanguageFilter, target: options.target };
  };
  const post=useCallback(async <T,>(operation:string,body:unknown={},signal?:AbortSignal):Promise<T>=>{const response=await fetch(`${API_BASE}/api/game-images/${operation}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({gamePath,...body as object}),signal});const value=await response.json();if(!response.ok)throw new Error(value.error||"图片操作失败");return value;},[gamePath]);
  const uiUpdates=useRef(new Map<string,UnityImage>()),uiTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const imageIndex=useRef<{folder:string;length:number;indexes:Map<string,number>}|null>(null);
  const flushImages=useCallback(()=>{
    if(uiTimer.current){clearTimeout(uiTimer.current);uiTimer.current=null;}
    const previous=current.current;if(!previous||!uiUpdates.current.size)return;
    const rows=previous.images||[];
    if(!imageIndex.current||imageIndex.current.folder!==previous.folder||imageIndex.current.length!==rows.length)imageIndex.current={folder:previous.folder,length:rows.length,indexes:new Map(rows.map((row,index)=>[row.id,index]))};
    const nextRows=rows.slice();for(const [id,image] of uiUpdates.current){const index=imageIndex.current.indexes.get(id);if(index!==undefined)nextRows[index]=image;}
    uiUpdates.current.clear();const next={...previous,images:nextRows};current.current=next;setProject(next);
  },[]);
  const mergeImages=useCallback((images:UnityImage[])=>{for(const image of images)uiUpdates.current.set(image.id,image);if(!uiTimer.current)uiTimer.current=setTimeout(flushImages,100);},[flushImages]);
  const update=useCallback((image:UnityImage)=>mergeImages([image]),[mergeImages]);
  const editImages = (values: UnityImage[]) => {
    const rows = current.current?.images || [];
    const byId = values.length > 1 ? new Map(rows.map(row => [row.id, row])) : undefined;
    const changes: UnityImage[] = [];
    for (const value of values) {
      const previous = uiUpdates.current.get(value.id) ?? (byId ? byId.get(value.id) : rows.find(row => row.id === value.id));
      if (!previous) continue;
      const saved = originals.current.get(value.id) ?? previous;
      tagEditedImageTranslations(value, previous, target);
      const next = reconcileImageEdit(value, previous, saved, confidence);
      if (next === previous) continue;
      if (next === saved) {
        originals.current.delete(value.id);
        edits.current.delete(value.id);
      } else {
        originals.current.set(value.id, saved);
        edits.current.set(value.id, next);
      }
      changes.push(next);
    }
    if (!changes.length) return;
    mergeImages(changes);
    flushImages();
    setDirty(edits.current.size > 0);
  };
  useEffect(()=>()=>{if(uiTimer.current)clearTimeout(uiTimer.current);if(reading.current){operationEpoch.current++;abort.current?.abort();void post("stop-read").catch(error=>logRuntimeError("image-preload-stop",error));}},[post]);

  const readImage=useCallback(async (image:UnityImage,translated=false,thumbnail=false,signal?:AbortSignal)=>{
    const query=new URLSearchParams({gamePath,id:image.id,translated:translated?"1":"0"});const response=await fetch(`${API_BASE}/api/game-images/preview?${query}`,{signal});if(!response.ok){const value=await response.json();throw new Error(value.error||"图片读取失败");}const blob=await response.blob();if(!thumbnail)return blob;
    const bitmap=await createImageBitmap(blob);try{const ratio=Math.min(1,256/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));canvas.getContext("2d")!.drawImage(bitmap,0,0,canvas.width,canvas.height);return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("无法生成缩略图")),"image/png"));}finally{bitmap.close();}
  },[gamePath]);
  useEffect(()=>{onBusy(!!busy&&(busy!=="读取图片工程"||active));return()=>onBusy(false);},[busy,active,onBusy]);
  useEffect(()=>()=>{abort.current?.abort();},[gamePath]);
  const persist=async(image:UnityImage)=>{const saved=await post<UnityImage>("save",{image:normalizeUnityImageSelection(image)});edits.current.delete(image.id);originals.current.delete(image.id);update(saved);};
  const save=async(silent=false)=>{if(!edits.current.size)return;const images=[...edits.current.values()];for(let offset=0;offset<images.length;offset+=64)await persistMany(images.slice(offset,offset+64));flushImages();setDirty(false);onResetSkipped();if(!silent){const message="图片与译文保存成功";showAppNotice(message);onMessage(message,"success");}};
  const write=async(image:UnityImage,blob:Blob)=>{const query=new URLSearchParams({gamePath,id:image.id});const response=await fetch(`${API_BASE}/api/game-images/render?${query}`,{method:"POST",headers:{"Content-Type":"image/png"},body:blob});const value=await response.json();if(!response.ok)throw new Error(value.error||"译图保存失败");return value as {path:string;hash:string};};
  const execute=(label:string,operation:()=>Promise<void>,resume?:GameImageTask)=>{
    const run=async()=>{if(operationActive.current||clearing||isBenchmarkRunning()&&!["读取图片工程","保存"].includes(label))return false;const epoch=++operationEpoch.current;operationActive.current=true;const timed=!!resume;if(resume?.kind==="scan"&&task.pendingTask()?.kind!=="scan")task.reset();if(timed)task.begin({...resume,options:{backend,strategy,mode,source,target,concurrency,provider,translationKind,translationModel,reviewModel,onlySourceLanguage,skipTargetLanguage}});let success=false;deviceMessages.current.clear();etaUpdate.current={time:0,value:undefined};operationStep.current=label==="应用译图"||label==="卸载译图"?"restore":label==="生成译图"?"render":label==="复核与重译"?"review":resume?(resume.kind==="scan"||resume.kind==="screen"?"filter":resume.kind):step==="restore"?"restore":"other";if(!["读取图片工程","应用译图","卸载译图","保存"].includes(label))onResetSkipped();onMessage(`开始${label}`);if(label!=="扫描图片"&&!["other","restore"].includes(operationStep.current))beginGameStep(promptState.scope + ":images", operationStep.current);setBusy(label);setProgress({detail:`${label}…`,state:"working"});try{await operation();if(epoch!==operationEpoch.current)return false;abort.current?.signal.throwIfAborted();success=true;if(label!=="复筛图片")onMessage(`${label}完成`,"success");setProgress(previous=>({...previous,detail:previous?.detail.endsWith("…")?`${label}完成`:previous?.detail||`${label}完成`,state:"done"}));}catch(error){if(epoch!==operationEpoch.current)return false;const stopped=!!abort.current?.signal.aborted;const text=stopped?"图片处理已中止，原有工程保留":error instanceof Error?error.message:String(error);setProgress(previous=>({...previous,detail:text,state:stopped?"stopped":"error"}));onMessage(text,stopped?"warning":"error");}finally{if(epoch===operationEpoch.current){flushImages();finishGameStep(promptState.scope + ":images",success);operationActive.current=false;if(timed)task.finish(success);abort.current=null;setBusy("");}}return success;};
    const promise=run();operationWork.current=promise;
    const clear=()=>{if(operationWork.current===promise)operationWork.current=null;};void promise.then(clear,clear);
    return promise;
  };

  const persistMany = async (images: UnityImage[], clearRendered = false) => {
    const saved = await measureGameAsync(promptState.scope + ":images", "saveMs", () => post<UnityImage[]>("save-many", {
      images: images.map(image => ({ ...normalizeUnityImageSelection(image), screening: image.screening ?? null, ...(clearRendered || image.noTranslationNeeded && !image.renderedFile ? { clearRendered: true } : {}) })),
    }));
    if (clearRendered && saved.some(image => image.renderedFile || image.renderedHash)) {
      throw new Error("后端仍返回旧译图缓存，请更新便携版后重试");
    }
    for (const image of saved) {
      edits.current.delete(image.id);
      originals.current.delete(image.id);
    }
    mergeImages(saved);
  };
  useEffect(()=>{let alive=true;void post<{exists:boolean}>("info").then(value=>{if(alive)setExisting(value.exists);}).catch(error=>onMessage(String(error),"error"));return()=>{alive=false;};},[gamePath]);
  const readProject=async(action:"load"|"scan",signal:AbortSignal):Promise<UnityProject|null>=>{
    const response=await fetch(`${API_BASE}/api/game-images/${action}-stream`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({gamePath}),signal});
    if(!response.ok||!response.body)throw new Error(action==="load"?"无法读取图片工程":"无法启动图片扫描");
    const reader=response.body.getReader(),decoder=new TextDecoder();let fragments:string[]=[],received=false,result:UnityProject|null=null;
    const event=(line:string)=>{if(!line.trim())return;const value=JSON.parse(line);if(value.type==="error")throw new Error(value.error);if(value.type==="progress")publishProgress(value);if(value.type==="result"){
      const loaded = value.project as UnityProject | null;
      if (loaded?.images) tagLegacyImageTargets(loaded.images, rememberLegacyGameTarget(gamePath, "images", savedOptions.target || "zh-CN"));
      result = loaded?.images ? { ...loaded, images: loaded.images.map(image => normalizeUnityImageSelection(restoreReviewSelection(image))) } : loaded;
      received=true;
    }};
    const append=(text:string)=>{let start=0,end:number;while((end=text.indexOf("\n",start))>=0){fragments.push(text.slice(start,end));event(fragments.join(""));fragments=[];start=end+1;}if(start<text.length)fragments.push(text.slice(start));};
    try{while(true){const value=await reader.read();if(value.done)break;append(decoder.decode(value.value,{stream:true}));}append(decoder.decode());if(fragments.length)event(fragments.join(""));if(!received)throw new Error("图片工程连接已结束，但未收到完整结果");signal.throwIfAborted();return result;}
    finally{reader.releaseLock();}
  };
  const loadExisting=()=>execute("读取图片工程",async()=>{
    await save(true);const controller=new AbortController();abort.current=controller;reading.current=true;
    try{const value=await readProject("load",controller.signal);imageIndex.current=null;current.current=value;setProject(value);setExisting(!!value);onMessage(value?"图片工程已准备完成":"没有已有图片工程，请先扫描资源",value?"success":"info");}
    finally{reading.current=false;}
  });
  const stopAndClear=async()=>{
    abort.current?.abort();operationEpoch.current++;finishGameStep(promptState.scope + ":images");operationActive.current=false;setBusy("");setClearing(true);
    setProgress({detail:"图片工程读取已中止",state:"stopped"});
    try{await post("stop-read");onMessage("图片读取已停止，读取缓存已清理；原图、译文、译图及备份保留","warning");}
    catch(error){onMessage(error instanceof Error?error.message:String(error),"error");}
    finally{etaUpdate.current={time:0,value:undefined};setProgress(null);setClearing(false);}
  };
  const discardChanges=async()=>{
    if (!originals.current.size) { onMessage("当前没有未保存的图片修改"); return true; }
    flushImages(); const saved = current.current; if (!saved) return false;
    const count = originals.current.size;
    const restored = { ...saved, images: saved.images?.map(image => originals.current.get(image.id) || image) };
    edits.current.clear(); originals.current.clear(); current.current=restored; setProject(restored); setDirty(false);
    onMessage(`已取消 ${count} 张图片的未保存修改`, "success"); return true;
  };
  const closeState=useRef({dirty,save});closeState.current={dirty,save};
  const needsCloseGuard=!!project||!!busy||dirty||clearing;
  useEffect(()=>{
    if(!needsCloseGuard||!isTauri())return;
    let disposed=false,unlisten:(()=>void)|undefined;
    void registerAppCloseGuard(async()=>{
      try{
        if(operationWork.current){const pending=operationWork.current,wasReading=reading.current;await showClosing("正在中止图片处理并保存已完成结果…");abort.current?.abort();if(wasReading)await post("stop-read");await pending;}
        if(closeState.current.dirty){
          clearClosing();
          if(!await confirm("图片勾选、区域或译文有未保存修改，保存后退出？",{title:"退出 LLMChat",okLabel:"保存后退出",cancelLabel:"取消"}))return false;
          await showClosing("正在保存图片与译文修改…");await closeState.current.save(true);
        }
        return true;
      }catch(error){onMessage(`图片退出处理失败：${String(error)}`,"error");return false;}finally{clearClosing();}
    }).then(stop=>{if(disposed)stop();else unlisten=stop;}).catch(error=>onMessage(String(error),"error"));
    return()=>{disposed=true;unlisten?.();};
  },[needsCloseGuard,showClosing,clearClosing]);
  const refineMethod = stageModels.refineMethod || (stageModels.filterRefine ? "llm" : "off");
  const refineModel = refineMethod === "llm" ? stageModels.filterRefine : undefined;
  const refineOcr = LOCAL_REFINE_MODELS.find(item => item.id === stageModels.refineOcr) || LOCAL_REFINE_MODELS[1];
  const refineConcurrency = Number(stageModels.refineConcurrency) || 2;
  const refineConfidence = Number(stageModels.refineConfidence || "50");
  const refineLimits = imagePresenceThresholds(refineConfidence);
  const refineThresholdHint = `当前阈值 ${refineConfidence}%。文字存在概率${refineLimits.text === 50 ? "＞" : "≥"}${refineLimits.text}%判有字，${refineLimits.noText === 50 ? "＜" : "≤"}${refineLimits.noText}%判无字，其余待复核。`;
  const refineKey = refineMethod === "off" ? undefined : JSON.stringify([refineMethod, refineConfidence, refineMethod === "llm" ? "text-probability-1024-1600-v2" : "local-evidence-v2",
    refineMethod === "local" ? refineOcr.id : [refineModel, promptState.selection.refine || "builtin:refine"]]);
  const screen=async(controller:AbortController,resume=false)=>{if(stageModels.filter!==undefined&&!stageModels.filter)throw new Error("请选择筛选视觉模型");task.select({kind:"screen",options:{backend,strategy,mode,source,target,concurrency,provider,translationKind,translationModel,reviewModel,onlySourceLanguage,skipTargetLanguage}});const base=current.current;if(!base)return;
    const screeningLanes=stageModels.filter?modelConcurrency(promptState.scope,"screen",stageModels.filter):localGameImageScreeningLanes(concurrency);
    const workers=Array.from({length:screeningLanes},()=>new LocalPaddleOcr("fast",{upscale:false,maxSide:1280,boxThresh:.3,backend,onDevice:reportDevice}));
    setImagePhaseStarted("filter");
    let prepared:Promise<void>|undefined;

    setProgress({detail:"正在准备分级筛选",state:"working"});
    try{const counts=await screenGameImages(base,controller.signal,{source,target,timingScope:promptState.scope + ":images",strategy:stageModels.filter?"full":strategy,concurrency:screeningLanes,resume,model:stageModels.filter||"fast"},{read:image=>measureGameAsync(promptState.scope + ":images", "processingMs", () => readImage(image,false,false,controller.signal)),recognize:async(blob,stage,index=0)=>{if(stageModels.filter){stage("大模型筛选");const lines=await recognizeGameImage(settings,stageModels.filter,blob,controller.signal,"screen",promptState.selection,{source,target},onMessage,async image=>(await workers[index].recognize(image,stage)).lines);return {lines,detectedBoxes:lines.length};}try{await(prepared??=workers[0].prepare());}catch(error){throw new ScreeningModelError(String(error));}
      const worker=workers[index];
      if(strategy==="full")return measureGameAsync(promptState.scope + ":images", "ocrMs", () => worker.recognize(blob,stage,{maxSide:1280,boxThresh:.3}));
      stage("快速文字检测");const rough=await measureGameAsync(promptState.scope + ":images", "ocrMs", () => worker.recognize(blob,stage,{maxSide:768,boxThresh:.5}));controller.signal.throwIfAborted();
      if(!rough.detectedBoxes)return rough;
      const state=classifyImageText(rough,{source,target}).state;
      if(state==="review"){stage("复核疑似文字");return measureGameAsync(promptState.scope + ":images", "ocrMs", () => worker.recognize(blob,stage,{maxSide:1280,boxThresh:.3}));}return rough;
},persist:persistMany},publishProgress);const detail=`筛选完成 · 候选 ${counts.candidate} · 未检测到字 ${counts["no-text"]} · 待复核 ${counts.review} · 无需翻译 ${counts["not-needed"]} · 失败 ${counts.failed}`;setProgress({detail,state:"done"});onMessage(detail,counts.failed?"warning":"success");if(counts.failed)throw new Error("部分图片筛选失败，请检查失败条目后继续。");}finally{await Promise.all(workers.map(worker=>worker.dispose()));}};

  const filterStep = () => {
    setStep("filter");
    return execute("筛选图片", async () => {
      await save(true);
      const controller = new AbortController();
      abort.current = controller;
      await screen(controller, true);
    }, { kind: "screen" });
  };

  const refineStep = () => {
    if (!refineKey) return Promise.resolve(true);
    setStep("refine");
    return execute("复筛图片", async () => {
      await save(true);
      if (!current.current?.images?.some(image => needsGameImageRefinement(image, refineKey))) {
        setProgress({ detail: "复筛已结束，所选图片均已处理。", state: "done" });
        return;
      }
      if (refineMethod === "llm" && !refineModel) throw new Error("请选择图片复筛模型");
      const controller = new AbortController();
      abort.current = controller;
      const scope = promptState.scope + ":images";
      const concurrency = refineModel ? modelConcurrency(promptState.scope, "refine", refineModel) : refineConcurrency;
      const local = refineMethod === "local" ? createLocalImageRefiner(refineOcr.id, concurrency, scope, reportDevice) : undefined;
      const connection = refineModel ? { ...resolveFeatureLlm(settings, refineModel), localModel: !!loadLocalModelProfiles()[refineModel] } : undefined;
      let gpuChecked = false;
      try {
        if (local) { await local.prepare(); controller.signal.throwIfAborted(); }
        if (connection) await prepareGameOllamaParallel(connection, concurrency, controller.signal, onMessage);
        const result = await refineGameImages(current.current?.images || [], controller.signal,
          { timingScope: scope, refineKey, concurrency, local: !!local, confidenceThreshold: refineConfidence }, {
            read: image => measureGameAsync(scope, "processingMs", () => readImage(image, false, false, controller.signal)),
            recognize: async (blob, worker) => {
              if (local) return local.recognize(blob, worker);
              const presence = await classifyGameImagePresence(settings, refineModel!, blob, controller.signal, promptState.selection, {}, onMessage, refineConfidence);
              if (!gpuChecked && connection) { gpuChecked = true; await reportRefinementGpu(connection, controller.signal, onMessage); }
              return { lines: [], detectedBoxes: 0, presence };
            },
            persist: persistMany,
          }, publishProgress);
        const { completed, counts, promoted, removed, changed, unchanged } = result;
        const detail = `复筛结果已保存 · 已处理 ${completed} 张 · 分类变化 ${changed} · 未变化 ${unchanged} · 待正式识别 ${counts.candidate} · 待复核 ${counts.review} · 未检测到文字 ${counts["no-text"]} · 无需翻译 ${counts["not-needed"]} · 失败 ${counts.failed}。新进入待正式识别 ${promoted} 张，从待正式识别移出 ${removed} 张。`;
        onMessage(detail, counts.failed ? "warning" : "success");
        if (counts.failed) throw new Error("复筛有未完成的图片，已保留初筛结果。请在「失败条目」中查看处理建议，可调整复筛配置后继续，也可手动分组。");
        setProgress({ detail, completed, total: completed, state: "done" });
      } finally { await local?.dispose(); }
    }, { kind: "refine" });
  };

  const scan = () => execute("扫描图片", async () => {
    await measureDeploymentStage(gamePath, "scanImages", async () => {
      await save(true); setImagePhaseStarted("initial");
      const controller = new AbortController(); abort.current = controller;
      const value = await readProject("scan", controller.signal);
      if (!value) throw new Error("扫描没有返回图片工程");
      imageIndex.current = null; current.current = value; setProject(value); setExisting(true);
      const count = value.images?.length ?? 0;
      const detail = "扫描完成 · " + count + " 张图片";
      setProgress({ detail, completed: count, total: count, state: "done" });
      onMessage(detail, "success");
      const timing = (value as UnityProject & { imageScanTiming?: ImageScanTiming }).imageScanTiming;
      return timing ? timing.parsed + timing.reused : count;
    }, count => count);
  }, { kind: "scan" });

  const autoReadAttempted=useRef(false);
  useEffect(()=>{if(existing&&!project&&!busy&&!clearing&&!disabled&&scanRequest<=handledScan.current&&!autoReadAttempted.current){autoReadAttempted.current=true;void loadExisting();}},[existing,project,busy,clearing,disabled,scanRequest]);
  const handledScan=useRef(0);
  useEffect(()=>{if(scanRequest>handledScan.current&&!busy){handledScan.current=scanRequest;scan();}},[scanRequest,busy]);
  const readImageNames = async (signal: AbortSignal) => {
    try {
      const names = await readRpgGameImageNames(gamePath,target,settings.textGlossary,signal);
      if (names.terms.size) onMessage(`已读取工程现有译名 · ${names.terms.size} 项${names.title.length ? " · 包含工程标题" : ""}`,"info");
      if (names.conflicts.length) onMessage(`存在多个已有译名，待术语表确认 · ${names.conflicts.join("、")}`,"warning");
      return names;
    } catch (error) {
      signal.throwIfAborted();
      onMessage(`工程译名读取未完成 · ${String(error)}`,"warning");
      return undefined;
    }
  };
  const createTranslator=(signal:AbortSignal, stage: "combined" | "initial" | "review" = "combined", names?: ImageNameMemory)=>{
    const request=async(engine:typeof provider,text:string)=>{
      if (engine === "llm" && !models.includes(stage === "review" ? reviewModel : translationModel)) throw new Error("请选择图片文字翻译模型");
      const model = stage === "review" && reviewModel ? reviewModel : translationModel;
      const options = buildUnityTranslateOptions(settings, engine, source, target, model, false, !!loadLocalModelProfiles()[model],engine==="llm"?gameTaskPrompt(stage==="review"?"review":"image",promptState.selection,{source,target}):undefined, "keep", {selection:promptState.selection,role:stage==="review"?"review":"image"});
      const translateInput = async (config: typeof options, input: string) => {
        const result = await translateGameWithOllama(input, { signal }, { ...config, autoFallback: false }, onMessage);
        if (!result.ok) throw Object.assign(new Error(result.error || result.code || "图片文字翻译失败"), { code: result.code });
        return result.translation;
      };
      const translate = (config: typeof options) => translateNamedImageText(text,input => translateInput(config,input),target,names);
      const translated = await translate(options);
      if (stage !== "combined" || engine !== "llm" || !reviewModel) return translated;
      if (!validateImageTranslation(text, translated)) return translated;
      return translate(buildUnityTranslateOptions(settings, "llm", source, target, reviewModel, false, !!loadLocalModelProfiles()[reviewModel],gameTaskPrompt("review",promptState.selection,{source,target}), "keep", {selection:promptState.selection,role:"review"}));
    };
    const pool=translationKind==="engine"&&stage!=="review"?createUnityEnginePool(engines.filter(row=>engineReady(parseEngineKeys(settings.translateEngineKeys),row.id)),signal,request,{timingScope:promptState.scope + ":images"}):null;
    return {translate:(text:string)=>pool?pool.translate(text):request("llm",text),concurrency:pool?Math.max(1,pool.concurrency):modelConcurrency(promptState.scope,"image",translationModel || settings.model),regions:pool?1:Math.max(modelConcurrency(promptState.scope,"image",translationModel || settings.model),modelConcurrency(promptState.scope,"review",reviewModel)),dispose:()=>pool?.dispose()};
  };
  const process=(phase:"recognize"|"translate",only?:UnityImage,ocrMode=mode, outputMode: "translate" | "translate-only" | "review" | "render" = "translate", signal?: AbortSignal)=>execute(phase==="recognize"?"识别图片":outputMode==="render"?"生成译图":outputMode==="review"?"复核与重译":"翻译图片",async()=>{
    if(phase==="recognize"&&stageModels.recognize!==undefined&&!stageModels.recognize)throw new Error("请选择识字视觉模型");
    if(phase==="translate"&&outputMode==="render"&&stageModels.render!==undefined&&!stageModels.render)throw new Error("请选择断行排版模型");
    if (phase === "translate" && outputMode === "review" && !models.includes(reviewModel)) throw new Error("请选择可用的图片复核模型");
    if (phase === "translate" && outputMode !== "render" && outputMode !== "review" && translationKind !== "engine" && !models.includes(translationModel)) throw new Error("请为图片翻译选择可用模型");
    if (phase === "translate" && outputMode !== "render" && outputMode !== "review" && translationKind === "engine" && !engines.some(row => row.enabled && engineReady(parseEngineKeys(settings.translateEngineKeys), row.id))) {
      throw new Error("请至少启用一个可用翻译引擎");
    }
    setImagePhaseStarted(phase);
    await save(true);
    signal?.throwIfAborted();
    const base = current.current;
    if (!base) return;
    if (!base.images?.length || base.images.some(needsGameImageScreening)) throw new Error("请先完成扫描与筛选");
    if (phase === "translate" && base.images.some(image => image.selected && !image.ocrCompleted)) throw new Error("请先完成图片识别，再开始翻译");
    if (phase === "recognize" && only && base.images.find(image => image.id === only.id)?.ocrCompleted) {
      onMessage("当前图片已有识字结果", "info");
      return;
    }
    const controller = new AbortController(); abort.current = controller;
    const input = only ? { ...base, images: base.images.map(image => ({ ...image, selected: image.id === only.id })) } : { ...base };
    if (phase === "translate" && outputMode !== "render") {
      const changed: UnityImage[] = [];
      let skipped = 0;
      input.images = input.images?.map(image => {
        if (!image.selected) return image;
        const next = groupByLanguage(outputMode === "review" ? image : mergeRecognizedRegions(image));
        if (next !== image) changed.push(next.selected && only ? { ...next, selected: only.selected } : next);
        if (!next.selected) skipped++;
        return next;
      });
      for (let offset = 0; offset < changed.length; offset += 64) {
        controller.signal.throwIfAborted();
        await persistMany(changed.slice(offset, offset + 64));
      }
      if (skipped) onMessage(`${skipped} 张图片没有需要翻译的文字，已移入「无需翻译」`, "info");
    }
    if(outputMode==="review")input.images=input.images?.map(image=>image.selected?{...image,regions:image.regions.map((region:ReviewedRegion)=>region.selected&&includesRegion(region.text)&&(!region.translation||region.error||validateImageTranslation(region.text,region.translation))?{...region,beforeReview:region.beforeReview||{translation:region.translation,error:region.error}}:region)}:image);
    const visionModel = phase === "recognize" ? stageModels.recognize : undefined;
    const recognitionGroup = visionModel ? (image: UnityImage) => gameImageVisionForAsset(visionModel, image.name, models) : undefined;
    const names = (visionModel || phase === "translate" && outputMode !== "render") ? await readImageNames(controller.signal) : undefined;
    const ocrReuse = createGameImageOcrReuse(promptState.scope + ":images");
    const recognitionLanes = visionModel ? modelConcurrency(promptState.scope, "recognize", visionModel) : concurrency;
    const ocr = Array.from({ length: phase === "recognize" ? recognitionLanes : 1 }, () => createUnityImageOcr(ocrMode, backend, reportDevice));
    let pendingWrites:UnityImage[]=[];let writes=Promise.resolve();let lastWrite=performance.now();
    const flushWrites=()=>{if(pendingWrites.length){const batch=pendingWrites;pendingWrites=[];lastWrite=performance.now();writes=writes.then(()=>persistMany(batch));}return writes;};
    const translator=createTranslator(controller.signal, outputMode === "review" ? "review" : outputMode === "translate-only" ? "initial" : "combined", names);
    const previous=task.task?.options;const reuseTranslations=!previous||previous.source===source&&previous.target===target&&previous.provider===provider;
    try {
      const model = visionModel || (phase === "translate" && outputMode !== "render" && (translationKind !== "engine" || outputMode === "review")
        ? (outputMode === "review" ? reviewModel : translationModel) : undefined);
      const lanes = visionModel ? recognitionLanes : translator.concurrency;
      if (model && lanes > 1) await prepareGameOllamaModels([{
        connection: { ...resolveFeatureLlm(settings, model), localModel: !!loadLocalModelProfiles()[model] }, lanes,
      }], controller.signal, onMessage);
      const currentCache = new Set<string>();
      if (phase === "recognize" && !stageModels.recognize) {
        const pending = input.images?.filter(image => image.selected && !image.ocrCompleted) ?? [];
        const candidates = !only && ocrMode === "fast" ? pending.filter(image => image.screening?.sourceHash === image.sourceHash &&
          image.screening?.recognition?.profile === "fast:1280:0.3:false") : [];
        if (candidates.length) publishProgress({ detail: "正在校验识字缓存", completed: 0, total: pending.length });
        for (let offset = 0; offset < candidates.length; offset += 512) {
          controller.signal.throwIfAborted();
          const sources = Object.fromEntries(candidates.slice(offset, offset + 512).map(image => [image.id, image.sourceHash]));
          const valid = await post<string[]>("current-sources", { sources }, controller.signal);
          for (const id of valid) currentCache.add(id);
        }
        const remaining = pending.length - currentCache.size;
        if (currentCache.size) onMessage(`已校验 ${currentCache.size} 张图片的识字缓存`, "info");
        if (remaining) {
          publishProgress({ detail: "正在初始化识别模型", completed: 0, total: pending.length });
          await ocr[0].prepare();
          await Promise.all(ocr.slice(1, Math.min(remaining, ocr[0].isGpu ? 2 : concurrency)).map(engine => engine.prepare()));
        }
        controller.signal.throwIfAborted();
      }
      await processUnityImages(input,controller.signal,{timingScope:promptState.scope + ":images",recognitionGroup,cachedRecognition: image => currentCache.has(image.id) ? mergeUnityOcrLines(image.screening!.recognition!.lines) : undefined,concurrency:recognitionLanes,translationConcurrency:outputMode==="render"&&stageModels.render?modelConcurrency(promptState.scope,"layout",stageModels.render):outputMode==="review"?modelConcurrency(promptState.scope,"review",reviewModel):translator.concurrency,regionConcurrency:translator.regions,reuseTranslations,targetLanguage:target,includeRegion:includesRegion,onTranslationFailures:!only&&outputMode==='translate-only'&&reviewModel?count=>onMessage(`${count} 张图片有待复核的区域，已保留成功译文。`,"warning"):undefined,read:image=>measureGameAsync(promptState.scope + ":images", "processingMs", () => readImage(image,false,false,controller.signal)),recognize:(blob,stage,worker=0,image)=>{
      if (visionModel) {
        stage("大模型识字与定位");
        const report = (message: string, level: "info" | "error" | "success" | "warning") => onMessage(image ? `${image.name} · ${message}` : message, level);
        const model = gameImageVisionForAsset(visionModel,image?.name || "",models);
        const placement = { assetName: image?.name, cleanBase: image && gameImageCleanBase(image,base.images || [],row => readImage(row,false,false,controller.signal)) };
        if (model !== visionModel) report(`Logo 识字使用 ${model}`,"info");
        return ocrReuse.read(blob,model,placement,controller.signal,() => ocr[worker % ocr.length].recognizeVision(blob, stage, controller.signal,
          fallback => recognizeGameImage(settings, model, blob, controller.signal, "recognize", promptState.selection, { source, target, ...placement, names }, report, fallback),
          message => report(message, "warning")));
      }
      return measureGameAsync(promptState.scope + ":images", "ocrMs", () => recognizeLocalGameImage(blob,
        input => ocr[ocr[0].isGpu ? worker % Math.min(2, ocr.length) : worker].recognize(input, stage), controller.signal));
    },translate:translator.translate,render:(blob,regions,image)=>renderGameImage(settings,stageModels.render||"",blob,regions,controller.signal,promptState.selection,{source,target},(text,level)=>onMessage(`${image.name} · ${text}`,level),{assetName:image.name,cleanBase:gameImageCleanBase(image,base.images||[],candidate=>readImage(candidate,false,false,controller.signal))}),write:(_project,image,blob)=>measureGameAsync(promptState.scope + ":images", "saveMs", () => write(image,blob)),persist:async(_project,image)=>{const value=only ? {...image,selected:image.selected && only.selected} : image;pendingWrites.push(value);if(pendingWrites.length>=32||performance.now()-lastWrite>=750)await flushWrites();},validate:validateImageTranslation},publishProgress,confidence,phase === "recognize" ? phase : outputMode === "review" ? "translate-only" : outputMode);await flushWrites();if(ocrReuse.hits)onMessage(`已复用 ${ocrReuse.hits} 张相同图片的正式识别结果`,"info");onMessage(phase==="recognize"?"图片识别完成":"图片翻译完成","success");}finally{try{await flushWrites();}finally{translator.dispose();await Promise.all(ocr.map(engine=>engine.dispose()));}}
  },{kind:phase==="recognize"?"recognize":outputMode==="review"?"review":outputMode==="render"?"render":"translate",imageId:only?.id,mode:ocrMode});
  const importImageArchive=(items:ImageArchiveReplacement[])=>execute("导入图片压缩包",async()=>{
    await save(true);const failures:string[]=[];let imported=0;
    for(const item of items){const image=current.current?.images?.find(row=>row.id===item.image.id);
      if(!image||image.sourceHash!==item.image.sourceHash){failures.push(`${item.image.name}：导入期间原资源已改变`);continue;}
      try{const result=await write(image,item.blob);await persist({...image,renderedFile:result.path,renderedHash:result.hash,renderedKind:"imported",completed:true,error:""});imported++;}
      catch(error){failures.push(`${image.name}（${image.file} / ${image.container} / ${image.objectId}）：${error instanceof Error?error.message:String(error)}`);}
    }
    if(failures.length)throw new Error(`已导入 ${imported} 张，失败 ${failures.length} 张：${failures.join("；")}`);
  });
  const translateCurrent=(image:UnityImage)=>void execute("翻译当前图片",async()=>{
    await save(true);const controller=new AbortController();abort.current=controller;
    const translator=createTranslator(controller.signal,"combined",await readImageNames(controller.signal));
    try {
      const merged = mergeRecognizedRegions(image);
      const filtered = groupByLanguage(merged);
      if (filtered !== merged) { await persist(filtered); onMessage(`${image.name} 已移入「无需翻译」`, "info"); return; }
      const next=await translateCurrentUnityImage(merged,controller.signal,translator.translate,validateImageTranslation,confidence,translator.regions,includesRegion,target);
      await persist(next);if(next.error)throw new Error(next.error);onMessage("当前图片译文已更新","success");
    } finally { translator.dispose(); }
  });
  const render=(image:UnityImage)=>void execute("生成译图",async()=>{const controller=new AbortController();abort.current=controller;if(stageModels.render!==undefined&&!stageModels.render)throw new Error("请选择断行排版模型");const regions=unityImageTranslationRegions(image.regions,confidence,image).map(region=>includesRegion(region.text)?region:{...region,selected:false});if(regions.some(region=>region.selected&&region.translationTarget&&region.translationTarget!==target))throw new Error("请先翻译成当前目标语言");const blob=await renderGameImage(settings,stageModels.render||"",await readImage(image),regions,abort.current!.signal,promptState.selection,{source,target},(message,level)=>onMessage(`${image.name} · ${message}`,level),{assetName:image.name,cleanBase:gameImageCleanBase(image,current.current?.images||[],candidate=>readImage(candidate,false,false,controller.signal))});const result=await write(image,blob);await persist({...image,renderedFile:result.path,renderedHash:result.hash,renderedKind:"generated",renderedTarget:target,noTranslationNeeded:false,completed:true,error:""});onMessage("译图已保存","success");});
  const importImage=(image:UnityImage,source?:GameImportSource,modelCandidate=false)=>execute("替换译图",async()=>{const path=source||await open({multiple:false,filters:[{name:"静态图片",extensions:["png","jpg","jpeg","webp","bmp"]}]});if(!path)return;const result=await write(image,await imageImportPng(path,image));await persist({...image,renderedFile:result.path,renderedHash:result.hash,renderedKind:"imported",...(modelCandidate?{screening:savedGameImageRedraw(image,result.hash)}:{}),completed:true,error:""});onMessage("替换译图已保存","success");});
  const images=project?.images||EMPTY_GAME_IMAGES;
  const patchConflicts = useMemo(() => matchImagePatchConflicts(patchConflictPaths, images), [patchConflictPaths, images]);
  useEffect(() => { if (patchConflictPaths.length) onMatchedPatchConflicts?.(patchConflicts.matched); }, [patchConflicts, patchConflictPaths, onMatchedPatchConflicts]);
  const selected=useMemo(()=>images.filter(image=>image.selected),[images]);
  const initialInterrupted = task.task?.kind === "translate" && !task.task.imageId;
  const imageTranslationAttempted = initialInterrupted || imagePhaseStarted === "translate" || images.some(image => !!image.renderedFile ||
    !!image.screening?.sourceSkip || image.regions.some(region => !!region.translation || !!region.error));
  const imageRecognitionAttempted = imagePhaseStarted === "recognize" || images.some(image => image.ocrCompleted || image.regions.length > 0);
  const imageScreeningAttempted = imagePhaseStarted === "filter" || images.some(image => !!image.screening);
  const resetLabels = { review: "清理复核及后续结果", translate: "重新翻译", recognize: "重新识别", filter: "重新筛选", refine: "清理复筛及后续结果", cache: "清理图片缓存" };
  const [imageResetRevision, setImageResetRevision] = useState(0);
  const needsRefinement = (image: UnityImage) => !!refineKey && needsGameImageRefinement(image, refineKey);
  const refineNeedsResume = !!refineKey && task.task?.kind === "refine";
  const refineUpdateRequired = !!refineKey && images.some(image => needsRefinement(image) && !!image.screening?.refineKey && !imageRefinementKeyMatches(image.screening.refineKey, refineKey));
  const redrawCount = images.filter(gameImageRedrawSelected).length;
  const complete=useMemo(()=>({restore:false,filter:images.length>0&&!images.some(needsGameImageScreening),refine:!refineNeedsResume&&!images.some(needsRefinement),recognize:selected.every(image=>image.ocrCompleted),translate:selected.every(image=>unityImageWorkDone(image,target))}),[images,selected,refineKey,refineNeedsResume,target]);
  const manualReviewPending = images.some(image => unityImageResultGroup(image) === "manual-review");
  useEffect(() => {
    onTaskStateChange?.({
      scanTiming: (project as (UnityProject & { imageScanTiming?: ImageScanTiming }) | null)?.imageScanTiming,
      state: !busy && task.task && progress?.state !== "error" ? "stopped" : progress?.state || "idle",
      stage: step,
      complete: !!project && (images.length === 0 || complete.filter && complete.refine && !manualReviewPending &&
        !redrawCount && selected.every(image => unityImageWorkDone(image, target))),
      count: project ? images.length : null, folder: project?.folder || "", exists: existing, loaded: !!project,
      selected: selected.length, valid: selected.filter(image => unityImageReadyForTarget(image, target)).length,
      operation: {
        label: busy || imageOperationLabels[operationStep.current],
        detail: progress?.detail,
        completed: progress?.completed,
        total: progress?.total ?? undefined,
      },
    });
  }, [busy, task.task, progress?.state, progress?.detail, progress?.completed, progress?.total, step, project?.folder,
    images.length, existing, selected, complete.filter, complete.refine, complete.translate, manualReviewPending,
    redrawCount, onTaskStateChange, target, (project as (UnityProject & { imageScanTiming?: ImageScanTiming }) | null)?.imageScanTiming]);
  const resetImages = async (phase: keyof typeof resetLabels) => {
    const label = resetLabels[phase];
    const descriptions = {
      review: "撤销复核重译并删除译图，保留首次翻译结果。",
      translate: "清除全部图片的译文和译图，保留识别和筛选记录。",
      recognize: "清除识别结果及后续译文、译图，保留筛选记录。",
      filter: "清除筛选、识别、译文和译图，保留原图。",
      refine: "恢复初筛结果，清除之后的识别、译文和译图。",
      cache: "清空图片处理记录和读取缓存，恢复到扫描后的状态。",
    };
    if (!await confirmation.ask(label, descriptions[phase])) return;
    const cleared = await execute(label, async () => {
      await save(true); flushImages(); const base = current.current; if (!base) return;
      const clearScreening = phase === "filter" || phase === "cache";
      const clearRecognition = clearScreening || phase === "refine" || phase === "recognize";
      const rows = (base.images || []).map(image => {
        const restored = clearRecognition ? restoreGameImageRecognition(image) : image;
        const next = { ...(phase === "refine" ? clearGameImageRefinement(restored) : restored), completed: false, noTranslationNeeded: false, error: image.sourceFile ? "" : image.error };
        if (next.screening) {
          const { redrawError: _error, redrawSelected: _selected, redrawResultHash: _result, ...screening } = next.screening;
          next.screening = screening;
        }
        if (clearScreening) Object.assign(next, { screening: undefined, selected: false, selectionManual: false });
        if (clearRecognition) Object.assign(next, { ocrCompleted: false, regions: [] });
        if (phase === "translate") next.regions = image.regions.map((region:ReviewedRegion) => {const {beforeReview:_,...rest}=region;return {...rest,translation:"",translationTarget:undefined,error:""};});
        if (phase === "review") next.regions = image.regions.map((region:ReviewedRegion)=>{const {beforeReview,...rest}=region;return beforeReview?{...rest,...beforeReview}:region;});
        return next;
      });
      for (let offset = 0; offset < rows.length; offset += 64) {
        publishProgress({ detail: `正在保存清理结果 ${Math.min(offset + 64, rows.length)} / ${rows.length} 张图片`, completed: offset, total: rows.length });
        await persistMany(rows.slice(offset, offset + 64), true);
      }
      flushImages();
      if (phase === "cache") await post("stop-read");
      task.reset();
      setImagePhaseStarted(phase === "review" ? "translate" : phase === "translate" ? "recognize" : (phase === "recognize" || phase === "refine") ? "filter" : phase === "filter" ? "cache" : "initial");
      setStep(phase === "cache" ? "filter" : phase === "review" ? "translate" : phase);
      if (clearRecognition) {
        resetImageGroupHistory(base.folder);
        setImageResetRevision(value => value + 1);
      }
    });
    if (cleared) {
      const order = ["filter", "refine", "recognize", "translate", "review", "render", "redraw"];
      clearGamePerformance(promptState.scope + ":images", order.slice(phase === "cache" ? 0 : order.indexOf(phase)));
      setProgress(null);
    }
  };
  const imageOutputIds = () => (current.current?.images || [])
    .filter(image => image.selected && unityImageReadyForTarget(image, target)).map(image => image.id);
  const applyImages = (ids: string[]) => execute("应用译图", async () => {
    await save(true);
    const ready = new Set(imageOutputIds());
    if (!ids.length || ids.some(id => !ready.has(id))) throw new Error("可应用的译图已改变，请再生成一次");
    const result = await measureDeploymentStage(gamePath, "applyImages",
      () => post<{ files: number; unchanged?: number; composed?: number; backupDetail?: string }>("apply", { backupMode, backupScopes, imageIds: ids }),
      result => result.files);
    if (result.backupDetail) onMessage(result.backupDetail, "success");
    const detail = result.composed ? ` · ${result.composed} 张与去码图合成` : "";
    onMessage(result.files ? `已应用 ${result.files} 张译图${detail}` : `${result.unchanged ?? 0} 张译图已是当前版本`, "success");
  });
  const uninstallImages = () => execute("卸载译图", async () => {
    await save(true);
    const result = await post<{ files: number; retained?: number }>("uninstall");
    onMessage(`已卸载 ${result.files} 张译图${result.retained ? ` · 保留 ${result.retained} 张去码图` : ""}`, "success");
  });
  if (handle) handle.current = {
    captureTestConfiguration: () => ({
      options: { mode, concurrency, confidence, redrawProfile, mosaic: readMosaicSettings(gamePath), strategy, refine: { method: refineMethod === "llm" || refineMethod === "local" ? refineMethod : "off", mode: refineOcr.id, concurrency: refineConcurrency, confidence: refineConfidence },
        translation: { kind: translationKind, provider, source, target, onlySourceLanguage, skipTargetLanguage, engines } },
      roles: captureGameTestRoles({ screen: stageModels.filter, refine: stageModels.filterRefine, recognize: stageModels.recognize,
        image: translationModel, review: reviewModel, layout: stageModels.render }, promptState,
        { screen: stageModels.filter, refine: stageModels.filterRefine, recognize: stageModels.recognize, image: translationModel || settings.model, review: reviewModel, layout: stageModels.render }),
    }),
    applyTestConfiguration: async preset => {
      if (disabled || busy || clearing || operationActive.current) throw new Error("请等待当前图片任务结束");
      const { mode, concurrency, strategy, refine, translation } = preset.options;
      const nextStages = { ...stageModels, confidence: String(preset.options.confidence ?? confidence) } as Record<string,string>;
      for (const [key, model] of [["filter", preset.roles.screen?.model], ["filterRefine", preset.roles.refine?.model], ["recognize", preset.roles.recognize?.model], ["render", preset.roles.layout?.model]] as const) {
        if (model === undefined) delete nextStages[key]; else nextStages[key] = model;
      }
      if (preset.options.redrawProfile) nextStages.redraw = preset.options.redrawProfile;
      if (refine) Object.assign(nextStages, { refineMethod: refine.method, refineOcr: refine.mode, refineConcurrency: String(refine.concurrency), refineConfidence: String(refine.confidence) });
      const nextOptions = { ...imageSettings(), mode, concurrency, strategy: strategy || "staged", translationModel: preset.roles.image?.model || "", reviewModel: preset.roles.review?.model || "",
        ...(translation ? { source: translation.source, target: translation.target, onlySourceLanguage: translation.onlySourceLanguage !== false,
          skipTargetLanguage: translation.skipTargetLanguage !== false, translationKind: translation.kind, provider: translation.provider } : {}) };
      await saveConfiguration(nextOptions, nextStages);
      if (preset.options.mosaic) saveMosaicSettings(gamePath, preset.options.mosaic);
      if (task.task) task.select({ ...task.task, mode, options: nextOptions });
      setStageModels(nextStages); setMode(mode); setStrategy(nextOptions.strategy); setConcurrency(concurrency);
      setSource(nextOptions.source); setTarget(nextOptions.target); setOnlySourceLanguage(nextOptions.onlySourceLanguage); setSkipTargetLanguage(nextOptions.skipTargetLanguage);
      setProvider(nextOptions.provider); setTranslationKind(nextOptions.translationKind); setTranslationModel(nextOptions.translationModel); setReviewModel(nextOptions.reviewModel);
      if (translation) setEngines(normalizeUnityEngines(translation.engines));
      applyGameTestRoles(preset.roles, promptState, { image: nextOptions.translationModel || settings.model });
      setConfigurationRevision(value => value + 1);
    },
    benchmark: () => ({
      setup: { scope: promptState.scope, source: onlySourceLanguage ? source : "auto", target, skipTarget: skipTargetLanguage,
        prompts: promptState.selection, mode, strategy, concurrency, engines, refineMode: refineOcr.id, refineConcurrency, refineConfidence,
        steps: { filter: stageModels.filter || "", refine: refineModel || "", recognize: stageModels.recognize || "",
          imageTranslate: translationKind === "engine" ? "" : translationModel, review: reviewModel, render: stageModels.render || "" } },
      getWorkload: () => { flushImages(); const project = current.current; return { project, selected: project?.images?.filter(image => image.selected) || [], embedded: true }; },
    }),
    stop: () => abort.current?.abort(),
    ensureIndex: async signal => {
      signal.throwIfAborted();
      const stop = () => abort.current?.abort();
      signal.addEventListener("abort", stop, {once:true});
      try {
        if (!current.current && !await loadExisting()) throw new Error("读取图片工程失败");
        if (!current.current && !await scan()) throw new Error("扫描图片失败");
        signal.throwIfAborted();
        return current.current?.images?.length ?? 0;
      } finally { signal.removeEventListener("abort", stop); }
    },
    saveChanges: () => save(true),
    prepare: async () => { if(busy||clearing)return false;if(!edits.current.size)return true;if(!await confirm("保存图片修改后开始一键流程？",{title:"保存图片修改",okLabel:"保存并继续",cancelLabel:"取消"}))return false;try{await save();return true;}catch(cause){onMessage(String(cause),"error");return false;} },
    automatic: async signal => {
      const stop = () => abort.current?.abort(); signal.addEventListener("abort", stop, {once:true});
      try {
        if (signal.aborted) return false;
        if (!current.current && !await loadExisting()) return false;
        if (!current.current && !await scan()) return false;
        if (signal.aborted) return false;
        if (!current.current?.images?.length) return true;
        const advance = async (step: string, run: () => Promise<boolean>) => {
          if (signal.aborted) return false;
          const saved = await configurationCommit.current?.(step);
          return saved !== false && !signal.aborted && await run() && !signal.aborted;
        };
        if (current.current.images.some(needsGameImageScreening) &&
            !await advance("filter", () => automaticSteps.current.filterStep())) return false;
        if ((automaticSteps.current.refineNeedsResume || current.current.images.some(image => automaticSteps.current.needsRefinement(image))) &&
            !await advance("refine", () => automaticSteps.current.refineStep())) return false;
        if (current.current.images.some(image => image.selected && !image.ocrCompleted) &&
            !await advance("recognize", () => automaticSteps.current.recognize())) return false;
        const pendingInitial = () => {
          const pending = task.pendingTask();
          return pending?.kind === "translate" && !pending.imageId ||
            current.current?.images?.some(image => image.selected && (automaticSteps.current.requiresInitial(image) ||
              !automaticSteps.current.reviewModel && !automaticSteps.current.translated(image)));
        };
        if (pendingInitial() || current.current.images.some(image => image.selected && (!unityImageWorkDone(image,target) || !automaticSteps.current.translated(image)))) {
          setStep("translate");
          if (pendingInitial() && !await advance("translate", () => automaticSteps.current.translate())) return false;
          const { reviewReady } = gameImageTranslationReadiness(true, !!pendingInitial(),
            current.current.images.some(image => image.selected && !automaticSteps.current.translated(image)), !!automaticSteps.current.reviewModel);
          if (reviewReady && !await advance("review", () => automaticSteps.current.review())) return false;
          if (current.current.images.some(image => image.selected && !automaticSteps.current.translated(image))) {
            onMessage("图片文字尚未全部通过校验，请检查失败区域", "error"); return false;
          }
          if (current.current.images.some(image => image.selected && !unityImageWorkDone(image,target)) &&
              !await advance("render", () => automaticSteps.current.render())) return false;
        }
        if (current.current.images.some(gameImageRedrawSelected) &&
            !await advance("redraw", () => automaticSteps.current.redraw())) return false;
        if (current.current.images.some(image => unityImageResultGroup(image) === "manual-review")) {
          onMessage("还有图片待人工确认，请处理后继续或跳过剩余内容", "warning");
          return false;
        }
        return current.current.images.filter(image => image.selected).every(image => unityImageWorkDone(image,target));
      } finally { signal.removeEventListener("abort",stop); }
    },
    outputIds: imageOutputIds,
    generate: async signal => {
      await save(true);
      signal.throwIfAborted();
      const render = automaticSteps.current;
      const rows = current.current?.images || [];
      if (rows.some(image => image.selected && !unityImageWorkDone(image, target))) {
        if (!render.textDone) throw new Error("请先完成图片文字翻译与复核");
        const stop = () => abort.current?.abort();
        signal.addEventListener("abort", stop, { once: true });
        try {
          if (!await render.render(signal)) throw new Error("译图生成未完成");
        } finally {
          signal.removeEventListener("abort", stop);
        }
      }
      signal.throwIfAborted();
      return imageOutputIds();
    },
    apply: applyImages,
    uninstall: uninstallImages,
  };
  const stepProgress = (step === "restore") === (operationStep.current === "restore") ? progress : null;
  const stepPaused = step !== "restore" && !!task.task;
  const translationRegions = (image: UnityImage) => unityImageTranslationRegions(image.regions, confidence, image)
    .filter(region => region.selected && includesRegion(region.text));
  const requiresInitial = (image: UnityImage) => image.renderedKind !== "imported" &&
    (groupByLanguage(mergeRecognizedRegions(image)).selected !== image.selected ||
      translationRegions(image).some(region => !region.error && (!region.translation.trim() || region.translationTarget && region.translationTarget !== target ||
        validateImageTranslation(region.text, region.translation))));
  const translated = (image: UnityImage) => image.ocrCompleted && (image.renderedKind === "imported" ||
    (groupByLanguage(mergeRecognizedRegions(image)).selected === image.selected &&
      translationRegions(image).every(region => !!region.translation.trim() && (!region.translationTarget || region.translationTarget === target) &&
        !validateImageTranslation(region.text, region.translation))));
  const recognitionReady = complete.filter && complete.refine && complete.recognize;
  const { textDone, reviewReady } = gameImageTranslationReadiness(recognitionReady,
    initialInterrupted || selected.some(requiresInitial), selected.some(image => !translated(image)), !!reviewModel);
  const hasReviewResults = images.some(image => image.regions.some((region: ReviewedRegion) => !!region.beforeReview));
  const hasRendered = images.some(image => !!image.renderedFile);
  const flowBusy = disabled || !!busy || clearing;
  const redraw = () => execute("AI 风格重绘", async () => {
    await save(true);
    const controller = new AbortController();
    abort.current = controller;
    const result = await redrawGameImages(current.current?.images || [], redrawProfile, target, controller.signal, {
      onStart: setRedrawingId,
      timingScope: promptState.scope + ":images",
      regions: translationRegions,
      read: image => readImage(image, false, false, controller.signal),
      write: (image, blob) => measureGameAsync(promptState.scope + ":images", "saveMs", () => write(image, blob)),
      persist,
    }, publishProgress, onMessage).finally(() => setRedrawingId(undefined));
    if (result.failed) throw new Error(`${result.failed} / ${result.total} 张重绘失败，失败项仍可重试`);
  }, { kind: "redraw" });
  const clearRendered = async () => {
    if (!await confirmation.ask("清理译图", "删除所生成的译图，保留识别文字和译文。")) return;
    await execute("清理译图", async () => {
      await save(true);
      const rows = (current.current?.images || []).filter(image => image.renderedFile)
        .map(image => ({ ...image, renderedFile: "", renderedHash: "", renderedKind: undefined, completed: false }));
      for (let offset = 0; offset < rows.length; offset += 64) await persistMany(rows.slice(offset, offset + 64), true);
      clearGamePerformance(promptState.scope + ":images", ["render"]);
      task.reset(); setProgress(null);
    });
  };
  const runStage = (stage: "recognize" | "translate" | "render") => {
    setStep(stage === "recognize" ? "recognize" : "translate");
    return stage === "recognize" ? process("recognize") : process("translate", undefined, mode, stage === "render" ? "render" : "translate-only");
  };
  const execution = { filterStep, refineStep, needsRefinement, refineNeedsResume, requiresInitial, translated, reviewModel, textDone,
    recognize: () => runStage("recognize"),
    translate: () => process("translate", undefined, mode, "translate-only"),
    review: () => process("translate", undefined, mode, "review"),
    render: (signal?: AbortSignal) => process("translate", undefined, mode, "render", signal),
    redraw,
  };
  const automaticSteps = useRef(execution);
  automaticSteps.current = execution;
  const imageFlow: GameFlowStep[] = ([
    { id: "filter", title: "筛选图片", models: [{role:"screen",id:stageModels.filter}], summary: stageModels.filter!==undefined ? "大模型筛选" : strategy === "staged" ? "分级快速筛选" : "完整范围筛选", state: complete.filter ? "done" : "current",
      run: !flowBusy && !project ? () => void loadExisting() : !flowBusy && !complete.filter && images.length ? () => void filterStep() : undefined,
      clear: !flowBusy && imageScreeningAttempted ? () => void resetImages("filter") : undefined },
    { id: "refine", title: "复筛图片", models: [{role:"refine",id:refineModel}],
      stateLabel: refineUpdateRequired ? "配置或规则已更新，需重新复筛" : undefined,
      runLabel: refineNeedsResume ? "继续" : refineUpdateRequired ? "重新复筛" : undefined,
      summary: refineMethod === "local" ? refineOcr.title : refineMethod === "llm" ? refineModel?.split("/").at(-1) || "请选择视觉模型" : "未启用", state: !complete.filter ? "waiting" : complete.refine ? "done" : "current",
      run: !flowBusy && complete.filter && !complete.refine && refineKey ? () => void refineStep() : undefined,
      clear: !flowBusy && images.some(image => !!image.screening?.refineKey) ? () => void resetImages("refine") : undefined },
    { id: "recognize", title: "识字与定位", models: [{role:"recognize",id:stageModels.recognize}], summary: stageModels.recognize!==undefined ? "大模型识别" : OCR_MODE_OPTIONS.find(item => item.id === mode)?.title, state: !complete.filter || !complete.refine ? "waiting" : complete.recognize || !selected.length ? "done" : "current",
      run: !flowBusy && complete.filter && complete.refine && !complete.recognize && selected.length ? () => void runStage("recognize") : undefined,
      clear: !flowBusy && imageRecognitionAttempted ? () => void resetImages("recognize") : undefined },
    { id: "translate", title: "翻译图片文字", models: translationKind === "engine" ? [] : [{role:"image",id:translationModel}], summary: translationKind === "engine" ? "翻译引擎" : translationModel.split("/").pop(), state: !recognitionReady ? "waiting" : textDone || reviewReady ? "done" : "current",
      stateLabel: reviewReady ? "初译结束，有待复核" : undefined,
      run: !flowBusy && recognitionReady && !textDone && !reviewReady ? () => void runStage("translate") : undefined,
      clear: !flowBusy && imageTranslationAttempted ? () => void resetImages("translate") : undefined },
    { id: "review", title: "复核与重译", models: translationKind === "engine" && !reviewModel ? [] : [{role:"review",id:reviewModel}], summary: reviewModel.split("/").pop() || "未配置复核模型", state: textDone ? "done" : reviewReady ? "current" : "waiting",
      stateLabel: textDone && !hasReviewResults ? "无需复核" : undefined,
      run: !flowBusy && reviewReady ? () => void process("translate", undefined, mode, "review") : undefined,
      clear: !flowBusy && (hasReviewResults || pendingKind === "review") ? () => void resetImages("review") : undefined },
    { id: "render", title: "生成译图", models: [{role:"layout",id:stageModels.render}], summary: stageModels.render!==undefined ? "大模型断行排版" : "保留底图排版", state: !textDone ? "waiting" : complete.translate ? "done" : "current",
      run: !flowBusy && textDone && !complete.translate ? () => void runStage("render") : undefined,
      clear: !flowBusy && (hasRendered || pendingKind === "render") ? () => void clearRendered() : undefined },
    { id: "redraw", title: "AI 风格重绘", summary: styleRedrawLabels[redrawProfile],
      state: !textDone || !complete.translate ? "waiting" : redrawCount ? "current" : "done",
      stateLabel: textDone && complete.translate && !redrawCount && operationStep.current !== "redraw" ? "未勾选图片" : undefined,
      run: !flowBusy && textDone && complete.translate && redrawCount ? () => void redraw() : undefined },
  ] satisfies GameFlowStep[]).map(flow => ({
    ...flow,
    stop: busy && (operationStep.current === flow.id || reading.current && flow.id === "filter")
      ? () => { if (reading.current) void stopAndClear(); else abort.current?.abort(); } : undefined,
    runLabel: !project ? "读取" : ((stepProgress?.state === "stopped" || stepProgress?.state === "error") && operationStep.current === flow.id || task.task && (task.task.kind === "screen" || task.task.kind === "scan" ? flow.id === "filter" : task.task.kind === flow.id)) ? "继续" : "开始",
    runDisabled: clearing,
    stopDisabled: !!abort.current?.signal.aborted,
  }));
  const progressState = busy ? "running" : stepProgress?.state === "error" ? "error"
    : stepPaused || stepProgress?.state === "stopped" ? "stopped" : stepProgress?.state === "done" ? "done" : "pending";
  const progressTitle = step === "restore" ? "应用到游戏" : imageFlow.find(flow => flow.id === operationStep.current)?.title || "图片工程";
  const progressCount = stepProgress?.completed ?? 0;
  const redrawSummary = operationStep.current === "redraw" ? gameImageRedrawSummary(stepProgress, progressState === "error") : undefined;
  const progressContent = <GameStepProgress title={progressTitle} state={progressState}
    label={clearing ? "正在清理" : redrawSummary?.label} elapsed={imageTaskDuration(task.elapsed)}
    percent={redrawSummary?.percent ?? (stepProgress?.total ? Math.floor(progressCount / stepProgress.total * 100) : undefined)}
    count={redrawSummary?.count ?? (stepProgress?.total ? `${progressCount} / ${stepProgress.total} 张` : undefined)}>
    {(busy || progressState === "error") && stepProgress?.detail && <p className="unity-task-detail">{stepProgress.detail}</p>}
    {busy && stepProgress?.etaMs !== undefined && <p className="unity-task-detail">预计剩余 {imageTaskDuration(stepProgress.etaMs)}</p>}
  </GameStepProgress>;
  const prompt = (scene: keyof typeof promptState.selection) => promptState.selection[scene] || "builtin:" + scene;
  const configuration = {
    filter: JSON.stringify(stageModels.filter === undefined ? [strategy] : [stageModels.filter, prompt("screen")]),
    refine: JSON.stringify([refineMethod, refineOcr.id, refineConcurrency, refineConfidence, refineModel, refineMethod === "llm" ? prompt("refine") : null]),
    recognize: JSON.stringify(stageModels.recognize === undefined ? [mode, concurrency] : [stageModels.recognize, prompt("recognize"), mode === "manga"]),
    translate: JSON.stringify([source, target, onlySourceLanguage, skipTargetLanguage,
      translationKind === "engine" ? ["engine", engines] : [translationKind, translationModel, prompt("image")]]),
    review: JSON.stringify([reviewModel, reviewModel ? prompt("review") : null]),
    render: JSON.stringify(stageModels.render === undefined ? [] : [stageModels.render, prompt("layout")]),
    redraw: JSON.stringify(redrawProfile),
  };
  const restoreConfiguration = (step: string) => {
    if (step === "translate") {
      setSource(source); setTarget(target); setOnlySourceLanguage(onlySourceLanguage); setSkipTargetLanguage(skipTargetLanguage);
      setTranslationKind(translationKind); setProvider(provider); setEngines(engines); setTranslationModel(translationModel);
      promptState.select("image", prompt("image"));
    } else if (step === "review") {
      setReviewModel(reviewModel);
      promptState.select("review", prompt("review"));
    } else if (step === "refine") {
      setStageModels(current => {
        const next = { ...current };
        for (const key of ["filterRefine", "refineMethod", "refineOcr", "refineConcurrency", "refineConfidence"]) {
          if (stageModels[key] === undefined) delete next[key];
          else next[key] = stageModels[key];
        }
        return next;
      });
      promptState.select("refine", prompt("refine"));
    } else if (step === "filter" || step === "recognize" || step === "render" || step === "redraw") {
      setStageModels(current => {
        const next = { ...current };
        if (stageModels[step] === undefined) delete next[step];
        else next[step] = stageModels[step];
        return next;
      });
      if (step === "filter") { setStrategy(strategy); promptState.select("screen", prompt("screen")); }
      if (step === "recognize") { setMode(mode); setConcurrency(concurrency); promptState.select("recognize", prompt("recognize")); }
      if (step === "render") promptState.select("layout", prompt("layout"));
    }
  };
  const configLocked = clearing || !project || !!busy && (configured === operationStep.current || imageFlow.some(step => step.id === configured && step.state === "done"));
  const operationContent=<>

    <div className="unity-step-panel"><GamePromptContext.Provider value={promptState}><GameFlowSequence runningParameters={[
      { scope: "config", label: "原文语言", value: UNITY_LANGUAGES.find(language => language.value === source)?.label ?? "自动检测" },
      { scope: "config", label: "目标语言", value: UNITY_LANGUAGES.find(language => language.value === target)?.label ?? target },
      { scope: "config", label: "仅翻译原语言", value: onlySourceLanguage ? "开启" : "关闭" },
      { scope: "config", label: "跳过目标语言", value: skipTargetLanguage ? "开启" : "关闭" },
      { scope: "config", label: "本地并发", value: String(concurrency) },
    ]} configurationCommit={configurationCommit} configurationRevision={configurationRevision} onSaveConfiguration={saveConfiguration} testConfigurations={testConfigurations} testConfigurationDisabled={testConfigurationDisabled || flowBusy} configurationScope={gamePath} configuration={configuration} restoreConfiguration={restoreConfiguration} actions={<button className="unity-btn unity-btn-warning unity-skip-remaining" disabled={disabled || clearing || !!busy || skipped} onClick={onSkip}>跳过剩余内容</button>} activity={{step: operationStep.current, state: busy || clearing ? "running" : stepProgress?.state || "pending", label: redrawSummary?.label, progress: progressContent}} steps={imageFlow} configured={configured} onConfigure={setConfigured} onRun={flowBusy || !project ? undefined : () => void handle?.current?.automatic(new AbortController().signal)}><div className="unity-translation-settings">
      {configured === "translate" && <GameTranslationTabs kind={translationKind} disabled={configLocked} onChange={kind => { setTranslationKind(kind); setProvider(kind === "engine" ? "bing" : "llm"); }}><div className="unity-control-group unity-translation-group"><div className="unity-group-fields unity-translation-fields">
        {translationKind !== "engine" && <>
          {configured === "translate" && <GameModelSelect label="图片文字翻译模型" promptKey="image" value={translationModel} disabled={configLocked} models={models} onChange={setTranslationModel} />}
        </>}
        <div className="unity-language-setting"><div className="unity-language-heading"><span>原文语言</span><label className="unity-inline-check"><input type="checkbox" disabled={configLocked || !!busy} checked={onlySourceLanguage} onChange={e=>setOnlySourceLanguage(e.target.checked)}/>仅翻源语言</label></div><select aria-label="原文语言" value={source} disabled={configLocked || !!busy} onChange={e=>setSource(e.target.value)}><option value="auto">自动检测</option>{UNITY_LANGUAGES.map(language=><option key={language.value} value={language.value}>{language.label}</option>)}</select></div>
        <div className="unity-language-setting"><div className="unity-language-heading"><span>目标语言</span><label className="unity-inline-check"><input type="checkbox" disabled={configLocked || !!busy} checked={skipTargetLanguage} onChange={e=>setSkipTargetLanguage(e.target.checked)}/>跳过目标语言</label></div><select aria-label="目标语言" value={target} disabled={configLocked || !!busy} onChange={e=>setTarget(e.target.value)}>{UNITY_LANGUAGES.map(language=><option key={language.value} value={language.value}>{language.label}</option>)}</select></div>
      </div></div>
      {translationKind==="engine"&&<UnityEngineList choices={engines} keys={parseEngineKeys(settings.translateEngineKeys)} disabled={configLocked} expanded={engineExpanded} onExpandedChange={setEngineExpanded} onChange={setEngines}/>}</GameTranslationTabs>}
      {configured === "review" && <div className="unity-offline-fields"><GameModelSelect optional label="校验失败重译模型（可选）" promptKey="review" value={reviewModel} disabled={configLocked} models={models} onChange={setReviewModel}/></div>}
      {configured === "refine" && <div className="unity-offline-fields">
        <label>复筛方式<select value={refineMethod} disabled={configLocked} onChange={event => setStageModels(previous => ({ ...previous, refineMethod: event.target.value }))}>
          <option value="off">关闭</option><option value="local">本地筛选</option><option value="llm">大模型</option>
        </select></label>
        {refineMethod === "local" && <>
          <label>本地模型<UnityDescriptionSelect label="复筛本地模型" value={refineOcr.id}
            disabled={configLocked} choices={LOCAL_REFINE_MODELS.map(item => ({ value: item.id, label: item.title, description: item.description }))}
            onChange={value => setStageModels(previous => ({ ...previous, refineOcr: value }))} /></label>
          <label>本地并发<select value={refineConcurrency} disabled={configLocked}
            onChange={event => setStageModels(previous => ({ ...previous, refineConcurrency: event.target.value }))}>
            {[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>
        </>}
        {refineMethod === "llm" && <GameModelSelect label="视觉模型（需支持图片输入）" promptKey="refine"
          value={refineModel || ""} models={models} disabled={configLocked}
          onChange={value => setStageModels(previous => ({ ...previous, filterRefine: value }))} />}
        {refineMethod !== "off" && <label data-tooltip={refineMethod === "llm" ? refineThresholdHint : "仅用于本地复筛。低于阈值的识别文字留待复核。"}>复筛置信度（%）
          <input type="number" min={0} max={100} step={1} value={stageModels.refineConfidence ?? "50"} disabled={configLocked}
            onChange={event => {
              const value = event.target.value;
              setStageModels(previous => ({ ...previous, refineConfidence: value === "" ? "" : String(Math.min(100, Math.max(0, Math.round(Number(value))))) }));
            }} />
        </label>}
        <p className="hint">复筛「待复核」和「待正式识别」的图片。{refineMethod === "llm" && "只判断文字是否存在，先用 1024 尺寸，判断把握低时再以 1600 尺寸复查。"}</p>
      </div>}
      {["filter","recognize","render"].includes(configured||"") && <GameProcessingTabs label="处理方式" localLabel={configured==="render"?"保留底图排版":configured==="filter"?"本地筛选":"本地 OCR"} disabled={configLocked} value={stageModels[configured!]!==undefined?"llm":"local"} onChange={value=>setStageModels(previous=>{const next={...previous};if(value==="llm")next[configured!]="";else delete next[configured!];return next;})}>{stageModels[configured!]!==undefined && <div className="unity-offline-fields"><GameModelSelect promptKey={configured==="render"?"layout":configured==="filter"?"screen":"recognize"} label={configured==="render"?"断行排版模型":"视觉模型（需支持图片输入）"} value={stageModels[configured!]||""} models={models} disabled={configLocked} onChange={value=>setStageModels(previous=>({...previous,[configured!]:value}))}/></div>}
      {configured === "recognize" && <label>翻译置信度阈值<input type="number" min={0} max={100} disabled={configLocked} value={confidence} onChange={e=>setStageModels(previous=>({...previous, confidence:String(Math.min(100,Math.max(0,Number(e.target.value))))}))}/></label>}
      {configured === "recognize" && stageModels.recognize !== undefined && <label className="unity-inline-check"><input type="checkbox" checked={mode === "manga"} disabled={configLocked}
        onChange={event => setMode(event.target.checked ? "manga" : "precise")} />用 Manga OCR 复读日文竖排</label>}
      {(configured === "filter" || configured === "recognize") && stageModels[configured]===undefined && <div className="unity-offline-fields">{configured === "filter" && <label>筛选策略<UnityDescriptionSelect label="筛选策略" value={strategy} disabled={configLocked} onChange={value=>setStrategy(value as typeof strategy)} choices={[
{value:"staged",label:"分级快速筛选",description:"先按资源目录跳过常规动画、角色和瓦片素材，再用快速模型检测文字；疑似文字使用更高分辨率复核。",warning:"可能跳过含有文字的素材；可手动改选，或改用完整范围筛选。"},
{value:"full",label:"完整范围筛选",description:"逐张检测全部未完成图片，包括动画、角色和瓦片素材，使用更高分辨率的快速模型。",warning:"检测范围更广，耗时通常更长。"}
]}/></label>}
        {configured === "recognize" && <><label>图片识别<select value={mode} disabled={configLocked} onChange={e=>setMode(e.target.value as OcrMode)}>{OCR_MODE_OPTIONS.map(option=><option key={option.id} value={option.id}>{option.title}</option>)}</select></label>
        <label>识别并发<select aria-label="图片识别并发" data-tooltip="分级快筛最多使用四个独立识别通道。" value={concurrency} disabled={configLocked} onChange={e=>setConcurrency(Number(e.target.value))}>{[1,2,3,4,6,8].map(value=><option key={value} value={value}>{value}</option>)}</select></label></>}
      </div>}
      {configured === "render" && <p className="hint">{stageModels.render!==undefined?"模型规划译文断行，程序绘制到原文字区域。":"纯色覆盖原文字区域后嵌入译文。"}</p>}
      </GameProcessingTabs>}
      {configured === "redraw" && <div className="unity-offline-fields">
        <label>模型工作流<select value={redrawProfile} disabled={configLocked} onChange={event => setStageModels(previous => ({ ...previous, redraw: event.target.value }))}>
          {Object.entries(styleRedrawLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label><span>勾选「识别到文字」中的图片即可批量重绘。</span>
      </div>}
      </div></GameFlowSequence></GamePromptContext.Provider></div>
    </>;
  const readMosaicSource=useCallback((image:UnityImage,signal:AbortSignal)=>readImage(image,false,false,signal),[readImage]);
  const resultContent=<>    {project?.images?.length ? <ImagePreviewReaderContext.Provider value={readImage}><UnityImageWorkbench redrawingId={redrawingId} confidenceThreshold={confidence} initialScreeningComplete={complete.filter} onRedrawFailure={async (image, reason) => {
      const row = current.current?.images?.find(item => item.id === image.id);
      if (row) await persist({ ...row, error: reason });
      onMessage(reason, "error");
    }} reuseRecognition patchIssues={patchConflicts.issues} key={imageResetRevision} onImportArchive={importImageArchive} onArchiveMessage={(text,error)=>onMessage(text,error?"error":"success")} leaveGuard={leaveGuard} project={project} active={active} disabled={disabled||clearing||!!busy} dirty={dirty} saving={busy==="保存"} ocrMode={mode} onTranslate={translateCurrent} onRecognize={complete.filter&&complete.refine?(image,selectedMode)=>process("recognize",image,selectedMode):undefined} onChange={image=>editImages([image])} onChangeMany={editImages} onRender={render} onImport={importImage} onDiscard={discardChanges} onSave={()=>execute("保存",()=>save())}/></ImagePreviewReaderContext.Provider>:<div className="game-image-empty">{busy==="扫描图片"?"正在扫描图片…":busy?"正在读取图片工程…":project?"未找到可读取的 PNG 图片资源":progress?.state==="stopped"?"图片工程读取已停止":progress?.state==="error"?"图片工程读取失败，请查看输出":existing===true?"正在恢复已有图片工程…":existing===false?"当前游戏没有已有图片工程，请在步骤 1 扫描资源":"正在检查已有图片工程…"}</div>}</>;
  return <>{(mosaicActive || mosaicDeployment) && workspaceTargets.results && workspaceTargets.controls && (project
    ? createPortal(<GameMosaicWorkbench settings={settings} gamePath={gamePath} images={project.images || EMPTY_GAME_IMAGES} backupMode={backupMode}
      read={readMosaicSource} controls={workspaceTargets.controls} deploymentHandle={mosaicDeployment} visible={!!mosaicActive} disabled={mosaicDisabled || !!busy} onBusy={onMosaicBusy} />, workspaceTargets.results)
    : mosaicActive && createPortal(<div className="engine-workflow-content"><p className="game-mosaic-empty">{busy ? "正在准备图片索引…" : "请先在步骤 1 扫描图片资源"}</p></div>, workspaceTargets.controls))}
    {active && busy === "读取图片工程" && <UnityProjectLoading project={gamePath.split(/[\\/]/).filter(Boolean).at(-1) || "游戏工程"} path={gamePath} detail={progress?.detail || "正在读取图片、识别结果和处理进度…"}/ >}{confirmation.dialog}{closingPhase&&<ClosingProgress phase={closingPhase}/>}{workspaceTargets.controls&&workflowStage!=="apply"&&createPortal(<div hidden={!active} className="engine-workflow-content">{operationContent}</div>,workspaceTargets.controls)}{workspaceTargets.results&&createPortal(<div hidden={!active} className="unity-image-result-pane">{resultContent}</div>,workspaceTargets.results)}</>;
}
