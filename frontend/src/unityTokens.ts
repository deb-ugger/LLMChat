// ASCII tag names distinguish Unity markup from visible <对白> and <2日目>.
const pattern = String.raw`\{[^{}\r\n]+\}|%%|(?<![0-9０-９])%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc]|<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t=][^>\r\n]*)?\/?>|<#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?>|\\[nrt]`;

// Mixed-script/repeated symbol runs next to hearts are game glyph codes, not prose.
const glyphPattern = String.raw`[\u0400-\u052f]{2,}[\u19d0-\u19df\u27c0-\u27ef][\u0400-\u05ff\u19d0-\u19df\u27c0-\u27ef]*|([\u0400-\u052f])\1+(?=[\s.!?！？…。、]*[♡♥])`;
export const unityGlyphTokens = () => new RegExp(glyphPattern, "g");
export const unityTranslationTokens = () => new RegExp(`${pattern}|${glyphPattern}`, "g");

export async function translateUnityGlyphs(source: string, translate: (text: string) => Promise<string>) {
  const glyphs: string[] = [];
  const protectedText = source.replace(unityGlyphTokens(), glyph => `{LLMCHAT_GLYPH_${glyphs.push(glyph) - 1}}`);
  let result = await translate(protectedText);
  for (const [index, glyph] of glyphs.entries()) {
    const marker = `{LLMCHAT_GLYPH_${index}}`;
    if (result.split(marker).length !== 2) throw new Error("翻译改动了游戏特殊字形占位符，请重试");
    result = result.replace(marker, glyph);
  }
  return result;
}

export function isTranslationRefusal(source: string, translation: string) {
  const output = translation.normalize("NFKC").trim();
  if (source.normalize("NFKC").trim() === output) return false;
  // Match complete canned responses. An apology by itself is valid dialogue.
  return /^(?:抱歉|很抱歉|对不起|抱歉,[ \t]*但|很抱歉,[ \t]*但)[,\s]*我?(?:无法|不能)(?:为您|为你)?(?:提供(?:相关|该|此|这段|这部分)?(?:的)?翻译(?:内容|结果)?|翻译(?:这段|此|该|上述)?(?:文本|内容|文字|请求))\s*[。.!！]?$/u.test(output)
    || /^(?:sorry|i(?:['’]m| am) sorry)[,.\s]+(?:but\s+)?i\s+(?:can(?:not|['’]t)|am unable to)\s+(?:translate (?:this|that)(?: (?:text|content))?|provide (?:a|the|this) translation)[.!]?$/i.test(output);
}

export const TRANSLATION_REFUSAL = "模型未提供译文。请检查识别文字，或换用其他翻译方式重试。";

export const TRANSLATION_PROMPT_LEAK = "译文混入了参考语境或模型提示，请重译此条";

/** Undefined means plain output. Null means the model returned a template without a usable translation. */
export function readGameTranslationEnvelope(source: string, output: string): string | null | undefined {
  const translationKey = /"translation"\s*:/;
  if (!translationKey.test(output) || translationKey.test(source)) return;
  const trimmed = output.trim();
  const body = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  if (!body.startsWith("{") || !body.endsWith("}")) return;
  let envelope: { translation?: unknown };
  try { envelope = JSON.parse(body); } catch { return; }
  if (!Object.hasOwn(envelope, "translation") ||
      Object.keys(envelope).some(key => key !== "translation" && key !== "original_text" && key !== "translation_instructions")) return;
  const translation = envelope.translation;
  return typeof translation === "string" && translation.trim() ? translation : null;
}

export function hasTranslationPromptLeak(source: string, translation: string) {
  if (!translation || source === translation) return false;
  const original = source.normalize("NFKC");
  const output = translation.normalize("NFKC");
  const markers = /<[ \t]*\/?[ \t]*reference[_ -]context[ \t]*>|"reference_context"[ \t]*:|[〖【](?:背景信息|待翻译文本)[〗】]/gi;
  const count = output.match(markers)?.length ?? 0;
  if (count > 0 && count > (original.match(markers)?.length ?? 0)) return true;
  return ["原文语境(仅参考)", "以下仅为参考上下文,不要翻译或输出此部分", "只输出最后一条用户消息的译文",
    "下列背景仅用于理解原文", "以下背景信息仅用于理解原文", "以下背景仅用于理解原文",
    "Use reference_context as read-only reference"].some(phrase => output.includes(phrase) && !original.includes(phrase));
}

export function unityTranslationProblem(source: string, translation: string) {
  if (!translation.trim()) return "译文为空";
  if (readGameTranslationEnvelope(source, translation) === null) return "模型返回的 JSON 翻译模板中没有有效译文，请重译此条";
  if (hasTranslationPromptLeak(source, translation)) return TRANSLATION_PROMPT_LEAK;
  if (isTranslationRefusal(source, translation)) return TRANSLATION_REFUSAL;
  const sourceGlyphs = source.match(unityGlyphTokens()) || [], targetGlyphs = translation.match(unityGlyphTokens()) || [];
  if (JSON.stringify(sourceGlyphs) !== JSON.stringify(targetGlyphs)) return `游戏特殊字形符号发生变化：应保留「${sourceGlyphs.join("、") || "无"}」，当前为「${targetGlyphs.join("、") || "无"}」`;
  const original = source.match(unityTranslationTokens()) || [];
  const translated = translation.match(unityTranslationTokens()) || [];
  if (JSON.stringify([...original].sort()) !== JSON.stringify([...translated].sort())) {
    const difference = (left: string[], right: string[]) => {
      const remaining = [...right];
      return left.filter(token => { const index = remaining.indexOf(token); if (index < 0) return true; remaining.splice(index, 1); return false; });
    };
    const missing = difference(original, translated), added = difference(translated, original);
    return "占位符、转义或富文本标签发生变化：" + [missing.length ? `缺少 ${missing.map(token => JSON.stringify(token)).join("、")}` : "", added.length ? `新增 ${added.map(token => JSON.stringify(token)).join("、")}` : ""].filter(Boolean).join("；");
  }
  const ordered = (value: string) => value.startsWith("<") || value.startsWith("\\") || value.startsWith("%") && !/^%\d+\$/.test(value);
  return JSON.stringify(original.filter(ordered)) === JSON.stringify(translated.filter(ordered)) ? "" : "富文本标签嵌套、转义或非定位格式参数的顺序发生变化";
}
