import type { GameWrapMode } from "./gameTextLayout";
import { gameDisplayTextProblem, gameControlSignature, gameFormatTokens, gameJapaneseTextIssue, rpgTextControlProblem, withoutGameSpeakerNames, translateGameDisplayText } from "./gameDisplayText";
import { API_BASE } from "./api";
import type { UnityEntry } from "./unityOffline";
import { applyUnityTranslationRows, readUnityTranslationRows, type TranslationRow, type UnityTranslationImportMode } from "./unityTranslationFiles";
import { unityTranslationError } from "./unityOffline";
import { hasTranslationPromptLeak, TRANSLATION_PROMPT_LEAK } from "./unityTokens";

export type GameTextOptions = { kind: "llm" | "local" | "engine"; model: string; dialogueModel?: string; screeningModel?: string; nameModel?: string; source: string; target: string; joinLines: boolean; includeContext?: boolean; wrapMode?: GameWrapMode; skipTargetLanguage?: boolean; onlySourceLanguage?: boolean };
export type DialogueRepair = "position" | "continuation" | "alignment" | "name";
export const dialogueRepairLabels: Record<DialogueRepair, string> = { position: "定位参数", continuation: "句尾对齐", alignment: "缺少行首定位", name: "姓名框" };
export type DialogueRepairPreview = { input: string; text: string };
export type GameTextEntry = UnityEntry & { dialogueRepairs?: DialogueRepair[]; dialogueRepairPreview?: DialogueRepairPreview };
export type GameTextProject = { dialoguePages?: import("./gameTranslationContext").GameDialoguePage[]; entries: GameTextEntry[]; sourcePath: string; translationPath: string; options: Partial<GameTextOptions>; workflow?: { screened: boolean; screenedIds?: string[] }; messageCore?: boolean; positionRepairs?: number };

export function isTextSelectionScreened(entries: UnityEntry[], screenedIds?: string[]) {
  if (!screenedIds?.length) return false;
  const screened = new Set(screenedIds);
  return entries.every(entry => !entry.selected || screened.has(entry.id));
}

export function restoreGameTextState(screened: boolean, selected: number, completed: number, failed: number, interrupted: boolean) {
  if (!screened || !selected) return "idle";
  if (completed === selected) return "done";
  if (failed) return "error";
  return interrupted ? "stopped" : "idle";
}

export function sameTextEdit(current: UnityEntry, saved: UnityEntry) {
  return current.selected === saved.selected && current.translation === saved.translation &&
    current.translationTarget === saved.translationTarget && current.layoutDraftTarget === saved.layoutDraftTarget &&
    current.screeningDraft === saved.screeningDraft && current.layoutDraft === saved.layoutDraft && current.error === saved.error;
}
const messageCoreNames = /\\(?:nc|nr|n[1-5]?)<([^<>\r\n]*)>/gi;
const explicitMessageCoreName = /\\nc<[^<>\\\r\n]+>(?=[\t \r\n]*$)/i;
export const repairMessageCorePositionPrefix = (text: string) =>
  text.replace(/^([ \t]*)(p[xy]\[[0-9]{1,5}\])(?=[\u3000-\uFFFF]|\\)/gim, "$1\\$2");
