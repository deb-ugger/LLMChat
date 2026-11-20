import { writeOutput, type OutputLevel } from "../appOutput";
import { useGameTestConfigurationSource } from "../gameAuxWindows";
import { GameBatchResults, type BatchRow } from "./GameBatchResults";
import { GameStepProgress } from "./GameStepProgress";
import { showAppNotice } from "./AppNotice";
import type { GameTestConfigurationAccess } from "../gameModelPreset";
import { gameAvailableModels } from "./GameTranslationTabs";
import { openGameTextBenchmark } from "./GameTextBenchmarkDialog";
import { GameWorkflowHelp } from "./GameWorkflowHelp";
import { GameMosaicPatchButton } from "./GameMosaicPatchButton";
import { GameMosaicCompletionContext } from "./GameMosaicWorkbench";
import { UnityIconButton } from "./UnityIconButton";
import { UnityActionIcon } from "./UnityActionIcon";
import { loadGameStage, rememberGameStage, rememberRecentGameFailures } from "../unityLastGame";
import { useGameActionConfirm, logGameButton } from "./GameActionConfirm";
import { gameTextRequest } from "../gameTextProject";
import { gamePatchCanGenerate, type GamePatchWorkflow } from "../gamePatchWorkflow";
import { GameWorkDirectory } from "./GameWorkDirectory";
import { gameDropTarget } from "../hooks/useGameFileDrop";
import { GameTextWorkspace, type GameTextHandle, type GameTextInfo } from "./GameTextWorkspace";
import { UnityGameWorkspace } from "./UnityGameWorkspace";
import { GameWorkflowSteps } from "./GameWorkflowSteps";
import { GameImageWorkbench, type GameImageInfo, type GameImageHandle } from "./GameImageWorkbench";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { API_BASE, api, type Settings } from "../api";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
const paths: Record<string, string> = { back: "m14 5-7 7 7 7M7 12h14", extract: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5", json: "M7 3H4v18h3m10-18h3v18h-3M10 8l-2 4 2 4m4-8 2 4-2 4", backup: "M4 4h16v6H4zM6 10v11h12V10m-9 4h6", refresh: "M20 8a8 8 0 1 0 0 8m0-13v5h-5", rollback: "M9 4 3 10l6 6M3 10h11a6 6 0 0 1 0 12", inspect: "M4 4h11v16H4zM8 9h3m-3 5h3m6-2 3 3 4-6", generate: "M5 3h10l4 4v14H5zM9 12h6m-3-3v6", apply: "m4 12 5 5 11-12", stop: "M5 5h14v14H5z", open: "M10 4H3v17h17v-7M14 3h7v7m0-7L10 14", help: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m-3 7a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3v1" };
function IconAction({ name, label, caption, hint, disabled, onClick }: { name: string; label: string; caption?: string; hint?: string; disabled?: boolean; onClick?: () => void }) {
  return <span className="embed-action" data-tooltip={hint || label} tabIndex={disabled ? 0 : undefined} aria-label={disabled ? label : undefined}><button type="button" className={`embed-icon${name==="help"?" is-help":""}${caption?" has-caption":""}`} aria-label={label} disabled={disabled} onClick={onClick}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>{caption&&<span>{caption}</span>}</button></span>;
}
export type EmbeddingGame = { path: string; name: string; engine: string; supported: boolean; textSupported?: boolean };
type Backup = { id: string; path: string; state: string; resources: number };
type Status = { issues?: Array<{file:string;source:string;translation:string;reason:string}>; state: string; action?: string; detail?: string; gamePath?: string; jsonPath?: string; outputPath?: string; exportPath?: string; imagesPath?: string; imageManifest?: string; patchPath?: string; backupPath?: string; matched?: number; blocked?: number; dictionaryEntries?: number; completed?: number; total?: number };
async function call<T>(action: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/api/json-embedding/${action}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || "操作失败"); return value;
}
export function JsonEmbeddingView({ onBack, initialGame: game, onGameDrop, settings, active = true, onOpenSettings }: { onOpenSettings?: () => void; settings: Settings; onBack: () => void; initialGame: EmbeddingGame; onGameDrop: (path: string) => void; active?: boolean }) {
  const isUnreal = game.engine === "Unreal Engine";
  const supportsImages = game.engine.startsWith("RPG Maker") || game.engine === "WOLF RPG";
  const availableBackupScopes = [
    ["text", "文本资源"],
    ...(game.engine.startsWith("RPG Maker") ? [["runtime", "插件与字体"]] : []),
    ...(supportsImages ? [["images", "图片资源"]] : []),
  ];
  const imageHandle = useRef<GameImageHandle | null>(null);
  const automaticAbort = useRef<AbortController | null>(null);
  const followAutomatic = useRef(true);
  const automaticKey = "llmchat-game-automatic:" + game.path;
  const [automatic, setAutomatic] = useState<"idle"|"running"|"stopped"|"error"|"done">(()=>{try{const state=JSON.parse(localStorage.getItem(automaticKey)||"null");return state&&state.state!=="done"?"stopped":"idle";}catch{return "idle";}});
  const [controlsTarget,setControlsTarget]=useState<HTMLDivElement|null>(null),[resultsTarget,setResultsTarget]=useState<HTMLDivElement|null>(null);
  const [imageScanRequest,setImageScanRequest]=useState(0);
  const imageLeaveGuard=useRef<((change:()=>void)=>void)|null>(null);
  const savedStage = useRef(loadGameStage(game.path, supportsImages)).current;
  const [textStep,setTextStep]=useState(Math.min(savedStage.step, 3));
  const [scanPath,setScanPath]=useState("");
  const [textInfo,setTextInfo]=useState<GameTextInfo>({count:0,selected:0,sourcePath:"",done:0,changed:0,dirty:false,running:false,state:"idle",translationPath:""});
  const scanLoadError = textInfo.loadResult?.path === scanPath ? textInfo.loadResult.error : undefined;
  const textHandle=useRef<GameTextHandle|null>(null),buildAfterCheck=useRef(false);
  const [generated,setGenerated]=useState(false);
  const textTarget = useRef<string | undefined>(undefined);
  const [workflow,setWorkflow]=useState<GamePatchWorkflow>({textSkipped:false,imagesSkipped:false});
  const workflowUpdate=useRef<(changes:Partial<GamePatchWorkflow>)=>Promise<boolean>>(async()=>false);
  const workflowWrites=useRef(Promise.resolve());
  const workflowRef=useRef(workflow);workflowRef.current=workflow;
  const textInfoChanged=useCallback((value:GameTextInfo)=>{const changedTarget=!!textTarget.current&&textTarget.current!==value.target;textTarget.current=value.target;if(value.dirty||value.running||changedTarget){setGenerated(false);if(workflowRef.current.textSkipped)void workflowUpdate.current({textSkipped:false});}setTextInfo(value);if(value.translationPath)setFile(value.translationPath);},[]);
  const [part,setPart]=useState<"text"|"images"|"mosaic">(savedStage.step >= 3 ? "text" : savedStage.part);
  const [mosaicBusy,setMosaicBusy]=useState(false);
  const [mosaicComplete,setMosaicComplete]=useState(false);
  useEffect(() => { rememberGameStage(game.path,textStep,part==="mosaic"?"images":part); }, [game.path,textStep,part]);
  const [imageWorkflow,setImageWorkflow]=useState<GameImageInfo>({state:"idle",stage:"filter",complete:false,count:null,folder:"",exists:null,loaded:false,selected:0,valid:0});
  const [imagesApplied, setImagesApplied] = useState(false);
  const [textFailures, setTextFailures] = useState<BatchRow[]>([]);
  const [textRepairs, setTextRepairs] = useState<BatchRow[]>([]);
  const [matchedImageConflicts, setMatchedImageConflicts] = useState<ReadonlySet<string>>(() => new Set());
  const [imageBusy,setImageBusy]=useState(false);const [detecting,setDetecting]=useState(true);
  const [patch,setPatch]=useState<{installed:boolean;managed?:boolean;legacy?:boolean;conflicts:string[]}>({installed:false,conflicts:[]});
  const loadPatch=async(adopt=false)=>{
    setDetecting(true);
    try {
      const current = await (adopt ? call<typeof patch>("detect-patch", {gamePath:game.path}) : call<typeof patch>("patch?gamePath="+encodeURIComponent(game.path)));
      setPatch(current);
      rememberRecentGameFailures(game.path, "patch", current.conflicts.length);
    } catch(cause) { setError(String(cause)); }
    finally { setDetecting(false); }
  };
  useEffect(() => {
    if (textInfo.sourcePath && !textInfo.dirty && !textInfo.running) rememberRecentGameFailures(game.path, "text", textFailures.length);
  }, [game.path, textInfo.sourcePath, textInfo.dirty, textInfo.running, textFailures.length]);
  useEffect(() => {
    if (imageWorkflow.exists === false || imageWorkflow.loaded && imageWorkflow.count === 0) rememberRecentGameFailures(game.path, "images", 0);
  }, [game.path, imageWorkflow.exists, imageWorkflow.loaded, imageWorkflow.count]);
  const [file, setFile] = useState("");
  const launchPreference = "llmchat-game-launch-after-apply:" + game.path;
  const [launchAfterApply, setLaunchAfterApply] = useState(() => localStorage.getItem(launchPreference) !== "false");
  const [launching, setLaunching] = useState(false);
  const manualLaunch = useRef(false);
  const launchInFlight = useRef(false);
  const [backupMode,setBackupMode]=useState<"auto"|"manual">(()=>localStorage.getItem(`llmchat-game-backup:${game.path}`)==="manual"?"manual":"auto");
  const [backupScopes,setBackupScopes]=useState<string[]>(()=>{try{const saved=JSON.parse(localStorage.getItem(`llmchat-game-backup-scopes:${game.path}`)||'["text"]');return Array.isArray(saved)?saved.filter(value=>availableBackupScopes.some(([scope])=>scope===value)):["text"];}catch{return ["text"];}});
  useEffect(()=>{localStorage.setItem(`llmchat-game-backup-scopes:${game.path}`,JSON.stringify(backupScopes));},[backupScopes,game.path]);
  const [pendingAction,setPendingAction]=useState("");
  const [fontPath,setFontPath]=useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" }), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const logKey = useRef("");
  const appendLog = useCallback((text: string, level: OutputLevel = "info", stage = "工程操作") =>
    writeOutput(["游戏翻译", game.engine, stage], text, level, level === "warning" || level === "error",
      level === "error" ? JSON.stringify([game.path, text]) : undefined), [game.engine, game.path]);
  const textLog = useCallback((text: string, level?: OutputLevel) => appendLog(text, level, "文本翻译"), [appendLog]);
  const imageLog = useCallback((text: string, level?: OutputLevel) => appendLog(text, level, "图片翻译"), [appendLog]);
  const confirmation = useGameActionConfirm(text => appendLog(text)); const confirm = confirmation.confirm;
  useEffect(() => {
    const text = error || status.detail;
    if (!text) { logKey.current = ""; return; }
    const level = error ? "error" : status.state === "error" ? "fail" : status.state === "done" ? "success" : "info";
    const action = status.action || "";
    const key = JSON.stringify([action, level, text]);
    if (logKey.current === key) return;
    logKey.current = key;
    const stages: Record<string, string> = { extract: "扫描资源", inspect: "检查译文", embed: "生成补丁", apply: "应用补丁", backup: "备份", rollback: "恢复" };
    writeOutput(["游戏翻译", game.engine, stages[action] || "工程操作"], text, level, level === "error" || level === "fail",
      !error && action ? JSON.stringify([game.path, action]) : undefined);
  }, [error, status.action, status.state, status.detail, game.engine, game.path]);
  useEffect(()=>{if(status.state!=="running"&&status.state!=="idle"){void loadPatch();}},[game.path,status.state]);
  const [backups, setBackups] = useState<Backup[]>([]), [backupId, setBackupId] = useState("");
  const [applyingTestConfiguration, setApplyingTestConfiguration] = useState(false);
  const touched = useRef(false);
  const workflowBusy = applyingTestConfiguration || automatic === "running" || pending || detecting || imageBusy || textInfo.running || status.state === "running" || launching;
  const busy = workflowBusy || mosaicBusy;
  const latestWorkflow = useRef({text:textInfo,images:imageWorkflow,pending,detecting}); latestWorkflow.current={text:textInfo,images:imageWorkflow,pending,detecting};
  const busyRef = useRef(busy); busyRef.current = busy;
  const testConfigurations: GameTestConfigurationAccess = {
    scope: "embedded:" + game.path, models: gameAvailableModels(settings),
    capture: () => {
      const text = textHandle.current;
      if (!text) throw new Error("请先读取文本工程");
      return { text: text.captureTestConfiguration(), images: imageHandle.current?.captureTestConfiguration(), detectedSource: text.detectedSource };
    },
    apply: async preset => {
      const text = textHandle.current, images = imageHandle.current;
      if (busyRef.current || !text || !textInfo.sourcePath || preset.images && !images) throw new Error("请等待工程读取或当前任务结束");
      setApplyingTestConfiguration(true);
      try {
        await text.applyTestConfiguration(preset.text);
        if (preset.images && images) {
          try { await images.applyTestConfiguration(preset.images); }
          catch (error) { throw new Error(`文本测试配置已保存，图片配置保存失败：${error instanceof Error ? error.message : String(error)}`); }
        }
        appendLog("已应用测试配置", "success");
      } finally { setApplyingTestConfiguration(false); }
    },
  };
  useGameTestConfigurationSource(testConfigurations);
  useEffect(() => { let alive = true; void call<Status>("status").then(async value => {
    if (alive && !touched.current && value.gamePath === game.path) { setFile(value.jsonPath || "");setStatus(value);if(followAutomatic.current && value.action?.includes("images"))setPart("images"); }
    if(alive){await loadPatch(false);}
  }).catch(cause => { if (alive) setError(String(cause)); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (status.state !== "running" || automatic === "running") return;
    let alive = true, timer: number;
    const poll = async () => { try { const value = await call<Status>("status"); if (alive) { setStatus(value); if (value.state === "running") timer = window.setTimeout(poll, 400); } } catch (cause) { if (alive) setError(String(cause)); } };
    timer = window.setTimeout(poll, 200); return () => { alive = false; window.clearTimeout(timer); };
  }, [status.state, automatic]);
  const loadBackups = async () => {
    setPending(true); setError("");
    try { const response = await fetch(`${API_BASE}/api/json-embedding/backups?gamePath=${encodeURIComponent(game.path)}`); const values = await response.json(); if (!response.ok) throw new Error(values.error); setBackups(values); setBackupId(values.find((item: Backup) => item.state !== "rolledBack")?.id || ""); }
    catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  useEffect(() => { if (["idle", "backedUp", "applied", "rolledBack", "uninstalled", "cleaned"].includes(status.state) || status.action === "backup" && status.state !== "running" && status.state !== "error") void loadBackups(); }, [status.state, status.action, game.path]);
  const stopScan = () => { imageHandle.current?.stop(); void call("stop",{}).then(()=>appendLog("已请求中止资源扫描","warning")).catch(cause=>setError(String(cause))); };
  const launchGame = async () => {
    if (launchInFlight.current) return;
    launchInFlight.current = true;
    setLaunching(true);
    setError("");
    try {
      const { gameExe } = await call<{gameExe:string}>("launch", { gamePath: game.path });
      appendLog(`已请求启动游戏 · ${gameExe}`, "success");
      showAppNotice("已请求启动游戏");
    } catch (cause) {
      const message = `启动游戏失败：${cause instanceof Error ? cause.message : String(cause)}`;
      setError(message);
      showAppNotice(message, "error");
    } finally { launchInFlight.current = false; setLaunching(false); }
  };
  useEffect(() => {
    if (!manualLaunch.current || status.action !== "apply" || status.gamePath !== game.path || status.state === "running") return;
    manualLaunch.current = false;
    if (status.state === "applied") void launchGame();
  }, [status]);
  const confirmInstalledPatch = () => !(patch.installed || patch.legacy) || confirm(
    "当前游戏已有文本补丁。继续会按当前生成的译文更新补丁，请先关闭游戏。",
    {title:"已有文本补丁",okLabel:"继续更新",cancelLabel:"取消"});
  const hasTextScan = !!(scanPath || textInfo.sourcePath);
  const start = async (action: string,jsonPath=file) => {
    if (action === "extract" && hasTextScan) {
      if (!await confirm("清除文本译文、草稿、图片筛选、识别及译图结果后重新扫描，处理配置保留。", {title:"重新扫描资源",okLabel:"重新扫描",cancelLabel:"取消"})) return;
      if (!await textHandle.current?.prepare()) return;
    }
    if (action === "apply" && !await confirmInstalledPatch()) return;
    if (action === "runtime") {
      const currentFile = await textHandle.current?.prepare();
      if (!currentFile) return;
      jsonPath = currentFile;
    }
    touched.current = true; setPending(true); setPendingAction(action); setError("");if(["extract","inspect","runtime","uninstall-text","cleanup-text","rollback"].includes(action))setGenerated(false);
    if(action==="extract"&&supportsImages){setImageScanRequest(value=>value+1);}
    try {
      const value=await call<Status>("start", { action, gamePath: game.path, jsonPath, backupId, fontPath, backupMode, backupScopes });
      manualLaunch.current = action === "apply" && launchAfterApply;
      setStatus(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setPending(false); }
  };
  const dropped = async (path: string) => {
    if (busyRef.current) return;
    if(/\.(json|csv|png|jpe?g|webp|bmp|zip)$/i.test(path))return;
    const change=()=>void textHandle.current?.leave().then(ok=>{if(ok){touched.current=true;onGameDrop(path);}});
    if(imageLeaveGuard.current)imageLeaveGuard.current(change);else change();
  };
  useEffect(() => {
    if (!isTauri() || !active) return;
    let disposed = false, unlisten: (() => void) | undefined;
    void getCurrentWindow().onDragDropEvent(event => {
      if (event.payload.type === "drop" && event.payload.paths[0]&&!gameDropTarget(event.payload.position)?.closest("[data-game-drop-zone]")) void dropped(event.payload.paths[0]);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(cause => setError(String(cause)));
    return () => { disposed = true; unlisten?.(); };
  }, [active]);
  const stopAutomatic = () => { automaticAbort.current?.abort(); textHandle.current?.stop(); imageHandle.current?.stop(); void call("stop",{}).catch(cause=>appendLog(`中止请求失败：${String(cause)}`,"error")); };
  const runAutomatic = async () => {
    if (automaticAbort.current || busy) return;
    if (!await confirmInstalledPatch()) return;
    if (!await textHandle.current?.leave()) return;
    if (supportsImages && !await imageHandle.current?.prepare()) return;
    const controller = new AbortController(); automaticAbort.current=controller;followAutomatic.current=true;setAutomatic("running");setError("");
    const checkpoint = (phase:string,state="running") => localStorage.setItem(automaticKey,JSON.stringify({phase,state}));
    const check = () => { if(controller.signal.aborted)throw new DOMException("一键流程已中止","AbortError"); };
    const tick = () => new Promise<void>(resolve=>window.setTimeout(resolve,150));
    const backend = async (action:string,jsonPath="") => {
      check();checkpoint(action);setPendingAction(action);
      let value=await call<Status>("start",{action,gamePath:game.path,jsonPath,fontPath,backupMode,backupScopes});setStatus(value);
      while(value.state==="running"){await tick();check();value=await call<Status>("status");setStatus(value);}
      check();if(value.state==="error"||value.state==="stopped"||value.blocked)throw new Error(value.detail||`${action}未完成`);return value;
    };
    try {
      appendLog("开始一键生成并应用");
      if (!latestWorkflow.current.text.sourcePath || latestWorkflow.current.text.loadResult?.path !== scanPath) {
        if (followAutomatic.current) { setPart("text"); setTextStep(1); }
        const { exportPath } = await backend("extract");
        if (!exportPath) throw new Error("扫描完成后没有生成文本文件");
        setScanPath(exportPath);
        while (latestWorkflow.current.text.loadResult?.path !== exportPath) { check(); await tick(); }
        const issue = latestWorkflow.current.text.loadResult?.error;
        if (issue) throw new Error(issue);
        if (!latestWorkflow.current.text.sourcePath) throw new Error("扫描后的文本工程为空");
      }
      check();
      checkpoint("translate");if (followAutomatic.current) setTextStep(2);
      const results=await Promise.all([
        workflowRef.current.textSkipped?Promise.resolve(true):textHandle.current!.automatic(controller.signal),
        !supportsImages||workflowRef.current.imagesSkipped?Promise.resolve(true):imageHandle.current!.automatic(controller.signal)
      ]);
      check();if(results.some(value=>!value))throw new Error("文本或图片尚未完成，进度已保存；可修正后继续或跳过剩余内容");
      const translated=await textHandle.current!.prepare();if(!translated)throw new Error("译文未能保存");
      await tick(); check();
      if (latestWorkflow.current.text.changed > 0 || latestWorkflow.current.text.positionRepairs) {
        if (followAutomatic.current) { setPart("text"); setTextStep(3); }
        const inspected=await backend("inspect",translated);if(!inspected.matched)throw new Error("没有可写回的译文或对话修正");await backend("embed",translated);setGenerated(true);
        await backend("apply",translated);
      } else appendLog("没有需要回写的文本，保留游戏原文");
      if (followAutomatic.current) { setPart("text"); setTextStep(3); }
      check();
      if(supportsImages&&!await imageHandle.current!.apply())throw new Error("图片应用未完成，已完成结果保留");
      check();
      checkpoint("done","done");setAutomatic("done");appendLog("一键生成并应用完成","success");
      if (launchAfterApply) await launchGame();
    } catch(cause) {const stopped=controller.signal.aborted;checkpoint("paused",stopped?"stopped":"error");setAutomatic(stopped?"stopped":"error");const text=stopped?"一键流程已中止，进度已保存":cause instanceof Error?cause.message:String(cause);if(!stopped)setError(text);appendLog(text,stopped?"warning":"error");}
    finally {automaticAbort.current=null;void loadPatch();}
  };
  useEffect(()=>()=>{automaticAbort.current?.abort();textHandle.current?.stop();imageHandle.current?.stop();},[]);
  const pickFont = async () => {try{const selected=await open({multiple:false,filters:[{name:"字体",extensions:["ttf","otf"]}]});if(typeof selected==="string")setFontPath(selected);}catch(cause){setError(String(cause));}};


  useEffect(()=>{if(status.exportPath)setScanPath(status.exportPath);if(status.action==="embed"&&status.state==="done"||status.action==="apply"&&status.state==="applied")setGenerated(true);},[status.exportPath,status.action,status.state]);
  useEffect(()=>{if(!buildAfterCheck.current)return;if(status.state==="ready"){buildAfterCheck.current=false;if(!status.matched||status.blocked)setError(`译文检查未通过：命中 ${status.matched||0} 处，异常 ${status.blocked||0} 处，请修正后重新生成`);else void start("embed");}else if(status.state==="error"||status.state==="stopped")buildAfterCheck.current=false;},[status.state]);
  useEffect(()=>{let alive=true;void gameTextRequest<GamePatchWorkflow>("workflow",{gamePath:game.path,sourcePath:textInfo.sourcePath}).then(value=>{if(alive)setWorkflow(value);}).catch(cause=>setError(String(cause)));return()=>{alive=false;};},[game.path,textInfo.sourcePath]);
  const updateWorkflow=async(changes:Partial<GamePatchWorkflow>)=>{
    const previous=workflowRef.current;
    setWorkflow(previous=>({...previous,...changes}));
    const job=workflowWrites.current.then(()=>gameTextRequest<GamePatchWorkflow>("workflow",{gamePath:game.path,sourcePath:textInfo.sourcePath,...changes}));workflowWrites.current=job.then(()=>{},()=>{});
    try{setWorkflow(await job);return true;}catch(cause){setWorkflow(previous);setError(`保存跳过选择失败：${String(cause)}`);return false;}
  };workflowUpdate.current=updateWorkflow;
  const skipPart=async(images:boolean)=>{
    if(busy)return;
    if(!await confirm(images?"跳过尚未完成的图片？已完成的译图保留，其余图片保持原样。":"跳过尚未完成的文本？已有有效译文保留，其余文本保持原文。",{title:images?"跳过 2.2":"跳过 2.1",okLabel:"跳过剩余",cancelLabel:"取消"}))return;
    if(!images&&!await textHandle.current?.prepare())return;
    if(await updateWorkflow(images?{imagesSkipped:true}:{textSkipped:true}))appendLog(images?"已跳过剩余图片，已有译图保留":"已跳过剩余文本，已有有效译文保留","success");
  };
  const skipImages=()=>{const change=()=>void skipPart(true);if(imageLeaveGuard.current)imageLeaveGuard.current(change);else change();};
  const canGenerate=gamePatchCanGenerate(textInfo,imageWorkflow,supportsImages,workflow);
  const generateTextPatch=async()=>{
    if(busy)return;
    if(!canGenerate){setError("请先完成文本和图片翻译，或分别跳过剩余内容，再生成补丁");return;}
    const path=await textHandle.current?.prepare();if(!path)return;setFile(path);setGenerated(false);buildAfterCheck.current=true;await start("inspect",path);
  };

  const progress = (actions: string[], idle?: { step: string; title: string; done: boolean }) => {
    const action=pending ? pendingAction : status.action;
    const matches=!!action&&actions.includes(action);
    if(!matches&&!idle)return null;
    const step=matches?(action==="extract"?"1":"3"):idle!.step;
    const title=matches?(action==="extract"?"扫描资源":action==="inspect"?"检查译文":action==="embed"?"生成补丁":action==="backup"?"备份":action==="rollback"?"恢复":action==="apply"?"应用到游戏":"处理资源"):idle!.title;
    const running=matches&&(pending||status.state==="running"),failed=!running&&(matches&&status.state==="error"||step==="1"&&!!scanLoadError);
    const stopped=matches&&status.state==="stopped";
    const done=!failed&&(matches?!running&&!stopped:!!idle?.done);
    const total = matches && !pending ? status.total : undefined;
    const completed = status.completed ?? 0;
    return <GameStepProgress title={`步骤 ${step} · ${title}`}
      state={running ? "running" : failed ? "error" : stopped ? "stopped" : done ? "done" : "pending"}
      percent={total ? Math.floor(completed / total * 100) : undefined}
      count={total ? `${completed} / ${total}` : undefined}
      actions={running && <button className="unity-btn" onClick={() => void call("stop", {}).catch(e => setError(String(e)))}>中止</button>}>
      {running && <p className="unity-task-detail">{pending ? "正在准备…" : status.detail}</p>}
    </GameStepProgress>;
  };
  const output = (label:string,path?:string) => path&&<div className="json-embedding-output"><button type="button" className="embed-path-link" data-tooltip={path} aria-label={`打开${label}`} onClick={()=>void api.revealPath(path).catch(e=>setError(String(e)))}><span>{label}</span><code>{path}</code></button></div>;

  const backupPanel=<section className="embed-section game-backup-settings" data-section="backup">
    <div className="game-maintenance-row"><h3>备份</h3><IconAction name="help" label="自动：应用前按所选范围创建备份。手动：点击立即备份时按所选范围创建备份。补丁卸载所需安装原件另行保留。"/>
      <label>方式<select aria-label="备份方式" value={backupMode} disabled={busy} onChange={e=>{const mode=e.target.value as "auto"|"manual";setBackupMode(mode);localStorage.setItem(`llmchat-game-backup:${game.path}`,mode);}}><option value="auto">自动备份</option><option value="manual">手动备份</option></select></label>
      <button type="button" className="unity-btn" disabled={busy||!game.supported||!backupScopes.length} onClick={()=>void start("backup")}>立即备份</button>
    </div>
    <div className="game-backup-scopes" role="group" aria-label="备份范围"><span>范围</span>{availableBackupScopes.map(([scope,label])=><label key={scope}><input type="checkbox" aria-label={label} disabled={busy} checked={backupScopes.includes(scope)} onChange={e=>setBackupScopes(current=>e.target.checked?[...current,scope]:current.filter(item=>item!==scope))}/>{label}</label>)}</div>
    {progress(["backup"])}{output("备份",status.backupPath)}
  </section>;
  const restorePanel=<section className="embed-section game-restore-settings" data-section="restore"><div className="game-maintenance-row"><h3>恢复</h3>
    <select aria-label="选择回滚备份" disabled={busy||!backups.length} value={backupId} onChange={e=>setBackupId(e.target.value)}><option value="">选择备份</option>{backups.map((item,index)=><option key={item.id} value={item.id} disabled={item.state==="rolledBack"}>{index+1} · {item.resources} 组资源 · {item.state==="snapshot"?"独立备份":item.state==="rolledBack"?"已回滚":item.state==="applied"?"已应用":"待恢复"}</option>)}</select>
    <IconAction name="refresh" label="刷新备份列表" disabled={busy} onClick={()=>void loadBackups()}/><button type="button" className="unity-btn unity-btn-warning unity-important-action" disabled={busy||!backupId} onClick={()=>void start("rollback")}>恢复</button>
  </div>{progress(["rollback"])}</section>;

  const canWritePatch = !busy && !patch.conflicts.length && !(backupMode === "auto" && !backupScopes.length);
  const patchStatus = detecting ? "正在检测补丁…" : patch.conflicts.length ? "游戏资源已改变" :
    patch.installed ? "文本补丁已安装" : patch.legacy ? "发现旧版文本补丁" : patch.managed ? "文本补丁已卸载" : "未安装文本补丁";
  const applyImages = async () => {
    if (!await imageHandle.current?.apply()) return;
    setImagesApplied(true);
    if (launchAfterApply) await launchGame();
  };
  const deploymentPanel = <div className="embed-deployment">
    <section className="embed-deploy-main" aria-label="安装补丁">
      <div className="embed-deploy-status" role="status">
        <strong className={patch.conflicts.length ? "is-warning" : patch.installed ? "is-installed" : ""}>{patchStatus}</strong>
        {patch.conflicts.length ? <span>请先处理文件冲突，再更新或卸载。</span> :
          patch.installed ? <span>可以直接启动游戏，或生成新补丁后更新。</span> :
          patch.legacy ? <span>检测补丁后可接管现有安装。</span> : null}
      </div>
      <div className="embed-deploy-launch">
        <button type="button" className="unity-btn unity-btn-primary" disabled={busy || !game.supported} onClick={() => void launchGame()}>{launching ? "正在启动…" : "启动游戏"}</button>
        <label><input type="checkbox" checked={launchAfterApply} disabled={busy} onChange={event => {
          const value = event.target.checked;
          setLaunchAfterApply(value);
          localStorage.setItem(launchPreference, String(value));
        }} />应用后启动</label>
      </div>
      <div className="embed-deploy-actions">
        <button type="button" className="unity-btn" data-tooltip="写入文本补丁前请先关闭游戏" disabled={!canWritePatch || !generated} onClick={() => void start("apply")}>{patch.installed ? "更新文本补丁" : "应用文本补丁"}</button>
        {supportsImages && <button type="button" className="unity-btn" data-tooltip="写入译图前请先关闭游戏" disabled={!canWritePatch || !imageWorkflow.valid} onClick={() => void applyImages()}>应用译图</button>}
        <IconAction name="refresh" caption="检测补丁" label="检测已安装补丁及文件改动" disabled={busy} onClick={() => void loadPatch(true)} />
        <IconAction name="rollback" caption="卸载文本" label="卸载文本补丁并恢复安装前资源" disabled={busy || !patch.installed || !!patch.conflicts.length} onClick={() => void start("uninstall-text")} />
        {supportsImages && <IconAction name="rollback" caption="卸载译图" label="卸载译图并保留已应用的去码图" disabled={busy || !imageWorkflow.loaded} onClick={async () => { if (await imageHandle.current?.uninstall()) setImagesApplied(false); }} />}
        <IconAction name="stop" caption="清理" label="清理已卸载文本补丁的安装原件和关联工作目录，保留用户备份" disabled={busy || patch.installed || !patch.managed} onClick={() => void start("cleanup-text")} />
      </div>
    </section>
    {imageBusy && imageWorkflow.stage === "restore" && <GameStepProgress title="处理译图补丁" state="running" />}
    <div className="embed-deploy-maintenance">{backupPanel}{restorePanel}</div>
    {supportsImages && <details className="embed-runtime-options" data-section="runtime" open={status.action === "runtime" ? true : undefined}>
      <summary>运行时加载译文</summary>
      <div className="embed-form-row">
        <label className="embed-field embed-inline-field"><span>中文字体</span><div className="json-embedding-path">
          <input aria-label="中文字体" value={fontPath} placeholder="可选 TTF / OTF" disabled={busy} onChange={event => setFontPath(event.target.value)} />
          <IconAction name="json" label="选择中文字体，随本地翻译插件加载" disabled={busy} onClick={() => void pickFont()} />
        </div></label>
        <IconAction name="apply" caption="安装插件" label="安装或更新本地 JSON 翻译插件" disabled={!canWritePatch || !file} onClick={() => void start("runtime")} />
      </div>
      {progress(["runtime"])}
    </details>}
    {(["running", "error", "stopped"].includes(status.state) || pending) && progress(["apply", "uninstall-text", "cleanup-text"])}
  </div>;

  const workRoot = game.path.replace(/[\\/]+$/, "") + "/LLMChat-JSON";
  const workDirectory = <GameWorkDirectory path={workRoot} disabled={!status.outputPath&&!textInfo.sourcePath&&!imageWorkflow.folder} onOpen={path=>void api.revealPath(path).catch(cause=>setError(String(cause)))}/>;
  const gameRoot = game.path.replace(/[\\/]+$/, "");
  const validationErrors = (status.issues || []).map((issue, index): BatchRow => {
    const name = issue.file.replace(/\\/g, "/");
    const locations = name.includes("/") ? [name, "www/" + name] : ["data/" + name, "www/data/" + name];
    return { id: "validation-" + index, kind: "resource", label: issue.file || "译文检查",
      detail: issue.reason, text: { source: issue.source, translation: issue.translation },
      paths: [...(name ? locations.map(path => gameRoot + "/" + path) : []), gameRoot] };
  });
  const fileConflicts = patch.conflicts.filter(path => !matchedImageConflicts.has(path))
    .map((path): BatchRow => ({ id: "patch-" + path, kind: "resource", label: path,
      detail: "补丁资源存在改动", paths: [gameRoot + "/" + path, gameRoot + "/" + path.replace(/[/\\][^/\\]*$/, ""), gameRoot] }));
  const locateBatch = (row: BatchRow) => {
    const textId = row.kind === "text" ? row.id : row.kind === "resource" && row.text ?
      textHandle.current?.findText?.(row.text.source, row.text.translation) : undefined;
    if (row.kind === "resource" && textId === undefined) {
      void (async () => {
        for (const path of row.paths) {
          try { await api.revealPath(path); return; }
          catch (error) { if (!(error instanceof Error) || !error.message.includes("路径不存在")) throw error; }
        }
        throw new Error("找不到资源位置：" + row.label);
      })().catch(cause => setError(String(cause)));
      return;
    }
    if (textId === undefined) return;
    const show = () => {
      setTextStep(2);
      setPart("text");
      textHandle.current?.locate?.(textId);
    };
    if (part === "images" && imageLeaveGuard.current) imageLeaveGuard.current(show);
    else show();
  };
  const textBatch = (textFailures.length > 0 || textRepairs.length > 0) && <GameBatchResults errors={textFailures} repairs={textRepairs} onLocate={locateBatch}
    onRetry={textFailures.length && !busy && textHandle.current?.canRetryFailures ? () => textHandle.current?.retryFailures?.() : undefined} />;
  const scanResources = <section className="unity-scan-resources" aria-label="资源信息"><h3>资源信息</h3>
    {workDirectory}
    <p>已扫描文本：{textInfo.count} 条</p>{textInfo.messageCore && <p>已启用 YEP Message Core。可在译文末尾用 <code>{"\\nc<人物名>"}</code> 补充居中姓名。</p>}<p>图片资源：{imageWorkflow.count===null?"未读取":`${imageWorkflow.count} 张`}</p>
    {textInfo.sourcePath&&<p>扫描文本：<code className="game-resource-path" data-tooltip={textInfo.sourcePath}>{textInfo.sourcePath}</code></p>}
    {imageWorkflow.folder&&<p>图片工程：<code className="game-resource-path" data-tooltip={imageWorkflow.folder}>{imageWorkflow.folder}</code></p>}
  </section>;
  const activeWorkflowId = part === "mosaic" ? "2.3" : part === "images" ? "2.2" : textStep === 2 ? "2.1" : String(textStep);
  const selectWorkflow = (id: string) => {
    if (id === activeWorkflowId) return;
    const change = () => {
      followAutomatic.current = false;
      if (id === "2.2" || id === "2.3") {
        setPart(id === "2.3" ? "mosaic" : "images");
        setTextStep(2);
      } else {
        setPart("text");
        setTextStep(id === "2.1" ? 2 : Number(id));
      }
    };
    if (part === "images" && imageLeaveGuard.current) imageLeaveGuard.current(change);
    else if (part === "text" && textInfo.dirty) void textHandle.current?.leave().then(ok => { if (ok) change(); });
    else change();
  };
  const workflowSteps=<GameWorkflowSteps idPrefix="embed-step" panelId="embed-step-panel" steps={[{id:"1",label:"扫描资源"},{id:"2.1",label:"文本翻译"},...(supportsImages?[{id:"2.2",label:"图片翻译"},{id:"2.3",label:"图片去码"}]:[]),{id:"3",label:"生成与应用"}].map(item=>{
    const selected=item.id===activeWorkflowId;
    const operationStep=(pending ? pendingAction : status.action)==="extract"?"1":"3";
    const imageStep=imageWorkflow.stage==="restore"?"3":"2.2";
    const running=mosaicBusy&&item.id==="2.3"||textInfo.running&&item.id==="2.1"||imageBusy&&item.id===imageStep||(pending||status.state==="running")&&operationStep===item.id;
    const scanned=!!scanPath||textInfo.count>0;
    const completed=item.id==="1"&&scanned||item.id==="2.1"&&scanned&&(workflow.textSkipped||textInfo.done===textInfo.selected)||item.id==="2.2"&&(imageWorkflow.complete||workflow.imagesSkipped)||item.id==="2.3"&&mosaicComplete||item.id==="3"&&(patch.installed||imagesApplied||!patch.conflicts.length&&automatic==="done");
    const ready=item.id==="1"||item.id==="2.3"&&imageWorkflow.loaded||["2.1","2.2"].includes(item.id)&&scanned||item.id==="3"&&(canGenerate||generated||imageWorkflow.valid>0);
    const failed=!!scanLoadError&&item.id==="1"&&!running||!scanLoadError&&textInfo.state==="error"&&item.id==="2.1"||imageWorkflow.state==="error"&&item.id===imageStep||status.state==="error"&&operationStep===item.id;
    const state=failed?"error":running?"current":completed?"complete":ready?"current":"pending";
    return {...item,state,selected,paused:!completed&&(textInfo.state==="stopped"&&item.id==="2.1"||imageWorkflow.state==="stopped"&&item.id===imageStep||status.state==="stopped"&&operationStep===item.id),running,onSelect:()=>selectWorkflow(item.id)};
  })}/>;
  return <div className="json-embedding-view" onClickCapture={event => logGameButton(event, appendLog)} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();const file=event.dataTransfer.files[0] as (File&{path?:string})|undefined;const raw=file?.path||event.dataTransfer.getData("text/uri-list").split(/\r?\n/).find(line=>!line.startsWith("#"));if(raw)void dropped(raw.startsWith("file://")?decodeURIComponent(raw.replace(/^file:\/\/\/?/,"")):raw);}}>{confirmation.dialog}
    <main className="embed-workspace embed-unity-workspace">
      <header className="embed-game-header"><IconAction name="back" label="返回游戏列表" disabled={busy} onClick={()=>{const change=()=>void textHandle.current?.leave().then(ok=>{if(ok)onBack();});if(imageLeaveGuard.current)imageLeaveGuard.current(change);else change();}}/><strong data-tooltip={game.name}>{game.name}</strong><span className="embed-engine">{game.engine}</span><button type="button" className="embed-game-location" data-tooltip={game.path} aria-label={game.path} onClick={()=>void api.revealPath(game.path).catch(e=>setError(String(e)))}>{game.path}</button><div className="unity-top-actions unity-header-icon-group" style={{marginLeft:"auto",flexShrink:0}}><UnityIconButton aria-label={automatic==="running"?"中止一键流程":automatic==="stopped"||automatic==="error"?"继续一键生成并应用":"一键生成并应用"} title={automatic==="running"?"中止并保存文本和图片进度":`扫描、并行翻译文本与图片、生成并应用${game.engine}补丁`} disabled={automatic!=="running"&&busy} onClick={()=>automatic==="running"?stopAutomatic():void runAutomatic()}><UnityActionIcon kind={automatic==="running"?"cancel":"run"}/></UnityIconButton><UnityIconButton aria-label="游戏翻译设置" title="打开游戏翻译设置" disabled={busy||!onOpenSettings} onClick={onOpenSettings}><UnityActionIcon kind="settings"/></UnityIconButton><UnityIconButton aria-label="测试队列" title="测试队列" disabled={busy} onClick={() => {
      const input = textHandle.current?.benchmark?.();
      if (input) openGameTextBenchmark({ ...input, images: imageHandle.current?.benchmark(), initialPart: part === "images" ? "images" : "text" });
    }}><UnityActionIcon kind="benchmark" /></UnityIconButton>{isUnreal && <GameMosaicPatchButton gamePath={game.path} disabled={busy} />}<GameWorkflowHelp mode="embedded" supportsImages={supportsImages} /></div></header>

      <UnityGameWorkspace steps={workflowSteps} controls={<div ref={setControlsTarget} id="embed-step-panel" role="tabpanel" aria-labelledby={`embed-step-${activeWorkflowId}`} className="engine-workspace-slot"/>} results={<div ref={setResultsTarget} className="engine-workspace-slot engine-result-slot"/>}/>
      {controlsTarget&&createPortal(<div hidden={part!=="text"||textStep===2} className="engine-workflow-content"><div className="unity-step-panel">

        {textStep===1&&<div className="unity-task-actions"><button className="unity-btn unity-btn-primary" disabled={busy && !(status.action === "extract" && status.state === "running" || pending && pendingAction === "extract")} onClick={()=>status.action === "extract" && status.state === "running" || pending && pendingAction === "extract" ? stopScan() : void start("extract")}>{status.action === "extract" && status.state === "running" || pending && pendingAction === "extract" ? "中止扫描" : hasTextScan?"重新扫描资源":"开始扫描"}</button></div>}
        {textStep===3&&<>
          <div className="unity-control-group"><span>待回写译文 {textInfo.changed} 条</span>{!!textInfo.positionRepairs && <span>对话纠错 {textInfo.positionRepairs} 条</span>}</div>
          <div className="unity-task-actions"><button className="unity-btn unity-btn-primary" data-tooltip="保存当前编辑并检查译文匹配、控制符及游戏资源，再生成补丁" disabled={busy||!canGenerate} onClick={()=>void generateTextPatch()}>生成补丁</button></div>
          {progress(["inspect","embed"])}
          {output("补丁目录",status.patchPath)}
          {deploymentPanel}
        </>}
        {textStep===1&&progress(["extract"],{step:"1",title:"扫描资源",done:!!scanPath||textInfo.count>0})}
        {textStep === 1 && isUnreal && !hasTextScan && <p className="hint">
          {game.textSupported === false
            ? "当前目录没有散装 .locres。若本地化文件在 Pak 或 IoStore 中，先用匹配游戏版本的工具导出到对应的 Content/Localization，再扫描。"
            : "扫描 Content/Localization 下的 .locres 文件。按游戏实际使用的原文语言筛选后再翻译。"}
        </p>}
        {textStep===1&&scanResources}
        {textStep===3&&validationErrors.length>0&&<div className="unity-step-batch"><GameBatchResults errors={validationErrors} onLocate={locateBatch}/></div>}
        {textStep===3&&fileConflicts.length>0&&<div className="unity-step-batch"><GameBatchResults errors={fileConflicts} onLocate={locateBatch}/></div>}
        {textStep===3&&patch.conflicts.some(path=>matchedImageConflicts.has(path))&&<button type="button" className="unity-btn" onClick={()=>selectWorkflow("2.2")}>查看图片补丁冲突</button>}
        </div></div>,controlsTarget)}
      <GameTextWorkspace testConfigurations={testConfigurations} testConfigurationDisabled={busy || !textInfo.sourcePath} gamePath={game.path} settings={settings} sourcePath={scanPath} controls={controlsTarget} results={resultsTarget} batchResults={textBatch} visible={part==="text"} step={textStep} active={active} disabled={mosaicBusy||pending||detecting||status.state==="running"} skipped={workflow.textSkipped} onSkip={()=>void skipPart(false)} handle={textHandle} onInfo={textInfoChanged} onBatchFailures={setTextFailures} onBatchCorrections={setTextRepairs} onMessage={textLog}/>
      {supportsImages&&<GameMosaicCompletionContext.Provider value={setMosaicComplete}><GameImageWorkbench mosaicActive={active&&part==="mosaic"} mosaicDisabled={workflowBusy} onMosaicBusy={setMosaicBusy} testConfigurations={testConfigurations} testConfigurationDisabled={busy || !textInfo.sourcePath} patchConflictPaths={patch.conflicts} onMatchedPatchConflicts={setMatchedImageConflicts} handle={imageHandle} workspaceTargets={{controls:controlsTarget,results:resultsTarget}} scanRequest={imageScanRequest} skipped={workflow.imagesSkipped} onSkip={skipImages} onResetSkipped={()=>{if(workflowRef.current.imagesSkipped)void updateWorkflow({imagesSkipped:false});}} leaveGuard={imageLeaveGuard} onTaskStateChange={setImageWorkflow} workflowStage={textStep===3?"apply":"images"} backupScopes={backupScopes} gamePath={game.path} settings={settings} backupMode={backupMode} active={active&&part==="images"} disabled={mosaicBusy||pending||detecting||status.state==="running"} onBusy={setImageBusy} onMessage={imageLog}/></GameMosaicCompletionContext.Provider>}

    </main>

  </div>;
}
