import type { UnityEntry } from "./unityOffline";

export const UNITY_STEPS = ["扫描资源", "翻译文本", "生成补丁", "应用到游戏"];
const LANGUAGE_LABELS: Record<string, string> = { ja: "日语", ko: "韩语", en: "英语", zh: "中文", ru: "俄语", all: "全部语言" };
export function unityTextLanguage(text: string) {
  const value = text.replace(/<[^>]*>|\{[^{}]*\}|%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?[sdifouxXeEgGc%]/g, "");
  if (/[ぁ-ゖァ-ヺ]/.test(value)) return "ja";
  if (/[가-힣]/.test(value)) return "ko";
  if (/[一-鿿]/.test(value)) return "cjk";
  if (/[А-Яа-яЁё]/.test(value)) return "ru";
  if (/\p{Script=Latin}/u.test(value)) return "en";
  return "und";
}
export function unityLanguageScope(entries: UnityEntry[], source: string) {
  const counts: Record<string, number> = {};
  const languages = entries.map(e => { const language = unityTextLanguage(e.source); counts[language] = (counts[language] || 0) + 1; return language; });
  const dominant = Object.entries(counts).filter(([name]) => name !== "und").sort((a, b) => b[1] - a[1])[0]?.[0] || "und";
  const language = source === "auto" ? dominant === "cjk" ? "zh" : dominant : source;
  const ids = new Set(entries.filter((_, i) => language === "all" || language !== "und" && (languages[i] === language || languages[i] === "cjk" && (language === "ja" || language === "zh"))).map(e => e.id));
  return { language, label: LANGUAGE_LABELS[language] || "未确定", ids, total: entries.length, count: ids.size };
}
export function unityStageState(step: number, completedThrough: number, runningStep?: number) {
  return step === runningStep ? "current" : step <= completedThrough ? "complete" : "pending";
}
