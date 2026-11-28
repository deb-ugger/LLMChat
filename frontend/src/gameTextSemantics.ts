import type { UnityEntry } from "./unityOffline";
import type { GameProjectTerm } from "./gameProjectGlossary";
import { gameFormatTokens } from "./gameDisplayText";

export type GameSemanticIssue = { code: string; detail: string };
export type GameSemanticReview = { translation: string; target: string; state: "checked" | "changed" | "uncertain" | "failed"; reason: string; previous?: string; issues: GameSemanticIssue[] };
export type GameSemanticEntry = UnityEntry & {
  dialoguePositions?: { page: number; line: number }[];
  semanticReview?: GameSemanticReview;
  sceneContextPending?: boolean;
  rpgTerm?: boolean;
};

export function currentGameSemanticReview(entry: GameSemanticEntry, target: string) {
  return entry.semanticReview?.translation === entry.translation && entry.semanticReview.target === target ? entry.semanticReview : undefined;
}

export function gameTextSemanticIssues(entry: GameSemanticEntry, target: string, terms: readonly GameProjectTerm[] = []): GameSemanticIssue[] {
  if (!entry.translation.trim()) return entry.sceneContextPending ? [{ code: "scene", detail: "此原文出现在不同场景，需要结合当前场景确认译法" }] : [];
  const source = entry.source.replace(gameFormatTokens(), ""), text = entry.translation.replace(gameFormatTokens(), "");
  const issues: GameSemanticIssue[] = [];
  for (const term of terms) {
    if (term.target === target && (entry.source.trim() === term.src || term.src.length >= 2 && entry.source.includes(term.src)) && !entry.translation.includes(term.dst))
      issues.push({ code: "term", detail: `正式词表要求「${term.src}」使用「${term.dst}」` });
  }
  if (entry.sceneContextPending) issues.push({ code: "scene", detail: "此原文出现在不同场景，需要结合当前场景确认译法" });
  if (!target.startsWith("zh")) return issues;
  if (/\\(?:P|N)\[\d+\][他她它我你您]/i.test(entry.translation)) issues.push({ code: "subject", detail: "人物姓名参数后又补了代词，可能重复主语或猜错性别" });
  if (/こちら/.test(source) && /我|你/.test(text) && !/私|僕|俺|わたし|あなた|君|お前/.test(source)) issues.push({ code: "perspective", detail: "原文指“这边”，译文新增了明确的第一或第二人称，请核对叙述视角" });
  const numbers = (value: string) => (value.normalize("NFKC").match(/[+-]?\d+(?:\.\d+)?%?/g) || []).sort();
  if (JSON.stringify(numbers(source)) !== JSON.stringify(numbers(text))) issues.push({ code: "numbers", detail: "正文中的数字、正负号或百分比与原文不同，需要核对数量和参数含义" });
  if (/(?:できない|できません|禁止|無効|必要ない|ならない)/.test(source) && !/不|没|无|禁|免|别/.test(text)) issues.push({ code: "negative", detail: "原文含否定或限制条件，译文可能遗漏了否定关系" });
  const repetition = /([\p{Script=Han}]{5,20})\1/u.exec(text);
  if (repetition && !source.includes(repetition[1] + repetition[1])) issues.push({ code: "repetition", detail: "译文有原文没有的连续重复片段" });
  if (source.length >= 15 && text.length > Math.max(80, source.length * 2.5)) issues.push({ code: "expansion", detail: "译文明显偏长，需要核对是否重复表达或添加解释" });
  return issues;
}

export function outstandingGameSemanticIssues(entry: GameSemanticEntry, target: string, terms: readonly GameProjectTerm[] = []) {
  const review = currentGameSemanticReview(entry, target);
  if (review?.state === "checked" || review?.state === "changed") return gameTextSemanticIssues(entry, target, terms).filter(issue => issue.code === "term" || issue.code === "scene");
  return review?.issues.length ? review.issues : gameTextSemanticIssues(entry, target, terms);
}
