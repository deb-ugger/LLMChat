import { hasMosaicDrafts, saveMosaicDrafts, useHasMosaicDrafts } from "./game-mosaic/mosaicDrafts";
import { benchmarkBlockingReason, isBenchmarkRunning, useBenchmarkRunning, useFormalWorkflowActivity } from "../benchmark/benchmarkRunner";
import { writeOutput, type OutputLevel } from "../appOutput";
import { useGameTestConfigurationSource } from "../gameAuxWindows";
import { GameBatchResults, type BatchRow } from "./GameBatchResults";
import { GameFlowPerformance, StepRunningMetrics } from "./GameFlowSequence";
import { StandaloneGameFlowCard } from "./GameFlowCard";
import { GameStepProgress, gameProgressLabels } from "./GameStepProgress";
import { formatFlowThroughput } from "../gameFlowMetrics";
import { showAppNotice } from "./AppNotice";
import type { GameTestConfigurationAccess } from "../gameModelPreset";
import { gameAvailableModels } from "./GameTranslationTabs";
import { openGameTextBenchmark } from "./GameTextBenchmarkDialog";
import { useProjectBenchmarkLauncher } from "../gameBenchmarkWindow";
import { GameMosaicPatchButton } from "./GameMosaicPatchButton";
import { GameMosaicCompletionContext, type GameMosaicDeploymentHandle } from "./GameMosaicWorkbench";
import { UnityIconButton } from "./UnityIconButton";
import { UnityActionIcon } from "./UnityActionIcon";
import { loadGameStage, rememberGameStage, rememberRecentGameFailures } from "../unityLastGame";
import { useGameActionConfirm, logGameButton } from "./GameActionConfirm";
import { gameTextRequest } from "../gameTextProject";
import { beginGameStep, finishGameStep, gameDuration, reportGameStepItems, stepPerformance } from "../gameModelPerformance";
import { deploymentMetrics, deploymentMetricScope, isGameDeploymentComplete, measureDeploymentStage } from "../unityWorkflow";
import { gamePatchCanGenerate, type GamePatchWorkflow } from "../gamePatchWorkflow";
import { GameWorkDirectory } from "./GameWorkDirectory";
import { gameDropTarget } from "../hooks/useGameFileDrop";
import { GameTextWorkspace, type GameTextHandle, type GameTextInfo } from "./GameTextWorkspace";
import { UnityGameWorkspace } from "./UnityGameWorkspace";
import { GameWorkflowSteps } from "./GameWorkflowSteps";
import { DeploymentCanvas, DeploymentThroughput, ImageExportPackageSection, LegacyImagePatchSection, deploymentSequence, loadDeploymentPlan, saveDeploymentPlan, validateDeploymentPlan,
  type DeploymentStep as CanvasStep, type DeploymentPhase as CanvasPhase, type DeploymentModel } from "./UnityDeploymentPanel";
import { GameImageWorkbench, type GameImageInfo, type GameImageHandle } from "./GameImageWorkbench";
import { createPortal } from "react-dom";
import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { API_BASE, api, type Settings } from "../api";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useGameImageExportPackage } from "../hooks/useGameImageExportPackage";
const paths: Record<string, string> = { back: "m14 5-7 7 7 7M7 12h14", extract: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5", json: "M7 3H4v18h3m10-18h3v18h-3M10 8l-2 4 2 4m4-8 2 4-2 4", backup: "M4 4h16v6H4zM6 10v11h12V10m-9 4h6", refresh: "M20 8a8 8 0 1 0 0 8m0-13v5h-5", rollback: "M9 4 3 10l6 6M3 10h11a6 6 0 0 1 0 12", inspect: "M4 4h11v16H4zM8 9h3m-3 5h3m6-2 3 3 4-6", generate: "M5 3h10l4 4v14H5zM9 12h6m-3-3v6", apply: "m4 12 5 5 11-12", stop: "M5 5h14v14H5z", open: "M10 4H3v17h17v-7M14 3h7v7m0-7L10 14", help: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m-3 7a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3v1" };
function IconAction({ name, label, caption, hint, disabled, onClick }: { name: string; label: string; caption?: string; hint?: string; disabled?: boolean; onClick?: () => void }) {
  return <span className="embed-action" data-tooltip={hint || label} tabIndex={disabled ? 0 : undefined} aria-label={disabled ? label : undefined}><button type="button" className={`embed-icon${name==="help"?" is-help":""}${caption?" has-caption":""}`} aria-label={label} disabled={disabled} onClick={onClick}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>{caption&&<span>{caption}</span>}</button></span>;
}
export type EmbeddingGame = { path: string; name: string; engine: string; supported: boolean; textSupported?: boolean };
function embeddingCapabilities(game: EmbeddingGame) {
  const rpgMaker = game.supported && game.engine.startsWith("RPG Maker");
  const wolf = game.supported && game.engine === "WOLF RPG";
  const unreal = game.supported && game.engine === "Unreal Engine";
  return {
    textSource: unreal ? "locres" : rpgMaker || wolf ? "engine-data" : null,
    imageProject: rpgMaker || wolf || unreal,
    imageExport: rpgMaker || wolf,
    selfMosaic: rpgMaker || wolf || unreal,
    thirdPartyMosaic: unreal,
    runtimeDictionary: rpgMaker,
    backupScopes: [
      ...(rpgMaker || wolf ? [["text", "文本资源"]] : unreal ? [["text", "散装 .locres"]] : []),
      ...(rpgMaker ? [["runtime", "插件与字体"], ["images", "图片资源"]] : []),
      ...(wolf || unreal ? [["images", "散装图片"]] : []),
    ],
  };
}
type WolfBackupAvailability = { dataWolfPresent: boolean; looseText: boolean; textArchives: boolean; looseImages: boolean; textIncludesImages: boolean };
type WolfBackupCategory = "looseText" | "dataWolf" | "looseImages" | "installationOriginals" | "textArchives";
type WolfBackupCoverage = Record<WolfBackupCategory, { included: boolean; count: number }>;
type Backup = { id: string; path: string; state: string; resources: number };
type Status = { issues?: Array<{file:string;source:string;translation:string;reason:string}>; state: string; action?: string; detail?: string; gamePath?: string; jsonPath?: string; outputPath?: string; exportPath?: string; imagesPath?: string; imageManifest?: string; patchPath?: string; backupPath?: string; backupCoverage?: WolfBackupCoverage; matched?: number; blocked?: number; dictionaryEntries?: number; completed?: number; total?: number };
const deploymentLabels = {
  scan: "扫描资源",
  translate: "翻译文本",
  translateImages: "翻译图片",
  inspect: "检查译文",
  generateText: "生成文本补丁",
  generateImages: "生成译图",
  generateMosaic: "准备已确认的去码图",
  applyText: "应用文本补丁",
  applyImages: "应用译图",
  applyMosaic: "应用去码图",
  applyImagePackage: "生成并应用图片成品包",
  uninstallImages: "卸载译图",
  uninstallMosaic: "卸载去码图",
};
type DeploymentPhase = keyof typeof deploymentLabels;
type DeploymentRun = {
  mode: "automatic" | "manual";
  phase?: DeploymentPhase;
  state: "running" | "stopped" | "error" | "done";
  detail?: string;
};
function restoreAutomaticDeployment(raw: string | null): DeploymentRun | null {
  const saved = JSON.parse(raw || "null");
  if (!saved || typeof saved.phase !== "string" || !Object.hasOwn(deploymentLabels, saved.phase) ||
      !["running", "stopped", "error"].includes(saved.state)) return null;
  return {
    mode: "automatic",
    phase: saved.phase as DeploymentPhase,
    state: saved.state === "error" ? "error" : "stopped",
    detail: typeof saved.detail === "string" ? saved.detail : undefined,
  };
}

const backendStepLabels: Record<string, string> = {
  extract: "扫描资源", inspect: "检查译文", embed: "生成文本补丁", apply: "应用文本补丁",
  backup: "备份游戏", rollback: "恢复备份", runtime: "安装翻译插件",
  "uninstall-text": "卸载文本补丁", "cleanup-text": "清理文本补丁",
};

