import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { copyText } from "../clipboard";
import { usePersistedSize } from "../hooks/usePersistedSize";
import { useSpeechModels, selectSpeechModel, setSpeechPreferences, getSpeechPreferences, refreshSpeechModels } from "../speech/models";
import { speechQueue, useSpeechQueue, type SpeechQueueItem } from "../speech/queue";
import { speechNative, type SpeechJobOptions } from "../speech/native";
import { SPEECH_MODELS, estimateSpeechProgress, formatSpeechTime, type SpeechCue, type SpeechModel, type SpeechFormat, type ChineseScript } from "../speech/transcription";
import { DownloadProgress } from "../speech/DownloadProgress";
import { SpeechAudioPlayer, SpeechWaveform, type SpeechPlayback } from "./SpeechAudioPlayer";
import { SpeechOnlineRunControls } from "./SpeechOnlineControls";

const labels: Record<SpeechQueueItem["status"], string> = { ready: "等待开始", queued: "排队中", running: "识别中", pausing: "暂停中", paused: "已暂停", resetting: "清理中", done: "已完成", error: "失败", cancelling: "取消中" };
const friendly = (error: unknown) => error instanceof Error ? error.message : String(error);
const speechLanguages = [["auto", "自动识别"], ["chinese", "中文"], ["english", "英语"], ["japanese", "日语"], ["korean", "韩语"], ["french", "法语"], ["german", "德语"], ["spanish", "西班牙语"], ["russian", "俄语"]];
const chineseScripts: Record<ChineseScript, string> = { simplified: "转为简体", traditional: "转为繁体", original: "不转换" };

function highlight(text: string, query: string) {
  if (!query) return text;
  const needle = query.toLowerCase(), lower = text.toLowerCase();
  const parts = [];
  let from = 0, match = lower.indexOf(needle);
  while (match >= 0) {
    parts.push(text.slice(from, match), <mark key={match}>{text.slice(match, match + query.length)}</mark>);
    from = match + query.length;
    match = lower.indexOf(needle, from);
  }
  parts.push(text.slice(from));
  return parts;
}

