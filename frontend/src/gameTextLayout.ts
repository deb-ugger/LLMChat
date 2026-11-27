import { gameFormatTokens } from "./gameDisplayText";
import { formatUnityStructure, unityListBlocks } from "./unityTextStructure";
import { smartUnityLines } from "./unityLineLayout";
export type GameWrapMode = "join" | "keep" | "natural";
export const GAME_NATURAL_LINE_PROMPT = "翻译时一并决定换行，不另行输出排版说明。根据当前原文可见文字的长度、各行长短和换行结构，自行估计适合的行长，不要求外部提供文本框宽度或固定字数。原文只有一行时译文保持一行，尤其是名称、按钮和简短系统提示；不要仅因译文比原文长就拆行。原文本来有多行时，在原文行长的参考范围内按完整语义安排段内换行，不机械按字符数切断，也不强凑原文行数。保留原有段落空行、列表边界、分页符和显式换行控制符，不合并不同段落或列表条目。不拆开词语、姓名、数值与单位、成对引用和短属性说明。动态占位符的实际显示长度未知，不把它们算成零宽，也不把保护标记的英文字符长度当作显示字数；控制符、占位符及参数必须完整保留。";

/** Reflow within the source paragraph/list structure without imposing its width as a hard limit. */
export function wrapGameTextToSource(source:string,translation:string){
  const tokens: string[] = [], markers = new Map<string, string>();
  const protect = (text: string) => text.replace(gameFormatTokens(), token => {
    let marker = markers.get(token);
    if (!marker) { marker = `{LLMCHAT_LINE_${tokens.length}}`; tokens.push(token); markers.set(token, marker); }
    return marker;
  });
  const result = formatUnityStructure(protect(source), protect(translation), (original, translated) =>
    /[\r\n]/.test(original) ? smartUnityLines(original, translated) :
      (original.match(/^[\t \u3000]*/)?.[0] || "") + translated + (original.match(/[\t \u3000]*$/)?.[0] || ""));
  return result.replace(/\{LLMCHAT_LINE_(\d+)\}/g, (_, index: string) => tokens[Number(index)]);
}
export function validateGameNaturalLines(source:string,translation:string){
  if (!/[\r\n]/.test(source.trim()) && /[\r\n]/.test(translation.trim()))
    throw new Error("原文为单行文本，译文也应保持单行，请重试此条");
  unityListBlocks(source,translation);
  // Normalize before counting: a single CRLF must never backtrack into two line breaks.
  const count=(text:string)=>text.replace(/\r\n?/g, "\n").replace(gameFormatTokens(), "").trim().split(/\n[\t \u3000]*\n/).filter(part=>part.trim()).length;
  const originalCount = count(source), translatedCount = count(translation);
  if(originalCount!==translatedCount)throw new Error(`模型改变了正文段落数量（原文 ${originalCount} 段，译文 ${translatedCount} 段），请保留空行分段后重试；译文草稿已保留`);
  return translation;
}
