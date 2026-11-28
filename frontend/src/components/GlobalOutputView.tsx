import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { writeDownloadedFile } from "../outputFiles";
import { save } from "@tauri-apps/plugin-dialog";
import { exportAppOutput, formatOutputMessage, formatOutputTime, loadAppOutputHistory, useAppOutput, useUnreadOutput, viewAppOutput, type OutputRow } from "../appOutput";
import { usePersistedHeight } from "../hooks/usePersistedHeight";
import { showAppNotice } from "./AppNotice";
import type { OutputVimLogHandle } from "./OutputVimLog";

const OutputVimLog = lazy(() => import("./OutputVimLog"));

const icons = {
  search: "M16 16l5 5M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
  download: "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4",
  previous: "m6 14 6-6 6 6",
  next: "m6 10 6 6 6-6",
  close: "m6 6 12 12M18 6 6 18",
};
function OutputIcon({ name }: { name: keyof typeof icons }) {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

export function OutputBadge() {
  const count = useUnreadOutput();
  return count ? <strong className="output-badge" aria-label={`${count} 条未读提醒`} role="status">{count}</strong> : null;
}

const logPageSize = 500;
function matchesLog(row: OutputRow, needle: string) {
  return formatOutputMessage(row).toLowerCase().includes(needle) || formatOutputTime(row.time).toLowerCase().includes(needle);
}

export function GlobalOutputView({ onClose }: { onClose: () => void }) {
  useLayoutEffect(viewAppOutput, []);
  const { rows, warning, logPath } = useAppOutput();
  const [windowHeight, setWindowHeight] = useState(() => window.innerHeight);
  const minHeight = 120;
  const maxHeight = Math.max(minHeight, windowHeight - 120);
  const size = usePersistedHeight("llmchat-output-height", Math.min(windowHeight * 0.42, 340), minHeight, maxHeight);
  useEffect(() => {
    const measure = () => setWindowHeight(window.innerHeight);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [vimCursor, setVimCursor] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const logEditor = useRef<OutputVimLogHandle>(null);
  const searchKeyword = searchOpen ? query.trim() : "";
  const matches = useMemo(() => {
    if (!searchKeyword) return [];
    const needle = searchKeyword.toLowerCase();
    return rows.filter(row => matchesLog(row, needle));
  }, [rows, searchKeyword]);
  const currentIndex = Math.min(matchIndex, matches.length - 1);
  const activeId = matches[currentIndex]?.id;
  const cursorOffset = vimCursor ? rows.findIndex(row => row.id === vimCursor) : -1;
  const cursorIndex = cursorOffset < 0 ? rows.length - 1 : cursorOffset;
  const cursorRow = rows[cursorIndex];
  const focusedId = activeId || cursorRow?.id;
  const lastPage = Math.max(0, Math.ceil(rows.length / logPageSize) - 1);
  const focusOffset = activeId ? rows.findIndex(row => row.id === activeId) : cursorIndex;
  const displayPage = focusOffset < 0 ? 0 : Math.floor((rows.length - 1 - focusOffset) / logPageSize);
  const end = rows.length - displayPage * logPageSize;
  const start = Math.max(0, end - logPageSize);
  const visible = useMemo(() => rows.slice(start, end), [rows, start, end]);
  const moveMatch = (offset: number) => {
    if (matches.length) setMatchIndex((currentIndex + offset + matches.length) % matches.length);
  };
  const openSearch = () => {
    if (searchOpen) search.current?.select(); else setSearchOpen(true);
  };
  const closeSearch = () => {
    setSearchOpen(false); setQuery(""); setMatchIndex(0);
    if (activeId) setVimCursor(activeId);
  };
  const selectPage = (next: number) => {
    setVimCursor(rows[rows.length - 1 - next * logPageSize]?.id);
    logEditor.current?.focus();
  };
  useEffect(() => {
    if (!logPath) return;
    let active = true;
    void loadAppOutputHistory().catch(error => {
      if (active) setHistoryError(`无法读取完整运行记录：${error instanceof Error ? error.message : String(error)}`);
    });
    return () => { active = false; };
  }, [logPath]);
  const onDrawerKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault(); event.stopPropagation(); openSearch();
    } else if (event.key === "Escape" && searchOpen) {
      event.preventDefault(); event.stopPropagation(); closeSearch();
    }
  };
  useLayoutEffect(() => {
    if (searchOpen) search.current?.focus();
    else logEditor.current?.focus();
  }, [searchOpen]);
  const download = async () => {
    setExporting(true);
    try {
      const text = await exportAppOutput();
      if (!text) { showAppNotice("暂无可下载的全局日志"); return; }
      const stamp = formatOutputTime(new Date().toISOString()).slice(0, 10);
      const path = await save({ defaultPath: `LLMChat-output-${stamp}.txt`, filters: [{ name: "文本日志", extensions: ["txt"] }] });
      if (!path) return;
      await writeDownloadedFile(path, new TextEncoder().encode(text), "输出日志");
      showAppNotice("全局日志已下载");
    } catch (error) { showAppNotice(`无法下载日志：${error instanceof Error ? error.message : String(error)}`, "error"); }
    finally { setExporting(false); }
  };
  return <section id="app-output-drawer" className="global-output" aria-label="全局输出" style={{ height: size.height }} onKeyDownCapture={onDrawerKey}>
    <button type="button" className="global-output-divider" role="separator" aria-orientation="horizontal" aria-label="调整输出面板高度"
      aria-valuemin={minHeight} aria-valuemax={maxHeight} aria-valuenow={Math.round(size.height)}
      onMouseDown={event => size.beginResize(event, "grow-up")}
      onKeyDown={event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        size.setHeight(height => height + (event.key === "ArrowUp" ? 24 : -24));
      }} />
    <header className="global-output-toolbar">
      <h1>输出</h1>
      {logPath && <code data-tooltip={logPath}>{logPath}</code>}
      <div className="global-output-tools">
        {lastPage > 0 && <div className="global-output-pages" role="group" aria-label="运行记录翻页">
          <button type="button" disabled={!!activeId || displayPage === lastPage} onClick={() => selectPage(displayPage + 1)}>更早记录</button>
          <span>{start + 1}–{end} / {rows.length}</span>
          <button type="button" disabled={!!activeId || displayPage === 0} onClick={() => selectPage(displayPage - 1)}>更新记录</button>
        </div>}
        <button type="button" className="global-output-icon" aria-label="查找日志" aria-expanded={searchOpen}
          data-tooltip="查找当前列表（Ctrl+F）" onClick={openSearch}><OutputIcon name="search" /></button>
        <button type="button" className="global-output-icon" aria-label="下载日志" disabled={exporting} data-tooltip="下载全局日志（含轮转备份）" onClick={() => void download()}><OutputIcon name="download" /></button>
      </div>
    </header>
    {searchOpen && <div className="global-output-search" role="search">
      <input ref={search} type="search" aria-label="搜索当前日志列表" placeholder="查找时间或日志内容" value={query}
        onChange={event => { setQuery(event.target.value); setMatchIndex(0); }}
        onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); } }} />
      <small role="status">{searchKeyword && (matches.length ? `${currentIndex + 1} / ${matches.length}` : "无匹配")}</small>
      <button type="button" className="global-output-icon" aria-label="上一处匹配" data-tooltip="上一处匹配（Shift+Enter）" disabled={!matches.length} onClick={() => moveMatch(-1)}><OutputIcon name="previous" /></button>
      <button type="button" className="global-output-icon" aria-label="下一处匹配" data-tooltip="下一处匹配（Enter）" disabled={!matches.length} onClick={() => moveMatch(1)}><OutputIcon name="next" /></button>
      <button type="button" className="global-output-icon" aria-label="关闭搜索" data-tooltip="关闭搜索（Esc）" onClick={closeSearch}><OutputIcon name="close" /></button>
    </div>}
    {(warning || historyError) && <p className="global-output-warning" role="alert">{warning || historyError}</p>}
    <div className="global-output-panel">
      {!visible.length ? <p className="global-output-empty">暂无输出</p>
        : <Suspense fallback={<p className="global-output-empty" role="status">正在加载运行记录…</p>}>
          <OutputVimLog ref={logEditor} rows={visible} targetId={focusedId} searchOpen={searchOpen}
            query={searchKeyword} matchId={activeId} onSelect={setVimCursor} onClose={onClose} />
        </Suspense>}
    </div>
  </section>;
}
