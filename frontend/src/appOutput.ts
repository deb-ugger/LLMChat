import { useEffect, useRef, useSyncExternalStore } from "react";
import { api } from "./api";
import { parseLogLine } from "./components/UnityViewHelpers";

export type OutputLevel = "info" | "step" | "success" | "warning" | "error";
export type OutputRow = { id: string; time: string; level: OutputLevel; text: string; important?: boolean; issue?: string; resolves?: string; resolvesId?: string };
const limit = 500;
let rows: OutputRow[] = [];
const issues = new Map<string, OutputRow>();
let pending: OutputRow[] = [];
let ready = false;
let writing = false;
let initialization: Promise<void> | undefined;
let warning = "";
let historyWarning = "";
let logPath = "";
const unreadKey = "llmchat-output-unread-notices";
let notices: number | undefined;
let viewing = false;
let snapshot = { rows, issues: [] as OutputRow[], warning, logPath, unread: 0 };
const listeners = new Set<() => void>();
const unreadNotices = () => notices ??= Math.max(0, Number(localStorage.getItem(unreadKey)) || 0);
function setUnreadNotices(value: number) {
  notices = value;
  localStorage.setItem(unreadKey, String(value));
}
const publish = () => {
  snapshot = { rows, issues: [...issues.values()], warning: warning || historyWarning, logPath, unread: unreadNotices() + issues.size };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useAppOutput = () => useSyncExternalStore(subscribe, () => snapshot);

export const useUnreadOutput = () => useSyncExternalStore(subscribe, () => snapshot.unread);
export function viewAppOutput() {
  viewing = true;
  setUnreadNotices(0);
  publish();
  void flush();
  return () => { viewing = false; };
}

function limitBacklog(batch: OutputRow[]) {
  if (batch.length <= limit) return batch;
  // Keep issue transitions until the backend has saved them, even if UI history rolls over.
  return batch.slice(0, -limit).filter(row => row.issue || row.resolves).concat(batch.slice(-limit));
}

async function flush() {
  if (!ready || writing || !pending.length) return;
  writing = true;
  try {
    while (pending.length) {
      const batch = pending.splice(0, 100);
      try {
        const result = await api.appendOutputLog(batch.map(row => JSON.stringify(row)).join("\n"));
        logPath = result.logPath || logPath;
      } catch (error) {
        pending = limitBacklog([...batch, ...pending]);
        throw error;
      }
    }
    warning = "";
  } catch (error) { warning = `输出日志写入失败：${String(error)}`; }
  finally { writing = false; publish(); }
}

function updateIssue(row: OutputRow) {
  if (row.issue) issues.set(row.issue, row);
  if (row.resolves && (!row.resolvesId || issues.get(row.resolves)?.id === row.resolvesId)) issues.delete(row.resolves);
}

function append(row: OutputRow) {
  updateIssue(row);
  if (row.important && !row.issue && !viewing) setUnreadNotices(unreadNotices() + 1);
  rows = rows.concat(row).slice(-limit);
  pending.push(row);
  if (!ready || warning) pending = limitBacklog(pending);
  publish();
  void flush();
}

export function writeOutput(path: readonly string[], message: string, level: OutputLevel = "info", important = level === "error" || level === "warning", task?: string) {
  const prefix = path.map(label => `[${label}]`).join("") + ":";
  const text = message.split(/\r?\n/).filter(line => line.trim()).map(line => prefix + line).join("\n");
  if (!text) return;
  const key = JSON.stringify([path, task ?? message]);
  append({ id: crypto.randomUUID(), time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), level, text, important,
    issue: level === "error" ? key : undefined, resolves: task && level === "success" && (!ready || issues.has(key)) ? key : undefined });
}

export function resolveOutputIssue(row: OutputRow) {
  if (!row.issue || issues.get(row.issue)?.id !== row.id) return;
  append({ id: crypto.randomUUID(), time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    level: "success", text: "[输出][错误处理]:已标记解决 · " + row.text.split("\n")[0], resolves: row.issue, resolvesId: row.id });
}

export function initializeAppOutput() {
  initialization ??= (async () => {
    try {
      const response = await api.readOutputLog(limit);
      for (const saved of response.issues || []) if (saved.issue && saved.id) issues.set(saved.issue, saved);
      for (const live of pending) updateIssue(live);
      const history: OutputRow[] = [];
      for (const line of (response.text || "").split(/\r?\n/)) {
        if (!line) continue;
        try {
          const row: OutputRow = JSON.parse(line);
          if (row && typeof row.text === "string" && typeof row.id === "string") history.push(row);
        } catch { historyWarning = "部分输出历史不完整，已加载可读取的记录。"; }
      }
      const remaining = limit - history.length - rows.length;
      if (remaining > 0) {
        const legacy = await api.readOutputLog(remaining, true).catch(error => {
          historyWarning = `历史游戏日志读取失败：${String(error)}`;
          return { text: "" };
        });
        const old = (legacy.text || "").split(/\r?\n/).filter(Boolean).map((line, i) => {
          const item = parseLogLine(line, `legacy-${i}`);
          return { ...item, level: item.level === "ok" ? "success" as const : item.level, text: "[游戏翻译][Unity][历史输出]:" + item.text };
        });
        history.unshift(...old);
      }
      logPath = response.logPath || "";
      rows = [...new Map([...history, ...rows].map(row => [row.id, row])).values()].slice(-limit);
    } catch (error) { historyWarning = `输出历史读取失败：${String(error)}`; }
    ready = true;
    publish();
    void flush();
  })();
  return initialization;
}

/** Publish status changes with their producer's location, including background work. */
export function useOutputMessage(path: readonly string[], message?: string | null, level: OutputLevel = "info", important = level === "error" || level === "warning") {
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (message && previous.current !== message) writeOutput(path, message, level, important);
    previous.current = message;
  }, [path, message, level, important]);
}
