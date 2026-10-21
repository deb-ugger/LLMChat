import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type StorageStatus } from "../api";
import { toFriendlyError } from "../friendlyError";
import "./StoragePanel.css";

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
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"paths" | "cleanup" | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const current = status ? Object.fromEntries(status.entries.map(e => [e.id, e.path])) : {};
  const saved = status?.pending ?? current;
  const dirty = status?.entries.some(e => paths[e.id] !== saved[e.id]);
  const chosen = status?.cleanupOptions.filter(e => selected.includes(e.id)) ?? [];
  const destructive = chosen.some(e => e.destructive);

  function accept(next: StorageStatus) {
    setStatus(next);
    setPaths(next.pending ?? Object.fromEntries(next.entries.map(e => [e.id, e.path])));
    setSelected(next.cleanup);
  }
  async function refresh() {
    setBusy(true); setError("");
    try { accept(await api.getStorage()); }
    catch (e) { setError(toFriendlyError(e, "无法读取存储信息")); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (active && !status && !busy) void refresh(); }, [active]); // Fetch on first visit; keep drafts when switching tabs.

  async function perform(kind: "paths" | "cleanup" | "cancelPaths" | "cancelCleanup") {
    setBusy(true); setError(""); setMessage(""); setConfirm(null);
    try {
      accept(kind === "paths" || kind === "cancelPaths"
        ? await api.saveStoragePaths(kind === "paths" ? paths : current)
        : await api.scheduleStorageCleanup(kind === "cleanup" ? selected : []));
      setMessage(kind.startsWith("cancel") ? "已取消待执行操作。" : "已保存，完全退出软件并重新启动后执行。迁移会保留原位置文件作为备份。");
    } catch (e) { setError(toFriendlyError(e, "存储操作失败")); }
    finally { setBusy(false); }
  }

  return <div className="storage-panel" hidden={!active}>
    <section className="settings-card storage-intro">
      <div className="storage-heading"><div><h2>存储</h2><p className="hint">查看软件文件的实际位置、修改存储目录，或按类别清理文件与缓存。</p></div>
        <button type="button" disabled={busy || !!dirty} onClick={() => void refresh()}>{busy ? "正在读取…" : "刷新占用"}</button></div>
      <p className="hint">路径修改和文件清理在下次启动、数据库与浏览器尚未打开时执行。迁移只复制软件数据并保留原件，新目录必须为空；迁移失败时继续使用原路径，并显示原因。</p>
      {status && <p className="storage-total">当前管理的文件约 <strong>{formatBytes(status.entries.reduce((sum, e) => sum + e.bytes, 0))}</strong></p>}
      {message && <p role="status" className="storage-success">{message}</p>}
      {(error || status?.error) && <p role="alert" className="storage-error">{error || status?.error}</p>}
      {!status && !busy && <button type="button" onClick={() => void refresh()}>重试</button>}
    </section>

    {status && <>
      <section className="settings-card">
        <div className="storage-heading"><h2>文件路径</h2><span className="hint">按用途分别设置目录</span></div>
        <div className="storage-paths">{status.entries.map(entry => <article className="storage-path" key={entry.id}>
          <div className="storage-heading"><label htmlFor={`storage-${entry.id}`}>{entry.label}</label><span>{formatBytes(entry.bytes)}{!entry.exists ? " · 尚未生成" : ""}</span></div>
          <p className="hint">{entry.description}</p>
          <div className="storage-path-input"><input id={`storage-${entry.id}`} value={paths[entry.id] ?? ""} disabled={busy} spellCheck={false}
            onChange={e => setPaths(p => ({ ...p, [entry.id]: e.target.value }))} />
            <button type="button" disabled={busy} onClick={() => { void (async () => {
              try {
                const value = await open({ directory: true, multiple: false, title: `选择${entry.label}目录`, defaultPath: paths[entry.id] || undefined });
                if (typeof value === "string") setPaths(p => ({ ...p, [entry.id]: value }));
              } catch (e) { setError(toFriendlyError(e, "无法选择目录")); }
            })(); }}>选择目录</button>
            <button type="button" disabled={busy || !entry.exists} onClick={() => { void api.openPath(entry.path).catch(e => setError(toFriendlyError(e))); }}>打开</button>
          </div>
          {paths[entry.id] !== entry.path && <p className="storage-current">当前仍使用：<code>{entry.path}</code></p>}
          {entry.files.length > 0 && <details className="storage-file-list"><summary>查看文件与子目录位置（{entry.files.length}）</summary>{entry.files.map(f => <div key={f.path}><code>{f.path}</code><span>{f.exists ? formatBytes(f.bytes) : "尚未生成"}</span></div>)}</details>}
        </article>)}</div>
        <div className="storage-actions">
          <button type="button" className="settings-save-current" disabled={busy || !dirty} onClick={() => { setAcknowledged(false); setConfirm("paths"); }}>保存路径修改</button>
          {dirty && <button type="button" disabled={busy} onClick={() => setPaths(saved)}>撤销未保存修改</button>}
          {status.pending && <button type="button" disabled={busy} onClick={() => void perform("cancelPaths")}>取消待执行迁移</button>}
        </div>
        {status.pending && <p role="status" className="hint">已有路径迁移等待下次启动执行。旧位置文件会保留，迁移后请确认数据完整再自行删除备份。</p>}
      </section>

      <section className="settings-card">
        <h2>文件与缓存清理</h2><p className="hint">勾选后查看清理范围。聊天记录、用量记录和翻译工程会永久删除；模型、安装包等缓存可重新下载。已排队的类别会在下次启动时清理当时的全部对应内容。</p>
        <div className="storage-cleanup">{status.cleanupOptions.map(option => <label key={option.id} className={`storage-cleanup-row${option.destructive ? " is-destructive" : ""}`}>
          <input type="checkbox" checked={selected.includes(option.id)} disabled={busy} onChange={e => setSelected(ids => e.target.checked ? [...ids, option.id] : ids.filter(id => id !== option.id))} />
          <span>{option.label}{status.cleanup.includes(option.id) && <small>已排队</small>}</span><span>{formatBytes(option.bytes)}</span>
        </label>)}</div>
        <div className="storage-actions"><button type="button" disabled={busy || !!dirty || !selected.length} onClick={() => { setAcknowledged(false); setConfirm("cleanup"); }}>清理所选项目（{formatBytes(chosen.reduce((sum, e) => sum + e.bytes, 0))}）</button>
          {!!status.cleanup.length && <button type="button" disabled={busy || !!dirty} onClick={() => void perform("cancelCleanup")}>取消全部待执行清理</button>}</div>
        {dirty && <p className="hint">请先保存或撤销路径修改，再安排清理。</p>}
      </section>

      <section className="settings-card storage-other"><h2>其他文件位置</h2>
        <p>程序与内置资源：<code>{status.programDir}</code>。内置 OCR、WASM 和页面资源随程序更新，不能作为缓存单独删除。</p>
        <p>存储路径索引：<code>{status.locator}</code>（及其 .bak/.tmp），必须留在程序旁，用于下次启动定位数据。</p>
        <p>用户另存的译文、导出文件和选择打开的原始文档：位于保存/打开时选择的位置；Unity 补丁、游戏翻译文本、配置及日志位于对应游戏目录。请在翻译工程或 Unity 页面管理这些文件。</p>
        {status.retained.length > 0 && <details><summary>迁移后保留的原位置备份（不计入当前占用）</summary>{status.retained.map((e, i) => <p key={i}><code>{e.path}</code>（{e.id}）</p>)}<p className="hint">软件数据目录仅备份其中的软件数据文件；其他类别保留原目录。确认新位置数据完整后可自行删除原件。</p></details>}
      </section>
    </>}

    {confirm && <div className="ocr-confirm-backdrop" role="presentation"><div className="ocr-confirm-dialog storage-confirm" role="alertdialog" aria-modal="true" aria-labelledby="storage-confirm-title" onKeyDown={e => { if (e.key === "Escape") setConfirm(null); }}>
      <h3 id="storage-confirm-title">{confirm === "paths" ? "确认修改存储路径" : "确认清理所选文件"}</h3>
      <div className="storage-confirm-body">{confirm === "paths" ? <>
        <p>下次启动将复制以下类别的数据到新目录，保留原件；不会覆盖新位置已有文件。</p>
        {status?.entries.filter(e => paths[e.id] !== e.path).map(e => <p key={e.id}><strong>{e.label}</strong><br /><code>{e.path}</code><br />→ <code>{paths[e.id]}</code></p>)}
      </> : <>
        <p>下次启动将删除以下类别当时的全部内容。若同时迁移路径，会先完成迁移，再清理新位置。请在退出前完成需要的备份。</p>
        {chosen.map(e => <details key={e.id}><summary>{e.label} · {formatBytes(e.bytes)}</summary>{e.paths.length ? e.paths.map(p => <p key={p}><code>{p}</code></p>) : <p className="hint">当前没有文件；仍会清理下次启动时对应类别的内容。</p>}</details>)}
        {destructive && <label className="storage-ack"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />我已备份需要的数据，理解聊天记录、用量或工程删除后不可恢复。</label>}
      </>}</div>
      <div className="ocr-confirm-actions"><button type="button" autoFocus onClick={() => setConfirm(null)}>取消</button><button type="button" disabled={confirm === "cleanup" && destructive && !acknowledged} onClick={() => void perform(confirm)}>确认并在下次启动执行</button></div>
    </div></div>}
  </div>;
}
