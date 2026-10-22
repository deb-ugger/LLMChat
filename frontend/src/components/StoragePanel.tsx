import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type StorageStatus } from "../api";
import { toFriendlyError } from "../friendlyError";
import "./StoragePanel.css";

const ICONS = {
  data: ["M20 6c0 2-4 3-8 3S4 8 4 6s4-3 8-3 8 1 8 3Z", "M4 6v12c0 2 4 3 8 3s8-1 8-3V6M4 12c0 2 4 3 8 3s8-1 8-3"],
  folder: ["M3 7V5h6l2 2h10v13H3V7Z", "M3 11h18"],
  scan: ["M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M7 12h10M8 8h8M8 16h8"],
  cube: ["m12 3 9 5v9l-9 5-9-5V8l9-5Z", "m3 8 9 5 9-5M12 13v9M7.5 5.5l9 5"],
  clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 7v5l3 2"],
  globe: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"],
  file: ["M14 3H5v18h14V8l-5-5Z", "M14 3v5h5M8 12h8M8 16h5"],
  chat: ["M21 11a8 8 0 0 1-8 8H7l-4 3V5a2 2 0 0 1 2-2h8a8 8 0 0 1 8 8Z", "M7 8h10M7 12h7"],
  chart: ["M4 3v18h17M8 16v-4M13 16V7M18 16v-6"],
  refresh: ["M20 8a8 8 0 1 0 0 8M20 3v5h-5"],
  trash: ["M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"],
  warning: ["m12 3 10 18H2L12 3Z", "M12 9v5M12 17h.01"],
  arrow: ["M5 12h14M14 7l5 5-5 5"],
  check: ["m5 12 4 4L19 6"],
  close: ["m6 6 12 12M6 18 18 6"],
} as const;
type IconName = keyof typeof ICONS;
function StorageIcon({ name }: { name: IconName }) {
  return <svg className="storage-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICONS[name].map((d, i) => <path key={i} d={d} />)}
  </svg>;
}
const PATH_COPY: Record<string, { icon: IconName; description: string }> = {
  data: { icon: "data", description: "配置、聊天、用量与计费数据" },
  projects: { icon: "folder", description: "工程文件、原文与译文" },
  ocr: { icon: "scan", description: "识别模型、分词器及下载文件" },
  unity: { icon: "cube", description: "安装包、字体与辅助工具" },
  temp: { icon: "clock", description: "下载、解压和处理临时文件" },
  webview: { icon: "globe", description: "界面偏好、阅读记录与浏览器缓存" },
};
const CLEANUP_COPY: Record<string, { title: string; description: string; icon: IconName }> = {
  logs: { title: "运行日志", description: "Unity 输出日志与日志备份。", icon: "file" },
  temp: { title: "临时文件", description: "下载和解压留下的文件，包含旧版临时目录。", icon: "clock" },
  webcache: { title: "浏览器缓存", description: "网络、渲染及语音模型缓存。清理后模型需重新下载，账号、设置和阅读记录保留。", icon: "globe" },
  ocr: { title: "OCR 模型", description: "已下载的识别模型，使用对应模式时需重新下载。", icon: "scan" },
  unity: { title: "Unity 资源缓存", description: "安装包、字体与工具，可在使用时重新下载。", icon: "cube" },
  chats: { title: "聊天记录", description: "全部对话内容与历史备份。", icon: "chat" },
  usage: { title: "用量记录", description: "全部请求明细、用量统计与历史备份。", icon: "chart" },
  projects: { title: "翻译工程", description: "全部托管工程，包括工程内的原文和译文。", icon: "folder" },
};
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(1)} ${units[index]}`;
}

export function StoragePanel({ active }: { active: boolean }) {
  const [status, setStatus] = useState<StorageStatus>();
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "paths" } | { kind: "cleanup"; id: string } | null>(null);
  const current = status ? Object.fromEntries(status.entries.map(e => [e.id, e.path])) : {};
  const saved = status?.pending ?? current;
  const dirty = status?.entries.some(e => paths[e.id] !== saved[e.id]);
  const changed = status?.entries.filter(e => paths[e.id] !== e.path) ?? [];
  const cleanupTarget = confirm?.kind === "cleanup" ? status?.cleanupOptions.find(e => e.id === confirm.id) : undefined;
  const cacheOptions = status?.cleanupOptions.filter(e => !e.destructive) ?? [];
  const dataOptions = status?.cleanupOptions.filter(e => e.destructive) ?? [];
  const locations = status?.entries.filter(entry => entry.id !== "projects") ?? [];

  function accept(next: StorageStatus) {
    setStatus(next);
    setPaths(next.pending ?? Object.fromEntries(next.entries.map(e => [e.id, e.path])));
  }
  async function refresh() {
    setBusy(true); setError("");
    try { accept(await api.getStorage()); }
    catch (e) { setError(toFriendlyError(e, "无法读取存储信息")); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (active && !status && !busy) void refresh(); }, [active]);

  async function savePaths(cancel = false) {
    setBusy(true); setError(""); setMessage(""); setConfirm(null);
    try {
      accept(await api.saveStoragePaths(cancel ? current : paths));
      setMessage(cancel ? "已取消路径迁移。" : "路径已保存，下次启动时迁移。原位置文件会保留为备份。");
    } catch (e) { setError(toFriendlyError(e, "保存存储路径失败")); }
    finally { setBusy(false); }
  }
  async function scheduleCleanup(id: string, queue: boolean) {
    setBusy(true); setError(""); setMessage(""); setConfirm(null);
    try {
      const ids = queue ? [...new Set([...status!.cleanup, id])] : status!.cleanup.filter(e => e !== id);
      accept(await api.scheduleStorageCleanup(ids));
      setMessage(queue ? `已安排清理${CLEANUP_COPY[id].title}，完全退出软件并重新启动后执行。` : `已取消${CLEANUP_COPY[id].title}清理。`);
    } catch (e) { setError(toFriendlyError(e, "设置清理计划失败")); }
    finally { setBusy(false); }
  }

  return <div className="storage-panel" hidden={!active}>
    <div className="storage-toolbar">
      <button className="storage-button" type="button" disabled={busy || !!dirty} onClick={() => void refresh()}><StorageIcon name="refresh" />{busy ? "正在读取…" : "刷新占用"}</button>
    </div>
    <div className="storage-overview">
      <div><span>当前占用</span><strong>{status ? formatBytes(status.entries.reduce((sum, e) => sum + e.bytes, 0)) : "—"}</strong><small>软件管理的本地文件</small></div>
      <div><span>可清理缓存</span><strong>{status ? formatBytes(cacheOptions.reduce((sum, e) => sum + e.bytes, 0)) : "—"}</strong><small>不包含聊天、用量和工程</small></div>
      <div><span>清理计划</span><strong>{status ? status.cleanup.length : "—"}<em>项</em></strong><small>{status?.cleanup.length ? "下次启动时执行" : "暂无待执行清理"}</small></div>
    </div>
    <div className="storage-timing-note"><StorageIcon name="clock" /><span>路径迁移与文件清理均在<strong>下次启动</strong>时执行，执行前可以取消。</span></div>
    {message && <div role="status" className="storage-notice is-success"><StorageIcon name="check" /><span>{message}</span></div>}
    {(error || status?.error) && <div role="alert" className="storage-notice is-error"><StorageIcon name="warning" /><span>{error || status?.error}</span></div>}
    {!status && !busy && <button className="storage-button" type="button" onClick={() => void refresh()}>重新读取</button>}

    {status && <>
      <section className="storage-section">
        <div className="storage-section-heading"><div><h2>存储位置</h2><p>选择空目录作为新位置，迁移时保留原文件。</p></div><span className="storage-count">{locations.length} 个目录</span></div>
        <div className="storage-locations">
          {locations.map(entry => <article className="storage-location" key={entry.id}>
            <span className="storage-item-icon"><StorageIcon name={PATH_COPY[entry.id].icon} /></span>
            <div className="storage-location-copy"><label htmlFor={`storage-${entry.id}`}>{entry.label}</label><p>{PATH_COPY[entry.id].description}</p><span>{entry.exists ? formatBytes(entry.bytes) : "尚未生成"}</span></div>
            <div className="storage-location-path"><input id={`storage-${entry.id}`} value={paths[entry.id] ?? ""} disabled={busy} spellCheck={false} aria-label={`${entry.label}路径`} onChange={e => setPaths(p => ({ ...p, [entry.id]: e.target.value }))} />
              {paths[entry.id] !== entry.path && <p className="storage-current-path">当前：{entry.path}</p>}
            </div>
            <div className="storage-location-actions">
              <button className="storage-button is-small" type="button" disabled={busy} onClick={() => { void (async () => {
                try {
                  const value = await open({ directory: true, multiple: false, title: `选择${entry.label}目录`, defaultPath: paths[entry.id] || undefined });
                  if (typeof value === "string") setPaths(p => ({ ...p, [entry.id]: value }));
                } catch (e) { setError(toFriendlyError(e, "无法选择目录")); }
              })(); }}>更改</button>
              <button className="storage-button is-small is-icon" type="button" title={`打开当前${entry.label}目录`} aria-label={`打开当前${entry.label}目录`} disabled={busy || !entry.exists} onClick={() => { void api.openPath(entry.path).catch(e => setError(toFriendlyError(e))); }}><StorageIcon name="folder" /></button>
            </div>
          </article>)}
          <div className="storage-location-footer"><span>{dirty ? "有未保存的路径修改" : status.pending ? "路径迁移已安排，等待下次启动" : "所有位置均为当前生效目录"}</span>
            <div className="storage-actions">
              {dirty && <button className="storage-button is-quiet" type="button" disabled={busy} onClick={() => setPaths(saved)}>撤销修改</button>}
              {status.pending && <button className="storage-button" type="button" disabled={busy} onClick={() => void savePaths(true)}>取消迁移</button>}
              <button className="storage-button is-primary" type="button" disabled={busy || !dirty} onClick={() => setConfirm({ kind: "paths" })}>保存路径</button>
            </div>
          </div>
        </div>
      </section>
      <section className="storage-section">
        <div className="storage-section-heading"><div><h2>缓存清理</h2><p>按类别独立清理，需要时可重新生成或下载。</p></div><span className="storage-section-symbol"><StorageIcon name="trash" /></span></div>
        {dirty && <p className="storage-inline-hint">请先保存或撤销路径修改，再安排清理。</p>}
        <div className="storage-cache-grid">{cacheOptions.map(option => {
          const copy = CLEANUP_COPY[option.id], queued = status.cleanup.includes(option.id);
          return <article key={option.id} className={`storage-cache-card${option.id === "webcache" ? " is-wide" : ""}${queued ? " is-queued" : ""}`}>
            <div className="storage-cache-heading"><span className="storage-item-icon"><StorageIcon name={copy.icon} /></span><div><h3>{copy.title}</h3><p>{copy.description}</p></div></div>
            <div className="storage-cache-footer"><strong>{formatBytes(option.bytes)}</strong><div className="storage-actions">
              {queued && <span className="storage-queued"><StorageIcon name="clock" />下次启动清理</span>}
              <button className={`storage-button${queued ? " is-quiet" : " is-cleanup"}`} type="button" disabled={busy || !!dirty} aria-label={`${queued ? "取消清理" : "清理"}${copy.title}`} onClick={() => queued ? void scheduleCleanup(option.id, false) : setConfirm({ kind: "cleanup", id: option.id })}>{queued ? "取消清理" : "清理"}{!queued && <StorageIcon name="arrow" />}</button>
            </div></div>
          </article>;
        })}</div>
      </section>
      <section className="storage-section storage-data-section">
        <div className="storage-section-heading"><div><h2>数据清理 <span className="storage-danger-tag">不可恢复</span></h2><p>这些是你的使用数据，删除前请确认已完成备份。</p></div></div>
        <div className="storage-data-list">{dataOptions.map(option => {
          const copy = CLEANUP_COPY[option.id], queued = status.cleanup.includes(option.id);
          return <article className="storage-data-row" key={option.id}>
            <span className="storage-item-icon is-muted"><StorageIcon name={copy.icon} /></span>
            <div className="storage-data-copy"><h3>{copy.title}</h3><p>{copy.description}</p></div>
            <span className="storage-data-size">{formatBytes(option.bytes)}</span>
            {queued && <span className="storage-queued"><StorageIcon name="clock" />下次启动删除</span>}
            <button className={`storage-button ${queued ? "is-quiet" : "is-danger"}`} type="button" disabled={busy || !!dirty} aria-label={`${queued ? "取消删除" : "删除"}${copy.title}`} onClick={() => queued ? void scheduleCleanup(option.id, false) : setConfirm({ kind: "cleanup", id: option.id })}>{queued ? "取消删除" : "删除"}</button>
          </article>;
        })}</div>
      </section>
      <footer className="storage-footnote"><p>程序目录 <code>{status.programDir}</code></p><p>路径配置 <code>{status.locator}</code></p><p>另存的文件由保存位置管理；游戏目录内的补丁、配置和日志请在 Unity 页面管理。</p>
        {status.retained.length > 0 && <div className="storage-retained"><p>迁移后保留的原位置备份：</p>{status.retained.map((e, i) => <code key={i}>{e.path}</code>)}</div>}
      </footer>
    </>}
    {confirm && <div className="storage-modal-backdrop" role="presentation"><div className="storage-modal" role="alertdialog" aria-modal="true" aria-labelledby="storage-confirm-title" aria-describedby="storage-confirm-description" onKeyDown={e => { if (e.key === "Escape") setConfirm(null); }}>
      <div className="storage-modal-heading"><span className={`storage-modal-icon${cleanupTarget?.destructive ? " is-danger" : ""}`}><StorageIcon name={confirm.kind === "paths" ? "folder" : cleanupTarget?.destructive ? "warning" : "trash"} /></span>
        <button className="storage-button is-quiet is-icon" type="button" aria-label="关闭确认窗口" onClick={() => setConfirm(null)}><StorageIcon name="close" /></button></div>
      <h2 id="storage-confirm-title">{confirm.kind === "paths" ? "更改存储位置？" : `${cleanupTarget?.destructive ? "删除" : "清理"}${CLEANUP_COPY[confirm.id].title}？`}</h2>
      <p id="storage-confirm-description">{confirm.kind === "paths" ? "下次启动将复制到新目录，并保留原位置的文件作为备份。" : "完全退出软件并重新启动后执行，重启前可随时取消。"}</p>
      <div className="storage-modal-body">{confirm.kind === "paths" ? changed.map(entry => <div className="storage-migration-row" key={entry.id}><strong>{entry.label}</strong><code>{entry.path}</code><StorageIcon name="arrow" /><code>{paths[entry.id]}</code></div>) : cleanupTarget && <>
        <div className="storage-modal-summary"><span>{CLEANUP_COPY[cleanupTarget.id].title}</span><strong>{formatBytes(cleanupTarget.bytes)}</strong></div>
        <div className={`storage-modal-explanation${cleanupTarget.destructive ? " is-danger" : ""}`}><StorageIcon name={cleanupTarget.destructive ? "warning" : "clock"} /><p>{cleanupTarget.destructive ? `${CLEANUP_COPY[cleanupTarget.id].description}将被永久删除，包含历史备份，无法恢复。请先备份需要的数据。` : CLEANUP_COPY[cleanupTarget.id].description}</p></div>
        {status?.pending && <p className="storage-inline-hint">已安排路径迁移，将先迁移，再清理新位置。</p>}
      </>}</div>
      <div className="storage-modal-actions"><button className="storage-button" type="button" autoFocus onClick={() => setConfirm(null)}>取消</button><button className={`storage-button ${cleanupTarget?.destructive ? "is-danger-filled" : "is-primary"}`} type="button" onClick={() => confirm.kind === "paths" ? void savePaths() : void scheduleCleanup(confirm.id, true)}>{confirm.kind === "paths" ? "确认更改" : cleanupTarget?.destructive ? "确认删除" : "确认清理"}</button></div>
    </div></div>}
  </div>;
}
