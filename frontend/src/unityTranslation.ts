import type { Settings, TranslateOptions, TranslateProvider } from "./api";
import { resolveFeatureLlm } from "./modelPresets";

export const UNITY_LANGUAGES = [
  { value: "zh-CN", label: "简体中文" }, { value: "zh-TW", label: "繁体中文" },
  { value: "en", label: "英语" }, { value: "ja", label: "日语" }, { value: "ko", label: "韩语" },
];

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
    prompt: `将游戏界面或对白翻译为${language}。仅返回译文，不要解释或代码围栏。保留所有格式占位符、富文本标签、反斜杠转义、换行及其数量，不翻译标识符和路径。`,
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
