import { useEffect, useId, useRef, useState } from "react";
import { positionWindowPopover } from "../viewportLayout";
import { createPortal } from "react-dom";
import { api } from "../api";
import { deleteDownloadFile, downloadFinished, downloadStartedEvent, getDownloadActions, useAppDownloads, type AppDownload, type DownloadStatus } from "../appDownloads";
import { showAppNotice } from "./AppNotice";
import { FeatureIcon } from "./FeatureIcon";
import "../appDownloads.css";

const statusLabels: Record<DownloadStatus, string> = {
  queued: "排队中",
  running: "下载中",
  paused: "已暂停",
  cancelling: "正在取消",
  saving: "正在保存",
  completed: "已完成",
  cancelled: "已取消",
  failed: "下载失败",
  "handed-off": "由浏览器处理",
};

function DownloadRow({ task }: { task: AppDownload }) {
  const { id, name, source, path, status, detail, progress, error } = task;
  const [deleting, setDeleting] = useState(false);
  const completedFile = status === "completed" && !!path;
  const display = (text: string) => path ? text.replaceAll(path, name) : text;
  const controls = getDownloadActions(task);
  const pause = status === "running" ? controls?.pause : undefined;
  const resume = status === "paused" ? controls?.resume : undefined;
  const cancel = status === "running" || status === "paused" || status === "queued" ? controls?.cancel : undefined;
  const open = async (reveal: boolean) => {
    if (!path) return;
    try {
      if (reveal) await api.revealPath(path);
      else await api.openPath(path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      showAppNotice(`无法${reveal ? "定位" : "打开"}文件：${detail}`, "error");
    }
  };
  const remove = async () => {
    setDeleting(true);
    try { await deleteDownloadFile(id); showAppNotice("文件已删除"); }
    catch (error) { showAppNotice(`无法删除文件：${display(error instanceof Error ? error.message : String(error))}`, "error"); }
    finally { setDeleting(false); }
  };
  return <li className="app-download-row">
    <span className="app-download-file"><FeatureIcon feature="text" size={22} /></span>
    <div className="app-download-content">
      <strong className="app-download-name" data-tooltip={name}>{name}</strong>
      <div className="app-download-footer">
        {completedFile && <button type="button" className="app-download-open" disabled={deleting} onClick={() => void open(false)}>打开文件</button>}
        <span className="app-download-source">{source}</span>
        {!completedFile && <span aria-live="polite" className={status === "failed" ? "app-download-status is-error" : "app-download-status"}>{statusLabels[status]}</span>}
      </div>
      {detail && <div className="app-download-detail" data-tooltip={display(detail)}>{display(detail)}</div>}
      {progress && (status === "running" || status === "paused") && <progress aria-label={`${name}的下载进度`} value={progress.value} max={progress.max} />}
      {error && <p className="app-download-error">{display(error)}</p>}
      {(pause || resume || cancel) && <div className="app-download-actions">
        {pause && <button type="button" onClick={() => pause(id)}>暂停</button>}
        {resume && <button type="button" onClick={() => resume(id)}>继续</button>}
        {cancel && <button type="button" onClick={() => cancel(id)}>取消下载</button>}
      </div>}
    </div>
    {completedFile && <div className="app-download-file-actions">
      <button type="button" className="app-download-icon" aria-label={`在文件夹中显示 ${name}`} data-tooltip="在文件夹中显示" disabled={deleting} onClick={() => void open(true)}><FeatureIcon feature="folder" size={19} /></button>
      <button type="button" className="app-download-icon app-download-delete" aria-label={`删除文件 ${name}`} data-tooltip={deleting ? "正在删除文件" : "删除文件"} disabled={deleting} onClick={() => void remove()}><FeatureIcon feature="remove" size={18} /></button>
    </div>}
  </li>;
}

export function AppDownloadsButton() {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const tasks = useAppDownloads();
  const pendingCount = tasks.filter(task => !downloadFinished(task)).length;
  const label = pendingCount ? `下载，${pendingCount} 项未完成` : "下载";
  useEffect(() => {
    const show = () => {
      if (!anchor.current || !panel.current) return;
      positionWindowPopover(anchor.current, panel.current);
      if (!panel.current.matches(":popover-open")) panel.current.showPopover();
    };
    window.addEventListener(downloadStartedEvent, show);
    return () => window.removeEventListener(downloadStartedEvent, show);
  }, []);
  return <>
    <button ref={anchor} type="button" className="window-action" aria-label={label} data-tooltip={label}
      aria-haspopup="dialog" aria-controls={id} aria-expanded={open} popoverTarget={id}
      onClick={event => positionWindowPopover(event.currentTarget, panel.current)}>
      <span><FeatureIcon feature="download" /></span>
    </button>
    {createPortal(<div ref={panel} id={id} role="dialog" aria-labelledby={id + "-title"} popover="auto"
      className="app-download-panel window-action-popover" onToggle={event => setOpen(event.currentTarget.matches(":popover-open"))}>
      <header>
        <h2 id={id + "-title"}>下载任务</h2>
        <button type="button" className="app-download-icon" aria-label="关闭下载任务" data-tooltip="关闭"
          popoverTarget={id} popoverTargetAction="hide"><FeatureIcon feature="close" size={16} /></button>
      </header>
      {open && (tasks.length > 0
        ? <ul>{tasks.map(task => <DownloadRow key={task.id} task={task} />)}</ul>
        : <p className="app-download-empty">暂无下载记录</p>)}
    </div>, document.body)}
  </>;
}
