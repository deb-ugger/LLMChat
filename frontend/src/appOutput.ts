import { useEffect, useRef, useSyncExternalStore } from "react";
import { api } from "./api";
import { parseLogLine } from "./components/UnityViewHelpers";

export type OutputLevel = "info" | "step" | "success" | "fail" | "warning" | "error";
export type OutputRow = { id: string; time: string; level: OutputLevel; text: string; important?: boolean };
const limit = 500;
const isIssueLevel = (level: OutputLevel) => level === "error" || level === "fail";
let rows: OutputRow[] = [];
let pending: OutputRow[] = [];
let ready = false;
let writing: Promise<void> | undefined;
let initialization: Promise<void> | undefined;
let warning = "";
let historyWarning = "";
let logPath = "";
const unreadKey = "llmchat-output-unread-warning-error";
export const outputCountsForBadge = (level: OutputLevel) => level === "error" || level === "warning";
let notices: number | undefined;
let viewing = false;
let snapshot = { rows, warning, logPath, unread: 0 };
const listeners = new Set<() => void>();
const unreadNotices = () => notices ??= Math.max(0, Number(localStorage.getItem(unreadKey)) || 0);
function setUnreadNotices(value: number) {
  notices = value;
  localStorage.setItem(unreadKey, String(value));
}
const publish = () => {
  snapshot = { rows, warning: warning || historyWarning, logPath, unread: unreadNotices() };
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
  return () => {
    viewing = false;
    if (rows.length > limit) { rows = rows.slice(-limit); publish(); }
  };
}

function flush() {
  if (writing) return writing;
  if (!ready || !pending.length) return Promise.resolve();
  writing = flushPending();
  return writing;
}

async function flushPending() {
  try {
    while (pending.length) {
      const batch = pending.splice(0, 100);
      try {
        const result = await api.appendOutputLog(batch.map(row => JSON.stringify(row)).join("\n"));
        logPath = result.logPath || logPath;
      } catch (error) {
        pending = [...batch, ...pending].slice(-limit);
        throw error;
      }
    }
    warning = "";
  } catch (error) { warning = `输出日志写入失败：${String(error)}`; }
  finally { writing = undefined; publish(); }
}

export function formatOutputTime(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return value || "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function outputStatusLabel(level: OutputLevel) {
  return level === "success" || level === "fail" || level === "error" || level === "warning" ? level.toUpperCase() : "";
}

export function formatOutputMessage({ level, text }: OutputRow) {
  const label = outputStatusLabel(level);
  return label ? `[${label}] ${text}` : text;
}

function readRecords(text: string) {
  const records: OutputRow[] = [];
  let incomplete = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row: OutputRow = JSON.parse(line);
      if (row && typeof row.text === "string" && typeof row.id === "string") records.push(row);
      else incomplete = true;
    } catch { incomplete = true; }
  }
  return { records, incomplete };
}

function readLegacyRecords(text: string) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.map((line, index): OutputRow => {
    const item = parseLogLine(line, `legacy-${lines.length - index}`);
    return { ...item, level: item.level === "ok" ? "success" : item.level, text: "[游戏翻译][Unity][历史输出]:" + item.text };
  });
}

function append(row: OutputRow) {
  if (outputCountsForBadge(row.level) && !viewing) setUnreadNotices(unreadNotices() + 1);
  rows = rows.concat(row);
  if (!viewing && rows.length > limit) rows = rows.slice(-limit);
  pending.push(row);
  if ((!ready || warning) && pending.length > limit) pending = pending.slice(-limit);
  publish();
  void flush();
}

export function writeOutput(path: readonly string[], message: string, level: OutputLevel = "info", important = isIssueLevel(level) || level === "warning", _task?: string) {
  const prefix = path.map(label => `[${label}]`).join("") + ":";
  const text = message.split(/\r?\n/).filter(line => line.trim()).map(line => prefix + line).join("\n");
  if (!text) return;
  append({ id: crypto.randomUUID(), time: new Date().toISOString(), level, text, important });
}

export async function exportAppOutput() {
  await initializeAppOutput();
  await flush();
  const result = await api.readOutputLog(limit, false, true);
  return result.text || "";
}

export async function loadAppOutputHistory() {
  const [full, legacy] = await Promise.all([
    api.readOutputLog(2000, false, true),
    api.readOutputLog(2000, true).catch(error => {
      historyWarning = `历史游戏日志读取失败：${String(error)}`;
      return { text: "" };
    }),
  ]);
  if (!viewing) return;
  const { records, incomplete } = readRecords(full.text || "");
  if (incomplete) historyWarning = "部分输出历史不完整，已加载可读取的记录。";
  const merged = new Map([...readLegacyRecords(legacy.text || ""), ...records, ...rows].map(row => [row.id, row]));
  rows = [...merged.values()];
  publish();
}

export function initializeAppOutput() {
  initialization ??= (async () => {
    try {
      const response = await api.readOutputLog(limit);
      const { records: history, incomplete } = readRecords(response.text || "");
      if (incomplete) historyWarning = "部分输出历史不完整，已加载可读取的记录。";
      const remaining = limit - history.length - rows.length;
      if (remaining > 0) {
        const legacy = await api.readOutputLog(remaining, true).catch(error => {
          historyWarning = `历史游戏日志读取失败：${String(error)}`;
          return { text: "" };
        });
        history.unshift(...readLegacyRecords(legacy.text || ""));
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
export function useOutputMessage(path: readonly string[], message?: string | null, level: OutputLevel = "info", important = isIssueLevel(level) || level === "warning") {
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (message && previous.current !== message) writeOutput(path, message, level, important);
    previous.current = message;
  }, [path, message, level, important]);
}