type ImageArtifact = { ids: string[]; applied: boolean; patchId?: string; path?: string };
type DeploymentArtifacts = {
  text?: { path: string; applied: boolean };
  images?: ImageArtifact;
  mosaic?: ImageArtifact;
};
type DeploymentStep = <T>(phase: DeploymentPhase, action: () => Promise<T>) => Promise<T>;
const deploymentPoll = () => new Promise<void>(resolve => window.setTimeout(resolve, 150));
async function call<T>(action: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/api/json-embedding/${action}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || "操作失败"); return value;
}
export function JsonEmbeddingView({ onBack, initialGame: game, onGameDrop, settings, active = true }: { settings: Settings; onBack: () => void; initialGame: EmbeddingGame; onGameDrop: (path: string) => void; active?: boolean }) {
  const { textSource, imageProject, imageExport, selfMosaic, thirdPartyMosaic, runtimeDictionary, backupScopes: availableBackupScopes } = embeddingCapabilities(game);
  const mosaicDirty = useHasMosaicDrafts(game.path);
  const [hasLooseLocres, setHasLooseLocres] = useState(game.textSupported === true);
  const [checkingTextSource, setCheckingTextSource] = useState(false);
  const needsLooseLocres = textSource === "locres" && !hasLooseLocres;
  const canUseTextResources = textSource !== null && !needsLooseLocres;
  const supportedPhases = useMemo<CanvasPhase[]>(() => [
    ...(canUseTextResources ? ["text" as const] : []), ...(imageProject ? ["image" as const] : []), ...(selfMosaic ? ["mosaic" as const] : []),
  ], [canUseTextResources,imageProject,selfMosaic]);
  const [planRevision, setPlanRevision] = useState(0);
  const plan = useMemo(() => loadDeploymentPlan(game.path,supportedPhases),[game.path,supportedPhases,planRevision]);
  const validation = validateDeploymentPlan(plan);
  const imageHandle = useRef<GameImageHandle | null>(null);
  const mosaicHandle = useRef<GameMosaicDeploymentHandle | null>(null);
  const deploymentAbort = useRef<AbortController | null>(null);
  const textActionRunning = useRef(false);
  const followAutomatic = useRef(true);
  const automaticKey = "llmchat-game-automatic:" + game.path;
  const [deployment, setDeployment] = useState<DeploymentRun | null>(() => {
    try { return restoreAutomaticDeployment(localStorage.getItem(automaticKey)); }
    catch { return null; }
  });
  const deploymentRunning = deployment?.state === "running";
  const automatic = deployment?.mode === "automatic" ? deployment.state : "idle";
  const artifactsKey = "llmchat-game-deployment-artifacts:" + game.path;
  const [artifacts, setArtifacts] = useState<DeploymentArtifacts>(() => {
    try { return JSON.parse(localStorage.getItem(artifactsKey) || "{}") || {}; }
    catch { return {}; }
  });
  useEffect(() => { localStorage.setItem(artifactsKey, JSON.stringify(artifacts)); }, [artifactsKey, artifacts]);
  const [controlsTarget,setControlsTarget]=useState<HTMLDivElement|null>(null),[resultsTarget,setResultsTarget]=useState<HTMLDivElement|null>(null);
  const [imageScanRequest,setImageScanRequest]=useState(0);
  const imageLeaveGuard=useRef<((change:()=>void)=>void)|null>(null);
  const savedStage = useRef(loadGameStage(game.path, imageProject)).current;
  const [textStep,setTextStep]=useState(Math.min(savedStage.step, 3));
  const [scanPath,setScanPath]=useState("");
  const [textInfo,setTextInfo]=useState<GameTextInfo>({count:0,selected:0,sourcePath:"",done:0,changed:0,dirty:false,running:false,state:"idle",translationPath:""});
  const scanLoadError = textInfo.loadResult?.path === scanPath ? textInfo.loadResult.error : undefined;
  const textHandle=useRef<GameTextHandle|null>(null);
  const textTarget = useRef<string | undefined>(undefined);
  const [workflow,setWorkflow]=useState<GamePatchWorkflow>({textSkipped:false,imagesSkipped:false});
  const workflowUpdate=useRef<(changes:Partial<GamePatchWorkflow>)=>Promise<boolean>>(async()=>false);
  const workflowWrites=useRef(Promise.resolve());
  const workflowRef=useRef(workflow);workflowRef.current=workflow;
  const textInfoChanged=useCallback((value:GameTextInfo)=>{const changedTarget=!!textTarget.current&&textTarget.current!==value.target;textTarget.current=value.target;if(value.dirty||value.running||changedTarget){setArtifacts(previous => previous.text ? { ...previous, text: undefined } : previous);if(workflowRef.current.textSkipped)void workflowUpdate.current({textSkipped:false});}setTextInfo(value);if(value.translationPath)setFile(value.translationPath);},[]);
  const [part,setPart]=useState<"text"|"images"|"mosaic">(savedStage.step >= 3 ? "text" : savedStage.part);
  const [mosaicBusy,setMosaicBusy]=useState(false);
  const [mosaicComplete,setMosaicComplete]=useState(false);
  const [packageMosaicIds, setPackageMosaicIds] = useState<string[]>([]);
  const updatePackageMosaicIds = useCallback((ids: string[]) => {
    setPackageMosaicIds(previous => previous.length === ids.length && previous.every((id, index) => id === ids[index]) ? previous : ids);
  }, []);
  useEffect(() => { rememberGameStage(game.path,textStep,part==="mosaic"?"images":part); }, [game.path,textStep,part]);
  const [imageWorkflow,setImageWorkflow]=useState<GameImageInfo>({state:"idle",stage:"filter",complete:false,count:null,folder:"",exists:null,loaded:false,selected:0,valid:0,dirty:false});
  const [textFailures, setTextFailures] = useState<BatchRow[]>([]);
  const [textRepairs, setTextRepairs] = useState<BatchRow[]>([]);
  const [matchedImageConflicts, setMatchedImageConflicts] = useState<ReadonlySet<string>>(() => new Set());
  const [imageBusy,setImageBusy]=useState(false);const [detecting,setDetecting]=useState(true);
  const [patch,setPatch]=useState<{installed:boolean;managed?:boolean;legacy?:boolean;conflicts:string[];wolfBackupAvailability?:WolfBackupAvailability}>({installed:false,conflicts:[]});
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
  const launchInFlight = useRef(false);
  const [backupMode,setBackupMode]=useState<"auto"|"manual">(()=>localStorage.getItem(`llmchat-game-backup:${game.path}`)==="manual"?"manual":"auto");
  const [backupScopes,setBackupScopes]=useState<string[]>(()=>{try{const saved=JSON.parse(localStorage.getItem(`llmchat-game-backup-scopes:${game.path}`)||(textSource==="locres"?'["text","images"]':'["text"]'));return Array.isArray(saved)?saved.filter(value=>availableBackupScopes.some(([scope])=>scope===value)):["text"];}catch{return ["text"];}});
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
  useEffect(()=>{if(!deploymentAbort.current&&status.state!=="running"&&status.state!=="idle"){void loadPatch();}},[game.path,status.state]);
  const [backups, setBackups] = useState<Backup[]>([]), [backupId, setBackupId] = useState("");
  const [applyingTestConfiguration, setApplyingTestConfiguration] = useState(false);
  const touched = useRef(false);
  const textBusy = textInfo.running || textInfo.state === "screening";
  const [exportBusy, setExportBusy] = useState(false);
  const [projectSaving, setProjectSaving] = useState(false);
  const projectDirty = textInfo.dirty || imageWorkflow.dirty || mosaicDirty;
  const otherWorkflowBusy = applyingTestConfiguration || checkingTextSource || deploymentRunning || pending || detecting || imageBusy || textBusy || status.state === "running" || launching;
  const workflowBusy = otherWorkflowBusy || exportBusy || projectSaving;
  const busy = workflowBusy || mosaicBusy;
  const textUnfinished = !workflow.textSkipped && !!textInfo.sourcePath && !textInfo.loadResult?.error &&
    (textInfo.state === "screen-stopped" || textInfo.selected > textInfo.done && ["stopped", "error"].includes(textInfo.state));
  const imageUnfinished = !workflow.imagesSkipped && imageWorkflow.loaded && !imageWorkflow.complete &&
    ["stopped", "error"].includes(imageWorkflow.state);
  const deploymentUnfinished = deployment?.mode === "automatic" && (deployment.state === "stopped" || deployment.state === "error");
  const deploymentLabel = deployment?.phase ? deploymentLabels[deployment.phase] : undefined;
  const textScreening = textInfo.state === "screening" || textInfo.state === "screen-stopped";
  const formalActivity = deploymentRunning || (!workflowBusy && deploymentUnfinished)
    ? { label: deploymentLabel || "一键流程", detail: deployment?.state === "error" ? deployment.detail || "失败待重试"
        : deployment?.state === "stopped" ? "已中止，等待继续" : undefined }
    : imageBusy || (!workflowBusy && imageUnfinished)
      ? { label: imageWorkflow.operation?.label || "图片翻译", detail: imageWorkflow.operation?.detail,
          completed: imageWorkflow.operation?.completed, total: imageWorkflow.operation?.total }
      : textBusy || (!workflowBusy && textUnfinished)
        ? { label: textScreening ? "筛选文本" : "翻译正文",
            detail: textUnfinished ? textInfo.state === "error" ? "失败待重试" : "已中止，等待继续" : undefined,
            completed: textScreening ? undefined : textInfo.done, total: textScreening ? undefined : textInfo.selected }
        : { label: applyingTestConfiguration ? "应用测试配置" : checkingTextSource ? "检查文本资源" :
            detecting ? "检测已安装补丁" : launching ? "启动游戏" : backendStepLabels[(pending ? pendingAction : status.action) || ""] || "工程处理",
            detail: status.state === "running" ? status.detail : undefined,
            completed: status.state === "running" ? status.completed : undefined, total: status.state === "running" ? status.total : undefined };
  useFormalWorkflowActivity(workflowBusy, game.name, formalActivity.label, formalActivity.completed, formalActivity.total,
    textUnfinished || imageUnfinished || deploymentUnfinished, formalActivity.detail);
  const testing = useBenchmarkRunning();
  const testTitle = testing ? benchmarkBlockingReason : undefined;
  const latestWorkflow = useRef({ text: textInfo, mosaicComplete }); latestWorkflow.current = { text: textInfo, mosaicComplete };
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
      if (busyRef.current || !text || !(textInfo.sourcePath || preset.images && imageWorkflow.loaded) || preset.images && !images) throw new Error("请等待工程读取或当前任务结束");
      setApplyingTestConfiguration(true);
      try {
        if (textInfo.sourcePath) await text.applyTestConfiguration(preset.text);
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
    if (alive && !touched.current && value.gamePath === game.path) { setFile(value.jsonPath || "");setStatus(value);if(imageProject && followAutomatic.current && value.action?.includes("images"))setPart("images"); }
    if(alive){await loadPatch(false);}
  }).catch(cause => { if (alive) setError(String(cause)); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (status.state !== "running" || deploymentAbort.current) return;
    let alive = true, timer: number;
    const poll = async () => { try { const value = await call<Status>("status"); if (alive) { setStatus(value); if (value.state === "running") timer = window.setTimeout(poll, 400); } } catch (cause) { if (alive) setError(String(cause)); } };
    timer = window.setTimeout(poll, 200); return () => { alive = false; window.clearTimeout(timer); };
  }, [status.state, deploymentRunning]);
  const loadBackups = async () => {
    setPending(true);
    try { const response = await fetch(`${API_BASE}/api/json-embedding/backups?gamePath=${encodeURIComponent(game.path)}`); const values = await response.json(); if (!response.ok) throw new Error(values.error); setBackups(values); setBackupId(values.find((item: Backup) => item.state !== "rolledBack")?.id || ""); }
    catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  useEffect(() => { if (!deploymentRunning && (["idle", "backedUp", "applied", "rolledBack", "uninstalled", "cleaned"].includes(status.state) || status.action === "backup" && status.state !== "running" && status.state !== "error")) void loadBackups(); }, [status.state, status.action, game.path, deploymentRunning]);
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
  const confirmInstalledPatch = () => !(patch.installed || patch.legacy) || confirm(
    "当前游戏已有文本补丁。继续会按当前生成的译文更新补丁，请先关闭游戏。",
    {title:"已有文本补丁",okLabel:"继续更新",cancelLabel:"取消"});
  const hasTextScan = !!(scanPath || textInfo.sourcePath);
  const remoteMeasurement = useRef<string | undefined>(undefined);
  const backendMetricScope = (action: string) => game.path + ":backend:" + action;
  const activeBackendAction = pending ? pendingAction : status.action;
  const backendActionBusy = pending || status.state === "running";
  useEffect(() => {
    const action = activeBackendAction;
    const next = backendActionBusy && action && ["inspect","backup","rollback","runtime","uninstall-text","cleanup-text"].includes(action)
      ? action : undefined;
    const previous = remoteMeasurement.current;
    if (previous === next) return;
    if (previous) {
      const completed = status.action === previous && status.gamePath === game.path && status.state !== "stopped" && status.state !== "error";
      finishGameStep(backendMetricScope(previous),completed);
    }
    remoteMeasurement.current = next;
    if (next) beginGameStep(backendMetricScope(next),next);
  }, [game.path, activeBackendAction, backendActionBusy, status.action, status.gamePath, status.state]);
  useEffect(() => () => {
    if (remoteMeasurement.current) finishGameStep(backendMetricScope(remoteMeasurement.current));
    remoteMeasurement.current = undefined;
  }, [game.path]);

  const scanMeasuring = useRef(false);
  const scanning = (pending && pendingAction === "extract") || (status.action === "extract" && status.state === "running");
  useEffect(() => () => {
    if (!scanMeasuring.current) return;
    finishGameStep(deploymentMetricScope(game.path, "scan"));
    scanMeasuring.current = false;
  }, [game.path]);
  useEffect(() => {
    const scope = deploymentMetricScope(game.path, "scan");
    if (scanning && !scanMeasuring.current) {
      scanMeasuring.current = true;
      beginGameStep(scope, "scan");
    }
    if (!scanMeasuring.current) return;
    const currentScan = status.action === "extract" && status.gamePath === game.path;
    if (currentScan && (status.state === "running" || !scanning) && status.completed !== undefined && (status.total ?? 0) > 0)
      reportGameStepItems(scope, "scan", status.completed);
    if (!scanning) {
      finishGameStep(scope, currentScan && status.state === "exported");
      scanMeasuring.current = false;
    }
  }, [game.path, scanning, status.action, status.gamePath, status.state, status.completed, status.total]);
  const scanMeasurement = stepPerformance(deploymentMetricScope(game.path,"scan"),"scan");
  const scanElapsed = scanMeasurement.taskId ? scanMeasurement.elapsedMs / 1000 : null;
  useEffect(() => {
    if (textSource === "locres" && status.state === "error" && (status.action === "extract" || status.action === "inspect")
        && status.detail?.startsWith("未找到散装 .locres")) {
      setHasLooseLocres(false);
      setTextStep(1);
    }
  }, [textSource, status]);

  const recheckLooseLocres = async () => {
    setCheckingTextSource(true);
    try {
      const games = await call<EmbeddingGame[]>("detect", { path: game.path });
      const found = games.some(item => item.path === game.path && item.textSupported === true);
      setHasLooseLocres(found);
      if (!found) showAppNotice("仍未找到散装 .locres");
    } catch (cause) {
      showAppNotice(cause instanceof Error ? cause.message : String(cause), "error");
    } finally { setCheckingTextSource(false); }
  };
  const start = async (action: string,jsonPath=file,scopes=backupScopes) => {
    if (isBenchmarkRunning()) return;
    if (action === "extract" && (hasTextScan || imageWorkflow.exists)) {
      const priorResults = !canUseTextResources ? "图片筛选、识别及译图结果" : imageProject ? "文本译文、草稿、图片筛选、识别及译图结果" : "文本译文和草稿";
      if (!await confirm(`清除${priorResults}后重新扫描，处理配置保留。`, {title:"重新扫描资源",okLabel:"重新扫描",cancelLabel:"取消"})) return;
      if (canUseTextResources && !await textHandle.current?.prepare()) return;
      if (imageProject && !await imageHandle.current?.prepare()) return;
    }
    if (isBenchmarkRunning()) return;
    if (action === "extract" && !canUseTextResources && imageProject) {
      setPart("images"); setTextStep(2); setImageScanRequest(value=>value+1);
      return;
    }
    if (action === "runtime") {
      const currentFile = await textHandle.current?.prepare();
      if (!currentFile) return;
      jsonPath = currentFile;
    }
    if (isBenchmarkRunning()) return;
    touched.current = true; setPending(true); setPendingAction(action); setError("");
    if(action==="extract"&&imageProject){setImageScanRequest(value=>value+1);}
    try {
      const value=await call<Status>("start", { action, gamePath: game.path, jsonPath, backupId, fontPath, backupMode, backupScopes: scopes });
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
  const recordImageArtifact = (kind: "images" | "mosaic", ids: string[], applied = false, draft?: ImageArtifact) => {
    setArtifacts(previous => ({ ...previous, [kind]: ids.length ? { ...draft, ids, applied } : undefined }));
  };
  const requestBackendStop = () => call("stop", {}).catch(cause => appendLog(`中止请求失败：${String(cause)}`, "error"));
  const stopDeployment = () => {
    deploymentAbort.current?.abort();
    textHandle.current?.stop();
    imageHandle.current?.stop();
    if (textActionRunning.current) void requestBackendStop();
  };
  const runTextAction = async (action: "extract" | "inspect" | "embed" | "apply", signal: AbortSignal, jsonPath = "") => {
    signal.throwIfAborted();
    try {
      let value = await call<Status>("start", { action, gamePath: game.path, jsonPath, fontPath, backupMode, backupScopes });
      setStatus(value);
      textActionRunning.current = value.state === "running";
      if (signal.aborted && textActionRunning.current) await requestBackendStop();
      while (value.state === "running") {
        await deploymentPoll();
        value = await call<Status>("status");
        setStatus(value);
      }
      const expected = { extract: "exported", inspect: "ready", embed: "done", apply: "applied" }[action];
      if (value.state !== expected || value.blocked) {
        signal.throwIfAborted();
        throw new Error(value.blocked ? `译文检查未通过：异常 ${value.blocked} 处` : value.detail || "文本补丁操作未完成");
      }
      return value;
    } finally { textActionRunning.current = false; }
  };

  const runDeployment = async (mode: DeploymentRun["mode"], work: (step: DeploymentStep, signal: AbortSignal) => Promise<void>) => {
    if (isBenchmarkRunning() || deploymentAbort.current || busyRef.current) return;
    const controller = new AbortController();
    const signal = controller.signal;
    deploymentAbort.current = controller;
    touched.current = true;
    setError("");
    let phase: DeploymentPhase | undefined;
    const report = (state: DeploymentRun["state"], detail?: string) => {
      const run = { mode, phase, state, detail };
      setDeployment(run);
      if (mode === "automatic") localStorage.setItem(automaticKey, JSON.stringify(run));
    };
    const step: DeploymentStep = async (next, action) => {
      signal.throwIfAborted();
      phase = next;
      report("running");
      return action();
    };
    try {
      await work(step, signal);
      signal.throwIfAborted();
      report("done");
      if (mode === "automatic") appendLog("一键生成并应用完成", "success");
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      report(signal.aborted ? "stopped" : "error", signal.aborted ? undefined : detail);
      appendLog(signal.aborted ? "部署已中止，已完成产物保留" : detail, signal.aborted ? "warning" : "error");
      if (mode === "automatic" && followAutomatic.current) { setPart("text"); setTextStep(3); }
    } finally {
      deploymentAbort.current = null;
      void loadPatch();
    }
  };

  const generateText = async (step: DeploymentStep, signal: AbortSignal) => {
    const translated = await step("inspect", async () => {
      const path = await textHandle.current?.prepare();
      if (!path) throw new Error("译文未能保存");
      const inspected = await runTextAction("inspect", signal, path);
      if (!inspected.matched) throw new Error("没有可写回的译文或对话修正");
      return path;
    });
    await step("generateText", async () => {
      const { patchPath } = await measureDeploymentStage(game.path, "generate", () => runTextAction("embed", signal, translated));
      if (!patchPath) throw new Error("生成完成后没有返回补丁目录");
      setArtifacts(previous => ({ ...previous, text: { path: patchPath, applied: false } }));
    });
    return translated;
  };
  const applyText = async (signal: AbortSignal, translated: string) => {
    await measureDeploymentStage(game.path, "apply", () => runTextAction("apply", signal, translated));
    setArtifacts(previous => previous.text ? { ...previous, text: { ...previous.text, applied: true } } : previous);
  };
  const applyImageArtifacts = async (kind: "images" | "mosaic", ids: string[], draft?: ImageArtifact) => {
    if (kind === "images") {
      if (!await imageHandle.current?.apply(ids)) throw new Error("译图应用未完成");
    } else {
      if (!mosaicHandle.current) throw new Error("去码工程尚未加载");
      const handle = mosaicHandle.current;
      await measureDeploymentStage(game.path, "applyMosaic", () => handle.apply(ids, false, draft?.patchId), files => files);
    }
    recordImageArtifact(kind, ids, true, draft);
  };
  const prepareMosaic = async (signal: AbortSignal, ids?: string[]) => {
    if (!mosaicHandle.current) throw new Error("去码工程尚未加载");
    const handle = mosaicHandle.current;
    const prepared = await measureDeploymentStage(game.path, "generateMosaic", () => handle.prepare(signal, ids), result => result.ids.length);
    const artifact = { ...prepared, applied: false };
    recordImageArtifact("mosaic", artifact.ids, false, artifact);
    return artifact;
  };

  const runAutomatic = async () => {
    if (hasMosaicDrafts(game.path)) { showAppNotice("请先点击右上角保存去码修改"); return; }
    if (isBenchmarkRunning() || deploymentAbort.current || busy || validation.issues.length || !await confirmInstalledPatch()) return;
    if (canUseTextResources && !await textHandle.current?.leave()) return;
    if (imageProject && !plan.disabled.includes("image") && !await imageHandle.current?.prepare()) return;
    followAutomatic.current = true;
    await runDeployment("automatic", async (step, signal) => {
      appendLog("开始一键生成并应用");
      if (canUseTextResources && !plan.disabled.includes("scan") && (!latestWorkflow.current.text.sourcePath || latestWorkflow.current.text.loadResult?.path !== scanPath)) {
        if (followAutomatic.current) { setPart("text"); setTextStep(1); }
        await step("scan", async () => {
          const { exportPath } = await runTextAction("extract", signal);
          if (!exportPath) throw new Error("扫描完成后没有生成文本文件");
          setScanPath(exportPath);
          while (latestWorkflow.current.text.loadResult?.path !== exportPath) {
            signal.throwIfAborted();
            await deploymentPoll();
          }
          const loaded = latestWorkflow.current.text;
          if (loaded.loadResult?.error) throw new Error(loaded.loadResult.error);
          if (!loaded.sourcePath) throw new Error("扫描后的文本工程为空");
        });
      }
      let imageIds: string[] = [];
      let mosaicDraft: ImageArtifact | undefined;
      let mosaicIds: string[] = [];
      for (const phase of deploymentSequence(plan)) {
        signal.throwIfAborted();
        if (phase === "text" && !workflowRef.current.textSkipped) {
          if (followAutomatic.current) { setPart("text"); setTextStep(2); }
          if (!await step("translate", () => textHandle.current!.automatic(signal)))
            throw new Error("文本翻译未完成，请检查失败条目");
        } else if (phase === "image" && !workflowRef.current.imagesSkipped) {
          if (followAutomatic.current) { setPart("images"); setTextStep(2); }
          if (!await step("translateImages", () => imageHandle.current!.automatic(signal)))
            throw new Error("图片翻译未完成，请检查失败图片");
          imageIds = imageHandle.current!.outputIds();
          if (!imageExport) recordImageArtifact("images", imageIds);
        } else if (phase === "mosaic") {
          await step("generateMosaic", async () => {
            if (!imageHandle.current) throw new Error("图片工程尚未加载");
            if (!await imageHandle.current.ensureIndex(signal)) return;
            await deploymentPoll();
            signal.throwIfAborted();
            if (!mosaicHandle.current) throw new Error("去码工程尚未加载");
            mosaicIds = await mosaicHandle.current.automatic(signal);
            if (mosaicIds.length && !imageExport) mosaicDraft = await prepareMosaic(signal, mosaicIds);
          });
        } else if (phase === "apply") {
          if (followAutomatic.current) { setPart("text"); setTextStep(3); }
          const text = latestWorkflow.current.text;
          const translated = canUseTextResources && !plan.disabled.includes("text") && (text.changed > 0 || text.positionRepairs) ? await generateText(step, signal) : "";
          if (translated) await step("applyText", () => applyText(signal, translated));
          if (imageExport) {
            const selected = new Set([...imageIds, ...mosaicIds]);
            if (selected.size) await step("applyImagePackage", async () => {
              const translations = new Set(imageIds);
              const candidates = (imageHandle.current?.exportCandidates() ?? []).filter(row => selected.has(row.imageId))
                .map(row => translations.has(row.imageId) ? { ...row, renderedHash: row.renderedHash ?? "" } : { ...row, renderedHash: undefined });
              if (candidates.length !== selected.size) throw new Error("部分图片不支持成品包导出，请检查游戏图片来源。");
              if (await exportPackage.deploy(candidates, mosaicIds, signal))
                appendLog("图片已通过成品包应用，收据已保存", "success");
            });
          } else {
            if (imageIds.length) await step("applyImages", () => applyImageArtifacts("images", imageIds));
            const mosaic = mosaicDraft;
            if (mosaic) await step("applyMosaic", () => applyImageArtifacts("mosaic", mosaic.ids, mosaic));
          }
          signal.throwIfAborted();
          if (launchAfterApply) await launchGame();
        }
      }
    });
  };
  useEffect(() => () => {
    deploymentAbort.current?.abort();
    textHandle.current?.stop();
    imageHandle.current?.stop();
  }, []);
  const pickFont = async () => {try{const selected=await open({multiple:false,filters:[{name:"字体",extensions:["ttf","otf"]}]});if(typeof selected==="string")setFontPath(selected);}catch(cause){setError(String(cause));}};


  useEffect(() => {
    if (status.gamePath !== game.path) return;
    if (status.exportPath) setScanPath(status.exportPath);
    if (status.action === "extract" && status.state === "exported") setArtifacts({});
    else if (!deploymentAbort.current && status.patchPath &&
        (status.action === "embed" && status.state === "done" || status.action === "apply" && status.state === "applied")) {
      const path = status.patchPath;
      setArtifacts(previous => ({ ...previous, text: { path, applied: status.state === "applied" } }));
    } else if (status.state === "uninstalled" || status.state === "cleaned") {
      setArtifacts(previous => ({ ...previous, text: undefined }));
    } else if (status.state === "rolledBack") setArtifacts({});
  }, [game.path, status.gamePath, status.action, status.state, status.patchPath, status.exportPath]);
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
  const canGenerate=canUseTextResources&&gamePatchCanGenerate(textInfo,imageWorkflow,imageProject,workflow);
  const generateTextPatch = () => void runDeployment("manual", async (step, signal) => {
    setFile(await generateText(step, signal));
  });
  const generateImages = () => void runDeployment("manual", (step, signal) => step("generateImages", async () => {
    const ids = await measureDeploymentStage(game.path, "generateImages", async () => await imageHandle.current?.generate(signal) || []);
    if (!ids.length) throw new Error("没有可用于部署的译图");
    if (!imageExport) recordImageArtifact("images", ids);
  }));
  const generateMosaic = () => {
    if (hasMosaicDrafts(game.path)) { showAppNotice("请先点击右上角保存去码修改"); return; }
    if (imageExport || !mosaicHandle.current?.selectedIds().length) { selectWorkflow("2.3"); return; }
    void runDeployment("manual", async (step, signal) => { await step("generateMosaic", () => prepareMosaic(signal)); });
  };
  const applyTextPatch = async () => {
    if (!await confirmInstalledPatch()) return;
    await runDeployment("manual", async (step, signal) => {
      await step("applyText", () => applyText(signal, file));
      if (launchAfterApply && !signal.aborted) await launchGame();
    });
  };
  const applyImages = () => void runDeployment("manual", async (step, signal) => {
    await step("applyImages", async () => {
      const ids = artifacts.images?.ids ?? imageHandle.current?.outputIds() ?? [];
      if (!ids.length) throw new Error("没有可应用的译图");
      await applyImageArtifacts("images", ids);
    });
    if (launchAfterApply && !signal.aborted) await launchGame();
  });
  const applyMosaic = async (undo = false) => {
    if (hasMosaicDrafts(game.path)) { showAppNotice("请先点击右上角保存去码修改"); return; }
    const ids = artifacts.mosaic?.ids ?? (undo ? mosaicHandle.current?.selectedIds() : undefined);
    if (!ids?.length || !await confirm(`请关闭游戏后继续。将处理 ${ids.length} 张去码图。`, {
      title: undo ? "卸载去码图" : "应用去码图",
      okLabel: undo ? "卸载去码图" : "应用去码图",
    })) return;
    await runDeployment("manual", async (step, signal) => {
      if (undo) {
        await step("uninstallMosaic", async () => {
          if (!mosaicHandle.current) throw new Error("去码工程尚未加载");
          await mosaicHandle.current.apply(ids, true);
          recordImageArtifact("mosaic", ids, false, artifacts.mosaic);
        });
      } else {
        await step("applyMosaic", () => applyImageArtifacts("mosaic", ids, artifacts.mosaic));
        if (launchAfterApply && !signal.aborted) await launchGame();
      }
    });
  };

  const readProgress = (actions: string[], idle?: { step: string; title: string; done: boolean }) => {
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
    const metricStage = step === "1" ? "scan" : action === "embed" ? "generate" : action === "apply" ? "apply" : undefined;
    const measurement = metricStage ? stepPerformance(deploymentMetricScope(game.path,metricStage),metricStage)
      : matches && action ? stepPerformance(backendMetricScope(action),action) : undefined;
    const scanThroughput = step === "1" && (running || done) ? formatFlowThroughput(measurement, "个") ??
      formatFlowThroughput(imageWorkflow.loaded ? stepPerformance(deploymentMetricScope(game.path, "scanImages"), "scanImages") : undefined, "张")
      : undefined;
    const detail = running ? pending ? "正在准备…" : status.detail : undefined;
    const details = <>{scanThroughput && <p className="game-flow-stage-throughput">扫描吞吐 <b>{scanThroughput}</b></p>}</>;
    return { title, step, running, stopped, state: running ? "running" as const : failed ? "error" as const
      : stopped ? "stopped" as const : done ? "done" as const : "pending" as const,
      measurement, elapsed: measurement?.taskId ? gameDuration(measurement.elapsedMs) : undefined,
      detail, details, completed, total, percent: total ? Math.floor(completed / total * 100) : undefined };
  };
  const progress = (actions: string[]) => {
    const task = readProgress(actions);
    if (!task) return null;
    return <GameStepProgress title={"步骤 " + task.step + " · " + task.title} state={task.state}
      elapsed={task.elapsed} percent={task.percent} count={task.total ? task.completed + " / " + task.total : undefined}
      actions={task.running && !deploymentRunning && <button className="unity-btn" onClick={() => void requestBackendStop()}>中止</button>}>
      {task.details}
      {task.detail && <p className="unity-task-detail">{task.detail}</p>}
      {(task.running || task.stopped && task.measurement?.taskId) && <StepRunningMetrics measured={task.measurement} stopped={task.stopped}
        parameters={[{ scope: "task", label: "操作", value: task.title }, { scope: "task", label: "引擎", value: game.engine }, { scope: "task", label: "项目", value: game.path }]} />}
    </GameStepProgress>;
  };
  const output = (label:string,path?:string) => path&&<div className="json-embedding-output"><button type="button" className="embed-path-link" data-tooltip={path} aria-label={`打开${label}`} onClick={()=>void api.revealPath(path).catch(e=>setError(String(e)))}><span>{label}</span><code>{path}</code></button></div>;

  const wolfBackup = game.engine === "WOLF RPG";
  const wolfAvailability = patch.wolfBackupAvailability;
  const snapshotOptions = wolfBackup ? [
    ...(wolfAvailability?.looseText || wolfAvailability?.textArchives ? [["text",
      (wolfAvailability.looseText && wolfAvailability.textArchives ? "散装文本和文本分包" : wolfAvailability.looseText ? "散装文本" : "文本分包")
        + (wolfAvailability.textIncludesImages ? "（含文本目录内图片）" : ""),
    ]] : []),
    ...(wolfAvailability?.looseImages ? [["images", "散装图片"]] : []),
  ] : availableBackupScopes;
  const snapshotScopes = backupScopes.filter(scope => snapshotOptions.some(([id]) => id === scope));
  const backedUpWolf = wolfBackup && status.action === "backup" && status.backupPath && status.backupCoverage;
  const backedUpCategories = backedUpWolf ? ([
    ["looseText", "散装文本"], ["textArchives", "文本分包"], ["looseImages", "散装图片"],
  ] as const).filter(([id]) => backedUpWolf[id].included)
    .map(([id, label]) => `${label} ${backedUpWolf[id].count} 个`).join("、") : "";
  const backupPanel=<section className="embed-section game-backup-settings" data-section="backup">
    <div className="game-maintenance-row"><h3>备份</h3><IconAction name="help" label="自动：应用前按所选范围创建备份。手动：点击立即备份时按所选范围创建备份。补丁卸载所需安装原件另行保留。"/>
      <label>方式<select aria-label="备份方式" value={backupMode} disabled={busy} onChange={e=>{const mode=e.target.value as "auto"|"manual";setBackupMode(mode);localStorage.setItem(`llmchat-game-backup:${game.path}`,mode);}}><option value="auto">自动备份</option><option value="manual">手动备份</option></select></label>
      <button type="button" className="unity-btn" disabled={testing||busy||!game.supported||!snapshotScopes.length} title={testTitle} onClick={()=>void start("backup", file, snapshotScopes)}>立即备份</button>
    </div>
    <div className="game-backup-scopes" role="group" aria-label="备份范围"><span>范围</span>{snapshotOptions.map(([scope,label])=><label key={scope}><input type="checkbox" aria-label={label} disabled={busy} checked={backupScopes.includes(scope)} onChange={e=>setBackupScopes(current=>e.target.checked?[...current,scope]:current.filter(item=>item!==scope))}/>{label}</label>)}</div>
    {wolfBackup && <>
      {!detecting && !snapshotOptions.length && <p className="hint">{wolfAvailability ? "当前没有可备份的散装资源或文本分包。" : "未读取到当前备份范围，请重新检测补丁。"}</p>}
      {wolfAvailability?.dataWolfPresent && !(backedUpWolf && backedUpWolf.dataWolf.included) && <p className="hint">检测到 Data.wolf。封包内的文本和图片当前不在备份范围。</p>}
      <p className="hint">补丁安装原件用于卸载，单独保留。</p>
      {backedUpCategories && <p className="hint">本次快照包含：{backedUpCategories}</p>}
    </>}
    {progress(["backup"])}{output("备份",status.backupPath)}
  </section>;
  const restorePanel=<section className="embed-section game-restore-settings" data-section="restore"><div className="game-maintenance-row"><h3>恢复</h3>
    <select aria-label="选择回滚备份" disabled={busy||!backups.length} value={backupId} onChange={e=>setBackupId(e.target.value)}><option value="">选择备份</option>{backups.map((item,index)=><option key={item.id} value={item.id} disabled={item.state==="rolledBack"}>{index+1} · {item.resources} 组资源 · {item.state==="snapshot"?"独立备份":item.state==="rolledBack"?"已回滚":item.state==="applied"?"已应用":"待恢复"}</option>)}</select>
    <IconAction name="refresh" label="刷新备份列表" disabled={busy} onClick={()=>void loadBackups()}/><button type="button" className="unity-btn unity-btn-warning unity-important-action" disabled={testing||busy||!backupId} title={testTitle} onClick={()=>void start("rollback")}>恢复</button>
  </div>{progress(["rollback"])}</section>;

  const canWritePatch = !testing && !busy && !patch.conflicts.length && !(backupMode === "auto" && !backupScopes.length);
  const patchStatus = detecting ? "正在检测补丁…" : patch.conflicts.length ? "游戏资源已改变" :
    patch.installed ? "文本补丁已安装" : patch.legacy ? "发现旧版文本补丁" : patch.managed ? "文本补丁已卸载" : "未安装文本补丁";
  const products = [
    artifacts.text && { name: "文本补丁", applied: artifacts.text.applied },
    !imageExport && artifacts.images ? { name: `${artifacts.images.ids.length} 张译图`, applied: artifacts.images.applied } : undefined,
    !imageExport && artifacts.mosaic ? { name: `${artifacts.mosaic.ids.length} 张去码图`, applied: artifacts.mosaic.applied } : undefined,
  ].filter(product => product !== undefined);
  const stagedProducts = products.filter(product => !product.applied).map(product => product.name).join("、");
  const phaseLabel = deployment?.phase === "translate" && !imageProject ? "文本翻译"
    : deployment?.phase ? deploymentLabels[deployment.phase] : "一键流程";
  const phaseStatus = deployment?.state === "running" ? `正在${phaseLabel}`
    : deployment?.state === "stopped" ? `已中止 · ${phaseLabel} · 已完成产物保留`
      : deployment?.state === "error" ? `失败 · ${phaseLabel} · ${deployment.detail}` : "";
  const canApplyText = !!artifacts.text?.path && !artifacts.text.applied;
  const exportLocked = otherWorkflowBusy || mosaicBusy || testing;
  const exportPackage = useGameImageExportPackage({
    gamePath: game.path, active: active && imageExport && part === "text" && textStep === 3,
    scanLegacyOnEntry: active && imageExport,
    locked: exportLocked, candidates: imageWorkflow.exportCandidates ?? [], mosaicIds: packageMosaicIds,
    onBusyChange: setExportBusy, confirm, legacyRevision: status.state,
  });
  const exportState = exportPackage.model;
  const imagePackageApplied = exportState.applied && !exportState.partiallyRestored && !exportState.needsRecovery;
  const pendingImagePackage = exportState.needsRecovery || exportState.partiallyRestored ||
    !imagePackageApplied && !!(exportState.path || exportState.confirmed || exportState.needsConfirmation || exportState.legacyInstalled);
  const readyToLaunch = !imageExport || !canApplyText && !pendingImagePackage;
  const installState = exportState.needsRecovery ? "需恢复" : exportState.partiallyRestored || exportState.used && !exportState.applied && patch.installed ? "部分恢复"
    : patch.installed || exportState.applied || !imageExport && (artifacts.images?.applied || artifacts.mosaic?.applied) ? "已应用" : "未安装";
  const deploymentProgress = readProgress(["inspect", "embed", "apply", "uninstall-text", "cleanup-text"]);
  const productRunning = deploymentRunning || deploymentProgress?.running || imageBusy && imageWorkflow.stage === "restore";
  const productState = productRunning ? "running" : deployment?.state === "error" ? "error"
    : deployment?.state === "stopped" ? "stopped" : deploymentProgress?.state === "error" || deploymentProgress?.state === "stopped"
      ? deploymentProgress.state : installState === "已应用" ? "done" : "pending";
  const packageProgress = deploymentProgress?.running ? deploymentProgress : undefined;
  const deploymentPanel = <div className="embed-deployment">
    <div><StandaloneGameFlowCard stepId="apply" title="生成与应用" state={productState}
      label={productState === "pending" || productState === "done" ? installState : gameProgressLabels[productState]}
      elapsed={deploymentProgress?.elapsed} progress={{
        current: packageProgress?.completed, total: packageProgress?.total,
        percent: packageProgress?.percent, sample: packageProgress?.detail ?? phaseStatus,
      }} actions={packageProgress && !deploymentRunning && <button className="unity-btn" onClick={() => void requestBackendStop()}>中止</button>}
      performance={<GameFlowPerformance measured={imageBusy && imageWorkflow.stage === "restore"
        ? stepPerformance(deploymentMetricScope(game.path, "applyImages"), "applyImages") : deploymentProgress?.measurement} />}
      body={<div className="dpl dpl-grid embed-product-grid">
        {canUseTextResources && <section className="dpl-panel">
          <div className="dpl-panel-head"><h3>文本补丁</h3><span>{textInfo.changed}</span></div>
          <dl className="dpl-stats dpl-stats-stack">
            <div><dt>已改条目</dt><dd>{textInfo.sourcePath ? textInfo.changed : "—"}</dd></div>
            <div><dt>字符集 / 缺字</dt><dd>—</dd></div>
            <div><dt>替换字体</dt><dd>{runtimeDictionary && fontPath.trim() ? <span className="dpl-hint" title={fontPath}>已选择</span> : "—"}</dd></div>
          </dl>
          <p className="dpl-hint">{canApplyText ? "文本补丁已生成，尚未应用。"
            : patch.installed ? "文本补丁已安装。" : patch.legacy ? "发现旧版文本补丁。" : "尚未生成文本补丁。"}</p>
          <div className="dpl-panel-foot"><button type="button" className="unity-btn unity-btn-primary" data-tooltip="保存当前编辑并检查译文后生成补丁" disabled={testing || busy || !canGenerate} title={testTitle} onClick={generateTextPatch}>生成补丁</button></div>
        </section>}
        {imageProject && <section className="dpl-panel">
          <div className="dpl-panel-head"><h3>图片补丁</h3><span>{imageWorkflow.valid}</span></div>
          <dl className="dpl-stats dpl-stats-stack">
            <div><dt>可用译图</dt><dd>{imageWorkflow.loaded ? imageWorkflow.valid : "—"}</dd></div>
            <div><dt>图片总数</dt><dd>{imageWorkflow.count ?? "—"}</dd></div>
            <div><dt>已译比例</dt><dd>{imageWorkflow.loaded && imageWorkflow.count ? (imageWorkflow.valid / imageWorkflow.count * 100).toFixed(1) + "%" : "—"}</dd></div>
          </dl>
          <p className="dpl-hint">{imageWorkflow.valid
            ? imageExport ? `确认后将通过成品包写入 ${imageWorkflow.valid} 张译图。` : `应用时将写入 ${imageWorkflow.valid} 张译图。`
            : "译图尚未生成，可在「图片翻译」中处理。"}</p>
          <div className="dpl-panel-foot"><button type="button" className="unity-btn" disabled={testing || busy || !imageWorkflow.loaded} title={testTitle} onClick={generateImages}>生成译图</button></div>
        </section>}
        {selfMosaic && <section className="dpl-panel">
          <div className="dpl-panel-head"><h3>去码补丁</h3><span>{mosaicHandle.current?.selectedIds().length ?? 0}</span></div>
          <dl className="dpl-stats dpl-stats-stack">
            <div><dt>已选去码图</dt><dd>{mosaicHandle.current ? imageExport ? packageMosaicIds.length : mosaicHandle.current.selectedIds().length : "—"}</dd></div>
            <div><dt>覆盖区域</dt><dd>—</dd></div>
          </dl>
          <p className="dpl-hint">{imageExport ? "已确认的去码图随成品包一起应用。" : "纳入的去码图随补丁一起应用。"}</p>
          <div className="dpl-panel-foot"><button type="button" className="unity-btn" data-tooltip={!imageExport && mosaicComplete ? "准备已确认的去码图" : "打开图片去码以重绘并确认候选"} disabled={testing || busy || !imageWorkflow.loaded} title={testTitle} onClick={generateMosaic}>{imageExport ? "查看去码图" : "生成去码图"}</button></div>
        </section>}
        <section className="dpl-panel dpl-panel-apply" aria-label="应用到游戏">
          <div className="dpl-panel-head">
            <h4>应用到游戏</h4>
            <span className={`dpl-tag${installState === "已应用" ? " is-ok" : ""}`}>{installState}</span>
          </div>
          <div className="dpl-path" title={game.path}>{game.path || "尚未选择游戏目录"}</div>
          {imageExport && <>
            <LegacyImagePatchSection legacy={exportPackage.legacy} state={exportState} actions={exportPackage.actions} locked={exportLocked || exportBusy} />
            <ImageExportPackageSection state={exportState} actions={exportPackage.actions} locked={exportLocked || exportBusy} />
          </>}
          {canUseTextResources && <div className="dpl-plan">
            <p>文本与字体</p>
            <div className="dpl-actions">
              <button type="button" className="dpl-btn" data-tooltip="写入文本补丁前请先关闭游戏" disabled={!canWritePatch || !canApplyText} title={testTitle} onClick={() => void applyTextPatch()}>{patch.installed ? "更新文本补丁" : "应用文本补丁"}</button>
              <IconAction name="refresh" caption="检测补丁" label="检测已安装补丁及文件改动" disabled={busy} onClick={() => {
                if (imageExport) exportPackage.actions.scanLegacy();
                void loadPatch(true);
              }} />
              <IconAction name="rollback" caption="卸载文本" label="卸载文本补丁并恢复安装前资源" hint={testTitle} disabled={testing || busy || !patch.installed || !!patch.conflicts.length} onClick={() => void start("uninstall-text")} />
              <IconAction name="stop" caption="清理" label="清理已卸载文本补丁的安装原件和关联工作目录，保留用户备份" hint={testTitle} disabled={testing || busy || patch.installed || !patch.managed} onClick={() => void start("cleanup-text")} />
            </div>
            <p className="dpl-hint">{patchStatus}{patch.conflicts.length ? "，请先处理文件冲突。" : ""}</p>
          </div>}
          {!imageExport && imageProject && <div className="dpl-plan">
            <p>图片补丁</p>
            <div className="dpl-actions">
              <button type="button" className="dpl-btn" data-tooltip="写入译图前请先关闭游戏" disabled={!canWritePatch || !imageWorkflow.valid} title={testTitle} onClick={applyImages}>应用译图</button>
              {selfMosaic && <button type="button" className="dpl-btn" disabled={!canWritePatch || !artifacts.mosaic?.ids.length} title={testTitle} onClick={() => void applyMosaic()}>应用去码图</button>}
              <IconAction name="rollback" caption="卸载译图" label="卸载译图并保留已应用的去码图" hint={testTitle} disabled={testing || busy || !imageWorkflow.loaded} onClick={() => void runDeployment("manual", step => step("uninstallImages", async () => {
                if (!await imageHandle.current?.uninstall()) throw new Error("译图卸载未完成");
                setArtifacts(previous => previous.images ? { ...previous, images: { ...previous.images, applied: false } } : previous);
              }))} />
              {selfMosaic && <IconAction name="rollback" caption="卸载去码图" label="卸载去码图并保留已应用的译图" hint={testTitle} disabled={testing || busy || !artifacts.mosaic?.applied && !mosaicComplete} onClick={() => void applyMosaic(true)} />}
            </div>
            {artifacts.mosaic?.path && <button type="button" className="dpl-btn" onClick={() => void api.revealPath(artifacts.mosaic!.path!)}>去码补丁目录</button>}
          </div>}
          {thirdPartyMosaic && <div className="dpl-mosaic"><span>第三方去码补丁</span><GameMosaicPatchButton gamePath={game.path} disabled={busy} /></div>}
          {phaseStatus && <p className={deployment?.state === "error" ? "dpl-hint is-warning" : "dpl-hint"} role="status">{phaseStatus}</p>}
          {deploymentRunning && automatic !== "running" && <button className="dpl-btn" type="button" onClick={stopDeployment}>中止</button>}
          <div className="embed-deploy-launch">
            <button type="button" className="dpl-btn dpl-btn-primary" disabled={busy || !game.supported || !readyToLaunch} onClick={() => void launchGame()}>{launching ? "正在启动…" : "启动游戏"}</button>
            {canUseTextResources && <label><input type="checkbox" checked={launchAfterApply} disabled={busy} onChange={event => {
              const value = event.target.checked;
              setLaunchAfterApply(value);
              localStorage.setItem(launchPreference, String(value));
            }} />应用后启动</label>}
          </div>
        </section></div>} /></div>
    <div className="embed-deploy-maintenance">{(canUseTextResources || imageProject) && backupPanel}{restorePanel}</div>
    {runtimeDictionary && <details className="embed-runtime-options" data-section="runtime" open={status.action === "runtime" ? true : undefined}>
      <summary>运行时加载译文</summary>
      <div className="embed-form-row">
        <label className="embed-field embed-inline-field"><span>中文字体</span><div className="json-embedding-path">
          <input aria-label="中文字体" value={fontPath} placeholder="可选 TTF / OTF" disabled={busy} onChange={event => setFontPath(event.target.value)} />
          <IconAction name="json" label="选择中文字体，随本地翻译插件加载" disabled={busy} onClick={() => void pickFont()} />
        </div></label>
        <IconAction name="apply" caption="安装插件" label="安装或更新本地 JSON 翻译插件" hint={testTitle} disabled={!canWritePatch || !file} onClick={() => void start("runtime")} />
      </div>
      {progress(["runtime"])}
    </details>}
  </div>;

  const scanProgress = readProgress(["extract"], { step: "1", title: "扫描资源",
    done: hasTextScan || !canUseTextResources && imageWorkflow.loaded });
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
    onRetry={textFailures.length && !testing && !busy && textHandle.current?.canRetryFailures ? () => textHandle.current?.retryFailures?.() : undefined} />;
  const scanResources = <section className="unity-scan-resources" aria-label="资源信息"><h3>资源信息</h3>
    {workDirectory}
    <p>已扫描文本：{textInfo.count} 条</p>{textInfo.messageCore && <p>已启用 YEP Message Core。可在译文末尾用 <code>{"\\nc<人物名>"}</code> 补充居中姓名。</p>}{imageProject && <p>图片资源：{imageWorkflow.count===null?"未读取":`${imageWorkflow.count} 张`}</p>}
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
  const deploymentStep = deployment?.phase === "scan" ? "1" : deployment?.phase === "translate" ? "2.1" : deployment?.phase === "translateImages" ? "2.2"
    : deployment?.phase === "generateMosaic" ? "2.3" : deployment?.phase ? "3" : undefined;
  const stageIds: Record<CanvasStep, string> = { scan: "1", text: "2.1", image: "2.2", mosaic: "2.3", apply: "3" };
  const deploymentPage = part === "text" && textStep === 3;
  const completed: CanvasStep[] = [];
  if (hasTextScan || (!canUseTextResources && imageWorkflow.loaded)) completed.push("scan");
  if (!textBusy && textInfo.sourcePath && !textInfo.loadResult?.error &&
      (workflow.textSkipped || textInfo.selected === textInfo.done)) completed.push("text");
  if (!imageBusy && (imageWorkflow.complete || workflow.imagesSkipped)) completed.push("image");
  if (!mosaicBusy && (mosaicComplete || imageWorkflow.loaded && imageWorkflow.count === 0)) completed.push("mosaic");
  const appliedIds = (artifact: ImageArtifact | undefined, ids: string[]) => {
    if (!artifact) return !ids.length;
    if (!artifact.applied || artifact.ids.length !== ids.length) return false;
    const applied = new Set(artifact.ids);
    return ids.every(id => applied.has(id));
  };
  const { enabledSteps } = validation;
  const enabledArtifacts = [
    enabledSteps.includes("text") ? artifacts.text : undefined,
    !imageExport && enabledSteps.includes("image") && !workflow.imagesSkipped ? artifacts.images : undefined,
    !imageExport && enabledSteps.includes("mosaic") ? artifacts.mosaic : undefined,
  ];
  const enabledImageIds = enabledSteps.includes("image") && !workflow.imagesSkipped ? imageHandle.current?.outputIds() ?? [] : [];
  const enabledMosaicIds = enabledSteps.includes("mosaic") ? mosaicHandle.current?.selectedIds() ?? [] : [];
  const outputsApplied = (!enabledSteps.includes("text") || !(textInfo.changed || textInfo.positionRepairs) || !!artifacts.text?.applied) &&
    (imageExport ? !(enabledImageIds.length || enabledMosaicIds.length) || imagePackageApplied
      : (!enabledSteps.includes("image") || workflow.imagesSkipped || appliedIds(artifacts.images, enabledImageIds)) &&
        (!enabledSteps.includes("mosaic") || appliedIds(artifacts.mosaic, enabledMosaicIds)));
  const applied = isGameDeploymentComplete(enabledSteps, completed, {
    applied: outputsApplied && !pendingImagePackage && (imagePackageApplied || enabledArtifacts.some(artifact => artifact?.applied) || automatic === "done"),
    blocked: enabledArtifacts.some(artifact => artifact && !artifact.applied) || !!patch.conflicts.length || !!validation.issues.length || textInfo.dirty ||
      textUnfinished || imageUnfinished || mosaicBusy || imageBusy || textBusy || pending || status.state === "running" ||
      deploymentRunning || deployment?.state === "stopped" || deployment?.state === "error",
  });
  if (applied) completed.push("apply");
  const activeCanvasStep = (Object.keys(stageIds) as CanvasStep[]).find(id => stageIds[id] === deploymentStep);
  const run = deploymentRunning && deployment?.mode === "automatic" ? {
    mode: "automatic" as const, steps: activeCanvasStep ? [activeCanvasStep] : [],
    completed: completed.filter(id => validation.enabledSteps.includes(id)).length,
    total: validation.enabledSteps.length, stopping: !!deploymentAbort.current?.signal.aborted,
  } : null;
  const canvas: DeploymentModel = {
    root: game.path, supportedPhases, plan, run, metrics: deploymentMetrics(game.path), stoppedStep: deployment?.state === "stopped" ? activeCanvasStep ?? null : null,
    completed, canStop: deploymentRunning, textCount: textInfo.changed, busyLabel: deploymentRunning ? phaseLabel : null,
    locked: busy || !(canUseTextResources || imageProject), patchReady: canGenerate, patch: null, staged: !!stagedProducts || !!exportState.path && !exportState.used, applied,
    installed: patch.installed, fontPath, fontName: "", extraCharacters: "", fontPlan: null, entries: [],
    images: { total: imageWorkflow.count ?? 0, ready: imageWorkflow.valid },
    mosaic: { enabled: selfMosaic, count: mosaicHandle.current?.selectedIds().length ?? 0 },
    progress: deploymentRunning ? { state: "active", percent: null, detail: phaseStatus, label: phaseLabel } : null,
  };
  const workflowSteps=<GameWorkflowSteps idPrefix="embed-step" panelId="embed-step-panel"
    edges={deploymentPage ? validation.effectiveEdges.map(({ from, to }) => ({ from: stageIds[from], to: stageIds[to] })) : undefined}
    skipped={deploymentPage ? plan.disabled.map(id => stageIds[id]) : undefined}
    enabled={deploymentPage ? validation.enabledSteps.map(id => stageIds[id]) : undefined}
    disconnected={deploymentPage ? validation.disconnected.map(id => stageIds[id]) : undefined} steps={[{id:"1",label:"扫描资源"},{id:"2.1",label:"文本翻译"},...(imageProject?[{id:"2.2",label:"图片翻译"}]:[]),...(selfMosaic?[{id:"2.3",label:"图片去码"}]:[]),{id:"3",label:"生成与应用"}].map(item=>{
    const selected=item.id===activeWorkflowId;
    const operationStep=(pending ? pendingAction : status.action)==="extract"?"1":"3";
    const imageStep=imageWorkflow.stage==="restore"?"3":"2.2";
    const running=deploymentRunning&&deploymentStep===item.id||mosaicBusy&&item.id==="2.3"||textBusy&&item.id==="2.1"||imageBusy&&item.id===imageStep||(pending||status.state==="running")&&operationStep===item.id;
    const scanned=!!scanPath||textInfo.count>0||(!canUseTextResources&&imageWorkflow.loaded);
    const finished = completed.some(step => stageIds[step] === item.id);
    const ready=item.id==="1"||item.id==="2.3"&&imageWorkflow.loaded||(item.id==="2.1"&&canUseTextResources||item.id==="2.2")&&scanned||item.id==="3"&&(canGenerate||canApplyText||imageProject&&imageWorkflow.valid>0||mosaicComplete);
    const failed=deployment?.state==="error"&&deploymentStep===item.id||!!scanLoadError&&item.id==="1"&&!running||!scanLoadError&&textInfo.state==="error"&&item.id==="2.1"||imageWorkflow.state==="error"&&item.id===imageStep||status.state==="error"&&operationStep===item.id;
    const state=running?"current":failed?"error":finished?"complete":ready?"current":"pending";
    return {...item,state,selected,paused:deployment?.state==="stopped"&&deploymentStep===item.id||!finished&&(textInfo.state==="stopped"&&item.id==="2.1"||imageWorkflow.state==="stopped"&&item.id===imageStep||status.state==="stopped"&&operationStep===item.id),running,onSelect:()=>selectWorkflow(item.id)};
  })}/>;
  useProjectBenchmarkLauncher(active, () => {
    const input = textHandle.current?.benchmark?.();
    if (!input) return false;
    openGameTextBenchmark({ ...input, images: imageHandle.current?.benchmark(), mosaicRoot: selfMosaic ? game.path : undefined,
      initialPart: part === "mosaic" ? "mosaic" : part === "images" ? "images" : "text" });
    return true;
  });
  return <div className="json-embedding-view" onClickCapture={event => logGameButton(event, appendLog)} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();const file=event.dataTransfer.files[0] as (File&{path?:string})|undefined;const raw=file?.path||event.dataTransfer.getData("text/uri-list").split(/\r?\n/).find(line=>!line.startsWith("#"));if(raw)void dropped(raw.startsWith("file://")?decodeURIComponent(raw.replace(/^file:\/\/\/?/,"")):raw);}}>{confirmation.dialog}
    <main className="embed-workspace embed-unity-workspace" data-workflow-part={part}>
      <header className="embed-game-header"><IconAction name="back" label="返回游戏列表" disabled={busy} onClick={()=>{const change=()=>void textHandle.current?.leave().then(ok=>{if(ok)onBack();});if(imageLeaveGuard.current)imageLeaveGuard.current(change);else change();}}/><strong data-tooltip={game.name}>{game.name}</strong><span className="embed-engine">{game.engine}</span><button type="button" className="embed-game-location" data-tooltip={game.path} aria-label={game.path} onClick={()=>void api.revealPath(game.path).catch(e=>setError(String(e)))}>{game.path}</button><div className="unity-top-actions unity-header-icon-group" style={{marginLeft:"auto",flexShrink:0}}>
        <UnityIconButton className="unity-project-save" aria-label="保存工程"
          title={projectSaving ? "正在保存工程修改" : projectDirty ? "保存工程修改" : "没有未保存的修改"}
          disabled={busy || !projectDirty} onClick={async()=>{
          setProjectSaving(true);
          try {
            if (textInfo.dirty && !await textHandle.current?.prepare()) return;
            if (imageWorkflow.dirty) {
              if (!imageHandle.current) return;
              await imageHandle.current.saveChanges();
            }
            if (mosaicDirty) saveMosaicDrafts(game.path);
            showAppNotice("工程已保存");
          } catch (cause) { setError(String(cause)); }
          finally { setProjectSaving(false); }
        }}><UnityActionIcon kind="save"/></UnityIconButton>
        {thirdPartyMosaic && !deploymentPage && <GameMosaicPatchButton gamePath={game.path} disabled={busy} />}
      </div></header>

      <UnityGameWorkspace active={active} deployment={deploymentPage} mosaic={part === "mosaic"} steps={workflowSteps} controls={<div ref={setControlsTarget} id="embed-step-panel" role="tabpanel" aria-labelledby={`embed-step-${activeWorkflowId}`} className="engine-workspace-slot"/>} results={<div ref={setResultsTarget} hidden={deploymentPage} className="engine-workspace-slot engine-result-slot"/>}/>
      {controlsTarget&&createPortal(<div hidden={part!=="text"||textStep===2} className="engine-workflow-content"><div className="unity-step-panel">

        {textStep === 1 && scanProgress && <><div><StandaloneGameFlowCard stepId="scan" title="扫描资源" state={scanProgress.state}
          label={gameProgressLabels[scanProgress.state]} elapsed={scanProgress.elapsed}
          progress={{ current: scanProgress.completed, total: scanProgress.total, percent: scanProgress.percent, sample: scanProgress.detail }}
          details={scanProgress.details} performance={<GameFlowPerformance measured={scanProgress.measurement} />}
          actions={<>
          {scanning ? <button className="unity-btn unity-btn-primary" onClick={stopScan}>中止扫描</button>
            : needsLooseLocres ? <><button className="unity-btn unity-btn-primary" disabled={testing || busy} title={testTitle} onClick={() => void start("extract")}>{imageWorkflow.exists ? "重新扫描图片" : "扫描图片"}</button><button className="unity-btn" disabled={busy} onClick={() => void recheckLooseLocres()}>{checkingTextSource ? "正在检测…" : "重新检测散装 .locres"}</button></>
            : canUseTextResources && <button className="unity-btn unity-btn-primary" disabled={testing || busy} title={testTitle} onClick={() => void start("extract")}>{hasTextScan ? "重新扫描资源" : "开始扫描"}</button>}
        </>}
        /></div>
            {textSource === "locres" && <p className="hint">图片翻译支持游戏 Content 目录中的散装 PNG。封包中的纹理暂不支持。</p>}
            {textSource === "locres" && (needsLooseLocres || !hasTextScan) && <p className="hint">
              {needsLooseLocres
                ? "当前目录没有散装 .locres。请先用外部工具将本地化字符串导出为散装 .locres，放到游戏对应的 Content/Localization 目录，再重新检测。"
                : "扫描 Content/Localization 下的散装 .locres。按游戏实际使用的原文语言筛选后再翻译。"}
            </p>}
            {scanResources}
        </>}
        {textStep===3&&<>
          <div className="unity-control-group"><span>待回写译文 {textInfo.changed} 条</span>{!!textInfo.positionRepairs && <span>对话纠错 {textInfo.positionRepairs} 条</span>}</div>
          {output("补丁目录",artifacts.text?.path)}
          <div className="dpl embed-deployment-canvas">
            <DeploymentThroughput metrics={canvas.metrics} />
            <DeploymentCanvas model={canvas} percent={run ? 100 * run.completed / Math.max(1, run.total) : canvas.applied ? 100 : canvas.staged ? 80 : 0}
              running={deploymentRunning} onFocusStep={id => selectWorkflow(stageIds[id])} actions={{
                execute: () => void runAutomatic(),
                stop: stopDeployment,
                savePlan: value => {
                  if (busy) return false;
                  try { saveDeploymentPlan(game.path, value); setPlanRevision(previous => previous + 1); return true; }
                  catch (cause) { setError(String(cause)); return false; }
                },
              }} />
          </div>
          {deploymentPanel}
        </>}
        {textStep===1 && imageWorkflow.scanTiming && <details><summary>图片扫描 · 重新解析 {imageWorkflow.scanTiming.parsed} 张 · 复用 {imageWorkflow.scanTiming.reused} 张</summary>
          <p>读取旧工程 {imageWorkflow.scanTiming.loadMs} ms · 查找资源 {imageWorkflow.scanTiming.listMs} ms · 校验与解析 {imageWorkflow.scanTiming.parseMs} ms</p></details>}
        {textStep===1 && scanElapsed!==null && !scanning && <details><summary>扫描计时 · {scanElapsed.toFixed(1)} 秒</summary><p>文本 {textInfo.count} 条 · 图片 {imageWorkflow.count ?? 0} 张</p></details>}
        {textStep===3&&validationErrors.length>0&&<div className="unity-step-batch"><GameBatchResults errors={validationErrors} onLocate={locateBatch}/></div>}
        {textStep===3&&fileConflicts.length>0&&<div className="unity-step-batch"><GameBatchResults errors={fileConflicts} onLocate={locateBatch}/></div>}
        {textStep===3&&imageProject&&patch.conflicts.some(path=>matchedImageConflicts.has(path))&&<button type="button" className="unity-btn" onClick={()=>selectWorkflow("2.2")}>查看图片补丁冲突</button>}
        </div></div>,controlsTarget)}
      <GameTextWorkspace testConfigurations={testConfigurations} testConfigurationDisabled={busy || !textInfo.sourcePath} gamePath={game.path} settings={settings} sourcePath={scanPath} controls={controlsTarget} results={resultsTarget} batchResults={textBatch} visible={part==="text"} step={textStep} active={active} disabled={projectSaving||mosaicBusy||deploymentRunning||pending||detecting||status.state==="running"} skipped={workflow.textSkipped} onSkip={()=>void skipPart(false)} handle={textHandle} onInfo={textInfoChanged} onBatchFailures={setTextFailures} onBatchCorrections={setTextRepairs} onMessage={textLog}/>
      {imageProject&&<GameMosaicCompletionContext.Provider value={setMosaicComplete}><GameImageWorkbench packageOnly={imageExport} onPackageMosaicSelection={imageExport ? updatePackageMosaicIds : undefined} mosaicDeployment={selfMosaic ? mosaicHandle : undefined} mosaicActive={active&&selfMosaic&&part==="mosaic"} mosaicDisabled={workflowBusy} onMosaicBusy={setMosaicBusy} testConfigurations={testConfigurations} testConfigurationDisabled={busy || !(textInfo.sourcePath || imageWorkflow.loaded)} patchConflictPaths={patch.conflicts} onMatchedPatchConflicts={setMatchedImageConflicts} handle={imageHandle} workspaceTargets={{controls:controlsTarget,results:resultsTarget}} scanRequest={imageScanRequest} skipped={workflow.imagesSkipped} onSkip={skipImages} onResetSkipped={()=>{if(workflowRef.current.imagesSkipped)void updateWorkflow({imagesSkipped:false});}} leaveGuard={imageLeaveGuard} onTaskStateChange={setImageWorkflow} workflowStage={textStep===3?"apply":"images"} backupScopes={backupScopes} gamePath={game.path} settings={settings} backupMode={backupMode} active={active&&part==="images"} disabled={projectSaving||mosaicBusy||deploymentRunning||pending||detecting||status.state==="running"} onBusy={setImageBusy} onMessage={imageLog}/></GameMosaicCompletionContext.Provider>}

    </main>

  </div>;
}
