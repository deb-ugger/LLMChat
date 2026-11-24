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
  availableActions?: DownloadAction[];
};
type DownloadAction = "pause" | "resume" | "cancel";
type DownloadActions = Partial<Record<DownloadAction, (id: string) => void>>;
type DownloadPatch = Partial<Omit<AppDownload, "id">>;
type DownloadMessage =
  | { kind: "add"; task: AppDownload }
  | { kind: "update"; id: string; patch: DownloadPatch }
  | { kind: "recover"; tasks: AppDownload[] }
  | { kind: "remove"; id: string }
  | { kind: "control"; id: string; action: DownloadAction };
const historyKey = "llmchat-downloads";
const legacyKey = "llmchat-game-image-downloads";

export const downloadFileName = (path: string) => path.split(/[\\/]/).at(-1) || path;
export const downloadFinished = ({ status }: AppDownload) =>
  status === "completed" || status === "cancelled" || status === "failed" || status === "handed-off";

function readHistory(): AppDownload[] {
  try {
    const saved = localStorage.getItem(historyKey);
    const history = saved ? JSON.parse(saved) :
      (JSON.parse(localStorage.getItem(legacyKey) || "[]") as Array<Pick<AppDownload, "id" | "status" | "error"> & { path: string; total: number }>)
        .map(({ id, path, status, error, total }) => ({
          id, name: downloadFileName(path), source: "游戏图片", status, path, error,
          detail: status === "completed" ? `${total} 张图片` : undefined,
        }));
    return Array.isArray(history) ? history : [];
  } catch {
    return [];
  }
}

let downloads = readHistory();
let channel: BroadcastChannel | undefined;
const actions = new Map<string, DownloadActions>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const getAppDownloads = () => downloads;
export const useAppDownloads = () => useSyncExternalStore(subscribe, getAppDownloads);
export function getDownloadActions(task: AppDownload): DownloadActions | undefined {
  const local = actions.get(task.id);
  if (local || !channel || !task.availableActions?.length) return local;
  const remote: DownloadActions = {};
  for (const action of task.availableActions) {
    remote[action] = id => broadcast({ kind: "control", id, action });
  }
  return remote;
}

function publish(next: AppDownload[]) {
  downloads = next;
  for (const listener of listeners) listener();
}

function saveHistory(history: AppDownload[]) {
  try { localStorage.setItem(historyKey, JSON.stringify(history)); }
  catch { showAppNotice("下载记录保存失败", "error"); }
}

function broadcast(message: DownloadMessage) {
  channel?.postMessage(message);
}

function replaceTask(tasks: AppDownload[], next: AppDownload) {
  return tasks.map(task => task.id === next.id ? next : task);
}

export function initAppDownloads(mainWindow: boolean) {
  if (channel) return;
  channel = new BroadcastChannel(historyKey);
  channel.onmessage = ({ data }: MessageEvent<DownloadMessage>) => {
    switch (data.kind) {
      case "add":
        if (!downloads.some(task => task.id === data.task.id)) publish([data.task, ...downloads]);
        break;
      case "update": {
        const current = downloads.find(task => task.id === data.id);
        if (current && !downloadFinished(current)) publish(replaceTask(downloads, { ...current, ...data.patch }));
        break;
      }
      case "recover": {
        const recovered = new Set(data.tasks.map(task => task.id));
        publish([...data.tasks, ...downloads.filter(task => !recovered.has(task.id))]);
        break;
      }
      case "remove":
        publish(downloads.filter(task => task.id !== data.id));
        break;
      case "control":
        actions.get(data.id)?.[data.action]?.(data.id);
        break;
    }
  };

  const history = readHistory();
  if (!mainWindow || history.every(downloadFinished)) {
    publish(history);
    return;
  }
  const recovered = history.map<AppDownload>(task => downloadFinished(task) ? task : {
    ...task, status: "failed", progress: undefined, availableActions: undefined, error: "应用关闭前未完成下载",
  });
  saveHistory(recovered);
  publish(recovered);
  broadcast({ kind: "recover", tasks: recovered });
}

export function addDownload(task: Omit<AppDownload, "id">, controls?: DownloadActions) {
  const id = crypto.randomUUID();
  const next = { ...task, id };
  if (controls) {
    actions.set(id, controls);
    next.availableActions = (Object.keys(controls) as DownloadAction[]).filter(action => controls[action]);
  }
  saveHistory([next, ...readHistory()]);
  publish([next, ...downloads]);
  broadcast({ kind: "add", task: next });
  return id;
}

export function updateDownload(id: string, patch: DownloadPatch) {
  const current = downloads.find(task => task.id === id);
  if (!current || downloadFinished(current)) return;
  const next = { ...current, ...patch };
  if (downloadFinished(next)) {
    next.progress = undefined;
    next.availableActions = undefined;
    actions.delete(id);
  }
  if (patch.status !== undefined) saveHistory(replaceTask(readHistory(), next));
  publish(replaceTask(downloads, next));
  broadcast({ kind: "update", id, patch: {
    ...patch, progress: next.progress, availableActions: next.availableActions,
  } });
}

export function removeDownload(id: string) {
  if (!downloads.some(task => task.id === id && downloadFinished(task))) return;
  saveHistory(readHistory().filter(task => task.id !== id));
  publish(downloads.filter(task => task.id !== id));
  broadcast({ kind: "remove", id });
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
