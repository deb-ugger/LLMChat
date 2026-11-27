import type { UnityEntry } from "./unityOffline";
import { gameTextNeedsNoTranslation, gameSpeakerNames, gameControlSignature, withoutGameSpeakerNames, gameFormatTokens, hasGameJapaneseText } from "./gameDisplayText";
import { unityTranslationProblem } from "./unityTokens";
import { GAME_RESOURCE_LABELS, isGameDialogue } from "./gameTranslationContext";
import { gameBracketProblem } from "./gameTextStructure";

type Term = { src: string; dst: string; enabled?: boolean };
const literal = (name: string) => /\p{L}/u.test(name) && !/[\\{}<>]/.test(name);
const bodyText = (text: string) => text.replace(gameFormatTokens(), "");
const matchesTarget = (name: string, target: string) => target.startsWith("zh") ? /\p{Script=Han}/u.test(name) && !hasGameJapaneseText(name) && !/\p{Script=Hangul}/u.test(name)
  : target === "en" ? /\p{Script=Latin}/u.test(name) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(name)
  : target === "ja" ? /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name) : target === "ko" && /\p{Script=Hangul}/u.test(name);
const validTranslation = (source: string, value: string, target: string) => literal(value) && !/[\r\n]/.test(value) && !gameBracketProblem(source, value) &&
  (!/^(zh|ja|ko|en)(?:-|$)/.test(target) || matchesTarget(value, target));

function openTermMemory(scope: string | undefined, target: string) {
  const key = scope ? "llmchat-game-term-memory:v1:" + JSON.stringify([scope.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(), target]) : undefined;
  let memory = new Map<string, string>();
  if (key) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "{}");
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("缓存格式无效");
      memory = new Map(Object.entries(saved) as [string, string][]);
    } catch (error) { throw new Error("读取工程术语缓存失败：" + String(error)); }
  }
  return {
    get: (name: string) => {
      const value = memory.get(name);
      return typeof value === "string" && validTranslation(name, value, target) ? value : undefined;
    },
    save: (name: string, value: string) => {
      if (!key || memory.get(name) === value) return;
      memory.set(name, value);
      try { localStorage.setItem(key, JSON.stringify(Object.fromEntries(memory))); }
      catch (error) { throw new Error("保存工程术语缓存失败：" + String(error)); }
    },
  };
}

