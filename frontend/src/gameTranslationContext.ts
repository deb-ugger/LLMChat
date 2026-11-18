import type { TranslateOptions } from "./api";
import type { UnityEntry } from "./unityOffline";
import { gameFormatTokens, gameSpeakerNames, gameTextHasSpeaker } from "./gameDisplayText";

export const GAME_CONTEXT_HINT = "大模型可参考同一剧情分支或资源中的前后文。条数和每条长度可在「设置 → 游戏翻译」调整。";
export const GAME_CONTEXT_MAX = 4000;
export const GAME_CONTEXT_COUNT_MAX = 8;
export const DEFAULT_GAME_CONTEXT = { previous: 200, following: 200, previousCount: 1, followingCount: 1 };
type ContextLengths = typeof DEFAULT_GAME_CONTEXT;
const contextKey = "llmchat-game-context-lengths";

export function loadGameContextLengths(): ContextLengths {
  try {
    const saved = JSON.parse(localStorage.getItem(contextKey) || "{}");
    const valid = (value: number, max: number) => Number.isInteger(value) && value >= 0 && value <= max;
    return {
      previous: valid(saved.previous, GAME_CONTEXT_MAX) ? saved.previous : DEFAULT_GAME_CONTEXT.previous,
      following: valid(saved.following, GAME_CONTEXT_MAX) ? saved.following : DEFAULT_GAME_CONTEXT.following,
      previousCount: valid(saved.previousCount, GAME_CONTEXT_COUNT_MAX) ? saved.previousCount : DEFAULT_GAME_CONTEXT.previousCount,
      followingCount: valid(saved.followingCount, GAME_CONTEXT_COUNT_MAX) ? saved.followingCount : DEFAULT_GAME_CONTEXT.followingCount,
    };
  } catch {
    return { ...DEFAULT_GAME_CONTEXT };
  }
}

export function saveGameContextLengths(lengths: ContextLengths) {
  localStorage.setItem(contextKey, JSON.stringify(lengths));
}
type Context = NonNullable<TranslateOptions["context"]>;
const reference = (source: string): Context[number] => ({ source, translation: "" });
export function gameTranslationRetry(context: Context | undefined, reason?: string) {
  return reason ? { context: [...context || [], reference(`重译原因：${reason}。只翻译当前给出的正文片段，完整译为目标语言。`)], llmBatch: false } : { context };
}
export const GAME_RESOURCE_LABELS = { character: "角色名", place: "地点名", skill: "技能名", item: "物品或装备名", interface: "游戏界面用语" } as const;
export const isGameDialogue = (source: string, entry?: UnityEntry) => !!entry?.dialoguePosition || gameTextHasSpeaker(source);

function singleSpeaker(text: string) {
  const names = new Set(gameSpeakerNames(text).filter(name => name && !/[\\{}<>]/.test(name)));
  return names.size === 1 ? names.values().next().value : undefined;
}

function visibleReference(text: string, name?: string) {
  return (name ? `${name}：` : "") + text.replace(gameFormatTokens(), "").trim();
}

export type GameDialoguePage = { file: string; event: number; page: number; commands: number[]; lines: string[]; speakers?: Record<number, string> };
export function gameDialogueReuseKey(entry: UnityEntry) {
  const source = entry.source.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  const position = entry.dialoguePosition;
  return position ? JSON.stringify(["dialogue", position.page, position.line, source]) :
    gameTextHasSpeaker(source) ? JSON.stringify(["dialogue", entry.id, source]) : source;
}

export function createGameTranslationContext(entries: UnityEntry[], includeNeighbors: boolean, dialoguePages?: GameDialoguePage[]) {
  const lengths = loadGameContextLengths();
  const previousLimit = lengths.previous ? lengths.previousCount : 0;
  const followingLimit = lengths.following ? lengths.followingCount : 0;
  const positions = includeNeighbors && (previousLimit || followingLimit) ? new Map(entries.map((entry, index) => [entry.id, index])) : undefined;
  return (entry?: UnityEntry, nameContext?: string, originalContext?: string): Context | undefined => {
    if (nameContext) return [reference(nameContext)];
    const context: Context = [];
    const positionInPage = entry?.dialoguePosition;
    const dialogue = positionInPage && dialoguePages?.[positionInPage.page];
    const tagName = entry && singleSpeaker(entry.source);
    if (entry?.rpgTextKind || entry?.rpgSystemMessage) {
      return [reference(entry.rpgTextContext || `文本用途：${entry.rpgTextKind ? GAME_RESOURCE_LABELS[entry.rpgTextKind] : "RPG 系统消息"}。`)];
    }
    if (originalContext) context.push(reference(`当前条目的完整语境：${originalContext}`));
    if (dialogue && positionInPage && dialogue.lines[positionInPage.line] === entry?.source) {
      const line = positionInPage.line;
      const speakerAt = (index: number) => {
        const name = dialogue.speakers?.[index]?.trim();
        return singleSpeaker(dialogue.lines[index] || "") || (name && !/[\\{}<>]/.test(name) ? name : undefined);
      };
      const name = speakerAt(line);
      const previous = includeNeighbors && previousLimit && dialogue.commands[line - 1] !== dialogue.commands[line] ? speakerAt(line - 1) : undefined;
      const following = includeNeighbors && followingLimit && dialogue.commands[line + 1] !== dialogue.commands[line] ? speakerAt(line + 1) : undefined;
      if (name) context.push(reference(`当前说话人：${name}。${previous && previous === following && name !== previous ? `听话人：${previous}。` : ""}保留说话视角和原文指代。`));
      if (!includeNeighbors) return context.length ? context : undefined;
      const label = (index: number, fallback: string) =>
        dialogue.commands[index] === dialogue.commands[line] ? "同组选项：" : fallback;
      for (let i = Math.max(0, line - previousLimit); i < line; i++)
        context.push(reference(label(i, "上文片段：") + Array.from(visibleReference(dialogue.lines[i], speakerAt(i))).slice(-lengths.previous).join("")));
      for (let i = line + 1; i <= line + followingLimit && i < dialogue.lines.length; i++)
        context.push(reference(label(i, "下文片段：") + Array.from(visibleReference(dialogue.lines[i], speakerAt(i))).slice(0, lengths.following).join("")));
      return context.length ? context : undefined;
    }
    if (tagName) context.push(reference(`当前说话人：${tagName}。保留说话视角和原文指代。`));
    const position = entry && positions?.get(entry.id);
    if (entry && position !== undefined && !dialoguePages && entry.objectId && entry.objectId !== "0") {
      const sameResource = (neighbor?: UnityEntry): neighbor is UnityEntry =>
        !!neighbor && neighbor.file === entry.file && neighbor.container === entry.container &&
        neighbor.objectId === entry.objectId && neighbor.locale === entry.locale;
      const previous: Context = [];
      for (let distance = 1; distance <= previousLimit; distance++) {
        const neighbor = entries[position - distance];
        if (!sameResource(neighbor)) break;
        previous.push(reference(`上文片段：${Array.from(neighbor.source).slice(-lengths.previous).join("")}`));
      }
      context.push(...previous.reverse());
      for (let distance = 1; distance <= followingLimit; distance++) {
        const neighbor = entries[position + distance];
        if (!sameResource(neighbor)) break;
        context.push(reference(`下文片段：${Array.from(neighbor.source).slice(0, lengths.following).join("")}`));
      }
    }
    return context.length ? context : undefined;
  };
}
