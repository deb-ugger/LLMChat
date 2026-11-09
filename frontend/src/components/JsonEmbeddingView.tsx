import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { API_BASE, api } from "../api";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
const paths: Record<string, string> = { back: "m14 5-7 7 7 7M7 12h14", extract: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5", json: "M7 3H4v18h3m10-18h3v18h-3M10 8l-2 4 2 4m4-8 2 4-2 4", backup: "M4 4h16v6H4zM6 10v11h12V10m-9 4h6", refresh: "M20 8a8 8 0 1 0 0 8m0-13v5h-5", rollback: "M9 4 3 10l6 6M3 10h11a6 6 0 0 1 0 12", inspect: "M4 4h11v16H4zM8 9h3m-3 5h3m6-2 3 3 4-6", generate: "M5 3h10l4 4v14H5zM9 12h6m-3-3v6", apply: "m4 12 5 5 11-12", stop: "M5 5h14v14H5z", open: "M10 4H3v17h17v-7M14 3h7v7m0-7L10 14", help: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m-3 7a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3v1" };
function IconAction({ name, label, disabled, onClick }: { name: string; label: string; disabled?: boolean; onClick?: () => void }) {
  return <button type="button" className="embed-icon" aria-label={label} data-tooltip={label} disabled={disabled} onClick={onClick}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg></button>;
}
export type EmbeddingGame = { path: string; name: string; engine: string; supported: boolean };
type Backup = { id: string; path: string; state: string; resources: number };
type Status = { issues?: Array<{file:string;source:string;translation:string;reason:string}>; state: string; action?: string; detail?: string; gamePath?: string; jsonPath?: string; outputPath?: string; exportPath?: string; imagesPath?: string; imageManifest?: string; patchPath?: string; backupPath?: string; matched?: number; blocked?: number; dictionaryEntries?: number; completed?: number; total?: number };
async function call<T>(action: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/api/json-embedding/${action}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || "操作失败"); return value;
}
export function JsonEmbeddingView({ onBack, initialGame: game, onGameDrop, active = true }: { onBack: () => void; initialGame: EmbeddingGame; onGameDrop: (path: string) => void; active?: boolean }) {
  const [file, setFile] = useState("");
  const [fontPath,setFontPath]=useState(""); const [imageManifest,setImageManifest]=useState(""); const [editedDirectory,setEditedDirectory]=useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" }), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const [backups, setBackups] = useState<Backup[]>([]), [backupId, setBackupId] = useState("");
  const touched = useRef(false), busy = pending || status.state === "running";
  const busyRef = useRef(busy); busyRef.current = busy;
  const [dragging, setDragging] = useState(false);
  useEffect(() => { let alive = true; void call<Status>("status").then(value => {
    if (alive && !touched.current && value.gamePath === game.path) { setFile(value.jsonPath || ""); setStatus(value); }
  }).catch(cause => { if (alive) setError(String(cause)); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (status.state !== "running") return;
    let alive = true, timer: number;
    const poll = async () => { try { const value = await call<Status>("status"); if(value.imageManifest)setImageManifest(value.imageManifest); if (alive) { setStatus(value); if (value.state === "running") timer = window.setTimeout(poll, 400); } } catch (cause) { if (alive) setError(String(cause)); } };
    timer = window.setTimeout(poll, 200); return () => { alive = false; window.clearTimeout(timer); };
  }, [status.state]);
  const loadBackups = async () => {
    setPending(true); setError("");
    try { const response = await fetch(`${API_BASE}/api/json-embedding/backups?gamePath=${encodeURIComponent(game.path)}`); const values = await response.json(); if (!response.ok) throw new Error(values.error); setBackups(values); setBackupId(values.find((item: Backup) => item.state !== "rolledBack")?.id || ""); }
    catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  useEffect(() => { if (["idle", "backedUp", "applied", "rolledBack"].includes(status.state) || status.action === "backup" && status.state !== "running" && status.state !== "error") void loadBackups(); }, [status.state, status.action, game.path]);
  const start = async (action: string) => {
    touched.current = true; setPending(true); setError("");
    try { setStatus(await call<Status>("start", { action, gamePath: game.path, jsonPath: file, backupId, fontPath, imageManifest, editedDirectory })); }
    catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  const pick = async () => {
    try {
      const path = await open({ multiple: false, filters: [{ name: "翻译 JSON", extensions: ["json"] }] });
      if (typeof path !== "string") return; touched.current = true;
      setFile(path); setStatus({ state: "idle" });
    } catch (cause) { setError(String(cause)); }
  };
  const dropped = async (path: string) => {
    if (busyRef.current) { setDragging(false); return; }
    setDragging(false); touched.current = true;
    if (/\.json$/i.test(path)) { setFile(path); setStatus({ state: "idle" }); }
    else onGameDrop(path);
  };
  useEffect(() => {
    if (!isTauri() || !active) return;
    let disposed = false, unlisten: (() => void) | undefined;
    void getCurrentWindow().onDragDropEvent(event => {
      if (event.payload.type === "enter" || event.payload.type === "over") setDragging(true);
      if (event.payload.type === "leave") setDragging(false);
      if (event.payload.type === "drop" && event.payload.paths[0]) void dropped(event.payload.paths[0]);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(cause => setError(String(cause)));
    return () => { disposed = true; unlisten?.(); };
  }, [active]);
  const pickExtra = async (kind: "font"|"manifest"|"directory"|"image") => {try {const selected=await open(kind==="directory"?{directory:true,multiple:false}:{multiple:false,filters:[{name:kind,extensions:kind==="font"?["ttf","otf"]:kind==="image"?["png"]:["json"]}]});if(typeof selected!=="string")return;if(kind==="font")setFontPath(selected);else if(kind==="manifest")setImageManifest(selected);else if(kind==="directory")setEditedDirectory(selected);else {sessionStorage.setItem("llmchat-game-image",selected);window.dispatchEvent(new Event("llmchat-open-game-image"));}}catch(cause){setError(String(cause));}};
  const openText = () => {if(status.exportPath){sessionStorage.setItem("llmchat-game-text",status.exportPath);window.dispatchEvent(new Event("llmchat-open-game-text"));}};
  return <div className={`json-embedding-view${dragging ? " is-dragging" : ""}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0] as (File & { path?: string }) | undefined; const raw = file?.path || event.dataTransfer.getData("text/uri-list").split(/\r?\n/).find(line => !line.startsWith("#")); if (raw) void dropped(raw.startsWith("file://") ? decodeURIComponent(raw.replace(/^file:\/\/\/?/, "")) : raw); else setDragging(false); }}>
    <header className="json-embedding-head"><IconAction name="back" label="返回游戏列表" disabled={busy} onClick={onBack} /><h2>{game.name} · {game.engine}</h2></header>
    {game && <section className="embed-section"><h3>备份与恢复</h3><div className="json-embedding-actions">
      <IconAction name="backup" label="立即备份原资源，不修改游戏" disabled={busy || !game.supported} onClick={() => void start("backup")} />
      <IconAction name="refresh" label="刷新备份列表" disabled={busy} onClick={() => void loadBackups()} />
      <select aria-label="选择回滚备份" disabled={busy || !backups.length} value={backupId} onChange={event => setBackupId(event.target.value)}><option value="">选择备份</option>{backups.map((item, index) => <option key={item.id} value={item.id} disabled={item.state === "rolledBack"}>{index + 1} · {item.resources} 组资源 · {item.state === "snapshot" ? "独立备份" : item.state === "rolledBack" ? "已回滚" : item.state === "applied" ? "已应用" : "待恢复"}</option>)}</select>
      <IconAction name="rollback" label="回滚所选备份的原资源" disabled={busy || !backupId} onClick={() => void start("rollback")} /></div><IconAction name="help" label="备份保存于游戏目录的 LLMChat-JSON/backups。应用前还会自动保留原件；回滚会保留当前资源中的改动。" /></section>}
    {game.supported && <section className="embed-section"><h3>提取文本与导入译文</h3><div className="json-embedding-actions"><IconAction name="extract" label="提取游戏文本并导出 MTool JSON" disabled={busy} onClick={() => void start("extract")} /></div><div className="json-embedding-path"><input aria-label="翻译 JSON" placeholder="选择翻译完成的 MTool 原文 → 译文 JSON" value={file} disabled={busy} onChange={event => { setFile(event.target.value); setStatus({ state: "idle" }); }} /><IconAction name="json" label="选择翻译 JSON，也可拖入" disabled={busy} onClick={() => void pick()} /></div>
      <div className="json-embedding-actions"><IconAction name="inspect" label="检查译文匹配" disabled={busy || !file.trim()} onClick={() => void start("inspect")} /><IconAction name="generate" label="生成嵌入补丁" disabled={busy || status.state !== "ready" || !status.matched} onClick={() => void start("embed")} /><IconAction name="apply" label="备份并应用到游戏，请先关闭游戏" disabled={busy || status.state !== "done"} onClick={() => void start("apply")} /></div><IconAction name="help" label="提取对话、选项和数据库显示文本为原文→译文 JSON；在文本翻译工程翻译后导入。保留脚本、标识符和资源路径，不提取图片文字及任意插件代码。应用与回滚前请关闭游戏。" /></section>}
    {game.engine.startsWith("RPG Maker") && <section className="embed-section"><h3>本地翻译与图片</h3><div className="json-embedding-path"><input aria-label="中文字体" value={fontPath} placeholder="可选 TTF / OTF 字体" onChange={e=>setFontPath(e.target.value)} disabled={busy}/><IconAction name="json" label="选择中文字体，随本地翻译插件加载" disabled={busy} onClick={()=>void pickExtra("font")}/><IconAction name="apply" label="安装或更新本地 JSON 翻译插件；回滚对应备份可卸载" disabled={busy||!file} onClick={()=>void start("runtime")}/></div><div className="json-embedding-actions"><IconAction name="extract" label="解密并导出游戏图片" disabled={busy} onClick={()=>void start("images-export")}/><IconAction name="open" label="选择导出图片，进入图片识别与翻译" disabled={busy} onClick={()=>void pickExtra("image")}/></div><div className="json-embedding-path"><input aria-label="图片映射清单" placeholder="导出的 images.json" value={imageManifest} onChange={e=>setImageManifest(e.target.value)}/><IconAction name="json" label="选择图片映射清单" onClick={()=>void pickExtra("manifest")}/><input aria-label="译图目录" placeholder="保存同名 PNG 译图的目录" value={editedDirectory} onChange={e=>setEditedDirectory(e.target.value)}/><IconAction name="open" label="选择译图目录" onClick={()=>void pickExtra("directory")}/><IconAction name="apply" label="重新加密译图并备份应用；仅替换已修改图片" disabled={busy||!imageManifest||!editedDirectory} onClick={()=>void start("images-apply")}/></div><IconAction name="help" label="本地插件按完整原文查找并缓存结果，兼顾绘字与测宽。译图需保留导出文件名和原尺寸；图片识别页可下载同名 PNG。"/></section>}
    {status.imagesPath && <div className="json-embedding-output">图片目录：{status.imagesPath}<IconAction name="open" label="打开导出图片目录" onClick={()=>void api.revealPath(status.imagesPath!).catch(e=>setError(String(e)))}/></div>}
    {status.exportPath && <IconAction name="open" label="在文本翻译工程中创建翻译工程" onClick={openText}/>}
    {(busy || status.detail) && <section className="embed-progress" aria-label="工作进度"><div><strong>{status.state === "error" ? "操作失败" : status.detail || "正在处理…"}</strong>{status.state === "running" && status.action !== "rollback" && <IconAction name="stop" label="中止当前操作" onClick={() => void call("stop", {}).catch(cause => setError(String(cause)))} />}</div><progress aria-label="当前阶段进度" max={status.total || undefined} value={status.state === "error" ? status.completed || 0 : busy ? status.total ? status.completed || 0 : undefined : status.total || 1} />{busy && !!status.total && <span>{status.completed || 0} / {status.total}</span>}</section>}
    {(error || status.state === "error") && <p role="alert" className="boot-error">{error || status.detail}</p>}
    {!!status.issues?.length && <details><summary>需修正的译文 · {status.issues.length}</summary>{status.issues.map((issue,index)=><details key={index}><summary>{issue.file} · {issue.reason}</summary><p>{issue.source}</p><p>{issue.translation}</p></details>)}</details>}
    {status.dictionaryEntries !== undefined && <dl className="json-embedding-counts"><div><dt>词典条目</dt><dd>{status.dictionaryEntries.toLocaleString()}</dd></div><div><dt>命中次数</dt><dd>{status.matched?.toLocaleString()}</dd></div><div><dt>异常，保留原文</dt><dd>{status.blocked?.toLocaleString()}</dd></div></dl>}
    {status.outputPath && <div className="json-embedding-output">工作目录：{status.outputPath}<IconAction name="open" label="用默认文件管理器打开工作目录" onClick={() => void api.revealPath(status.outputPath!).catch(cause => setError(String(cause)))} /></div>}
    {status.exportPath && <div className="json-embedding-output">MTool JSON：{status.exportPath}<IconAction name="open" label="打开导出 JSON 所在目录" onClick={() => void api.revealPath(status.exportPath!).catch(cause => setError(String(cause)))} /></div>}
    {status.backupPath && <div className="json-embedding-output">备份：{status.backupPath}<IconAction name="open" label="用默认文件管理器打开备份" onClick={() => void api.revealPath(status.backupPath!).catch(cause => setError(String(cause)))} /></div>}
  </div>;
}
