// ASCII tag names distinguish Unity markup from visible <对白> and <2日目>.
const pattern = String.raw`\{[^{}\r\n]+\}|%%|(?<![0-9０-９])%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc]|<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t=][^>\r\n]*)?\/?>|<#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?>|\\[nrt]`;

// Mixed-script/repeated symbol runs next to hearts are game glyph codes, not prose.
const glyphPattern = String.raw`[\u0400-\u052f]{2,}[\u19d0-\u19df\u27c0-\u27ef][\u0400-\u05ff\u19d0-\u19df\u27c0-\u27ef]*|([\u0400-\u052f])\1+(?=[\s!?！？…。、]*[♡♥])`;
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

export function unityTranslationProblem(source: string, translation: string) {
  if (!translation.trim()) return "译文为空";
  const sourceGlyphs = source.match(unityGlyphTokens()) || [], targetGlyphs = translation.match(unityGlyphTokens()) || [];
  if (JSON.stringify(sourceGlyphs) !== JSON.stringify(targetGlyphs)) return `游戏特殊字形符号发生变化：应保留「${sourceGlyphs.join("、") || "无"}」，当前为「${targetGlyphs.join("、") || "无"}」`;
  const original = source.match(unityTranslationTokens()) || [];
  const translated = translation.match(unityTranslationTokens()) || [];
  if (JSON.stringify([...original].sort()) !== JSON.stringify([...translated].sort())) return "占位符、转义或富文本标签发生变化";
  const ordered = (value: string) => value.startsWith("<") || value.startsWith("\\") || value.startsWith("%") && !/^%\d+\$/.test(value);
  return JSON.stringify(original.filter(ordered)) === JSON.stringify(translated.filter(ordered)) ? "" : "富文本标签嵌套、转义或非定位格式参数的顺序发生变化";
}
