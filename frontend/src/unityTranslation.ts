import type { Settings, TranslateOptions, TranslateProvider } from "./api";
import { resolveFeatureLlm } from "./modelPresets";

export const UNITY_LANGUAGES = [
  { value: "zh-CN", label: "简体中文" }, { value: "zh-TW", label: "繁体中文" },
  { value: "en", label: "英语" }, { value: "ja", label: "日语" }, { value: "ko", label: "韩语" },
];

/** Fold display wrapping within a paragraph; keep paragraph and program escapes. */
export function prepareUnityTranslationText(text: string, joinLines = true) {
  if (!joinLines) return text;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f]/u;
  return text.replace(/\r\n?/g, "\n").split(/(\n[\t ]*\n(?:[\t ]*\n)*)/).map((part, index) => {
    if (index % 2) return part;
    return part.split("\n").reduce((joined, line) => {
      const left = joined.trimEnd(), right = line.trimStart();
      if (!left || !right) return joined + "\n" + line;
      const separator = cjk.test([...left].at(-1)!) && cjk.test([...right][0]) ? "" : " ";
      return left + separator + right;
    });
  }).join("");
}

export function buildUnityTranslateOptions(
  settings: Pick<Settings, "apiUrl" | "apiKey" | "model">,
  provider: TranslateProvider,
  source: string,
  target: string,
  model = "",
): TranslateOptions {
  if (provider !== "llm") return { provider, source, target, feature: "unity", maxLength: 0, autoChunk: true };
  const connection = resolveFeatureLlm(settings, model);
  if (!connection.apiUrl.trim() || !connection.model.trim()) throw new Error("请先在设置 → 通用中配置所选模型和 API 地址");
  const language = UNITY_LANGUAGES.find(l => l.value === target)?.label || target;
  return {
    provider: "llm", source, target, feature: "unity",
    ...connection,
    prompt: `将游戏界面或对白翻译为${language}。将整条文本作为一个完整的上下文理解，不把排版换行当作句子边界；结合前后文确定主语、指代和语气。仅返回译文，不要解释或代码围栏。保留所有格式占位符、富文本标签、反斜杠转义及段落，不翻译标识符和路径。`,
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
