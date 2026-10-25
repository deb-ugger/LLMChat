import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { open as openPath } from "@tauri-apps/plugin-shell";
import { api, type Settings, type TranslateProvider, type UnityGameInfo } from "../api";
import { TRANSLATE_ENGINES, classicEngines, engineReady, parseEngineKeys } from "../translateEngines";
import { buildUnityTranslateOptions, sameUnityGamePath, UNITY_LANGUAGES } from "../unityTranslation";
import { legacyUnityOutputDirectory, mergeUnityProject, UnityPaused, unityRun, unityTranslationError, type UnityEntry, type UnityPatch, type UnityProgress, type UnityProject, type UnityWorkspace } from "../unityOffline";
import { explainUnityFailure, explainUnityWarning } from "../unityOfflineFeedback";
import { UNITY_STEPS, unityLanguageScope, unityStageState } from "../unityWorkflow";
import { translateUnitySession } from "../unityTranslationSession";
import { usePersistedWidth } from "../hooks/usePersistedWidth";
import "../unityOffline.css";

export type UnityOfflineHandle = { prepareToLeave: () => Promise<boolean> };
const GENERATION_STEPS = UNITY_STEPS;
type GenerationProgress = UnityProgress & { step: number; state: "running" | "done" | "stopped" | "error"; failure?: string };
type RunCheckpoint = {
  step: number; endStep: number; automatic: boolean; finished: boolean;
  projectFolder: string; scanFolder: string; patchFolder: string; patch: UnityPatch | null;
  previousProjectFolder?: string; scopeVersion?: number;
  translationKind: "llm" | "engine"; engine: TranslateProvider; source: string; target: string; includeCode: boolean; fontPath: string;
  progress: GenerationProgress;
};
type Props = {
  active: boolean; game: UnityGameInfo | null; settings: Settings;
  onOpenGeneralSettings?: () => void;
  onBusyChange?: (busy: boolean) => void;
  toolbarTarget: HTMLElement | null;
};
export const UnityOfflineView = forwardRef<UnityOfflineHandle, Props>(function UnityOfflineView({ active, game, settings, onOpenGeneralSettings, onBusyChange, toolbarTarget }, ref) {
  const root = game?.gameDir || "";
  const [output, setOutput] = useState("");
  const [project, setProject] = useState<UnityProject | null>(null);
  const [translationKind, setTranslationKind] = useState<"llm" | "engine">("llm");
  const [engine, setEngine] = useState<TranslateProvider>("bing");
  const [source, setSource] = useState("auto");
  const [target, setTarget] = useState("zh-CN");
  const [includeCode, setIncludeCode] = useState(false);
  const [activeStep, setActiveStep] = useState(1);
  const [fontPath, setFontPath] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [patch, setPatch] = useState<UnityPatch | null>(null);
  const [dirty, setDirty] = useState(false);
  const [generation, setGeneration] = useState<GenerationProgress | null>(null);
  const [applied, setApplied] = useState(false);
  const [checkpoint, setCheckpoint] = useState<RunCheckpoint | null>(null);
  const checkpointRef = useRef<RunCheckpoint | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreNotices, setRestoreNotices] = useState<string[]>([]);
  const [workRoot, setWorkRoot] = useState("");
  const [rowIssue, setRowIssue] = useState<UnityEntry | null>(null);
  const panelWidth = usePersistedWidth("unity-offline-panel-width", 480, 300, 900);
  const sourceWidth = usePersistedWidth("unity-offline-source-width", 112, 80, 280);
  const [originalRatio, setOriginalRatio] = useState(() => Math.min(70, Math.max(20, Number(localStorage.getItem("unity-offline-original-ratio")) || 45)));
  const tableRef = useRef<HTMLTableElement>(null);
  const columnDrag = useRef<{ x: number; ratio: number; width: number; latest: number } | null>(null);
  const taskWrites = useRef<Promise<unknown>>(Promise.resolve());
  const queuedSignature = useRef("");
  const checkpointKey = "llmchat-unity-run:" + root.toLowerCase();
  const remember = (value: RunCheckpoint) => {
    checkpointRef.current = value; setCheckpoint(value); setGeneration(value.progress);
    const { progress, ...fields } = value;
    const signature = JSON.stringify({ root, ...fields, progress: { step: progress.step, state: progress.state, folder: progress.folder, total: progress.total, failure: progress.failure } });
    if (signature !== queuedSignature.current) {
      queuedSignature.current = signature;
      const job = structuredClone(value);
      taskWrites.current = taskWrites.current.catch(() => {}).then(() => unityRun("save-task", { root, task: job }));
      void taskWrites.current.catch(e => { queuedSignature.current = ""; setError(`任务检查点保存失败：${String(e)}`); });
    }
  };
  const abort = useRef<AbortController | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const closing = useRef(false);
  const status = useRef({ busy, dirty }); status.current = { busy, dirty };
  const latest = useRef(project); latest.current = project;
  const publish = (value: UnityProject) => { latest.current = value; setProject(value); };
  const needsRescan = !!project && (project.scanRevision || 0) < 2;
  const scanSettingsChanged = !!project && checkpoint?.projectFolder === project.folder && checkpoint.includeCode !== includeCode;
  const needsScan = needsRescan || scanSettingsChanged;

  useEffect(() => {
    setProject(null); setPatch(null); setDirty(false); setPage(0); setSearch("");
    setError(""); setMessage(""); setFontPath("");
    setGeneration(null); setApplied(false);
    setActiveStep(1);
    setRestoreNotices([]);
    setWorkRoot(""); setOutput(""); setRowIssue(null); queuedSignature.current = "";
    setCheckpoint(null); checkpointRef.current = null;
    let cancelled = false;
    const saved = localStorage.getItem(checkpointKey);
    if (!root) { setRestoring(false); return; }
    setRestoring(true);
    void (async () => {
      try {
        const workspace = await unityRun<UnityWorkspace<RunCheckpoint>>("workspace", { root, outputRoot: await legacyUnityOutputDirectory(), task: saved ? JSON.parse(saved) : null });
        if (cancelled) return;
        setWorkRoot(workspace.workRoot); setOutput(workspace.projectsRoot); setRestoreNotices(workspace.saved.notices);
        let value = workspace.task;
        const folder = value?.projectFolder || value?.scanFolder;
        let p: UnityProject | null;
        if (folder) p = await loadProject(folder, value?.previousProjectFolder);
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
        if (p && !sameUnityGamePath(p.root, root)) throw new Error("检查点不属于当前游戏");
        setProject(p);
        if (value) {
          if (value.scopeVersion !== 1) value = { ...value, source: value.finished && !value.patch && value.endStep < 3 ? value.source : "all", scopeVersion: 1 };
          setPatch(value.patch); setApplied(value.finished && value.endStep === 4);
          setTranslationKind(value.translationKind); setEngine(value.engine); setSource(value.source); setTarget(value.target); setIncludeCode(value.includeCode); setFontPath(value.fontPath);
          if (!value.finished && value.step === 2 && p) {
            const ids = unityLanguageScope(p.entries, value.source).ids;
            const rows = p.entries.filter(e => e.selected && ids.has(e.id));
            value.progress = { ...value.progress, completed: rows.filter(e => e.translation && !unityTranslationError(e.source, e.translation)).length, total: rows.length, detail: "已恢复保存的译文；失败或未完成条目可重试" };
          }
          if (!value.finished && value.progress.state !== "error") value.progress.state = "stopped";
          remember(value);
          setActiveStep(value.step);
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
  const selected = project?.entries.filter(e => e.selected && scope.ids.has(e.id)) || [];
  const engineConfigured = engineReady(parseEngineKeys(settings.translateEngineKeys), engine);
  const connectionReady = translationKind === "llm" ? !!settings.model.trim() && !!settings.apiUrl.trim() : engineConfigured;
  const done = selected.filter(e => e.translation && !unityTranslationError(e.source, e.translation)).length;
  const filtered = useMemo(() => project?.entries.filter(e => scope.ids.has(e.id) && (!search || `${e.source}\n${e.translation}\n${e.file}`.toLowerCase().includes(search.toLowerCase()))) || [], [project, search, scope]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 40));
  const rows = filtered.slice(Math.min(page, pageCount - 1) * 40, (Math.min(page, pageCount - 1) + 1) * 40);
  const update = (id: string, value: Partial<UnityProject["entries"][number]>) => {
    setProject(p => p ? { ...p, entries: p.entries.map(e => e.id === id ? { ...e, ...value, error: "" } : e) } : p);
    setDirty(true); invalidatePatch();
  };
  async function operation(label: string, task: () => Promise<void>, keepProgress = true) {
    if (running.current) return false;
    if (!keepProgress) setGeneration(null);
    setBusy(label); setError(""); setMessage("");
    const work = task(); running.current = work;
    try { await work; return true; } catch (e) { setError(String(e instanceof Error ? e.message : e)); return false; }
    finally { running.current = null; setBusy(""); }
  }
  function projectCheckpoint(p: UnityProject, incomplete = false, completed: number | null = 1, total: number | null = 1): RunCheckpoint {
    return { step: 1, endStep: 1, automatic: false, finished: !incomplete, projectFolder: p.folder, scanFolder: incomplete ? p.folder : "", patchFolder: "", patch: null,
      translationKind, engine, source, target, includeCode, fontPath, scopeVersion: 1,
      progress: { step: 1, state: incomplete ? "stopped" : "done", detail: incomplete ? "已加载扫描检查点" : "已加载保存工程", completed: completed || 0, total } };
  }
  async function loadProject(folder: string, previousFolder?: string) {
    let p = await unityRun<UnityProject>("load", { path: folder + "/unity-project.json" });
    if (!sameUnityGamePath(p.root, root)) throw new Error("工作目录中的工程不属于当前游戏，请检查游戏工作文件夹");
    if (previousFolder && !sameUnityGamePath(previousFolder, folder)) {
      const previous = await unityRun<UnityProject>("load", { path: previousFolder + "/unity-project.json" });
      if (!sameUnityGamePath(previous.root, root)) throw new Error("旧工程不属于当前游戏");
      p = mergeUnityProject(previous, p);
      await unityRun("save", { project: p });
    }
    return p;
  }
  async function rescan() {
    if (project && !window.confirm("重新扫描会建立新工程，并保留原工程。原文和位置未变化的译文及选取会保留；已改变或新增的文本需要重新翻译。继续？")) return;
    if (dirty) await save();
    await runWorkflow(1, 1);
  }
  async function save(p = latest.current) {
    if (!p) return;
    await unityRun("save", { project: p });
    if (latest.current === p) setDirty(false);
  }
  async function translationOptions(run?: RunCheckpoint) {
    const general = await api.getSettings();
    const provider = (run?.translationKind || translationKind) === "llm" ? "llm" : run?.engine || engine;
    if (provider !== "llm" && !engineReady(parseEngineKeys(general.translateEngineKeys), provider))
      throw new Error("请先在设置 → 通用 → 翻译引擎中配置所选引擎的凭证");
    const language = unityLanguageScope(latest.current?.entries || [], run?.source || source).language;
    return buildUnityTranslateOptions(general, provider, language === "all" || language === "und" ? "auto" : language, run?.target || target);
  }
  async function scan(onProgress?: (value: UnityProgress) => void, signal?: AbortSignal, run?: RunCheckpoint) {
    let p = await unityRun<UnityProject>("scan", { root, outputRoot: output, includeCode: run?.includeCode ?? includeCode, path: run?.scanFolder || "" }, onProgress, signal);
    if (run?.previousProjectFolder) {
      const previous = await loadProject(run.previousProjectFolder);
      p = mergeUnityProject(previous, p); await unityRun("save", { project: p });
    }
    publish(p); setPage(0); setDirty(false); setPatch(null); setApplied(false);
    setMessage(p.entries.length ? `扫描完成：${p.entries.length} 条文本，${p.fonts.length} 个字体` : "未找到可处理的文本，请查看扫描提示中的跳过原因。");
    return p;
  }
  async function translateProject(p: UnityProject, controller: AbortController, options: Awaited<ReturnType<typeof translationOptions>>, onProgress?: (value: UnityProgress) => void, languageSource = source) {
    const next = structuredClone(p);
    setDirty(true);
    const cache = new Map<string, string>();
    for (const entry of next.entries) if (entry.translation && !unityTranslationError(entry.source, entry.translation)) cache.set(entry.source, entry.translation);
    const ids = unityLanguageScope(next.entries, languageSource).ids;
    const selectedEntries = next.entries.filter(e => e.selected && ids.has(e.id));
    try {
      await translateUnitySession(selectedEntries, cache, {
        signal: controller.signal, validate: unityTranslationError, formatFailure: error => explainUnityFailure(error).reason, progress: onProgress,
        translate: async text => {
          const seconds = options.provider === "llm" ? 120 : 30;
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(seconds * 1000)]);
          try { const response = await api.translate(text, { signal }, options); if (!response.ok) throw new Error(response.code || "翻译请求失败"); return response.translation; }
          catch (error) { if (!controller.signal.aborted && signal.reason?.name === "TimeoutError") throw new Error(`翻译请求超过 ${seconds} 秒未响应`); throw error; }
        },
        persist: async () => { await unityRun("save", { project: next }); publish({ ...next, entries: [...next.entries] }); },
      });
    } finally {
      const final = { ...next, entries: [...next.entries] };
      publish(final);
      await save(final);
      setMessage(controller.signal.aborted ? "已停止，已保存完成的译文" : "本轮翻译已结束，可检查译文后生成补丁");
    }
    return next;
  }
  async function exportPatch(p: UnityProject, onProgress?: (value: UnityProgress) => void, signal?: AbortSignal, run?: RunCheckpoint) {
    setBusy("生成补丁");
    const selectedIds = [...unityLanguageScope(p.entries, run?.source || source).ids];
    const result = await unityRun<UnityPatch>("export", { project: p, selectedIds, fontPath: run?.fontPath ?? fontPath, path: run?.patchFolder || "" }, onProgress, signal);
    setPatch(result); setDirty(false);
    setMessage(`已生成 ${result.files} 个补丁文件，回写 ${result.entries} 条译文、替换 ${result.fontReplacements} 个 UGUI 字体；尚未验证游戏显示。`);
    return result;
  }
  async function applyPatch(result: UnityPatch, onProgress?: (value: UnityProgress) => void, signal?: AbortSignal) {
    setBusy("应用到游戏");
    await unityRun("apply", { root, path: result.folder }, onProgress, signal);
    setApplied(true);
    setMessage(`已将 ${result.files} 个补丁文件应用到游戏。原件保存在补丁目录的 original 文件夹，实际显示请启动游戏检查。`);
  }
  async function runWorkflow(startStep: number, endStep: number, resume = false) {
    const controller = new AbortController(); abort.current = controller;
    let run: RunCheckpoint = resume && checkpointRef.current ? { ...checkpointRef.current, endStep } : {
      step: startStep, endStep, automatic: startStep === 1 && endStep === 4, finished: false,
      projectFolder: startStep === 1 && endStep === 1 ? "" : project?.folder || "", scanFolder: "", patchFolder: "", patch: startStep === 4 ? patch : null,
      previousProjectFolder: startStep === 1 && endStep === 1 ? project?.folder : undefined,
      translationKind, engine, source, target, includeCode, fontPath, scopeVersion: 1,
      progress: { step: startStep, state: "running", detail: "准备处理", completed: 0, total: null },
    };
    if (needsScan && run.step < 3) {
      run = { ...run, step: 1, projectFolder: "", scanFolder: "", previousProjectFolder: project?.folder,
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
      remember(run);
      let p = project;
      for (let index = run.step; index <= endStep; index++) {
        setActiveStep(index);
        run.step = index; setBusy(GENERATION_STEPS[index - 1]);
        const onProgress = (progress: UnityProgress) => { if (run.step === index && !run.finished) report(progress); };
        report({ detail: `准备${GENERATION_STEPS[index - 1]}`, completed: 0, total: null });
        await taskWrites.current;
        if (controller.signal.aborted) throw new UnityPaused("");
        if (index === 1) {
          const reuse = run.projectFolder && !run.scanFolder && p;
          p = reuse || await scan(onProgress, controller.signal, run);
          run.projectFolder = p.folder; run.scanFolder = ""; run.previousProjectFolder = undefined;
          if (reuse) report({ detail: `复用当前工程：${p.entries.length} 条文本，保留选取和已有译文`, completed: 1, total: 1 });
        } else if (index === 2) {
          if (!p) throw new Error("请先扫描当前游戏资源");
          const selectedIds = unityLanguageScope(p.entries, run.source).ids;
          if (!p.entries.some(e => e.selected && selectedIds.has(e.id))) throw new Error("当前原文语言范围内没有所选文本，请调整原文语言或选取文本");
          p = await translateProject(p, controller, await translationOptions(run), onProgress, run.source);
          if (controller.signal.aborted) throw new UnityPaused("");
          const ids = unityLanguageScope(p.entries, run.source).ids;
          const failed = p.entries.filter(e => e.selected && ids.has(e.id) && unityTranslationError(e.source, e.translation));
          if (failed.length) throw new Error(`${failed.length} 条译文失败或未通过校验，工程已保存；修正或恢复后重试，不会继续应用`);
        } else if (index === 3) {
          if (!p) throw new Error("请先扫描当前游戏资源");
          const result = await exportPatch(p, onProgress, controller.signal, run);
          run.patch = result; run.patchFolder = result.folder;
        } else {
          if (!run.patch) throw new Error("请先生成补丁");
          await applyPatch(run.patch, onProgress, controller.signal);
        }
        if (controller.signal.aborted) throw new UnityPaused("");
        if (index < endStep) { run.step = index + 1; run.progress = { step: index + 1, state: "running", detail: "等待开始下一步", completed: 0, total: null }; remember(run); }
      }
      run.finished = true; run.progress = { ...run.progress, state: "done" }; remember(run);
    } catch (e) {
      if (e instanceof UnityPaused) {
        if (e.folder) {
          if (run.step === 1) { run.scanFolder = e.folder; run.projectFolder = e.folder; }
          if (run.step === 3) run.patchFolder = e.folder;
        }
        run.progress = { ...run.progress, state: "stopped" }; remember(run);
        if (run.step === 1 && run.scanFolder) publish(await loadProject(run.scanFolder, run.previousProjectFolder));
        setMessage(run.step === 4 ? "应用已中止，部分文件可能已写入。请勿启动游戏，恢复后继续应用。原件备份已保留。" : "任务已中止，检查点已保存，点击恢复继续未完成部分。");
      } else { run.progress = { ...run.progress, state: "error", failure: e instanceof Error ? e.message : String(e) }; remember(run); throw e; }
    } finally { abort.current = null; await taskWrites.current; }
  }
  const stop = () => {
    abort.current?.abort();
    setMessage("正在中止，完成当前文件的安全写入并保存检查点后停止，请勿退出或启动游戏。");
  };
  const progressPercent = generation?.total ? Math.floor(generation.completed / generation.total * 100) : null;
  const progressUnit = generation?.step === 2 ? "条" : "个文件";
  const resumable = !!checkpoint && !checkpoint.finished;
  const locked = !!busy || restoring || resumable;
  const entriesLocked = !!busy || restoring || resumable && checkpoint.step !== 2;
  const resumeTask = () => checkpoint && void operation("恢复任务", () => runWorkflow(checkpoint.step, checkpoint.endStep, true), true);
  const finishTask = () => {
    if (!checkpoint || !window.confirm("结束本次流程？已保存的工程、译文和补丁仍保留，但不再自动继续后续步骤。")) return;
    remember({ ...checkpoint, finished: true, endStep: generation?.step || checkpoint.step });
  };
  const failure = error ? explainUnityFailure(error) : null;
  const errorPanel = failure && <div className="unity-failure" role="alert">
    <strong>失败原因</strong><p>{failure.reason}</p><p>处理方法：{failure.action}</p>
    <details><summary>技术详情</summary><pre>{failure.technical}</pre></details>
  </div>;
  const progressRunning = !!busy && generation?.state === "running";
  const scanWarnings = [...(project?.warnings || []), ...restoreNotices];
  const scanReady = !!project && !needsScan && !(resumable && checkpoint.step === 1);
  const translationReady = scanReady && selected.length > 0 && done === selected.length;
  const completedThrough = applied ? 4 : patch ? 3 : translationReady ? 2 : scanReady ? 1 : 0;
  const executingStep = generation && generation.state !== "done" ? generation.step : completedThrough < 4 ? completedThrough + 1 : undefined;
  const parametersLocked = locked || applied;
  const invalidatePatch = () => {
    setPatch(null); setGeneration(null);
    const saved = checkpointRef.current;
    if (saved?.finished && saved.patch) {
      const value = { ...saved, patch: null, patchFolder: "" };
      remember(value); setGeneration(null);
    }
  };
  const projectDetails = <section className="unity-offline-footer">
    {(project || scanWarnings.length > 0) && <details><summary>字体与扫描提示 · {project?.fonts.length || 0} 个字体 / {scanWarnings.length} 条提示</summary><div className="unity-offline-report">{project?.fonts.map((f, i) => <p key={i}>{f.name} · {f.kind} · {f.file}</p>)}{scanWarnings.map((w, i) => { const info = explainUnityWarning(w); return <div key={`w${i}`}><p>{info.reason}</p>{info.technical && <details><summary>技术详情</summary><pre>{info.technical}</pre></details>}</div>; })}</div></details>}
    {!generation && busy && <p role="status">{busy}…</p>}{!error && message && <p role="status">{message}</p>}
    {workRoot && <div className="unity-offline-output"><span>工作目录</span><code title={workRoot}>{workRoot}</code><button className="unity-btn" onClick={() => void openPath(workRoot).catch(e => setError(String(e)))}>打开</button></div>}
    {patch && <button className="unity-btn" onClick={() => void openPath(patch.folder).catch(e => setError(String(e)))}>打开补丁目录</button>}
  </section>;
  const finishColumnDrag = () => {
    if (!columnDrag.current) return;
    const ratio = columnDrag.current.latest; columnDrag.current = null;
    setOriginalRatio(ratio); localStorage.setItem("unity-offline-original-ratio", String(ratio));
  };
  return <div className="unity-offline">
    {toolbarTarget && createPortal(<button className="unity-btn unity-btn-primary" disabled={!!busy || restoring || !root || !output || (!resumable || checkpoint.step <= 2) && !connectionReady || applied} onClick={() => void operation("一键生成", () => runWorkflow(1, 4, resumable), true)}>{applied ? "已应用到游戏" : resumable && checkpoint.automatic ? "恢复一键生成" : "一键生成并应用"}</button>, toolbarTarget)}
    <aside className="unity-offline-config" style={{ width: panelWidth.width }}>
    <section className={`unity-generation unity-workflow ${generation?.state || "idle"}`} aria-label="分步设置与任务进度">
      <nav className="unity-step-tabs" role="tablist" aria-label="处理步骤">{GENERATION_STEPS.map((label, index) => {
        const step = index + 1;
        const state = unityStageState(step, completedThrough, executingStep);
        return <button key={label} id={`unity-step-${step}`} role="tab" aria-selected={activeStep === step} aria-controls="unity-step-panel" aria-current={executingStep === step ? "step" : undefined} className={`unity-step-tab ${state}${activeStep === step ? " is-selected" : ""}`} onClick={() => setActiveStep(step)}><span className="unity-step-number" aria-hidden="true">{step}</span>{label}</button>;
      })}</nav>
      <div id="unity-step-panel" role="tabpanel" aria-labelledby={`unity-step-${activeStep}`} className="unity-step-panel">
        {activeStep === 1 && <>
          <div className="unity-offline-fields">
            <label>原文语言<select value={source} disabled={parametersLocked} onChange={e => { setSource(e.target.value); setPage(0); invalidatePatch(); }}><option value="auto">自动（主语言）</option><option value="ja">日语</option><option value="en">英语</option><option value="ko">韩语</option><option value="zh">中文</option><option value="ru">俄语</option><option value="all">全部语言</option></select></label>
            <label className="unity-offline-check"><input type="checkbox" disabled={parametersLocked} checked={includeCode} onChange={e => { setIncludeCode(e.target.checked); invalidatePatch(); }} />扫描代码字面量</label>
            <button className="unity-btn" disabled={locked || !root || !output} onClick={() => void operation("扫描资源", rescan)}>{project ? "重新扫描" : "扫描资源"}</button>
          </div>
          <p className="hint">{project ? `当前范围：${scope.label} ${scope.count} / ${scope.total} 条。其他语言保留在工程中，不参与本次翻译和补丁。` : "扫描后按数量最多的主语言显示，也可指定原文语言或查看全部语言。"}</p>
          {project && source !== "all" && <p className="hint">按文字特征筛选；纯汉字可能同时用于中文和日文。切换语言不会删除提取结果或译文。</p>}
          {needsScan && <p className="hint">提取方式或扫描选项已变化，需要重新扫描；一键流程会自动重新提取并保留匹配译文。</p>}
          {includeCode && <p className="hint">代码字面量可能包含程序标识；请取消不应翻译的条目，错误修改可能使游戏无法运行。</p>}
        </>}
        {activeStep === 2 && <>
          <div className="unity-offline-fields">
            <label>翻译方式<select value={translationKind} disabled={parametersLocked} onChange={e => setTranslationKind(e.target.value as "llm" | "engine")}><option value="llm">大模型</option><option value="engine">翻译引擎</option></select></label>
            {translationKind === "llm" ? <span className="unity-offline-model">通用模型 <strong>{settings.model || "未配置"}</strong></span> : <label>翻译引擎<select value={engine} disabled={parametersLocked} onChange={e => setEngine(e.target.value as TranslateProvider)}>{classicEngines(TRANSLATE_ENGINES).map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>}
            <label>目标语言<select value={target} disabled={parametersLocked} onChange={e => { setTarget(e.target.value); invalidatePatch(); }}>{UNITY_LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}</select></label>
            {onOpenGeneralSettings && <button className="unity-btn" disabled={!!busy} onClick={onOpenGeneralSettings}>通用设置</button>}
            <button className="unity-btn unity-btn-primary" disabled={locked || !scanReady || !selected.length || !connectionReady || applied} onClick={() => void operation("翻译中", () => runWorkflow(2, 2), true)}>翻译所选 / 继续</button>
          </div>
          <p className={connectionReady ? "hint" : "unity-offline-error"}>{translationKind === "llm" ? "模型、API 地址与密钥使用设置 → 通用中的当前配置。" : engineConfigured ? "引擎凭证与代理使用设置 → 通用中的配置。" : "所选引擎尚未配置凭证，请前往通用设置配置。"}</p>
          <p className="hint">{scanReady ? `原文范围：${scope.label}，已选 ${selected.length} 条。仅处理未完成文本，已有译文保留。` : "请先完成扫描，再执行此步；可以提前配置翻译参数。"}</p>
        </>}
        {activeStep === 3 && <>
          <div className="unity-offline-font"><label>UGUI 替换字体<input value={fontPath} readOnly placeholder="可选 TTF / OTF；生成时检查缺字" /></label><button className="unity-btn" disabled={parametersLocked} onClick={() => void operation("选择字体", async () => { const path = await open({ filters: [{ name: "字体", extensions: ["ttf", "otf"] }] }); if (typeof path === "string") { setFontPath(path); invalidatePatch(); } })}>选择字体</button>{fontPath && <button className="unity-btn" disabled={parametersLocked} onClick={() => { setFontPath(""); invalidatePatch(); }}>取消替换</button>}
            <button className="unity-btn unity-btn-primary" disabled={locked || !translationReady || applied} onClick={() => void operation("生成补丁", () => runWorkflow(3, 3), true)}>生成补丁</button>
          </div>
          <div className="unity-offline-output"><span>工作目录</span><code title={workRoot}>{workRoot || "正在加载游戏工作目录"}</code></div>
          <p className="hint">{translationReady ? `为当前 ${scope.label} 范围生成资源补丁，并保留对应原件备份。` : "请先完成所选文本的翻译，再执行此步；可以提前选择字体。"} 字体替换仅支持已识别的 UGUI 字体，不自动生成 TMP / NGUI 图集。</p>
        </>}
        {activeStep === 4 && <>
          <div className="unity-offline-output"><span>应用位置</span><code title={root}>{root}</code><button className="unity-btn unity-btn-primary" disabled={locked || !patch || applied} onClick={() => void operation("应用到游戏", () => runWorkflow(4, 4), true)}>{applied ? "已应用到游戏" : "应用到游戏"}</button></div>
          <p className="hint">{patch ? "请先关闭游戏。应用前检查进程及原件、补丁哈希，保留备份；写入失败时回滚。" : "请先生成补丁，再执行此步。应用前会检查游戏进程和文件变化，并保留原件备份。"}</p>
        </>}
      </div>
      {generation && <div className="unity-step-progress">
      <div className="unity-generation-status" role="status"><strong>第 {generation.step} / 4 步 · {GENERATION_STEPS[generation.step - 1]}{generation.state === "done" ? " · 已完成" : generation.state === "stopped" ? " · 已中止" : generation.state === "error" ? " · 失败" : ""}</strong><span>{progressPercent === null ? busy ? "正在准备…" : generation.state === "error" ? "未开始" : "等待恢复" : `${progressPercent}% · ${generation.completed} / ${generation.total} ${progressUnit}`}</span>{busy && abort.current ? <button className="unity-btn" onClick={stop} disabled={abort.current.signal.aborted}>中止</button> : !busy && resumable && <button className="unity-btn" onClick={resumeTask} disabled={restoring}>{generation.state === "error" && progressPercent === null ? "重试" : "恢复"}{checkpoint.automatic ? "一键流程" : GENERATION_STEPS[checkpoint.step - 1]}</button>}</div>
      <div key={generation.step} className={`unity-progress-track${progressRunning ? " is-running" : ""}${progressPercent === null ? " is-indeterminate" : ""}`} role="progressbar" aria-label="当前步骤进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent ?? undefined} aria-valuetext={progressPercent === null ? progressRunning ? "正在准备，暂未取得总量" : "未获得进度" : `${progressPercent}%`}>
        <div className="unity-progress-fill" style={{ width: `${progressPercent ?? 0}%` }} />
      </div>
      {generation.state === "error" ? errorPanel : <p title={generation.detail}>{generation.detail}</p>}
      {!busy && resumable && generation.step < 4 && <button className="unity-btn" onClick={finishTask}>结束本次流程</button>}
      {generation.step === 4 && generation.state !== "done" && <p className="unity-offline-error">应用尚未完成，请勿启动游戏。恢复后继续写入，原件保存在补丁目录的 original 文件夹。</p>}
      </div>}
    </section>
    {generation?.state !== "error" && errorPanel}
    {projectDetails}
    </aside>
    <button className="unity-workspace-divider" role="separator" aria-orientation="vertical" aria-label="调整步骤区和结果区宽度" aria-valuenow={Math.round(panelWidth.width)} onMouseDown={e => panelWidth.beginResize(e, "grow-right")} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); panelWidth.setWidth(panelWidth.width + (e.key === "ArrowRight" ? 16 : -16)); } }} />
    <section className="unity-offline-workbench">
      <div className="unity-offline-toolbar">
        <strong>文本与译文{project ? ` · ${scope.label} ${scope.count} 条` : ""}</strong>
        <input type="search" aria-label="搜索原文和译文" placeholder="搜索" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} />
        <span>{selected.length} 条已选 · {done} 条可回写</span>
        <button className="unity-btn" disabled={!!busy || !project} onClick={() => void operation("保存工程", async () => { await save(); setMessage("工程已保存"); })}>{dirty ? "保存工程 *" : "保存工程"}</button>
      </div>
      {!project ? <div className="unity-offline-empty">{restoring ? "正在加载当前游戏的保存工程…" : "当前游戏还没有可用的保存文本。点击‘一键生成并应用’即可自动提取、翻译和应用；工程与进度会自动保存。"}</div> : <>
        <div className="unity-offline-table-scroll"><table ref={tableRef} className="unity-offline-table" style={{ minWidth: Math.max(560, (sourceWidth.width + 212) / (1 - originalRatio / 100)), "--unity-original-width": `${originalRatio}%` } as CSSProperties}><colgroup><col style={{ width: 32 }} /><col style={{ width: sourceWidth.width }} /><col style={{ width: "var(--unity-original-width)" }} /><col /></colgroup><thead><tr>
          <th><input type="checkbox" aria-label="选取全部搜索结果" disabled={entriesLocked || applied || !filtered.length} checked={filtered.length > 0 && filtered.every(e => e.selected)} onChange={e => { const ids = new Set(filtered.map(r => r.id)); const checked = e.target.checked; setProject({ ...project, entries: project.entries.map(r => ids.has(r.id) ? { ...r, selected: checked } : r) }); setDirty(true); invalidatePatch(); }} /></th>
          <th className="unity-resizable-column">来源<button className="unity-column-divider" role="separator" aria-orientation="vertical" aria-label="调整来源列宽" aria-valuenow={Math.round(sourceWidth.width)} onMouseDown={e => sourceWidth.beginResize(e, "grow-right")} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); sourceWidth.setWidth(sourceWidth.width + (e.key === "ArrowRight" ? 8 : -8)); } }} /></th>
          <th className="unity-resizable-column">原文<button className="unity-column-divider" role="separator" aria-orientation="vertical" aria-label="调整原文和译文列宽" aria-valuenow={Math.round(originalRatio)} onPointerDown={e => { e.preventDefault(); columnDrag.current = { x: e.clientX, ratio: originalRatio, latest: originalRatio, width: tableRef.current!.getBoundingClientRect().width }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { const drag = columnDrag.current; if (!drag) return; drag.latest = Math.max(20, Math.min(70, drag.ratio + (e.clientX - drag.x) / drag.width * 100)); tableRef.current?.style.setProperty("--unity-original-width", `${drag.latest}%`); }} onPointerUp={finishColumnDrag} onPointerCancel={finishColumnDrag} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const ratio = Math.max(20, Math.min(70, originalRatio + (e.key === "ArrowRight" ? 2 : -2))); setOriginalRatio(ratio); localStorage.setItem("unity-offline-original-ratio", String(ratio)); } }} /></th><th>译文</th>
        </tr></thead><tbody>{rows.map(entry => <tr key={entry.id} className={entry.error ? "has-error" : ""}>
          <td><input type="checkbox" aria-label={`选择第 ${entry.id} 条`} disabled={entriesLocked || applied} checked={entry.selected} onChange={e => update(entry.id, { selected: e.target.checked })} /></td>
          <td title={`${entry.file}\n${entry.container}\n${entry.locator}`}><span>{entry.kind}</span><small>{entry.file.split(/[\\/]/).pop()} · #{entry.objectId === "0" ? entry.id : entry.objectId}</small></td>
          <td className="unity-offline-source"><div className="unity-source-text" title={entry.source}>{entry.source}</div></td>
          <td><div className="unity-entry-editor"><textarea aria-label={`第 ${entry.id} 条译文`} value={entry.translation} disabled={entriesLocked || applied} rows={1} onChange={e => update(entry.id, { translation: e.target.value })} />{(entry.error || entry.translation && unityTranslationError(entry.source, entry.translation)) && <button className="unity-row-error" title={entry.error ? explainUnityFailure(entry.error).reason : unityTranslationError(entry.source, entry.translation)} aria-label={`第 ${entry.id} 条错误详情`} onClick={() => setRowIssue({ ...entry, error: entry.error || unityTranslationError(entry.source, entry.translation) })}>!</button>}</div></td>
        </tr>)}</tbody></table>{!filtered.length && <p className="hint">当前语言或搜索范围内没有文本，可在扫描步骤切换原文语言或选择全部语言查看。</p>}</div>
        <div className="unity-offline-pagination"><button className="unity-btn" disabled={page <= 0} onClick={() => setPage(p => p - 1)}>上一页</button><span>{Math.min(page + 1, pageCount)} / {pageCount}</span><button className="unity-btn" disabled={page + 1 >= pageCount} onClick={() => setPage(p => p + 1)}>下一页</button></div>
      </>}
      {rowIssue && <div className="unity-row-error-panel" role="dialog" aria-label={`第 ${rowIssue.id} 条错误详情`}><button className="unity-btn" onClick={() => setRowIssue(null)}>关闭</button><strong>第 {rowIssue.id} 条处理失败</strong><p>{explainUnityFailure(rowIssue.error).reason}</p><p>{explainUnityFailure(rowIssue.error).action}</p><details><summary>技术详情</summary><pre>{rowIssue.error}</pre></details></div>}
    </section>
  </div>;
});
