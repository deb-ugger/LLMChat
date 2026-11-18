import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import {
  cancelGameImageDownload, gameImageDownloadFinished, pauseGameImageDownload,
  removeGameImageDownload, resumeGameImageDownload, useGameImageDownloads, type GameImageDownload,
} from "../gameImageDownloads";
import { showAppNotice } from "./AppNotice";
import { UnityActionIcon } from "./UnityActionIcon";
import { UnityIconButton } from "./UnityIconButton";

const statusLabels: Record<GameImageDownload["status"], string> = {
  queued: "排队中",
  running: "下载中",
  paused: "已暂停",
  cancelling: "正在取消",
  saving: "正在保存文件",
  completed: "已完成",
  cancelled: "已取消",
  failed: "下载失败",
};

function DownloadRow({ task }: { task: GameImageDownload }) {
  const { id, path, status, progress, total } = task;
  const filename = path.split(/[\\/]/).at(-1) || path;
  const progressVisible = (status === "running" || status === "paused") && progress;
  const open = async (reveal: boolean) => {
    try {
      if (reveal) await api.revealPath(path);
      else await api.openPath(path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      showAppNotice(`无法${reveal ? "定位" : "打开"}文件：${detail}`, "error");
    }
  };
  return <li className="game-image-download-row">
    <div className="game-image-download-heading">
      <strong data-tooltip={filename}>{filename}</strong>
      {gameImageDownloadFinished(task) && <button type="button" className="game-image-download-icon"
        aria-label={`移除 ${filename} 的下载记录`} data-tooltip="移除下载记录" onClick={() => removeGameImageDownload(id)}>
        <UnityActionIcon kind="remove" />
      </button>}
    </div>
    <div className="game-image-download-path" data-tooltip={path}>{path}</div>
    <div className="game-image-download-status">
      <span aria-live="polite" className={status === "failed" ? "is-error" : undefined}>{statusLabels[status]}</span>
      {status === "completed" && <span>{total} 张图片</span>}
      {progressVisible && (progress.stage === "reading"
        ? <span data-tooltip={progress.file}>读取图片 {progress.completed + 1} / {total}</span>
        : <span>打包 {progress.percent}%</span>)}
    </div>
    {progressVisible && <progress aria-label={progress.stage === "reading" ? "读取图片进度" : "压缩包进度"}
      value={progress.stage === "reading" ? progress.completed : progress.percent}
      max={progress.stage === "reading" ? total : 100} />}
    {task.error && <p className="game-image-download-error">{task.error}</p>}
    {(status === "running" || status === "paused" || status === "queued" || status === "completed") &&
      <div className="game-image-download-actions">
        {(status === "running" || status === "paused") &&
          <button type="button" onClick={() => status === "paused" ? resumeGameImageDownload(id) : pauseGameImageDownload(id)}>
            {status === "paused" ? "继续" : "暂停"}
          </button>}
        {(status === "running" || status === "paused" || status === "queued") &&
          <button type="button" onClick={() => cancelGameImageDownload(id)}>取消下载</button>}
        {status === "completed" && <>
          <button type="button" onClick={() => void open(false)}>打开文件</button>
          <button type="button" onClick={() => void open(true)}>在文件夹中显示</button>
        </>}
      </div>}
  </li>;
}

export function GameImageDownloadsButton({ active }: { active: boolean }) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const tasks = useGameImageDownloads();
  const pendingCount = tasks.filter(task => !gameImageDownloadFinished(task)).length;
  useEffect(() => {
    if (!active && panel.current?.matches(":popover-open")) panel.current.hidePopover();
  }, [active]);
  return <>
    <UnityIconButton title="下载任务" aria-label={pendingCount ? `下载任务，${pendingCount} 项未完成` : "下载任务"}
      className="game-image-download-trigger" aria-haspopup="dialog" aria-controls={id} aria-expanded={open}
      popoverTarget={id} onClick={event => {
        const bounds = event.currentTarget.getBoundingClientRect();
        panel.current?.style.setProperty("--download-top", `${bounds.bottom + 6}px`);
        panel.current?.style.setProperty("--download-right", `${Math.max(8, window.innerWidth - bounds.right)}px`);
      }}>
      <UnityActionIcon kind="download" />
      {pendingCount > 0 && <span className="game-image-download-count" aria-hidden="true">{pendingCount}</span>}
    </UnityIconButton>
    {createPortal(<div ref={panel} id={id} role="dialog" aria-labelledby={id + "-title"} popover="auto"
      className="game-image-download-panel" onToggle={event => setOpen(event.currentTarget.matches(":popover-open"))}>
      <header>
        <h2 id={id + "-title"}>下载任务</h2>
        <button type="button" className="game-image-download-icon" aria-label="关闭下载任务" data-tooltip="关闭"
          popoverTarget={id} popoverTargetAction="hide"><UnityActionIcon kind="cancel" /></button>
      </header>
      {open && (tasks.length > 0
        ? <ul>{tasks.map(task => <DownloadRow key={task.id} task={task} />)}</ul>
        : <p className="game-image-download-empty">暂无图片下载记录</p>)}
    </div>, document.body)}
  </>;
}
