import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { open as openPath } from "@tauri-apps/plugin-shell";
import { api, type Settings, type TranslateProvider, type UnityGameInfo } from "../api";
import { TRANSLATE_ENGINES, classicEngines, engineReady, parseEngineKeys } from "../translateEngines";
import { buildUnityTranslateOptions, sameUnityGamePath, UNITY_LANGUAGES } from "../unityTranslation";
import { unityOutputDirectory, unityRun, unityTranslationError, type UnityPatch, type UnityProject } from "../unityOffline";
import "../unityOffline.css";

export type UnityOfflineHandle = { prepareToLeave: () => Promise<boolean> };
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
  const hasProject = project !== null;
  useEffect(() => {
    if (!active || !hasProject || !isTauri()) return;
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
  }, [active, hasProject]);

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
  async function operation(label: string, task: () => Promise<void>) {
    setBusy(label); setError(""); setMessage("");
    const work = task(); running.current = work;
    try { await work; return true; } catch (e) { setError(String(e instanceof Error ? e.message : e)); return false; }
    finally { running.current = null; setBusy(""); }
  }
  const canReplace = () => !dirty || window.confirm("当前工程有未保存的修改，是否放弃并打开其他工程？");
  async function save(p = latest.current) {
    if (!p) return;
    await unityRun("save", { project: p });
    if (latest.current === p) setDirty(false);
  }
  async function translate() {
    if (!project) return;
    const controller = new AbortController(); abort.current = controller;
    const general = await api.getSettings();
    const provider = translationKind === "llm" ? "llm" : engine;
    if (provider !== "llm" && !engineReady(parseEngineKeys(general.translateEngineKeys), provider))
      throw new Error("请先在设置 → 通用 → 翻译引擎中配置所选引擎的凭证");
    const options = buildUnityTranslateOptions(general, provider, source, target);
    const next = structuredClone(project);
    setDirty(true);
    const cache = new Map<string, string>();
    for (const entry of next.entries) if (entry.translation && !unityTranslationError(entry.source, entry.translation)) cache.set(entry.source, entry.translation);
    let count = 0;
    try {
      for (const entry of next.entries.filter(e => e.selected && (!e.translation || unityTranslationError(e.source, e.translation)))) {
        if (controller.signal.aborted) break;
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
        publish({ ...next, entries: [...next.entries] });
        setMessage(`已处理 ${count} 条；成功结果会保存，可继续翻译剩余文本`);
        if (count % 10 === 0) await unityRun("save", { project: next });
      }
    } finally {
      const final = { ...next, entries: [...next.entries] };
      publish(final);
      await save(final); abort.current = null;
      setMessage(controller.signal.aborted ? "已停止，已保存完成的译文" : "本轮翻译已结束，可检查译文后生成补丁");
    }
    if (autoExport && !controller.signal.aborted && next.entries.filter(e => e.selected).every(e => !unityTranslationError(e.source, e.translation))) {
      setBusy("生成补丁");
      const result = await unityRun<UnityPatch>("export", { project: next, fontPath });
      setPatch(result);
      setMessage(`已完成翻译并生成 ${result.files} 个补丁文件，回写 ${result.entries} 条译文、替换 ${result.fontReplacements} 个 UGUI 字体；尚未验证游戏显示。`);
    }
  }
  return <div className="unity-offline">
    <section className="unity-offline-options">
      <div className="unity-offline-path">
        <button className="unity-btn unity-btn-primary" disabled={!!busy || !root || !output} onClick={() => { if (!canReplace()) return; void operation("扫描资源", async () => { const p = await unityRun<UnityProject>("scan", { root, outputRoot: output, includeCode }); publish(p); setPage(0); setDirty(false); setPatch(null); setMessage(`扫描完成：${p.entries.length} 条文本，${p.fonts.length} 个字体`); }); }}>扫描资源</button>
        <button className="unity-btn" disabled={!!busy || !game} onClick={() => { if (!canReplace()) return; void operation("打开工程", async () => { const path = await open({ filters: [{ name: "嵌字工程", extensions: ["json"] }] }); if (typeof path !== "string") return; const p = await unityRun<UnityProject>("load", { path }); if (!sameUnityGamePath(p.root, root)) throw new Error("此工程不属于当前游戏，请返回游戏列表选择对应游戏后再打开"); publish(p); setPage(0); setDirty(false); setPatch(null); }); }}>打开工程</button>
      </div>
      <div className="unity-offline-fields">
        <label>翻译方式<select value={translationKind} disabled={!!busy} onChange={e => setTranslationKind(e.target.value as "llm" | "engine")}><option value="llm">大模型</option><option value="engine">翻译引擎</option></select></label>
        {translationKind === "llm" ? <span className="unity-offline-model">通用模型 <strong>{settings.model || "未配置"}</strong></span> : <label>翻译引擎<select value={engine} disabled={!!busy} onChange={e => setEngine(e.target.value as TranslateProvider)}>{classicEngines(TRANSLATE_ENGINES).map(e => <option key={e.id} value={e.id}>{e.label}</option>)}</select></label>}
        <label>原文语言<select value={source} disabled={!!busy} onChange={e => setSource(e.target.value)}><option value="auto">自动检测</option><option value="en">英语</option><option value="ja">日语</option><option value="ko">韩语</option><option value="zh">中文</option></select></label>
        <label>目标语言<select value={target} disabled={!!busy} onChange={e => setTarget(e.target.value)}>{UNITY_LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}</select></label>
        <label className="unity-offline-check"><input type="checkbox" disabled={!!busy} checked={includeCode} onChange={e => setIncludeCode(e.target.checked)} />扫描代码字面量</label>
        <label className="unity-offline-check"><input type="checkbox" disabled={!!busy} checked={autoExport} onChange={e => setAutoExport(e.target.checked)} />翻译完成后生成补丁</label>
        {onOpenGeneralSettings && <button className="unity-btn" disabled={!!busy} onClick={onOpenGeneralSettings}>通用设置</button>}
      </div>
      <p className={connectionReady ? "hint" : "unity-offline-error"}>{translationKind === "llm" ? "模型、API 地址与密钥使用设置 → 通用中的当前配置。" : engineConfigured ? "引擎凭证与网络代理使用设置 → 通用中的配置。" : "所选引擎尚未配置凭证，请先前往设置 → 通用 → 翻译引擎配置。"}</p>
      {includeCode && <p className="hint">代码字面量可能包含程序标识；请取消不应翻译的条目，错误修改可能使游戏无法运行。</p>}
      <div className="unity-offline-output"><span>输出目录</span><code title={output}>{output || "请在桌面应用中使用"}</code></div>
    </section>
    <section className="unity-offline-workbench">
      <div className="unity-offline-toolbar">
        <strong>文本与译文{project ? ` · ${project.entries.length} 条` : ""}</strong>
        <input type="search" aria-label="搜索原文和译文" placeholder="搜索" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} />
        <span>{selected.length} 条已选 · {done} 条可回写</span>
        <button className="unity-btn" disabled={!!busy || !project} onClick={() => void operation("保存工程", async () => { await save(); setMessage("工程已保存"); })}>{dirty ? "保存工程 *" : "保存工程"}</button>
        <button className="unity-btn unity-btn-primary" disabled={!!busy || !selected.length || !connectionReady} onClick={() => void operation("翻译中", translate)}>{autoExport ? "翻译并生成补丁" : "翻译所选 / 继续"}</button>
        {busy === "翻译中" && <button className="unity-btn" onClick={() => abort.current?.abort()}>停止翻译</button>}
      </div>
      {!project ? <div className="unity-offline-empty">扫描当前游戏的资源，或打开该游戏已保存的嵌字工程。补丁独立输出，不直接修改游戏。</div> : <>
        <div className="unity-offline-table-scroll"><table className="unity-offline-table"><thead><tr>
          <th><input type="checkbox" aria-label="选取全部搜索结果" disabled={!!busy || !filtered.length} checked={filtered.length > 0 && filtered.every(e => e.selected)} onChange={e => { const ids = new Set(filtered.map(r => r.id)); const checked = e.target.checked; setProject({ ...project, entries: project.entries.map(r => ids.has(r.id) ? { ...r, selected: checked } : r) }); setDirty(true); setPatch(null); }} /></th>
          <th>来源</th><th>原文</th><th>译文</th>
        </tr></thead><tbody>{rows.map(entry => <tr key={entry.id} className={entry.error ? "has-error" : ""}>
          <td><input type="checkbox" aria-label={`选择第 ${entry.id} 条`} disabled={!!busy} checked={entry.selected} onChange={e => update(entry.id, { selected: e.target.checked })} /></td>
          <td title={`${entry.file}\n${entry.container}\n${entry.locator}`}><span>{entry.kind}</span><small>{entry.file.split(/[\\/]/).pop()}</small><small>#{entry.objectId === "0" ? entry.id : entry.objectId}</small></td>
          <td className="unity-offline-source">{entry.source}</td>
          <td><textarea aria-label={`第 ${entry.id} 条译文`} value={entry.translation} disabled={!!busy} rows={2} onChange={e => update(entry.id, { translation: e.target.value })} />{(entry.error || entry.translation && unityTranslationError(entry.source, entry.translation)) && <small className="unity-offline-error">{entry.error || unityTranslationError(entry.source, entry.translation)}</small>}</td>
        </tr>)}</tbody></table>{!filtered.length && <p className="hint">没有符合条件的文本。请查看下方扫描提示。</p>}</div>
        <div className="unity-offline-pagination"><button className="unity-btn" disabled={page <= 0} onClick={() => setPage(p => p - 1)}>上一页</button><span>{Math.min(page + 1, pageCount)} / {pageCount}</span><button className="unity-btn" disabled={page + 1 >= pageCount} onClick={() => setPage(p => p + 1)}>下一页</button></div>
      </>}
    </section>
    <section className="unity-offline-footer">
      <div className="unity-offline-font"><label>UGUI 替换字体<input value={fontPath} readOnly placeholder="可选 TTF / OTF；生成时检查缺字" /></label><button className="unity-btn" disabled={!!busy} onClick={() => void operation("选择字体", async () => { const path = await open({ filters: [{ name: "字体", extensions: ["ttf", "otf"] }] }); if (typeof path === "string") { setFontPath(path); setPatch(null); } })}>选择字体</button>{fontPath && <button className="unity-btn" disabled={!!busy} onClick={() => setFontPath("")}>取消替换</button>}
        <button className="unity-btn unity-btn-primary" disabled={!!busy || !selected.length || done !== selected.length} onClick={() => void operation("生成补丁", async () => { const result = await unityRun<UnityPatch>("export", { project, fontPath }); setPatch(result); setDirty(false); setMessage(`已生成 ${result.files} 个补丁文件，回写 ${result.entries} 条译文、替换 ${result.fontReplacements} 个 UGUI 字体；尚未验证游戏显示。`); })}>生成补丁</button>
      </div>
      {project && <details><summary>字体与扫描提示 · {project.fonts.length} 个字体 / {project.warnings.length} 条提示</summary><div className="unity-offline-report">{project.fonts.map((f, i) => <p key={i}>{f.name} · {f.kind} · {f.file}</p>)}{project.warnings.map((w, i) => <p key={`w${i}`}>{w}</p>)}</div></details>}
      {busy && <p role="status">{busy}…</p>}{error && <p role="alert" className="unity-offline-error">{error}</p>}{message && <p role="status">{message}</p>}
      {project && <div className="unity-offline-output"><span>工程位置</span><code title={project.folder}>{project.folder}</code><button className="unity-btn" onClick={() => void openPath(project.folder).catch(e => setError(String(e)))}>打开工程目录</button></div>}
      {patch && <button className="unity-btn" onClick={() => void openPath(patch.folder).catch(e => setError(String(e)))}>打开补丁目录</button>}
    </section>
  </div>;
});
