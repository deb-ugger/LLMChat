import type { Settings, TranslateOptions, TranslateProvider } from "./api";
import { resolveFeatureLlm } from "./modelPresets";
import { prepareUnityStructuredText } from "./unityTextStructure";

export const UNITY_LANGUAGES = [
  { value: "zh-CN", label: "简体中文" }, { value: "zh-TW", label: "繁体中文" },
  { value: "en", label: "英语" }, { value: "ja", label: "日语" }, { value: "ko", label: "韩语" },
];

/** Remove display wrapping before translation; program escapes remain intact. */
export function prepareUnityTranslationText(text: string, joinLines = true) {
  if (!joinLines) return text;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f]/u;
  return text.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean).reduce((joined, line) => {
    if (!joined) return line;
    const separator = cjk.test([...joined].at(-1)!) && cjk.test([...line][0]) ? "" : " ";
    return joined + separator + line;
  }, "").trim();
}

export function prepareUnityTranslationRequest(text: string, joinLines = true) {
  return joinLines ? prepareUnityStructuredText(text, prepareUnityTranslationText) : text;
}

/** Classic engines translate visible text; Unity markup and control tokens never leave this process. */
export async function translateUnityRichText(source: string, translate: (text: string) => Promise<string>) {
  const token = /\{[^{}\r\n]+\}|%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc%]|<\/?[^>\r\n]+>|\\[nrt]/g;
  if (!token.test(source)) return translate(source);
  token.lastIndex = 0;
  const text = async (part: string) => {
    if (!/\p{L}/u.test(part)) return part;
    const leading = part.match(/^\s*/)?.[0] || "", trailing = part.match(/\s*$/)?.[0] || "";
    const result = (await translate(part.trim())).trim();
    if (!result) throw new Error("可见文字的译文为空");
    if (result.match(token)) throw new Error("翻译引擎在可见文字中新增了格式标签或占位符");
    return leading + result + trailing;
  };
  let result = "", offset = 0;
  // Snapshot matches before awaiting translation, so callbacks cannot change regex traversal.
  for (const match of [...source.matchAll(token)]) {
    result += await text(source.slice(offset, match.index)) + match[0]; offset = match.index! + match[0].length;
  }
  return result + await text(source.slice(offset));
}

/** Reflow the full translation to the source layout without splitting tokens. */
export function restoreUnityTranslationLines(source: string, translation: string) {
  if (!/[\r\n]/.test(source)) return translation;
  const layout = source.split(/(\r\n|\r|\n)/);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const units = (text: string) => {
    const result: string[] = []; let offset = 0;
    const append = (part: string) => result.push(...Array.from(segmenter.segment(part), item => item.segment));
    for (const match of text.matchAll(/\{[^{}\r\n]+\}|%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc%]|<\/?[^>\r\n]+>|\\[nrt]/g)) {
      append(text.slice(offset, match.index)); result.push(match[0]); offset = match.index! + match[0].length;
    }
    append(text.slice(offset)); return result;
  };
  const weight = (unit: string) => /^<[^>]+>$/.test(unit) ? 0 : [...unit].length;
  const lines = layout.filter((_, i) => i % 2 === 0);
  const weights = lines.map(line => units(line.trim()).reduce((sum, unit) => sum + weight(unit), 0));
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const translated = units(prepareUnityTranslationText(translation));
  const positions = [0]; for (const unit of translated) positions.push(positions.at(-1)! + weight(unit));
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  let start = 0, consumed = 0, remaining = lines.filter(line => line.trim()).length;
  const restored = layout.map((part, index) => {
    if (index % 2 || !part.trim()) return part;
    consumed += weights[index / 2]; remaining--;
    let end = translated.length;
    if (remaining) {
      const reserve = translated.length - start >= remaining + 1;
      const minimum = start + (reserve ? 1 : 0), maximum = reserve ? translated.length - remaining : start;
      const target = positions.at(-1)! * consumed / total;
      let best = Infinity;
      for (let candidate = minimum; candidate <= maximum; candidate++) {
        const left = translated[candidate - 1] || "", right = translated[candidate] || "";
        const boundary = /\s|[.,!?;:，。！？、；：]/u.test(left) || /^\s/u.test(right) || cjk.test(left) && cjk.test(right);
        const score = Math.abs(positions[candidate] - target) + (boundary ? 0 : Math.max(2, positions.at(-1)! / lines.length * 0.2));
        if (score < best) { best = score; end = candidate; }
      }
    }
    const text = translated.slice(start, end).join("").trim(); start = end;
    return (part.match(/^[\t ]*/)?.[0] || "") + text + (part.match(/[\t ]*$/)?.[0] || "");
  });
  // Drop only empty rows created to fill the source quota, keeping actual paragraph gaps.
  const removed = new Set<number>();
  layout.forEach((part, index) => {
    if (index % 2 === 0 && part.trim() && !restored[index].trim()) {
      removed.add(index);
      if (index + 1 < layout.length) removed.add(index + 1);
      else if (index) removed.add(index - 1);
    }
  });
  return restored.filter((_, index) => !removed.has(index)).join("");
}

export function buildUnityTranslateOptions(
  settings: Pick<Settings, "apiUrl" | "apiKey" | "model">,
  provider: TranslateProvider,
  source: string,
  target: string,
  model = "",
  joinLines = true,
): TranslateOptions {
  if (provider !== "llm") return { provider, source, target, feature: "unity", maxLength: 0, autoChunk: true };
  const connection = resolveFeatureLlm(settings, model);
  if (!connection.apiUrl.trim() || !connection.model.trim()) throw new Error("请先在设置 → 通用中配置所选模型和 API 地址");
  const language = UNITY_LANGUAGES.find(l => l.value === target)?.label || target;
  return {
    provider: "llm", source, target, feature: "unity",
    ...connection,
    prompt: `将游戏界面或对白翻译为${language}。将整条文本作为一个完整的上下文理解，结合前后文确定主语、指代和语气。仅返回译文，不要解释或代码围栏。${joinLines ? "保留段落、列表编号、项目符号及条目顺序，不合并不同条目；段落或条目内部输出连贯译文，显示折行由程序恢复。" : "保留原换行和空行。"}保留所有格式占位符、富文本标签和反斜杠转义，不翻译标识符和路径。`,
  };
}

export function sameUnityGamePath(left: string, right: string) {
  const normalize = (path: string) => {
    let value = path.trim().replace(/\//g, "\\");
    if (value.startsWith("\\\\?\\UNC\\")) value = "\\\\" + value.slice(8);
    else if (value.startsWith("\\\\?\\")) value = value.slice(4);
    return value.replace(/\\+$/, "").toLowerCase();
  };
  return normalize(left) === normalize(right);
}
