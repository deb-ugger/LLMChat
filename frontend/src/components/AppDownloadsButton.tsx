import { useId, useRef, useState } from "react";
import { positionWindowPopover } from "../viewportLayout";
import { createPortal } from "react-dom";
import { api } from "../api";
import { downloadFinished, getDownloadActions, removeDownload, useAppDownloads, type AppDownload, type DownloadStatus } from "../appDownloads";
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
  return <li className="app-download-row">
    <div className="app-download-heading">
      <strong data-tooltip={name}>{name}</strong>
      {downloadFinished(task) && <button type="button" className="app-download-icon"
        aria-label={`移除 ${name} 的下载记录`} data-tooltip="移除下载记录" onClick={() => removeDownload(id)}>
        <FeatureIcon feature="remove" size={16} />
      </button>}
    </div>
    {path && <div className="app-download-path" data-tooltip={path}>{path}</div>}
    <div className="app-download-status">
      <span>{source}</span>
      <span aria-live="polite" className={status === "failed" ? "is-error" : undefined}>{statusLabels[status]}</span>
    </div>
    {detail && <div className="app-download-path" data-tooltip={detail}>{detail}</div>}
    {progress && (status === "running" || status === "paused") && <progress aria-label={`${name}的下载进度`} value={progress.value} max={progress.max} />}
    {error && <p className="app-download-error">{error}</p>}
    {(pause || resume || cancel || status === "completed" && path) && <div className="app-download-actions">
      {pause && <button type="button" onClick={() => pause(id)}>暂停</button>}
      {resume && <button type="button" onClick={() => resume(id)}>继续</button>}
      {cancel && <button type="button" onClick={() => cancel(id)}>取消下载</button>}
      {status === "completed" && path && <>
        <button type="button" onClick={() => void open(false)}>打开文件</button>
        <button type="button" onClick={() => void open(true)}>在文件夹中显示</button>
      </>}
    </div>}
  </li>;
}

export function AppDownloadsButton() {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const tasks = useAppDownloads();
  const pendingCount = tasks.filter(task => !downloadFinished(task)).length;
  const label = pendingCount ? `下载，${pendingCount} 项未完成` : "下载";
  return <>
    <button type="button" className="window-action" aria-label={label} data-tooltip={label}
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
