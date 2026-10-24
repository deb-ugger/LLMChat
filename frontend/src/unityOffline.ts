import { invoke } from "@tauri-apps/api/core";
import { join, resourceDir } from "@tauri-apps/api/path";

export const UNITY_OUTPUT_KEY = "llmchat-unity-output-directory";
export type UnityEntry = {
  id: string; file: string; container: string; objectId: string; locator: string;
  kind: string; source: string; translation: string; selected: boolean; error: string;
};
export type UnityFont = { file: string; container: string; objectId: string; name: string; kind: string };
export type UnityProject = {
  version: number; root: string; folder: string; entries: UnityEntry[];
  fonts: UnityFont[]; warnings: string[]; hashes: Record<string, string>;
};
export type UnityPatch = { folder: string; files: number; entries: number; fontReplacements: number };
export const unityRun = <T>(action: string, request: object) => invoke<T>("unity_offline_run", { action, request });
export async function unityOutputDirectory() {
  return localStorage.getItem(UNITY_OUTPUT_KEY)?.trim() || await join(await resourceDir(), "unity-output");
}

const tokens = /\{[^{}\r\n]+\}|%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc%]|<\/?[^>\r\n]+>|\\[nrt]/g;
export function unityTranslationError(source: string, translation: string) {
  if (!translation.trim()) return "译文为空";
  const a = (source.match(tokens) || []).sort();
  const b = (translation.match(tokens) || []).sort();
  return JSON.stringify(a) === JSON.stringify(b) ? "" : "占位符、转义或富文本标签发生变化";
}
