import type { GlossaryEntry, TransEntry } from "./textTranslate";

export type TextProtection = { mode: "smart" | "custom" | "off"; rules: string[] };
export type TextCheckOptions = { sourceLang?: string; targetLang?: string; format?: string; protection?: TextProtection };
export const textIssueLabels = { structure: "结构错误", request: "请求失败", term: "术语未落实", untranslated: "疑似未翻译", language: "外文残留", punctuation: "标点结构", lines: "行数变化" };
export type TextIssueKind = keyof typeof textIssueLabels;

const commonTokens = String.raw`\{[^{}\r\n]+\}|%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc%]|<\/?[A-Za-z][^>\r\n]*>|\{\\[^}\r\n]+\}|\\[nrt]`;
const gameTokens = String.raw`\\[A-Za-z]+(?:\[[^\]\r\n]*\])?|\[(?:\/?(?:color|size|font|b|i|u)|ruby)[^\]\r\n]*\]`;
export const textProtectionPresets: Record<string, string[]> = {
  "RPGMaker 控制符": [commonTokens, gameTokens],
  "Ren’Py 变量与标签": [commonTokens, String.raw`\[[A-Za-z_][\w.]*\]|\{[^{}\r\n]+\}`],
  "ASS 格式与转义": [commonTokens, String.raw`\\[Nnh]|\{\\[^}\r\n]+\}`],
};

export function protectionRegex(format = "plain", settings?: TextProtection) {
  const mode = settings?.mode ?? "smart";
  const rules = mode === "custom" ? settings?.rules.filter(rule => rule.trim()) || [] : mode === "smart" ? [commonTokens, ...(["json", "ass"].includes(format) ? [gameTokens] : [])] : [];
  let expression: RegExp;
  try { expression = new RegExp([...rules.map(rule => `(?:${rule})`), String.raw`\r\n|\n|\r|\t`].join("|"), "gu"); }
  catch (cause) { throw new Error(`文本保护规则无效：${cause instanceof Error ? cause.message : String(cause)}`); }
  if (expression.test("")) throw new Error("文本保护规则不能匹配空文本");
  return expression;
}

export function protectText(source: string, format = "plain", settings?: TextProtection, namespace = 0) {
  const regex = protectionRegex(format, settings), fragments: string[] = [];
  let nonce = namespace;
  while (source.includes(`⟦LC${nonce}_`)) nonce++;
  const prefix = `⟦LC${nonce}_`;
  const text = source.replace(regex, part => { if (!part.length) throw new Error("文本保护规则不能匹配空文本"); return `${prefix}${fragments.push(part) - 1}⟧`; });
  const remaining = text.replace(new RegExp(`⟦LC${nonce}_\\d+⟧`, "g"), "");
  return { text, fragments, onlyProtected: !/[\p{L}\p{N}]/u.test(remaining), restore(translated: string) {
    for (let i = 0; i < fragments.length; i++) {
      if (translated.split(`${prefix}${i}⟧`).length !== 2) throw new Error(`保护片段丢失或重复：${fragments[i]}`);
    }
    const restored = translated.replace(new RegExp(`⟦LC${nonce}_(\\d+)⟧`, "g"), (_, index: string) => {
      if (!(Number(index) in fragments)) throw new Error(`未知保护片段：${index}`);
      return fragments[Number(index)];
    });
    for (const marker of restored.match(/⟦LC\d+_\d+⟧/g) || []) if (!source.includes(marker)) throw new Error(`未知保护片段：${marker}`);
    return restored;
  } };
}

export function termMatches(text: string, term: GlossaryEntry, field: "src" | "dst" = "src") {
  return term.caseSensitive === false ? text.toLocaleLowerCase().includes(term[field].toLocaleLowerCase()) : text.includes(term[field]);
}

