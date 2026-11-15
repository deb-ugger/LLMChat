import type { GameWrapMode } from "./gameTextLayout";
import { gameDisplayTextProblem, gameControlSignature, withoutGameSpeakerNames, translateGameDisplayText } from "./gameDisplayText";
import { API_BASE } from "./api";
import type { UnityEntry } from "./unityOffline";
import { applyUnityTranslationRows, readUnityTranslationRows, type TranslationRow, type UnityTranslationImportMode } from "./unityTranslationFiles";
import { unityTranslationError } from "./unityOffline";

export type GameTextOptions = { kind: "llm" | "local" | "engine"; model: string; dialogueModel?: string; nameModel?: string; source: string; target: string; joinLines: boolean; wrapMode?: GameWrapMode; skipTargetLanguage?: boolean; onlySourceLanguage?: boolean };
export type GameTextProject = { entries: UnityEntry[]; sourcePath: string; translationPath: string; options: Partial<GameTextOptions> };
export function gameTextProblem(source: string, translation: string) {
  const error = unityTranslationError(withoutGameSpeakerNames(source), withoutGameSpeakerNames(translation));
  if (error) return error;
  const missing = gameDisplayTextProblem(source, translation);
  if (missing) return missing;
  return gameControlSignature(source) === gameControlSignature(translation) ? "" : "游戏控制符发生变化，请保留原文中的反斜杠指令及参数";
}
export const translateGameControls = translateGameDisplayText;
export async function gameTextRequest<T>(action: "load" | "save" | "workflow", body: object): Promise<T> {
  const response = await fetch(`${API_BASE}/api/game-text/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "游戏文本工程操作失败");
  return result;
}
export function gameTextDictionary(entries: UnityEntry[], exportAll = false) {
  return Object.fromEntries(entries.filter(entry => exportAll || entry.selected && entry.translation.trim() && !entry.error && !gameTextProblem(entry.source, entry.translation)).map(entry => [entry.source, entry.translation]));
}
export function importGameText(entries: UnityEntry[], contents: string, csv: boolean, mode: UnityTranslationImportMode) {
  const data = csv ? null : JSON.parse(contents.replace(/^\uFEFF/, ""));
  if (csv) return { ...applyUnityTranslationRows(entries, readUnityTranslationRows(entries, contents, true), gameTextProblem, { mode, allowClear: mode === "replace" }), unmatched: 0 };
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("请选择 MTool 原文→译文 JSON，或导出的翻译文件");
  let values: [string, string][];
  if (data.kind === "llmchat-unity-translations") {
    if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error("翻译文件版本或 entries 结构无效");
    values = data.entries.map((row: unknown, index: number) => {
      if (!row || typeof row !== "object" || !("source" in row) || !("translation" in row) || typeof row.source !== "string" || typeof row.translation !== "string") throw new Error(`翻译文件第 ${index + 1} 条必须包含文本 source 和 translation`);
      return [row.source, row.translation];
    });
  } else {
    values = Object.entries(data).map(([source, translation]) => {
      if (typeof translation !== "string") throw new Error(`原文「${source.slice(0, 60)}」的译文不是文本`);
      return [source, translation];
    });
  }
  const bySource = new Map(entries.map(entry => [entry.source, entry]));
  const rows = new Map<string, TranslationRow>();
  let unmatched = 0;
  for (const [source, translation] of values) {
    const entry = bySource.get(source);
    if (!entry) { unmatched++; continue; }
    if (rows.has(entry.id) && rows.get(entry.id)!.translation !== translation) throw new Error(`原文「${source.slice(0, 60)}」对应多条不同译文，无法确定应导入哪一条`);
    rows.set(entry.id, { id: entry.id, source, translation });
  }
  if (!rows.size) throw new Error(`导入文件的 ${values.length} 条原文均未匹配当前扫描，请检查游戏版本及原文语言`);
  // Exported IDs can change after rescanning; the exact original text owns the translation.
  return { ...applyUnityTranslationRows(entries, [...rows.values()], gameTextProblem, { mode, allowClear: mode === "replace" }), unmatched };
}
