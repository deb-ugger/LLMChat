import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { API_BASE, api } from "../api";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
const paths: Record<string, string> = { back: "m14 5-7 7 7 7M7 12h14", extract: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5", json: "M7 3H4v18h3m10-18h3v18h-3M10 8l-2 4 2 4m4-8 2 4-2 4", backup: "M4 4h16v6H4zM6 10v11h12V10m-9 4h6", refresh: "M20 8a8 8 0 1 0 0 8m0-13v5h-5", rollback: "M9 4 3 10l6 6M3 10h11a6 6 0 0 1 0 12", inspect: "M4 4h11v16H4zM8 9h3m-3 5h3m6-2 3 3 4-6", generate: "M5 3h10l4 4v14H5zM9 12h6m-3-3v6", apply: "m4 12 5 5 11-12", stop: "M5 5h14v14H5z", open: "M10 4H3v17h17v-7M14 3h7v7m0-7L10 14", help: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m-3 7a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3v1" };
function IconAction({ name, label, caption, disabled, onClick }: { name: string; label: string; caption?: string; disabled?: boolean; onClick?: () => void }) {
  const [anchor,setAnchor]=useState<DOMRect|null>(null),[position,setPosition]=useState({left:8,top:8});const tip=useRef<HTMLDivElement>(null);const dismissed=useRef(false);
  useLayoutEffect(()=>{if(!anchor||!tip.current)return;const box=tip.current.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(anchor.left,window.innerWidth-box.width-8)),top:Math.max(8,Math.min(anchor.bottom+6,window.innerHeight-box.height-8))});},[anchor]);
  useEffect(()=>{if(!anchor)return;const close=()=>setAnchor(null);window.addEventListener("scroll",close,true);window.addEventListener("resize",close);window.addEventListener("blur",close);return()=>{window.removeEventListener("scroll",close,true);window.removeEventListener("resize",close);window.removeEventListener("blur",close);};},[anchor]);
  return <span className="embed-action" onPointerDownCapture={()=>{dismissed.current=true;setAnchor(null);}} onKeyDown={event=>{if(["Escape","Enter"," "].includes(event.key)){dismissed.current=true;setAnchor(null);}}} onMouseEnter={event=>{dismissed.current=false;setAnchor(event.currentTarget.getBoundingClientRect());}} onMouseLeave={()=>setAnchor(null)} onFocus={event=>{if(!dismissed.current)setAnchor(event.currentTarget.getBoundingClientRect());}} onBlur={()=>setAnchor(null)}><button type="button" className={`embed-icon${name==="help"?" is-help":""}${caption?" has-caption":""}`} aria-label={label} disabled={disabled} onClick={()=>{dismissed.current=true;setAnchor(null);onClick?.();}}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>{caption&&<span>{caption}</span>}</button>{anchor&&createPortal(<div ref={tip} role="tooltip" className="embed-tooltip" style={position}>{label}</div>,document.body)}</span>;
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
  const [backupMode,setBackupMode]=useState<"auto"|"manual">(()=>localStorage.getItem(`llmchat-game-backup:${game.path}`)==="manual"?"manual":"auto");
  const [backupScopes,setBackupScopes]=useState<string[]>(["text"]);
  const [pendingAction,setPendingAction]=useState("");
  const [fontPath,setFontPath]=useState(""); const [imageManifest,setImageManifest]=useState(""); const [editedDirectory,setEditedDirectory]=useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" }), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const [logs,setLogs]=useState<Array<{id:number;text:string;failed:boolean}>>([]);const logKey=useRef("");const logId=useRef(0);const logBottom=useRef<HTMLDivElement>(null);
  useEffect(()=>{const text=error||status.detail;if(!text)return;const key=`${status.action||""}:${status.state}:${text}`;if(logKey.current===key)return;logKey.current=key;setLogs(current=>[...current,{id:++logId.current,text,failed:!!error||status.state==="error"}].slice(-200));},[error,status.action,status.state,status.detail]);
  useEffect(()=>{logBottom.current?.scrollIntoView({block:"nearest"});},[logs]);
  const [backups, setBackups] = useState<Backup[]>([]), [backupId, setBackupId] = useState("");
  const touched = useRef(false), busy = pending || status.state === "running";
  const busyRef = useRef(busy); busyRef.current = busy;
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
    touched.current = true; setPending(true); setPendingAction(action); setError("");
    try { setStatus(await call<Status>("start", { action, gamePath: game.path, jsonPath: file, backupId, fontPath, imageManifest, editedDirectory, backupMode, backupScopes })); }
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
    if (busyRef.current) return;
    touched.current = true;
    if (/\.json$/i.test(path)) { setFile(path); setStatus({ state: "idle" }); }
    else onGameDrop(path);
  };
  useEffect(() => {
    if (!isTauri() || !active) return;
    let disposed = false, unlisten: (() => void) | undefined;
    void getCurrentWindow().onDragDropEvent(event => {
      if (event.payload.type === "drop" && event.payload.paths[0]) void dropped(event.payload.paths[0]);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(cause => setError(String(cause)));
    return () => { disposed = true; unlisten?.(); };
  }, [active]);
  const pickExtra = async (kind: "font"|"manifest"|"directory"|"image") => {try {const selected=await open(kind==="directory"?{directory:true,multiple:false}:{multiple:false,filters:[{name:kind,extensions:kind==="font"?["ttf","otf"]:kind==="image"?["png"]:["json"]}]});if(typeof selected!=="string")return;if(kind==="font")setFontPath(selected);else if(kind==="manifest")setImageManifest(selected);else if(kind==="directory")setEditedDirectory(selected);else {sessionStorage.setItem("llmchat-game-image",selected);window.dispatchEvent(new Event("llmchat-open-game-image"));}}catch(cause){setError(String(cause));}};
  const openText = () => {const source=status.exportPath||file;if(source){sessionStorage.setItem("llmchat-game-text",source);window.dispatchEvent(new Event("llmchat-open-game-text"));}};
  const progress = (actions: string[]) => {
    const action=pending ? pendingAction : status.action;
    if(!action||!actions.includes(action)||(!status.detail&&!pending))return null;
    return <div className="embed-progress" aria-label="工作进度"><div><strong>{pending?"正在准备…":status.detail}</strong>{status.state==="running"&&status.action!=="rollback"&&<IconAction name="stop" label="中止当前操作" onClick={()=>void call("stop",{}).catch(e=>setError(String(e)))}/>}</div><progress aria-label="当前阶段进度" max={status.total||1} value={pending||status.state==="running"&&!status.total?undefined:status.state==="running"||status.state==="error"?status.completed||0:status.total||1}/>{status.state==="running"&&!!status.total&&<span>{status.completed||0} / {status.total}</span>}</div>;
  };
  const output = (label:string,path?:string) => path&&<div className="json-embedding-output"><span>{label}<code>{path}</code></span><IconAction name="open" label={`打开${label}所在目录`} onClick={()=>void api.revealPath(path).catch(e=>setError(String(e)))}/></div>;
  return <div className="json-embedding-view" onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();const file=event.dataTransfer.files[0] as (File&{path?:string})|undefined;const raw=file?.path||event.dataTransfer.getData("text/uri-list").split(/\r?\n/).find(line=>!line.startsWith("#"));if(raw)void dropped(raw.startsWith("file://")?decodeURIComponent(raw.replace(/^file:\/\/\/?/,"")):raw);}}>
    <aside className="embed-sidebar">
      <header className="json-embedding-head"><IconAction name="back" label="返回游戏列表" disabled={busy} onClick={onBack}/></header>
      <div className="embed-game-info"><strong>{game.name}</strong><span className="embed-engine">{game.engine}</span><div className="embed-game-path"><code>{game.path}</code><IconAction name="open" label="打开游戏目录" onClick={()=>void api.revealPath(game.path).catch(e=>setError(String(e)))}/></div></div>
      <section className="embed-section" data-section="backup"><header><h3>备份与恢复</h3><IconAction name="help" label="自动：应用前创建并保留备份。手动：选择对应备份范围并点击备份图标，成功应用后不保留新增自动备份；未手动备份的改动无法回滚。应用失败仍尝试恢复原资源。"/></header>
        <label className="embed-field">备份方式<select aria-label="备份方式" value={backupMode} disabled={busy} onChange={e=>{const mode=e.target.value as "auto"|"manual";setBackupMode(mode);localStorage.setItem(`llmchat-game-backup:${game.path}`,mode);}}><option value="auto">自动备份</option><option value="manual">手动备份</option></select></label>
        {game.engine.startsWith("RPG Maker")&&<fieldset className="embed-scopes" disabled={busy||backupMode==="auto"}><legend>手动备份范围</legend><label><input type="checkbox" aria-label="全部备份范围" checked={backupScopes.length===3} onChange={e=>setBackupScopes(e.target.checked?["text","runtime","images"]:[])}/>全部</label>{[["text","文本资源"],["runtime","插件与字体"],["images","图片资源"]].map(([scope,label])=><label key={scope}><input type="checkbox" aria-label={label} checked={backupScopes.includes(scope)} onChange={e=>setBackupScopes(current=>e.target.checked?[...current,scope]:current.filter(item=>item!==scope))}/>{label}</label>)}</fieldset>}

        <div className="json-embedding-actions"><IconAction name="backup" caption="备份" label="立即备份原资源，不修改游戏" disabled={busy||!game.supported||!backupScopes.length} onClick={()=>void start("backup")}/><IconAction name="refresh" label="刷新备份列表" disabled={busy} onClick={()=>void loadBackups()}/><IconAction name="rollback" caption="回滚" label="回滚所选备份的原资源" disabled={busy||!backupId} onClick={()=>void start("rollback")}/></div>
        <select aria-label="选择回滚备份" disabled={busy||!backups.length} value={backupId} onChange={e=>setBackupId(e.target.value)}><option value="">选择备份</option>{backups.map((item,index)=><option key={item.id} value={item.id} disabled={item.state==="rolledBack"}>{index+1} · {item.resources} 组资源 · {item.state==="snapshot"?"独立备份":item.state==="rolledBack"?"已回滚":item.state==="applied"?"已应用":"待恢复"}</option>)}</select>
        {progress(["backup","rollback"])}{output("备份",status.backupPath)}
      </section>
    </aside>
    <main className="embed-workspace">
      <section className="embed-section" data-section="text"><header><h3>文本翻译</h3><IconAction name="help" label="导出 MTool JSON，在文本翻译工程翻译后导入；也可使用已有译文。保留脚本、标识符和资源路径。应用前请关闭游戏。"/><div className="json-embedding-actions"><IconAction name="extract" caption="提取原文" label="提取游戏文本并导出 MTool JSON" disabled={busy} onClick={()=>void start("extract")}/><IconAction name="open" caption="进入翻译工程" label="使用文本翻译工程翻译原文" disabled={busy||!(status.exportPath||file)} onClick={openText}/><IconAction name="json" caption="导入翻译" label="选择翻译 JSON，也可拖入" disabled={busy} onClick={()=>void pick()}/></div></header>

        {output("MTool JSON",status.exportPath)}
        <div className="embed-form-row"><label className="embed-field embed-inline-field"><span>翻译 JSON</span><div className="json-embedding-path"><input aria-label="翻译 JSON" placeholder="选择翻译完成的 JSON" value={file} disabled={busy} onChange={e=>{setFile(e.target.value);setStatus({state:"idle"});}}/></div></label><div className="json-embedding-actions"><IconAction name="inspect" caption="检查译文" label="检查译文匹配" disabled={busy||!file.trim()} onClick={()=>void start("inspect")}/><IconAction name="generate" caption="生成补丁" label="生成嵌入补丁" disabled={busy||status.state!=="ready"||!status.matched} onClick={()=>void start("embed")}/><IconAction name="apply" caption="应用译文" label="应用到游戏，请先关闭游戏" disabled={busy||status.state!=="done"} onClick={()=>void start("apply")}/></div></div>
        {progress(["extract","inspect","embed","apply"])}
        {status.dictionaryEntries!==undefined&&<dl className="json-embedding-counts"><div><dt>词典条目</dt><dd>{status.dictionaryEntries.toLocaleString()}</dd></div>{status.matched!==undefined&&<div><dt>命中次数</dt><dd>{status.matched.toLocaleString()}</dd></div>}{status.blocked!==undefined&&<div><dt>异常，保留原文</dt><dd>{status.blocked.toLocaleString()}</dd></div>}</dl>}
        {!!status.issues?.length&&<details><summary>需修正的译文 · {status.issues.length}</summary>{status.issues.map((issue,index)=><details key={index}><summary>{issue.file} · {issue.reason}</summary><p>{issue.source}</p><p>{issue.translation}</p></details>)}</details>}
        {output("补丁目录",status.patchPath)}
        {game.engine.startsWith("RPG Maker")&&<details className="embed-runtime-options" data-section="runtime" open={status.action==="runtime"?true:undefined}><summary>运行时加载译文</summary><header><IconAction name="help" label="使用本节选择的翻译 JSON，按完整原文查找并缓存译文，同步绘字与测宽。可加载中文字体；自动备份的安装记录可回滚卸载。"/></header>
          <div className="embed-form-row"><label className="embed-field embed-inline-field"><span>中文字体</span><div className="json-embedding-path"><input aria-label="中文字体" value={fontPath} placeholder="可选 TTF / OTF" disabled={busy} onChange={e=>setFontPath(e.target.value)}/><IconAction name="json" label="选择中文字体，随本地翻译插件加载" disabled={busy} onClick={()=>void pickExtra("font")}/></div></label><IconAction name="apply" caption="安装插件" label="安装或更新本地 JSON 翻译插件" disabled={busy||!file} onClick={()=>void start("runtime")}/></div>{progress(["runtime"])}
        </details>}
      </section>
      {game.engine.startsWith("RPG Maker")&&<>
        <section className="embed-section embed-images" data-section="images"><header><h3>图片翻译与回写</h3><IconAction name="help" label="先解密导出图片，再进入图片识别翻译。下载 PNG 译图时保留原文件名与尺寸，选择译图目录后重新加密并应用；仅替换已修改图片。"/><div className="json-embedding-actions"><IconAction name="extract" caption="导出图片" label="解密并导出游戏图片" disabled={busy} onClick={()=>void start("images-export")}/><IconAction name="open" caption="翻译图片" label="选择导出图片，进入图片识别与翻译" disabled={busy} onClick={()=>void pickExtra("image")}/></div></header>

          <div className="embed-image-fields embed-form-row"><div className="embed-field"><div className="embed-field-title"><label htmlFor="embed-manifest">图片映射清单</label><IconAction name="json" label="选择图片映射清单" disabled={busy} onClick={()=>void pickExtra("manifest")}/></div><div className="json-embedding-path"><input id="embed-manifest" aria-label="图片映射清单" placeholder="images.json" value={imageManifest} disabled={busy} onChange={e=>setImageManifest(e.target.value)}/></div></div><div className="embed-field"><div className="embed-field-title"><label htmlFor="embed-directory">译图目录</label><IconAction name="open" label="选择译图目录" disabled={busy} onClick={()=>void pickExtra("directory")}/></div><div className="json-embedding-path"><input id="embed-directory" aria-label="译图目录" placeholder="同名 PNG 译图所在目录" value={editedDirectory} disabled={busy} onChange={e=>setEditedDirectory(e.target.value)}/></div></div><IconAction name="apply" caption="应用译图" label="重新加密译图并应用；仅替换已修改图片" disabled={busy||!imageManifest||!editedDirectory} onClick={()=>void start("images-apply")}/></div>
          {progress(["images-export","images-apply"])}{output("图片目录",status.imagesPath)}
        </section>
      </>}
      {output("工作目录",status.outputPath)}
    </main>
    <section className="embed-log" aria-label="输出"><header><strong>输出</strong></header><div className="embed-log-lines" role="log" aria-live="polite">{logs.map(entry=><p key={entry.id} className={entry.failed?"is-error":undefined}>{entry.text}</p>)}<div ref={logBottom}/></div></section>
  </div>;
}
