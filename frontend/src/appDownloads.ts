import { useSyncExternalStore } from "react";
import { showAppNotice } from "./components/AppNotice";

export type DownloadStatus = "queued" | "running" | "paused" | "cancelling" | "saving" | "completed" | "cancelled" | "failed" | "handed-off";
export type AppDownload = {
  id: string;
  name: string;
  source: string;
  status: DownloadStatus;
  path?: string;
  detail?: string;
  progress?: { value: number; max: number };
  error?: string;
};
type DownloadActions = Partial<Record<"pause" | "resume" | "cancel", (id: string) => void>>;
const historyKey = "llmchat-downloads";
const legacyKey = "llmchat-game-image-downloads";

export const downloadFileName = (path: string) => path.split(/[\\/]/).at(-1) || path;
export const downloadFinished = ({ status }: AppDownload) =>
  status === "completed" || status === "cancelled" || status === "failed" || status === "handed-off";

function readHistory(): AppDownload[] {
  try {
    const saved = localStorage.getItem(historyKey);
    const history: AppDownload[] = saved ? JSON.parse(saved) :
      (JSON.parse(localStorage.getItem(legacyKey) || "[]") as Array<Pick<AppDownload, "id" | "status" | "error"> & { path: string; total: number }>)
        .map(({ id, path, status, error, total }) => ({
          id, name: downloadFileName(path), source: "游戏图片", status, path, error,
          detail: status === "completed" ? `${total} 张图片` : undefined,
        }));
    return history.map(task => downloadFinished(task) ? task : {
      ...task, status: "failed", progress: undefined, error: "应用关闭前未完成下载",
    });
  } catch {
    return [];
  }
}

let downloads = readHistory();
const actions = new Map<string, DownloadActions>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const getAppDownloads = () => downloads;
export const useAppDownloads = () => useSyncExternalStore(subscribe, getAppDownloads);
export const getDownloadActions = (id: string) => actions.get(id);

function publish(next: AppDownload[], persist: boolean) {
  downloads = next;
  if (persist) {
    try { localStorage.setItem(historyKey, JSON.stringify(downloads)); }
    catch { showAppNotice("下载记录保存失败", "error"); }
  }
  for (const listener of listeners) listener();
}

export function addDownload(task: Omit<AppDownload, "id">, controls?: DownloadActions) {
  const id = crypto.randomUUID();
  if (controls) actions.set(id, controls);
  publish([{ ...task, id }, ...downloads], true);
  return id;
}

export function updateDownload(id: string, patch: Partial<Omit<AppDownload, "id">>) {
  const current = downloads.find(task => task.id === id);
  if (!current || downloadFinished(current)) return;
  const next = { ...current, ...patch };
  if (downloadFinished(next)) {
    next.progress = undefined;
    actions.delete(id);
  }
  publish(downloads.map(task => task.id === id ? next : task), patch.status !== undefined);
}

export function removeDownload(id: string) {
  publish(downloads.filter(task => task.id !== id || !downloadFinished(task)), true);
}

export async function trackDownload<T>(
  task: Omit<AppDownload, "id" | "status">,
  run: () => Promise<T>,
): Promise<T> {
  const id = addDownload({ ...task, status: "saving" });
  try {
    const result = await run();
    updateDownload(id, { status: "completed" });
    return result;
  } catch (error) {
    updateDownload(id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
