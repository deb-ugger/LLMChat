import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { dirname, join, resourceDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFileBytes } from "../localDocFile";
import { exportUnityTranslations, importUnityTranslations } from "../unityTranslationFiles";
import { api, type Settings, type TranslateProvider, type UnityGameInfo, type OcrMode } from "../api";
import { currentEffectivePresets, loadLocalModelProfiles, loadVendorProfiles, resolveFeatureLlm } from "../modelPresets";
import { engineReady, parseEngineKeys } from "../translateEngines";
import { buildUnityTranslateOptions, prepareUnityTranslationRequest, translateUnityRichText, restoreUnityTranslationLines, sameUnityGamePath, UNITY_LANGUAGES } from "../unityTranslation";
import { formatUnityStructure, planUnityStructuredLines, translateUnityStructuredText, canReuseUnityStructuredDraft } from "../unityTextStructure";
import { legacyUnityOutputDirectory, mergeUnityProject, UnityPaused, unityRun, unityTranslationError, type UnityEntry, type UnityPatch, type UnityProgress, type UnityProject, type UnityWorkspace, type UnityInspection, type UnityFontPlan, type UnityImage } from "../unityOffline";
import { explainUnityFailure, explainUnityWarning } from "../unityOfflineFeedback";
import { UNITY_STAGE_TABS, unityImagesReady, UNITY_STEPS, unityLanguageScope, unityStageState, unityEntryLanguage, unityLanguageLabel, unityScanUpdate, unityScanOptionChanges } from "../unityWorkflow";
import { translateUnitySession, unityTranslationStats, unityTranslationCharacters, unityTranslationContextKey, yieldUnityPreparation, type UnityTranslationQueue } from "../unityTranslationSession";
import { smartUnityLines, planUnityLines, flattenUnityLines, applyUnityLineBreaks, parseUnityLineModel, unityLineModelInput, UNITY_LINE_MODEL_PROMPT, type UnityLineMode } from "../unityLineLayout";
import { UnitySegmentation } from "../unitySegmentation";
import { UnityProjectLoading } from "./UnityProjectLoading";
import { UnityImageWorkbench } from "./UnityImageWorkbench";
import { createUnityTranslationJobs, mergeUnityTranslationProject, UnityTranslationStopped, type UnityTranslationPart } from "../unityTranslationJobs";
import { createUnityImageOcr, processUnityImages, renderUnityImage, unityImageTranslationRegions } from "../unityImages";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { UnityEngineList } from "./UnityEngineList";
import { UnityTranslationProgress } from "./UnityTranslationProgress";
import { createUnityEnginePool, loadUnityEngines, normalizeUnityEngines, defaultUnityEngines, UNITY_ENGINE_CHOICES_KEY, type UnityEngineChoice } from "../unityEnginePool";
import { UnityDescriptionSelect, UNITY_WRAP_CHOICES, UNITY_LINE_CHOICES, UNITY_SEGMENT_CHOICES } from "./UnityDescriptionSelect";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import { usePersistedSize } from "../hooks/usePersistedSize";
import "../unityOffline.css";

