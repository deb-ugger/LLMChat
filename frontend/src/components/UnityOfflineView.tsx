import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { open as openPath } from "@tauri-apps/plugin-shell";
import { api, type Settings, type TranslateProvider, type UnityGameInfo } from "../api";
import { TRANSLATE_ENGINES, classicEngines, engineReady, parseEngineKeys } from "../translateEngines";
import { buildUnityTranslateOptions, sameUnityGamePath, UNITY_LANGUAGES } from "../unityTranslation";
import { UnityPaused, unityOutputDirectory, unityRun, unityTranslationError, type UnityPatch, type UnityProgress, type UnityProject } from "../unityOffline";
import "../unityOffline.css";

export type UnityOfflineHandle = { prepareToLeave: () => Promise<boolean> };
const GENERATION_STEPS = ["扫描资源", "翻译文本", "生成补丁", "应用到游戏"];
type GenerationProgress = UnityProgress & { step: number; state: "running" | "done" | "stopped" | "error" };
type RunCheckpoint = {
  step: number; endStep: number; automatic: boolean; finished: boolean;
  projectFolder: string; scanFolder: string; patchFolder: string; patch: UnityPatch | null;
  translationKind: "llm" | "engine"; engine: TranslateProvider; source: string; target: string; includeCode: boolean; fontPath: string;
  progress: GenerationProgress;
};
type Props = {
  active: boolean; game: UnityGameInfo | null; settings: Settings;
  onOpenGeneralSettings?: () => void;
  onBusyChange?: (busy: boolean) => void;
};
export const UnityOfflineView = forwardRef<UnityOfflineHandle, Props>(function UnityOfflineView({ active, game, settings, onOpenGeneralSettings, onBusyChange }, ref) {
  const root = game?.gameDir || "";
  const [output, setOutput] = useState("");
  const [project, setProject] = useState<UnityProject | null>(null);
  const [translationKind, setTranslationKind] = useState<"llm" | "engine">("llm");
  const [engine, setEngine] = useState<TranslateProvider>("bing");
  const [source, setSource] = useState("auto");
  const [target, setTarget] = useState("zh-CN");
  const [includeCode, setIncludeCode] = useState(false);
  const [autoExport, setAutoExport] = useState(true);
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
  const checkpointKey = "llmchat-unity-run:" + root.toLowerCase();
  const remember = (value: RunCheckpoint) => {
    localStorage.setItem(checkpointKey, JSON.stringify(value));
    checkpointRef.current = value; setCheckpoint(value); setGeneration(value.progress);
  };
  const abort = useRef<AbortController | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const closing = useRef(false);
  const status = useRef({ busy, dirty }); status.current = { busy, dirty };
  const latest = useRef(project); latest.current = project;
  const publish = (value: UnityProject) => { latest.current = value; setProject(value); };

  useEffect(() => {
    if (!active || !isTauri()) return;
    void unityOutputDirectory().then(setOutput).catch(e => setError(String(e)));
  }, [active]);
  useEffect(() => {
    setProject(null); setPatch(null); setDirty(false); setPage(0); setSearch("");
    setError(""); setMessage(""); setFontPath("");
    setGeneration(null); setApplied(false);
    setCheckpoint(null); checkpointRef.current = null;
    let cancelled = false;
    const saved = localStorage.getItem(checkpointKey);
    if (!root || !saved) { setRestoring(false); return; }
    setRestoring(true);
    void (async () => {
      try {
        const value: RunCheckpoint = JSON.parse(saved);
        const folder = value.projectFolder || value.scanFolder;
        const p = folder ? await unityRun<UnityProject>("load", { path: folder + "/unity-project.json" }) : null;
        if (cancelled) return;
        if (p && !sameUnityGamePath(p.root, root)) throw new Error("检查点不属于当前游戏");
        setProject(p); setPatch(value.patch); setApplied(value.finished && value.endStep === 4);
        setTranslationKind(value.translationKind); setEngine(value.engine); setSource(value.source); setTarget(value.target); setIncludeCode(value.includeCode); setFontPath(value.fontPath);
        if (!value.finished) value.progress.state = "stopped";
        checkpointRef.current = value; setCheckpoint(value); setGeneration(value.progress);
        if (!value.finished) setMessage("发现未完成任务，点击恢复可从检查点继续。");
      } catch (e) { if (!cancelled) setError(`恢复检查点失败：${String(e)}。工程和补丁文件仍保留，请检查路径或重新打开工程。`); }
      finally { if (!cancelled) setRestoring(false); }
    })();
    return () => { cancelled = true; };
  }, [root]);
  useEffect(() => { onBusyChange?.(!!busy); }, [busy, onBusyChange]);
  useImperativeHandle(ref, () => ({ prepareToLeave: async () => {
    if (busy || running.current) { setError("请先停止翻译或等待当前处理完成后切换"); return false; }
    return dirty ? operation("保存工程", () => save()) : true;
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
        await getCurrentWindow().destroy();
      } catch (e) { setError(`退出失败，窗口已保留：${String(e)}`); }
      finally { closing.current = false; }
    }).then(fn => { if (cancelled) fn(); else dispose = fn; }).catch(e => setError(String(e)));
    return () => { cancelled = true; dispose?.(); };
  }, [active, needsCloseHandler]);

  const selected = project?.entries.filter(e => e.selected) || [];
  const engineConfigured = engineReady(parseEngineKeys(settings.translateEngineKeys), engine);
  const connectionReady = translationKind === "llm" ? !!settings.model.trim() && !!settings.apiUrl.trim() : engineConfigured;
  const done = selected.filter(e => e.translation && !unityTranslationError(e.source, e.translation)).length;
  const filtered = useMemo(() => project?.entries.filter(e => !search || `${e.source}\n${e.translation}\n${e.file}`.toLowerCase().includes(search.toLowerCase())) || [], [project, search]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 40));
  const rows = filtered.slice(Math.min(page, pageCount - 1) * 40, (Math.min(page, pageCount - 1) + 1) * 40);
  const update = (id: string, value: Partial<UnityProject["entries"][number]>) => {
    setProject(p => p ? { ...p, entries: p.entries.map(e => e.id === id ? { ...e, ...value, error: "" } : e) } : p);
    setDirty(true); setPatch(null);
  };
  async function operation(label: string, task: () => Promise<void>, keepProgress = true) {
    if (running.current) return false;
    if (!keepProgress) setGeneration(null);
    setBusy(label); setError(""); setMessage("");
    const work = task(); running.current = work;
    try { await work; return true; } catch (e) { setError(String(e instanceof Error ? e.message : e)); setGeneration(p => p ? { ...p, state: "error" } : p); return false; }
    finally { running.current = null; setBusy(""); }
  }
  const canReplace = () => !dirty || window.confirm("当前工程有未保存的修改，是否放弃并打开其他工程？");
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
    return buildUnityTranslateOptions(general, provider, run?.source || source, run?.target || target);
  }
  async function scan(onProgress?: (value: UnityProgress) => void, signal?: AbortSignal, run?: RunCheckpoint) {
    const p = await unityRun<UnityProject>("scan", { root, outputRoot: output, includeCode: run?.includeCode ?? includeCode, path: run?.scanFolder || "" }, onProgress, signal);
    publish(p); setPage(0); setDirty(false); setPatch(null); setApplied(false);
    setMessage(`扫描完成：${p.entries.length} 条文本，${p.fonts.length} 个字体`);
    return p;
  }
  async function translateProject(p: UnityProject, controller: AbortController, options: Awaited<ReturnType<typeof translationOptions>>, onProgress?: (value: UnityProgress) => void) {
    const next = structuredClone(p);
    setDirty(true);
    const cache = new Map<string, string>();
    for (const entry of next.entries) if (entry.translation && !unityTranslationError(entry.source, entry.translation)) cache.set(entry.source, entry.translation);
    const selectedEntries = next.entries.filter(e => e.selected);
    const pending = selectedEntries.filter(e => !e.translation || unityTranslationError(e.source, e.translation));
    let count = selectedEntries.length - pending.length;
    onProgress?.({ detail: "正在翻译所选文本", completed: count, total: selectedEntries.length });
    try {
      for (const entry of pending) {
        if (controller.signal.aborted) break;
        onProgress?.({ detail: `翻译第 ${count + 1} 条：${entry.file}`, completed: count, total: selectedEntries.length });
        try {
          let text = cache.get(entry.source);
          if (!text) {
            const response = await api.translate(entry.source, { signal: controller.signal }, options);
            if (!response.ok) throw new Error(response.code || "翻译请求失败");
            text = response.translation;
            const problem = unityTranslationError(entry.source, text);
            if (problem) throw new Error(problem);
            cache.set(entry.source, text);
          }
          entry.translation = text; entry.error = "";
        } catch (e) {
          if (controller.signal.aborted) break;
          entry.error = String(e instanceof Error ? e.message : e);
        }
        count++;
        await unityRun("save", { project: next });
        publish({ ...next, entries: [...next.entries] });
        setMessage(`已处理 ${count} 条；成功结果会保存，可继续翻译剩余文本`);
        onProgress?.({ detail: `已处理 ${count} 条文本`, completed: count, total: selectedEntries.length });
      }
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
    const result = await unityRun<UnityPatch>("export", { project: p, fontPath: run?.fontPath ?? fontPath, path: run?.patchFolder || "" }, onProgress, signal);
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
      translationKind, engine, source, target, includeCode, fontPath,
      progress: { step: startStep, state: "running", detail: "准备处理", completed: 0, total: null },
    };
    const report = (progress: UnityProgress) => {
      if (progress.total === null && run.progress.step === run.step && run.progress.total !== null)
        progress = { ...progress, completed: run.progress.completed, total: run.progress.total };
      if (progress.folder) {
        if (run.step === 1) run.scanFolder = progress.folder;
        if (run.step === 3) run.patchFolder = progress.folder;
      }
      run = { ...run, progress: { ...progress, step: run.step, state: "running" } }; remember(run);
    };
    try {
      remember(run);
      let p = project;
      for (let index = run.step; index <= endStep; index++) {
        run.step = index; setBusy(GENERATION_STEPS[index - 1]);
        report({ detail: `准备${GENERATION_STEPS[index - 1]}`, completed: 0, total: null });
        if (controller.signal.aborted) throw new UnityPaused("");
        if (index === 1) {
          const reuse = run.projectFolder && !run.scanFolder && p;
          p = reuse || await scan(report, controller.signal, run);
          run.projectFolder = p.folder; run.scanFolder = "";
          if (reuse) report({ detail: `复用当前工程：${p.entries.length} 条文本，保留选取和已有译文`, completed: 1, total: 1 });
        } else if (index === 2) {
          if (!p?.entries.some(e => e.selected)) throw new Error("没有可翻译的所选文本，请查看扫描提示或选择文本");
          p = await translateProject(p, controller, await translationOptions(run), report);
          if (controller.signal.aborted) throw new UnityPaused("");
          const failed = p.entries.filter(e => e.selected && unityTranslationError(e.source, e.translation));
          if (failed.length) throw new Error(`${failed.length} 条译文失败或未通过校验，工程已保存；修正或恢复后重试，不会继续应用`);
        } else if (index === 3) {
          if (!p) throw new Error("请先扫描或打开工程");
          const result = await exportPatch(p, report, controller.signal, run);
          run.patch = result; run.patchFolder = result.folder;
        } else {
          if (!run.patch) throw new Error("请先生成补丁");
          await applyPatch(run.patch, report, controller.signal);
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
        if (run.step === 1 && run.scanFolder) publish(await unityRun<UnityProject>("load", { path: run.scanFolder + "/unity-project.json" }));
        setMessage(run.step === 4 ? "应用已中止，部分文件可能已写入。请勿启动游戏，恢复后继续应用。原件备份已保留。" : "任务已中止，检查点已保存，点击恢复继续未完成部分。");
      } else { run.progress = { ...run.progress, state: "error" }; remember(run); throw e; }
    } finally { abort.current = null; }
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
  return <div className="unity-offline">
    <section className="unity-offline-options">
      <div className="unity-offline-path">
        <button className="unity-btn unity-btn-primary" disabled={!!busy || restoring || !root || !output || (!resumable || checkpoint.step <= 2) && !connectionReady || applied} onClick={() => void operation("一键生成", () => runWorkflow(1, 4, resumable), true)}>{applied ? "已应用到游戏" : resumable && checkpoint.automatic ? "恢复一键生成" : "一键生成并应用"}</button>
        <button className="unity-btn" disabled={locked || !root || !output} onClick={() => { if (!canReplace()) return; void operation("扫描资源", () => runWorkflow(1, 1), true); }}>扫描资源</button>
        <button className="unity-btn" disabled={locked || !game} onClick={() => { if (!canReplace()) return; void operation("打开工程", async () => { const path = await open({ filters: [{ name: "嵌字工程", extensions: ["json"] }] }); if (typeof path !== "string") return; const p = await unityRun<UnityProject>("load", { path }); if (!sameUnityGamePath(p.root, root)) throw new Error("此工程不属于当前游戏，请返回游戏列表选择对应游戏后再打开"); publish(p); setPage(0); setDirty(false); setPatch(null); setApplied(false); localStorage.removeItem(checkpointKey); setCheckpoint(null); checkpointRef.current = null; }); }}>打开工程</button>
        <span className="hint">扫描 → 翻译 → 生成补丁 → 应用到游戏；请先关闭游戏，原件自动备份。</span>
      </div>
      <div className="unity-offline-fields">
        <label>翻译方式<select value={translationKind} disabled={locked} onChange={e => setTranslationKind(e.target.value as "llm" | "engine")}><option value="llm">大模型</option><option value="engine">翻译引擎</option></select></label>
        {translationKind === "llm" ? <span className="unity-offline-model">通用模型 <strong>{settings.model || "未配置"}</strong></span> : <label>翻译引擎<select value={engine} disabled={locked} onChange={e => setEngine(e.target.value as TranslateProvider)}>{classicEngines(TRANSLATE_ENGINES).map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>}
        <label>原文语言<select value={source} disabled={locked} onChange={e => setSource(e.target.value)}><option value="auto">自动检测</option><option value="en">英语</option><option value="ja">日语</option><option value="ko">韩语</option><option value="zh">中文</option></select></label>
        <label>目标语言<select value={target} disabled={locked} onChange={e => setTarget(e.target.value)}>{UNITY_LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}</select></label>
        <label className="unity-offline-check"><input type="checkbox" disabled={locked} checked={includeCode} onChange={e => setIncludeCode(e.target.checked)} />扫描代码字面量</label>
        <label className="unity-offline-check"><input type="checkbox" disabled={locked} checked={autoExport} onChange={e => setAutoExport(e.target.checked)} />翻译完成后生成补丁</label>
        {onOpenGeneralSettings && <button className="unity-btn" disabled={!!busy} onClick={onOpenGeneralSettings}>通用设置</button>}
      </div>
      <p className={connectionReady ? "hint" : "unity-offline-error"}>{translationKind === "llm" ? "模型、API 地址与密钥使用设置 → 通用中的当前配置。" : engineConfigured ? "引擎凭证与网络代理使用设置 → 通用中的配置。" : "所选引擎尚未配置凭证，请先前往设置 → 通用 → 翻译引擎配置。"}</p>
      {includeCode && <p className="hint">代码字面量可能包含程序标识；请取消不应翻译的条目，错误修改可能使游戏无法运行。</p>}
      <div className="unity-offline-output"><span>输出目录</span><code title={output}>{output || "请在桌面应用中使用"}</code></div>
    </section>
    {generation && <section className={`unity-generation ${generation.state}`} aria-label="一键生成进度">
      <ol>{GENERATION_STEPS.map((label, index) => <li key={label} className={index + 1 === generation.step ? "current" : index + 1 < generation.step ? "complete" : ""} aria-current={index + 1 === generation.step ? "step" : undefined}>{index + 1}. {label}</li>)}</ol>
      <div className="unity-generation-status" role="status"><strong>第 {generation.step} / 4 步 · {GENERATION_STEPS[generation.step - 1]}{generation.state === "done" ? " · 已完成" : generation.state === "stopped" ? " · 已中止" : generation.state === "error" ? " · 失败" : ""}</strong><span>{progressPercent === null ? busy ? "正在准备…" : "等待恢复" : `${progressPercent}% · ${generation.completed} / ${generation.total} ${progressUnit}`}</span>{busy && abort.current ? <button className="unity-btn" onClick={stop} disabled={abort.current.signal.aborted}>中止</button> : !busy && resumable && <button className="unity-btn" onClick={resumeTask} disabled={restoring}>恢复{checkpoint.automatic ? "一键流程" : GENERATION_STEPS[checkpoint.step - 1]}</button>}</div>
      <progress aria-label="当前步骤进度" max={generation.total || 1} value={generation.total === null ? undefined : generation.completed} />
      <p title={generation.detail}>{generation.detail}</p>
      {!busy && resumable && generation.step < 4 && <button className="unity-btn" onClick={finishTask}>结束本次流程</button>}
      {generation.step === 4 && generation.state !== "done" && <p className="unity-offline-error">应用尚未完成，请勿启动游戏。恢复后继续写入，原件保存在补丁目录的 original 文件夹。</p>}
    </section>}
    <section className="unity-offline-workbench">
      <div className="unity-offline-toolbar">
        <strong>文本与译文{project ? ` · ${project.entries.length} 条` : ""}</strong>
        <input type="search" aria-label="搜索原文和译文" placeholder="搜索" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} />
        <span>{selected.length} 条已选 · {done} 条可回写</span>
        <button className="unity-btn" disabled={!!busy || !project} onClick={() => void operation("保存工程", async () => { await save(); setMessage("工程已保存"); })}>{dirty ? "保存工程 *" : "保存工程"}</button>
        <button className="unity-btn unity-btn-primary" disabled={locked || !selected.length || !connectionReady || applied} onClick={() => void operation("翻译中", () => runWorkflow(2, autoExport ? 3 : 2), true)}>{autoExport ? "翻译并生成补丁" : "翻译所选 / 继续"}</button>
      </div>
      {!project ? <div className="unity-offline-empty">扫描当前游戏的资源，或打开该游戏已保存的嵌字工程。补丁独立输出，不直接修改游戏。</div> : <>
        <div className="unity-offline-table-scroll"><table className="unity-offline-table"><thead><tr>
          <th><input type="checkbox" aria-label="选取全部搜索结果" disabled={entriesLocked || applied || !filtered.length} checked={filtered.length > 0 && filtered.every(e => e.selected)} onChange={e => { const ids = new Set(filtered.map(r => r.id)); const checked = e.target.checked; setProject({ ...project, entries: project.entries.map(r => ids.has(r.id) ? { ...r, selected: checked } : r) }); setDirty(true); setPatch(null); }} /></th>
          <th>来源</th><th>原文</th><th>译文</th>
        </tr></thead><tbody>{rows.map(entry => <tr key={entry.id} className={entry.error ? "has-error" : ""}>
          <td><input type="checkbox" aria-label={`选择第 ${entry.id} 条`} disabled={entriesLocked || applied} checked={entry.selected} onChange={e => update(entry.id, { selected: e.target.checked })} /></td>
          <td title={`${entry.file}\n${entry.container}\n${entry.locator}`}><span>{entry.kind}</span><small>{entry.file.split(/[\\/]/).pop()}</small><small>#{entry.objectId === "0" ? entry.id : entry.objectId}</small></td>
          <td className="unity-offline-source">{entry.source}</td>
          <td><textarea aria-label={`第 ${entry.id} 条译文`} value={entry.translation} disabled={entriesLocked || applied} rows={2} onChange={e => update(entry.id, { translation: e.target.value })} />{(entry.error || entry.translation && unityTranslationError(entry.source, entry.translation)) && <small className="unity-offline-error">{entry.error || unityTranslationError(entry.source, entry.translation)}</small>}</td>
        </tr>)}</tbody></table>{!filtered.length && <p className="hint">没有符合条件的文本。请查看下方扫描提示。</p>}</div>
        <div className="unity-offline-pagination"><button className="unity-btn" disabled={page <= 0} onClick={() => setPage(p => p - 1)}>上一页</button><span>{Math.min(page + 1, pageCount)} / {pageCount}</span><button className="unity-btn" disabled={page + 1 >= pageCount} onClick={() => setPage(p => p + 1)}>下一页</button></div>
      </>}
    </section>
    <section className="unity-offline-footer">
      <div className="unity-offline-font"><label>UGUI 替换字体<input value={fontPath} readOnly placeholder="可选 TTF / OTF；生成时检查缺字" /></label><button className="unity-btn" disabled={locked || applied} onClick={() => void operation("选择字体", async () => { const path = await open({ filters: [{ name: "字体", extensions: ["ttf", "otf"] }] }); if (typeof path === "string") { setFontPath(path); setPatch(null); } })}>选择字体</button>{fontPath && <button className="unity-btn" disabled={locked || applied} onClick={() => setFontPath("")}>取消替换</button>}
        <button className="unity-btn unity-btn-primary" disabled={locked || !selected.length || done !== selected.length || applied} onClick={() => void operation("生成补丁", () => runWorkflow(3, 3), true)}>生成补丁</button>
        {patch && <button className="unity-btn" disabled={locked || applied} onClick={() => void operation("应用到游戏", () => runWorkflow(4, 4), true)}>{applied ? "已应用到游戏" : "应用到游戏"}</button>}
      </div>
      {project && <details><summary>字体与扫描提示 · {project.fonts.length} 个字体 / {project.warnings.length} 条提示</summary><div className="unity-offline-report">{project.fonts.map((f, i) => <p key={i}>{f.name} · {f.kind} · {f.file}</p>)}{project.warnings.map((w, i) => <p key={`w${i}`}>{w}</p>)}</div></details>}
      {busy && <p role="status">{busy}…</p>}{error && <p role="alert" className="unity-offline-error">{error}</p>}{message && <p role="status">{message}</p>}
      {project && <div className="unity-offline-output"><span>工程位置</span><code title={project.folder}>{project.folder}</code><button className="unity-btn" onClick={() => void openPath(project.folder).catch(e => setError(String(e)))}>打开工程目录</button></div>}
      {patch && <button className="unity-btn" onClick={() => void openPath(patch.folder).catch(e => setError(String(e)))}>打开补丁目录</button>}
    </section>
  </div>;
});
