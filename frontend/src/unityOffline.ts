import type { ImageScreening } from "./gameImageScreening";
import { Channel, invoke } from "@tauri-apps/api/core";
import { join, resourceDir } from "@tauri-apps/api/path";

export const UNITY_OUTPUT_KEY = "llmchat-unity-output-directory";
export type UnityEntry = {
  id: string; file: string; container: string; objectId: string; locator: string;
  kind: string; source: string; translation: string; selected: boolean; error: string;
  locale?: string;
  layoutDraft?: string;
  parentId?: string; parentLocator?: string; sourceStart?: number;
};
export type UnityImageRegion = { text: string; translation: string; confidence: number; x0: number; y0: number; x1: number; y1: number; selected: boolean; manualSelected?: boolean; reviewReason?: string; error: string };
export type UnityImage = { selectionManual?: boolean; screening?: ImageScreening; id: string; file: string; container: string; objectId: string; kind: string; name: string; width: number; height: number; sourceFile: string; sourceHash: string; renderedFile: string; renderedHash: string; selected: boolean; ocrCompleted: boolean; completed: boolean; error: string; regions: UnityImageRegion[] };
export type UnityFont = { file: string; container: string; objectId: string; name: string; kind: string; references?: { field: string; fileId: number; pathId: string }[] };
export type UnityInspection = { runtime: string; assemblies: { path: string; writable: boolean; reason: string }[]; catalogs: string[] };
export type UnityFontPlan = { folder: string; characterCount: number; originalReferences: number; translatedReferences: number; fontChecked: boolean; missing: number[]; fonts: UnityFont[]; requirements: string[] };
export type UnityProject = {
  version: number; root: string; folder: string; entries: UnityEntry[];
  scanRevision?: number;
  images?: UnityImage[]; imagesSkipped?: boolean; textSkipped?: boolean;
  segmentSources?: Record<string, string>;
  textMode?: "lines" | "paragraphs" | "smart";
  diagnostics?: { file: string; container: string; objectId: string; reason: string; action: string }[];
  resources?: { file: string; state: "ready" | "empty" | "partial" | "failed"; texts: number; fonts: number; failedObjects: number }[];
  fonts: UnityFont[]; warnings: string[]; hashes: Record<string, string>;
};
export type UnityPatch = { folder: string; files: number; entries: number; images?: number; fontReplacements: number };
export type UnitySavedProject = { project: UnityProject | null; scanCompleted: number | null; scanTotal: number | null; includeCode: boolean | null; notices: string[] };
export type UnityWorkspace<T> = { workRoot: string; projectsRoot: string; saved: UnitySavedProject; task: T | null; installed: boolean };
export function mergeUnityProject(previous: UnityProject, scanned: UnityProject) {
  const key = (e: UnityEntry) => JSON.stringify([e.file, e.container, e.objectId, e.kind === "UI 文本" && e.locator === "m_Text" ? "/m_Text" : e.locator, e.kind === "UI 文本" ? "游戏文本" : e.kind, e.source]);
  const entries = new Map(previous.entries.map(e => [key(e), e]));
  return { ...scanned, entries: scanned.entries.map(e => {
    const saved = entries.get(key(e));
    return saved ? { ...e, translation: saved.translation, selected: saved.selected, error: saved.error } : e;
  }) };
}
export type UnityTranslationActivity = { id: string; references: number; phase: "translating" | "reusing" | "formatting" | "saving" };
export type UnityEngineProgress = { id: string; characters: number; speed: number; active: boolean; entryId?: string };
export type UnityProgress = {
  detail: string; completed: number; total: number | null; folder?: string; coverageCompleted?: number; coverageTotal?: number; requests?: number; reused?: number;
  translation?: { processed: number; pending: number; successful: number; failed: number; failedEntries: number; active: UnityTranslationActivity[]; last?: { id: string; failed: boolean } };
  engineStats?: UnityEngineProgress[]; engineTargetCharacters?: number;
};
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

export { unityTranslationProblem as unityTranslationError } from "./unityTokens";