export function textWarnings(source: string, translation: string, glossary: GlossaryEntry[], options: TextCheckOptions) {
  const warnings: string[] = [];
  const missing = glossary.filter(term => term.enabled !== false && term.src && term.dst && termMatches(source, term) && !termMatches(translation, term, "dst"));
  if (missing.length) warnings.push(`术语未落实：${missing.map(term => `${term.src} → ${term.dst}`).join("；")}`);
  if (source.trim() === translation.trim() && /\p{L}/u.test(source) && options.sourceLang !== options.targetLang) warnings.push("疑似未翻译：译文与原文相同");
  const target = options.targetLang || "";
  const sourceLang = options.sourceLang || "";
  if (/^zh/.test(target) && (/^ja/.test(sourceLang) || sourceLang === "auto") && /[\u3041-\u3096\u30a1-\u30fa]/.test(translation)) warnings.push("外文残留：译文包含日文假名");
  if (/^zh/.test(target) && /^(?:en|auto)/.test(sourceLang) && /\b[A-Za-z]{2,}(?:[ \t]+[A-Za-z]{2,}){2,}\b/.test(translation)) warnings.push("外文残留：译文包含连续英文词语");
  if (/^(?:en|fr|de|es|it|pt)/.test(target) && /^(?:zh|ja|ko)/.test(sourceLang) && /[\u3400-\u9fff\u3041-\u30fa\uac00-\ud7af]/.test(translation)) warnings.push("外文残留：译文包含原文语言字符");
  const pairs = [["（", "）"], ["(", ")"], ["「", "」"], ["『", "』"], ["“", "”"]];
  const count = (value: string, char: string) => value.split(char).length - 1;
  if (pairs.some(([left, right]) => count(source, left) === count(source, right) && count(translation, left) !== count(translation, right))) warnings.push("标点结构：成对标点不完整");
  if (source.split(/\r\n|\r|\n/).length !== translation.split(/\r\n|\r|\n/).length) warnings.push("行数变化：原文与译文行数不同");
  return warnings.join("\n");
}

export function matchesTextIssue(entry: TransEntry, kind: TextIssueKind | "all") {
  if (kind === "all") return entry.status === "error" || !!entry.warning;
  const structural = !!entry.error && /保护|占位|标签|顺序|条数|编号|译文为空|批量译文|格式/.test(entry.error);
  if (kind === "structure") return structural;
  if (kind === "request") return !!entry.error && !structural;
  return !!entry.warning?.includes(textIssueLabels[kind]);
}

export function contextSections(entries: TransEntry[], ranges?: { original: string; ranges: { start: number; end: number }[] }) {
  let section = 0;
  return entries.map((entry, index) => {
    const start = ranges?.ranges[entry.metaIndex ?? -1]?.start;
    const prefix = start === undefined ? "" : ranges!.original.slice(ranges!.original.lastIndexOf("\n", start - 1) + 1, start);
    if (index && (entry.documentPath !== entries[index - 1].documentPath || /^\s*#{1,6}\s/.test(prefix) || /^(?:#{1,6}\s|第.{1,20}[章节幕]|chapter\s+\w+\b)/i.test(entry.src.trim()))) section++;
    return section;
  });
}

export function textContext(entries: TransEntry[], index: number, before: number, after: number, sections: number[], current: (id: string) => TransEntry | undefined) {
  const result: { source: string; translation: string }[] = [];
  for (let i = Math.max(0, index - before); i <= Math.min(entries.length - 1, index + after); i++) {
    if (i === index || sections[i] !== sections[index]) continue;
    const entry = current(entries[i].id) || entries[i];
    result.push({ source: entry.src, translation: entry.status === "done" && !entry.error ? entry.dst : "" });
  }
  if (entries[index].context) result.push({ source: entries[index].context!, translation: "" });
  return result;
}

/** Exact newline segments only; never guess translated character proportions. */
export function mtoolParents(entries: TransEntry[]) {
  const parents = new Map<string, { parentId: string; segment: number }>();
  const bySource = new Map(entries.filter(entry => !entry.translateSeparately).map(entry => [entry.src, entry.id]));
  for (const entry of entries) {
    if (entry.translateSeparately || !entry.src.includes("\n")) continue;
    const segments = entry.src.split("\n");
    if (segments.some(segment => !segment.trim()) || new Set(segments).size !== segments.length) continue;
    segments.forEach((segment, index) => {
      const id = bySource.get(segment);
      if (id && id !== entry.id && !parents.has(id)) parents.set(id, { parentId: entry.id, segment: index });
    });
  }
  return parents;
}