function TaskIcon({ action }: { action: "play" | "pause" | "trash" }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {action === "play" ? <path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none" /> : action === "pause" ? <><path d="M8 5v14M16 5v14" strokeWidth="4" /></> : <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>}
  </svg>;
}

export function SpeechRunOptions({ options }: { options?: SpeechJobOptions } = {}) {
  const { preferences: pref, selected } = useSpeechModels(false);
  const model = SPEECH_MODELS.find(model => model.id === (options?.model ?? selected))!;
  const online = (options ? options.processing?.mode : pref.mode) === "online";
  const language = !online && model.language !== "auto" ? model.language : options?.language ?? pref.language;
  const formats = options?.formats ?? pref.formats;
  return <div className="speech-processing-options">
    <label>录音语言<select title="录音中说的语言" disabled={!online && model.language !== "auto"} value={language} onChange={event => setSpeechPreferences({ language: event.target.value })}>
      {speechLanguages.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select></label>
    <label className="speech-chinese-script">中文简繁转换<output>{chineseScripts[options?.chineseScript ?? pref.chineseScript]}</output></label>
    <fieldset className="speech-format-options"><legend>输出文件</legend>{(["srt", "vtt", "txt"] as SpeechFormat[]).map(format => <label key={format}><input type="checkbox" checked={formats.includes(format)} onChange={event => setSpeechPreferences({ formats: event.target.checked ? [...pref.formats, format] : pref.formats.filter(item => item !== format) })} />{format.toUpperCase()}</label>)}</fieldset>
    {!formats.length && <p className="speech-error">至少选择一种输出格式。</p>}
  </div>;
}

export function SpeechView({ active }: { active: boolean }) {
  const models = useSpeechModels(active);
  const queue = useSpeechQueue();
  const pref = models.preferences;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [toolsReady, setToolsReady] = useState(false);
  const [clock, setClock] = useState(performance.now());
  const [page, setPage] = useState(0);
  const [view, setView] = useState<"cues" | "text">("cues");
  const [search, setSearch] = useState("");
  const query = search.trim();
  const [preview, setPreview] = useState<{ id: string; query: string; page: number; cues: SpeechCue[]; total: number } | null>(null);
  const [playback, setPlayback] = useState<SpeechPlayback | null>(null);
  const initialized = useRef(false);
  const restored = useRef(new Set<string>());
  const workspace = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(window.innerWidth - 124);
  const [height, setHeight] = useState(window.innerHeight - 36);
  const left = usePersistedSize("llmchat-speech-left", 340, 260, Math.max(260, width * .6), "x");
  const upper = usePersistedSize("llmchat-speech-options-height", 150, 96, Math.max(96, height - 240), "y");
  const currentItems = queue.items.filter(item => !item.fromHistory);
  const unfinishedItems = queue.items.filter(item => item.fromHistory);
  const selected = queue.items.find(item => item.id === selectedId) ?? currentItems[0];
  const playerItem = queue.items.find(item => item.source.path === playback?.path) ?? selected;
  const taskOptions = selected && (selected.folder || ["queued", "running", "pausing"].includes(selected.status)) ? selected.options : undefined;
  const selectedModel = taskOptions?.model ?? models.selected;
  const online = (taskOptions ? taskOptions.processing?.mode : pref.mode) === "online";
  const resultItems = currentItems.filter(item => item.folder && item.showOutput && !["cancelling", "resetting"].includes(item.status));
  const result = resultItems.find(item => item.id === selected?.id);
  const matchingPreview = preview?.id === result?.id && preview?.query === query ? preview : null;
  const resultPreview = matchingPreview?.page === page ? matchingPreview : null;
  const modelInfo = SPEECH_MODELS.find(model => model.id === selectedModel)!;
  const status = models.rows?.find(row => row.model === selectedModel);
  const running = queue.items.filter(item => item.status === "running" || item.status === "queued").length;
  const canStart = currentItems.some(item => ["ready", "paused", "error"].includes(item.status) && (item.folder || (pref.formats.length && pref.outputRoot)));
  const timing = queue.items.some(item => item.runningSince !== undefined);
  const elapsed = (item: SpeechQueueItem) => item.elapsedMs + (item.runningSince !== undefined ? Math.max(0, clock - item.runningSince) : 0);
  const remaining = (item: SpeechQueueItem) => {
    const progress = estimateSpeechProgress(item.source.duration, item.offset, item.startedOffset ?? item.offset,
      item.processingStartedAt === undefined ? 0 : Math.max(0, clock - item.processingStartedAt));
    return progress.remainingSeconds === null ? "首段完成后估算" : formatSpeechTime(progress.remainingSeconds, ".").slice(0, -4);
  };

  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { setWidth(entry.contentRect.width); setHeight(entry.contentRect.height); });
    observer.observe(element); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!active || initialized.current) return;
    initialized.current = true;
    if (!isTauri()) { setError("请在 LLMChat 桌面版中使用本地音频分段处理。"); return; }
    void speechNative.environment().then(async environment => {
      setToolsReady(environment.toolsReady);
      if (!environment.toolsReady) setError("音频解码组件缺失，请更新完整便携版。");
      const root = getSpeechPreferences().outputRoot;
      if (!root || root === environment.legacyOutputRoot) setSpeechPreferences({ outputRoot: environment.outputRoot });
      // Keep old tasks resumable without moving or rewriting their files.
      if (!restored.current.has(environment.legacyOutputRoot)) {
        restored.current.add(environment.legacyOutputRoot);
        await speechQueue.restore(environment.legacyOutputRoot);
      }
    }).catch(cause => setError(friendly(cause)));
  }, [active]);
  useEffect(() => {
    if (!active || !pref.outputRoot || restored.current.has(pref.outputRoot)) return;
    restored.current.add(pref.outputRoot);
    void speechQueue.restore(pref.outputRoot).catch(cause => { restored.current.delete(pref.outputRoot); setError(friendly(cause)); });
  }, [active, pref.outputRoot]);
  useEffect(() => { speechQueue.pump(); }, [pref.concurrency]);
  useEffect(() => {
    if (!active || !timing) return;
    const timer = window.setInterval(() => setClock(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [active, timing]);
  useEffect(() => () => speechQueue.pause(), []);
  useEffect(() => {
    if (!active || !isTauri()) return;
    let unlisten: (() => void) | undefined, disposed = false;
    void getCurrentWindow().onDragDropEvent(event => {
      if (event.payload.type === "enter" || event.payload.type === "over") setDragging(true);
      else setDragging(false);
      if (event.payload.type === "drop") void speechQueue.add(event.payload.paths);
    }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(cause => setError(friendly(cause)));
    return () => { disposed = true; unlisten?.(); };
  }, [active]);
  useEffect(() => { setPage(0); setSearch(""); }, [result?.id]);
  useEffect(() => {
    let disposed = false;
    if (!active || !result) { setPreview(null); return; }
    const id = result.id;
    void speechNative.preview(result.folder, page, query).then(preview => { if (!disposed) setPreview({ ...preview, id, query, page }); }).catch(cause => { if (!disposed) setError(friendly(cause)); });
    return () => { disposed = true; };
  }, [active, result?.id, result?.folder, result?.revision, result?.status, page, query]);

  const pickFiles = async () => {
    try {
      const paths = await openDialog({ multiple: true, directory: false, title: "添加音频文件", filters: [{ name: "音频", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "webm", "wma", "aiff", "m4b"] }] });
      if (paths) await speechQueue.add(Array.isArray(paths) ? paths : [paths]);
    } catch (cause) { setError(friendly(cause)); }
  };
  const pages = Math.max(1, Math.ceil((matchingPreview?.total ?? 0) / 100));
  const pageText = resultPreview?.cues.map(cue => cue.text).join("\n") ?? "";
  const outputItem = result ?? selected;
  const outputFolder = outputItem?.folder || pref.outputRoot;
  const selectFile = (item: SpeechQueueItem) => {
    setSelectedId(item.id);
    setPage(0); setSearch("");
  };
  const cancelFile = async (item: SpeechQueueItem) => {
    try {
      if (await confirmDialog(`确定取消“${item.source.name}”并清理生成的字幕和断点？原音频文件将保留。`, { title: "取消并清理", kind: "warning", okLabel: "确认清理", cancelLabel: "取消" })) await speechQueue.cancel(item.id);
    } catch (cause) { setError(friendly(cause)); }
  };
  const renderJob = (item: SpeechQueueItem) => <article key={item.id} className={`speech-job${selected?.id === item.id ? " is-selected" : ""}${playback?.path === item.source.path ? " is-playing" : ""}`} onClick={() => selectFile(item)}>
    <div><strong title={item.source.path}>{item.source.name}</strong><label className="speech-job-preview" onClick={event => event.stopPropagation()}><input type="checkbox" checked={item.showOutput} onChange={event => {
      speechQueue.setShowOutput(item.id, event.target.checked);
      if (event.target.checked) selectFile(item);
    }} />显示转写结果</label></div>
    <div className="speech-job-meta"><span className={`speech-job-status is-${item.status}`}>{labels[item.status]}</span><small><span>{formatSpeechTime(item.offset, ".")} / {formatSpeechTime(item.source.duration, ".")}</span><span>· {item.cueCount} 段</span></small><strong className="speech-job-percent">{(item.source.duration ? Math.min(100, item.offset / item.source.duration * 100) : 0).toFixed(1)}%</strong></div>
    {(elapsed(item) > 0 || item.status === "running") && <div className="speech-job-timing"><span>已用 {Math.floor(elapsed(item) / 1000)}s</span>{item.status === "running" && <span>预计剩余：{remaining(item)}</span>}</div>}
    <div className="speech-job-meter">{playback?.path === item.source.path ? <SpeechWaveform analyser={playback.analyser} /> : <progress value={item.offset} max={item.source.duration} />}</div>
    {item.status === "error" && <p className="speech-error">{item.message}</p>}
    <div className="speech-job-actions">{["ready", "paused", "error"].includes(item.status) && <button className="speech-icon-button" aria-label={item.status === "ready" ? "开始转写" : "继续转写"} title={item.status === "ready" ? "开始转写" : "从已保存断点继续"} onClick={event => { event.stopPropagation(); selectFile(item); speechQueue.start(item.id); }}><TaskIcon action="play" /></button>}
      {["queued", "running"].includes(item.status) && <button className="speech-icon-button" aria-label="暂停转写" title="暂停并保留断点" onClick={event => { event.stopPropagation(); speechQueue.pause(item.id); }}><TaskIcon action="pause" /></button>}
      <div className="speech-job-cleanup"><button className="speech-stop" disabled={item.status !== "paused"} title={item.status === "paused" ? "删除该任务的字幕和断点，保留音频" : "暂停任务后可清除进度"} onClick={event => { event.stopPropagation(); void speechQueue.reset(item.id).then(id => { if (id) { setSelectedId(id); setNotice(""); } }); }}>清除进度</button>
      <button className="speech-stop speech-icon-button" disabled={["cancelling", "resetting"].includes(item.status)} aria-label="取消并清理" title="取消并清理字幕和断点" onClick={event => { event.stopPropagation(); void cancelFile(item); }}><TaskIcon action="trash" /></button></div>
    </div>
  </article>;
  const styles = { "--speech-left-width": `${left.size}px`, "--speech-options-height": `${upper.size}px` } as CSSProperties;

  return <section className={`speech-view${dragging ? " is-file-dragging" : ""}`} style={styles} onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
    <div className="speech-workspace" ref={workspace}>
      <aside className="speech-controls">
        <section className="speech-file-card speech-input-pane">
          <div className="speech-queue-heading"><h2>音频队列 <span>· {queue.items.length} 个文件</span></h2><button disabled={!toolsReady || queue.importing} onClick={() => void pickFiles()}>添加文件</button></div>
          {queue.items.length === 0 && <button className="speech-file-picker" disabled={!toolsReady || queue.importing} onClick={() => void pickFiles()}>{queue.importing ? "正在读取音频信息…" : "拖放音频到此处，或点击添加多个文件"}</button>}
          <div className="speech-job-list">{currentItems.map(renderJob)}
            {unfinishedItems.length > 0 && <section className="speech-unfinished" aria-label="未完成任务"><h3>未完成任务 · {unfinishedItems.length}</h3>{unfinishedItems.map(renderJob)}</section>}
          </div>
          {playback && playerItem && playerItem.id !== selected?.id && <div className="speech-playing-name" title={playerItem.source.name}>正在试听：{playerItem.source.name}</div>}
          {playerItem && <SpeechAudioPlayer path={playerItem.source.path} onPlaybackChange={setPlayback} />}
          <div className="speech-actions"><button className="speech-primary" disabled={!toolsReady || !canStart} onClick={() => speechQueue.start()}>开始 / 继续队列</button><button disabled={!running} onClick={() => speechQueue.pause()}>全部暂停</button></div>
        </section>
      </aside>
      <div className="speech-splitter is-vertical" role="separator" aria-label="调整左右布局" aria-orientation="vertical" onMouseDown={event => left.beginResize(event, 1)} />
      <main className="speech-right">
        <section className="speech-settings">
          <h3>{taskOptions ? "当前任务参数" : "新任务选项"}</h3>
          <fieldset className="speech-task-fields" aria-label={taskOptions ? "当前任务参数" : "新任务选项"} disabled={!!taskOptions}>
          <SpeechOnlineRunControls options={taskOptions} />
          {!online && <><label>识别模型<select title={modelInfo.label} value={selectedModel} disabled={!!models.inUse || !!models.download} onChange={event => selectSpeechModel(event.target.value as SpeechModel)}>{SPEECH_MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
          <div className="speech-model-info"><span className={`speech-model-status ${status?.installed ? "is-installed" : ""}`}>{!status ? "检查中" : status.installed ? "已下载" : status.files ? "部分下载" : "未下载"}</span><span>{status?.bytes ? `${(status.bytes / 1048576).toFixed(1)} MiB` : `约 ${modelInfo.sizeMiB} MiB`}</span><span>{modelInfo.description}</span></div></>}
          <SpeechRunOptions options={taskOptions} />
          </fieldset>
        </section>
        <div className="speech-splitter is-horizontal" role="separator" aria-label="调整参数与结果区域高度" aria-orientation="horizontal" onMouseDown={event => upper.beginResize(event, 1)} />
      <section className="speech-results">
        <div className="speech-results-header"><h2 className="speech-results-heading">转写结果</h2>
        <div className="speech-output-location"><span title={outputFolder}>输出到：{outputFolder || "请在设置 → 语音转文字中选择目录"}</span>{outputItem?.folder && outputItem.status !== "resetting" && <button aria-label="打开输出目录" title="打开输出目录" onClick={() => void api.openPath(outputItem.folder).catch(cause => setError(friendly(cause)))}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 7h7l2 3h9l-3 10H3V7Z"/><path d="M3 7V4h7l2 3h8v3"/></svg></button>}</div></div>
        {result && <div className="speech-result-tabs" role="tablist" aria-label="转写结果文件">{resultItems.map((item, index) => <button type="button" role="tab" id={`speech-tab-${item.id}`} aria-controls="speech-result-page" aria-selected={item.id === result.id} tabIndex={item.id === result.id ? 0 : -1} title={item.source.name} key={item.id} onClick={() => { selectFile(item); setNotice(""); }} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % resultItems.length : event.key === "ArrowLeft" ? (index + resultItems.length - 1) % resultItems.length : event.key === "Home" ? 0 : event.key === "End" ? resultItems.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault(); selectFile(resultItems[next]); setNotice("");
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}>{item.source.name}</button>)}</div>}
        <DownloadProgress download={models.download} />
        {(error || queue.error || models.error) && <div className="speech-error" role="alert">{error || queue.error || models.error}<button onClick={() => { setError(""); speechQueue.clearError(); if (models.error) void refreshSpeechModels(); }}>关闭</button></div>}
        {notice && <div className="speech-notice" role="status">{notice}</div>}
        {result ? <div className="speech-result-page" id="speech-result-page" role="tabpanel" aria-labelledby={`speech-tab-${result.id}`}>
          <div className="speech-result-tools"><div className="speech-display-switch" role="radiogroup" aria-label="结果显示方式"><button role="radio" aria-checked={view === "cues"} onClick={() => setView("cues")}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M9 5h12M9 12h12M9 19h12"/><circle cx="3" cy="5" r="1"/><circle cx="3" cy="12" r="1"/><circle cx="3" cy="19" r="1"/></svg>时间轴</button><button role="radio" aria-checked={view === "text"} onClick={() => setView("text")}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 5h16M4 10h16M4 15h16M4 20h10"/></svg>纯文本</button></div>
          <div className="speech-search" role="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input type="search" aria-label="搜索" title="搜索当前音频转写结果" placeholder="搜索" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} />{query && <><span role="status">{resultPreview ? `找到 ${resultPreview.total} 段` : "搜索中…"}</span><button aria-label="清除搜索" onClick={() => { setSearch(""); setPage(0); }}>×</button></>}</div>
          <button disabled={!pageText} onClick={() => void copyText(pageText).then(ok => setNotice(ok ? "已复制本页文本" : "复制失败"))}>复制本页文本</button></div>
          {!resultPreview?.cues.length ? <div className="speech-empty">{query ? resultPreview ? "未找到匹配内容。" : "正在搜索…" : "每段识别完成并写入文件后，结果会显示在这里。"}</div> : view === "text" ? <pre className="speech-preview">{highlight(pageText, query)}</pre> : <div className="speech-cues">{resultPreview.cues.map((cue, index) => <div className="speech-cue" key={page * 100 + index}><span><b>{page * 100 + index + 1}</b><time>{formatSpeechTime(cue.start, ".")}<br />{formatSpeechTime(cue.end, ".")}</time></span><p>{highlight(cue.text, query)}</p></div>)}</div>}
          {pages > 1 && <div className="speech-pagination"><button disabled={!page} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page + 1} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>下一页</button></div>}
        </div> : <div className="speech-empty">开始处理并开启文件的结果显示后，可在这里切换查看转写结果。</div>}
      </section>
      </main>
    </div>
  </section>;
}
