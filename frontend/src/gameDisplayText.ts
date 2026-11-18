import { unityTranslationTokens, unityTranslationProblem } from "./unityTokens";
import type { UnityEntry } from "./unityOffline";

const controls = String.raw`\\(?:[A-Za-z]+(?:\[[^\]\r\n]*\]|<[^>\r\n]*>)?|[.!|^><{}$\\])`;
const speaker = String.raw`\\(?:n[1-5]?|nc|nr|name|speaker)<([^>\r\n]*)>`;
const rpgArguments = String.raw`%[1-9]\d*(?![\d$])`;
const rpgConditions = String.raw`(?:if|en)\([^)\r\n]+\)`;
const termPatterns = new WeakMap<ReadonlyMap<string, string>, RegExp | null>();
const formats = () => new RegExp(`${speaker.replace("([^>", "(?:[^>")}|${controls}|${rpgConditions}|${unityTranslationTokens().source}|${rpgArguments}`, "gi");
export const gameFormatTokens = formats;
export const gameSpeakerNames = (text: string) => [...text.matchAll(new RegExp(speaker, "gi"))].map(match => match[1].trim());
const identifiers = /\b(?:[A-Za-z]{1,6}\d+|\d+[A-Za-z]{1,6})\b/g;
const japaneseOnlyHan = /[撃戦闘剣仮変黒発録経闇髪楽続読売覚気顔対価]/u;
const japaneseKana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
function languageText(source: string, names = true) {
  return source.replace(new RegExp(speaker, "gi"), names ? "$1" : "").replace(formats(), "").replace(identifiers, "").trim();
}

export function hasGameJapaneseText(source: string) {
  const visible = languageText(source);
  return japaneseKana.test(visible) || japaneseOnlyHan.test(visible);
}

export function gameJapaneseTextIssue(source: string, translation: string, target: string) {
  if (!translation.trim() || !target.startsWith("zh") || !hasGameJapaneseText(source)) return "";
  const visible = languageText(translation).replace(/[っッー]/g, "");
  return japaneseKana.test(visible) || japaneseOnlyHan.test(visible) ? "译文仍含日文，请检查正文和说话人姓名" : "";
}

export function gameImageJapaneseTextIssue(source: string, translation: string, target?: string) {
  if (!target || !gameJapaneseTextIssue(source, translation, target)) return "";
  return source.normalize("NFKC").trim() === translation.normalize("NFKC").trim()
    ? "模型原样返回了日文，请重译此区域" : "译文仍含日文，请重译此区域";
}

const rpgSystemTranslations = new Map<string, [string, string]>([
  ["Recovery", ["%1は%2を%3回復した！", "%1恢复了%3点%2！"]],
  ["Loss", ["%1は%2を%3失った！", "%1失去了%3点%2！"]],
  ["Drain", ["%1は%2を%3消費した！", "%1被吸取了%3点%2！"]],
  ["Gain", ["%1は%2を%3獲得した！", "%1获得了%3点%2！"]],
  ["obtainExp", ["%1を%2受け取った！", "获得了%1点%2！"]],
  ["criticalToEnemy", ["会心の一撃！！", "暴击！！"]],
  ["criticalToActor", ["痛恨の一撃！！", "遭到暴击！！"]],
]);

export function translateRpgSystemMessage(entry: Pick<UnityEntry, "source" | "rpgSystemMessage"> | undefined, target: string) {
  if (!entry?.rpgSystemMessage || target !== "zh-CN") return undefined;
  const template = rpgSystemTranslations.get(entry.rpgSystemMessage.replace(/^(actor|enemy)(?=[A-Z])/, ""));
  if (!template || entry.source.trim().normalize("NFKC") !== template[0].normalize("NFKC")) return undefined;
  return entry.source.replace(/\S[\s\S]*\S|\S/, () => template[1]);
}

/** Explicit source selection requires script evidence or a declared resource locale. */
export function gameTextMatchesSource(source: string, language: string, locale?: string) {
  const selected = language.toLowerCase().replace(/_/g, "-").split("-")[0];
  if (!selected || selected === "auto" || selected === "all") return true;
  if (locale) return locale.toLowerCase().replace(/_/g, "-").split("-")[0] === selected;
  const visible = languageText(source);
  switch (selected) {
    case "ja": return japaneseKana.test(visible) || japaneseOnlyHan.test(visible);
    case "ko": return /\p{Script=Hangul}/u.test(visible);
    case "zh": return /\p{Script=Han}/u.test(visible) && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(visible);
    case "en": return /\p{Script=Latin}/u.test(visible);
    case "ru": return /\p{Script=Cyrillic}/u.test(visible);
    default: return false;
  }
}

