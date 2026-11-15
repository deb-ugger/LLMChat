import { GamePromptContext, useGamePromptSelection, gameTaskPrompt } from "../gamePrompts";
import { recognizeGameImage, renderGameImage } from "../gameImageModel";
import { recommendedGameModels, gameModelPresetKey } from "../gameModelPreset";
import { GameFlowSequence, type GameFlowStep } from "./GameFlowSequence";
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
import { classifyImageText, screenGameImages, ScreeningModelError } from "../gameImageScreening";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, API_BASE, type OcrMode, type Settings } from "../api";
import { engineReady, parseEngineKeys } from "../translateEngines";
import { loadLocalModelProfiles } from "../modelPresets";
import { gameTextMatchesSource, gameTextNeedsNoTranslation } from "../gameDisplayText";
import { buildUnityTranslateOptions, UNITY_LANGUAGES } from "../unityTranslation";
import { createUnityEnginePool, loadUnityEngines, UNITY_ENGINE_CHOICES_KEY } from "../unityEnginePool";
import { UnityEngineList } from "./UnityEngineList";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { createUnityImageOcr, translateCurrentUnityImage, mergeUnityOcrLines, processUnityImages, unityImageTranslationRegions } from "../unityImages";
import { unityTranslationError, type UnityImage, type UnityImageRegion, type UnityProject } from "../unityOffline";
import { ImagePreviewReaderContext, UnityImageWorkbench } from "./UnityImageWorkbench";
import "../unityOffline.css";

