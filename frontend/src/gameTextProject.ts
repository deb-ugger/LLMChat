import type { GameWrapMode } from "./gameTextLayout";
import { gameBracketPairs, gameBracketEnds, gameBracketIssue, gameBracketProblem } from "./gameTextStructure";
import { gameDisplayTextProblem, gameControlSignature, gameFormatTokens, gameJapaneseTextIssue, gameTextMatchesSource, rpgTextControlProblem, withoutGameSpeakerNames, translateGameDisplayText } from "./gameDisplayText";
import { API_BASE } from "./api";
import type { UnityEntry } from "./unityOffline";
import { applyUnityTranslationRows, readUnityTranslationRows, type TranslationRow, type UnityTranslationImportMode } from "./unityTranslationFiles";
import { unityTranslationError } from "./unityOffline";
import { hasTranslationPromptLeak, TRANSLATION_PROMPT_LEAK } from "./unityTokens";

export type GameTextOptions = { kind: "llm" | "local" | "engine"; model: string; dialogueModel?: string; screeningModel?: string; nameModel?: string; source: string; target: string; joinLines: boolean; includeContext?: boolean; wrapMode?: GameWrapMode; lineMode?: import("./unityLineLayout").UnityLineMode; lineModel?: string; skipTargetLanguage?: boolean; onlySourceLanguage?: boolean };
export type DialogueRepair = "position" | "continuation" | "alignment" | "name";
export const dialogueRepairLabels: Record<DialogueRepair, string> = { position: "定位参数", continuation: "句尾对齐", alignment: "缺少行首定位", name: "姓名框" };
export type DialogueRepairPreview = { input: string; text: string };
export type GameTextEntry = UnityEntry & { dialogueRepairs?: DialogueRepair[]; dialogueRepairPreview?: DialogueRepairPreview; importPartial?: { translation: string; unmatched: string[] }; translationResult?: { translation: string; target: string } };
export const gameTextSupplementResult = (entry: UnityEntry, target?: string) => {
  const result = (entry as GameTextEntry).translationResult;
  return !!result && !!entry.translation.trim() && result.translation === entry.translation && (!target || result.target === target);
};
export const gameTextImportPartial = (entry: UnityEntry) => {
  const partial = (entry as GameTextEntry).importPartial;
  return partial?.translation === entry.translation ? partial : undefined;
};
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
    current.screeningDraft === saved.screeningDraft && current.layoutDraft === saved.layoutDraft && current.error === saved.error &&
    JSON.stringify(gameTextImportPartial(current)) === JSON.stringify(gameTextImportPartial(saved));
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

