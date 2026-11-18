import { invoke } from "@tauri-apps/api/core";
import { dirname, join, resourceDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { useSyncExternalStore } from "react";
import { showAppNotice } from "./components/AppNotice";
import { exportGameImages, type GameImageExportProgress } from "./gameImageArchive";
import type { UnityImage } from "./unityOffline";

export type GameImageDownloadRange = "all" | "filtered" | "checked";
type Status = "queued" | "running" | "paused" | "cancelling" | "saving" | "completed" | "cancelled" | "failed";
export type GameImageDownload = {
  id: string;
  path: string;
  status: Status;
  total: number;
  progress?: GameImageExportProgress;
  error?: string;
};

const historyKey = "llmchat-game-image-downloads";
const directoryKey = "llmchat-game-image-download-directory";
const archiveNames: Record<GameImageDownloadRange, string> = {
  all: "all-images.zip",
  filtered: "filtered-images.zip",
  checked: "checked-images.zip",
};

export function gameImageDownloadFinished(task: GameImageDownload) {
  return task.status === "completed" || task.status === "cancelled" || task.status === "failed";
}

function readHistory(): GameImageDownload[] {
  try {
    const saved: GameImageDownload[] = JSON.parse(localStorage.getItem(historyKey) || "[]");
    return saved.map(task => gameImageDownloadFinished(task) ? task :
      { ...task, status: "failed", error: "应用关闭前未完成下载" });
  } catch {
    return [];
  }
}

let downloads = readHistory();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const useGameImageDownloads = () => useSyncExternalStore(subscribe, () => downloads);

function publish(tasks: GameImageDownload[], persist: boolean) {
  downloads = tasks;
  if (persist) {
    try {
      localStorage.setItem(historyKey, JSON.stringify(downloads));
    } catch {
      showAppNotice("下载记录保存失败", "error");
    }
  }
  for (const listener of listeners) listener();
}

function update(id: string, patch: Partial<GameImageDownload>) {
  publish(downloads.map(task => task.id === id ? { ...task, ...patch } : task), patch.status !== undefined);
}

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
  update(id, { status: "running" });
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
        update(id, { progress });
      }, control, chunk => invoke("append_game_image_zip", chunk, { headers: { "llmchat-download-id": id } }));
      await control.checkpoint();
      update(id, { status: "saving" });
      await invoke("finish_game_image_zip", { id, expectedBytes });
      update(id, { status: "completed" });
      showAppNotice("图片下载完成。可在右上角「下载任务」打开文件。");
    } catch (error) {
      let detail = error instanceof Error ? error.message : String(error);
      let cleanupFailed = false;
      if (started) {
        try { await invoke("cancel_game_image_zip", { id }); }
        catch (cleanupError) { cleanupFailed = true; detail += "；" + String(cleanupError); }
      }
      if (control.signal.aborted && !cleanupFailed) update(id, { status: "cancelled" });
      else {
        update(id, { status: "failed", error: detail });
        showAppNotice("图片下载失败。请在右上角查看下载任务。", "error");
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
    if (downloads.some(task => !gameImageDownloadFinished(task) && pathKey(task.path) === pathKey(path))) {
      showAppNotice("该文件路径已有下载任务，请选择其他文件名或位置。", "error");
      return;
    }
    localStorage.setItem(directoryKey, selectedDirectory);
    const task: GameImageDownload = { id: crypto.randomUUID(), path, status: "queued", total: images.length };
    pending.set(task.id, { path, images, read });
    publish([task, ...downloads], true);
    runNext();
  } catch (error) {
    showAppNotice(error instanceof Error ? error.message : String(error), "error");
  }
}

export function pauseGameImageDownload(id: string) {
  if (active?.id !== id || downloads.find(task => task.id === id)?.status !== "running") return;
  active.control.setPaused(true);
  update(id, { status: "paused" });
}

export function resumeGameImageDownload(id: string) {
  if (active?.id !== id || downloads.find(task => task.id === id)?.status !== "paused") return;
  active.control.setPaused(false);
  update(id, { status: "running" });
}

export function cancelGameImageDownload(id: string) {
  const task = downloads.find(task => task.id === id);
  if (task?.status === "queued" && pending.delete(id)) update(id, { status: "cancelled" });
  if (active?.id === id && (task?.status === "running" || task?.status === "paused")) {
    update(id, { status: "cancelling" });
    active.control.cancel();
  }
}

export function removeGameImageDownload(id: string) {
  publish(downloads.filter(task => task.id !== id || !gameImageDownloadFinished(task)), true);
}