export const repairMessageCoreNameLineBreak = (text: string) => {
  const joined = text.replace(/(?<!\\)(\\(?:nc|nr|n[1-5]?)<[^<>\\\r\n \t][^<>\\\r\n]*?)[ \t]*\r?\n[ \t]*>/gi, "$1>");
  const closed = joined.replace(/(?<!\\)(\\(?:nc|nr|n[1-5]?)<[^<>\\\r\n \t][^<>\\\r\n]{0,47}?)[ \t]*(?=\r?$)/gim, "$1>");
  const repaired = closed.replace(/^([ \t]*)\\px\[[0-9]+\][ \t]*(\\(?:nc|nr|n[1-5]?)<[^<>\\\r\n]+>)[ \t]*(?=\r?$)/gim, "$1$2");
  if (closed === joined) return repaired;
  const name = /(?<!\\)(\\(?:nc|nr|n[1-5]?)<[^<>\\\r\n]+>)[ \t\r\n]*$/i.exec(repaired);
  if (!name || !repaired.slice(repaired.lastIndexOf("\n", name.index) + 1, name.index).trim()) return repaired;
  const lines = repaired.split("\n");
  if (lines.length < 4) return repaired.slice(0, name.index) + (repaired.includes("\r\n") ? "\r\n" : "\n") + repaired.slice(name.index);
  if (!lines[0].trim()) return name[1] + repaired.slice(0, name.index) + repaired.slice(name.index + name[1].length);
  return repaired;
};
export function hasMessageCoreNameOverride(source: string, translation: string) {
  const normalizedSource = repairMessageCoreNameLineBreak(source), normalizedTranslation = repairMessageCoreNameLineBreak(translation);
  const original = [...normalizedSource.matchAll(messageCoreNames)], edited = [...normalizedTranslation.matchAll(messageCoreNames)];
  return edited.length === 1 && explicitMessageCoreName.test(normalizedTranslation) &&
    (!original.length || original.length === 1 && original[0][1] !== edited[0][1] &&
      withoutGameSpeakerNames(normalizedSource) === withoutGameSpeakerNames(normalizedTranslation));
}

export function gameTextProblem(source: string, translation: string, messageCore = false) {
  if (hasTranslationPromptLeak(source, translation)) return TRANSLATION_PROMPT_LEAK;
  if (messageCore && translation.trim()) {
    source = repairMessageCoreNameLineBreak(repairMessageCorePositionPrefix(source));
    translation = repairMessageCoreNameLineBreak(repairMessageCorePositionPrefix(translation));
    const originalNames = [...source.matchAll(messageCoreNames)], translatedNames = [...translation.matchAll(messageCoreNames)];
    if (!originalNames.length && hasMessageCoreNameOverride(source, translation)) {
      translation = translation.replace(explicitMessageCoreName, "");
    } else if (originalNames.length === 1 && originalNames[0][1].trim()) {
      if (!translatedNames.length) translation += originalNames[0][0];
      else if (translatedNames.length === 1 && !translatedNames[0][1].trim())
        translation = translation.replace(translatedNames[0][0], () => originalNames[0][0]);
    }
  }
  const error = unityTranslationError(withoutGameSpeakerNames(source), withoutGameSpeakerNames(translation));
  if (error) return error;
  const missing = gameDisplayTextProblem(source, translation) || rpgTextControlProblem(source, translation);
  if (missing) return missing;
  return gameControlSignature(source) === gameControlSignature(translation) ? "" : "游戏控制符发生变化，请保留原文中的反斜杠指令及参数";
}

export function createGameTextValidator(messageCore: boolean, target: string) {
  const checked = new Map<string, { translation: string; problem: string }>();
  return (source: string, translation: string) => {
    const last = checked.get(source);
    if (last?.translation === translation) return last.problem;
    const problem = gameTextProblem(source, translation, messageCore) || gameJapaneseTextIssue(source, translation, target);
    checked.set(source, { translation, problem });
    return problem;
  };
}

