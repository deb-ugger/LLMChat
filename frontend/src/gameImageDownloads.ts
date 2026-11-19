import { invoke } from "@tauri-apps/api/core";
import { dirname, join, resourceDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { addDownload, downloadFileName, downloadFinished, getAppDownloads, updateDownload } from "./appDownloads";
import { showAppNotice } from "./components/AppNotice";
import { exportGameImages } from "./gameImageArchive";
import type { UnityImage } from "./unityOffline";

export type GameImageDownloadRange = "all" | "filtered" | "checked";
const directoryKey = "llmchat-game-image-download-directory";
const archiveNames: Record<GameImageDownloadRange, string> = {
  all: "all-images.zip",
  filtered: "filtered-images.zip",
  checked: "checked-images.zip",
};

function createDownloadControl() {
  const controller = new AbortController();
  const { signal } = controller;
  const pauseListeners = new Set<(paused: boolean) => void>();
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const setPaused = (paused: boolean) => {
    if (paused === !!gate) return;
    if (paused) gate = new Promise(resolve => { release = resolve; });
    else {
      release?.();
      gate = undefined;
      release = undefined;
    }
    for (const listener of pauseListeners) listener(paused);
  };
  return {
    signal,
    setPaused,
    async checkpoint() {
      while (gate) await gate;
      signal.throwIfAborted();
    },
    onPauseChange(listener: (paused: boolean) => void) {
      pauseListeners.add(listener);
      return () => { pauseListeners.delete(listener); };
    },
    cancel() {
      controller.abort();
      setPaused(false);
    },
  };
}

type ExportRequest = {
  path: string;
  images: readonly UnityImage[];
  read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>;
};
const pending = new Map<string, ExportRequest>();
let active: { id: string; control: ReturnType<typeof createDownloadControl> } | undefined;

function runNext() {
  if (active) return;
  const next = pending.entries().next().value;
  if (!next) return;
  const [id, { path, images, read }] = next;
  pending.delete(id);
  const control = createDownloadControl();
  active = { id, control };
  updateDownload(id, { status: "running" });
  void (async () => {
    let started = false;
    try {
      await control.checkpoint();
      await invoke("begin_game_image_zip", { id, path });
      started = true;
      let lastReport = -Infinity;
      const expectedBytes = await exportGameImages(images, read, progress => {
        const now = performance.now();
        if (progress.stage === "reading" && now - lastReport < 100) return;
        lastReport = now;
        updateDownload(id, progress.stage === "reading"
          ? { detail: `读取图片 ${progress.completed + 1} / ${images.length} · ${progress.file}`, progress: { value: progress.completed, max: images.length } }
          : { detail: `打包 ${progress.percent}%`, progress: { value: progress.percent, max: 100 } });
      }, control, chunk => invoke("append_game_image_zip", chunk, { headers: { "llmchat-download-id": id } }));
      await control.checkpoint();
      updateDownload(id, { status: "saving", detail: undefined });
      await invoke("finish_game_image_zip", { id, expectedBytes });
      updateDownload(id, { status: "completed", detail: `${images.length} 张图片` });
      showAppNotice("图片下载完成。可在左侧「下载」打开文件。");
    } catch (error) {
      let detail = error instanceof Error ? error.message : String(error);
      let cleanupFailed = false;
      if (started) {
        try { await invoke("cancel_game_image_zip", { id }); }
        catch (cleanupError) { cleanupFailed = true; detail += "；" + String(cleanupError); }
      }
      if (control.signal.aborted && !cleanupFailed) updateDownload(id, { status: "cancelled", detail: undefined });
      else {
        updateDownload(id, { status: "failed", error: detail, detail: undefined });
        showAppNotice("图片下载失败。请在左侧「下载」查看详情。", "error");
      }
    } finally {
      active = undefined;
      runNext();
    }
  })();
}

const pathKey = (path: string) => path.replaceAll("/", "\\").toLowerCase();

export async function downloadGameImages(range: GameImageDownloadRange, images: readonly UnityImage[], read: ExportRequest["read"]) {
  try {
    const directory = localStorage.getItem(directoryKey) || await resourceDir();
    const path = await save({
      title: "保存图片压缩包",
      defaultPath: await join(directory, archiveNames[range]),
      filters: [{ name: "图片压缩包", extensions: ["zip"] }],
    });
    if (!path) return;
    const selectedDirectory = await dirname(path);
    if (getAppDownloads().some(task => task.path && !downloadFinished(task) && pathKey(task.path) === pathKey(path))) {
      showAppNotice("该文件路径已有下载任务，请选择其他文件名或位置。", "error");
      return;
    }
    localStorage.setItem(directoryKey, selectedDirectory);
    const id = addDownload({ name: downloadFileName(path), source: "游戏图片", path, status: "queued", detail: `${images.length} 张图片` }, {
      pause: pauseGameImageDownload, resume: resumeGameImageDownload, cancel: cancelGameImageDownload,
    });
    pending.set(id, { path, images, read });
    runNext();
  } catch (error) {
    showAppNotice(error instanceof Error ? error.message : String(error), "error");
  }
}

function pauseGameImageDownload(id: string) {
  if (active?.id !== id || getAppDownloads().find(task => task.id === id)?.status !== "running") return;
  active.control.setPaused(true);
  updateDownload(id, { status: "paused" });
}

function resumeGameImageDownload(id: string) {
  if (active?.id !== id || getAppDownloads().find(task => task.id === id)?.status !== "paused") return;
  active.control.setPaused(false);
  updateDownload(id, { status: "running" });
}

function cancelGameImageDownload(id: string) {
  const task = getAppDownloads().find(task => task.id === id);
  if (task?.status === "queued" && pending.delete(id)) updateDownload(id, { status: "cancelled", detail: undefined });
  if (active?.id === id && (task?.status === "running" || task?.status === "paused")) {
    updateDownload(id, { status: "cancelling" });
    active.control.cancel();
  }
}