/** Only positive language evidence can skip a request; shared Han words remain ambiguous. */
export function gameTextNeedsNoTranslation(source: string, target: string) {
  const visible = languageText(source);
  const body = languageText(source, false);
  if (!source.trim()) return false;
  if (!/\p{L}/u.test(visible)) return true;
  const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(visible);
  const hangul = /\p{Script=Hangul}/u.test(visible);
  const han = /\p{Script=Han}/u.test(visible);
  const foreign = /[\p{Script=Cyrillic}\p{Script=Arabic}]/u.test(visible);
  const latin = visible.match(/[A-Za-z]+/g) || [];
  const prose = latin.some(word => !/^(?:HP|MP|TP|EXP|LV|NPC|BGM|SE|ON|OFF|OK)$/i.test(word));
  const chinese = /(?:你[们們的好]|我[们們的]|[这這][个個里裡些]|[那哪][个個里裡]|[吗嗎么麼]|什么|什麼|已经|已經|没有|沒有|[获獲]得了|到手了|收到了|完成了|要不要|是否|请[选選按稍]|請[選按稍]|正在|保存成功|不行|不要|注意|[发發][现現]|[继繼][续續]|的[话話]|无法|無法|[呜嗚]|好[热熱]|怎[么麼]|[请請]等)/u.test(visible);
  if (target.startsWith("zh")) {
    const speakerOnly = !/\p{L}/u.test(body) && new RegExp(speaker, "i").test(source);
    const simplified = /[这们吗么没获请选认开关档读买卖钱为与体罚颤紧缩给既处门会让后从图]/u.test(visible);
    const chineseSyntax = /(?:还是|既然|这样|就得|失去意识|一边|另一边|知道是|来了|着呢|的话|太多了|太少了|(?:条件|條件|地点|地點)[：:]|之[后後前]|[你您][的已]|[这這]是)/u.test(visible);
    const hanCount = (visible.match(/\p{Script=Han}/gu) || []).length;
    const latinCount = latin.join("").length;
    // Sentence grammar distinguishes Chinese prose from ambiguous shared-Han names/labels.
    const chineseGrammar = hanCount >= 4 && /(?:[谁誰]|[啊呀哦喔嘛啦呢吧](?=[，。！？、…,.!?~～\s]|$)|真是|[都就才也又][能是有要不]|不知道|不知曉)/u.test(visible);
    const chineseEvidence = chinese || simplified || chineseSyntax || chineseGrammar;
    const chineseWithLoanwords = chineseEvidence && hanCount >= 4 && hanCount >= latinCount * .6;
    if (kana || japaneseOnlyHan.test(visible) || hangul || foreign || prose && !chineseWithLoanwords || !han || !(chineseEvidence || speakerOnly)) return false;
    // Do not skip obvious script conversion between simplified and traditional output.
    const opposite = target === "zh-TW" ? /[这们吗么没获请选认开关档读买卖钱为与体图]/u : /[這們嗎麼沒獲請選認開關檔讀買賣錢為與體圖]/u;
    return !opposite.test(visible);
  }
  if (target === "ja") return kana && !hangul && !foreign && !prose && !chinese;
  if (target === "ko") return hangul && !kana && !han && !foreign && !prose;
  if (target === "en" && !kana && !hangul && !han && !foreign) {
    const words = new Set(latin.map(word => word.toLowerCase()));
    const evidence = ["the", "you", "your", "are", "is", "with", "this", "that", "please", "would", "have"].filter(word => words.has(word)).length;
    return evidence >= 2 || /\b(?:new game|save game|load game|please wait|game over)\b/i.test(visible);
  }
  return false;
}