/** Prepare a game-local, target-specific dictionary before concurrent dialogue requests. */
export async function prepareGameTerms(selected: UnityEntry[], references: UnityEntry[], target: string, glossary: string | Term[] | undefined,
  translate: (name: string, context: string) => Promise<string>, signal: AbortSignal, progress?: (detail: string, completed: number, total: number) => void, memoryScope?: string) {
  signal.throwIfAborted();
  progress?.("正在从插件姓名框和游戏数据库收集术语", 0, selected.length);
  const terms = new Map<string, string>();
  const issues = new Map<string, string>();
  const configured: Term[] = typeof glossary === "string" ? JSON.parse(glossary || "[]") : glossary || [];
  for (const term of configured) if (term.enabled !== false && term.src?.trim() && term.dst?.trim()) terms.set(term.src.trim(), term.dst.trim());
  const requested = new Map<string, string>();
  const add = (name: string, context: string, character = false) => {
    if (literal(name) && !gameTextNeedsNoTranslation(character ? `\\nc<${name}>` : name, target) && !terms.has(name) && !requested.has(name)) requested.set(name, context);
  };
  for (const entry of selected) for (const name of gameSpeakerNames(entry.source)) {
    add(name, `文本用途：角色名或称呼。首次所见对白：${bodyText(entry.source).trim().slice(0, 240)}`, true);
  }
  if (selected.length) {
    const bodies = selected.map(entry => bodyText(entry.source)).join("\u0000");
    const knownNames = new Set(references.flatMap(entry => gameSpeakerNames(entry.source)));
    for (const name of knownNames)
      if (name.length >= 2 && bodies.includes(name)) add(name, "文本用途：对白中出现的已知角色名。", true);
    const selectedSources = new Set(selected.map(entry => entry.source));
    for (const entry of references) {
      const kind = entry.rpgTextKind;
      const term = entry.source.trim();
      if (kind && kind !== "interface" && (selectedSources.has(entry.source) || term.length >= 2 && bodies.includes(term)))
        add(term, `文本用途：${GAME_RESOURCE_LABELS[kind]}。只输出该术语的译名。`, kind === "character");
    }
  }
  if (!requested.size) {
    progress?.("术语已就绪", 0, 0);
    return { terms, issues };
  }
  const memory = openTermMemory(memoryScope, target);
  progress?.(`已收集 ${requested.size} 个不同术语，正在匹配工程已有译名`, 0, requested.size);
  const votes = new Map<string, Map<string, { count: number; positions: string[] }>>();
  for (const entry of references) {
    if (entry.error || !entry.translation || entry.translationTarget && entry.translationTarget !== target) continue;
    const term = entry.rpgTextKind && entry.rpgTextKind !== "interface" && !isGameDialogue(entry.source, entry);
    const original = term ? [entry.source.trim()] : gameSpeakerNames(entry.source);
    if (!original.some(name => requested.has(name))) continue;
    if (gameControlSignature(entry.source) !== gameControlSignature(entry.translation) || unityTranslationProblem(withoutGameSpeakerNames(entry.source), withoutGameSpeakerNames(entry.translation))) continue;
    const translated = term ? [entry.translation.trim()] : gameSpeakerNames(entry.translation);
    if (original.length !== translated.length) continue;
    original.forEach((name, index) => {
      const value = translated[index];
      if (!requested.has(name) || !validTranslation(name, value, target)) return;
      const choices = votes.get(name) || new Map<string, { count: number; positions: string[] }>();
      const choice = choices.get(value) || { count: 0, positions: [] };
      choice.count++;
      if (choice.positions.length < 3) choice.positions.push("#" + entry.id);
      choices.set(value, choice);
      votes.set(name, choices);
    });
  }
  for (const [name, choices] of votes) {
    if (choices.size === 1) terms.set(name, choices.keys().next().value!);
    else {
      const candidates = [...choices].sort((a, b) => b[1].count - a[1].count)
        .map(([value, choice]) => `「${value}」${choice.count} 处（${choice.positions.join("、")}）`);
      issues.set(name, `术语「${name}」有多个译名，${candidates.join("，")}。请在术语表确认后重试。`);
    }
  }
  for (const name of requested.keys()) {
    if (issues.has(name)) continue;
    if (!terms.has(name)) {
      const remembered = memory.get(name);
      if (remembered) terms.set(name, remembered);
    }
    const translation = terms.get(name);
    if (translation) memory.save(name, translation);
  }
  const pending = [...requested].filter(([name]) => !terms.has(name) && !issues.has(name));
  const reusedNames = [...requested.keys()].filter(name => terms.has(name)).length;
  progress?.(`术语去重完成：复用 ${reusedNames} 个已有译名，待确定 ${pending.length} 个新译名`, 0, pending.length);
  let completedNames = 0;
  for (let offset = 0; offset < pending.length; offset += 4) {
    const settled = await Promise.allSettled(pending.slice(offset, offset + 4).map(async ([name, context], localIndex) => {
      const index = offset + localIndex;
      signal.throwIfAborted();
      progress?.(`正在确定术语 ${index + 1}/${pending.length}：${name}`, completedNames, pending.length);
      let value: string;
      try {
        value = (await translate(name, context)).trim();
        if (!validTranslation(name, value, target)) throw new Error("模型返回的译名无效、括号引用不匹配或未完整译为目标语言");
      } catch (error) {
        signal.throwIfAborted();
        issues.set(name, `确定译名「${name}」失败：${error instanceof Error ? error.message : String(error)}`);
        progress?.(`术语待处理：${name}`, ++completedNames, pending.length);
        return;
      }
      terms.set(name, value);
      memory.save(name, value);
      signal.throwIfAborted();
      progress?.(`术语已确定：${name} → ${value}`, ++completedNames, pending.length);
    }));
    signal.throwIfAborted();
    const failedWrite = settled.find(result => result.status === "rejected");
    if (failedWrite?.status === "rejected") throw failedWrite.reason;
  }
  return { terms, issues };
}

export function gameTermProblem(source: string, issues: ReadonlyMap<string, string>) {
  if (!issues.size) return undefined;
  const names = gameSpeakerNames(source), body = bodyText(source);
  const messages = [...new Set([...issues].filter(([name]) => names.includes(name) || body.trim() === name).map(([, problem]) => problem))];
  return messages.length ? messages.join("。") : undefined;
}
