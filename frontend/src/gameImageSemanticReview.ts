import type { Settings } from "./api";
import type { UnityImage, UnityImageRegion } from "./unityOffline";
import { gameTaskPrompt, type GamePromptSelection } from "./gamePrompts";
import type { OllamaOutput } from "./gameOllama";
import { requestGameModelJson } from "./gameModelRequest";

export function needsImageSemanticReview(region: UnityImageRegion, model: string | undefined, target?: string, prompt?: string) {
  if (!model || !region.translation.trim()) return false;
  const previous = region.beforeReview;
  if (previous?.reviewedSource === region.text && previous.reviewedTranslation === region.translation &&
      previous.reviewedTarget === target && previous.reviewedModel === model && previous.reviewedPrompt === prompt) return false;
  return region.confidence < 85 || [...region.text.trim()].length >= 8 ||
    /\d|攻撃|防御|回復|増|減|上昇|下降|禁止|無効|有効|不可|必須|消費|獲得|attack|guard|defen[cs]e|increase|decrease|not\b|damage|\b(?:save|load|cancel|equip|sell|buy|enable|disable|heal|yes|no|on|off)\b/i.test(region.text);
}

export function parseImageSemanticReview(value: unknown, original: string) {
  const row = value as { verdict?: string; translation?: string; reason?: string } | null;
  if (row?.verdict === "accept") return original;
  if (row?.verdict === "correct" && typeof row.translation === "string" && row.translation.trim()) return row.translation.trim();
  if (row?.verdict === "uncertain") throw new Error("译文语义待确认：" + (row.reason || "上下文不足"));
  throw new Error("语义复核模型未返回有效的判断或修正译文");
}

export async function reviewGameImageTranslation(settings: Settings, model: string, image: UnityImage, region: UnityImageRegion,
  target: string, signal: AbortSignal, selection?: GamePromptSelection, report?: OllamaOutput) {
  const prompt = gameTaskPrompt("review", selection, { target }) + "\n核对游戏图片区域的原文与译文，重点检查动作对象、数值、否定、增减方向和遗漏。" +
    "图片文件名和邻近原文仅提供语境，不替换待核对的原文。内容证据不足时返回 uncertain。" +
    '只返回 JSON：{"verdict":"accept|correct|uncertain","translation":"修正后的完整译文","reason":"简短理由"}。' +
    "accept 保留现有译文，correct 必须提供目标语言的完整修正译文，保留占位符。" + JSON.stringify({
      target, file: image.file, source: region.text, translation: region.translation,
      nearbyText: image.regions.filter(other => other !== region).slice(0, 8).map(other => other.text.slice(0, 160)),
    });
  const value = await requestGameModelJson(settings, model, prompt, signal, undefined, "game-images", report,
    { selection, role: "review" });
  return parseImageSemanticReview(value, region.translation);
}
