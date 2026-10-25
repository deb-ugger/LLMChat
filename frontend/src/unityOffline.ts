import { Channel, invoke } from "@tauri-apps/api/core";
import { join, resourceDir } from "@tauri-apps/api/path";

export const UNITY_OUTPUT_KEY = "llmchat-unity-output-directory";
export type UnityEntry = {
  id: string; file: string; container: string; objectId: string; locator: string;
  kind: string; source: string; translation: string; selected: boolean; error: string;
};
export type UnityFont = { file: string; container: string; objectId: string; name: string; kind: string };
export type UnityProject = {
  version: number; root: string; folder: string; entries: UnityEntry[];
  scanRevision?: number;
  fonts: UnityFont[]; warnings: string[]; hashes: Record<string, string>;
};
export type UnityPatch = { folder: string; files: number; entries: number; fontReplacements: number };
export type UnitySavedProject = { project: UnityProject | null; scanCompleted: number | null; scanTotal: number | null; includeCode: boolean | null; notices: string[] };
export type UnityWorkspace<T> = { workRoot: string; projectsRoot: string; saved: UnitySavedProject; task: T | null };
export function mergeUnityProject(previous: UnityProject, scanned: UnityProject) {
  const key = (e: UnityEntry) => JSON.stringify([e.file, e.container, e.objectId, e.kind === "UI 文本" && e.locator === "m_Text" ? "/m_Text" : e.locator, e.kind === "UI 文本" ? "游戏文本" : e.kind, e.source]);
  const entries = new Map(previous.entries.map(e => [key(e), e]));
  return { ...scanned, entries: scanned.entries.map(e => {
    const saved = entries.get(key(e));
    return saved ? { ...e, translation: saved.translation, selected: saved.selected, error: saved.error } : e;
  }) };
}
export type UnityProgress = { detail: string; completed: number; total: number | null; folder?: string };
export class UnityPaused extends Error { constructor(public folder: string) { super("任务已中止，进度已保存"); } }
export const unityRun = async <T>(action: string, request: object, onProgress?: (value: UnityProgress) => void, signal?: AbortSignal): Promise<T> => {
  if (signal?.aborted) throw new UnityPaused("");
  const channel = new Channel<UnityProgress>(onProgress);
  const operationId = signal ? crypto.randomUUID() : undefined;
  let stopRequest: Promise<void> | undefined;
  const stop = () => { stopRequest = invoke<void>("unity_offline_stop", { operationId }); void stopRequest.catch(() => {}); };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const result = await invoke<T | { paused: true; folder: string }>("unity_offline_run", { action, request, onProgress: channel, operationId });
    await stopRequest;
    if (result && typeof result === "object" && "paused" in result) throw new UnityPaused(result.folder);
    return result as T;
  } finally { signal?.removeEventListener("abort", stop); }
};
export async function legacyUnityOutputDirectory() {
  return localStorage.getItem(UNITY_OUTPUT_KEY)?.trim() || await join(await resourceDir(), "unity-output");
}

const tokens = /\{[^{}\r\n]+\}|%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc%]|<\/?[^>\r\n]+>|\\[nrt]/g;
export function unityTranslationError(source: string, translation: string) {
  if (!translation.trim()) return "译文为空";
  const a = (source.match(tokens) || []).sort();
  const b = (translation.match(tokens) || []).sort();
  return JSON.stringify(a) === JSON.stringify(b) ? "" : "占位符、转义或富文本标签发生变化";
}
