import type { UnityEntry, UnityProject, UnityImage } from "./unityOffline";
import { isTranslationRefusal, unityTranslationTokens } from "./unityTokens";
import { gameImageJapaneseTextIssue, gameTextMatchesSource } from "./gameDisplayText";

export const UNITY_STEPS = ["扫描资源", "文本翻译", "生成补丁", "应用到游戏"];
export const UNITY_STAGE_TABS = [
  { step: 1, id: "1", label: "扫描资源", imageOnly: false },
  { step: 2, id: "2.1", label: "文本翻译", imageOnly: false },
  { step: 2, id: "2.2", label: "图片翻译", imageOnly: true },
  { step: 2, id: "2.3", label: "图片去码", imageOnly: false },
  { step: 3, id: "3", label: "生成与应用", imageOnly: false },
] as const;
export const unityImageHasRefusal = (image: UnityImage) => image.renderedKind !== "imported" && image.regions.some(region => region.selected && isTranslationRefusal(region.text, region.translation));
export const unityImageResultReady = (image: UnityImage) => image.completed && !image.error && !image.regions.some(region => region.error) && !!image.renderedFile && !unityImageHasRefusal(image);
export const unityImageHasUntranslatedJapanese = (image: UnityImage, target?: string) => !!image.renderedFile && image.renderedKind !== "imported" &&
  image.regions.some(region => region.selected && gameImageJapaneseTextIssue(region.text, region.translation, target || region.translationTarget || image.renderedTarget));
export const imageTranslationMatchesTarget = (image: UnityImage, target?: string) =>
  !target || !image.renderedTarget || image.renderedTarget === target || image.renderedKind === "imported";
export const unityImageReadyForTarget = (image: UnityImage, target?: string) =>
  unityImageResultReady(image) && imageTranslationMatchesTarget(image, target) && !unityImageHasUntranslatedJapanese(image, target);
export const unityImageWorkDone = (image: UnityImage, target?: string) =>
  unityImageReadyForTarget(image, target) || !!image.noTranslationNeeded && image.completed && !image.error && imageTranslationMatchesTarget(image, target);
export const unityImagesReady = (project: UnityProject | null, target?: string) => !!project && (!!project.imagesSkipped || !(project.images || []).some(i => i.selected) || (project.scanRevision || 0) >= 5 && (project.images || []).filter(i => i.selected).every(image => unityImageWorkDone(image, target)));
export function tagLegacyImageTargets(images: UnityImage[], target: string) {
  for (const image of images) {
    if (image.renderedFile && image.renderedKind !== "imported") image.renderedTarget ??= target;
    for (const region of image.regions) if (region.translation) region.translationTarget ??= target;
  }
}
export function rememberLegacyGameTarget(game: string, lane: "images" | "unity", current: string) {
  const key = `llmchat-legacy-game-target:${lane}:${game}`;
  const saved = localStorage.getItem(key);
  if (saved) return saved;
  localStorage.setItem(key, current);
  return current;
}
export function tagEditedImageTranslations(image: UnityImage, previous: UnityImage, target: string) {
  for (const [index, region] of image.regions.entries()) {
    if (region.translation && region.translation !== previous.regions[index]?.translation &&
        (!region.translationTarget || region.translationTarget === previous.regions[index]?.translationTarget)) region.translationTarget = target;
  }
}
export const UNITY_SCAN_COMPATIBILITY = { current: 12, minimumUsable: 2 };
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
  const value = text.replace(unityTranslationTokens(), "");
  if (/[가-힣]/.test(value)) return "ko";
  if (/[ぁ-ゖァ-ヺ]/.test(value)) return "ja";
  if (/[一-鿿]/.test(value)) return "cjk";
  if (/[А-Яа-яЁё]/.test(value)) return "ru";
  if (/\p{Script=Latin}/u.test(value)) return "en";
  return "und";
}
export function unityLanguageScope(entries: UnityEntry[], source: string, onlySourceLanguage = true) {
  const counts: Record<string, number> = {};
  const languages = entries.map(e => { const language = unityEntryLanguage(e); counts[language] = (counts[language] || 0) + 1; return language; });
  const dominant = Object.entries(counts).filter(([name]) => name !== "und").sort((a, b) => b[1] - a[1])[0]?.[0] || "und";
  const language = source === "auto" ? dominant === "cjk" ? "zh" : dominant : source;
  const explicit = source !== "auto" && source !== "all";
  const ids = new Set(entries.filter((entry, i) => !onlySourceLanguage || language === "all" || language !== "und" && (explicit ? gameTextMatchesSource(entry.source, language, entry.locale) : languages[i] === language || !entry.locale && languages[i] === "cjk" && (language === "ja" || language === "zh"))).map(e => e.id));
  return { language, label: !onlySourceLanguage ? "全部语言" : language === "und" ? "未确定" : unityLanguageLabel(language), ids, total: entries.length, count: ids.size };
}
export function unityStageState(step: number, completedThrough: number, runningStep?: number, failedStep?: number, outdatedStep?: number, optionalStep?: number) {
  return step === failedStep ? "error" : step === runningStep ? "current" : step === outdatedStep ? "outdated" : step === optionalStep ? "optional-update" : step <= completedThrough ? "complete" : step === completedThrough + 1 ? "current" : "pending";
}
