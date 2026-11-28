import type { GameProjectTerm } from "./gameProjectGlossary";
import { currentGameSemanticReview, gameTextSemanticIssues, type GameSemanticEntry, type GameSemanticIssue, type GameSemanticReview } from "./gameTextSemantics";
import { restoreGameBracketStyle } from "./gameTextStructure";

export type GameTextReviewItem = { id: number; entry: GameSemanticEntry; issues: GameSemanticIssue[] };
type Decision = { id: number; verdict: "keep" | "revise" | "uncertain"; reason: string; translation?: string };
type Options = {
  target: string; terms: readonly GameProjectTerm[]; signal: AbortSignal; includeFailures?: boolean;
  request: (items: GameTextReviewItem[]) => Promise<unknown>;
  validate: (source: string, translation: string) => string;
  format?: (source: string, translation: string) => string | Promise<string>;
  persist: (entries: GameSemanticEntry[]) => Promise<void>;
  progress?: (completed: number, total: number, detail: string) => void;
};

const reviewableFailure = /括号|引用|占位符|控制符|未保留|仍含日文|未翻译|正文|译文为空|重译|重复|标记|转义/;

export async function reviewGameText(entries: GameSemanticEntry[], options: Options) {
  const pending = entries.flatMap(entry => {
    if (entry.translationTarget && entry.translationTarget !== options.target) return [];
    const reviewed = currentGameSemanticReview(entry, options.target);
    const issues = gameTextSemanticIssues(entry, options.target, options.terms);
    if ((reviewed?.state === "checked" || reviewed?.state === "changed") && !entry.error && !entry.sceneContextPending && !issues.some(issue => issue.code === "term")) return [];
    if (entry.error && options.includeFailures && reviewableFailure.test(entry.error)) issues.unshift({ code: "invalid", detail: entry.error });
    return issues.length && (entry.translation.trim() || entry.error && options.includeFailures) ? [{ entry, issues }] : [];
  });
  let changed = 0, unresolved = 0, completed = 0;
  const plans: { item: typeof pending[number]; decision?: Decision; failure?: string }[] = [];
  for (let offset = 0; offset < pending.length;) {
    options.signal.throwIfAborted();
    const batch: GameTextReviewItem[] = []; let size = 0;
    while (offset < pending.length && batch.length < 8) {
      const next = pending[offset], length = next.entry.source.length + next.entry.translation.length;
      if (batch.length && size + length > 6000) break;
      batch.push({ ...next, id: batch.length }); size += length; offset++;
    }
    options.progress?.(completed, pending.length, `正在语义复核 ${completed} / ${pending.length} 条`);
    try {
      const raw = await options.request(batch);
      options.signal.throwIfAborted();
      const ids = new Set(batch.map(item => item.id));
      if (!Array.isArray(raw) || raw.length !== batch.length || raw.some(value => !value || !ids.delete(value.id) ||
          !["keep", "revise", "uncertain"].includes(value.verdict) || typeof value.reason !== "string" || !value.reason.trim() ||
          value.verdict === "revise" && (typeof value.translation !== "string" || !value.translation.trim())))
        throw new Error("语义复核模型返回的条目、判定或修订译文无效");
      const decisions = new Map<number, Decision>((raw as Decision[]).map(value => [value.id, value]));
      batch.forEach(item => plans.push({ item, decision: decisions.get(item.id)! }));
    } catch (error) {
      options.signal.throwIfAborted();
      const failure = error instanceof Error ? error.message : String(error);
      batch.forEach(item => plans.push({ item, failure }));
    }
    completed += batch.length;
  }
  completed = 0;
  for (const plan of plans) {
    options.signal.throwIfAborted();
    const { entry, issues } = plan.item, previous = entry.translation;
    let review: GameSemanticReview;
    try {
      if (plan.failure || !plan.decision) throw new Error(plan.failure || "语义复核未返回判定");
      const decision = plan.decision;
      if (decision.verdict === "uncertain") {
        review = { translation: previous, target: options.target, state: "uncertain", reason: decision.reason, issues };
        unresolved++;
      } else {
        if (decision.verdict === "keep" && (entry.error || !previous.trim())) throw new Error("原译文未通过校验，复核模型未提供有效修订");
        let value = decision.verdict === "revise" ? decision.translation!.trim() : previous;
        const problem = options.validate(entry.source, value);
        if (problem) throw new Error("复核译文未通过校验：" + problem);
        value = restoreGameBracketStyle(entry.source, value);
        if (options.format) value = await options.format(entry.source, value);
        const formattedProblem = options.validate(entry.source, value);
        if (formattedProblem) throw new Error(formattedProblem);
        entry.translation = value; entry.translationTarget = options.target; entry.error = ""; entry.sceneContextPending = false;
        const modified = value !== previous;
        review = { translation: value, target: options.target, state: modified ? "changed" : "checked", reason: decision.reason, issues, ...(modified ? { previous } : {}) };
        if (modified) changed++;
      }
    } catch (error) {
      options.signal.throwIfAborted();
      review = { translation: previous, target: options.target, state: "failed", reason: error instanceof Error ? error.message : String(error), issues };
      unresolved++;
    }
    entry.semanticReview = review;
    await options.persist([entry]);
    options.progress?.(++completed, pending.length, `语义复核 ${completed} / ${pending.length} 条，已修订 ${changed} 条，待确认 ${unresolved} 条`);
  }
  return { total: pending.length, changed, unresolved };
}
