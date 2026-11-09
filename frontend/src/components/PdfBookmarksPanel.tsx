import { useEffect, useState } from "react";
import { addPdfBookmark, loadPdfBookmarks, savePdfBookmarks, type PdfBookmark } from "../pdfBookmarks";

export function PdfBookmarksPanel({ documentKey, page, label, onJump }: { documentKey: string; page: number; label: string; onJump: (page: number) => void }) {
  const [bookmarks, setBookmarks] = useState<PdfBookmark[]>([]);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  useEffect(() => {
    let cancelled = false;
    void loadPdfBookmarks(documentKey).then(items => { if (!cancelled) { setBookmarks(items); setLoaded(true); } }).catch(cause => { if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause)); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [documentKey]);
  const save = async (next: PdfBookmark[]) => {
    setBusy(true); setError("");
    try { await savePdfBookmarks(documentKey, next); setBookmarks(next); setEditing(null); }
    catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { setBusy(false); }
  };
  const present = bookmarks.some(bookmark => bookmark.page === page);
  return <div className="pdf-outline-body pdf-bookmarks">
    <div className="pdf-bookmarks-head"><strong>书签</strong><button type="button" className="pdf-tool-btn pdf-tool-icon-btn" disabled={busy || !loaded || present} title={present ? "当前页已有书签" : "添加当前页书签"} aria-label="添加当前页书签" onClick={() => void save(addPdfBookmark(bookmarks, page, label))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4zM9 9h6m-3-3v6" /></svg></button></div>
    {error && <p role="alert" className="pdf-bookmarks-error">{error}</p>}
    {!busy && !error && !bookmarks.length && <p className="pdf-bookmarks-empty">暂无书签，点击右上角添加当前页。</p>}
    <ul className="pdf-outline-list">{bookmarks.map(bookmark => <li key={bookmark.page} className={`pdf-bookmark${bookmark.page === page ? " active" : ""}`}>
      {editing === bookmark.page ? <form className="pdf-bookmark-edit" onSubmit={event => { event.preventDefault(); void save(bookmarks.map(item => item.page === bookmark.page ? { ...item, title: title.trim() || item.title } : item)); }}>
        <input aria-label="书签名称" autoFocus value={title} disabled={busy} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setEditing(null); } }} />
        <button type="submit" disabled={busy} title="保存名称" aria-label="保存名称">✓</button><button type="button" disabled={busy} title="取消重命名" aria-label="取消重命名" onClick={() => setEditing(null)}>×</button>
      </form> : <><button type="button" className="pdf-outline-item pdf-bookmark-title" title={`${bookmark.title} · PDF 第 ${bookmark.page} 页`} onClick={() => onJump(bookmark.page)}>{bookmark.title}<small>PDF {bookmark.page}</small></button>
        <button type="button" className="pdf-bookmark-action" disabled={busy} title="重命名书签" aria-label={`重命名 ${bookmark.title}`} onClick={() => { setEditing(bookmark.page); setTitle(bookmark.title); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6zM14 5l5 5" /></svg></button>
        <button type="button" className="pdf-bookmark-action" disabled={busy} title="删除书签" aria-label={`删除 ${bookmark.title}`} onClick={() => void save(bookmarks.filter(item => item.page !== bookmark.page))}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg></button></>}
    </li>)}</ul>
  </div>;
}