type ReviewedRegion = UnityImageRegion & {beforeReview?:{translation:string;error:string}};
const EMPTY_GAME_IMAGES:UnityImage[]=[];
export type GameImageInfo = {state:string;stage:string;complete:boolean;count:number|null;folder:string;exists:boolean|null;loaded:boolean;selected:number;valid:number};
export type GameImageHandle = { automatic: (signal: AbortSignal) => Promise<boolean>; stop: () => void; prepare: () => Promise<boolean>; apply: () => Promise<boolean> };
export function GameImageWorkbench({ handle, gamePath, settings, backupMode, backupScopes, backupPanel, restorePanel, workflowSteps,workflowStage,onTaskStateChange,leaveGuard,workspaceTargets,scanRequest=0,skipped,onSkip,onResetSkipped,active, disabled, onBusy, onMessage }: { handle?: {current: GameImageHandle | null}; workspaceTargets:{controls:HTMLElement|null;results:HTMLElement|null};scanRequest?:number;skipped:boolean;onSkip:()=>void;onResetSkipped:()=>void;leaveGuard?:{current:((change:()=>void)=>void)|null};onTaskStateChange?:(value:GameImageInfo)=>void;backupScopes:string[];workflowSteps:ReactNode;workflowStage?:"images"|"apply";backupPanel:ReactNode;restorePanel:ReactNode;gamePath:string;settings:Settings;backupMode:string;active:boolean;disabled:boolean;onBusy:(value:boolean)=>void;onMessage:(value:string,level?:"info"|"warning"|"error"|"success")=>void }) {
  const promptState=useGamePromptSelection(gamePath + ":images");
  const {phase:closingPhase,show:showClosing,clear:clearClosing}=useClosingProgress();
  const operationWork=useRef<Promise<boolean>|null>(null),reading=useRef(false);
  const task=useGameImageTask(gamePath);
  const confirmation = useGameActionConfirm(text => onMessage(text)); const confirm = confirmation.confirm;
  const [imagePhaseStarted, setImagePhaseStarted] = useState<"initial" | "filter" | "recognize" | "translate" | "cache">(() => task.task?.kind === "translate" ? "translate" : task.task?.kind === "screen" ? "filter" : task.task?.kind === "recognize" ? "recognize" : "initial");
  const etaUpdate=useRef({time:0,value:undefined as number|undefined});
  const lastProgressPaint=useRef(0),operationActive=useRef(false);
  const publishProgress=(value:{detail:string;completed:number;total:number|null;etaMs?:number})=>{if(!operationActive.current)return;const now=performance.now();if(value.etaMs!==undefined&&(now-etaUpdate.current.time>=1000||value.etaMs===0))etaUpdate.current={time:now,value:value.etaMs};if(now-lastProgressPaint.current>=100||value.completed===value.total){lastProgressPaint.current=now;setProgress({...value,etaMs:etaUpdate.current.value,state:"working"});}};
  const [existing,setExisting]=useState<boolean|null>(null);
  const [project,setProject]=useState<UnityProject|null>(null),current=useRef(project);current.current=project;
  const [busy,setBusy]=useState(""),[dirty,setDirty]=useState(false),[notice,setNotice]=useState("");
  const operationStep=useRef<"filter"|"recognize"|"translate"|"review"|"render"|"restore"|"other">("other");
  const [progress,setProgress]=useState<{detail:string;etaMs?:number;completed?:number;total?:number|null;state:"working"|"done"|"error"|"stopped"}|null>(null);
  const operationEpoch=useRef(0);const [clearing,setClearing]=useState(false);
  const originals = useRef(new Map<string,UnityImage>());
  const edits=useRef(new Map<string,UnityImage>()),abort=useRef<AbortController|null>(null);
  const [step,setStep]=useState<"filter"|"recognize"|"translate"|"restore">(()=>task.task?.kind==="recognize"?"recognize":task.task?.kind==="translate"?"translate":"filter");
  const [configured, setConfigured] = useState<string | null>(null);
  const backend="auto" as const;
  const deviceMessages=useRef(new Set<string>());
  const reportDevice=(text:string,fallback:boolean)=>{if(!deviceMessages.current.has(text)){deviceMessages.current.add(text);onMessage(text,fallback?"warning":"info");}};
  useEffect(()=>{if(workflowStage==="apply")setStep("restore");else if(workflowStage==="images")setStep(previous=>previous==="restore"?"filter":previous);},[workflowStage]);
  const [savedOptions] = useState<Partial<NonNullable<GameImageTask["options"]>>>(()=>{try{return JSON.parse(localStorage.getItem("llmchat-game-image-options:"+gamePath)||"{}");}catch{return {};}});
  const [strategy,setStrategy]=useState<"staged"|"full">(task.task?.options?.strategy||savedOptions.strategy||"staged"),[concurrency,setConcurrency]=useState(()=>task.task?.options?.concurrency||savedOptions.concurrency||(navigator.hardwareConcurrency>=4?2:1));
  const [mode,setMode]=useState<OcrMode>(task.task?.options?.mode||savedOptions.mode||settings.imageOcrMode as OcrMode||"fast");
  const [provider,setProvider]=useState(task.task?.options?.provider||savedOptions.provider||settings.ocrTranslateProvider),[source,setSource]=useState(task.task?.options?.source||savedOptions.source||settings.ocrTranslateSource||"auto"),[target,setTarget]=useState(task.task?.options?.target||savedOptions.target||settings.ocrTranslateTarget||"zh-CN");
  const [translationKind,setTranslationKind]=useState<"llm"|"local"|"engine">(task.task?.options?.translationKind||savedOptions.translationKind||(provider==="llm"?"llm":"engine"));
  const [translationModel,setTranslationModel]=useState(task.task?.options?.translationModel||savedOptions.translationModel||"");
  const [engines,setEngines]=useState(loadUnityEngines),[engineExpanded,setEngineExpanded]=useState(false);
  useEffect(()=>{localStorage.setItem(UNITY_ENGINE_CHOICES_KEY,JSON.stringify(engines));},[engines]);
  const [onlySourceLanguage,setOnlySourceLanguage]=useState(savedOptions.onlySourceLanguage??false),[skipTargetLanguage,setSkipTargetLanguage]=useState(savedOptions.skipTargetLanguage??true);
  const models = gameAvailableModels(settings);
  const [stageModels,setStageModels] = useState<Record<string,string>>(()=>{try{return JSON.parse(localStorage.getItem("llmchat-image-stage-models:"+gamePath)||"{}");}catch{return {};}});
  useEffect(()=>{localStorage.setItem("llmchat-image-stage-models:"+gamePath,JSON.stringify(stageModels));},[gamePath,stageModels]);
  const [reviewModel, setReviewModel] = useState(task.task?.options?.reviewModel || savedOptions.reviewModel || "");
  useEffect(() => {
    const preset = recommendedGameModels(), key = gameModelPresetKey(gamePath, "images");
    if (!preset || !gamePath || !active || busy || clearing || localStorage.getItem(key)) return;
    setStageModels({ recognize: preset.vision }); setTranslationKind("llm"); setProvider("llm");
    setTranslationModel(preset.text); setReviewModel(preset.review); setStrategy("staged"); setConcurrency(2);
    setTarget("zh-CN"); setOnlySourceLanguage(true); setSkipTargetLanguage(true);
    if (task.task) task.select({ ...task.task, options: { backend, strategy: "staged", mode, source, target: "zh-CN", concurrency: 2, provider: "llm", translationKind: "llm", translationModel: preset.text, reviewModel: preset.review, onlySourceLanguage: true, skipTargetLanguage: true } });
    localStorage.setItem(key, "configured");
  }, [gamePath, active, busy, clearing]);
  useEffect(()=>{try{localStorage.setItem("llmchat-game-image-options:"+gamePath,JSON.stringify({strategy,concurrency,mode,provider,source,target,translationKind,translationModel,reviewModel,onlySourceLanguage,skipTargetLanguage}));}catch(error){onMessage(`图片参数自动保存失败：${String(error)}`,"error");}},[gamePath,strategy,concurrency,mode,provider,source,target,translationKind,translationModel,reviewModel,onlySourceLanguage,skipTargetLanguage]);
  const saveConfiguration=()=>{
    localStorage.setItem("llmchat-game-image-options:"+gamePath,JSON.stringify({strategy,concurrency,mode,provider,source,target,translationKind,translationModel,reviewModel,onlySourceLanguage,skipTargetLanguage}));
    localStorage.setItem("llmchat-image-stage-models:"+gamePath,JSON.stringify(stageModels));
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
  useEffect(()=>()=>{if(uiTimer.current)clearTimeout(uiTimer.current);if(reading.current){operationEpoch.current++;abort.current?.abort();void post("stop-read").catch(error=>logRuntimeError("image-preload-stop",error));}},[post]);

  const readImage=useCallback(async (image:UnityImage,translated=false,thumbnail=false,signal?:AbortSignal,retain=true)=>{
    const query=new URLSearchParams({gamePath,id:image.id,translated:translated?"1":"0",cache:retain?"1":"0"});const response=await fetch(`${API_BASE}/api/game-images/preview?${query}`,{signal});if(!response.ok){const value=await response.json();throw new Error(value.error||"图片读取失败");}const blob=await response.blob();if(!thumbnail)return blob;
    const bitmap=await createImageBitmap(blob);try{const ratio=Math.min(1,256/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));canvas.getContext("2d")!.drawImage(bitmap,0,0,canvas.width,canvas.height);return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("无法生成缩略图")),"image/png"));}finally{bitmap.close();}
  },[gamePath]);
  useEffect(()=>{onBusy(!!busy&&(busy!=="读取图片工程"||active));return()=>onBusy(false);},[busy,active,onBusy]);
  useEffect(()=>()=>{abort.current?.abort();},[gamePath]);
  const persist=async(image:UnityImage)=>{const saved=await post<UnityImage>("save",{image});edits.current.delete(image.id);originals.current.delete(image.id);update(saved);};
  const save=async(silent=false)=>{if(!edits.current.size)return;const images=[...edits.current.values()];for(let offset=0;offset<images.length;offset+=64)await persistMany(images.slice(offset,offset+64));flushImages();setDirty(false);setNotice("保存成功");if(!silent)onMessage("图片与译文保存成功","success");};
  const write=async(image:UnityImage,blob:Blob)=>{const query=new URLSearchParams({gamePath,id:image.id});const response=await fetch(`${API_BASE}/api/game-images/render?${query}`,{method:"POST",headers:{"Content-Type":"image/png"},body:blob});const value=await response.json();if(!response.ok)throw new Error(value.error||"译图保存失败");return value as {path:string;hash:string};};
  const execute=(label:string,operation:()=>Promise<void>,resume?:GameImageTask)=>{
    const run=async()=>{if(busy||clearing)return false;const epoch=++operationEpoch.current;operationActive.current=true;const timed=!!resume;if(timed)task.begin({...resume,options:{backend,strategy,mode,source,target,concurrency,provider,translationKind,translationModel,reviewModel,onlySourceLanguage,skipTargetLanguage}});let success=false;deviceMessages.current.clear();etaUpdate.current={time:0,value:undefined};operationStep.current=label==="生成译图"?"render":label==="复核与重译"?"review":resume?(resume.kind==="scan"||resume.kind==="screen"?"filter":resume.kind):step==="restore"?"restore":"other";if(label!=="读取图片工程")onResetSkipped();onMessage(`开始${label}`);setBusy(label);setNotice("");setProgress({detail:`${label}…`,state:"working"});try{await operation();if(epoch!==operationEpoch.current)return false;success=true;onMessage(`${label}完成`,"success");setProgress(previous=>({...previous,detail:previous?.detail.endsWith("…")?`${label}完成`:previous?.detail||`${label}完成`,state:"done"}));}catch(error){if(epoch!==operationEpoch.current)return false;const text=abort.current?.signal.aborted?"图片处理已中止，原有工程保留":error instanceof Error?error.message:String(error);setProgress(previous=>({...previous,detail:text,state:abort.current?.signal.aborted?"stopped":"error"}));onMessage(text,abort.current?.signal.aborted?"warning":"error");}finally{if(epoch===operationEpoch.current){flushImages();operationActive.current=false;if(timed)task.finish(success);abort.current=null;setBusy("");}}return success;};
    const promise=run();operationWork.current=promise;
    const clear=()=>{if(operationWork.current===promise)operationWork.current=null;};void promise.then(clear,clear);
    return promise;
  };

  const persistMany = async (images: UnityImage[], clearRendered = false) => {
    const saved = await post<UnityImage[]>("save-many", {
      images: images.map(image => ({ ...image, screening: image.screening ?? null, ...(clearRendered ? { clearRendered: true } : {}) })),
    });
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
    const event=(line:string)=>{if(!line.trim())return;const value=JSON.parse(line);if(value.type==="error")throw new Error(value.error);if(value.type==="progress")publishProgress(value);if(value.type==="result"){result=value.project;received=true;}};
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
    abort.current?.abort();operationEpoch.current++;operationActive.current=false;task.reset();setBusy("");setClearing(true);
    setProgress({detail:"图片工程读取已中止",state:"stopped"});
    try{await post("stop-read");onMessage("图片读取已停止，读取缓存已清理；原图、译文、译图及备份保留","warning");}
    catch(error){onMessage(error instanceof Error?error.message:String(error),"error");}
    finally{task.reset();etaUpdate.current={time:0,value:undefined};setProgress(null);setClearing(false);}
  };
  const discardChanges=async()=>{
    if (!originals.current.size) { onMessage("当前没有未保存的图片修改"); return true; }
    flushImages(); const saved = current.current; if (!saved) return false;
    const count = originals.current.size;
    const restored = { ...saved, images: saved.images?.map(image => originals.current.get(image.id) || image) };
    edits.current.clear(); originals.current.clear(); current.current=restored; setProject(restored); setDirty(false); setNotice("");
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
  const screen=async(controller:AbortController,resume=false)=>{if(stageModels.filter!==undefined&&!stageModels.filter)throw new Error("请选择筛选视觉模型");task.select({kind:"screen",options:{backend,strategy,mode,source,target,concurrency,provider,translationKind,translationModel,reviewModel,onlySourceLanguage,skipTargetLanguage}});const base=current.current;if(!base)return;const workers=Array.from({length:concurrency},()=>new LocalPaddleOcr("fast",{upscale:false,maxSide:1280,boxThresh:.3,backend,onDevice:reportDevice}));
    setImagePhaseStarted("filter");
    let prepared:Promise<void>|undefined;

    setProgress({detail:"正在准备分级筛选",state:"working"});
    try{const counts=await screenGameImages(base,controller.signal,{source,target,strategy:stageModels.filter?"full":strategy,concurrency:stageModels.filter?1:concurrency,resume,model:stageModels.filter||"fast"},{read:image=>readImage(image,false,false,controller.signal,false),recognize:async(blob,stage,index=0)=>{if(stageModels.filter){stage("大模型筛选");const lines=await recognizeGameImage(settings,stageModels.filter,blob,controller.signal,"screen",promptState.selection,{source,target});return {lines,detectedBoxes:lines.length};}try{await(prepared??=workers[0].prepare());}catch(error){throw new ScreeningModelError(String(error));}
      const worker=workers[workers[0].isGpu?index%Math.min(2,workers.length):index];
      if(strategy==="full")return worker.recognize(blob,stage,{maxSide:1280,boxThresh:.3});
      stage("快速文字检测");const rough=await worker.recognize(blob,stage,{maxSide:768,boxThresh:.5});controller.signal.throwIfAborted();
      if(!rough.detectedBoxes)return rough;
      const state=classifyImageText(rough,{source,target}).state;
      if(state==="review"){stage("复核疑似文字");return worker.recognize(blob,stage,{maxSide:1280,boxThresh:.3});}return rough;
},persist:persistMany},publishProgress);const detail=`筛选完成 · 候选 ${counts.candidate} · 未检测到字 ${counts["no-text"]} · 待复核 ${counts.review} · 无需翻译 ${counts["not-needed"]} · 失败 ${counts.failed}`;setProgress({detail,state:"done"});onMessage(detail,counts.failed?"warning":"success");}finally{await Promise.all(workers.map(worker=>worker.dispose()));}};

  const scan=()=>execute("扫描图片",async()=>{await save(true);const controller=new AbortController();abort.current=controller;const value=await readProject("scan",controller.signal);if(!value)throw new Error("扫描没有返回图片工程");imageIndex.current=null;current.current=value;setProject(value);setExisting(true);const count=value.images?.length||0;setProgress({detail:`扫描完成 · ${count} 张图片`,completed:count,total:count,state:"done"});onMessage(`扫描完成 · ${count} 张图片`,"success");},{kind:"scan"});

  const autoReadAttempted=useRef(false);
  useEffect(()=>{if(existing&&!project&&!busy&&!clearing&&!disabled&&scanRequest<=handledScan.current&&!autoReadAttempted.current){autoReadAttempted.current=true;void loadExisting();}},[existing,project,busy,clearing,disabled,scanRequest]);
  const handledScan=useRef(0);
  useEffect(()=>{if(scanRequest>handledScan.current&&!busy){handledScan.current=scanRequest;scan();}},[scanRequest,busy]);
  const createTranslator=(signal:AbortSignal, stage: "combined" | "initial" | "review" = "combined")=>{
    const local = !!loadLocalModelProfiles()[translationModel || settings.model] || translationKind === "local" && !translationModel || !!loadLocalModelProfiles()[reviewModel];
    const request=async(engine:typeof provider,text:string)=>{
      if (onlySourceLanguage && !gameTextMatchesSource(text,source) || skipTargetLanguage && gameTextNeedsNoTranslation(text,target)) return text;
      if (engine === "llm" && !models.includes(stage === "review" ? reviewModel : translationModel)) throw new Error("请选择图片文字翻译模型");
      const model = stage === "review" && reviewModel ? reviewModel : translationModel;
      const options = buildUnityTranslateOptions(settings, engine, source, target, model, false, !!loadLocalModelProfiles()[model],engine==="llm"?gameTaskPrompt(stage==="review"?"review":"image",promptState.selection,{source,target}):undefined);
      const translate = async (config: typeof options) => {
        const result = await api.translate(text, { signal }, { ...config, autoFallback: false });
        if (!result.ok) throw new Error(result.code || "图片文字翻译失败");
        return result.translation;
      };
      const translated = await translate(options);
      if (stage !== "combined" || engine !== "llm" || !reviewModel || !unityTranslationError(text, translated)) return translated;
      return translate(buildUnityTranslateOptions(settings, "llm", source, target, reviewModel, false, !!loadLocalModelProfiles()[reviewModel],gameTaskPrompt("review",promptState.selection,{source,target})));
    };
    const pool=translationKind==="engine"&&stage!=="review"?createUnityEnginePool(engines.filter(row=>engineReady(parseEngineKeys(settings.translateEngineKeys),row.id)),signal,request):null;
    return {translate:(text:string)=>pool?pool.translate(text):request("llm",text),concurrency:pool?Math.max(1,pool.concurrency):local?1:2,regions:pool||local?1:8,dispose:()=>pool?.dispose()};
  };
  const process=(phase:"recognize"|"translate",only?:UnityImage,ocrMode=mode,continuing=false, outputMode: "translate" | "translate-only" | "review" | "render" = "translate")=>execute(phase==="recognize"?"识别图片":outputMode==="render"?"生成译图":outputMode==="review"?"复核与重译":"翻译图片",async()=>{
    if(phase==="recognize"&&stageModels.recognize!==undefined&&!stageModels.recognize)throw new Error("请选择识字视觉模型");
    if(phase==="translate"&&outputMode==="render"&&stageModels.render!==undefined&&!stageModels.render)throw new Error("请选择断行排版模型");
    if (phase === "translate" && outputMode !== "render" && outputMode !== "review" && translationKind !== "engine" && (!models.includes(translationModel) || !!reviewModel && !models.includes(reviewModel))) throw new Error("请为图片翻译选择可用模型");
    if (phase === "translate" && outputMode !== "render" && outputMode !== "review" && translationKind === "engine" && !engines.some(row => row.enabled && engineReady(parseEngineKeys(settings.translateEngineKeys), row.id))) {
      throw new Error("请至少启用一个可用翻译引擎");
    }
    setImagePhaseStarted(phase);
    await save(true);const base=current.current;if(!base)return;if(!base.images?.length||base.images.some(image=>!image.screening))throw new Error("请先完成扫描与筛选");if(phase==="translate"&&base.images.some(image=>image.selected&&!image.ocrCompleted))throw new Error("请先完成图片识别，再开始翻译");if(continuing&&phase==="recognize"&&only?.ocrCompleted)return;const controller=new AbortController();abort.current=controller;
    const ocr=Array.from({length:phase==="recognize"?concurrency:1},()=>createUnityImageOcr(ocrMode,backend,reportDevice));const input=only?{...base,images:base.images?.map(image=>({...image,selected:image.id===only.id,ocrCompleted:image.id===only.id?false:image.ocrCompleted,completed:image.id===only.id?false:image.completed}))}:{...base};
    if(outputMode==="review")input.images=input.images?.map(image=>image.selected?{...image,regions:image.regions.map((region:ReviewedRegion)=>region.selected&&(!region.translation||region.error||unityTranslationError(region.text,region.translation))?{...region,beforeReview:region.beforeReview||{translation:region.translation,error:region.error}}:region)}:image);
    let pendingWrites:UnityImage[]=[];let writes=Promise.resolve();
    const flushWrites=()=>{if(pendingWrites.length){const batch=pendingWrites;pendingWrites=[];writes=writes.then(()=>persistMany(batch));}return writes;};
    const translator=createTranslator(controller.signal, outputMode === "review" ? "review" : outputMode === "translate-only" ? "initial" : "combined");
    const previous=task.task?.options;const reuseTranslations=!previous||previous.source===source&&previous.target===target&&previous.provider===provider;
    try{if(phase==="recognize"&&!stageModels.recognize){const pending=input.images?.filter(image=>image.selected&&!image.ocrCompleted&&!(ocrMode==="fast"&&image.screening?.sourceHash===image.sourceHash&&image.screening.recognition?.profile==="fast:1280:0.3:false")).length||0;publishProgress({detail:"正在初始化识别模型",completed:0,total:pending});if(pending){await ocr[0].prepare();await Promise.all(ocr.slice(1,Math.min(pending,ocr[0].isGpu?2:concurrency)).map(engine=>engine.prepare()));}controller.signal.throwIfAborted();}await processUnityImages(input,controller.signal,{concurrency:phase==="recognize"&&stageModels.recognize?1:concurrency,translationConcurrency:translator.concurrency,regionConcurrency:translator.regions,reuseTranslations,read:image=>readImage(image,false,false,controller.signal),recognize:(blob,stage,worker=0,image)=>{
      if(stageModels.recognize){stage("大模型识字与定位");return recognizeGameImage(settings,stageModels.recognize,blob,controller.signal,"recognize",promptState.selection,{source,target});}
      const cached=image?.screening;
      if(ocrMode==="fast"&&cached&&cached.sourceHash===image?.sourceHash&&cached.recognition?.profile==="fast:1280:0.3:false")return Promise.resolve(mergeUnityOcrLines(cached.recognition.lines));
      return ocr[ocr[0].isGpu?worker%Math.min(2,ocr.length):worker].recognize(blob,stage);
    },translate:translator.translate,render:(blob,regions)=>renderGameImage(settings,stageModels.render||"",blob,regions,controller.signal,promptState.selection,{source,target}),write:(_project,image,blob)=>write(image,blob),persist:async(_project,image)=>{const value=only?{...image,selected:image.ocrCompleted&&!image.regions.some(region=>region.text.trim())?false:only.selected}:image;if(phase==="recognize"){pendingWrites.push(value);if(pendingWrites.length>=32)await flushWrites();}else await persist(value);},validate:unityTranslationError},publishProgress,50,phase === "recognize" ? phase : outputMode === "review" ? "translate-only" : outputMode);onMessage(phase==="recognize"?"图片识别完成":"图片翻译完成","success");}finally{try{await flushWrites();}finally{translator.dispose();await Promise.all(ocr.map(engine=>engine.dispose()));}}
  },{kind:phase,imageId:only?.id,mode:ocrMode});
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
    const translator=createTranslator(controller.signal);
    try {
      const next=await translateCurrentUnityImage(image,controller.signal,translator.translate,unityTranslationError,50,translator.regions);
      await persist(next);if(next.error)throw new Error(next.error);onMessage("当前图片译文已更新","success");
    } finally { translator.dispose(); }
  });
  const render=(image:UnityImage)=>void execute("生成译图",async()=>{const controller=new AbortController();abort.current=controller;if(stageModels.render!==undefined&&!stageModels.render)throw new Error("请选择断行排版模型");const blob=await renderGameImage(settings,stageModels.render||"",await readImage(image),unityImageTranslationRegions(image.regions,50,image),abort.current!.signal,promptState.selection,{source,target});const result=await write(image,blob);await persist({...image,renderedFile:result.path,renderedHash:result.hash,renderedKind:"generated",completed:true,error:""});onMessage("译图已保存","success");});
  const importImage=(image:UnityImage,source?:GameImportSource)=>execute("替换译图",async()=>{const path=source||await open({multiple:false,filters:[{name:"静态图片",extensions:["png","jpg","jpeg","webp","bmp"]}]});if(!path)return;const result=await write(image,await imageImportPng(path,image));await persist({...image,renderedFile:result.path,renderedHash:result.hash,renderedKind:"imported",completed:true,error:""});onMessage("替换译图已保存","success");});
  const images=project?.images||EMPTY_GAME_IMAGES;
  const selected=useMemo(()=>images.filter(image=>image.selected),[images]);
  const imageTranslationAttempted = imagePhaseStarted === "translate" || images.some(image => !!image.renderedFile || image.regions.some(region => !!region.translation));
  const imageRecognitionAttempted = imagePhaseStarted === "recognize" || images.some(image => image.ocrCompleted || image.regions.length > 0);
  const imageScreeningAttempted = imagePhaseStarted === "filter" || images.some(image => !!image.screening);
  const resetLabels = { review: "清理复核及后续结果", translate: "重新翻译", recognize: "重新识别", filter: "重新筛选", cache: "清理图片缓存" };
  const [imageResetRevision, setImageResetRevision] = useState(0);
  const complete=useMemo(()=>({restore:false,filter:images.length>0&&images.every(image=>!!image.screening),recognize:selected.length>0&&selected.every(image=>image.ocrCompleted),translate:selected.length>0&&selected.every(image=>image.completed)}),[images,selected]);
  useEffect(()=>{onTaskStateChange?.({state:!busy&&task.task&&progress?.state!=="error"?"stopped":progress?.state||"idle",stage:step,complete:!!project&&(images.length===0||complete.filter&&selected.every(image=>image.completed&&!image.error&&!!image.renderedFile)),count:project?images.length:null,folder:project?.folder||"",exists:existing,loaded:!!project,selected:selected.length,valid:selected.filter(image=>image.completed&&!image.error&&!!image.renderedFile).length});},[busy,task.task,progress?.state,step,project?.folder,images.length,existing,selected,complete.filter,complete.translate,onTaskStateChange]);
  const resetImages = async (phase: keyof typeof resetLabels) => {
    const label = resetLabels[phase];
    const descriptions = {
      review: "撤销复核重译并删除译图，保留首次翻译结果。",
      translate: "清除全部图片的译文和译图，保留识别和筛选记录。",
      recognize: "清除识别结果及后续译文、译图，保留筛选记录。",
      filter: "清除筛选、识别、译文和译图，保留原图。",
      cache: "清空图片处理记录和读取缓存，恢复到扫描后的状态。",
    };
    if (!await confirmation.ask(label, descriptions[phase])) return;
    const cleared = await execute(label, async () => {
      await save(true); flushImages(); const base = current.current; if (!base) return;
      const clearScreening = phase === "filter" || phase === "cache";
      const clearRecognition = clearScreening || phase === "recognize";
      const rows = (base.images || []).map(image => {
        const next = { ...image, completed: false, error: image.sourceFile ? "" : image.error };
        if (clearScreening) Object.assign(next, { screening: undefined, selected: false, selectionManual: false });
        if (clearRecognition) Object.assign(next, { ocrCompleted: false, regions: [] });
        if (phase === "translate") next.regions = image.regions.map((region:ReviewedRegion) => {const {beforeReview:_,...rest}=region;return {...rest,translation:"",error:""};});
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
      setImagePhaseStarted(phase === "review" ? "translate" : phase === "translate" ? "recognize" : phase === "recognize" ? "filter" : phase === "filter" ? "cache" : "initial");
      setStep(phase === "cache" ? "filter" : phase === "review" ? "translate" : phase);
      if (clearScreening) setImageResetRevision(value => value + 1);
    });
    if (cleared) setProgress(null);
  };
  if (handle) handle.current = {
    stop: () => abort.current?.abort(),
    prepare: async () => { if(busy||clearing)return false;if(!edits.current.size)return true;if(!await confirm("保存图片修改后开始一键流程？",{title:"保存图片修改",okLabel:"保存并继续",cancelLabel:"取消"}))return false;try{await save();return true;}catch(cause){onMessage(String(cause),"error");return false;} },
    automatic: async signal => {
      const stop = () => abort.current?.abort(); signal.addEventListener("abort", stop, {once:true});
      try {
        if (signal.aborted) return false;
        if (!current.current && !await loadExisting()) return false;
        if (!current.current && !await scan()) return false;
        if (signal.aborted) return false;
        if (!current.current?.images?.length) return true;
        if (current.current.images.some(image=>!image.screening)) {
          setStep("filter"); if (!await execute("自动筛选文字", async()=>{await save(true);const controller=new AbortController();abort.current=controller;await screen(controller,true);},{kind:"screen"}) || signal.aborted) return false;
        }
        if (current.current.images.some(image=>image.selected&&!image.ocrCompleted)) {
          setStep("recognize"); if (!await process("recognize") || signal.aborted) return false;
        }
        if (current.current.images.some(image=>image.selected&&!image.completed)) {
          setStep("translate");
          if (current.current.images.some(image => image.selected && !translated(image))) {
            const translatedAll=await process("translate", undefined, mode, false, "translate-only");
            if(signal.aborted||!translatedAll&&!reviewModel)return false;
          }
          if (current.current.images.some(image => image.selected && !translated(image)) && reviewModel) {
            if (!await process("translate", undefined, mode, false, "review") || signal.aborted) return false;
          }
          if (current.current.images.some(image => image.selected && !translated(image))) {
            onMessage("图片文字尚未全部通过校验，请检查失败区域", "error"); return false;
          }
          if (!await process("translate", undefined, mode, false, "render") || signal.aborted) return false;
        }
        return current.current.images.filter(image=>image.selected).every(image=>image.completed&&!image.error&&!!image.renderedFile);
      } finally { signal.removeEventListener("abort",stop); }
    },
    apply: () => execute("应用译图", async()=>{await save(true);const rows=current.current?.images?.filter(image=>image.selected&&image.completed&&!!image.renderedFile)||[];if(!rows.length)return;const result=await post<{files:number}>("apply",{backupMode,backupScopes});onMessage(`已应用 ${result.files} 张译图`,"success");})
  };
  const stepProgress = (step === "restore") === (operationStep.current === "restore") ? progress : null;
  const stepPaused = step !== "restore" && !!task.task;
  const translated = (image: UnityImage) => image.ocrCompleted && unityImageTranslationRegions(image.regions, 50, image)
    .filter(region => region.selected).every(region => !!region.translation && !unityTranslationError(region.text, region.translation));
  const textDone = complete.filter && selected.every(translated);
  const hasRendered = images.some(image => !!image.renderedFile);
  const flowBusy = disabled || !!busy || clearing;
  const screenStep = () => { setStep("filter"); return execute("自动筛选文字", async () => {
    await save(true); const controller = new AbortController(); abort.current = controller; await screen(controller, true);
  }, { kind: "screen" }); };
  const clearRendered = async () => {
    if (!await confirmation.ask("清理译图", "删除所生成的译图，保留识别文字和译文。")) return;
    await execute("清理译图", async () => {
      await save(true);
      const rows = (current.current?.images || []).filter(image => image.renderedFile)
        .map(image => ({ ...image, renderedFile: "", renderedHash: "", renderedKind: undefined, completed: false }));
      for (let offset = 0; offset < rows.length; offset += 64) await persistMany(rows.slice(offset, offset + 64), true);
      task.reset(); setProgress(null);
    });
  };
  const runStage = (stage: "recognize" | "translate" | "render") => {
    setStep(stage === "recognize" ? "recognize" : "translate");
    return stage === "recognize" ? process("recognize") : process("translate", undefined, mode, false, stage === "render" ? "render" : "translate-only");
  };
  const imageFlow: GameFlowStep[] = ([
    { id: "filter", title: "筛选图片", summary: stageModels.filter!==undefined ? "大模型筛选" : strategy === "staged" ? "分级快速筛选" : "完整范围筛选", state: complete.filter ? "done" : "current",
      run: !flowBusy && !project ? () => void loadExisting() : !flowBusy && !complete.filter && images.length ? () => void screenStep() : undefined,
      clear: !flowBusy && imageScreeningAttempted ? () => void resetImages("filter") : undefined },
    { id: "recognize", title: "识字与定位", summary: stageModels.recognize!==undefined ? "大模型识别" : OCR_MODE_OPTIONS.find(item => item.id === mode)?.title, state: !complete.filter ? "waiting" : complete.recognize || !selected.length ? "done" : "current",
      run: !flowBusy && complete.filter && !complete.recognize && selected.length ? () => void runStage("recognize") : undefined,
      clear: !flowBusy && imageRecognitionAttempted ? () => void resetImages("recognize") : undefined },
    { id: "translate", title: "翻译图片文字", summary: translationKind === "engine" ? "翻译引擎" : translationModel.split("/").pop(), state: !complete.recognize ? "waiting" : textDone ? "done" : imageTranslationAttempted && reviewModel ? "waiting" : "current",
      run: !flowBusy && complete.recognize && !textDone ? () => void runStage("translate") : undefined,
      clear: !flowBusy && imageTranslationAttempted ? () => void resetImages("translate") : undefined },
    { id: "review", title: "复核与重译", summary: reviewModel.split("/").pop() || "校验失败时重译", state: textDone ? "done" : complete.recognize && imageTranslationAttempted && !!reviewModel ? "current" : "waiting",
      run: !flowBusy && complete.recognize && imageTranslationAttempted && !textDone && reviewModel ? () => void process("translate", undefined, mode, false, "review") : undefined,
      clear: !flowBusy && images.some(image=>image.regions.some((region:ReviewedRegion)=>!!region.beforeReview)) ? () => void resetImages("review") : undefined },
    { id: "render", title: "生成译图", summary: stageModels.render!==undefined ? "大模型断行排版" : "原位排版", state: !textDone ? "waiting" : complete.translate ? "done" : "current",
      run: !flowBusy && textDone && !complete.translate ? () => void runStage("render") : undefined,
      clear: !flowBusy && hasRendered ? () => void clearRendered() : undefined },
  ] satisfies GameFlowStep[]).map(flow => ({
    ...flow,
    stop: busy && (operationStep.current === flow.id || reading.current && flow.id === "filter")
      ? () => { if (reading.current) void stopAndClear(); else abort.current?.abort(); } : undefined,
    runLabel: !project ? "读取" : stepProgress?.state === "stopped" && operationStep.current === flow.id ? "继续" : "开始",
    runDisabled: clearing || !!busy && !!abort.current?.signal.aborted,
  }));
  const progressContent = <div className={`unity-current-task ${busy ? "running" : stepProgress?.state || "pending"}`} role="status" aria-label="图片处理进度">
      <div className="unity-generation-status"><strong>步骤 {step === "restore" ? "应用到游戏" : imageFlow.find(flow => flow.id === operationStep.current)?.title || "图片工程"} · {clearing ? "正在清理" : busy ? "正在处理" : stepProgress?.state === "error" ? "失败" : stepPaused || stepProgress?.state === "stopped" ? "已中止" : stepProgress?.state === "done" ? "已完成" : "待开始"}</strong><span className="unity-elapsed">累计用时：{imageTaskDuration(task.elapsed)}</span></div>
      <div className={`unity-progress-track${busy ? " is-running" : ""}`} role="progressbar" aria-label="图片处理进度条" aria-valuemin={0} aria-valuemax={100} aria-valuenow={busy && !stepProgress?.total ? undefined : stepProgress?.state === "done" ? 100 : stepProgress?.total ? Math.min(100,(stepProgress.completed || 0) / stepProgress.total * 100) : 0}>
        <div className="unity-progress-fill" style={{width:`${stepProgress?.state === "done" ? 100 : stepProgress?.total ? Math.min(100,(stepProgress.completed || 0) / stepProgress.total * 100) : 0}%`}} />
      </div>
      {!!stepProgress?.total && <div className="unity-progress-count">{Math.floor((stepProgress.completed || 0) / stepProgress.total * 100)}% · {stepProgress.completed || 0} / {stepProgress.total} 张图片</div>}
      {busy && stepProgress?.detail && <p className="unity-task-detail" data-tooltip={stepProgress.detail}>{stepProgress.detail}</p>}
      {(task.elapsed > 0 || !!busy) && <div className="unity-generation-status"><span className="game-image-eta">预计剩余：{!busy || stepProgress?.etaMs === undefined ? "—" : imageTaskDuration(stepProgress.etaMs)}</span></div>}
    </div>;
  const prompt = (scene: keyof typeof promptState.selection) => promptState.selection[scene] || "builtin:" + scene;
  const configuration = {
    filter: JSON.stringify(stageModels.filter === undefined ? [strategy] : [stageModels.filter, prompt("screen")]),
    recognize: JSON.stringify(stageModels.recognize === undefined ? [mode, concurrency] : [stageModels.recognize, prompt("recognize")]),
    translate: JSON.stringify([source, target, onlySourceLanguage, skipTargetLanguage,
      translationKind === "engine" ? ["engine", engines] : [translationKind, translationModel, prompt("image")]]),
    review: JSON.stringify([reviewModel, reviewModel ? prompt("review") : null]),
    render: JSON.stringify(stageModels.render === undefined ? [] : [stageModels.render, prompt("layout")]),
  };
  const restoreConfiguration = (step: string) => {
    if (step === "translate") {
      setSource(source); setTarget(target); setOnlySourceLanguage(onlySourceLanguage); setSkipTargetLanguage(skipTargetLanguage);
      setTranslationKind(translationKind); setProvider(provider); setEngines(engines); setTranslationModel(translationModel);
      promptState.select("image", prompt("image"));
    } else if (step === "review") {
      setReviewModel(reviewModel);
      promptState.select("review", prompt("review"));
    } else if (step === "filter" || step === "recognize" || step === "render") {
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
  const operationContent=<>
    {workflowSteps}
    {step==="restore"?<>{backupPanel}<div className="game-image-deployment"><h3>应用与卸载</h3><div className="game-image-actions"><button className="unity-btn" disabled={disabled||!!busy||backupMode==="auto"&&!backupScopes.length||!project?.images?.some(image=>image.selected&&image.completed&&!!image.renderedFile)} onClick={()=>void execute("应用译图",async()=>{await save(true);const value=await post<{files:number}>("apply",{backupMode,backupScopes});onMessage(`已应用 ${value.files} 张译图`,"success");})}>应用译图</button><button className="unity-btn" disabled={disabled||!!busy||!project} data-tooltip="恢复本软件已应用图片的原图，保留识别结果和译图；游戏图片被其他程序改动时停止卸载" aria-label="恢复本软件已应用图片的原图，保留识别结果和译图；游戏图片被其他程序改动时停止卸载" onClick={()=>void execute("卸载译图",async()=>{await save(true);const result=await post<{files:number}>("uninstall");onMessage(`已卸载 ${result.files} 张译图`,"success");})}>卸载译图</button></div></div>{restorePanel}{progressContent}</>:<><div className="unity-step-panel"><GamePromptContext.Provider value={promptState}><GameFlowSequence onSaveConfiguration={saveConfiguration} configurationScope={gamePath} configuration={configuration} restoreConfiguration={restoreConfiguration} actions={<button className="unity-btn unity-btn-warning unity-skip-remaining" disabled={disabled || clearing || !!busy || skipped} onClick={onSkip}>跳过剩余内容</button>} activity={{step: operationStep.current, state: busy || clearing ? "running" : stepProgress?.state || "pending", progress: progressContent}} steps={imageFlow} configured={configured} onConfigure={setConfigured} onRun={flowBusy || !project ? undefined : () => void handle?.current?.automatic(new AbortController().signal)}><div className="unity-translation-settings">
      {configured === "translate" && <GameTranslationTabs kind={translationKind} disabled={!!busy} onChange={kind => { setTranslationKind(kind); setProvider(kind === "engine" ? "bing" : "llm"); }}><div className="unity-control-group unity-translation-group"><div className="unity-group-fields unity-translation-fields">
        {translationKind !== "engine" && <>
          {configured === "translate" && <GameModelSelect label="图片文字翻译模型" promptKey="image" value={translationModel} disabled={!!busy} models={models} onChange={setTranslationModel} />}
        </>}
        <div className="unity-language-setting"><div className="unity-language-heading"><span>原文语言</span><label className="unity-inline-check"><input type="checkbox" disabled={!!busy} checked={onlySourceLanguage} onChange={e=>setOnlySourceLanguage(e.target.checked)}/>仅翻源语言</label></div><select aria-label="原文语言" value={source} disabled={!!busy} onChange={e=>setSource(e.target.value)}><option value="auto">自动检测</option>{UNITY_LANGUAGES.map(language=><option key={language.value} value={language.value}>{language.label}</option>)}</select></div>
        <div className="unity-language-setting"><div className="unity-language-heading"><span>目标语言</span><label className="unity-inline-check"><input type="checkbox" disabled={!!busy} checked={skipTargetLanguage} onChange={e=>setSkipTargetLanguage(e.target.checked)}/>跳过目标语言</label></div><select aria-label="目标语言" value={target} disabled={!!busy} onChange={e=>setTarget(e.target.value)}>{UNITY_LANGUAGES.map(language=><option key={language.value} value={language.value}>{language.label}</option>)}</select></div>
      </div></div>
      {translationKind==="engine"&&<UnityEngineList choices={engines} keys={parseEngineKeys(settings.translateEngineKeys)} disabled={!!busy} expanded={engineExpanded} onExpandedChange={setEngineExpanded} onChange={setEngines}/>}</GameTranslationTabs>}
      {configured === "review" && <div className="unity-offline-fields"><GameModelSelect optional label="校验失败重译模型（可选）" promptKey="review" value={reviewModel} disabled={!!busy} models={models} onChange={setReviewModel}/></div>}
      {["filter","recognize","render"].includes(configured||"") && <GameProcessingTabs label="处理方式" localLabel={configured==="render"?"本地原位排版":configured==="filter"?"本地筛选":"本地 OCR"} disabled={!!busy} value={stageModels[configured!]!==undefined?"llm":"local"} onChange={value=>setStageModels(previous=>{const next={...previous};if(value==="llm")next[configured!]="";else delete next[configured!];return next;})}>{stageModels[configured!]!==undefined && <div className="unity-offline-fields"><GameModelSelect promptKey={configured==="render"?"layout":configured==="filter"?"screen":"recognize"} label={configured==="render"?"断行排版模型":"视觉模型（需支持图片输入）"} value={stageModels[configured!]||""} models={models} disabled={!!busy} onChange={value=>setStageModels(previous=>({...previous,[configured!]:value}))}/></div>}
      {(configured === "filter" || configured === "recognize") && stageModels[configured]===undefined && <div className="unity-offline-fields">{configured === "filter" && <label>筛选策略<UnityDescriptionSelect label="筛选策略" value={strategy} disabled={!!busy} onChange={value=>setStrategy(value as typeof strategy)} choices={[
{value:"staged",label:"分级快速筛选",description:"先按资源目录跳过常规动画、角色和瓦片素材，再用快速模型检测文字；疑似文字使用更高分辨率复核。",warning:"可能跳过含有文字的素材；可手动改选，或改用完整范围筛选。"},
{value:"full",label:"完整范围筛选",description:"逐张检测全部未完成图片，包括动画、角色和瓦片素材，使用更高分辨率的快速模型。",warning:"检测范围更广，耗时通常更长。"}
]}/></label>}
        {configured === "recognize" && <><label>图片识别<select value={mode} disabled={!!busy} onChange={e=>setMode(e.target.value as OcrMode)}>{OCR_MODE_OPTIONS.map(option=><option key={option.id} value={option.id}>{option.title}</option>)}</select></label>
        <label>识别并发<select aria-label="图片识别并发" value={concurrency} disabled={!!busy} onChange={e=>setConcurrency(Number(e.target.value))}>{[1,2,3,4,6,8].map(value=><option key={value} value={value}>{value}</option>)}</select></label></>}
      </div>}
      {configured === "render" && <p className="hint">{stageModels.render!==undefined?"模型规划译文断行，程序绘制到原文字区域。":"纯色覆盖原文字区域后嵌入译文。"}</p>}
      </GameProcessingTabs>}
      </div></GameFlowSequence></GamePromptContext.Provider></div>
    </>}
    </>;
  const resultContent=<>    {project?.images?.length ? <ImagePreviewReaderContext.Provider value={readImage}><UnityImageWorkbench key={imageResetRevision} onImportArchive={importImageArchive} onArchiveMessage={(text,error)=>onMessage(text,error?"error":"success")} leaveGuard={leaveGuard} project={project} active={active} disabled={disabled||clearing||!!busy} dirty={dirty} saving={busy==="保存"} saveNotice={notice} ocrMode={mode} onTranslate={translateCurrent} onRecognize={complete.filter?(image,selectedMode)=>process("recognize",image,selectedMode):undefined} onChange={image=>{onResetSkipped();const previous=current.current?.images?.find(row=>row.id===image.id);if(!previous||JSON.stringify(previous)===JSON.stringify(image))return;if(!originals.current.has(image.id))originals.current.set(image.id,previous);const changed=previous?.selected!==image.selected?{...image,selectionManual:true}:image;edits.current.set(image.id,changed);setDirty(true);update(changed);}} onChangeMany={images=>{onResetSkipped();const previousById=new Map((current.current?.images||[]).map(image=>[image.id,image]));const changed=images.map(image=>({...image,selectionManual:true}));for(const image of changed){const previous=previousById.get(image.id);if(previous&&!originals.current.has(image.id))originals.current.set(image.id,previous);edits.current.set(image.id,image);}setDirty(!!edits.current.size);mergeImages(changed);}} onRender={render} onImport={importImage} onDiscard={discardChanges} onSave={()=>execute("保存",()=>save())}/></ImagePreviewReaderContext.Provider>:<div className="game-image-empty">{busy==="扫描图片"?"正在扫描图片…":busy?"正在读取图片工程…":project?"未找到可读取的 PNG 图片资源":progress?.state==="stopped"?"图片工程读取已停止":progress?.state==="error"?"图片工程读取失败，请查看输出":existing===true?"正在恢复已有图片工程…":existing===false?"当前游戏没有已有图片工程，请在步骤 1 扫描资源":"正在检查已有图片工程…"}</div>}</>;
  return <>{confirmation.dialog}{closingPhase&&<ClosingProgress phase={closingPhase}/>}{workspaceTargets.controls&&createPortal(<div hidden={!active} className="engine-workflow-content">{operationContent}</div>,workspaceTargets.controls)}{workspaceTargets.results&&createPortal(<div hidden={!active} className="unity-image-result-pane">{resultContent}</div>,workspaceTargets.results)}</>;
}