export type UnityOfflineHandle = { prepareToLeave: () => Promise<boolean> };
const GENERATION_STEPS = UNITY_STEPS;
type UnityTranslationOptions = ReturnType<typeof buildUnityTranslateOptions> & { engineIds?: TranslateProvider[] };
type GenerationProgress = UnityProgress & { step: number; state: "pending" | "running" | "done" | "stopped" | "error" | "skipped"; failure?: string };
type TranslationFileStatus = { action: "download" | "import"; state: "working" | "checked" | "done" | "cancelled" | "error"; detail: string; path?: string; folder?: string };
type RunCheckpoint = {
  step: number; endStep: number; automatic: boolean; finished: boolean;
  projectFolder: string; scanFolder: string; patchFolder: string; patch: UnityPatch | null;
  previousProjectFolder?: string; scopeVersion?: number; translationFailure?: string;
  translationRuns?: Record<UnityTranslationPart, GenerationProgress>;
  imageOnly?: boolean; imageOcrMode?: OcrMode; imageConfidenceThreshold?: number;
  partial?: boolean; joinLines?: boolean; lineMode?: UnityLineMode; lineModel?: string; layoutOnly?: boolean;
  textMode?: "lines" | "paragraphs" | "smart"; codeAssemblies?: string[] | null; typeDirectory?: string; extraCharacters?: string;
  translationKind: "llm" | "engine"; llmModel?: string; engine: TranslateProvider; engines?: UnityEngineChoice[]; source: string; target: string; includeCode: boolean; fontPath: string;
  progress: GenerationProgress;
};
type Props = {
  active: boolean; game: UnityGameInfo | null; settings: Settings;
  onOpenGeneralSettings?: () => void;
  onBusyChange?: (busy: boolean) => void;
  onInstallationChange?: (root: string, installed: boolean) => void;
  toolbarTarget: HTMLElement | null;
};
export const UnityOfflineView = forwardRef<UnityOfflineHandle, Props>(function UnityOfflineView({ active, game, settings, onOpenGeneralSettings, onBusyChange, onInstallationChange, toolbarTarget }, ref) {
  const root = game?.gameDir || "";
  const [output, setOutput] = useState("");
  const [project, setProject] = useState<UnityProject | null>(null);
  const [translationKind, setTranslationKind] = useState<"llm" | "engine">("llm");
  const [llmModel, setLlmModel] = useState("");
  const [engine, setEngine] = useState<TranslateProvider>("bing");
  const [engineChoices, setEngineChoices] = useState<UnityEngineChoice[]>(loadUnityEngines);
  const [engineListExpanded, setEngineListExpanded] = useState(true);
  useEffect(() => { localStorage.setItem(UNITY_ENGINE_CHOICES_KEY, JSON.stringify(engineChoices)); }, [engineChoices]);
  const [source, setSource] = useState("auto");
  const [imagePart, setImagePart] = useState(false);
  const [imageOcrMode, setImageOcrMode] = useState<OcrMode>("fast");
  const [imageConfidenceThreshold, setImageConfidenceThreshold] = useState(50);
  const [target, setTarget] = useState("zh-CN");
  const [joinLines, setJoinLines] = useState(true);
  const [lineMode, setLineMode] = useState<UnityLineMode>("local");
  const [lineModel, setLineModel] = useState("");
  const [includeCode, setIncludeCode] = useState(false);
  const [textMode, setTextMode] = useState<"lines" | "paragraphs" | "smart">("smart");
  const [preparingRescan, setPreparingRescan] = useState(false);
  const [codeAssemblies, setCodeAssemblies] = useState<string[] | null>(null);
  const [typeDirectory, setTypeDirectory] = useState("");
  const [extraCharacters, setExtraCharacters] = useState("");
  const [inspection, setInspection] = useState<UnityInspection | null>(null);
  const [inspectionError, setInspectionError] = useState("");
  const [fontPlan, setFontPlan] = useState<UnityFontPlan | null>(null);
  const [activeStep, setActiveStep] = useState(1);
  const followProgress = useRef(true);
  const [fontPath, setFontPath] = useState("");
  const [search, setSearch] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [jumpPage, setJumpPage] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [fileStatus, setFileStatus] = useState<TranslationFileStatus | null>(null);
  const [message, setMessage] = useState("");
  const [patch, setPatch] = useState<UnityPatch | null>(null);
  const [dirty, setDirty] = useState(false);
  const [generationState, setGeneration] = useState<GenerationProgress | null>(null);
  const [applied, setApplied] = useState(false);
  const [checkpoint, setCheckpoint] = useState<RunCheckpoint | null>(null);
  const checkpointRef = useRef<RunCheckpoint | null>(null);
  const generation = activeStep === 2 && checkpoint?.translationRuns ? checkpoint.translationRuns[imagePart ? "images" : "text"] : generationState;
  const translationJobs = useRef<ReturnType<typeof createUnityTranslationJobs> | null>(null);
  const projectWrites = useRef<Promise<unknown>>(Promise.resolve());
  const imageMode = useRef(imageOcrMode); imageMode.current = imageOcrMode;
  const imageThreshold = useRef(imageConfidenceThreshold); imageThreshold.current = imageConfidenceThreshold;
  const [restoring, setRestoring] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState("");
  const [restoreNotices, setRestoreNotices] = useState<string[]>([]);
  const [workRoot, setWorkRoot] = useState("");
  const [rowIssue, setRowIssue] = useState<UnityEntry | null>(null);
  const [rowJump, setRowJump] = useState<{ id: string; sequence: number } | null>(null);
  const [failurePage, setFailurePage] = useState(0);
  const panelWidth = usePersistedWidth("unity-offline-panel-width", 480, 300, 900);
  const configRef = useRef<HTMLElement>(null);
  const upperRef = useRef<HTMLDivElement>(null);
  const workflowRef = useRef<HTMLElement>(null);
  const [manualLayout, setManualLayout] = useState(false);
  const [configHeight, setConfigHeight] = useState(window.innerHeight - 100);
  const upperMinimum = 300;
  const upperMaximum = Math.max(upperMinimum, configHeight - 180);
  const upper = usePersistedSize("unity-offline-upper-height", 320, upperMinimum, upperMaximum, "y");
  const upperHeight = Math.max(upperMinimum, Math.min(manualLayout ? upper.size : 520, upperMaximum));
  useEffect(() => {
    const height = Math.max(upperMinimum, Math.min(upper.size, upperMaximum));
    if (height !== upper.size) upper.setSize(height);
  }, [upperMinimum, upperMaximum, upper.size, upper.setSize]);
  useEffect(() => { setManualLayout(false); }, [root, active]);
  const resizeLayout = (event: Parameters<typeof upper.beginResize>[0]) => {
    const currentUpper = upperRef.current!.getBoundingClientRect().height;
    upper.setSize(currentUpper); setManualLayout(true);
    upper.beginResize(event, 1, currentUpper);
  };
  const resizeLayoutKey = (change: number) => {
    const currentUpper = upperRef.current!.getBoundingClientRect().height;
    upper.setSize(Math.max(upperMinimum, Math.min(upperMaximum, currentUpper + change)));
    setManualLayout(true);
  };
  const sourceWidth = usePersistedWidth("unity-offline-source-width", 112, 80, 280);
  const [originalRatio, setOriginalRatio] = useState(() => Math.min(70, Math.max(20, Number(localStorage.getItem("unity-offline-original-ratio")) || 45)));
  const tableRef = useRef<HTMLTableElement>(null);
  const columnDrag = useRef<{ x: number; ratio: number; width: number; latest: number } | null>(null);
  const taskWrites = useRef<Promise<unknown>>(Promise.resolve());
  const queuedSignature = useRef("");
  const checkpointKey = "llmchat-unity-run:" + root.toLowerCase();
  const remember = (value: RunCheckpoint) => {
    checkpointRef.current = value; setCheckpoint(value); setGeneration(value.progress);
    const { progress, translationRuns, ...fields } = value;
    const parts = translationRuns && Object.fromEntries(Object.entries(translationRuns).map(([part, value]) => [part, { state: value.state, total: value.total, failure: value.failure, engineStats: value.engineStats?.map(({ id, characters }) => ({ id, characters })) }]));
    const signature = JSON.stringify({ root, ...fields, translationRuns: parts, progress: { step: progress.step, state: progress.state, folder: progress.folder, total: progress.total, failure: progress.failure } });
    if (signature !== queuedSignature.current) {
      queuedSignature.current = signature;
      const job = structuredClone(value);
      taskWrites.current = taskWrites.current.catch(() => {}).then(() => unityRun("save-task", { root, task: job }));
      void taskWrites.current.catch(e => { queuedSignature.current = ""; setError(`任务检查点保存失败：${String(e)}`); });
    }
  };
  const abort = useRef<AbortController | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const translationQueue = useRef<UnityTranslationQueue | null>(null);
  const closing = useRef(false);
  const status = useRef({ busy, dirty }); status.current = { busy, dirty };
  const latest = useRef(project); latest.current = project;
  const publish = (value: UnityProject) => { latest.current = value; setProject(value); };
  const scanUpdate = unityScanUpdate(project, checkpoint, { includeCode, textMode, typeDirectory, codeAssemblies });
  const needsScan = scanUpdate.level === "required";
  useEffect(() => { workflowRef.current?.scrollTo({ top: 0 }); }, [activeStep]);
  useEffect(() => {
    let cancelled = false; setInspection(null); setInspectionError("");
    if (root) void unityRun<UnityInspection>("inspect", { root }).then(result => { if (!cancelled) setInspection(result); }).catch(error => { if (!cancelled) setInspectionError(String(error)); });
    return () => { cancelled = true; };
  }, [root]);
  useEffect(() => {
    const element = configRef.current; if (!element) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === element) setConfigHeight(entry.contentRect.height);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setProject(null); setPatch(null); setDirty(false); setPage(0); setJumpPage(""); setSearch(""); setFileStatus(null); setRowJump(null); setFailurePage(0);
    setError(""); setActionError(""); setMessage(""); setFontPath(""); setLlmModel(""); setJoinLines(true);
    setLineMode("local"); setLineModel("");
    setImageConfidenceThreshold(50);
    setGeneration(null); setApplied(false);
    setTextMode("smart"); setCodeAssemblies(null); setTypeDirectory(""); setExtraCharacters(""); setFontPlan(null);
    setPreparingRescan(false);
    setActiveStep(1); setImagePart(false); followProgress.current = true;
    setRestoreNotices([]);
    setWorkRoot(""); setOutput(""); setRowIssue(null); queuedSignature.current = "";
    setCheckpoint(null); checkpointRef.current = null;
    let cancelled = false;
    const saved = localStorage.getItem(checkpointKey);
    if (!root) { setRestoring(false); return; }
    setLoadingDetail("正在读取工作目录与任务检查点…");
    setRestoring(true);
    void (async () => {
      try {
        const workspace = await unityRun<UnityWorkspace<RunCheckpoint>>("workspace", { root, outputRoot: await legacyUnityOutputDirectory(), task: saved ? JSON.parse(saved) : null });
        if (cancelled) return;
        setWorkRoot(workspace.workRoot); setOutput(workspace.projectsRoot); setRestoreNotices(workspace.saved.notices);
        let value = workspace.task;
        const folder = value?.projectFolder || value?.scanFolder;
        let p: UnityProject | null;
        if (folder) p = await loadProject(folder, value?.previousProjectFolder, detail => { if (!cancelled) setLoadingDetail(detail); });
        else {
          const found = workspace.saved;
          if (cancelled) return;
          setRestoreNotices(found.notices); p = found.project;
          if (p) {
            const incomplete = found.scanTotal !== null;
            if (!value) value = projectCheckpoint(p, incomplete, found.scanCompleted, found.scanTotal);
            else { value.projectFolder = p.folder; if (incomplete) value.scanFolder = p.folder; }
            if (found.includeCode !== null) value.includeCode = found.includeCode;
          }
        }
        if (cancelled) return;
        setLoadingDetail(p ? `正在恢复 ${p.entries.length.toLocaleString("zh-CN")} 条原文、译文及处理进度…` : "正在准备项目操作界面…");
        if (p && !sameUnityGamePath(p.root, root)) throw new Error("检查点不属于当前游戏");
        setProject(p);
        setApplied(workspace.installed); onInstallationChange?.(root, workspace.installed);
        if (value) {
          if ((value.lineMode as string) === "hanlp") value.lineMode = "wtp";
          if (value.scopeVersion !== 1) value = { ...value, source: value.finished && !value.patch && value.endStep < 3 ? value.source : "all", scopeVersion: 1 };
          setPatch(value.patch);
          setTranslationKind(value.translationKind); setLlmModel(value.llmModel || ""); setEngine(value.engine); setSource(value.source); setTarget(value.target); setJoinLines(value.joinLines ?? true); setIncludeCode(value.includeCode); setFontPath(value.fontPath);
          setEngineChoices(value.engines ? normalizeUnityEngines(value.engines) : defaultUnityEngines());
          setLineMode(value.lineMode || "local"); setLineModel(value.lineModel || "");
          setTextMode(value.textMode || p?.textMode || "paragraphs"); setCodeAssemblies(value.codeAssemblies ?? null); setTypeDirectory(value.typeDirectory || ""); setExtraCharacters(value.extraCharacters || "");
          if (!value.finished && value.step === 2 && !value.imageOnly && p) {
            const ids = unityLanguageScope(p.entries, value.source).ids;
            const rows = p.entries.filter(e => e.selected && ids.has(e.id));
            value.progress = { ...value.progress, ...unityTranslationStats(rows, unityTranslationError, unityTranslationContextKey), translation: undefined, detail: "已恢复有效译文；主进度按语境内去重后的原文计算，未完成项可继续" };
          }
          if (value.translationRuns && p) {
            const ids = unityLanguageScope(p.entries, value.source).ids;
            const rows = p.entries.filter(entry => entry.selected && ids.has(entry.id));
            value.translationRuns.text = { ...value.translationRuns.text, ...unityTranslationStats(rows, unityTranslationError, unityTranslationContextKey), translation: undefined };
            const images = (p.images || []).filter(image => image.selected);
            value.translationRuns.images = { ...value.translationRuns.images, completed: images.filter(image => image.completed).length, total: images.length };
            if (!value.finished) for (const progress of Object.values(value.translationRuns)) if (progress.state === "running") progress.state = "stopped";
          }
          if (!value.finished && value.progress.state !== "error") value.progress.state = "stopped";
          remember(value);
          setActiveStep(value.step); setImagePart(!!value.imageOnly); setImageOcrMode(value.imageOcrMode || "fast");
          setImageConfidenceThreshold(value.imageConfidenceThreshold ?? 50);
          if (value.finished && value.endStep !== 4) setGeneration(null);
          if (value.progress.state === "error") setError(value.progress.failure || "上次任务未能完成，可以重试。已有工程和译文仍保留。");
          else if (!value.finished) setMessage("已从游戏工作目录加载未完成任务，点击恢复可继续。");
          else if (p) setMessage("已自动加载上次保存的工程。");
        }
        await taskWrites.current;
        if (!cancelled) localStorage.removeItem(checkpointKey);
      } catch (e) { if (!cancelled) setError(`恢复检查点失败：${e instanceof Error ? e.message : String(e)}`); }
      finally { if (!cancelled) setRestoring(false); }
    })();
    return () => { cancelled = true; };
  }, [root]);
  useEffect(() => { onBusyChange?.(!!busy || restoring); }, [busy, restoring, onBusyChange]);
  useImperativeHandle(ref, () => ({ prepareToLeave: async () => {
    if (busy || running.current || restoring) { setError("请先中止任务或等待当前工作目录处理完成后切换"); return false; }
    try { if (dirty) await save(); await taskWrites.current; return true; } catch (e) { setError(String(e)); return false; }
  } }));
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || busy) event.preventDefault(); };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);
  const needsCloseHandler = project !== null || !!busy;
  useEffect(() => {
    if (!active || !needsCloseHandler || !isTauri()) return;
    let dispose: (() => void) | undefined; let cancelled = false;
    void getCurrentWindow().onCloseRequested(async event => {
      event.preventDefault();
      if (closing.current) return;
      closing.current = true;
      try {
        if (status.current.busy) {
          const proceed = await confirm("停止翻译或等待当前资源处理结束，保存工程后退出？", { title: "退出 LLMChat", okLabel: "保存并退出", cancelLabel: "取消" });
          if (!proceed) return;
          abort.current?.abort(); await running.current;
        }
        if (latest.current) await unityRun("save", { project: latest.current });
        await taskWrites.current;
        await getCurrentWindow().destroy();
      } catch (e) { setError(`退出失败，窗口已保留：${String(e)}`); }
      finally { closing.current = false; }
    }).then(fn => { if (cancelled) fn(); else dispose = fn; }).catch(e => setError(String(e)));
    return () => { cancelled = true; dispose?.(); };
  }, [active, needsCloseHandler]);

  const scope = useMemo(() => unityLanguageScope(project?.entries || [], source), [project, source]);
  const sourceLanguages = useMemo(() => [...new Set(["ja", "en", "ko", "zh", "ru", ...(project?.entries.map(unityEntryLanguage) || [])])].filter(language => !["und", "cjk", "all"].includes(language)), [project]);
  const selected = useMemo(() => project?.entries.filter(e => e.selected && scope.ids.has(e.id)) || [], [project, scope]);
  const modelChoices = useMemo(() => {
    const presets = currentEffectivePresets(), locals = loadLocalModelProfiles(), vendors = loadVendorProfiles();
    return [...new Set([settings.model, ...Object.keys(locals)])].filter(Boolean).map(model => {
      const preset = presets.find(p => p.model === model);
      return { model, label: preset?.label || model, group: preset?.group || "本地模型", connection: resolveFeatureLlm(settings, model, locals, vendors, presets) };
    }).filter(p => p.connection.apiUrl.trim()).map(({ connection: _, ...choice }) => choice);
  }, [settings, active]);
  const modelConnection = resolveFeatureLlm(settings, llmModel);
  const engineConfigured = engineChoices.some(row => row.enabled && engineReady(parseEngineKeys(settings.translateEngineKeys), row.id));
  const connectionReady = translationKind === "llm" ? !!modelConnection.model.trim() && !!modelConnection.apiUrl.trim() : engineConfigured;
  const done = useMemo(() => selected.filter(e => e.translation && !e.error && !unityTranslationError(e.source, e.translation)).length, [selected]);
  const filtered = useMemo(() => project?.entries.filter(e => scope.ids.has(e.id) && (!errorsOnly || e.error || unityTranslationError(e.source, e.translation)) && (!search || `${e.source}\n${e.translation}\n${e.file}`.toLowerCase().includes(search.toLowerCase()))) || [], [project, search, scope, errorsOnly]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 40));
  const rows = filtered.slice(Math.min(page, pageCount - 1) * 40, (Math.min(page, pageCount - 1) + 1) * 40);
  const translationFailures = useMemo(() => project?.entries.filter(entry => scope.ids.has(entry.id) && !!entry.error) || [], [project, scope]);
  const failurePageCount = Math.max(1, Math.ceil(translationFailures.length / 20));
  const visibleFailurePage = Math.min(failurePage, failurePageCount - 1);
  const locateTranslationFailure = (id: string) => {
    const index = project?.entries.filter(entry => scope.ids.has(entry.id)).findIndex(entry => entry.id === id) ?? -1;
    if (index < 0) return;
    setSearch(""); setErrorsOnly(false); setJumpPage(""); setRowIssue(null);
    setPage(Math.floor(index / 40));
    setRowJump(previous => ({ id, sequence: (previous?.sequence || 0) + 1 }));
  };
  useEffect(() => {
    if (!rowJump) return;
    const row = Array.from(tableRef.current?.querySelectorAll<HTMLTableRowElement>("tbody tr[data-entry-id]") || []).find(element => element.dataset.entryId === rowJump.id);
    row?.scrollIntoView({ block: "center", inline: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    row?.focus({ preventScroll: true });
  }, [rowJump]);
  const update = (id: string, value: Partial<UnityProject["entries"][number]>) => {
    const p = latest.current;
    if (p) publish({ ...p, entries: p.entries.map(e => e.id === id ? { ...e, ...value, error: "" } : e) });
    setDirty(true); invalidatePatch();
    setFontPlan(null);
  };
  async function operation(label: string, task: () => Promise<void>, keepProgress = true, reportError: (message: string) => void = setError) {
    if (running.current) return false;
    if (!keepProgress) setGeneration(null);
    setBusy(label); setError(""); setActionError(""); setMessage("");
    const work = task(); running.current = work;
    try { await work; return true; } catch (e) { reportError(String(e instanceof Error ? e.message : e)); return false; }
    finally { running.current = null; setBusy(""); }
  }
  function projectCheckpoint(p: UnityProject, incomplete = false, completed: number | null = 1, total: number | null = 1): RunCheckpoint {
    return { step: 1, endStep: 1, automatic: false, finished: !incomplete, projectFolder: p.folder, scanFolder: incomplete ? p.folder : "", patchFolder: "", patch: null,
      translationKind, llmModel, engine, engines: engineChoices, source, target, joinLines, lineMode, lineModel, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters, scopeVersion: 1,
      progress: { step: 1, state: incomplete ? "stopped" : "done", detail: incomplete ? "已加载扫描检查点" : "已加载保存工程", completed: completed || 0, total } };
  }
  async function loadProject(folder: string, previousFolder?: string, onLoading?: (detail: string) => void) {
    onLoading?.("正在加载工程原文、译文及字体信息…");
    let p = await unityRun<UnityProject>("load", { path: folder + "/unity-project.json" });
    if (!sameUnityGamePath(p.root, root)) throw new Error("工作目录中的工程不属于当前游戏，请检查游戏工作文件夹");
    if (previousFolder && !sameUnityGamePath(previousFolder, folder)) {
      onLoading?.("正在读取旧工程并匹配可复用译文…");
      const previous = await unityRun<UnityProject>("load", { path: previousFolder + "/unity-project.json" });
      if (!sameUnityGamePath(previous.root, root)) throw new Error("旧工程不属于当前游戏");
      p = mergeUnityProject(previous, p);
      await unityRun("save", { project: p });
    }
    return p;
  }
  async function restartStage(step: number) {
    if (busy || restoring) return;
    if (step === 1) {
      setPreparingRescan(true); setActiveStep(1); followProgress.current = false;
      setGeneration(null); setError(""); setActionError(""); setMessage(""); setRowIssue(null); setFileStatus(null);
      return;
    }
    const cleanup = step === 2 && imagePart ? "图片识别结果、图片译文和后续补丁，保留文本译文及原图" : step === 1 ? "当前游戏的扫描工程、译文、字库检查及补丁" : step === 2 ? "当前工程的文本译文、字库检查及补丁，保留扫描、图片识别结果和译图" : step === 3 ? "当前工程的字库检查、补丁及应用记录，保留扫描和译文" : "应用记录，恢复游戏原件，保留校验通过的补丁、扫描和译文";
    if (!await confirm(`重做“${step === 2 && imagePart ? "2.2 图片识别与翻译" : GENERATION_STEPS[step - 1]}”？将清除${cleanup}。已应用的文件会先从校验通过的原件备份恢复；清理完成后再重新开始。`, { title: "重做步骤", kind: "warning", okLabel: "清理并重新设置", cancelLabel: "取消" })) return;
    await operation("清理旧产物", async () => {
      if (dirty) await save(); await taskWrites.current;
      const task = checkpointRef.current || (project && projectCheckpoint(project));
      const applyWorkspace = (workspace: UnityWorkspace<RunCheckpoint>) => {
        const p = workspace.saved.project; latest.current = p; setProject(p);
        checkpointRef.current = workspace.task; setCheckpoint(workspace.task); queuedSignature.current = "";
        setPatch(workspace.task?.patch || null); setApplied(workspace.installed); onInstallationChange?.(root, workspace.installed); setGeneration(null); setDirty(false); setPage(0); setRowIssue(null);
        setFontPlan(null);
        setRestoreNotices(workspace.saved.notices);
      };
      try {
        const result = await unityRun<{ step: number; workspace: UnityWorkspace<RunCheckpoint> }>("reset-step", { root, step, imageOnly: step === 2 && imagePart, path: project?.folder || "", task: task && { ...task, translationKind, llmModel, engine, engines: engineChoices, source, target, joinLines, lineMode, lineModel, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters } }, progress => setMessage(progress.detail));
        applyWorkspace(result.workspace); setActiveStep(step === 2 ? 2 : result.step); followProgress.current = false;
        setMessage(step === 4 ? "游戏原件已恢复，应用记录已清理，可复用已生成的补丁重新应用。" : "本步及后续失效产物已清理，可调整参数后重新开始。");
      } catch (error) {
        // The native reset checkpoint finishes any interrupted cleanup before loading results.
        try { applyWorkspace(await unityRun<UnityWorkspace<RunCheckpoint>>("workspace", { root })); } catch { /* Keep the original cleanup failure visible. */ }
        throw error;
      }
    }, false);
  }
  function queueProjectWrite<T>(job: () => Promise<T>): Promise<T> {
    const next = projectWrites.current.catch(() => {}).then(job); projectWrites.current = next; return next;
  }
  async function save(p = latest.current) {
    if (!p) return;
    await queueProjectWrite(() => unityRun("save", { project: latest.current?.folder === p.folder ? latest.current : p }));
    setDirty(false);
  }
  function publishTranslation(p: UnityProject, part: UnityTranslationPart) {
    const merged = mergeUnityTranslationProject(latest.current || p, p, part); publish(merged); return merged;
  }
  async function saveTranslation(p: UnityProject, part: UnityTranslationPart) { publishTranslation(p, part); await save(); }

  async function translationOptions(run?: RunCheckpoint, forImages = false): Promise<UnityTranslationOptions> {
    const general = await api.getSettings();
    const engineIds = (run?.engines || engineChoices).filter(row => row.enabled && engineReady(parseEngineKeys(general.translateEngineKeys), row.id)).map(row => row.id);
    const provider = (run?.translationKind || translationKind) === "llm" ? "llm" : engineIds[0];
    if (!provider) throw new Error("请在并行翻译列表中至少启用一个免 Key 或已配置凭证的引擎");
    const language = forImages ? run?.source || source : unityLanguageScope(latest.current?.entries || [], run?.source || source).language;
    return { ...buildUnityTranslateOptions(general, provider, language === "all" || language === "und" ? "auto" : language, run?.target || target, run?.llmModel ?? llmModel, forImages ? false : run?.joinLines ?? joinLines), engineIds: provider === "llm" ? undefined : engineIds };
  }
  async function scan(onProgress?: (value: UnityProgress) => void, signal?: AbortSignal, run?: RunCheckpoint) {
    let p = await unityRun<UnityProject>("scan", { root, outputRoot: output, includeCode: run?.includeCode ?? includeCode, textMode: run?.textMode || textMode, codeAssemblies: run?.codeAssemblies ?? codeAssemblies, typeDirectory: run?.typeDirectory ?? typeDirectory, path: run?.scanFolder || "" }, onProgress, signal);
    if (run?.previousProjectFolder) {
      const previous = await loadProject(run.previousProjectFolder);
      p = mergeUnityProject(previous, p); await unityRun("save", { project: p });
    }
    publish(p); setPage(0); setDirty(false); setPatch(null); setApplied(false);
    setFontPlan(null);
    setMessage(p.entries.length ? `扫描完成：${p.entries.length} 条文本，${p.fonts.length} 个字体` : "未找到可处理的文本，请查看扫描提示中的跳过原因。");
    return p;
  }
  async function translateProject(p: UnityProject, controller: AbortController, options: Awaited<ReturnType<typeof translationOptions>>, onProgress?: (value: UnityProgress) => void, languageSource = source, mergeLines = joinLines, breakMode: UnityLineMode = "local", helperModel = "", layoutOnly = false, onlyIds?: Set<string>) {
    await yieldUnityPreparation(controller.signal);
    const next = structuredClone(p);
    const cache = new Map<string, string>();
    const sourceIndexes = new Map(next.entries.map((entry, index) => [entry.id, index]));
    const ids = unityLanguageScope(next.entries, languageSource).ids;
    const selectedEntries = next.entries.filter(e => (onlyIds ? onlyIds.has(e.id) : e.selected && ids.has(e.id)) && (!layoutOnly || !!e.layoutDraft));
    const helperCache = new Map<string, string>();
    const segmenter = new UnitySegmentation();
    const sentenceCache = new Map<string, number[]>();
    const helperOptions = mergeLines && breakMode === "model" && selectedEntries.some(e => /[\r\n]/.test(e.source) && (layoutOnly || e.error || !e.translation || unityTranslationError(e.source, e.translation)))
      ? { ...buildUnityTranslateOptions(await api.getSettings(), "llm", "auto", options.target || "zh-CN", helperModel), prompt: UNITY_LINE_MODEL_PROMPT, autoChunk: false } : null;
    setDirty(true);
    const format = async (original: string, translated: string) => {
      if (!/[\r\n]/.test(original)) return translated;
      if (breakMode === "ratio") return formatUnityStructure(original, translated, restoreUnityTranslationLines);
      if (breakMode === "wtp") {
        const texts = new Set<string>();
        planUnityStructuredLines(original, translated, (s, t) => { const plan = planUnityLines(s, t); if (plan.slots.length > 1) texts.add(flattenUnityLines(t)); return plan; });
        for (const text of texts) if (!sentenceCache.has(text)) sentenceCache.set(text, await segmenter.sentenceEnds(text, controller.signal));
        return applyUnityLineBreaks(planUnityStructuredLines(original, translated, (s, t) => planUnityLines(s, t, undefined, sentenceCache.get(flattenUnityLines(t)))));
      }
      if (breakMode !== "model") return formatUnityStructure(original, translated, smartUnityLines);
      const plan = planUnityStructuredLines(original, translated, planUnityLines);
      if (!plan.breaks.length) return smartUnityLines(original, translated);
      const key = JSON.stringify([original.replace(/\r\n?/g, "\n"), plan.units]);
      let response = helperCache.get(key);
      if (!response) {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
        try {
          const result = await api.translate(unityLineModelInput(original, plan), { signal }, helperOptions!);
          if (!result.ok) throw new Error(result.code || "断行辅助请求失败");
          response = result.translation;
        } catch (error) {
          if (!controller.signal.aborted && signal.reason?.name === "TimeoutError") throw new Error("断行辅助模型超过 120 秒未响应，译文草稿已保存");
          throw error;
        }
      }
      const formatted = parseUnityLineModel(plan, response); helperCache.set(key, response); return formatted;
    };
    let formatQueue = Promise.resolve();
    const queuedFormat = (original: string, translated: string) => {
      const work = formatQueue.then(() => { controller.signal.throwIfAborted(); return format(original, translated); });
      formatQueue = work.then(() => {}, () => {});
      return work;
    };
    const requestTranslation = async (text: string, provider = options.provider, entry?: UnityEntry) => {
      const { engineIds: _engines, ...requestOptions } = options;
      const index = entry ? sourceIndexes.get(entry.id) ?? 0 : 0;
      const context = entry && provider === "llm" ? [
        { source: `资源：${entry.file} / ${entry.container}；类型：${entry.kind}；字段：${entry.locator}`, translation: "" },
        ...next.entries.slice(Math.max(0, index - 2), index).filter(previous => previous.file === entry.file && previous.container === entry.container && previous.locale === entry.locale).map(previous => ({ source: previous.source, translation: previous.translation })),
      ] : undefined;
      const request = async (block: string) => {
        const seconds = provider === "llm" ? 120 : 30;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(seconds * 1000)]);
        try { const response = await api.translate(prepareUnityTranslationRequest(block, mergeLines), { signal }, { ...requestOptions, provider, context, autoFallback: provider === "llm" ? undefined : false }); if (!response.ok) throw new Error(response.code || "翻译请求失败"); return response.translation; }
        catch (error) { if (!controller.signal.aborted && signal.reason?.name === "TimeoutError") throw new Error(`翻译请求超过 ${seconds} 秒未响应`); throw error; }
      };
      const translate = (block: string) => provider === "llm" ? request(block) : translateUnityRichText(block, request);
      return mergeLines ? translateUnityStructuredText(text, translate) : translate(text);
    };
    const measure = (text: string) => [...prepareUnityTranslationRequest(text, mergeLines)].length;
    const engineTargetCharacters = !layoutOnly && options.provider !== "llm" ? unityTranslationCharacters(selectedEntries, next.entries, unityTranslationError, text => prepareUnityTranslationRequest(text, mergeLines), mergeLines ? canReuseUnityStructuredDraft : undefined, unityTranslationContextKey).pendingCharacters : 0;
    let engineStats: NonNullable<UnityProgress["engineStats"]> = checkpointRef.current?.translationRuns?.text.engineStats || (!checkpointRef.current?.imageOnly && checkpointRef.current?.progress.step === 2 ? checkpointRef.current.progress.engineStats : undefined) || [];
    const initialStats = engineStats;
    let translationProgress: UnityProgress | undefined;
    const reportTranslation = (progress: UnityProgress) => {
      translationProgress = progress;
      onProgress?.(engineStats.length ? { ...progress, engineStats, engineTargetCharacters } : progress);
    };
    const pool = !layoutOnly && options.provider !== "llm" ? createUnityEnginePool((options.engineIds || [options.provider as TranslateProvider]).map(id => ({ id, enabled: true })), controller.signal, async (id, text) => {
      const translated = await requestTranslation(text, id);
      const problem = unityTranslationError(text, translated); if (problem) throw new Error(problem);
      return translated;
    }, { initialStats, measure, onStats: value => { engineStats = value; if (translationProgress) onProgress?.({ ...translationProgress, engineStats, engineTargetCharacters }); } }) : null;
    try {
      if (layoutOnly) {
        const total = next.entries.filter(e => e.selected && ids.has(e.id) && /[\r\n]/.test(e.source) && (e.layoutDraft || e.translation && !unityTranslationError(e.source, e.translation))).length;
        let completed = total - selectedEntries.length, failures = 0;
        onProgress?.({ detail: "仅重新断行，未请求重新翻译", completed, total });
        for (const entry of selectedEntries) {
          if (controller.signal.aborted) break;
          try {
            const body = await format(entry.source.trim(), entry.layoutDraft!.trim());
            if (controller.signal.aborted) break;
            const value = (entry.source.match(/^[\t \u3000]*/)?.[0] || "") + body;
            const problem = unityTranslationError(entry.source, value); if (problem) throw new Error(problem);
            entry.translation = value; entry.error = ""; delete entry.layoutDraft; completed++;
          } catch (error) {
            if (controller.signal.aborted) throw error;
            entry.error = `译文排版失败：${error instanceof Error ? error.message : String(error)}`;
            failures++;
          }
          await saveTranslation({ ...next, entries: [...next.entries] }, "text");
          onProgress?.({ detail: `仅重新断行，未请求重新翻译${failures ? ` · ${failures} 条失败已记录，继续处理` : ""}`, completed: completed + failures, total });
        }
        return next;
      }
      await translateUnitySession(selectedEntries, cache, {
        references: next.entries,
        key: unityTranslationContextKey,
        signal: controller.signal, validate: unityTranslationError, progress: reportTranslation,
        onQueue: queue => { translationQueue.current = queue; },
        concurrency: pool?.concurrency || 1,
        canReuseDraft: mergeLines ? canReuseUnityStructuredDraft : undefined,
        format: mergeLines ? queuedFormat : undefined, retainDraft: mergeLines, persistDraftBeforeFormat: breakMode === "model" || breakMode === "wtp",
        translate: pool ? (text, entry) => pool.translate(text, entry?.id) : (text, entry) => requestTranslation(text, options.provider, entry),
        persist: async () => { await saveTranslation({ ...next, entries: [...next.entries] }, "text"); },
      });
    } finally {
      pool?.dispose();
      segmenter.dispose();
      const final = { ...next, entries: [...next.entries] };
      await saveTranslation(final, "text");
      setMessage(controller.signal.aborted ? "已停止，已保存译文和排版草稿" : layoutOnly ? "断行处理已保存，未重新翻译；检查排版后可生成补丁" : "本轮翻译已结束，可检查译文后生成补丁");
    }
    return next;
  }
  const imageBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("图片读取失败")); reader.readAsDataURL(blob);
  });
  const imageRequest = (p: UnityProject, image: UnityImage) => ({ root: p.root, folder: p.folder, images: [image] });
  async function writeImage(p: UnityProject, image: UnityImage, blob: Blob) {
    return unityRun<{ path: string; hash: string }>("save-image", { project: imageRequest(p, image), imageId: image.id, imageData: await imageBase64(blob) });
  }
  async function translateImages(p: UnityProject, controller: AbortController, run: RunCheckpoint, onProgress: (value: UnityProgress) => void) {
    if ((p.scanRevision || 0) < 5) throw new Error("当前工程尚未扫描图片，请更新扫描，或跳过步骤 2.2");
    if (!(p.images || []).some(image => image.selected && !image.completed)) { onProgress({ completed: 0, total: 0, detail: "图片已完成或没有选中的图片" }); return p; }
    const options = await translationOptions(run, true), ocr = createUnityImageOcr(run.imageOcrMode || "fast");
    const primaryProvider = options.provider; if (!primaryProvider) throw new Error("未选择图片翻译引擎");
    const request = async (provider: string, text: string) => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(provider === "llm" ? 120000 : 30000)]);
      const response = await api.translate(text, { signal }, { ...options, provider });
      if (!response.ok) throw new Error(response.code || "图片文字翻译失败"); return response.translation;
    };
    const pool = options.provider !== "llm" && options.engineIds?.length ? createUnityEnginePool(options.engineIds.map(id => ({ id, enabled: true })), controller.signal, request) : null;
    let current = p;
    const cancelOcr = () => { void ocr.dispose(); }; controller.signal.addEventListener("abort", cancelOcr, { once: true });
    try {
      current = await processUnityImages(p, controller.signal, {
        read: async image => new Blob([await readFileBytes(p.folder + "/" + image.sourceFile)], { type: "image/png" }),
        recognize: ocr.recognize, translate: text => pool ? pool.translate(text) : request(primaryProvider, text), render: renderUnityImage,
        write: writeImage,
        persist: async (next, image) => { current = next; publishTranslation({ ...next, images: [...(next.images || [])] }, "images"); const snapshot = structuredClone(image); await queueProjectWrite(() => unityRun("save-image", { project: imageRequest(next, snapshot), imageId: snapshot.id })); },
        validate: unityTranslationError,
      }, onProgress, run.imageConfidenceThreshold ?? 50);
      return current;
    } finally { pool?.dispose(); controller.signal.removeEventListener("abort", cancelOcr); await ocr.dispose(); await saveTranslation(current, "images"); }
  }
  const editImage = (image: UnityImage) => {
    const p = latest.current; if (!p) return;
    const next = { ...p, imagesSkipped: false, images: (p.images || []).map(item => item.id === image.id ? image : item) };
    publish(next); setDirty(true); invalidatePatch();
  };
  const updateImagePreview = (image: UnityImage, imported = false) => operation(imported ? "替换译图" : "生成译图", async () => {
    if (!project) return;
    let blob: Blob;
    if (imported) { const selected = await open({ filters: [{ name: "PNG 译图", extensions: ["png"] }] }); if (typeof selected !== "string") return; blob = new Blob([await readFileBytes(selected)], { type: "image/png" }); }
    else blob = await renderUnityImage(new Blob([await readFileBytes(project.folder + "/" + image.sourceFile)], { type: "image/png" }), unityImageTranslationRegions(image.regions, imageConfidenceThreshold));
    const result = await writeImage(project, image, blob);
    const next = { ...project, imagesSkipped: false, images: (project.images || []).map(item => item.id === image.id ? { ...image, completed: true, error: "", renderedFile: result.path, renderedHash: result.hash } : item) };
    publish(next); await save(next); invalidatePatch();
  });
  async function skipTranslationPart(images = imagePart) {
    if (!project || restoring || busy && !translationJobs.current) return;
    if (!await confirm(images ? "跳过尚未完成的图片？已完成的译图保留，其余图片保持原样。" : "跳过尚未完成的文本？已有有效译文保留，其余文本保持原文。", { title: images ? "跳过 2.2" : "跳过 2.1", okLabel: "跳过剩余", cancelLabel: "取消" })) return;
    const jobs = translationJobs.current;
    if (jobs) {
      const p = latest.current!; publish({ ...p, ...(images ? { imagesSkipped: true } : { textSkipped: true }) });
      const saved = save(); await Promise.all([saved, jobs.skip(images ? "images" : "text")]); return;
    }
    await operation("保存跳过选择", async () => {
      const next = { ...project, ...(images ? { imagesSkipped: true } : { textSkipped: true }) }; publish(next); await save(next);
      const task = checkpointRef.current || projectCheckpoint(next);
      remember({ ...task, step: 2, endStep: 2, imageOnly: images, automatic: false, finished: true, partial: !!next.textSkipped, progress: { step: 2, state: "done", completed: 0, total: 0, detail: images ? "已跳过剩余图片，未完成图片保持原样" : "已跳过剩余文本，未完成文本保持原文" } });
      await taskWrites.current; setActiveStep(images ? 3 : 2); setImagePart(!images);
    });
  }
  async function exportPatch(p: UnityProject, onProgress?: (value: UnityProgress) => void, signal?: AbortSignal, run?: RunCheckpoint) {
    setBusy("生成补丁");
    const ids = unityLanguageScope(p.entries, run?.source || source).ids;
    const selectedIds = run?.partial || p.textSkipped ? p.entries.filter(e => e.selected && ids.has(e.id) && !e.error && e.translation && !unityTranslationError(e.source, e.translation)).map(e => e.id) : [...ids];
    const fontSourceIds = run?.partial || p.textSkipped ? p.entries.filter(e => e.selected && ids.has(e.id)).map(e => e.id) : undefined;
    const result = await unityRun<UnityPatch>("export", { project: p, selectedIds, fontPath: run?.fontPath ?? fontPath, extraCharacters: run?.extraCharacters ?? extraCharacters, fontSourceIds, path: run?.patchFolder || "" }, onProgress, signal);
    setPatch(result); setDirty(false);
    setMessage(`已生成 ${result.files} 个补丁文件，回写 ${result.entries} 条译文、${result.images || 0} 张译图，替换 ${result.fontReplacements} 个 UGUI 字体；尚未验证游戏显示。`);
    return result;
  }
  async function applyPatch(result: UnityPatch, onProgress?: (value: UnityProgress) => void, signal?: AbortSignal) {
    setBusy("应用到游戏");
    await unityRun("apply", { root, path: result.folder }, onProgress, signal);
    setApplied(true); onInstallationChange?.(root, true);
    setMessage(`已将 ${result.files} 个补丁文件应用到游戏。原件保存在补丁目录的 original 文件夹，实际显示请启动游戏检查。`);
  }
  async function startWorkflow(startStep: number, endStep: number, resume = false, automatic = startStep < endStep, updateScan = false, part?: UnityTranslationPart) {
    if (busy || restoring || running.current) return;
    const changedScanOptions = resume && checkpointRef.current?.step === 1
      ? unityScanOptionChanges(checkpointRef.current, { includeCode, textMode, typeDirectory, codeAssemblies }) : [];
    const rescan = (needsScan || updateScan || preparingRescan || changedScanOptions.length > 0) && (resume ? checkpointRef.current?.step ?? startStep : startStep) <= 2;
    if (rescan && !await confirm(`重新扫描将保留旧工程，复用原文、原图及定位匹配的译文、图片识别结果和译图；仅补丁与字库检查会失效，如已应用补丁则先恢复游戏原件。新工程及复用结果保存完成后再清理旧工程。${scanUpdate.reasons.length ? "\n" + scanUpdate.reasons.join("\n") : ""}${endStep >= 2 ? "扫描完成后再继续翻译。" : ""}`, { title: needsScan ? "需要重新扫描" : "可选更新扫描", kind: "warning", okLabel: "重新扫描并继续", cancelLabel: "取消" })) return;
    setPreparingRescan(false);
    await operation("准备任务", () => runWorkflow(startStep, endStep, resume, automatic, rescan, part), true);
  }
  async function runWorkflow(startStep: number, endStep: number, resume = false, automatic = startStep < endStep, rescan = false, part?: UnityTranslationPart) {
    const controller = new AbortController(); abort.current = controller;
    let run: RunCheckpoint = resume && checkpointRef.current ? { ...checkpointRef.current, endStep } : {
      step: startStep, endStep, automatic, finished: false, imageOnly: startStep === 2 && (part ? part === "images" : automatic ? textReady : imagePart), imageOcrMode, imageConfidenceThreshold,
      projectFolder: startStep === 1 && endStep === 1 ? "" : project?.folder || "", scanFolder: "", patchFolder: "", patch: startStep === 4 ? patch : null,
      previousProjectFolder: startStep === 1 && endStep === 1 ? checkpointRef.current?.previousProjectFolder || project?.folder : undefined,
      translationKind, llmModel, engine, engines: engineChoices, source, target, joinLines, lineMode, lineModel, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters, scopeVersion: 1,
      partial: !!project?.textSkipped || startStep >= 3 && !!checkpointRef.current?.partial,
      translationRuns: checkpointRef.current?.translationRuns,
      progress: { step: startStep, state: "running", detail: "准备处理", completed: 0, total: null },
    };
    if (automatic) run.automatic = true;
    if (resume && run.step === 1) run.source = source;
    if (part) run.imageOnly = part === "images";
    if (rescan) {
      run = { ...run, step: 1, imageOnly: false, projectFolder: "", scanFolder: "", previousProjectFolder: checkpointRef.current?.previousProjectFolder || project?.folder || checkpointRef.current?.projectFolder || checkpointRef.current?.scanFolder, source, includeCode, textMode, codeAssemblies, typeDirectory,
        translationFailure: run.progress.step === 2 && run.progress.state === "error" ? run.progress.failure : run.translationFailure,
        progress: { step: 1, state: "running", detail: "重新提取游戏组件文本，已有工程和译文保留", completed: 0, total: null } };
    }
    let lastReported = 0;
    const report = (progress: UnityProgress) => {
      const urgent = run.progress.step !== run.step || !!progress.folder && progress.folder !== (run.step === 1 ? run.scanFolder : run.patchFolder) || progress.total !== null && progress.completed === progress.total;
      if (progress.total === null && run.progress.step === run.step && run.progress.total !== null)
        progress = { ...progress, completed: run.progress.completed, total: run.progress.total };
      if (progress.folder) {
        if (run.step === 1) run.scanFolder = progress.folder;
        if (run.step === 3) run.patchFolder = progress.folder;
      }
      run = { ...run, progress: { ...progress, step: run.step, state: "running" } };
      checkpointRef.current = run;
      if (urgent || performance.now() - lastReported >= 100) { remember(run); lastReported = performance.now(); }
    };
    try {
      followProgress.current = true;
      if (rescan && project) {
        if (dirty) await save();
        await taskWrites.current;
        await unityRun("reset-step", { root, step: 3, path: project.folder, task: { ...(checkpointRef.current || projectCheckpoint(project)), previousProjectFolder: undefined } });
        setPatch(null); setApplied(false); onInstallationChange?.(root, false); setFontPlan(null);
        run.patch = null; run.patchFolder = "";
      }
      remember(run);
      let p = project;
      for (let index = run.step; index <= endStep; index++) {
        if (followProgress.current) { setActiveStep(index); if (index === 2) setImagePart(!!run.imageOnly); }
        run.step = index; setBusy(GENERATION_STEPS[index - 1]);
        if (index === 2) delete run.translationFailure;
        const onProgress = (progress: UnityProgress) => { if (run.step === index && !run.finished) report(progress); };
        report({ detail: `准备${GENERATION_STEPS[index - 1]}`, completed: 0, total: null });
        await taskWrites.current;
        if (controller.signal.aborted) throw new UnityPaused("");
        if (index === 1) {
          const reuse = run.projectFolder && !run.scanFolder && p;
          p = reuse || await scan(onProgress, controller.signal, run);
          const previousFolder = run.previousProjectFolder;
          run.projectFolder = p.folder; run.scanFolder = "";
          if (previousFolder && !sameUnityGamePath(previousFolder, p.folder)) {
            remember(run); await taskWrites.current;
            const reused = await unityRun<{ project: UnityProject; reusedText: number; reusedImages: number }>("finish-rescan", { root, path: previousFolder, task: { ...run, previousProjectFolder: undefined } });
            p = reused.project; publish(p); setMessage(`扫描完成：复用 ${reused.reusedText} 条译文和 ${reused.reusedImages} 张图片的处理结果`);
          }
          run.previousProjectFolder = undefined;
          if (reuse) report({ detail: `复用当前工程：${p.entries.length} 条文本，保留选取和已有译文`, completed: 1, total: 1 });
        } else if (index === 2) {
          if (!p) throw new Error("请先扫描当前游戏资源");
          await yieldUnityPreparation(controller.signal);
          const preparationScope = unityLanguageScope(p.entries, run.source);
          const rows = p.entries.filter(entry => entry.selected && preparationScope.ids.has(entry.id));
          const textComplete = !run.layoutOnly && (!!p.textSkipped || !p.entries.length || rows.length > 0 && rows.every(entry => entry.translation && !entry.error && !unityTranslationError(entry.source, entry.translation)));
          const imageComplete = unityImagesReady(p);
          const initial = { text: p.textSkipped && !run.layoutOnly ? "skipped" : textComplete ? "done" : "pending", images: p.imagesSkipped ? "skipped" : imageComplete ? "done" : "pending" } as const;
          const oldParts = run.translationRuns;
          const requestedPart = part || (run.imageOnly ? "images" : "text");
          run = { ...run, translationRuns: {
            text: !automatic && requestedPart !== "text" && oldParts?.text ? oldParts.text : { ...(oldParts?.text || run.progress), step: 2, state: initial.text, detail: textComplete ? "文本结果已保留" : "等待开始翻译文本" },
            images: !automatic && requestedPart !== "images" && oldParts?.images ? oldParts.images : { ...(oldParts?.images || { completed: 0, total: null }), step: 2, state: initial.images, detail: imageComplete ? "图片结果已保留" : "等待开始图片识别与翻译" },
          }, progress: { step: 2, state: "running", completed: 0, total: null, detail: "文本和图片任务分别处理并保存" } };
          const partReported = { text: 0, images: 0 };
          const reportPart = (part: UnityTranslationPart, value: UnityProgress) => {
            run = { ...run, translationRuns: { ...run.translationRuns!, [part]: { ...run.translationRuns![part], ...value, step: 2, state: "running" } } };
            checkpointRef.current = run;
            if (value.total !== null && value.completed === value.total || performance.now() - partReported[part] >= 100) { remember(run); partReported[part] = performance.now(); }
          };
          const jobs = createUnityTranslationJobs({
            signal: controller.signal, initial,
            changed: (part, state, failure) => {
              const previous = run.translationRuns![part];
              run = { ...run, translationRuns: { ...run.translationRuns!, [part]: { ...previous, state, failure, detail: state === "stopped" ? "已中止，进度已保存" : state === "skipped" ? "已跳过剩余内容，已完成结果保留" : previous.detail } } }; remember(run);
            },
            run: async (part, job) => {
              const current = latest.current || p!;
              if (part === "images") {
                run.imageOcrMode = imageMode.current;
                run.imageConfidenceThreshold = imageThreshold.current;
                await translateImages(current, job, run, value => reportPart(part, value)); return;
              }
              const selectedIds = unityLanguageScope(current.entries, run.source).ids;
              if (current.entries.length && !current.entries.some(entry => entry.selected && selectedIds.has(entry.id))) throw new Error("当前原文语言范围内没有所选文本，请调整语言或选取文本");
              if (current.entries.length) await translateProject(current, job, run.layoutOnly ? { provider: "llm", source: run.source, target: run.target } : await translationOptions(run), value => reportPart(part, value), run.source, run.joinLines ?? true, run.lineMode || "local", run.lineModel || "", !!run.layoutOnly);
              const final = latest.current || current;
              const failed = final.entries.filter(entry => entry.selected && selectedIds.has(entry.id) && (!run.layoutOnly || !!entry.layoutDraft) && (entry.error || unityTranslationError(entry.source, entry.translation)));
              if (failed.length) throw new Error(`${failed.length} 条文本翻译或排版未完成，已有译文和草稿已保存`);
            },
          });
          translationJobs.current = jobs; remember(run);
          try { await jobs.wait(automatic && !run.layoutOnly ? ["text", "images"] : [part || (run.imageOnly ? "images" : "text")]); }
          finally { translationJobs.current = null; await projectWrites.current; }
          p = latest.current || p;
        } else if (index === 3) {
          if (!p) throw new Error("请先扫描当前游戏资源");
          const result = await exportPatch(p, onProgress, controller.signal, run);
          run.patch = result; run.patchFolder = result.folder;
        } else {
          if (!run.patch) throw new Error("请先生成补丁");
          await applyPatch(run.patch, onProgress, controller.signal);
        }
        if (controller.signal.aborted) throw new UnityPaused("");
        if (index === 2 && !run.imageOnly && !run.layoutOnly && !automatic && !unityImagesReady(p)) { setActiveStep(2); setImagePart(true); }
        else setActiveStep(run.layoutOnly ? 2 : Math.min(index + 1, GENERATION_STEPS.length));
        if (index < endStep) { run.step = index + 1; run.progress = { step: index + 1, state: "running", detail: "等待开始下一步", completed: 0, total: null }; remember(run); }
      }
      run.finished = true; run.progress = { ...run.progress, state: "done" }; remember(run);
    } catch (e) {
      const paused = e instanceof UnityPaused ? e : e instanceof UnityTranslationStopped ? new UnityPaused("") : null;
      if (paused || controller.signal.aborted) {
        if (paused?.folder) {
          if (run.step === 1) { run.scanFolder = paused.folder; run.projectFolder = paused.folder; }
          if (run.step === 3) run.patchFolder = paused.folder;
        }
        run.progress = { ...run.progress, state: "stopped", detail: "处理已中止，检查点已保存" }; remember(run);
        if (run.step === 1 && run.scanFolder) publish(await loadProject(run.scanFolder, run.previousProjectFolder));
        setMessage(run.step === 4 ? "应用已中止，部分文件可能已写入。请勿启动游戏，恢复后继续应用。原件备份已保留。" : "任务已中止，检查点已保存，点击恢复继续未完成部分。");
      } else { run.progress = { ...run.progress, state: "error", failure: e instanceof Error ? e.message : String(e) }; remember(run); throw e; }
    } finally { abort.current = null; await taskWrites.current; }
  }
  const startTranslationPart = (part: UnityTranslationPart) => {
    const jobs = translationJobs.current;
    if (jobs) { jobs.start(part); return; }
    void startWorkflow(2, checkpoint?.automatic && !checkpoint.finished ? checkpoint.endStep : 2, !!checkpoint && !checkpoint.finished, !!checkpoint?.automatic && !checkpoint.finished, false, part);
  };
  const stop = () => {
    abort.current?.abort();
    setMessage("正在中止，完成当前文件的安全写入并保存检查点后停止，请勿退出或启动游戏。");
  };
  const progressPercent = generation?.total ? Math.floor(generation.completed / generation.total * 100) : generation?.state === "done" && generation.total === 0 ? 100 : null;
  const progressIsImage = generation?.step === 2 && (activeStep === 2 && checkpoint?.translationRuns ? imagePart : !!checkpoint?.imageOnly);
  const progressUnit = generation?.step === 2 ? progressIsImage ? "张图片" : checkpoint?.layoutOnly ? "处文本" : generation.translation ? "种原文（已检查）" : "种原文（已有译文）" : "个文件";
  const resumable = !preparingRescan && !!checkpoint && !checkpoint.finished;
  const pausedScan = checkpoint?.step === 1 && !checkpoint.finished && (checkpoint.progress.state === "stopped" || checkpoint.progress.state === "error");
  const scanOptionsChanged = !!pausedScan && unityScanOptionChanges(checkpoint!, { includeCode, textMode, typeDirectory, codeAssemblies }).length > 0;
  const locked = !!busy || restoring || resumable;
  const entriesLocked = !!busy || restoring || resumable && (checkpoint.step !== 2 || !!checkpoint.imageOnly);
  const resumeTask = () => checkpoint && void startWorkflow(checkpoint.step, checkpoint.endStep, true, checkpoint.automatic);
  async function skipRemaining() { await skipTranslationPart(!!checkpoint?.imageOnly); }

  const currentPart: UnityTranslationPart = imagePart ? "images" : "text";
  const selectedJob = checkpoint?.translationRuns?.[currentPart];
  const taskAction = translationJobs.current ? <>
    {selectedJob?.state === "running" && <button className="unity-btn" disabled={translationJobs.current.isStopping(currentPart)} onClick={() => { translationJobs.current?.stop(currentPart); setMessage("正在中止当前任务，另一任务继续处理"); }}>中止 {imagePart ? "2.2" : "2.1"}</button>}
    {Object.values(checkpoint?.translationRuns || {}).filter(part => part.state === "running").length > 1 && <button className="unity-btn" onClick={stop}>中止全部</button>}
  </> : <>{busy && abort.current ? <button className="unity-btn" onClick={stop} disabled={abort.current.signal.aborted}>中止</button> : !busy && resumable && <button className="unity-btn" onClick={resumeTask} disabled={restoring}>{needsScan || scanOptionsChanged ? "重新扫描并继续" : checkpoint.layoutOnly ? "恢复断行" : `${generation?.state === "error" && progressPercent === null ? "重试" : "恢复"}${checkpoint.automatic ? "一键流程" : checkpoint.imageOnly ? "图片识别与翻译" : GENERATION_STEPS[checkpoint.step - 1]}`}</button>}{!busy && resumable && checkpoint.step === 2 && <button className="unity-btn" disabled={restoring || needsScan} title={needsScan ? "需要先重新扫描" : "保留已完成结果，未处理内容保持原样"} onClick={() => void skipRemaining()}>{checkpoint?.imageOnly ? "跳过剩余图片" : "跳过剩余文本"}</button>}</>;
  const failureMessage = generation?.state === "error" ? generation.failure || error : error;
  const failure = failureMessage ? explainUnityFailure(failureMessage) : null;
  const currentRowIssue = rowIssue && project?.entries.find(entry => entry.id === rowIssue.id);
  const rowFailure = rowIssue ? explainUnityFailure(currentRowIssue?.error || currentRowIssue && unityTranslationError(currentRowIssue.source, currentRowIssue.translation) || rowIssue.error) : null;
  const rowQueueStatus = rowIssue ? translationQueue.current?.status(rowIssue.id) : undefined;
  const rowRetryQueued = rowQueueStatus === "pending" || rowQueueStatus === "active" || !!rowIssue && busy === `重试条目 #${rowIssue.id}`;
  useEffect(() => {
    if (currentRowIssue && !currentRowIssue.error && currentRowIssue.translation && !unityTranslationError(currentRowIssue.source, currentRowIssue.translation)) setRowIssue(null);
  }, [project, rowIssue?.id]);
  const errorPanel = failure && <div className="unity-failure" role="alert">
    <strong>失败原因</strong><p>{failure.reason}</p><p>处理方法：{failure.action}</p>
    {failure.technical && <details><summary>技术详情</summary><pre>{failure.technical}</pre></details>}
  </div>;
  const progressRunning = !!busy && generation?.state === "running";
  useEffect(() => {
    if (progressRunning && followProgress.current)
      workflowRef.current?.querySelector<HTMLElement>('[aria-label="任务状态"]')?.scrollIntoView({ block: "nearest" });
  }, [progressRunning, generation?.step, activeStep]);
  const scanWarnings = [...(project?.warnings || []), ...restoreNotices];
  const warningDetails = scanWarnings.map(explainUnityWarning);
  const streamWarnings = warningDetails.filter(w => w.category === "stream");
  const scanReady = !preparingRescan && !!project && !needsScan && (checkpoint?.step !== 1 || checkpoint.progress.state === "done");
  const retryTranslationEntry = async (id: string) => {
    const queue = translationQueue.current;
    if (queue) {
      if (queue.retry(id)) { setMessage(`条目 #${id} 已重新加入翻译队列`); setRowIssue(previous => previous ? { ...previous } : null); }
      return;
    }
    if (busy || restoring || !scanReady || applied || patch || !connectionReady) return;
    const p = latest.current, item = p?.entries.find(entry => entry.id === id);
    if (!p || !item || !item.error && item.translation && !unityTranslationError(item.source, item.translation)) return;
    await operation(`重试条目 #${id}`, async () => {
      const controller = new AbortController(); abort.current = controller;
      const previous = checkpointRef.current;
      const task = { ...(previous || projectCheckpoint(p)), step: 2, endStep: 2, automatic: false, finished: false, layoutOnly: false, imageOnly: false, patch: null, patchFolder: "" };
      const rememberTextRetry = (value: RunCheckpoint) => remember({ ...value, translationRuns: value.translationRuns ? { ...value.translationRuns, text: value.progress } : undefined });
      let lastProgress: UnityProgress = { detail: `正在重试条目 #${id}`, completed: 0, total: null };
      const report = (progress: UnityProgress) => {
        const current = latest.current || p;
        const stats = unityTranslationStats(current.entries.filter(entry => entry.selected && scope.ids.has(entry.id)), unityTranslationError, unityTranslationContextKey);
        lastProgress = { ...progress, ...stats, completed: Math.min(stats.total, Math.max(stats.completed, previous?.step === 2 ? previous.progress.completed : 0)), translation: progress.translation && { ...progress.translation, successful: stats.completed } };
        rememberTextRetry({ ...task, progress: { ...lastProgress, step: 2, state: "running" } });
      };
      try {
        const next = await translateProject(p, controller, await translationOptions(), report, source, joinLines, lineMode, lineModel, false, new Set([id]));
          controller.signal.throwIfAborted();
        const retried = next.entries.find(entry => entry.id === id)!;
        const problem = retried.error || unityTranslationError(retried.source, retried.translation);
        const remaining = next.entries.filter(entry => entry.selected && scope.ids.has(entry.id) && (entry.error || unityTranslationError(entry.source, entry.translation))).length;
        const detail = problem ? `条目 #${id} 重试失败：${problem}` : `条目 #${id} 重试成功${remaining ? `，另有 ${remaining} 条未完成` : ""}`;
        rememberTextRetry({ ...task, finished: !problem && !remaining, progress: { ...lastProgress, step: 2, state: problem ? "error" : remaining ? "stopped" : "done", failure: problem || undefined, detail } });
        if (problem) setError(detail); else { setRowIssue(null); setMessage(detail); }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        const detail = `已中止条目 #${id} 的重试，已有译文和草稿保留`;
        rememberTextRetry({ ...task, progress: { ...lastProgress, step: 2, state: "stopped", detail } }); setMessage(detail);
      } finally { abort.current = null; }
    }, true, setActionError);
  };
  const scanStarted = !!project || !!(checkpoint?.projectFolder || checkpoint?.scanFolder) || checkpoint?.step === 1 && !checkpoint.finished;
  useEffect(() => {
    if (!scanReady) { setSearch(""); setPage(0); setJumpPage(""); setRowIssue(null); setRowJump(null); setFailurePage(0); }
  }, [scanReady]);
  const textReady = scanReady && (!!project?.textSkipped || selected.length > 0 && (done === selected.length || !!checkpoint?.partial && done > 0) || project?.entries.length === 0);
  const imagesReady = scanReady && unityImagesReady(project);
  const translationReady = textReady && imagesReady;
  const patchReady = scanReady && (textReady || selected.every(entry => !!entry.error || !!entry.translation && !unityTranslationError(entry.source, entry.translation))) && (imagesReady || (project?.images || []).filter(image => image.selected).every(image => image.completed || !!image.error || image.regions.some(region => !!region.error)));
  const completedThrough = preparingRescan ? 0 : applied ? 4 : patch ? 3 : translationReady ? 2 : scanReady ? 1 : 0;
  const displayedCompletedThrough = preparingRescan ? 0 : Math.max(completedThrough, checkpoint?.step === 2 && !translationReady ? 1 : project && checkpoint && !checkpoint.layoutOnly ? checkpoint.finished && checkpoint.progress.state === "done" ? checkpoint.endStep : checkpoint.step - 1 : 0);
  const executingStep = generation && generation.state !== "done" ? generation.step : completedThrough < 4 ? completedThrough + 1 : undefined;
  const scanParametersLocked = !!busy || restoring || scanStarted && !preparingRescan && !pausedScan;
  const parametersLocked = activeStep === 1 ? scanParametersLocked : locked || applied || activeStep <= completedThrough || activeStep === 2 && (imagePart ? imagesReady : textReady);
  const viewingProgress = !!generation && activeStep === generation.step && (activeStep !== 2 || (!!checkpoint?.translationRuns || imagePart === !!checkpoint?.imageOnly));
  const lineOptionsLocked = !!busy || restoring;
  const updateEngineChoices = (value: UnityEngineChoice[]) => {
    const engines = normalizeUnityEngines(value);
    setEngineChoices(engines);
    const saved = checkpointRef.current;
    if (saved && !saved.finished && saved.step === 2) remember({ ...saved, engines });
  };
  const updateLineOptions = (mode: UnityLineMode, model: string) => {
    setLineMode(mode); setLineModel(model);
    const saved = checkpointRef.current;
    if (saved && !saved.finished && saved.step === 2) remember({ ...saved, lineMode: mode, lineModel: model });
  };
  const invalidatePatch = () => {
    setPatch(null); if (!translationJobs.current) setGeneration(null);
    const saved = checkpointRef.current;
    if (!translationJobs.current && saved?.finished && saved.translationRuns) {
      remember({ ...saved, patch: null, patchFolder: "" }); setGeneration(null); return;
    }
    if (saved?.finished && saved.patch) {
      const value = { ...saved, patch: null, patchFolder: "" };
      remember(value); setGeneration(null);
    }
  };
  const openFolder = async (path: string) => {
    setActionError("");
    try { await api.revealPath(path); }
    catch (e) { setActionError(`打开目录失败：${e instanceof Error ? e.message : String(e)}`); }
  };
  const downloadTranslations = () => operation("下载翻译文件", async () => {
    if (!project || !scanReady) return;
    setFileStatus({ action: "download", state: "working", detail: "请选择下载文件的保存位置…" });
    const path = await saveDialog({
      title: "下载翻译文件", defaultPath: await join(await resourceDir(), "Unity翻译.json"),
      filters: [{ name: "JSON 翻译文件", extensions: ["json"] }, { name: "CSV 翻译表格", extensions: ["csv"] }],
    });
    if (!path) { setFileStatus({ action: "download", state: "cancelled", detail: "已取消下载" }); return; }
    setFileStatus({ action: "download", state: "working", path, detail: `正在生成并保存 ${project.entries.length} 条原文与译文…` });
    const contents = new TextEncoder().encode(exportUnityTranslations(project.entries, /\.csv$/i.test(path)));
    await invoke("write_file_bytes", { path, contents: Array.from(contents) });
    setFileStatus({ action: "download", state: "done", path, folder: await dirname(path), detail: `下载完成：${project.entries.length} 条 · ${(contents.byteLength / 1024).toFixed(1)} KiB` });
    setMessage(`已导出 ${project.entries.length} 条原文与译文：${path}`);
  }, true, detail => setFileStatus(previous => ({ ...previous, action: "download", state: "error", detail: `下载失败：${detail}` })));
  const uploadTranslations = () => operation("导入翻译文件", async () => {
    if (!project || !scanReady) return;
    setFileStatus({ action: "import", state: "working", detail: "请选择需要校验的翻译文件…" });
    const path = await open({ title: "导入翻译文件", multiple: false, filters: [{ name: "翻译文件", extensions: ["json", "csv"] }] });
    if (typeof path !== "string") { setFileStatus({ action: "import", state: "cancelled", detail: "已取消导入，工程未覆盖" }); return; }
    setFileStatus({ action: "import", state: "working", path, detail: "正在读取文件并校验格式、条目标识、原文和占位符…" });
    const result = importUnityTranslations(project.entries, new TextDecoder("utf-8", { fatal: true }).decode(await readFileBytes(path)), /\.csv$/i.test(path), unityTranslationError);
    const summary = `校验通过：匹配 ${result.matched} 条，修改 ${result.changed} 条（其中清空 ${result.cleared} 条），${result.unchanged} 条译文不变，保留 ${result.remaining} 条未提供条目。`;
    setFileStatus({ action: "import", state: "checked", path, detail: summary });
    if (!result.changed) {
      setFileStatus({ action: "import", state: "done", path, folder: await dirname(path), detail: `${summary}无需覆盖。` });
      setMessage(`已匹配 ${result.matched} 条，译文没有变化。`); return;
    }
    if (!await confirm(`${summary}\n\n全部检查通过，确认后才会覆盖对应译文。${applied ? "请先关闭游戏；已应用的补丁会先恢复原件。" : ""}${patch || applied ? "现有补丁将清理，之后需重新生成。" : ""}`, { title: "翻译文件校验通过", okLabel: "确认覆盖", cancelLabel: "取消" })) {
      setFileStatus({ action: "import", state: "cancelled", path, detail: `${summary}已取消覆盖，工程未修改。` }); return;
    }
    setFileStatus({ action: "import", state: "working", path, detail: `正在导入并保存 ${result.changed} 条译文…` });
    if (dirty) await save();
    await taskWrites.current;
    if (patch || applied) {
      const reset = await unityRun<{ workspace: UnityWorkspace<RunCheckpoint> }>("reset-step", { root, step: 3, path: project.folder, task: checkpointRef.current || projectCheckpoint(project) });
      setPatch(null); setFontPlan(null); setApplied(reset.workspace.installed); onInstallationChange?.(root, reset.workspace.installed);
      if (reset.workspace.installed) throw new Error("当前游戏仍有其他已应用补丁，请先卸载后再导入译文");
    }
    const next = { ...project, entries: result.entries };
    await unityRun("save", { project: next });
    publish(next); setDirty(false); setPatch(null); setFontPlan(null); setRowIssue(null);
    remember(projectCheckpoint(next)); await taskWrites.current;
    setFileStatus({ action: "import", state: "done", path, folder: await dirname(path), detail: `导入完成：已替换 ${result.changed} 条译文，其中清空 ${result.cleared} 条。` });
    setActiveStep(2); setMessage(`已匹配 ${result.matched} 条，替换 ${result.changed} 条译文。`);
  }, true, detail => setFileStatus(previous => ({ ...previous, action: "import", state: "error", detail: `导入失败：${detail}` })));
  const openTranslationFile = async (path: string) => {
    setActionError("");
    try { await api.openPath(path); } catch (error) { setActionError(`打开文件失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  const checkFontPlan = () => operation("字库检查", async () => {
    if (!project) return;
    const controller = new AbortController(); abort.current = controller;
    const previousProgress = generation;
    if (checkpointRef.current) { remember({ ...checkpointRef.current, fontPath, extraCharacters }); setGeneration(previousProgress); }
    try {
      await taskWrites.current;
      setFontPlan(await unityRun<UnityFontPlan>("font-plan", { project, selectedIds: selected.map(entry => entry.id), fontPath, extraCharacters }, progress => setMessage(progress.detail), controller.signal));
    } catch (error) { if (error instanceof UnityPaused) setMessage("字库检查已中止，工程与译文保留，可重新检查。"); else throw error; }
    finally { abort.current = null; }
  }, true, setActionError);
  const reflowExisting = async () => {
    if (!project || busy || restoring || !scanReady) return;
    if ((patch || applied) && !await confirm(applied ? "请先关闭游戏。重新断行会先从备份恢复游戏原件，再清理旧补丁，保留扫描和译文；完成后需重新生成并应用补丁。继续？" : "重新断行会清理现有补丁，保留扫描和译文；排版完成后需重新生成补丁。继续？", { title: "重新断行", okLabel: applied ? "恢复原件并继续" : "清理补丁并继续", cancelLabel: "取消" })) return;
    await operation("仅重新断行", async () => {
      if (dirty) await save(); await taskWrites.current;
      if (patch || applied) {
        const reset = await unityRun<{ workspace: UnityWorkspace<RunCheckpoint> }>("reset-step", { root, step: 3, path: project.folder, task: checkpointRef.current || projectCheckpoint(project) });
        setPatch(null); setFontPlan(null); setApplied(reset.workspace.installed); onInstallationChange?.(root, reset.workspace.installed);
        if (reset.workspace.installed) throw new Error("当前游戏仍有其他工程的已应用补丁，请先卸载后再重新断行；译文已保留。");
      }
      const next = structuredClone(latest.current || project);
      for (const entry of next.entries) if (entry.selected && scope.ids.has(entry.id) && /[\r\n]/.test(entry.source) && entry.translation && !unityTranslationError(entry.source, entry.translation)) {
        entry.layoutDraft = entry.translation; entry.error = "";
      }
      await unityRun("save", { project: next }); publish(next);
      remember({ ...projectCheckpoint(next), translationRuns: checkpointRef.current?.translationRuns, step: 2, endStep: 2, automatic: false, finished: false, layoutOnly: true, joinLines: true, lineMode, lineModel, progress: { step: 2, state: "running", detail: "仅重新断行，复用已有译文", completed: 0, total: null } });
      await taskWrites.current; await runWorkflow(2, 2, true);
    });
  };
  const launchGame = () => {
    if (!applied || locked || !root || error) return;
    return operation("启动游戏", async () => {
      const result = await api.unityLaunch(root);
      if (!result.ok) throw new Error(result.error || "启动游戏失败");
      setMessage("已请求启动游戏。");
    }, true, setActionError);
  };
  const uninstallPatch = async () => {
    if (!applied || locked || !await confirm("卸载嵌字翻译补丁并恢复游戏原件？工程、译文、补丁及原件备份会保留。请先关闭游戏。", { title: "卸载补丁", kind: "warning", okLabel: "卸载补丁", cancelLabel: "取消" })) return;
    await operation("卸载补丁", async () => {
      await taskWrites.current;
      const workspace = await unityRun<UnityWorkspace<RunCheckpoint>>("uninstall", { root }, progress => setMessage(progress.detail));
      const p = workspace.saved.project; latest.current = p; setProject(p);
      checkpointRef.current = workspace.task; setCheckpoint(workspace.task); queuedSignature.current = "";
      setPatch(null); setApplied(workspace.installed); onInstallationChange?.(root, workspace.installed);
      setGeneration(null); setDirty(false); setActiveStep(3);
      setMessage("补丁已卸载，游戏原件已恢复；工程、译文和备份已保留。");
    });
  };
  const projectDetails = <section className="unity-offline-footer" aria-label="任务输出">
    {workRoot && <div className="unity-offline-output"><span>工作目录</span><code title={workRoot}>{workRoot}</code><button className="unity-btn" onClick={() => void openFolder(workRoot)}>打开</button></div>}
    <div className="unity-output-heading"><strong>输出</strong>{!preparingRescan && scanWarnings.length + (project?.diagnostics?.length || 0) > 0 && <span>{scanWarnings.length + (project?.diagnostics?.length || 0)} 条提示</span>}{!preparingRescan && patch && <button className="unity-btn" onClick={() => void openFolder(patch.folder)}>补丁目录</button>}</div>
    <div className="unity-offline-log">
      {preparingRescan ? <p role="status">确认上方参数后开始扫描。</p> : <>
      {scanReady && translationFailures.length > 0 && <details className="unity-translation-failures" aria-label="翻译失败条目">
        <summary>翻译 / 排版失败 · {translationFailures.length} 条</summary>
        <ul>{translationFailures.slice(visibleFailurePage * 20, (visibleFailurePage + 1) * 20).map(entry => <li key={entry.id}>
          <button type="button" className="unity-error-locate" aria-label={`定位第 ${entry.id} 条错误`} onClick={() => locateTranslationFailure(entry.id)}>
            第 {entry.id} 条 · {entry.file}{entry.container ? ` / ${entry.container}` : ""} · 对象 {entry.objectId} · 字段 {entry.locator}
          </button>
          <p className="unity-offline-error">{explainUnityFailure(entry.error).reason}</p>
        </li>)}</ul>
        {failurePageCount > 1 && <div className="unity-failure-pagination" aria-label="失败条目翻页">
          <button className="unity-btn" disabled={visibleFailurePage === 0} onClick={() => setFailurePage(visibleFailurePage - 1)}>上一页</button>
          <span>{visibleFailurePage + 1} / {failurePageCount}</span>
          <button className="unity-btn" disabled={visibleFailurePage + 1 >= failurePageCount} onClick={() => setFailurePage(visibleFailurePage + 1)}>下一页</button>
        </div>}
      </details>}
      {fileStatus && <details className={`unity-transfer-output${fileStatus.state === "error" ? " unity-offline-error" : ""}`} aria-label="翻译文件处理结果">
        <summary>{fileStatus.action === "download" ? "翻译文件下载" : "翻译文件导入"} · {fileStatus.state === "working" ? "处理中" : fileStatus.state === "error" ? "失败" : "已完成"}</summary>
        {(fileStatus.state === "working" || fileStatus.state === "done") && <progress aria-label="翻译文件处理进度" max={1} value={fileStatus.state === "done" ? 1 : undefined} />}
        <p role={fileStatus.state === "error" ? "alert" : "status"}>{fileStatus.detail}</p>
        {fileStatus.state === "done" && fileStatus.path && <div className="unity-transfer-links">
          <a href="#" title={fileStatus.path} onClick={event => { event.preventDefault(); void openTranslationFile(fileStatus.path!); }}>文件：{fileStatus.path}</a>
          {fileStatus.folder && <a href="#" title={fileStatus.folder} onClick={event => { event.preventDefault(); void openFolder(fileStatus.folder!); }}>文件夹：{fileStatus.folder}</a>}
        </div>}
      </details>}
      {!error && (!generation || activeStep !== generation.step) && <p role="status">{busy ? generation?.state === "running" ? generation.detail : message || `${busy}…` : message || "等待操作"}</p>}
      {errorPanel}
      {checkpoint?.translationFailure && <p className="unity-offline-error" role="alert">待重试的翻译错误：{explainUnityFailure(checkpoint.translationFailure).reason} 重新扫描完成后将重试翻译。</p>}
      {actionError && <p className="unity-offline-error" role="alert">{actionError}</p>}
      {!!project?.resources?.length && <p className="hint">目标资源：{project.resources.filter(resource => resource.state === "ready").length} 个可读取 · {project.resources.filter(resource => resource.state === "empty").length} 个无正文或字体 · {project.resources.filter(resource => resource.state === "partial").length} 个部分解析 · {project.resources.filter(resource => resource.state === "failed").length} 个失败</p>}
      {!!project?.diagnostics?.length && <details><summary>未提取的资源与原因 · {project.diagnostics.length} 项</summary>{project.diagnostics.map((issue, index) => <div key={index} className="unity-warning-item"><strong>{issue.file}{issue.container ? ` / ${issue.container}` : ""}{issue.objectId ? ` / 对象 ${issue.objectId}` : ""}</strong><p>{issue.reason}</p><p>{issue.action}</p></div>)}</details>}
      {checkpoint?.partial && <p className="hint">仅回写 {done} 条有效译文，其余 {selected.length - done} 条保持原文。</p>}
      {!!project?.fonts.length && <details><summary>已识别字体 · {project.fonts.length} 个</summary>{project.fonts.map((f, i) => <p key={i}>{f.name} · {f.kind} · {f.file}</p>)}</details>}
      {!!streamWarnings.length && <details><summary>对象读取范围不足 · {streamWarnings.length} 项</summary><p>{streamWarnings[0].reason}</p><p className="hint">{streamWarnings[0].impact}</p>{streamWarnings.map((info, i) => <details className="unity-warning-item" key={`stream${i}`}><summary>{info.location}</summary><pre>{info.technical}</pre></details>)}</details>}
      {warningDetails.some(w => w.category !== "stream") && <details aria-label="其他输出提示"><summary>其他提示 · {warningDetails.filter(w => w.category !== "stream").length} 项</summary>{warningDetails.filter(w => w.category !== "stream").map((info, i) => <div className="unity-warning-item" key={`w${i}`}><p>{info.reason}</p>{info.technical && <details><summary>技术详情</summary><pre>{info.technical}</pre></details>}</div>)}</details>}
      </>}
    </div>
  </section>;
  const finishColumnDrag = () => {
    if (!columnDrag.current) return;
    const ratio = columnDrag.current.latest; columnDrag.current = null;
    setOriginalRatio(ratio); localStorage.setItem("unity-offline-original-ratio", String(ratio));
  };
  return <div className="unity-offline">
    {active && root && restoring && <UnityProjectLoading project={root.split(/[\\/]/).filter(Boolean).at(-1) || "Unity 项目"} path={root} detail={loadingDetail} />}
    {toolbarTarget && createPortal(applied ? <button className="unity-btn unity-btn-danger" disabled={locked} onClick={() => void uninstallPatch()}>卸载补丁</button> : <button className="unity-btn unity-btn-primary" disabled={!!busy || restoring || !root || !output || (!resumable || checkpoint.step <= 2) && completedThrough < 2 && !connectionReady} onClick={() => void startWorkflow(needsScan ? 1 : Math.min(4, completedThrough + 1), 4, resumable, true)}>{resumable && checkpoint.automatic ? "恢复一键生成" : "一键生成并应用"}</button>, toolbarTarget)}
    <aside ref={configRef} className="unity-offline-config" style={{ width: panelWidth.width }}>
    <div ref={upperRef} className={`unity-offline-upper${manualLayout ? " is-manual" : ""}`} style={{ height: upperHeight }}>
    <section ref={workflowRef} className={`unity-generation unity-workflow ${generation?.state || "idle"}`} aria-label="分步设置与当前任务">
      <nav className="unity-step-tabs" role="tablist" aria-label="处理步骤">{UNITY_STAGE_TABS.map(tab => {
        const { step, number, label } = tab;
        const subReady = tab.imageOnly ? imagesReady : textReady;
        const partProgress = step === 2 && !preparingRescan ? checkpoint?.translationRuns?.[tab.imageOnly ? "images" : "text"] : undefined;
        const runningHere = step === 2 && partProgress ? partProgress.state === "running" : executingStep === step && (step !== 2 || !!checkpoint?.imageOnly === tab.imageOnly);
        const state = step === 2 ? (partProgress ? partProgress.state === "error" : generation?.step === 2 && generation.state === "error" && !!checkpoint?.imageOnly === tab.imageOnly) ? "error" : subReady ? "complete" : runningHere ? "current" : "pending" : unityStageState(step, displayedCompletedThrough, executingStep, generation?.state === "error" ? generation.step : undefined, !preparingRescan && needsScan ? 1 : undefined, !preparingRescan && scanUpdate.level === "optional" ? 1 : undefined);
        const selectedTab = activeStep === step && (step !== 2 || imagePart === tab.imageOnly);
        return <button key={number} id={`unity-step-${number}`} role="tab" aria-selected={selectedTab} aria-controls="unity-step-panel" aria-current={runningHere ? "step" : undefined} className={`unity-step-tab ${state}${selectedTab ? " is-selected" : runningHere ? " is-active-task" : ""}`} onClick={() => { followProgress.current = false; setActiveStep(step); setImagePart(tab.imageOnly); }}><span className="unity-step-number" aria-hidden="true">{number}</span>{label}{(state === "outdated" || state === "optional-update") && ` · ${scanUpdate.label}`}</button>;
      })}</nav>
      <div id="unity-step-panel" role="tabpanel" aria-labelledby={`unity-step-${activeStep === 2 ? imagePart ? "2.2" : "2.1" : activeStep}`} className="unity-step-panel">
        {activeStep === 1 && <>
          <div className="unity-offline-fields unity-scan-fields">
            <label>原文语言<select value={source} title="仅处理所选语言范围，其他语言的原文与译文保留在工程中" disabled={scanParametersLocked} onChange={e => { setSource(e.target.value); setPage(0); }}><option value="auto">自动（主语言）</option>{sourceLanguages.map(language => <option key={language} value={language}>{unityLanguageLabel(language)}</option>)}<option value="all">全部语言</option></select></label>
            <label>文本分段<UnityDescriptionSelect label="文本分段" value={textMode} choices={UNITY_SEGMENT_CHOICES} disabled={parametersLocked} onChange={value => setTextMode(value as "lines" | "paragraphs" | "smart")} /></label>
            <label className="unity-offline-check unity-scan-code-option" title="扫描游戏代码中的硬编码文本，补充资源中未提取到的对白或界面文字。结果可能包含程序标识，请在扫描后取消不应翻译的条目；错误修改可能使游戏无法运行。"><input type="checkbox" disabled={parametersLocked} checked={includeCode} onChange={e => setIncludeCode(e.target.checked)} />扫描代码字面量</label>

          </div>
          <div className="unity-scan-types"><label><span>类型定义</span><input value={typeDirectory} readOnly placeholder="自动读取游戏 Managed" title={typeDirectory || "IL2CPP 可选择匹配的 DummyDll 目录，仅用于读取字段定义"} /></label><div className="unity-type-actions"><button className="unity-btn" disabled={parametersLocked} onClick={() => void operation("选择类型定义", async () => { const path = await open({ directory: true }); if (typeof path === "string") setTypeDirectory(path); })}>选择目录</button>{typeDirectory && <button className="unity-btn" disabled={parametersLocked} onClick={() => setTypeDirectory("")}>自动</button>}</div></div>
          {includeCode && <details className="unity-assembly-options"><summary>代码范围 · {codeAssemblies?.length ?? inspection?.assemblies?.filter(assembly => assembly.writable).length ?? 0} 个程序集</summary>{(inspection?.assemblies || []).map(assembly => <label key={assembly.path}><input type="checkbox" disabled={parametersLocked || !assembly.writable} checked={assembly.writable && (codeAssemblies?.includes(assembly.path) ?? true)} onChange={event => setCodeAssemblies(current => { const selected = current ?? inspection!.assemblies.filter(item => item.writable).map(item => item.path); return event.target.checked ? [...selected, assembly.path].sort() : selected.filter(path => path !== assembly.path); })} /><span>{assembly.path}{assembly.reason ? ` · ${assembly.reason}` : ""}</span></label>)}{!inspection?.assemblies?.length && <p className="hint">未找到可选的游戏 Managed 程序集；标准 global-metadata.dat 字面量仍按代码扫描选项处理。</p>}</details>}
          {inspectionError && <p className="unity-offline-error">程序集预检失败：{inspectionError}</p>}
          {!!inspection?.catalogs?.length && <p className="hint">检测到 {inspection.catalogs.length} 个 Addressables Catalog；修改相关 Bundle 后需验证 CRC、依赖和缓存，当前不会自动改写 Catalog。</p>}
          {!project && <p className="hint">扫描后可在结果区查看原文范围和文本数量。</p>}
          {!preparingRescan && project && source !== "all" && <p className="hint">优先使用语言字段标记，未标记时按文字特征筛选；纯汉字可能同时用于中文和日文。</p>}
          {pausedScan && !preparingRescan && scanOptionsChanged && <p className="hint">扫描参数已变化，继续时需从头重新扫描；确认后保留可匹配复用的旧结果。</p>}
        </>}
        {activeStep === 2 && <div className="unity-translation-settings">
          <div className="unity-control-group unity-translation-group" role="group" aria-label="翻译参数">
          <div className="unity-group-fields unity-translation-fields">
            <label>翻译方式<select value={translationKind} disabled={parametersLocked} onChange={e => setTranslationKind(e.target.value as "llm" | "engine")}><option value="llm">大模型</option><option value="engine">翻译引擎</option></select></label>
            {translationKind === "llm" && <label>翻译模型<select value={llmModel} disabled={parametersLocked} onChange={e => setLlmModel(e.target.value)}><option value="">跟随通用（{settings.model || "未配置"}）</option>{llmModel && !modelChoices.some(p => p.model === llmModel) && <option value={llmModel}>{llmModel}（未配置）</option>}{[...new Set(modelChoices.map(p => p.group))].map(group => <optgroup key={group} label={group}>{modelChoices.filter(p => p.group === group).map(p => <option key={p.model} value={p.model}>{p.label}</option>)}</optgroup>)}</select></label>}
            <label>目标语言<select value={target} disabled={parametersLocked} onChange={e => { setTarget(e.target.value); invalidatePatch(); }}>{UNITY_LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}</select></label>
          </div>
          <div className="unity-settings-action">
            {onOpenGeneralSettings && <button className="unity-btn unity-icon-action" aria-label="通用设置" title="通用设置：模型连接、凭证与代理" disabled={!!busy} onClick={onOpenGeneralSettings}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6M16 14v6" /></svg></button>}

          </div>
          {!connectionReady && <p className="unity-offline-error unity-group-note">{translationKind === "llm" ? "所选模型尚未配置 API 地址，请前往通用设置配置。" : "请在下方列表中启用至少一个免 Key 或已配置凭证的引擎。"}</p>}
          </div>
          {translationKind === "engine" && <UnityEngineList choices={engineChoices} keys={parseEngineKeys(settings.translateEngineKeys)} disabled={parametersLocked} expanded={engineListExpanded} onExpandedChange={setEngineListExpanded} onChange={updateEngineChoices} />}
          {imagePart && <><p className="hint">2.1 与 2.2 可同时处理，各自保存进度。</p><div className="unity-offline-fields"><label>图片识别<select value={imageOcrMode} disabled={restoring || applied || checkpoint?.translationRuns?.images.state === "running"} onChange={event => setImageOcrMode(event.target.value as OcrMode)}>{OCR_MODE_OPTIONS.map(mode => <option key={mode.id} value={mode.id}>{mode.title}</option>)}</select></label><label title="低于阈值的区域默认不自动翻译，可在图片结果中手动勾选后处理。">翻译置信度阈值<input aria-label="图片翻译置信度阈值" type="number" min={0} max={100} step={1} value={imageConfidenceThreshold} disabled={restoring || applied || checkpoint?.translationRuns?.images.state === "running"} onChange={event => setImageConfidenceThreshold(Math.max(0, Math.min(100, Number(event.target.value))))} />%</label><span>底图处理：纯色覆盖后嵌字</span></div><p className="hint">复用图片文字识别模型。译图保持原尺寸；复杂背景请检查预览，必要时替换译图。回写纹理使用 RGBA32，资源体积可能增大。</p></>}
          {!imagePart && <><div className="unity-control-group unity-line-group" role="group" aria-label="换行参数">
          <div className="unity-group-fields unity-line-fields">
            <label>换行处理<UnityDescriptionSelect label="换行处理" value={joinLines ? "join" : "keep"} choices={UNITY_WRAP_CHOICES} disabled={lineOptionsLocked} onChange={value => { const enabled = value === "join"; setJoinLines(enabled); const saved = checkpointRef.current; if (saved && !saved.finished && saved.step === 2 && !saved.layoutOnly) remember({ ...saved, joinLines: enabled }); }} /></label>
            {joinLines && <label>断行方式<UnityDescriptionSelect label="断行方式" value={lineMode} choices={UNITY_LINE_CHOICES} disabled={lineOptionsLocked} onChange={value => updateLineOptions(value as UnityLineMode, lineModel)} /></label>}
            {joinLines && lineMode === "model" && <label className="unity-aux-model">辅助模型<select value={lineModel} disabled={lineOptionsLocked} onChange={e => updateLineOptions(lineMode, e.target.value)}><option value="">跟随通用（{settings.model || "未配置"}）</option>{lineModel && !modelChoices.some(p => p.model === lineModel) && <option value={lineModel}>{lineModel}（未配置）</option>}{[...new Set(modelChoices.map(p => p.group))].map(group => <optgroup key={group} label={group}>{modelChoices.filter(p => p.group === group).map(p => <option key={p.model} value={p.model}>{p.label}</option>)}</optgroup>)}</select></label>}
          </div>

          </div>
          {!scanReady && <p className="hint">请先完成扫描，再执行此步；可以提前配置翻译参数。</p>}
          <div className="unity-file-actions" role="group" aria-label="翻译文件导入导出">
            <span className="unity-file-caption">翻译文件</span>
            {fileStatus && <span className={`unity-file-status${fileStatus.state === "error" ? " unity-offline-error" : ""}`} role="status" aria-live="polite">{fileStatus.detail}</span>}
            <button className="unity-btn unity-text-action" aria-label="下载翻译文件" title="下载全部扫描条目的原文与译文（JSON / CSV）。编辑时保留 id、source，只修改 translation。" disabled={!!busy || restoring || !scanReady} onClick={() => void downloadTranslations()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" /></svg>下载</button>
            <button className="unity-btn unity-text-action" aria-label="导入翻译文件" title="导入 JSON / CSV 翻译文件，按 id 匹配并替换对应译文；未提供的条目保留，空译文会清空对应译文。" disabled={!!busy || restoring || !scanReady} onClick={() => void uploadTranslations()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 17V5m-5 5 5-5 5 5M4 17v4h16v-4" /></svg>导入</button>
          </div>
        </>}
        </div>}
        {activeStep === 3 && <>
          <div className="unity-offline-font"><label>替换字体<input value={fontPath} readOnly placeholder="可选 TTF / OTF；检查缺字并生成所需图集" /></label><button className="unity-btn" disabled={parametersLocked} onClick={() => void operation("选择字体", async () => { const path = await open({ filters: [{ name: "字体", extensions: ["ttf", "otf"] }] }); if (typeof path === "string") { setFontPath(path); setFontPlan(null); invalidatePatch(); } })}>选择字体</button>{fontPath && <button className="unity-btn" disabled={parametersLocked} onClick={() => { setFontPath(""); setFontPlan(null); invalidatePatch(); }}>取消替换</button>}

          </div>
          <div className="unity-offline-fields"><label>补充字符<input value={extraCharacters} disabled={parametersLocked} placeholder="角色名等动态内容" onChange={event => { setExtraCharacters(event.target.value); setFontPlan(null); }} /></label><button className="unity-btn" disabled={!!busy || restoring || !project} onClick={() => void checkFontPlan()}>字库检查与字符集</button>{busy === "字库检查" && <button className="unity-btn" onClick={stop} disabled={abort.current?.signal.aborted}>中止检查</button>}</div>
          {fontPlan && <details className="unity-font-plan" open><summary>{fontPlan.characterCount} 个字符 · {fontPlan.fontChecked ? `${fontPlan.missing.length} 个缺字` : "未选择字体"}</summary><p>采用译文 {fontPlan.translatedReferences} 处，保留原文 {fontPlan.originalReferences} 处，包含英文与数字。</p>{fontPlan.requirements.map(requirement => <p key={requirement}>{requirement}</p>)}{fontPlan.missing.length > 0 && <p className="unity-offline-error">缺字预览：{fontPlan.missing.slice(0, 24).map(code => String.fromCodePoint(code)).join("")}</p>}<button className="unity-btn" onClick={() => void openFolder(fontPlan.folder)}>打开字符集目录</button></details>}
          <p className="hint">{patchReady ? "为已选的有效译文和译图生成补丁，出错项目自动跳过，并保留原件备份。" : "请先完成所选文本的翻译，再执行此步；可以提前选择字体。"} 文本补丁与已识别的 UGUI 字体替换无需 Unity Editor。</p>
          {project?.fonts.some(font => /^(TMP|NGUI)/.test(font.kind)) && <p className="hint">已检测到 TMP / NGUI 字体。选择替换字体后生成字形和独立图集，无需 Unity Editor；共享图集或不支持的布局会说明具体原因。</p>}
        </>}
        {activeStep === 4 && <>
          <div className="unity-offline-output"><span>应用位置</span><code title={root}>{root}</code></div>
          {!applied && <p className="hint">{patch ? "请先关闭游戏。应用前检查进程及原件、补丁哈希，保留备份；写入失败时回滚。" : "请先生成补丁，再执行此步。应用前会检查游戏进程和文件变化，并保留原件备份。"}</p>}
        </>}
      </div>
      <div className="unity-task-actions" role="group" aria-label="当前步骤操作">
        {activeStep === 1 && <button className={`unity-btn ${!preparingRescan && scanStarted ? "unity-btn-warning" : "unity-btn-primary"}`} disabled={!!busy || restoring || !root || !output} onClick={() => void (preparingRescan ? startWorkflow(1, 1, false, false, true) : scanStarted ? restartStage(1) : startWorkflow(1, 1))}>{!preparingRescan && scanStarted ? "重新扫描资源" : "开始扫描"}</button>}
        {activeStep === 2 && !imagePart && <>
          {checkpoint?.translationRuns?.text.state !== "running" && <button className="unity-btn unity-btn-primary" title="使用上方翻译与换行参数，保留已有有效译文" disabled={restoring || !!busy && !translationJobs.current || !scanReady || !selected.length || !connectionReady || applied || textReady} onClick={() => startTranslationPart("text")}>{checkpoint?.translationRuns?.text.state === "stopped" || checkpoint?.translationRuns?.text.state === "error" ? "恢复翻译文本" : "翻译所选"}</button>}
            {(done > 0 || selected.some(e => e.layoutDraft) || checkpoint?.step === 2) && <button className="unity-btn unity-btn-warning" disabled={!!busy || restoring || !scanReady} title="清除译文与后续产物，重新设置翻译参数" onClick={() => void restartStage(2)}>重做翻译</button>}
          <button className={`unity-btn${checkpoint?.layoutOnly ? " unity-btn-warning" : ""}`} disabled={!!busy || restoring || !scanReady || !joinLines || !selected.some(e => /[\r\n]/.test(e.source) && (e.translation || e.layoutDraft) && !unityTranslationError(e.source, e.translation || e.layoutDraft!))} title={applied ? "恢复游戏原件并保留译文，重新处理断行；之后需生成并应用新补丁" : "保留现有译文，仅重新处理换行；不会重新翻译"} onClick={() => void reflowExisting()}>{checkpoint?.layoutOnly ? "重做断行" : "仅重新断行"}</button>
        </>}
        {activeStep === 2 && imagePart && <><button className="unity-btn unity-btn-primary" disabled={restoring || !!busy && !translationJobs.current || checkpoint?.translationRuns?.images.state === "running" || !scanReady || (project?.scanRevision || 0) < 5 || !connectionReady || applied || imagesReady} onClick={() => startTranslationPart("images")}>{checkpoint?.translationRuns?.images.state === "stopped" || checkpoint?.translationRuns?.images.state === "error" ? "恢复图片处理" : "识别并翻译图片"}</button><button className="unity-btn unity-btn-warning" disabled={!!busy || restoring || !scanReady} onClick={() => void restartStage(2)}>重做图片处理</button></>}
        {activeStep === 2 && <button className="unity-btn" disabled={!!busy && !translationJobs.current || restoring || !scanReady || applied || !!patch} onClick={() => void skipTranslationPart()}>跳过 {imagePart ? "2.2" : "2.1"} 剩余内容</button>}
        {activeStep === 3 && <button className="unity-btn unity-btn-primary" disabled={locked || !patchReady || applied || !!patch} onClick={() => void startWorkflow(3, 3)}>生成补丁</button>}
        {activeStep === 4 && (applied ? <button className="unity-btn unity-btn-primary" disabled={locked || !!error} onClick={() => void launchGame()}>启动游戏</button> : <button className="unity-btn unity-btn-primary" disabled={locked || !patch} onClick={() => void startWorkflow(4, 4)}>应用到游戏</button>)}
        {activeStep > 2 && (activeStep <= completedThrough || generation?.state === "error" && activeStep === generation.step) && <button className="unity-btn unity-btn-warning" disabled={!!busy || restoring} onClick={() => void restartStage(activeStep)}>重做此步</button>}
      </div>
    <div className={`unity-current-task ${generation?.state || "idle"}${generation && !viewingProgress && progressRunning ? " unity-background-task is-running" : ""}`} aria-label="任务状态">


      <div className="unity-generation-status" role="status"><strong>步骤 {(generation?.step || activeStep) === 2 ? (generation ? progressIsImage : imagePart) ? "2.2" : "2.1" : generation?.step || activeStep} · {(generation?.step || activeStep) === 2 && (generation ? progressIsImage : imagePart) ? "图片识别与翻译" : GENERATION_STEPS[(generation?.step || activeStep) - 1]}{generation ? generation.state === "done" ? " · 已完成" : generation.state === "skipped" ? " · 已跳过" : generation.state === "pending" ? " · 待开始" : generation.state === "stopped" ? " · 已中止" : generation.state === "error" ? " · 失败" : " · 正在处理" : activeStep <= completedThrough ? " · 已完成" : " · 待开始"}</strong><span>{generation ? progressPercent === null ? generation.state === "pending" ? "等待开始" : generation.state === "skipped" ? "已跳过" : generation.state === "running" ? "正在准备…" : generation.state === "done" ? "已完成" : generation.state === "error" ? "未开始" : "等待恢复" : `${progressPercent}% · ${generation.completed} / ${generation.total} ${progressUnit}` : ""}</span><div className="unity-status-actions">
        {taskAction}
        {generation && !viewingProgress && <button className="unity-btn" onClick={() => { followProgress.current = true; setActiveStep(generation.step); setImagePart(!!checkpoint?.imageOnly); }}>查看进度</button>}
      </div></div>
      <div key={generation?.step || activeStep} className={`unity-progress-track${progressRunning ? " is-running" : ""}`} role="progressbar" aria-label="当前步骤进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={generation ? progressPercent ?? undefined : activeStep <= completedThrough ? 100 : 0} aria-valuetext={generation ? progressPercent === null ? progressRunning ? "正在准备，暂未取得总量" : "未获得进度" : `${progressPercent}%` : activeStep <= completedThrough ? "已完成" : "待开始"}>
        <div className="unity-progress-fill" style={{ width: `${generation ? progressPercent ?? 0 : activeStep <= completedThrough ? 100 : 0}%` }} />
      </div>
      {generation?.step === 2 && !checkpoint?.layoutOnly && !progressIsImage ? <UnityTranslationProgress progress={generation} running={progressRunning} onLocate={locateTranslationFailure} /> : generation?.state !== "error" && <p className="unity-task-detail" title={generation?.detail}>{generation ? generation.detail : "确认上方参数后开始处理。"}</p>}
      {activeStep === 2 && checkpoint?.translationRuns && checkpoint.translationRuns[imagePart ? "text" : "images"].state !== "pending" && <button className="unity-sibling-task" onClick={() => setImagePart(!imagePart)}>{imagePart ? "2.1 翻译文本" : "2.2 图片识别与翻译"} · {({ running: "正在处理", done: "已完成", stopped: "已中止", error: "失败", skipped: "已跳过", pending: "待开始" })[checkpoint.translationRuns[imagePart ? "text" : "images"].state]}</button>}
      {generation?.step === 4 && generation.state !== "done" && <p className="unity-offline-error">应用尚未完成，请勿启动游戏。恢复后继续写入，原件保存在补丁目录的 original 文件夹。</p>}
    </div>
    </section>
    </div>
    <button className="unity-output-divider" role="separator" aria-orientation="horizontal" aria-label="调整步骤和输出区域高度" aria-valuenow={Math.round(upperHeight)} onMouseDown={e => resizeLayout(e)} onKeyDown={e => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); resizeLayoutKey(e.key === "ArrowDown" ? 16 : -16); } }} />
    {projectDetails}
    </aside>
    <button className="unity-workspace-divider" role="separator" aria-orientation="vertical" aria-label="调整步骤区和结果区宽度" aria-valuenow={Math.round(panelWidth.width)} onMouseDown={e => panelWidth.beginResize(e, "grow-right")} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); panelWidth.setWidth(panelWidth.width + (e.key === "ArrowRight" ? 16 : -16)); } }} />
    {activeStep === 2 && imagePart ? <UnityImageWorkbench project={project} confidenceThreshold={imageConfidenceThreshold} disabled={!!busy || restoring || applied || !!patch} onChange={editImage} onRender={image => void updateImagePreview(image)} onImport={image => void updateImagePreview(image, true)} onSave={() => void save().catch(error => setActionError(String(error)))} /> : <section className="unity-offline-workbench">
      <div className="unity-offline-toolbar">
        <strong>文本与译文</strong>
      <div className="unity-result-filters">
        <label><input type="checkbox" checked={errorsOnly} disabled={!scanReady} onChange={event => { setErrorsOnly(event.target.checked); setPage(0); }} />仅看未完成 / 失败</label>
        {errorsOnly && <button className="unity-btn" disabled={!!busy || restoring || !scanReady || !connectionReady || applied || !selected.some(entry => entry.error || unityTranslationError(entry.source, entry.translation))} onClick={() => void startWorkflow(2, 2, !!checkpoint?.layoutOnly, false, false, "text")}>重试未完成项</button>}
        <input type="search" aria-label="搜索原文和译文" placeholder="搜索" value={scanReady ? search : ""} disabled={!scanReady} onChange={e => { setSearch(e.target.value); setPage(0); }} />
      </div>
        <button className="unity-btn" disabled={!scanReady || !!busy && !translationJobs.current || !dirty} onClick={() => void save().then(() => setMessage("工程已保存"), error => setActionError(String(error)))}>{scanReady && dirty ? "保存工程 *" : "保存工程"}</button>
      </div>
      {scanReady && project ? <>
        <div className="unity-offline-table-scroll"><table ref={tableRef} className="unity-offline-table" style={{ minWidth: Math.max(560, (sourceWidth.width + 212) / (1 - originalRatio / 100)), "--unity-original-width": `${originalRatio}%` } as CSSProperties}><colgroup><col style={{ width: 32 }} /><col style={{ width: sourceWidth.width }} /><col style={{ width: "var(--unity-original-width)" }} /><col /></colgroup><thead><tr>
          <th><input type="checkbox" aria-label="选取全部搜索结果" disabled={entriesLocked || applied || !filtered.length} checked={filtered.length > 0 && filtered.every(e => e.selected)} onChange={e => { const ids = new Set(filtered.map(r => r.id)); const checked = e.target.checked; publish({ ...(latest.current || project), entries: (latest.current || project).entries.map(r => ids.has(r.id) ? { ...r, selected: checked } : r) }); setDirty(true); invalidatePatch(); }} /></th>
          <th className="unity-resizable-column">来源<button className="unity-column-divider" role="separator" aria-orientation="vertical" aria-label="调整来源列宽" aria-valuenow={Math.round(sourceWidth.width)} onMouseDown={e => sourceWidth.beginResize(e, "grow-right")} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); sourceWidth.setWidth(sourceWidth.width + (e.key === "ArrowRight" ? 8 : -8)); } }} /></th>
          <th className="unity-resizable-column">原文<button className="unity-column-divider" role="separator" aria-orientation="vertical" aria-label="调整原文和译文列宽" aria-valuenow={Math.round(originalRatio)} onPointerDown={e => { e.preventDefault(); columnDrag.current = { x: e.clientX, ratio: originalRatio, latest: originalRatio, width: tableRef.current!.getBoundingClientRect().width }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { const drag = columnDrag.current; if (!drag) return; drag.latest = Math.max(20, Math.min(70, drag.ratio + (e.clientX - drag.x) / drag.width * 100)); tableRef.current?.style.setProperty("--unity-original-width", `${drag.latest}%`); }} onPointerUp={finishColumnDrag} onPointerCancel={finishColumnDrag} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const ratio = Math.max(20, Math.min(70, originalRatio + (e.key === "ArrowRight" ? 2 : -2))); setOriginalRatio(ratio); localStorage.setItem("unity-offline-original-ratio", String(ratio)); } }} /></th><th>译文</th>
        </tr></thead><tbody>{rows.map(entry => <tr key={rowJump?.id === entry.id ? `${entry.id}:${rowJump.sequence}` : entry.id} data-entry-id={entry.id} tabIndex={-1} className={`${entry.error || entry.translation && unityTranslationError(entry.source, entry.translation) ? "has-error" : ""}${rowJump?.id === entry.id ? " unity-entry-target" : ""}`}>
          <td><input type="checkbox" aria-label={`选择第 ${entry.id} 条`} disabled={entriesLocked || applied} checked={entry.selected} onChange={e => update(entry.id, { selected: e.target.checked })} /></td>
          <td title={`${entry.file}\n${entry.container}\n${entry.locator}${entry.locale ? `\n语言字段：${entry.locale}` : ""}`}><span>#{entry.id} · {entry.kind}{entry.locale ? ` · ${unityLanguageLabel(unityEntryLanguage(entry))}` : ""}</span><small>{entry.file.split(/[\\/]/).pop()} · 对象 #{entry.objectId === "0" ? entry.id : entry.objectId}</small></td>
          <td className="unity-offline-source"><div className="unity-source-text" title={entry.source}>{entry.source}</div></td>
          <td><div className="unity-entry-editor"><textarea aria-label={`第 ${entry.id} 条译文`} value={entry.translation || entry.layoutDraft || ""} disabled={entriesLocked || applied} rows={1} onChange={e => update(entry.id, { translation: e.target.value, layoutDraft: undefined })} />{(entry.error || entry.translation && unityTranslationError(entry.source, entry.translation)) && <button className="unity-row-error" title={entry.error ? explainUnityFailure(entry.error).reason : unityTranslationError(entry.source, entry.translation)} aria-label={`第 ${entry.id} 条错误详情`} onClick={() => setRowIssue({ ...entry, error: entry.error || unityTranslationError(entry.source, entry.translation) })}>!</button>}</div></td>
        </tr>)}</tbody></table>{!filtered.length && <p className="hint">当前语言或搜索范围内没有文本，可在扫描步骤切换原文语言或选择全部语言查看。</p>}</div>
        <div className="unity-results-footer">
        {scanReady && <span aria-label="文本范围与选择统计">{scope.label} · {selected.length ? <>可回写 {done} / {selected.length} 条{selected.length !== scope.count && <> · 范围共 {scope.count} 条</>}</> : <>未选择 · 范围共 {scope.count} 条</>}</span>}
        <div className="unity-offline-pagination"><button className="unity-btn" disabled={page <= 0} onClick={() => setPage(p => Math.max(0, p - 10))}>-10 页</button><button className="unity-btn" disabled={page <= 0} onClick={() => setPage(p => p - 1)}>上一页</button><span>{Math.min(page + 1, pageCount)} / {pageCount}</span><button className="unity-btn" disabled={page + 1 >= pageCount} onClick={() => setPage(p => p + 1)}>下一页</button><button className="unity-btn" disabled={page + 1 >= pageCount} onClick={() => setPage(p => Math.min(pageCount - 1, p + 10))}>+10 页</button><input type="number" inputMode="numeric" aria-label="跳转页码" min={1} max={pageCount} placeholder="页码" value={jumpPage} onChange={e => setJumpPage(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && Number.isInteger(Number(jumpPage)) && jumpPage.trim()) { setPage(Math.max(0, Math.min(pageCount - 1, Number(jumpPage) - 1))); setJumpPage(""); } }} /><button className="unity-btn" disabled={!jumpPage.trim() || !Number.isInteger(Number(jumpPage))} onClick={() => { setPage(Math.max(0, Math.min(pageCount - 1, Number(jumpPage) - 1))); setJumpPage(""); }}>跳转</button></div>
        </div>
      {rowIssue && rowFailure && <div className="unity-row-error-panel" role="dialog" aria-label={`第 ${rowIssue.id} 条错误详情`}><div className="unity-row-error-actions"><button className="unity-btn" aria-label={`重试第 ${rowIssue.id} 条`} disabled={rowRetryQueued || restoring || !scanReady || !connectionReady || applied || !!patch || !!busy && rowQueueStatus !== "failed"} title={applied || patch ? "请先清理现有补丁再重试" : rowRetryQueued ? "该条目已在翻译队列中" : busy && rowQueueStatus !== "failed" ? "请在当前任务结束后单独重试此条目" : "重新加入翻译队列，保留已有译文和草稿"} onClick={() => void retryTranslationEntry(rowIssue.id)}>{rowRetryQueued ? "已在队列" : "重试此条"}</button><button className="unity-btn" onClick={() => setRowIssue(null)}>关闭</button></div><strong>第 {rowIssue.id} 条处理失败</strong><p>{rowFailure.reason}</p><p>{rowFailure.action}</p>{rowFailure.technical && <details><summary>技术详情</summary><pre>{rowFailure.technical}</pre></details>}</div>}
      </> : <div className="unity-offline-empty">扫描完成后显示文本与译文。</div>}
    </section>}
  </div>;
});