const isVisibleGameBrace = (token: string) => /^\{[^{}\r\n"']+\}$/.test(token) && !/^\{(?:\d+|[A-Za-z_][\w.]*)(?:\s*,\s*[+-]?\d+)?(?::[^{}\r\n]*)?\}$/.test(token);
const visibleGameBraces = (text: string) => text.replace(/\{[^{}\r\n"']+\}/g, token => isVisibleGameBrace(token) ? "｛" + token.slice(1, -1) + "｝" : token);

export function gameTextProblem(source: string, translation: string, messageCore = false) {
  if (source === translation && !source.trim()) return "";
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
  // Compare actual placeholders; a brace containing prose is visible text.
  source = visibleGameBraces(source); translation = visibleGameBraces(translation);
  const error = unityTranslationError(withoutGameSpeakerNames(source), withoutGameSpeakerNames(translation));
  if (error) return error;
  const missing = gameDisplayTextProblem(source, translation) || rpgTextControlProblem(source, translation);
  if (missing) return missing;
  const brackets = gameBracketProblem(importVisibleText(source), importVisibleText(translation));
  if (brackets) return brackets;
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
function importTextWrapper(source: string) {
  // These controls change presentation, not names or variable substitutions.
  const token = String.raw`\\(?:fh|f|c|px|py|fs|fn|ow|oc|i)\[[^\]\r\n]*\]`;
  return new RegExp(`^((?:${token}[ \\t]*)*)([\\s\\S]*?)((?:[ \\t]*${token})*)$`, "i").exec(source)!;
}

function restoreImportDisplayControls(source: string, translation: string) {
  if (!translation.trim()) return translation;
  const restore = (original: string, translated: string) => {
    const wrapped = importTextWrapper(original.trim()), present = importTextWrapper(translated.trim());
    if (!(wrapped[1] || wrapped[3]) || present[1] || present[3]) return translated;
    // Only edge controls have an unambiguous position after translation.
    if ([...wrapped[2].matchAll(gameFormatTokens())].some(token => importTextWrapper(token[0])[1])) return translated;
    const text = translated.trim(), offset = translated.indexOf(text);
    return translated.slice(0, offset) + wrapped[1] + text + wrapped[3] + translated.slice(offset + text.length);
  };
  const originals = source.split(/\r\n|\r|\n/), parts = translation.split(/(\r\n|\r|\n)/);
  if (originals.length === (parts.length + 1) / 2)
    return parts.map((part, index) => index % 2 ? part : restore(originals[index / 2], part)).join("");
  return restore(source, translation);
}

type ImportTextSource = { source: string; line?: number; range?: [number, number] };
type ImportTextChoices = Map<string, ImportTextSource>;
type ImportTextSplit = { sourceLines: number; translationLines: number; available: boolean; reason: string };
const normalizeImportText = (text: string) => text.replace(/\r\n|\r/g, "\n").normalize("NFKC");
const importTextTokens = (source: string) => [...source.matchAll(gameFormatTokens())].filter(match => !/^\\(?:n[1-5]?|nc|nr|name|speaker)</i.test(match[0]) && !isVisibleGameBrace(match[0]));
const importVisibleText = (text: string) => text.replace(gameFormatTokens(), token => isVisibleGameBrace(token) ? token : /^\\(?:n[1-5]?|nc|nr|name|speaker)</i.test(token) ? token.slice(token.indexOf("<") + 1, -1) : "");
const importBracketPairs = gameBracketPairs, importBracketEnds = gameBracketEnds;
const balancedImportBrackets = (text: string) => !gameBracketIssue(text);
function importBracketUnits(text: string) {
  if (!balancedImportBrackets(text)) return [{ text, after: "" }];
  const units: { text: string; after: string }[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!importBracketPairs.has(char) && !importBracketEnds.has(char) && char !== "\r" && char !== "\n") continue;
    if (index > start) units.push({ text: text.slice(start, index), after: "" });
    const length = char === "\r" && text[index + 1] === "\n" ? 2 : 1;
    units.push({ text: text.slice(index, index + length), after: "" }); index += length - 1; start = index + 1;
  }
  if (start < text.length) units.push({ text: text.slice(start), after: "" });
  return units.length ? units : [{ text, after: "" }];
}

function indexGameTextImportFile(values: [string, string][]) {
  const splits = new Map<string, ImportTextSplit>();
  const lineIndex = new Map<string, ImportTextChoices>(), derivedIndex = new Map<string, ImportTextChoices>();
  const add = (index: Map<string, ImportTextChoices>, text: string, translated: string, origin: ImportTextSource) => {
    const line = text.trim(), value = translated.trim();
    if (!line || !value || value === line && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(line)) return;
    let choices = index.get(line);
    if (!choices) index.set(line, choices = new Map());
    choices.set(value, origin);
  };
  // Parse the file before searching the scanned entries. Original blocks and
  // explicit single-line records take priority over derived line records.
  for (const [source, translation] of values) {
    add(lineIndex, source, translation, { source });
    const wrapped = importTextWrapper(source.trim()), restored = importTextWrapper(restoreImportDisplayControls(source, translation).trim());
    if ((wrapped[1] || wrapped[3]) && wrapped[2] && gameControlSignature(wrapped[1] + wrapped[3]) === gameControlSignature(restored[1] + restored[3])) {
      const offset = source.indexOf(source.trim()) + wrapped[1].length;
      add(derivedIndex, wrapped[2], restored[2], { source, range: [offset, offset + wrapped[2].length] });
    }
    const sourceTokens = importTextTokens(source), targetTokens = importTextTokens(translation);
    if (sourceTokens.length && JSON.stringify(sourceTokens.map(token => token[0])) === JSON.stringify(targetTokens.map(token => token[0]))) {
      let start = 0, targetStart = 0;
      for (let index = 0; index <= sourceTokens.length; index++) {
        const end = sourceTokens[index]?.index ?? source.length, targetEnd = targetTokens[index]?.index ?? translation.length;
        add(derivedIndex, source.slice(start, end), translation.slice(targetStart, targetEnd), { source, range: [start, end] });
        if (index < sourceTokens.length) { start = end + sourceTokens[index][0].length; targetStart = targetEnd + targetTokens[index][0].length; }
      }
    }
    const sourceLines = source.split(/\r\n|\r|\n/), translationLines = translation.split(/\r\n|\r|\n/);
    if (sourceLines.length <= 1) continue;
    const available = sourceLines.length === translationLines.length && sourceLines.every((line, index) => !line.trim() === !translationLines[index].trim());
    splits.set(source, { sourceLines: sourceLines.length, translationLines: translationLines.length, available,
      reason: available ? "原文和译文逐行对应" : "原文与译文行数或空行不对应，仅保留整段匹配" });
    if (available) {
      let offset = 0;
      const separators = source.match(/\r\n|\r|\n/g) || [];
      sourceLines.forEach((line, index) => {
        add(derivedIndex, line, translationLines[index], { source, line: index, range: [offset, offset + line.length] });
        offset += line.length + (separators[index]?.length || 0);
      });
    }
  }
  const normalizedIndex = (index: Map<string, ImportTextChoices>) => {
    const result = new Map<string, ImportTextChoices>();
    for (const [text, choices] of index) {
      const key = normalizeImportText(text);
      let normalized = result.get(key);
      if (!normalized) result.set(key, normalized = new Map());
      for (const [translation, origin] of choices) normalized.set(translation, origin);
    }
    return result;
  };
  const widthIndex = normalizedIndex(lineIndex), derivedWidthIndex = normalizedIndex(derivedIndex);
  const lookup = (text: string) => lineIndex.get(text) || widthIndex.get(normalizeImportText(text)) || derivedIndex.get(text) || derivedWidthIndex.get(normalizeImportText(text));
  return { lookup, splits };
}

function reassembleGameText(source: string, lookup: (line: string) => ImportTextChoices | undefined, punctuation = false, preserveLatin = false) {
  const parts = source.split(/(\r\n|\r|\n)/);
  const units = punctuation ? importBracketUnits(source) :
    parts.filter((_, index) => index % 2 === 0).map((text, index) => ({ text, after: parts[index * 2 + 1] || "" }));
  let offset = 0;
  const starts = units.map(unit => { const start = offset; offset += unit.text.length + unit.after.length; return start; });
  type Gap = { start: number; end: number; text: string };
  type Plan = { text: string; used: ImportTextSource[]; missingLines: string[]; unmatched: Gap[]; matches: { start: number; end: number; translation: string }[]; ambiguous: boolean; retained: string[] };
  const lines = units.length;
  const plans: Plan[] = [];
  plans[lines] = { text: "", used: [], missingLines: [], unmatched: [], matches: [], ambiguous: false, retained: [] };
  // Match complete file blocks before shorter ones, but choose a partition that
  // covers every source line rather than committing to a dead-end prefix.
  for (let start = lines - 1; start >= 0; start--) {
    let best: Plan | undefined;
    for (let end = lines - 1; end >= start; end--) {
      const original = units.slice(start, end + 1).map((unit, index) => unit.text + (index < end - start ? unit.after : "")).join(""), text = original.trim();
      if (!text || punctuation && !balancedImportBrackets(text)) continue;
      let choices = lookup(text), prefix = "", suffix = "";
      if (!choices?.size) {
        const wrapped = importTextWrapper(text);
        if (wrapped[1] || wrapped[3]) { choices = lookup(wrapped[2]); prefix = wrapped[1]; suffix = wrapped[3]; }
      }
      if (!choices?.size) continue;
      const tail = plans[end + 1], offset = original.indexOf(text);
      const [translation, origin] = choices.entries().next().value!;
      const replacement = original.slice(0, offset) + prefix + translation + suffix + original.slice(offset + text.length);
      const plan: Plan = {
        text: replacement + units[end].after + tail.text,
        used: [...(choices.size === 1 ? [origin] : choices.values()), ...tail.used],
        missingLines: tail.missingLines, unmatched: tail.unmatched, ambiguous: choices.size !== 1 || tail.ambiguous, retained: tail.retained,
        matches: [{ start: starts[start], end: starts[end] + units[end].text.length, translation: replacement }, ...tail.matches],
      };
      if (!best || plan.missingLines.length < best.missingLines.length) best = plan;
    }
    const tail = plans[start + 1], original = units[start].text, visible = importVisibleText(original);
    const retained = preserveLatin && /\p{L}/u.test(visible) && /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u.test(visible);
    const missing = /\p{L}/u.test(visible) && !retained ? [original.trim()] : [];
    const fallback: Plan = { text: original + units[start].after + tail.text, used: tail.used, missingLines: [...missing, ...tail.missingLines], unmatched: [...(missing.length ? [{ start: starts[start], end: starts[start] + original.length, text: original }] : []), ...tail.unmatched], matches: tail.matches, ambiguous: tail.ambiguous, retained: [...(retained ? [original.trim()] : []), ...tail.retained] };
    plans[start] = !best || fallback.missingLines.length < best.missingLines.length ? fallback : best;
  }
  const { used, missingLines, unmatched, matches, ambiguous, text, retained } = plans[0];
  if (ambiguous || !used.length) return { used, missingLines, unmatched, matches, retained, reason: ambiguous ? "跨行片段对应多条不同译文" : "" };
  return { used, translation: text, missingLines, unmatched, matches, retained };
}

function matchGameTextFragments(source: string, lookup: (text: string) => ImportTextChoices | undefined, preserveLatin: boolean) {
  // MTool dictionaries also contain literal fragments between parameters.
  // Keep the original parameters in place; names inside speaker tags are text.
  const tokens = importTextTokens(source);
  const used: ImportTextSource[] = [], missingLines: string[] = [], output: string[] = [], retained: string[] = [];
  let position = 0, ambiguity = "";
  const append = (text: string) => {
    if (!/\p{L}/u.test(text)) { output.push(text); return; }
    const literal = text.trim(), choices = lookup(literal);
    if (choices?.size === 1) {
      const [translation, key] = choices.entries().next().value!;
      used.push(key);
      const offset = text.indexOf(literal);
      output.push(text.slice(0, offset) + translation + text.slice(offset + literal.length));
      return;
    }
    if (choices && choices.size > 1) {
      used.push(...choices.values()); ambiguity = "正文片段对应多条不同译文"; return;
    }
    const lines = reassembleGameText(text, lookup, true, preserveLatin);
    used.push(...lines.used);
    if (lines.translation !== undefined) { output.push(lines.translation); retained.push(...lines.retained); missingLines.push(...lines.missingLines); }
    else if (!lines.used.length && !lines.reason && !lines.missingLines?.length) { output.push(text); retained.push(...lines.retained); }
    else {
      output.push(text);
      if (lines.reason?.includes("不同译文")) ambiguity = lines.reason;
      missingLines.push(...(lines.missingLines?.length ? lines.missingLines : [literal]));
    }
  };
  for (const token of tokens) {
    append(source.slice(position, token.index));
    output.push(token[0]); position = token.index! + token[0].length;
  }
  append(source.slice(position));
  if (!used.length && (missingLines.length || !retained.length)) return null;
  if (ambiguity) return { used, missingLines, reason: ambiguity };
  return { used, translation: output.join(""), missingLines, retained };
}

function finishGameTextImport(entries: UnityEntry[], rows: TranslationRow[], values: [string, string][], links: Map<string, ImportTextSource[]>, matchingIssues: { id: string; reason: string; missingLines?: string[] }[], validate: (source: string, translation: string) => string, mode: UnityTranslationImportMode, options: { reassembled?: number; controlsRestored?: number; fragmentMatched?: number; splits?: Map<string, ImportTextSplit>; retainedFragments?: { id: string; fragments: string[] }[]; partialEntries?: { id: string; remaining: string[] }[] } = {}) {
  const { reassembled = 0, controlsRestored = 0, fragmentMatched = 0, splits = new Map<string, ImportTextSplit>(), retainedFragments = [], partialEntries = [] } = options;
  const originals = new Map(entries.map(entry => [entry.id, entry]));
  const restored = new Set<string>();
  const prepared = rows.map(row => {
    const translation = restoreImportDisplayControls(originals.get(row.id)!.source, row.translation);
    if (translation === row.translation) return row;
    restored.add(row.id); return { ...row, translation };
  });
  const applied = applyUnityTranslationRows(entries, prepared, validate, { mode, allowClear: mode === "replace", partial: true });
  const rejected = new Set(applied.issues.map(issue => issue.id));
  const partials = new Map(partialEntries.map(entry => [entry.id, entry.remaining]));
  const provided = new Set(prepared.map(row => row.id));
  const next: GameTextEntry[] = applied.entries.map((entry, index) => {
    const accepted = provided.has(entry.id) && !rejected.has(entry.id) && !(mode === "fill" && (entries[index].translation.trim() || entries[index].layoutDraft?.trim()));
    const remaining = accepted ? partials.get(entry.id) : undefined;
    const partial = accepted ? remaining?.length ? { translation: entry.translation, unmatched: remaining } : undefined : gameTextImportPartial(entry);
    return JSON.stringify(partial) === JSON.stringify(gameTextImportPartial(entry)) ? entry : { ...entry, importPartial: partial };
  });
  const result = { ...applied, entries: next, changed: next.filter((entry, index) => entry !== entries[index]).length };
  const appliedPartials = next.filter(entry => provided.has(entry.id) && !rejected.has(entry.id) && gameTextImportPartial(entry)).map(entry => ({ id: entry.id, remaining: gameTextImportPartial(entry)!.unmatched }));
  const displayControlsRestored = result.entries.filter((entry, index) => entry !== entries[index] && restored.has(entry.id)).length;
  const issues = [...matchingIssues, ...result.issues];
  const problems = new Map(issues.map(issue => [issue.id, issue.reason]));
  const candidates = new Map(prepared.map(row => [row.id, row.translation]));
  const bySource = new Map<string, string[]>();
  const uses = new Map<string, { id: string; line?: number; range?: [number, number] }[]>();
  for (const [id, sources] of links) for (const origin of sources) {
    const ids = bySource.get(origin.source) || []; if (!ids.includes(id)) ids.push(id); bySource.set(origin.source, ids);
    const rows = uses.get(origin.source) || []; rows.push({ id, line: origin.line, range: origin.range }); uses.set(origin.source, rows);
  }
  // A dictionary can contain both a paragraph and separate translations of its
  // lines. Record unused alternatives separately from absent source text.
  const alternatives = new Map<string, string[]>();
  for (const entry of result.entries) {
    const parts = [entry.source];
    let offset = 0;
    for (const token of importTextTokens(entry.source)) {
      parts.push(entry.source.slice(offset, token.index)); offset = token.index! + token[0].length;
    }
    parts.push(entry.source.slice(offset));
    const keys = new Set<string>();
    const groups = new Set(parts);
    for (const part of parts) {
      const lines = part.split(/\r\n|\r|\n/);
      for (let start = 0; start < lines.length; start++) for (let end = start + 1; end <= lines.length; end++) groups.add(lines.slice(start, end).join("\n"));
    }
    for (const part of groups) {
      const literal = part.trim(); if (!literal) continue;
      keys.add(normalizeImportText(literal));
      const wrapped = importTextWrapper(literal);
      if (wrapped[2]) keys.add(normalizeImportText(wrapped[2]));
    }
    for (const key of keys) {
      const ids = alternatives.get(key) || []; ids.push(entry.id); alternatives.set(key, ids);
    }
  }
  const translatedIds = new Set(result.entries.filter(entry => entry.translation.trim()).map(entry => entry.id));
  const details = values.map(([source, translation]) => {
    const entryIds = bySource.get(source) || [];
    if (!entryIds.length) {
      const lineSplit = splits.get(source);
      const related = alternatives.get(normalizeImportText(source.trim())) || (lineSplit ? [...new Set(source.split(/\r\n|\r|\n/).flatMap(line => alternatives.get(normalizeImportText(line.trim())) || []))] : []);
      if (related.length) return { source, translation, entryIds: related,
        status: lineSplit && !lineSplit.available ? "未应用" : related.some(id => translatedIds.has(id)) ? "备选未使用" : "未应用",
        reason: lineSplit && !lineSplit.available ? lineSplit.reason : related.some(id => translatedIds.has(id)) ? "对应条目已有整段或其他片段译文，此备选译文未使用" : "仅匹配正文片段，整条仍缺少其他译文", lineSplit };
    }
    const statuses = entryIds.map(id => {
      const original = originals.get(id)!;
      if (problems.has(id)) return { id, status: "未应用", reason: problems.get(id)! };
      if (mode === "fill" && (original.translation.trim() || original.layoutDraft?.trim()))
        return { id, status: original.translation === candidates.get(id) ? "译文相同" : "未应用", reason: original.translation === candidates.get(id) ? "工程已有相同译文" : "补全模式保留已有译文或排版草稿" };
      if (!candidates.get(id)?.trim() && mode !== "replace") return { id, status: "未应用", reason: "导入译文为空" };
      return { id, status: original.translation === candidates.get(id) && !original.error && !original.layoutDraft ? "译文相同" : "已应用", reason: "" };
    });
    const status = statuses.find(row => row.status === "已应用") || statuses.find(row => row.status === "译文相同") || statuses[0];
    const acceptedIds = new Set(statuses.filter(row => row.status === "已应用" || row.status === "译文相同").map(row => row.id));
    const accepted = (uses.get(source) || []).filter(use => acceptedIds.has(use.id));
    const usedLines = [...new Set(accepted.flatMap(use => use.line === undefined ? [] : [use.line + 1]))].sort((a, b) => a - b);
    const lineSplit = splits.get(source);
    const usedParts = accepted.flatMap(use => use.range ? [{ start: use.range[0], end: use.range[1], text: source.slice(...use.range) }] : []);
    let partial = false;
    if (accepted.length && accepted.every(use => use.range)) {
      const controls = importTextTokens(source);
      partial = [...source.matchAll(/[\p{L}\p{N}]/gu)].some(letter => !controls.some(token => letter.index! >= token.index! && letter.index! < token.index! + token[0].length) && !usedParts.some(part => letter.index! >= part.start && letter.index! < part.end));
    }
    return { source, translation, entryIds, status: partial ? "部分应用" : status?.status || "未匹配", reason: partial ? "已应用部分正文，其余片段未匹配或未通过" : status?.reason || (status ? "" : "当前扫描中没有完整原文或可完整重组的对应条目"), usedLines, usedParts, lineSplit };
  });
  const missingEntries = result.entries.filter(entry => !entry.translation.trim()).map(entry => ({ id: entry.id, source: entry.source, reason: problems.get(entry.id) || (candidates.has(entry.id) ? "导入译文为空" : "翻译文件中没有可匹配译文") }));
  const fileUsed = details.filter(row => row.status === "已应用" || row.status === "译文相同").length;
  const filePartiallyUsed = details.filter(row => row.status === "部分应用").length;
  const projectPartial = next.filter(entry => gameTextImportPartial(entry)).length;
  const audit = { fileTotal: values.length, fileUsed, filePartiallyUsed, fileUnused: values.length - fileUsed - filePartiallyUsed, projectTotal: entries.length, projectTranslated: result.entries.length - missingEntries.length, projectPartial, projectComplete: result.entries.length - missingEntries.length - projectPartial, partialEntries: appliedPartials, changed: result.changed, reassembled, controlsRestored, displayControlsRestored, fragmentMatched, retainedFragments, details, missingEntries, issues };
  return { ...result, issues, audit, unmatched: details.filter(row => row.status === "未匹配").length, reassembled, controlsRestored, fragmentMatched };
}

export type GameTextImportAudit = ReturnType<typeof finishGameTextImport>["audit"];

export function importGameText(entries: UnityEntry[], contents: string, csv: boolean, mode: UnityTranslationImportMode, messageCore = false, sourceLanguage = "auto") {
  const validate = (source: string, translation: string) => gameTextProblem(source, translation, messageCore);
  const data = csv ? null : JSON.parse(contents.replace(/^\uFEFF/, ""));
  if (csv) {
    const rows = readUnityTranslationRows(entries, contents, true, true);
    return finishGameTextImport(entries, rows, [...rows, ...rows.issues].map(row => [row.source, row.translation]), new Map(rows.map(row => [row.id, [{ source: row.source }]])), rows.issues, validate, mode);
  }
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
  const fileIndex = data.kind === "llmchat-unity-translations" ? undefined : indexGameTextImportFile(values);
  const bySource = new Map(entries.map(entry => [entry.source, entry]));
  const rows = new Map<string, TranslationRow>();
  const links = new Map<string, ImportTextSource[]>();
  const conflicts = new Set<string>();
  const reassemblyIssues: { id: string; reason: string; missingLines?: string[] }[] = [];
  for (const [source, translation] of values) {
    const entry = bySource.get(source);
    if (!entry) continue;
    links.set(entry.id, [{ source }]);
    if (conflicts.has(entry.id)) continue;
    if (rows.has(entry.id) && rows.get(entry.id)!.translation !== translation) {
      rows.delete(entry.id); conflicts.add(entry.id);
      reassemblyIssues.push({ id: entry.id, reason: "同一原文对应多条不同译文，无法唯一匹配" }); continue;
    }
    rows.set(entry.id, { id: entry.id, source, translation });
  }
  let reassembled = 0, controlsRestored = 0, fragmentMatched = 0;
  const retainedFragments: { id: string; fragments: string[] }[] = [];
  const partialEntries: { id: string; remaining: string[] }[] = [];
  const splits = fileIndex?.splits || new Map<string, ImportTextSplit>();
  if (fileIndex) {
    const { lookup } = fileIndex;
    for (const entry of entries) {
      if (conflicts.has(entry.id) || rows.get(entry.id)?.translation.trim() || mode === "replace" && rows.has(entry.id)) continue;
      const original = entry.source.trim(), wrapped = importTextWrapper(original);
      const whole = (wrapped[1] || wrapped[3]) ? lookup(wrapped[2]) : undefined;
      const choice = whole?.size === 1 ? whole.entries().next().value! : undefined;
      const offset = entry.source.indexOf(original);
      let candidate: { used: ImportTextSource[]; translation?: string; reason?: string; missingLines?: string[]; retained?: string[]; unmatched?: { start: number; end: number; text: string }[]; matches?: { start: number; end: number; translation: string }[] } = choice ? { used: [choice[1]], translation: entry.source.slice(0, offset) + wrapped[1] + choice[0] + wrapped[3] + entry.source.slice(offset + original.length) } :
        whole && whole.size > 1 ? { used: [...whole.values()], reason: "同一原文对应多条不同译文，无法唯一匹配" } : reassembleGameText(entry.source, lookup);
      let fragments = false;
      const preserveLatin = /^ja(?:-|$)/i.test(sourceLanguage) || sourceLanguage === "auto" && gameTextMatchesSource(entry.source, "ja");
      if (candidate.translation !== undefined && candidate.unmatched?.length) {
        const patches = [...(candidate.matches || [])], missing: string[] = [], used = [...candidate.used], retained = [...(candidate.retained || [])];
        for (const gap of candidate.unmatched) {
          const match = matchGameTextFragments(gap.text, lookup, preserveLatin);
          if (match?.translation !== undefined) {
            patches.push({ start: gap.start, end: gap.end, translation: match.translation });
            used.push(...match.used); missing.push(...(match.missingLines || [])); retained.push(...(match.retained || []));
            if (match.used.length) fragments = true;
          } else missing.push(gap.text.trim());
        }
        let text = "", start = 0;
        for (const patch of patches.sort((a, b) => a.start - b.start)) { text += entry.source.slice(start, patch.start) + patch.translation; start = patch.end; }
        candidate = { used, translation: text + entry.source.slice(start), missingLines: missing, retained };
      } else if (candidate.translation === undefined && !candidate.reason?.includes("不同译文")) {
        const match = matchGameTextFragments(entry.source, lookup, preserveLatin);
        if (match?.used.length) { candidate = match; fragments = true; }
      }
      const translation = candidate.translation;
      if (candidate.used.length) links.set(entry.id, candidate.used);
      const reason = candidate.reason || (translation ? validate(entry.source, translation) : "");
      if (reason) {
        if (!(mode === "fill" && (entry.translation.trim() || entry.layoutDraft?.trim()))) reassemblyIssues.push({ id: entry.id, reason, missingLines: candidate.missingLines });
        continue;
      }
      if (!translation) continue;
      rows.set(entry.id, { id: entry.id, source: entry.source, translation });
      if (translation !== entry.translation && !(mode === "fill" && (entry.translation.trim() || entry.layoutDraft?.trim()))) {
        reassembled++;
        if (choice) controlsRestored++;
        if (fragments) fragmentMatched++;
        if (candidate.retained?.length) retainedFragments.push({ id: entry.id, fragments: candidate.retained });
        if (candidate.missingLines?.length) partialEntries.push({ id: entry.id, remaining: candidate.missingLines });
      }
    }
  }
  return finishGameTextImport(entries, [...rows.values()], values, links, reassemblyIssues, validate, mode, { reassembled, controlsRestored, fragmentMatched, splits, retainedFragments, partialEntries });
}
