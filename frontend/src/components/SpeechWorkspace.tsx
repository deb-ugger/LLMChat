import { useEffect, useId, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { copyText } from "../clipboard";
import { speechQueue, type SpeechQueueItem } from "../speech/queue";
import { speechNative } from "../speech/native";
import { formatSpeechTime, type SpeechCue, type SpeechRange } from "../speech/transcription";
import { SpeechRangePage, type SpeechRangePageHandle } from "./SpeechRangeEditor";

const friendly = (error: unknown) => error instanceof Error ? error.message : String(error);
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

type PaneHandle = { openItem: (item: SpeechQueueItem, range?: boolean) => void; getItem: () => SpeechQueueItem | undefined };
type PaneProps = {
  id: string; active: boolean; items: SpeechQueueItem[]; initialItem?: SpeechQueueItem;
  onSelect: (item: SpeechQueueItem) => void; layoutControl?: ReactNode; ref?: Ref<PaneHandle>;
  drafts: Map<string, SpeechRange[]>; changeDraft: (id: string, ranges?: SpeechRange[]) => void;
};

export function SpeechPane({ id, active, items, initialItem, onSelect, layoutControl, ref, drafts, changeDraft }: PaneProps) {
  const [selectedId, setSelectedId] = useState<string | null>(initialItem?.id ?? null);
  const [workspaceMode, setWorkspaceMode] = useState<"results" | "ranges">("results");
  const [rangeWorkspace, setRangeWorkspace] = useState<{ ids: string[]; activeId: string | null }>({ ids: [], activeId: null });
  const rangeOrder = useRef(rangeWorkspace);
  rangeOrder.current = rangeWorkspace;
  const [closedResults, setClosedResults] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<"cues" | "text">("cues");
  const [search, setSearch] = useState("");
  const query = search.trim();
  const [preview, setPreview] = useState<{ id: string; query: string; page: number; cues: SpeechCue[]; total: number } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const rangePages = useRef(new Map<string, SpeechRangePageHandle>());
  const [tabMenu, setTabMenu] = useState<{ mode: "results" | "ranges"; id: string; x: number; y: number } | null>(null);
  const selected = items.find(item => item.id === selectedId) ?? (selectedId === null ? initialItem : undefined);
  const resultItems = items.filter(item => item.folder && item.showOutput && !closedResults.includes(item.id) && !["cancelling", "resetting"].includes(item.status));
  const result = resultItems.find(item => item.id === selected?.id);
  const rangeItems = rangeWorkspace.ids.flatMap(id => { const item = items.find(item => item.id === id); return item ? [item] : []; });
  const fileTabs = workspaceMode === "ranges" ? rangeItems : resultItems;
  const selectedTabId = workspaceMode === "ranges" ? rangeWorkspace.activeId : result?.id;
  const menuItems = tabMenu?.mode === "ranges" ? rangeItems : resultItems;
  const menuIndex = menuItems.findIndex(item => item.id === tabMenu?.id);
  const activeRange = rangeItems.find(item => item.id === rangeWorkspace.activeId);
  const matchingPreview = preview?.id === result?.id && preview?.query === query ? preview : null;
  const resultPreview = matchingPreview?.page === page ? matchingPreview : null;
  const pages = Math.max(1, Math.ceil((matchingPreview?.total ?? 0) / 100));
  const pageText = resultPreview?.cues.map(cue => cue.text).join("\n") ?? "";
  useEffect(() => { setPage(0); setSearch(""); }, [result?.id]);
  useEffect(() => {
    let disposed = false;
    if (!active || workspaceMode !== "results" || !result) return;
    const taskId = result.id;
    const read = () => {
      void speechNative.preview(result.folder, page, query).then(preview => { if (!disposed) setPreview({ ...preview, id: taskId, query, page }); }).catch(cause => { if (!disposed) setError(friendly(cause)); });
    };
    const timer = query ? window.setTimeout(read, 250) : undefined;
    if (!query) read();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [active, workspaceMode, result?.id, result?.folder, result?.revision, result?.status, page, query]);
  const selectFile = (item: SpeechQueueItem) => {
    setSelectedId(item.id); setTabMenu(null); setPage(0); setSearch("");
    setClosedResults(current => current.filter(id => id !== item.id)); onSelect(item);
  };
  const openRange = (item: SpeechQueueItem) => {
    selectFile(item); setWorkspaceMode("ranges");
    setRangeWorkspace(current => ({ ids: current.ids.includes(item.id) ? current.ids : [...current.ids, item.id], activeId: item.id }));
  };
  useImperativeHandle(ref, () => ({ openItem: (item, range) => { if (range || workspaceMode === "ranges") openRange(item); else selectFile(item); }, getItem: () => workspaceMode === "ranges" ? activeRange : selected }));
  const closeRange = (taskId: string) => {
    const current = rangeOrder.current;
    const ids = current.ids.filter(value => value !== taskId);
    const activeId = current.activeId === taskId ? ids[Math.min(current.ids.indexOf(taskId), ids.length - 1)] ?? null : current.activeId;
    rangeOrder.current = { ids, activeId }; setRangeWorkspace(rangeOrder.current);
    const next = items.find(item => item.id === activeId);
    if (current.activeId === taskId && next) selectFile(next);
  };
  const closeTabs = async (mode: "results" | "ranges", ids: string[]) => {
    setTabMenu(null);
    if (mode === "ranges") {
      for (const taskId of ids) {
        const item = items.find(item => item.id === taskId), page = rangePages.current.get(taskId);
        if (page && item && !await page.requestClose(() => openRange(item))) break;
      }
    } else {
      setClosedResults(current => [...new Set([...current, ...ids])]);
      if (selected && ids.includes(selected.id)) {
        const remaining = resultItems.filter(item => !ids.includes(item.id));
        const next = remaining[Math.min(resultItems.findIndex(item => item.id === selected.id), remaining.length - 1)];
        if (next) selectFile(next);
      }
    }
  };
  return (
      <div className="speech-pane-content">
        <div className="speech-results-header"><div className="speech-workspace-switch" role="group" aria-label="工作区切换">
          <button className="speech-results-heading" aria-pressed={workspaceMode === "results"} onClick={() => { setWorkspaceMode("results"); setTabMenu(null); if (selected) onSelect(selected); }}>转写结果</button>
          <button className="speech-results-heading" aria-pressed={workspaceMode === "ranges"} onClick={() => { const item = activeRange ?? rangeItems[0] ?? selected; if (item) openRange(item); else { setWorkspaceMode("ranges"); setTabMenu(null); } }}>识别范围</button>
        </div>{layoutControl}</div>
        {fileTabs.length > 0 && <div className="speech-result-tabs" role="tablist" aria-label={workspaceMode === "ranges" ? "识别范围文件" : "转写结果文件"}>{fileTabs.map((item, index) => <div className="speech-file-tab" key={item.id}>
          <button type="button" role="tab" id={`${id}-${workspaceMode}-tab-${item.id}`} aria-controls={workspaceMode === "ranges" ? `${id}-range-page-${item.id}` : `${id}-result-page`} aria-selected={item.id === selectedTabId} tabIndex={item.id === selectedTabId || (!selectedTabId && index === 0) ? 0 : -1} title={item.source.name}
            onClick={() => { if (workspaceMode === "ranges") openRange(item); else selectFile(item); setNotice(""); }}
            onContextMenu={event => { event.preventDefault(); setTabMenu({ mode: workspaceMode, id: item.id, x: Math.max(0, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(0, Math.min(event.clientY, window.innerHeight - 168)) }); }}
            onKeyDown={event => {
              const next = event.key === "ArrowRight" ? (index + 1) % fileTabs.length : event.key === "ArrowLeft" ? (index + fileTabs.length - 1) % fileTabs.length : event.key === "Home" ? 0 : event.key === "End" ? fileTabs.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault(); if (workspaceMode === "ranges") openRange(fileTabs[next]); else selectFile(fileTabs[next]); setNotice("");
              event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}>{item.source.name}</button>
          <button type="button" className="speech-tab-close" aria-label={`关闭标签页：${item.source.name}`} title="关闭标签页" onClick={() => void closeTabs(workspaceMode, [item.id])}>×</button>
        </div>)}</div>}
        {tabMenu && menuIndex >= 0 && <><div className="speech-tab-menu-backdrop" onPointerDown={() => setTabMenu(null)} /><div className="speech-tab-menu" role="menu" aria-label="标签页操作" style={{ left: tabMenu.x, top: tabMenu.y }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setTabMenu(null); } }}>
          {menuIndex > 0 && <button role="menuitem" autoFocus onClick={() => void closeTabs(tabMenu.mode, menuItems.slice(0, menuIndex).map(item => item.id))}>关闭左侧所有标签页</button>}
          {menuIndex < menuItems.length - 1 && <button role="menuitem" autoFocus={menuIndex === 0} onClick={() => void closeTabs(tabMenu.mode, menuItems.slice(menuIndex + 1).map(item => item.id))}>关闭右侧所有标签页</button>}
          {menuItems.length > 1 && <button role="menuitem" onClick={() => void closeTabs(tabMenu.mode, menuItems.filter(item => item.id !== tabMenu.id).map(item => item.id))}>关闭其他所有标签页</button>}
          <button role="menuitem" autoFocus={menuItems.length === 1} className="speech-tab-menu-current" onClick={() => void closeTabs(tabMenu.mode, [tabMenu.id])}>关闭标签页</button>
        </div></>}
        {error && <div className="speech-error" role="alert">{error}<button onClick={() => setError("")}>关闭</button></div>}
        {notice && <div className="speech-notice" role="status">{notice}</div>}
        {rangeItems.map(item => <div key={item.id} id={`${id}-range-page-${item.id}`} role="tabpanel" aria-labelledby={`${id}-ranges-tab-${item.id}`} className="speech-range-tab-page" hidden={workspaceMode !== "ranges" || rangeWorkspace.activeId !== item.id}>
          <SpeechRangePage ref={page => { if (page) rangePages.current.set(item.id, page); else rangePages.current.delete(item.id); }} name={item.source.name} duration={item.source.duration} ranges={item.options.ranges} disabled={!!item.folder || ["queued", "running", "pausing", "resetting", "cancelling"].includes(item.status)} sharedDraft={drafts.get(item.id)} onDraftChange={ranges => changeDraft(item.id, ranges)} onDiscard={() => changeDraft(item.id)} onChange={ranges => speechQueue.setRanges(item.id, ranges)} onClose={() => closeRange(item.id)} />
        </div>)}
        {workspaceMode === "ranges" && !activeRange && <div className="speech-empty">选择音频任务后，点击“选取片段”查看或编辑识别范围。</div>}
        {workspaceMode === "results" && (result ? <div className="speech-result-page" id={`${id}-result-page`} role="tabpanel" aria-labelledby={`${id}-results-tab-${result.id}`}>
          <div className="speech-result-tools"><div className="speech-display-switch" role="radiogroup" aria-label="结果显示方式"><button role="radio" aria-checked={view === "cues"} onClick={() => setView("cues")}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M9 5h12M9 12h12M9 19h12"/><circle cx="3" cy="5" r="1"/><circle cx="3" cy="12" r="1"/><circle cx="3" cy="19" r="1"/></svg>时间轴</button><button role="radio" aria-checked={view === "text"} onClick={() => setView("text")}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 5h16M4 10h16M4 15h16M4 20h10"/></svg>纯文本</button></div>
          <div className="speech-search" role="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input type="search" aria-label="搜索" title="搜索当前音频转写结果" placeholder="搜索" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} />{query && <>{!!resultPreview?.total && <span role="status">找到 {resultPreview.total} 段</span>}<button aria-label="清除搜索" onClick={() => { setSearch(""); setPage(0); }}>×</button></>}</div>
          <button disabled={!pageText} onClick={() => void copyText(pageText).then(ok => setNotice(ok ? "已复制本页文本" : "复制失败"))}>复制本页文本</button></div>
          {!resultPreview?.cues.length ? <div className="speech-empty">{query ? resultPreview ? "未找到匹配内容。" : "正在搜索…" : "每段识别完成并写入文件后，结果会显示在这里。"}</div> : view === "text" ? <pre className="speech-preview">{highlight(pageText, query)}</pre> : <div className="speech-cues">{resultPreview.cues.map((cue, index) => <div className="speech-cue" key={page * 100 + index}><span><b>{page * 100 + index + 1}</b><time>{formatSpeechTime(cue.start, ".")}<br />{formatSpeechTime(cue.end, ".")}</time></span><p>{highlight(cue.text, query)}</p></div>)}</div>}
          {pages > 1 && <div className="speech-pagination"><button disabled={!page} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page + 1} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>下一页</button></div>}
        </div> : <div className="speech-empty">开始处理并开启文件的结果显示后，可在这里切换查看转写结果。</div>)}
      </div>
  );
}

export type SpeechWorkspaceHandle = { openItem: (item: SpeechQueueItem, range?: boolean) => void };
type WorkspaceProps = { active: boolean; items: SpeechQueueItem[]; initialItem?: SpeechQueueItem; onSelect: (item: SpeechQueueItem) => void; children?: ReactNode; ref?: Ref<SpeechWorkspaceHandle> };
export function SpeechWorkspace({ active, items, initialItem, onSelect, children, ref }: WorkspaceProps) {
  const [layout, setLayout] = useState<"single" | "columns" | "rows">("single");
  const [hasSplit, setHasSplit] = useState(false);
  const [activePane, setActivePane] = useState(0);
  const [ratio, setRatio] = useState(.5);
  const [layoutMenu, setLayoutMenu] = useState(false);
  const [drafts, setDrafts] = useState(new Map<string, SpeechRange[]>());
  const panes = useRef(new Map<number, PaneHandle>());
  const container = useRef<HTMLDivElement>(null);
  const rootId = useId();
  const changeDraft = (id: string, ranges?: SpeechRange[]) => setDrafts(current => { const next = new Map(current); if (ranges) next.set(id, ranges); else next.delete(id); return next; });
  useImperativeHandle(ref, () => ({ openItem: (item, range) => panes.current.get(activePane)?.openItem(item, range) }));
  const activate = (index: number) => { setActivePane(index); const item = panes.current.get(index)?.getItem(); if (item) onSelect(item); };
  const chooseLayout = (next: typeof layout) => { setLayout(next); setLayoutMenu(false); if (next !== "single") setHasSplit(true); else { setActivePane(0); const item = panes.current.get(0)?.getItem(); if (item) onSelect(item); } };
  const layoutControl = <div className="speech-layout-control"><button className="speech-layout-button" aria-haspopup="menu" aria-expanded={layoutMenu} onClick={() => setLayoutMenu(value => !value)}><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2"/>{layout === "columns" ? <path d="M10 3v14"/> : layout === "rows" ? <path d="M2 10h16"/> : null}</svg>布局</button>
    {layoutMenu && <><div className="speech-tab-menu-backdrop" onPointerDown={() => setLayoutMenu(false)}/><div className="speech-layout-menu speech-tab-menu" role="menu" aria-label="工作区布局" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setLayoutMenu(false); } }}>{([['single','单页'],['columns','左右分屏'],['rows','上下分屏']] as const).map(([value,label]) => <button key={value} role="menuitemradio" aria-checked={layout === value} autoFocus={layout === value} onClick={() => chooseLayout(value)}>{label}{layout === value && <span aria-hidden="true">✓</span>}</button>)}</div></>}
  </div>;
  const columns = layout === "columns";
  const splitStyle = layout === "single" ? undefined : { [columns ? "gridTemplateColumns" : "gridTemplateRows"]: `minmax(0, ${ratio}fr) 8px minmax(0, ${1 - ratio}fr)` } as CSSProperties;
  return <section className="speech-results">{children}<div className={`speech-result-panes is-${layout}`} ref={container} style={splitStyle}>
    {[0, 1].filter(index => index === 0 || hasSplit).map(index => <div key={index} className={`speech-result-pane${layout !== "single" && activePane === index ? " is-active-pane" : ""}`} hidden={index === 1 && layout === "single"} role="region" aria-label={`工作区 ${index + 1}`} onPointerDownCapture={() => activate(index)} onClickCapture={() => activate(index)} onFocusCapture={() => activate(index)}>
      <SpeechPane id={`${rootId}-pane-${index}`} ref={pane => { if (pane) panes.current.set(index, pane); else panes.current.delete(index); }} active={active && (index === 0 || layout !== "single")} items={items} initialItem={index === 0 ? initialItem : items.find(item => item.folder && item.showOutput && item.id !== initialItem?.id) ?? initialItem} onSelect={onSelect} drafts={drafts} changeDraft={changeDraft} layoutControl={index === (columns ? 1 : 0) ? layoutControl : undefined}/>
    </div>)}
    {layout !== "single" && <div className={`speech-pane-splitter ${columns ? "is-vertical" : "is-horizontal"}`} role="separator" tabIndex={0} aria-label="调整分屏比例" aria-orientation={columns ? "vertical" : "horizontal"} aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio * 100)} style={columns ? { gridColumn: 2, gridRow: 1 } : { gridRow: 2, gridColumn: 1 }}
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId) || !container.current) return; const bounds = container.current.getBoundingClientRect(); setRatio(Math.max(.2, Math.min(.8, columns ? (event.clientX - bounds.left) / bounds.width : (event.clientY - bounds.top) / bounds.height))); }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onKeyDown={event => { const before = columns ? "ArrowLeft" : "ArrowUp", after = columns ? "ArrowRight" : "ArrowDown"; if (event.key === before || event.key === after) { event.preventDefault(); setRatio(value => Math.max(.2, Math.min(.8, value + (event.key === before ? -.02 : .02)))); } }}/>}
  </div></section>;
}