export const translateGameControls = translateGameDisplayText;
export async function gameTextRequest<T>(action: "load" | "save" | "workflow" | "checkpoint", body: object): Promise<T> {
  const { dialoguePages: _, ...saved } = body as Partial<GameTextProject>;
  const response = await fetch(`${API_BASE}/api/game-text/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "save" ? saved : body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "游戏文本工程操作失败");
  return result;
}
export function gameTextDictionary(entries: UnityEntry[], exportAll = false, target?: string) {
  return Object.fromEntries(entries.filter(entry => exportAll || entry.selected && entry.translation.trim() && !entry.error && !gameTextProblem(entry.source, entry.translation))
    .map(entry => [entry.source, hasTranslationPromptLeak(entry.source, entry.translation) || target && entry.translationTarget && entry.translationTarget !== target ? "" : entry.translation]));
}
function reassembleGameText(source: string, lookup: (line: string) => Map<string, string> | undefined) {
  const parts = source.split(/(\r\n|\r|\n)/);
  let found = 0, missing = 0, ambiguous = 0;
  const used: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const original = parts[index], line = original.trim();
    if (!/\p{L}/u.test(line.replace(gameFormatTokens(), ""))) continue;
    let choices = lookup(line);
    let prefix = "", suffix = "";
    if (!choices?.size) {
      const wrapped = /^((?:\\(?:c|px|py|fs)\[\d+\][ \t]*)*)(.*?)([ \t]*(?:\\(?:c|px|py|fs)\[\d+\][ \t]*)*)$/i.exec(line);
      if (wrapped && (wrapped[1] || wrapped[3])) {
        choices = lookup(wrapped[2]);
        prefix = wrapped[1]; suffix = wrapped[3];
      }
    }
    if (!choices?.size) { missing++; continue; }
    if (choices.size !== 1) { ambiguous++; continue; }
    const [translation, key] = choices.entries().next().value!;
    found++;
    used.push(key);
    const offset = original.indexOf(line);
    parts[index] = original.slice(0, offset) + prefix + translation + suffix + original.slice(offset + line.length);
  }
  if (!found || missing || ambiguous) {
    return { used: [], reason: ambiguous ? "单行对应多条不同译文" : found ? "缺少 " + missing + " 行译文" : "" };
  }
  return { used, translation: parts.join("") };
}

export function importGameText(entries: UnityEntry[], contents: string, csv: boolean, mode: UnityTranslationImportMode, messageCore = false) {
  const validate = (source: string, translation: string) => gameTextProblem(source, translation, messageCore);
  const data = csv ? null : JSON.parse(contents.replace(/^\uFEFF/, ""));
  if (csv) return { ...applyUnityTranslationRows(entries, readUnityTranslationRows(entries, contents, true), validate, { mode, allowClear: mode === "replace" }), unmatched: 0, reassembled: 0, reassemblyIssues: [] };
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
  const used = new Set<string>();
  for (const [source, translation] of values) {
    const entry = bySource.get(source);
    if (!entry) continue;
    used.add(source);
    if (rows.has(entry.id) && rows.get(entry.id)!.translation !== translation) throw new Error(`原文「${source.slice(0, 60)}」对应多条不同译文，无法确定应导入哪一条`);
    rows.set(entry.id, { id: entry.id, source, translation });
  }
  let reassembled = 0;
  const reassemblyIssues: { id: string; reason: string }[] = [];
  if (data.kind !== "llmchat-unity-translations") {
    const lineIndex = new Map<string, Map<string, string>>();
    for (const [source, translation] of values) {
      const line = source.trim(), value = translation.trim();
      if (!line || !value || /[\r\n]/.test(line) || /[\r\n]/.test(value) ||
        value === line && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(line)) continue;
      let choices = lineIndex.get(line);
      if (!choices) lineIndex.set(line, choices = new Map());
      choices.set(value, source);
    }
    for (const entry of entries) {
      if (rows.get(entry.id)?.translation.trim() || mode === "replace" && rows.has(entry.id) ||
          mode === "fill" && (entry.translation.trim() || entry.layoutDraft?.trim())) continue;
      const candidate = reassembleGameText(entry.source, line => lineIndex.get(line));
      const translation = candidate.translation;
      const reason = candidate.reason || (translation ? validate(entry.source, translation) : "");
      if (reason) { reassemblyIssues.push({ id: entry.id, reason }); continue; }
      if (!translation || translation === entry.source) continue;
      rows.set(entry.id, { id: entry.id, source: entry.source, translation });
      candidate.used.forEach(key => used.add(key));
      if (translation !== entry.translation) reassembled++;
    }
  }
  if (!rows.size && !reassemblyIssues.length)
    throw new Error("导入文件的 " + values.length + " 条原文均未匹配当前扫描，请检查游戏版本及原文语言");
  return { ...applyUnityTranslationRows(entries, [...rows.values()], validate, { mode, allowClear: mode === "replace" }),
    unmatched: values.filter(([source]) => !used.has(source)).length, reassembled, reassemblyIssues };
}
