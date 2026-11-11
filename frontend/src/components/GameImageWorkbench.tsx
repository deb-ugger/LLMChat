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
import { resolveFeatureLlm } from "../modelPresets";
import { TRANSLATE_ENGINES } from "../translateEngines";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { createUnityImageOcr, translateCurrentUnityImage, mergeUnityOcrLines, processUnityImages, renderUnityImage, unityImageTranslationRegions } from "../unityImages";
import { unityTranslationError, type UnityImage, type UnityProject } from "../unityOffline";
import { ImagePreviewReaderContext, UnityImageWorkbench } from "./UnityImageWorkbench";
import "../unityOffline.css";

export function GameImageWorkbench({ gamePath, settings, backupMode, backupPanel, restorePanel, workflowSteps,workflowStage,onTaskStateChange,leaveGuard,workspaceTargets,scanRequest=0,active, disabled, onBusy, onMessage }: { workspaceTargets:{controls:HTMLElement|null;results:HTMLElement|null};scanRequest?:number;leaveGuard?:{current:((change:()=>void)=>void)|null};onTaskStateChange?:(value:{state:string;stage:string})=>void;workflowSteps:ReactNode;workflowStage?:"images"|"apply";backupPanel:ReactNode;restorePanel:ReactNode;gamePath:string;settings:Settings;backupMode:string;active:boolean;disabled:boolean;onBusy:(value:boolean)=>void;onMessage:(value:string,level?:"info"|"warning"|"error"|"success")=>void }) {
  const task=useGameImageTask(gamePath);
  const etaUpdate=useRef({time:0,value:undefined as number|undefined});
  const lastProgressPaint=useRef(0);
  const publishProgress=(value:{detail:string;completed:number;total:number|null;etaMs?:number})=>{const now=performance.now();if(value.etaMs!==undefined&&(now-etaUpdate.current.time>=1000||value.etaMs===0))etaUpdate.current={time:now,value:value.etaMs};if(now-lastProgressPaint.current>=100||value.completed===value.total){lastProgressPaint.current=now;setProgress({...value,etaMs:etaUpdate.current.value,state:"working"});}};
  const [project,setProject]=useState<UnityProject|null>(null),current=useRef(project);current.current=project;
  const [busy,setBusy]=useState(""),[dirty,setDirty]=useState(false),[notice,setNotice]=useState("");
  const operationStep=useRef<"filter"|"recognize"|"translate"|"restore">("filter");
  const [progress,setProgress]=useState<{detail:string;etaMs?:number;completed?:number;total?:number|null;state:"working"|"done"|"error"|"stopped"}|null>(null);
  const operationEpoch=useRef(0);const [clearing,setClearing]=useState(false);
  const edits=useRef(new Map<string,UnityImage>()),abort=useRef<AbortController|null>(null);
  const [step,setStep]=useState<"filter"|"recognize"|"translate"|"restore">(()=>task.task?.kind==="recognize"?"recognize":task.task?.kind==="translate"?"translate":"filter");
  const backend="auto" as const;
  const deviceMessages=useRef(new Set<string>());
  const reportDevice=(text:string,fallback:boolean)=>{if(!deviceMessages.current.has(text)){deviceMessages.current.add(text);onMessage(text,fallback?"warning":"info");}};
  useEffect(()=>{if(workflowStage==="apply")setStep("restore");else if(workflowStage==="images")setStep(previous=>previous==="restore"?"filter":previous);},[workflowStage]);
  const [strategy,setStrategy]=useState<"staged"|"full">(task.task?.options?.strategy||"staged"),[concurrency,setConcurrency]=useState(()=>task.task?.options?.concurrency||(navigator.hardwareConcurrency>=4?2:1));
  const [mode,setMode]=useState<OcrMode>(task.task?.options?.mode||settings.imageOcrMode as OcrMode||"fast");
  const [provider,setProvider]=useState(task.task?.options?.provider||settings.ocrTranslateProvider),[source,setSource]=useState(task.task?.options?.source||settings.ocrTranslateSource||"auto"),[target,setTarget]=useState(task.task?.options?.target||settings.ocrTranslateTarget||"zh-CN");
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
  useEffect(()=>()=>{if(uiTimer.current)clearTimeout(uiTimer.current);},[]);

  const readImage=useCallback(async (image:UnityImage,translated=false,thumbnail=false,signal?:AbortSignal,retain=true)=>{
    const query=new URLSearchParams({gamePath,id:image.id,translated:translated?"1":"0",cache:retain?"1":"0"});const response=await fetch(`${API_BASE}/api/game-images/preview?${query}`,{signal});if(!response.ok){const value=await response.json();throw new Error(value.error||"图片读取失败");}const blob=await response.blob();if(!thumbnail)return blob;
    const bitmap=await createImageBitmap(blob);try{const ratio=Math.min(1,256/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));canvas.getContext("2d")!.drawImage(bitmap,0,0,canvas.width,canvas.height);return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("无法生成缩略图")),"image/png"));}finally{bitmap.close();}
  },[gamePath]);
  useEffect(()=>{onBusy(!!busy);return()=>onBusy(false);},[busy,onBusy]);
  useEffect(()=>()=>{abort.current?.abort();},[gamePath]);
  const persist=async(image:UnityImage)=>{const saved=await post<UnityImage>("save",{image});edits.current.delete(image.id);update(saved);};
  const save=async(silent=false)=>{if(!edits.current.size)return;const images=[...edits.current.values()];for(let offset=0;offset<images.length;offset+=64)await persistMany(images.slice(offset,offset+64));flushImages();setDirty(false);setNotice("保存成功");if(!silent)onMessage("图片与译文保存成功","success");};
  const write=async(image:UnityImage,blob:Blob)=>{const query=new URLSearchParams({gamePath,id:image.id});const response=await fetch(`${API_BASE}/api/game-images/render?${query}`,{method:"POST",headers:{"Content-Type":"image/png"},body:blob});const value=await response.json();if(!response.ok)throw new Error(value.error||"译图保存失败");return value as {path:string;hash:string};};
  const execute=async(label:string,operation:()=>Promise<void>,resume?:GameImageTask)=>{if(busy||clearing)return false;const epoch=++operationEpoch.current;task.begin(resume?{...resume,options:{backend,strategy,mode,source,target,concurrency,provider}}:undefined);let success=false;deviceMessages.current.clear();etaUpdate.current={time:0,value:undefined};operationStep.current=resume?(resume.kind==="scan"||resume.kind==="screen"?"filter":resume.kind):step;setBusy(label);setNotice("");setProgress({detail:`${label}…`,state:"working"});try{await operation();success=true;setProgress(previous=>({...previous,detail:previous?.detail.endsWith("…")?`${label}完成`:previous?.detail||`${label}完成`,state:"done"}));}catch(error){if(epoch!==operationEpoch.current)return false;const text=abort.current?.signal.aborted?"图片处理已中止，原有工程保留":error instanceof Error?error.message:String(error);setProgress(previous=>({...previous,detail:text,state:abort.current?.signal.aborted?"stopped":"error"}));onMessage(text,abort.current?.signal.aborted?"warning":"error");}finally{if(epoch===operationEpoch.current){flushImages();task.finish(success);abort.current=null;setBusy("");}}return success;};

  const persistMany=async(images:UnityImage[])=>{const saved=await post<UnityImage[]>("save-many",{images});for(const image of saved)edits.current.delete(image.id);mergeImages(saved);};
  const loadExisting=()=>void execute("读取图片工程",async()=>{
    await save(true);const controller=new AbortController();abort.current=controller;
    const value=await post<UnityProject|null>("load",{},controller.signal);controller.signal.throwIfAborted();
    imageIndex.current=null;current.current=value;setProject(value);onMessage(value?"图片工程读取完成":"没有已有图片工程，请先扫描资源",value?"success":"info");
  });
  const stopAndClear=async()=>{
    abort.current?.abort();operationEpoch.current++;task.finish(false);setBusy("");setClearing(true);
    setProgress({detail:"图片工程读取已中止",state:"stopped"});
    try{await post("stop-read");onMessage("图片读取已停止，读取缓存已清理；原图、译文、译图及备份保留","warning");}
    catch(error){onMessage(error instanceof Error?error.message:String(error),"error");}
    finally{setClearing(false);}
  };
  const discardChanges=async()=>{try{
    const saved=await post<UnityProject|null>("load");if(!saved)return false;
    if(uiTimer.current){clearTimeout(uiTimer.current);uiTimer.current=null;}uiUpdates.current.clear();edits.current.clear();
    current.current=saved;setProject(saved);setDirty(false);setNotice("");return true;
  }catch(error){onMessage(String(error),"error");return false;}};
  const screen=async(controller:AbortController,resume=false)=>{task.select({kind:"screen",options:{backend,strategy,mode,source,target,concurrency,provider}});const base=current.current;if(!base)return;const workers=Array.from({length:concurrency},()=>new LocalPaddleOcr("fast",{upscale:false,maxSide:1280,boxThresh:.3,backend,onDevice:reportDevice}));
    let prepared:Promise<void>|undefined;

    setProgress({detail:"正在准备分级筛选",state:"working"});
    try{const counts=await screenGameImages(base,controller.signal,{source,target,strategy,concurrency,resume,model:"fast"},{read:image=>readImage(image,false,false,controller.signal,false),recognize:async(blob,stage,index=0)=>{try{await(prepared??=workers[0].prepare());}catch(error){throw new ScreeningModelError(String(error));}
      const worker=workers[workers[0].isGpu?index%Math.min(2,workers.length):index];
      if(strategy==="full")return worker.recognize(blob,stage,{maxSide:1280,boxThresh:.3});
      stage("快速文字检测");const rough=await worker.recognize(blob,stage,{maxSide:768,boxThresh:.5});controller.signal.throwIfAborted();
      if(!rough.detectedBoxes)return rough;
      const state=classifyImageText(rough,{source,target}).state;
      if(state==="review"){stage("复核疑似文字");return worker.recognize(blob,stage,{maxSide:1280,boxThresh:.3});}return rough;
},persist:persistMany},publishProgress);const detail=`筛选完成 · 候选 ${counts.candidate} · 未检测到字 ${counts["no-text"]} · 待复核 ${counts.review} · 无需翻译 ${counts["not-needed"]} · 失败 ${counts.failed}`;setProgress({detail,state:"done"});onMessage(detail,counts.failed?"warning":"success");}finally{await Promise.all(workers.map(worker=>worker.dispose()));}};

  const scan=()=>void execute("扫描图片",async()=>{await save(true);const controller=new AbortController();abort.current=controller;setProgress({detail:"正在准备图片扫描",state:"working"});const response=await fetch(`${API_BASE}/api/game-images/scan-stream`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({gamePath}),signal:controller.signal});if(!response.ok||!response.body)throw new Error("无法启动图片扫描");const reader=response.body.getReader(),decoder=new TextDecoder();let pending="",result=false;const event=(line:string)=>{if(!line.trim())return;const value=JSON.parse(line);if(value.type==="error")throw new Error(value.error);if(value.type==="progress")setProgress({...value,state:"working"});if(value.type==="result"){imageIndex.current=null;current.current=value.project;setProject(value.project);result=true;const count=value.project.images?.length||0;setProgress({detail:`扫描完成 · ${count} 张图片`,completed:count,total:count,state:"done"});onMessage(`扫描完成 · ${count} 张图片`,"success");}};try{while(true){const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});let end:number;while((end=pending.indexOf("\n"))>=0){event(pending.slice(0,end));pending=pending.slice(end+1);}}pending+=decoder.decode();if(pending.trim())event(pending);if(!result)throw new Error("扫描连接已结束，但未收到结果");}finally{reader.releaseLock();}},{kind:"scan"});

  const handledScan=useRef(0);
  useEffect(()=>{if(scanRequest>handledScan.current&&!busy){handledScan.current=scanRequest;scan();}},[scanRequest,busy]);
  const process=(phase:"recognize"|"translate",only?:UnityImage,ocrMode=mode,continuing=false)=>void execute(phase==="recognize"?"识别图片":"翻译图片",async()=>{
    await save(true);const base=current.current;if(!base)return;if(!base.images?.length||base.images.some(image=>!image.screening))throw new Error("请先完成扫描与筛选");if(continuing&&phase==="recognize"&&only?.ocrCompleted)return;const controller=new AbortController();abort.current=controller;
    const ocr=Array.from({length:phase==="recognize"?concurrency:1},()=>createUnityImageOcr(ocrMode,backend,reportDevice));const input=only?{...base,images:base.images?.map(image=>({...image,selected:image.id===only.id,ocrCompleted:image.id===only.id?false:image.ocrCompleted,completed:image.id===only.id?false:image.completed}))}:base;
    let pendingWrites:UnityImage[]=[];let writes=Promise.resolve();
    const flushWrites=()=>{if(pendingWrites.length){const batch=pendingWrites;pendingWrites=[];writes=writes.then(()=>persistMany(batch));}return writes;};
    const connection=resolveFeatureLlm(settings,settings.ocrTranslateModel);
    const previous=task.task?.options;const reuseTranslations=!previous||previous.source===source&&previous.target===target&&previous.provider===provider;
    try{if(phase==="recognize"){const pending=input.images?.filter(image=>image.selected&&!image.ocrCompleted&&!(ocrMode==="fast"&&image.screening?.sourceHash===image.sourceHash&&image.screening.recognition?.profile==="fast:1280:0.3:false")).length||0;publishProgress({detail:"正在初始化识别模型",completed:0,total:pending});if(pending){await ocr[0].prepare();await Promise.all(ocr.slice(1,Math.min(pending,ocr[0].isGpu?2:concurrency)).map(engine=>engine.prepare()));}controller.signal.throwIfAborted();}await processUnityImages(input,controller.signal,{concurrency,translationConcurrency:provider==="llm"?2:1,regionConcurrency:provider==="llm"?8:1,reuseTranslations,read:image=>readImage(image,false,false,controller.signal),recognize:(blob,stage,worker=0,image)=>{
      const cached=image?.screening;
      if(ocrMode==="fast"&&cached&&cached.sourceHash===image?.sourceHash&&cached.recognition?.profile==="fast:1280:0.3:false")return Promise.resolve(mergeUnityOcrLines(cached.recognition.lines));
      return ocr[ocr[0].isGpu?worker%Math.min(2,ocr.length):worker].recognize(blob,stage);
    },translate:async text=>(await api.translate(text,{signal:controller.signal},{provider,source,target,feature:"unity",...connection})).translation,render:renderUnityImage,write:(_project,image,blob)=>write(image,blob),persist:async(_project,image)=>{const value=only?{...image,selected:image.ocrCompleted&&!image.regions.some(region=>region.text.trim())?false:only.selected}:image;if(phase==="recognize"){pendingWrites.push(value);if(pendingWrites.length>=32)await flushWrites();}else await persist(value);},validate:unityTranslationError},publishProgress,50,phase);onMessage(phase==="recognize"?"图片识别完成":"图片翻译完成","success");}finally{try{await flushWrites();}finally{await Promise.all(ocr.map(engine=>engine.dispose()));}}
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
    const connection=resolveFeatureLlm(settings,settings.ocrTranslateModel);
    const next=await translateCurrentUnityImage(image,controller.signal,async text=>(await api.translate(text,{signal:controller.signal},{provider,source,target,feature:"unity",...connection})).translation,unityTranslationError,50,provider==="llm"?16:1);
    await persist(next);if(next.error)throw new Error(next.error);onMessage("当前图片译文已更新","success");
  });
  const render=(image:UnityImage)=>void execute("生成译图",async()=>{const blob=await renderUnityImage(await readImage(image),unityImageTranslationRegions(image.regions,50,image));const result=await write(image,blob);await persist({...image,renderedFile:result.path,renderedHash:result.hash,renderedKind:"generated",completed:true,error:""});onMessage("译图已保存","success");});
  const importImage=(image:UnityImage,source?:GameImportSource)=>execute("替换译图",async()=>{const path=source||await open({multiple:false,filters:[{name:"静态图片",extensions:["png","jpg","jpeg","webp","bmp"]}]});if(!path)return;const result=await write(image,await imageImportPng(path,image));await persist({...image,renderedFile:result.path,renderedHash:result.hash,renderedKind:"imported",completed:true,error:""});onMessage("替换译图已保存","success");});
  const images=project?.images||[];
  const selected=useMemo(()=>images.filter(image=>image.selected),[images]);
  const complete=useMemo(()=>({restore:false,filter:images.length>0&&images.every(image=>!!image.screening),recognize:selected.length>0&&selected.every(image=>image.ocrCompleted),translate:selected.length>0&&selected.every(image=>image.completed)}),[images,selected]);
  useEffect(()=>{onTaskStateChange?.({state:!busy&&task.task&&progress?.state!=="error"?"stopped":progress?.state||"idle",stage:step});},[busy,task.task,progress?.state,step,onTaskStateChange]);
  const resumeTask=()=>{if(!task.task)return;const next=task.task!;setStep(next.kind==="scan"||next.kind==="screen"?"filter":next.kind);if(next.kind==="scan")scan();else if(next.kind==="screen")void execute("自动筛选文字",async()=>{await save(true);const controller=new AbortController();abort.current=controller;await screen(controller,true);},next);else process(next.kind,next.imageId?current.current?.images?.find(image=>image.id===next.imageId):undefined,mode!==next.options?.mode?mode:next.mode||mode,true);};
  const taskControl=(kind:GameImageTask["kind"],name:string,label:string,ready:boolean,start:()=>void)=>{
    const running=busy===({scan:"扫描图片",screen:"自动筛选文字",recognize:"识别图片",translate:"翻译图片"}[kind]);
    const resumable=!busy&&task.task?.kind===kind;
    return <button className="unity-btn" disabled={running?!abort.current:disabled||clearing||!!busy||(!resumable&&!ready)} onClick={()=>running?abort.current?.abort():resumable?resumeTask():start()}>{running?`中止${name}`:resumable?`继续${name}`:label}</button>;
  };
  const operationContent=<>
    {workflowSteps}
    <div className="unity-step-panel"><div className="json-embedding-actions">
    <button type="button" className="unity-btn" disabled={disabled||clearing||!!busy} onClick={loadExisting}>读取已有工程</button>
    <button type="button" className="unity-btn" title="停止图片工程读取并释放读取缓存；保留原图、识别结果、译图、安装记录和备份" disabled={clearing||!!busy&&busy!=="读取图片工程"} onClick={()=>void stopAndClear()}>{clearing?"正在清理读取缓存…":"强制停止并清理读取缓存"}</button>
    </div></div>

    {step==="restore"?<>{backupPanel}<div className="game-image-deployment"><h3>应用与卸载</h3><div className="game-image-actions"><button className="unity-btn" disabled={disabled||!!busy||!project?.images?.some(image=>image.selected&&image.completed&&!!image.renderedFile)} onClick={()=>void execute("应用译图",async()=>{await save(true);const value=await post<{files:number}>("apply",{backupMode});onMessage(`已应用 ${value.files} 张译图`,"success");})}>应用译图</button><button className="unity-btn" disabled={disabled||!!busy||!project} title="恢复本软件已应用图片的原图，保留识别结果和译图；游戏图片被其他程序改动时停止卸载" onClick={()=>void execute("卸载译图",async()=>{await save(true);const result=await post<{files:number}>("uninstall");onMessage(`已卸载 ${result.files} 张译图`,"success");})}>卸载译图</button></div></div>{restorePanel}</>:<><div className="unity-step-panel"><div className="unity-offline-fields">{step==="filter"&&<><label>筛选策略<UnityDescriptionSelect label="筛选策略" value={strategy} disabled={!!busy} onChange={value=>setStrategy(value as typeof strategy)} choices={[
{value:"staged",label:"分级快速筛选",description:"先按资源目录跳过常规动画、角色和瓦片素材，再用快速模型检测文字；疑似文字使用更高分辨率复核。",warning:"可能跳过含有文字的素材；可手动改选，或改用完整范围筛选。"},
{value:"full",label:"完整范围筛选",description:"逐张检测全部未完成图片，包括动画、角色和瓦片素材，使用更高分辨率的快速模型。",warning:"检测范围更广，耗时通常更长。"}
]}/></label><label>并发<select aria-label="图片筛选并发" value={concurrency} disabled={!!busy} onChange={event=>setConcurrency(Number(event.target.value))}>{[1,2,3,4,6,8].map(value=><option key={value} value={value}>{value}</option>)}</select></label></>}{<label>翻译引擎<select value={provider} disabled={!!busy} onChange={event=>setProvider(event.target.value as typeof provider)}>{TRANSLATE_ENGINES.map(engine=><option key={engine.id} value={engine.id}>{engine.label}</option>)}</select></label>}{workspaceTargets&&<label>图片识别<select value={mode} disabled={!!busy} onChange={event=>setMode(event.target.value as OcrMode)}>{OCR_MODE_OPTIONS.map(option=><option key={option.id} value={option.id}>{option.title}</option>)}</select></label>}<div className="unity-offline-fields"><label>源语言<input value={source} disabled={!!busy} onChange={event=>setSource(event.target.value)}/></label><label>目标语言<input value={target} disabled={!!busy} onChange={event=>setTarget(event.target.value)}/></label></div></div>
    <div className="game-image-actions">
      {taskControl("screen","筛选","筛选图片",!!images.length,()=>void execute("自动筛选文字",async()=>{await save(true);const controller=new AbortController();abort.current=controller;await screen(controller);},{kind:"screen"}))}
      {taskControl("recognize","识别","识别所选图片",complete.filter&&selected.some(image=>!!image.sourceFile&&!image.ocrCompleted),()=>process("recognize"))}
      {taskControl("translate","翻译","翻译所选图片",complete.filter&&selected.some(image=>image.ocrCompleted&&!image.completed),()=>process("translate"))}
    </div>
    </div>

    </>}
    {(busy||progress?.state==="working"||progress?.state==="stopped"||task.task||task.elapsed>0)&&<div className="game-image-progress" role="status" aria-label="图片处理进度"><div>{!!busy&&<strong title={progress?.detail||busy}>{progress?.state==="error"?"":progress?.detail||busy}</strong>}<span className="game-image-elapsed">累计用时：{imageTaskDuration(task.elapsed)}</span><span className="game-image-eta">预计剩余：{progress?.state!=="working"?"—":progress.etaMs===undefined?"估算中…":progress.etaMs<60000?`${Math.ceil(progress.etaMs/1000)} 秒`:progress.etaMs<3600000?`${Math.ceil(progress.etaMs/60000)} 分钟`:`${Math.floor(progress.etaMs/3600000)} 小时 ${Math.ceil(progress.etaMs%3600000/60000)} 分钟`}</span>{!!progress?.total&&<span className="game-image-counter">{progress.completed||0} / {progress.total}</span>}</div><div className={`game-image-meter ${busy&&!progress?.total?"indeterminate":""}`} role="progressbar" aria-label="图片处理进度条" aria-valuemin={0} aria-valuemax={progress?.total||100} aria-valuenow={busy&&!progress?.total?undefined:progress?.state==="done"?progress.total||100:progress?.completed||0}><span style={{transform:`scaleX(${progress?.state==="done"?1:progress?.total?Math.min(1,(progress.completed||0)/progress.total):0})`}}/></div></div>}</>;
  const resultContent=<>    {project?.images?.length ? <ImagePreviewReaderContext.Provider value={readImage}><UnityImageWorkbench onImportArchive={importImageArchive} onArchiveMessage={(text,error)=>onMessage(text,error?"error":"success")} leaveGuard={leaveGuard} project={project} active={active} disabled={disabled||clearing||!!busy} dirty={dirty} saving={busy==="保存"} saveNotice={notice} ocrMode={mode} onTranslate={translateCurrent} onRecognize={complete.filter?(image,selectedMode)=>process("recognize",image,selectedMode):undefined} onChange={image=>{const previous=current.current?.images?.find(row=>row.id===image.id);const changed=previous?.selected!==image.selected?{...image,selectionManual:true}:image;edits.current.set(image.id,changed);setDirty(true);update(changed);}} onChangeMany={images=>{const changed=images.map(image=>({...image,selectionManual:true}));for(const image of changed)edits.current.set(image.id,image);setDirty(!!edits.current.size);mergeImages(changed);}} onRender={render} onImport={importImage} onDiscard={discardChanges} onSave={()=>execute("保存",()=>save())}/></ImagePreviewReaderContext.Provider>:<div className="game-image-empty">{busy==="扫描图片"?"正在扫描图片…":busy?"正在读取图片工程…":project?"未找到可读取的 PNG 图片资源":"请先扫描资源，或点击读取已有工程"}</div>}</>;
  return <>{workspaceTargets.controls&&createPortal(<div hidden={!active} className="engine-workflow-content">{operationContent}</div>,workspaceTargets.controls)}{workspaceTargets.results&&createPortal(<div hidden={!active} className="unity-image-result-pane">{resultContent}</div>,workspaceTargets.results)}</>;
}
