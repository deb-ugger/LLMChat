import { unityTranslationTokens } from "./unityTokens";
import type { UnityEntry } from "./unityOffline";

const controls = String.raw`\\(?:[A-Za-z]+(?:\[[^\]\r\n]*\]|<[^>\r\n]*>)?|[.!|^><{}$\\])`;
const speaker = String.raw`\\(?:n[1-5]?|nc|nr|name|speaker)<([^>\r\n]*)>`;
const formats = () => new RegExp(`${speaker.replace("([^>", "(?:[^>")}|${controls}|${unityTranslationTokens().source}`, "gi");
export const gameFormatTokens = formats;
const identifiers = /\b(?:[A-Za-z]{1,6}\d+|\d+[A-Za-z]{1,6})\b/g;
function languageText(source: string, names = true) {
  return source.replace(new RegExp(speaker, "gi"), names ? "$1" : "").replace(formats(), "").replace(identifiers, "").trim();
}

/** Explicit source selection requires script evidence or a declared resource locale. */
export function gameTextMatchesSource(source: string, language: string, locale?: string) {
  const selected = language.toLowerCase().replace(/_/g, "-").split("-")[0];
  if (!selected || selected === "auto" || selected === "all") return true;
  if (locale) return locale.toLowerCase().replace(/_/g, "-").split("-")[0] === selected;
  const visible = languageText(source);
  switch (selected) {
    case "ja": return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(visible);
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
    const simplified = /[这们吗么没获请选认开关档读买卖钱为与体罚颤紧缩给既处门会让后从]/u.test(visible);
    const chineseSyntax = /(?:还是|既然|这样|就得|失去意识|一边|另一边|知道是|来了|着呢|的话|太多了|太少了|(?:条件|條件|地点|地點)[：:]|之[后後前]|[你您][的已]|[这這]是)/u.test(visible);
    const hanCount = (visible.match(/\p{Script=Han}/gu) || []).length;
    const latinCount = latin.join("").length;
    // Sentence grammar distinguishes Chinese prose from ambiguous shared-Han names/labels.
    const chineseGrammar = hanCount >= 4 && /(?:[谁誰]|[啊呀哦喔嘛啦呢吧](?=[，。！？、…,.!?~～\s]|$)|真是|[都就才也又][能是有要不]|不知道|不知曉)/u.test(visible);
    const chineseEvidence = chinese || simplified || chineseSyntax || chineseGrammar;
    const chineseWithLoanwords = chineseEvidence && hanCount >= 4 && hanCount >= latinCount * .6;
    if (kana || hangul || foreign || prose && !chineseWithLoanwords || !han || !(chineseEvidence || speakerOnly)) return false;
    // Do not skip obvious script conversion between simplified and traditional output.
    const opposite = target === "zh-TW" ? /[这们吗么没获请选认开关档读买卖钱为与体]/u : /[這們嗎麼沒獲請選認開關檔讀買賣錢為與體]/u;
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
      if (result.structured && (!entry.translation.trim() || entry.translation === result.template)) {
        entry.translation = ""; entry.screeningDraft = result.template;
      } else if (!result.structured) delete entry.screeningDraft;
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
    if (!/\p{L}/u.test(value) || bodyKept || skipTarget && gameTextNeedsNoTranslation(value, target)) keep(start, end);
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
export async function translateGameDisplayText(source: string, translate: (text: string, originalContext?: string) => Promise<string>, target = "", sourceLanguage = "auto", terms: ReadonlyMap<string, string> = new Map()) {
  const tokens: string[] = [];
  const protect = (value: string) => `{LLMCHAT_FORMAT_${tokens.push(value) - 1}}`;
  if (!gameTextMatchesSource(source, sourceLanguage)) return source;
  if (target && gameTextNeedsNoTranslation(source, target)) return source;
  // A Chinese body with a Japanese speaker only needs the speaker translated.
  // Protect target-language runs verbatim, including their original whitespace.
  const speakers = new RegExp(speaker, "gi");
  let offset = 0, prepared = "";
  for (const match of source.matchAll(speakers)) {
    const body = source.slice(offset, match.index);
    prepared += target && gameTextNeedsNoTranslation(body, target) ? protect(body) : body;
    prepared += match[0]; offset = match.index! + match[0].length;
  }
  const remaining = source.slice(offset);
  prepared += target && gameTextNeedsNoTranslation(remaining, target) ? protect(remaining) : remaining;
  const text = prepared.replace(formats(), (token: string) => {
    if (/^\{LLMCHAT_FORMAT_\d+\}$/.test(token)) return token;
    const name = new RegExp(`^${speaker}$`, "i").exec(token)?.[1];
    if (name !== undefined) {
      if (/[\\{}]/.test(name)) return protect(token);
      const canonical = terms.get(name);
      if (canonical !== undefined) return protect(token.slice(0, token.indexOf("<") + 1) + canonical + ">");
      if (target.startsWith("zh") && /\p{Script=Han}/u.test(name) && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Latin}]/u.test(name)) return protect(token);
      return protect(token.slice(0, token.indexOf("<") + 1)) + name + protect(">");
    }
    return protect(token);
  });
  const screenedText = text.split(/(\{LLMCHAT_FORMAT_\d+\})/).map(part => /^\{LLMCHAT_FORMAT_\d+\}$/.test(part) || !target || !gameTextNeedsNoTranslation(part, target) ? part : protect(part)).join("");
  const escape = (value: string) => [...value].map(char => ".*+?^${}()|[]\\".includes(char) ? "\\" + char : char).join("");
  const replacements = [...terms].filter(([from, to]) => from !== to).sort((a, b) => b[0].length - a[0].length);
  const termPattern = replacements.length ? new RegExp(replacements.map(([from]) => escape(from)).join("|"), "gu") : null;
  const protectedText = termPattern ? screenedText.split(/(\{LLMCHAT_FORMAT_\d+\})/).map(part => /^\{LLMCHAT_FORMAT_\d+\}$/.test(part) ? part : part.replace(termPattern, (term: string, offset: number, input: string) => {
    if (/^[A-Za-z0-9_]/.test(term) && offset > 0 && /[A-Za-z0-9_]/.test(input[offset - 1]) || /[A-Za-z0-9_]$/.test(term) && /[A-Za-z0-9_]/.test(input[offset + term.length] || "")) return term;
    return protect(terms.get(term)!);
  })).join("") : screenedText;
  const visibleText = protectedText.replace(/\{LLMCHAT_FORMAT_\d+\}/g, "");
  let result = /\p{L}/u.test(visibleText) ? await translate(protectedText, tokens.length ? source : undefined) : protectedText;
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    const marker = `{LLMCHAT_FORMAT_${index}}`;
    if (result.split(marker).length !== 2) throw new Error(`翻译结果未保留格式控制符 ${token}（保护标记 ${marker} 缺失或重复）。此条译文未保存。请重试此条，或在译文中保留原控制符及参数后手动填写。`);
    result = result.replace(marker, token);
  }
  const problem = gameDisplayTextProblem(source, result);
  if (problem) throw new Error(problem);
  return result;
}

export function gameControlSignature(text: string) {
  return JSON.stringify([...text.matchAll(new RegExp(`${speaker}|${controls}`, "gi"))].map(match => match[1] === undefined ? match[0] : match[0].replace(/<[^>]*>$/, "<>")));
}
export function withoutGameSpeakerNames(text: string) {
  return text.replace(new RegExp(speaker, "gi"), token => token.replace(/<[^>]*>$/, "<>"));
}
