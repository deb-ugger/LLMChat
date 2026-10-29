import type { UnityEntry, UnityProject } from "./unityOffline";

export const UNITY_STEPS = ["扫描资源", "翻译文本", "生成补丁", "应用到游戏"];
export const UNITY_STAGE_TABS = [
  { step: 1, number: "1", label: "扫描资源", imageOnly: false },
  { step: 2, number: "2.1", label: "翻译文本", imageOnly: false },
  { step: 2, number: "2.2", label: "图片识别与翻译", imageOnly: true },
  { step: 3, number: "3", label: "生成补丁", imageOnly: false },
  { step: 4, number: "4", label: "应用到游戏", imageOnly: false },
] as const;
export const unityImagesReady = (project: UnityProject | null) => !!project && (!!project.imagesSkipped || (project.scanRevision || 0) >= 5 && (project.images || []).filter(i => i.selected).every(i => i.completed));
export const UNITY_SCAN_COMPATIBILITY = { current: 5, minimumUsable: 2 };
type ScanOptions = { includeCode: boolean; textMode?: "lines" | "paragraphs" | "smart"; typeDirectory?: string; codeAssemblies?: string[] | null };
export function unityScanOptionChanges(saved: ScanOptions, current: ScanOptions) {
  const reasons: string[] = [];
  const mode = (value?: string) => value === "smart" ? "智能分段" : value === "lines" ? "按行" : "按段落";
  if ((saved.textMode || "paragraphs") !== current.textMode) reasons.push(`文本分段：${mode(saved.textMode)} → ${mode(current.textMode)}`);
  if (saved.includeCode !== current.includeCode) reasons.push(`代码字面量扫描：${saved.includeCode ? "开启" : "关闭"} → ${current.includeCode ? "开启" : "关闭"}`);
  if ((saved.typeDirectory || "") !== (current.typeDirectory || "")) reasons.push(`类型定义目录：${saved.typeDirectory || "自动读取游戏 Managed"} → ${current.typeDirectory || "自动读取游戏 Managed"}`);
  if (current.includeCode) {
    const assemblies = (values?: string[] | null) => values == null ? null : [...new Set(values.map(value => value.toLowerCase()))].sort();
    if (JSON.stringify(assemblies(saved.codeAssemblies)) !== JSON.stringify(assemblies(current.codeAssemblies))) {
      const describe = (values?: string[] | null) => values == null ? "自动选择可写程序集" : values.length ? values.join("、") : "未选择程序集";
      reasons.push(`代码程序集范围：${describe(saved.codeAssemblies)} → ${describe(current.codeAssemblies)}`);
    }
  }
  return reasons;
}
export function unityScanUpdate(project: UnityProject | null, saved: (ScanOptions & { projectFolder: string; step?: number; progress?: { state: string } }) | null, current: ScanOptions) {
  const reasons: string[] = [];
  let level: "none" | "optional" | "required" = "none";
  if (!project) return { label: "", level, reasons };
  const revision = project.scanRevision || 0;
  const { current: latest, minimumUsable } = UNITY_SCAN_COMPATIBILITY;
  if (revision < minimumUsable || revision > latest) {
    level = "required";
    reasons.push(`扫描格式不兼容：${revision ? `工程第 ${revision} 版` : "工程未记录版本"}，当前支持第 ${minimumUsable}–${latest} 版，需重新扫描`);
  } else if (revision < latest) {
    level = "optional";
    reasons.push(`扫描规则有更新：工程第 ${revision} 版 → 当前第 ${latest} 版；现有扫描格式仍受支持`);
  }
  if (saved?.projectFolder === project.folder) {
    if (revision !== latest && saved.step === 1 && saved.progress?.state !== "done") {
      level = "required";
      reasons.push("未完成的扫描使用旧版检查点，不能跨扫描规则版本续扫，需按当前规则重新扫描");
    }
    const optionStart = reasons.length;
    reasons.push(...unityScanOptionChanges({ ...saved, textMode: saved.textMode || project.textMode }, current));
    if (reasons.length > optionStart) level = "required";
  }
  return { label: level === "required" ? "需更新" : level === "optional" ? "可选更新" : "", level, reasons };
}
const LANGUAGE_LABELS: Record<string, string> = { ja: "日语", ko: "韩语", en: "英语", zh: "中文", ru: "俄语", fr: "法语", de: "德语", es: "西班牙语", it: "意大利语", pt: "葡萄牙语", all: "全部语言" };
export const unityLanguageLabel = (language: string) => LANGUAGE_LABELS[language] || language;
export const unityEntryLanguage = (entry: UnityEntry) => entry.locale?.trim().toLowerCase().replace(/_/g, "-").split("-")[0] || unityTextLanguage(entry.source);
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
  const languages = entries.map(e => { const language = unityEntryLanguage(e); counts[language] = (counts[language] || 0) + 1; return language; });
  const dominant = Object.entries(counts).filter(([name]) => name !== "und").sort((a, b) => b[1] - a[1])[0]?.[0] || "und";
  const language = source === "auto" ? dominant === "cjk" ? "zh" : dominant : source;
  const ids = new Set(entries.filter((entry, i) => language === "all" || language !== "und" && (languages[i] === language || !entry.locale && languages[i] === "cjk" && (language === "ja" || language === "zh"))).map(e => e.id));
  return { language, label: language === "und" ? "未确定" : unityLanguageLabel(language), ids, total: entries.length, count: ids.size };
}
export function unityStageState(step: number, completedThrough: number, runningStep?: number, failedStep?: number, outdatedStep?: number, optionalStep?: number) {
  return step === failedStep ? "error" : step === runningStep ? "current" : step === outdatedStep ? "outdated" : step === optionalStep ? "optional-update" : step <= completedThrough ? "complete" : "pending";
}