export function rpgTextControlProblem(source: string, translation: string) {
  const signature = (value: string) => JSON.stringify([...value.matchAll(formats())]
    .map(match => match[0])
    .filter(token => /^%[1-9]\d*$/.test(token) || /^(?:if|en)\(/i.test(token)).sort());
  return signature(source) === signature(translation) ? "" : "RPG 参数或选项条件发生变化";
}

export function gameDisplayTextProblem(source: string, translated: string) {
  const body = (text: string) => text.replace(formats(), "");
  const originalNames = [...source.matchAll(new RegExp(speaker, "gi"))];
  const translatedNames = [...translated.matchAll(new RegExp(speaker, "gi"))];
  if (originalNames.some((match, index) => /\p{L}/u.test(match[1]) && translatedNames[index] && !translatedNames[index][1].trim())) return "说话人姓名尚未填写";
  return /\p{L}/u.test(body(source)) && !/\p{L}/u.test(body(translated)) ? "译文缺少正文，仅剩控制符或说话人，请重试此条" : "";
}

export function preserveTargetGameText(entries: UnityEntry[], target: string, sourceLanguage = "auto", skipTarget = true) {
  let count = 0;
  for (const entry of entries) {
    const outsideSource = !gameTextMatchesSource(entry.source, sourceLanguage, entry.locale);
    const alreadyTarget = skipTarget && gameTextNeedsNoTranslation(entry.source, target);
    if ((alreadyTarget || outsideSource && (!entry.translation || !!entry.error)) && (entry.translation !== entry.source || entry.error || entry.layoutDraft)) {
      entry.translation = entry.source; entry.error = ""; delete entry.layoutDraft; delete entry.screeningDraft; count++;
    } else {
      const result = gameTextScreeningResult(entry.source, target, sourceLanguage, skipTarget, entry.locale);
      if (!result.unchanged && result.structured && (!entry.translation.trim() || entry.translation === result.template)) {
        entry.translation = ""; entry.screeningDraft = result.template;
      } else if (result.unchanged || !result.structured) delete entry.screeningDraft;
    }
  }
  return count;
}

export function gameTextHasSpeaker(source: string) { return new RegExp(speaker, "i").test(source); }

export function gameTextScreeningResult(source: string, target: string, sourceLanguage = "auto", skipTarget = true, locale?: string) {
  const outsideSource = !gameTextMatchesSource(source, sourceLanguage, locale);
  const unchanged = outsideSource || skipTarget && gameTextNeedsNoTranslation(source, target);
  const structured = gameTextHasSpeaker(source) || /\\(?:px|py|fn|fs|c|i|v|n)(?:\[|<)/i.test(source);
  const retained: { start: number; end: number }[] = [];
  const keep = (start: number, end: number) => {
    if (end <= start) return;
    const last = retained.at(-1);
    if (last && last.end === start) last.end = end; else retained.push({ start, end });
  };
  if (!structured) return { source, unchanged, structured, retained, template: "" };
  if (unchanged) return { source, unchanged, structured, retained: source ? [{ start: 0, end: source.length }] : [], template: source };
  const body = source.replace(new RegExp(speaker, "gi"), "");
  const bodyKept = skipTarget && gameTextNeedsNoTranslation(body, target);
  const text = (start: number, end: number) => {
    const value = source.slice(start, end);
    if (!gameTextMatchesSource(value, sourceLanguage) || !/\p{L}/u.test(value) || bodyKept || skipTarget && gameTextNeedsNoTranslation(value, target)) keep(start, end);
  };
  let offset = 0;
  for (const match of source.matchAll(formats())) {
    const start = match.index!, end = start + match[0].length;
    text(offset, start);
    const name = new RegExp(`^${speaker}$`, "i").exec(match[0])?.[1];
    if (name === undefined || /[\\{}]/.test(name) || !/\p{L}/u.test(name) || skipTarget && gameTextNeedsNoTranslation(`\\nc<${name}>`, target)) keep(start, end);
    else { const nameStart = start + match[0].indexOf("<") + 1; keep(start, nameStart); keep(end - 1, end); }
    offset = end;
  }
  text(offset, source.length);
  // Preserve line breaks, indentation, code-unit offsets and full-width character spacing.
  const blank = (part: string) => [...part].map(char => /\s/u.test(char) ? char : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char) ? "　" : " ".repeat(char.length)).join("");
  let template = ""; offset = 0;
  for (const span of retained) { template += blank(source.slice(offset, span.start)) + source.slice(span.start, span.end); offset = span.end; }
  template += blank(source.slice(offset));
  return { source, unchanged, structured, retained, template };
}

/** Keep the whole body and speaker together instead of translating tag-separated fragments. */
export async function translateGameDisplayText(source: string, translate: (text: string, originalContext?: string, retryReason?: string) => Promise<string>, target = "", sourceLanguage = "auto", terms: ReadonlyMap<string, string> = new Map(), skipTarget = true, preserveDialogueLines = false) {
  const tokens: string[] = [];
  const protect = (value: string) => `{LLMCHAT_FORMAT_${tokens.push(value) - 1}}`;
  const keepTarget = !!target && skipTarget;
  if (!gameTextMatchesSource(source, sourceLanguage)) return source;
  if (keepTarget && gameTextNeedsNoTranslation(source, target)) return source;
  // A Chinese body with a Japanese speaker only needs the speaker translated.
  // Protect target-language runs verbatim, including their original whitespace.
  const speakers = new RegExp(speaker, "gi");
  let offset = 0, prepared = "";
  for (const match of source.matchAll(speakers)) {
    const body = source.slice(offset, match.index);
    prepared += !gameTextMatchesSource(body, sourceLanguage) || keepTarget && gameTextNeedsNoTranslation(body, target) ? protect(body) : body;
    prepared += match[0]; offset = match.index! + match[0].length;
  }
  const remaining = source.slice(offset);
  prepared += !gameTextMatchesSource(remaining, sourceLanguage) || keepTarget && gameTextNeedsNoTranslation(remaining, target) ? protect(remaining) : remaining;
  const pattern = formats();
  const structure = preserveDialogueLines ? new RegExp(pattern.source + String.raw`|[\t \u3000]*(?:\r\n|\r|\n)[\t \u3000]*`, pattern.flags) : pattern;
  const text = prepared.replace(structure, (token: string) => {
    if (/^\{LLMCHAT_FORMAT_\d+\}$/.test(token)) return token;
    const name = new RegExp(`^${speaker}$`, "i").exec(token)?.[1];
    if (name !== undefined) {
      if (/[\\{}]/.test(name)) return protect(token);
      const canonical = terms.get(name.trim());
      if (canonical !== undefined) return protect(token.slice(0, token.indexOf("<") + 1) + canonical + ">");
      if (keepTarget && target.startsWith("zh") && gameTextNeedsNoTranslation(token, target)) return protect(token);
      return protect(token.slice(0, token.indexOf("<") + 1)) + name + protect(">");
    }
    return protect(token);
  });
  const screenedText = text.split(/(\{LLMCHAT_FORMAT_\d+\})/).map(part => /^\{LLMCHAT_FORMAT_\d+\}$/.test(part) || !keepTarget || !gameTextNeedsNoTranslation(part, target) ? part : protect(part)).join("");
  let termPattern = termPatterns.get(terms);
  if (termPattern === undefined) {
    const escaped = [...terms].filter(([from, to]) => from !== to).map(([from]) => from)
      .sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    termPattern = escaped.length ? new RegExp(escaped.join("|"), "gu") : null;
    termPatterns.set(terms, termPattern);
  }
  const appliedTerms = new Map<string, string>();
  const protectedText = termPattern ? screenedText.split(/(\{LLMCHAT_FORMAT_\d+\})/).map(part => /^\{LLMCHAT_FORMAT_\d+\}$/.test(part) ? part : part.replace(termPattern, (term: string, offset: number, input: string) => {
    if (/^[A-Za-z0-9_]/.test(term) && offset > 0 && /[A-Za-z0-9_]/.test(input[offset - 1]) || /[A-Za-z0-9_]$/.test(term) && /[A-Za-z0-9_]/.test(input[offset + term.length] || "")) return term;
    if (/^\p{Script=Han}$/u.test(term) && part.trim() !== term) return term;
    const translation = terms.get(term)!;
    appliedTerms.set(term, translation);
    return protect(translation);
  })).join("") : screenedText;
  const visibleText = protectedText.replace(/\{LLMCHAT_FORMAT_\d+\}/g, "");
  // Deterministic edge controls and retained names never need model output.
  const prefix = protectedText.match(/^(?:\s|\{LLMCHAT_FORMAT_\d+\})*/)?.[0] || "";
  const rest = protectedText.slice(prefix.length);
  const suffix = rest.match(/(?:\s|\{LLMCHAT_FORMAT_\d+\})*$/)?.[0] || "";
  const body = rest.slice(0, rest.length - suffix.length);
  const referenceText = source.replace(new RegExp(speaker, "gi"), "（说话人：$1）").replace(formats(), "");
  let result = protectedText;
  let retryReason = "";
  if (/\p{L}/u.test(visibleText)) {
    try { result = prefix + await translate(body, referenceText.trim() !== body.trim() ? referenceText : undefined) + suffix; }
    catch (error) {
      if (!/token repeat limit reached|模型重复生成/.test(error instanceof Error ? error.message : String(error))) throw error;
      retryReason = "模型输出发生重复";
    }
  }
  // Specialized translation models can drop opaque markers. Retry visible spans
  // without asking the model to recreate controls, names or retained target text.
  const markerPattern = /\{LLMCHAT_FORMAT_\d+\}/g;
  const expectedMarkers = protectedText.match(markerPattern) || [];
  const restoreMarkers = (value: string) => {
    for (let index = tokens.length - 1; index >= 0; index--) value = value.replace(`{LLMCHAT_FORMAT_${index}}`, () => tokens[index]);
    return value;
  };
  const qualityProblem = (value: string) => {
    const residue = gameJapaneseTextIssue(source, value, target);
    if (residue) return residue;
    if (preserveDialogueLines && JSON.stringify(value.match(/\r\n|\r|\n/g)) !== JSON.stringify(source.match(/\r\n|\r|\n/g))) return "译文改变了对白的换行或空行";
    const duplicated = [...appliedTerms].find(([from, to]) => to.length >= 2 && source.includes(from) &&
      !source.includes(from + from) && !source.includes(to + to) && value.includes(to + to));
    return duplicated ? `译文重复了术语「${duplicated[1]}」` : "";
  };
  const problemWith = (value: string) => unityTranslationProblem(withoutGameSpeakerNames(source), withoutGameSpeakerNames(value)) ||
    gameDisplayTextProblem(source, value) || rpgTextControlProblem(source, value) || qualityProblem(value);
  retryReason ||= JSON.stringify(result.match(markerPattern) || []) !== JSON.stringify(expectedMarkers) ?
    "译文中的格式标记丢失、重复或顺序错误" : problemWith(restoreMarkers(result));
  if (retryReason) {
    const pieces = protectedText.split(/(\{LLMCHAT_FORMAT_\d+\})/);
    const translatedPieces: string[] = [];
    const retriedSpans = new Map<string, string>();
    for (const piece of pieces) {
      if (/^\{LLMCHAT_FORMAT_\d+\}$/.test(piece) || !/\p{L}/u.test(piece)) { translatedPieces.push(piece); continue; }
      const leading = piece.match(/^\s*/)?.[0] || "";
      const trailing = piece.match(/\s*$/)?.[0] || "";
      const input = piece.trim();
      let translated = retriedSpans.get(input);
      if (translated === undefined) { translated = (await translate(input, referenceText.trim() !== input ? referenceText : undefined, retryReason)).trim(); retriedSpans.set(input, translated); }
      if (!translated || /\{LLMCHAT_FORMAT_\d+\}/.test(translated)) throw new Error("正文重译未返回有效内容，请检查模型与提示词；此条译文未保存");
      translatedPieces.push(leading + translated + trailing);
    }
    result = translatedPieces.join("");
  }
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    const marker = `{LLMCHAT_FORMAT_${index}}`;
    if (result.split(marker).length !== 2) throw new Error(`翻译结果未保留格式控制符 ${token}（保护标记 ${marker} 缺失或重复）。此条译文未保存。请重试此条，或在译文中保留原控制符及参数后手动填写。`);
    result = result.replace(marker, () => token);
  }
  const problem = problemWith(result);
  if (problem) throw new Error(problem);
  return result;
}

export function gameControlSignature(text: string) {
  return JSON.stringify([...text.matchAll(new RegExp(`${speaker}|${controls}`, "gi"))].map(match => match[1] === undefined ? match[0] : match[0].replace(/<[^>]*>$/, "<>")));
}
export function withoutGameSpeakerNames(text: string) {
  return text.replace(new RegExp(speaker, "gi"), token => token.replace(/<[^>]*>$/, "<>"));
}
