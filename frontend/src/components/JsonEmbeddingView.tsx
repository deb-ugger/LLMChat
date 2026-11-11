import { useGameFileDrop,gameDropTarget } from "../hooks/useGameFileDrop";
import { UnityGameWorkspace } from "./UnityGameWorkspace";
import { GameWorkflowSteps } from "./GameWorkflowSteps";
import { GameImageWorkbench } from "./GameImageWorkbench";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { API_BASE, api, type Settings } from "../api";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
const paths: Record<string, string> = { back: "m14 5-7 7 7 7M7 12h14", extract: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5", json: "M7 3H4v18h3m10-18h3v18h-3M10 8l-2 4 2 4m4-8 2 4-2 4", backup: "M4 4h16v6H4zM6 10v11h12V10m-9 4h6", refresh: "M20 8a8 8 0 1 0 0 8m0-13v5h-5", rollback: "M9 4 3 10l6 6M3 10h11a6 6 0 0 1 0 12", inspect: "M4 4h11v16H4zM8 9h3m-3 5h3m6-2 3 3 4-6", generate: "M5 3h10l4 4v14H5zM9 12h6m-3-3v6", apply: "m4 12 5 5 11-12", stop: "M5 5h14v14H5z", open: "M10 4H3v17h17v-7M14 3h7v7m0-7L10 14", help: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m-3 7a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3v1" };
function IconAction({ name, label, caption, hint, disabled, onClick }: { name: string; label: string; caption?: string; hint?: string; disabled?: boolean; onClick?: () => void }) {
  const [anchor,setAnchor]=useState<DOMRect|null>(null),[position,setPosition]=useState({left:8,top:8});const tip=useRef<HTMLDivElement>(null);const dismissed=useRef(false);
  useLayoutEffect(()=>{if(!anchor||!tip.current)return;const box=tip.current.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(anchor.left,window.innerWidth-box.width-8)),top:Math.max(8,Math.min(anchor.bottom+6,window.innerHeight-box.height-8))});},[anchor]);
  useEffect(()=>{if(!anchor)return;const close=()=>setAnchor(null);window.addEventListener("scroll",close,true);window.addEventListener("resize",close);window.addEventListener("blur",close);return()=>{window.removeEventListener("scroll",close,true);window.removeEventListener("resize",close);window.removeEventListener("blur",close);};},[anchor]);
  return <span className="embed-action" onPointerDownCapture={()=>{dismissed.current=true;setAnchor(null);}} onKeyDown={event=>{if(["Escape","Enter"," "].includes(event.key)){dismissed.current=true;setAnchor(null);}}} onMouseEnter={event=>{dismissed.current=false;setAnchor(event.currentTarget.getBoundingClientRect());}} onMouseLeave={()=>setAnchor(null)} onFocus={event=>{if(!dismissed.current)setAnchor(event.currentTarget.getBoundingClientRect());}} onBlur={()=>setAnchor(null)}><button type="button" className={`embed-icon${name==="help"?" is-help":""}${caption?" has-caption":""}`} aria-label={label} disabled={disabled} onClick={()=>{dismissed.current=true;setAnchor(null);onClick?.();}}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>{caption&&<span>{caption}</span>}</button>{anchor&&createPortal(<div ref={tip} role="tooltip" className="embed-tooltip" style={position}>{hint||label}</div>,document.body)}</span>;
}
export type EmbeddingGame = { path: string; name: string; engine: string; supported: boolean };
type Backup = { id: string; path: string; state: string; resources: number };
type Status = { issues?: Array<{file:string;source:string;translation:string;reason:string}>; state: string; action?: string; detail?: string; gamePath?: string; jsonPath?: string; outputPath?: string; exportPath?: string; imagesPath?: string; imageManifest?: string; patchPath?: string; backupPath?: string; matched?: number; blocked?: number; dictionaryEntries?: number; completed?: number; total?: number };
async function call<T>(action: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/api/json-embedding/${action}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || "操作失败"); return value;
}
export function JsonEmbeddingView({ onBack, initialGame: game, onGameDrop, settings, active = true }: { settings: Settings; onBack: () => void; initialGame: EmbeddingGame; onGameDrop: (path: string) => void; active?: boolean }) {
  const [controlsTarget,setControlsTarget]=useState<HTMLDivElement|null>(null),[resultsTarget,setResultsTarget]=useState<HTMLDivElement|null>(null);
  const [imageScanRequest,setImageScanRequest]=useState(0);
  const imageLeaveGuard=useRef<((change:()=>void)=>void)|null>(null);
  const [textStep,setTextStep]=useState(1);
  const [part,setPart]=useState<"text"|"images">("text");const [imagesVisited,setImagesVisited]=useState(false);
  useEffect(()=>{if(part==="images")setImagesVisited(true);},[part]);
  const [imageWorkflow,setImageWorkflow]=useState({state:"idle",stage:"filter"});
  const [imageBusy,setImageBusy]=useState(false);const [detecting,setDetecting]=useState(true);
  const [patch,setPatch]=useState<{installed:boolean;managed?:boolean;legacy?:boolean;conflicts:string[]}>({installed:false,conflicts:[]});
  const loadPatch=async(adopt=false)=>{setDetecting(true);try{setPatch(await (adopt?call("detect-patch",{gamePath:game.path}):call("patch?gamePath="+encodeURIComponent(game.path))));}catch(cause){setError(String(cause));}finally{setDetecting(false);}};
  const [file, setFile] = useState("");
  const [backupMode,setBackupMode]=useState<"auto"|"manual">(()=>localStorage.getItem(`llmchat-game-backup:${game.path}`)==="manual"?"manual":"auto");
  const [backupScopes,setBackupScopes]=useState<string[]>(["text"]);
  const [pendingAction,setPendingAction]=useState("");
  const [fontPath,setFontPath]=useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" }), [error, setError] = useState(""), [pending, setPending] = useState(false);
  const [logs,setLogs]=useState<Array<{id:number;text:string;level:"info"|"warning"|"error"|"success"}>>([]);const logKey=useRef("");const logId=useRef(0);const logBottom=useRef<HTMLDivElement>(null);
  const appendLog=(text:string,level:"info"|"warning"|"error"|"success"="info")=>setLogs(current=>{const last=current[current.length-1];return last?.text===text&&last.level===level?current:[...current,{id:++logId.current,text,level}].slice(-200);});
  useEffect(()=>{const text=error||status.detail;if(!text)return;const level=error||status.state==="error"?"error":status.state==="done"?"success":"info";const key=`${level}:${text}`;if(logKey.current===key)return;logKey.current=key;appendLog(text,level);},[error,status.action,status.state,status.detail]);
  useEffect(()=>{logBottom.current?.scrollIntoView({block:"nearest"});},[logs]);
  useEffect(()=>{if(status.state!=="running"&&status.state!=="idle"){void loadPatch();}},[game.path,status.state]);
  const [backups, setBackups] = useState<Backup[]>([]), [backupId, setBackupId] = useState("");
  const touched = useRef(false), busy = pending || detecting || imageBusy || status.state === "running";
  const busyRef = useRef(busy); busyRef.current = busy;
  useEffect(() => { let alive = true; void call<Status>("status").then(async value => {
    if (alive && !touched.current && value.gamePath === game.path) { setFile(value.jsonPath || "");setStatus(value);if(value.action?.includes("images"))setPart("images"); }
    if(alive){await loadPatch(false);}
  }).catch(cause => { if (alive) setError(String(cause)); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (status.state !== "running") return;
    let alive = true, timer: number;
    const poll = async () => { try { const value = await call<Status>("status"); if (alive) { setStatus(value); if (value.state === "running") timer = window.setTimeout(poll, 400); } } catch (cause) { if (alive) setError(String(cause)); } };
    timer = window.setTimeout(poll, 200); return () => { alive = false; window.clearTimeout(timer); };
  }, [status.state]);
  const loadBackups = async () => {
    setPending(true); setError("");
    try { const response = await fetch(`${API_BASE}/api/json-embedding/backups?gamePath=${encodeURIComponent(game.path)}`); const values = await response.json(); if (!response.ok) throw new Error(values.error); setBackups(values); setBackupId(values.find((item: Backup) => item.state !== "rolledBack")?.id || ""); }
    catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  useEffect(() => { if (["idle", "backedUp", "applied", "rolledBack", "uninstalled", "cleaned"].includes(status.state) || status.action === "backup" && status.state !== "running" && status.state !== "error") void loadBackups(); }, [status.state, status.action, game.path]);
  const start = async (action: string,jsonPath=file) => {
    touched.current = true; setPending(true); setPendingAction(action); setError("");
    if(action==="extract"&&game.engine.startsWith("RPG Maker")){setImagesVisited(true);setImageScanRequest(value=>value+1);}
    try { const value=await call<Status>("start", { action, gamePath: game.path, jsonPath, backupId, fontPath, backupMode, backupScopes });setStatus(value); }
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
    if(/\.(json|csv|png|jpe?g|webp|bmp|zip)$/i.test(path))return;
    touched.current = true;onGameDrop(path);
  };
  useEffect(() => {
    if (!isTauri() || !active) return;
    let disposed = false, unlisten: (() => void) | undefined;
    void getCurrentWindow().onDragDropEvent(event => {
      if (event.payload.type === "drop" && event.payload.paths[0]&&!gameDropTarget(event.payload.position)?.closest("[data-game-drop-zone]")) void dropped(event.payload.paths[0]);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(cause => setError(String(cause)));
    return () => { disposed = true; unlisten?.(); };
  }, [active]);
  const pickFont = async () => {try{const selected=await open({multiple:false,filters:[{name:"字体",extensions:["ttf","otf"]}]});if(typeof selected==="string")setFontPath(selected);}catch(cause){setError(String(cause));}};


  const textDropRoot=useRef<HTMLDivElement>(null);
  const textDrop=useGameFileDrop({busy:status.action==="inspect"&&status.state==="running"||pendingAction==="inspect"&&pending,active:active&&part==="text"&&textStep===2&&!busy,root:textDropRoot,match:(_target,names)=>names.length<=1&&(!names[0]||/\.json$/i.test(names[0]))?textDropRoot.current:null,label:()=>"松开以导入翻译 JSON",drop:async source=>{const path=typeof source==="string"?source:(source as File&{path?:string}).path;if(!path)throw new Error("无法取得文件路径，请在桌面窗口拖入 JSON 文件，或使用导入按钮");touched.current=true;setFile(path);await start("inspect",path);},error:setError});
  const openText = () => {const source=status.exportPath||file;if(source){sessionStorage.setItem("llmchat-game-text",source);window.dispatchEvent(new Event("llmchat-open-game-text"));}};
  const progress = (actions: string[]) => {
    const action=pending ? pendingAction : status.action;
    if(!action||!actions.includes(action)||(!status.detail&&!pending))return null;
    return <div className="embed-progress" aria-label="工作进度"><div><strong>{pending?"正在准备…":status.detail}</strong>{status.state==="running"&&status.action!=="rollback"&&<IconAction name="stop" label="中止当前操作" onClick={()=>void call("stop",{}).catch(e=>setError(String(e)))}/>}</div><progress aria-label="当前阶段进度" max={status.total||1} value={pending||status.state==="running"&&!status.total?undefined:status.state==="running"||status.state==="error"||status.state==="paused"?status.completed||0:status.total||1}/>{status.state==="running"&&!!status.total&&<span>{status.completed||0} / {status.total}</span>}</div>;
  };
  const output = (label:string,path?:string) => path&&<div className="json-embedding-output"><button type="button" className="embed-path-link" aria-label={`打开${label}`} onClick={()=>void api.revealPath(path).catch(e=>setError(String(e)))}><span>{label}</span><code>{path}</code></button></div>;

  const backupPanel=(<section className="embed-section" data-section="backup"><header><h3>备份</h3><IconAction name="help" label="自动：应用前创建并保留备份。手动：选择对应备份范围并点击备份图标，成功应用后不保留新增自动备份；未手动备份的改动无法回滚。应用失败仍尝试恢复原资源。文本补丁卸载所需原件另行保存，不受此备份方式影响。"/></header>
        <label className="embed-field">备份方式<select aria-label="备份方式" value={backupMode} disabled={busy} onChange={e=>{const mode=e.target.value as "auto"|"manual";setBackupMode(mode);localStorage.setItem(`llmchat-game-backup:${game.path}`,mode);}}><option value="auto">自动备份</option><option value="manual">手动备份</option></select></label>
        {game.engine.startsWith("RPG Maker")&&<fieldset className="embed-scopes" disabled={busy||backupMode==="auto"}><legend>手动备份范围</legend>{[["text","文本资源"],["runtime","插件与字体"],["images","图片资源"]].map(([scope,label])=><label key={scope}><input type="checkbox" aria-label={label} checked={backupScopes.includes(scope)} onChange={e=>setBackupScopes(current=>e.target.checked?[...current,scope]:current.filter(item=>item!==scope))}/>{label}</label>)}</fieldset>}

        <div className="json-embedding-actions"><IconAction name="backup" caption="备份" label="立即备份原资源，不修改游戏" disabled={busy||!game.supported||!backupScopes.length} onClick={()=>void start("backup")}/></div>
        {progress(["backup"])}{output("备份",status.backupPath)}
      </section>);
  const restorePanel=(<section className="embed-section" data-section="restore"><header><h3>恢复</h3></header>        <select aria-label="选择回滚备份" disabled={busy||!backups.length} value={backupId} onChange={e=>setBackupId(e.target.value)}><option value="">选择备份</option>{backups.map((item,index)=><option key={item.id} value={item.id} disabled={item.state==="rolledBack"}>{index+1} · {item.resources} 组资源 · {item.state==="snapshot"?"独立备份":item.state==="rolledBack"?"已回滚":item.state==="applied"?"已应用":"待恢复"}</option>)}</select>
<div className="json-embedding-actions"><IconAction name="refresh" label="刷新备份列表" disabled={busy} onClick={()=>void loadBackups()}/><IconAction name="rollback" caption="恢复" label="回滚所选备份的原资源" disabled={busy||!backupId} onClick={()=>void start("rollback")}/></div>{progress(["rollback"])}</section>);

  const logPanel=<section className="unity-offline-footer" aria-label="任务输出"><div className="unity-output-heading"><strong>输出</strong></div><div className="unity-offline-log embed-log-lines" role="log" aria-live="polite">{logs.map(entry=><p key={entry.id} className={`is-${entry.level}`}>{entry.text}</p>)}<div ref={logBottom}/></div></section>;
  const selectWorkflow=(id:string)=>{const change=()=>{if(id==="2.2"){setPart("images");setTextStep(2);}else{setPart("text");setTextStep(id==="2.1"?2:Number(id));}};if(part==="images"&&id!=="2.2"&&imageLeaveGuard.current)imageLeaveGuard.current(change);else change();};
  const workflowSteps=<GameWorkflowSteps steps={[{id:"1",label:"扫描资源"},{id:"2.1",label:"翻译文本"},...(game.engine.startsWith("RPG Maker")?[{id:"2.2",label:"图片翻译"}]:[]),{id:"3",label:"生成补丁"},{id:"4",label:"应用到游戏"}].map(item=>{
    const selected=part==="images"?(textStep===4?item.id==="4":item.id==="2.2"):item.id===(textStep===2?"2.1":String(textStep));
    const operationStep=status.action==="extract"?"1":status.action==="inspect"?"2.1":status.action==="embed"?"3":"4";
    const imageStep=imageWorkflow.stage==="restore"?"4":"2.2";
    const state=imageWorkflow.state==="error"&&item.id===imageStep?"error":status.state==="error"&&operationStep===item.id?"error":item.id==="1"&&status.exportPath||item.id==="4"&&patch.installed?"complete":selected?"current":"pending";
    return {...item,number:item.id,state,selected,paused:imageWorkflow.state==="stopped"&&item.id===imageStep,running:imageBusy&&item.id===imageStep||status.state==="running"&&operationStep===item.id,onSelect:()=>selectWorkflow(item.id)};
  })}/>;
  return <div className="json-embedding-view" onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();const file=event.dataTransfer.files[0] as (File&{path?:string})|undefined;const raw=file?.path||event.dataTransfer.getData("text/uri-list").split(/\r?\n/).find(line=>!line.startsWith("#"));if(raw)void dropped(raw.startsWith("file://")?decodeURIComponent(raw.replace(/^file:\/\/\/?/,"")):raw);}}>
    {textDrop.overlay}
    <main className="embed-workspace embed-unity-workspace">
      <header className="embed-game-header"><IconAction name="back" label="返回游戏列表" disabled={busy} onClick={onBack}/><strong title={game.name}>{game.name}</strong><span className="embed-engine">{game.engine}</span><button type="button" className="embed-game-location" title={game.path} onClick={()=>void api.revealPath(game.path).catch(e=>setError(String(e)))}>{game.path}</button></header>

      <UnityGameWorkspace controls={<div ref={setControlsTarget} className="engine-workspace-slot"/>} results={<div ref={setResultsTarget} className="engine-workspace-slot engine-result-slot"/>} output={logPanel}/>
      {controlsTarget&&createPortal(<div hidden={part!=="text"} className="engine-workflow-content">{workflowSteps}<div className="unity-step-panel">

<header><h3>文本翻译</h3><IconAction name="help" label="导出 MTool JSON，在文本翻译工程翻译后导入；也可使用已有译文。保留脚本、标识符和资源路径。应用前请关闭游戏。"/><div className="json-embedding-actions"><span hidden={textStep!==1}><IconAction name="extract" caption="扫描资源" label="提取游戏文本并导出 MTool JSON" disabled={busy} onClick={()=>void start("extract")}/></span><span hidden={textStep!==1}><IconAction name="open" caption="进入翻译工程" label="使用文本翻译工程翻译原文" disabled={busy||!(status.exportPath||file)} onClick={openText}/></span><span hidden={textStep!==2}><IconAction name="json" caption="导入翻译" label="选择翻译 JSON，也可拖入" disabled={busy} onClick={()=>void pick()}/></span></div></header>

        {textStep===1&&output("MTool JSON",status.exportPath)}
        <div className="embed-form-row" hidden={textStep!==2}><label className="embed-field embed-inline-field"><span>翻译 JSON</span><div className="json-embedding-path"><input aria-label="翻译 JSON" placeholder="选择翻译完成的 JSON" value={file} disabled={busy} onChange={e=>{setFile(e.target.value);setStatus({state:"idle"});}}/></div></label><div className="json-embedding-actions"><IconAction name="inspect" caption="检查译文" label="检查译文匹配" hint="读取游戏中的可显示文本，检查 JSON 格式、原文精确匹配及译文控制符一致性，统计命中和异常；异常译文保留原文。此操作不写入游戏，不校验翻译语义及字体排版。" disabled={busy||!file.trim()} onClick={()=>void start("inspect")}/></div></div>


        {progress(["extract","inspect","embed","apply","uninstall-text","cleanup-text"])}
        {output("补丁目录",status.patchPath)}
        {textStep===4&&game.engine.startsWith("RPG Maker")&&<details className="embed-runtime-options" data-section="runtime" open={status.action==="runtime"?true:undefined}><summary>运行时加载译文</summary><header><IconAction name="help" label="使用本节选择的翻译 JSON，按完整原文查找并缓存译文，同步绘字与测宽。可加载中文字体；自动备份的安装记录可回滚卸载。"/></header>
          <div className="embed-form-row"><label className="embed-field embed-inline-field"><span>中文字体</span><div className="json-embedding-path"><input aria-label="中文字体" value={fontPath} placeholder="可选 TTF / OTF" disabled={busy} onChange={e=>setFontPath(e.target.value)}/><IconAction name="json" label="选择中文字体，随本地翻译插件加载" disabled={busy} onClick={()=>void pickFont()}/></div></label><IconAction name="apply" caption="安装插件" label="安装或更新本地 JSON 翻译插件" disabled={busy||!file} onClick={()=>void start("runtime")}/></div>{progress(["runtime"])}
        </details>}

        {textStep===3&&<div className="embed-section"><div className="json-embedding-actions"><IconAction name="generate" caption="生成补丁" label="生成嵌入补丁" disabled={busy||status.state!=="ready"||!status.matched} onClick={()=>void start("embed")}/></div></div>}
        {textStep===4&&<>{backupPanel}{game.engine.startsWith("RPG Maker")&&<button className="unity-btn" type="button" onClick={()=>{setPart("images");setTextStep(4);}}>应用图片译图</button>}<div className="json-embedding-actions"><IconAction name="apply" caption={patch.installed?"更新译文":"应用译文"} label="应用到游戏，请先关闭游戏" disabled={busy||status.state!=="done"||!!patch.conflicts.length} onClick={()=>void start("apply")}/></div>        <div className="embed-patch-state"><strong>{detecting?"正在检测补丁…":patch.installed?"文本补丁已安装":patch.legacy?"发现历史补丁，检查译文后接管":patch.managed?"文本补丁已卸载":"未发现文本补丁安装记录"}</strong><IconAction name="refresh" caption="检测补丁" label="检测已安装补丁及文件改动" disabled={busy} onClick={()=>void loadPatch(true)}/><IconAction name="rollback" caption="卸载" label="卸载文本补丁并恢复安装前资源" disabled={busy||!patch.installed||!!patch.conflicts.length} onClick={()=>void start("uninstall-text")}/><IconAction name="stop" caption="清理" label="清理已卸载文本补丁的安装原件和关联工作目录，保留用户备份" disabled={busy||patch.installed||!patch.managed} onClick={()=>void start("cleanup-text")}/></div>{restorePanel}</>}
        {output("工作目录",status.outputPath)}</div></div>,controlsTarget)}
      {resultsTarget&&createPortal(<div ref={textDropRoot} data-game-drop-zone="text" {...textDrop.handlers} hidden={part!=="text"} className="engine-result-content"><section className="unity-offline-workbench engine-text-results" aria-label="译文检查结果"><h3>检查结果</h3>        {status.dictionaryEntries!==undefined&&<dl className="json-embedding-counts"><div><dt>词典条目</dt><dd>{status.dictionaryEntries.toLocaleString()}</dd></div>{status.matched!==undefined&&<div><dt>命中次数</dt><dd>{status.matched.toLocaleString()}</dd></div>}{status.blocked!==undefined&&<div><dt>异常，保留原文</dt><dd>{status.blocked.toLocaleString()}</dd></div>}</dl>}
        {!!status.issues?.length&&<details><summary>需修正的译文 · {status.issues.length}</summary>{status.issues.map((issue,index)=><details key={index}><summary>{issue.file} · {issue.reason}</summary><p>{issue.source}</p><p>{issue.translation}</p></details>)}</details>}
        {!!patch.conflicts.length&&<details><summary>补丁文件存在改动 · {patch.conflicts.length}</summary>{patch.conflicts.map(path=><p key={path}>{path}</p>)}</details>}{status.dictionaryEntries===undefined&&!status.issues?.length&&<p className="hint">导入译文并检查后显示结果</p>}</section></div>,resultsTarget)}
      {game.engine.startsWith("RPG Maker")&&(imagesVisited||part==="images")&&<GameImageWorkbench workspaceTargets={{controls:controlsTarget,results:resultsTarget}} scanRequest={imageScanRequest} leaveGuard={imageLeaveGuard} onTaskStateChange={setImageWorkflow} workflowSteps={workflowSteps} workflowStage={textStep===4?"apply":"images"} backupPanel={backupPanel} restorePanel={restorePanel} gamePath={game.path} settings={settings} backupMode={backupMode} active={active&&part==="images"} disabled={pending||detecting||status.state==="running"} onBusy={setImageBusy} onMessage={appendLog}/>}

    </main>

  </div>;
}
