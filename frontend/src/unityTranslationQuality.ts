import { unityTranslationTokens } from "./unityTokens";

/** Advisory checks only: names, sound effects and context can be intentional. */
export function unityTranslationQuality(source: string, translation: string, target: string): string[] {
  if (!translation.trim()) return [];
  const visible = (text: string) => text.replace(unityTranslationTokens(), "").normalize("NFKC").trim();
  const original = visible(source), translated = visible(translation);
  const language = target.toLowerCase().split("-")[0];
  const issues: string[] = [];
  if (language !== "ja" && /[ぁ-ゖァ-ヺ]/.test(translated.replace(/[っッー]/g, ""))) issues.push("译文仍含日文，请检查是否漏译或混入原文");
  if (language !== "ko" && /[가-힣]/.test(translated)) issues.push("译文仍含韩文，请检查是否漏译或混入原文");
  const untranslatedSource = language !== "ja" && /[ぁ-ゖァ-ヺ]/.test(original)
    || language !== "ko" && /[가-힣]/.test(original)
    || language !== "en" && /[a-zA-Z]{3,}\s+[a-zA-Z]{3,}/.test(original);
  if (untranslatedSource && original.replace(/\s+/g, " ") === translated.replace(/\s+/g, " ")) issues.push("译文与原文相同，请确认是否需要翻译");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(translation)) issues.push("译文包含替换字符或异常控制字符");
  const sourceLength = [...original.replace(/\s/g, "")].length;
  const targetLength = [...translated.replace(/\s/g, "")].length;
  if (sourceLength >= 80 && targetLength < sourceLength * .15) issues.push("译文明显偏短，请检查是否遗漏整句或段落");
  return issues;
}
