import type { MosaicScoreCounts } from "./mosaicScoreCounts";
import { mosaicWallClock, type MosaicScoreFreeze } from "./mosaicScoreInputs";

export type MosaicScoreStage = "mosaicScreen" | "mosaicRefine";
type ScoreInput = MosaicScoreCounts & {
  status: string; runFailures: number; elapsedMs: number; freeze?: MosaicScoreFreeze; timing?: string; issues: readonly string[];
};
export type MosaicMetric = {
  label: string; weight: number; numerator: number; denominator: number; ratio: number | null; missing?: string;
};
export type MosaicRankingDetail = {
  key: "freeze" | "timing" | "items" | "samples" | "complete" | "coverage" | "health" | "status";
  label: string;
  current: string;
  required: string;
  action: string;
};
const displayCoverage = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;
const fraction = (n: number, d: number) => d > 0 ? n / d : null;
const roundScore = (value: number) => Math.round(value * 10 + 1e-9) / 10;
export const mosaicScoreTitle = (stage: MosaicScoreStage) => stage === "mosaicScreen" ? "初筛候选保留分" : "复筛综合分";

export function scoreMosaicRun(stage: MosaicScoreStage, row: ScoreInput) {
  const healthy = row.status === "完成" && !row.runFailures && !row.issues.length &&
    row.samples > 0 && row.validRuns === row.samples && !row.invalid;
  const hasWallClock = row.timing === mosaicWallClock;
  const speed = healthy && hasWallClock && Number.isFinite(row.elapsedMs) && row.elapsedMs > 0
    ? row.elapsedMs / (10 * row.validRuns) : null;
  const failedImages = Math.max(row.runFailures, row.failed);
  const speedUnavailableReason = speed !== null ? undefined : row.issues[0] ||
    (failedImages > 0 ? "有 " + failedImages + " 张图片处理失败" : !healthy ? "本轮未完整成功" :
      row.timing === "segment-only" ? "仅有续跑段计时" : row.timing === "reused-output" ? "复用归档输出" :
        !hasWallClock ? "缺完整计时标记" : "用时无效");
  const labelled = row.evaluatedPositive + row.evaluatedNegative;
  const definite = row.tp + row.tn + row.fp + row.fn;
  const delivery = fraction(row.foundBoxes, row.expectedBoxes);
  const boxCoverage = fraction(row.evaluatedBoxes, row.expectedBoxes);
  const positiveCoverage = fraction(row.tp + row.fn, row.confirmedPositive);
  const negativeCoverage = fraction(row.tn + row.fp, row.confirmedNegative);
  const items: MosaicMetric[] = [];
  const metric = (label: string, weight: number, numerator: number, denominator: number, reason?: string) => {
    const ratio = fraction(numerator, denominator);
    items.push({ label, weight, numerator, denominator, ratio, missing: ratio === null ? reason : undefined });
  };
  if (stage === "mosaicScreen") {
    metric("有码候选保留", 85, row.evaluatedPositive - row.fn, row.evaluatedPositive, "缺可评的已确认有码图");
    metric("无码下游减负", 15, row.tn, row.evaluatedNegative, "缺可评的已确认无码图");
  } else {
    metric("少漏图", 35, row.evaluatedPositive - row.fn, row.evaluatedPositive, "缺可评的已确认有码图");
    metric("少误报", 12, row.evaluatedNegative - row.fp, row.evaluatedNegative, "缺可评的已确认无码图");
    metric("少漏框", 30, row.foundBoxes, row.evaluatedBoxes, row.expectedBoxes ? "已标框图片没有明确有效判定" : "缺人工框");
    metric("少多框", 8, row.completeMatchedBoxes, row.completePredictedBoxes,
      row.completeEvaluatedImages ? "完整标注子集没有自动输出框" : "缺可评的完整标注");
    metric("少人工复核", 12, labelled - row.review, labelled, "缺可评的已确认标注");
    metric("速度", 3, speed === null ? 0 : Math.min(100, speed), speed ?? 0, speedUnavailableReason);
  }
  const effectiveWeight = items.reduce((sum, item) => sum + (item.ratio === null ? 0 : item.weight), 0);
  const score = effectiveWeight && (stage === "mosaicScreen" || definite)
    ? 100 * items.reduce((sum, item) => sum + item.weight * (item.ratio ?? 0), 0) / effectiveWeight : null;
  const rankingReasons = [...row.issues];
  if (!healthy) rankingReasons.push("轮次未健康完成");
  if (!row.freeze) rankingReasons.push("缺冻结样本或标注版本");
  if (!hasWallClock) rankingReasons.push("缺完整可比计时协议");
  if (effectiveWeight < 100) rankingReasons.push("评分缺项");
  if (score === null) rankingReasons.push(stage === "mosaicRefine" ? "没有已标注明确判定" : "没有可评的已确认标注");
  const sampleShortage = row.confirmedPositive < 60 || row.confirmedNegative < 60;
  const boxShortage = row.annotatedImages < 30 || row.expectedBoxes < 60;
  const completeShortage = row.completePositiveImages < 30;
  const lowCoverage = (positiveCoverage ?? 0) < .9 || (negativeCoverage ?? 0) < .9 || (boxCoverage ?? 0) < .9;
  if (sampleShortage) rankingReasons.push("已确认有码、无码各需至少 60 张不同原图");
  if (stage === "mosaicRefine") {
    if (boxShortage) rankingReasons.push("至少 30 张有码图有框且人工框至少 60 个");
    if (completeShortage) rankingReasons.push("至少 30 张有码图完整标框");
    if (lowCoverage) rankingReasons.push("正负类明确判定率和可评框覆盖均需达到 90%");
  }
  const details: MosaicRankingDetail[] = [];
  if (!row.freeze) details.push({ key: "freeze", label: "冻结样本", current: "未绑定",
    required: "绑定冻结样本与标注版本", action: "选择样本集后跑一轮新测试" });
  if (!hasWallClock) details.push({ key: "timing", label: "计时协议",
    current: row.timing === "segment-only" ? "仅记录续跑段" : row.timing === "reused-output" ? "复用了归档输出" : "无完整计时记录",
    required: "整轮墙钟计时", action: "从头跑一轮新测试" });
  if (effectiveWeight < 100 || score === null) {
    const missing = [...new Set(items.flatMap(item => item.missing ? [item.missing] : []))];
    details.push({ key: "items", label: "评分缺项", current: effectiveWeight < 100
      ? `${effectiveWeight}/100（缺 ${100 - effectiveWeight} 分）` : "缺已标注明确判定",
    required: stage === "mosaicScreen" ? "两项均可评分" : "六项均可评分，且有已标注明确判定",
    action: missing.length ? `提供可评分数据（${missing.join("，")}）` : "取得已标注样本的明确判定" });
  }
  if (sampleShortage) {
    const missing = [row.confirmedPositive < 60 ? `${60 - row.confirmedPositive} 张有码原图` : "",
      row.confirmedNegative < 60 ? `${60 - row.confirmedNegative} 张无码原图` : ""].filter(Boolean);
    details.push({ key: "samples", label: "样本规模", current: `有码 ${row.confirmedPositive} 张，无码 ${row.confirmedNegative} 张`,
      required: "有码、无码各 ≥60 张不同原图", action: `人工确认至少 ${missing.join("和")}` });
  }
  if (stage === "mosaicRefine" && (boxShortage || completeShortage)) details.push({
    key: "complete", label: "完整标注", current: `${row.completePositiveImages} 张完整标框，${row.annotatedImages} 张有框，共 ${row.expectedBoxes} 框`,
    required: "至少 30 张有码图完整标框，人工框至少 60 个",
    action: [completeShortage ? `把 ${30 - row.completePositiveImages} 张有码图标完并确认` : "",
      row.expectedBoxes < 60 ? `标出 ${60 - row.expectedBoxes} 个缺少的人工框` : ""].filter(Boolean).join("，"),
  });
  if (stage === "mosaicRefine" && lowCoverage) {
    const missing = [positiveCoverage, negativeCoverage, boxCoverage].flatMap((value, index) =>
      (value ?? 0) < .9 ? [["有码", "无码", "人工框"][index]] : []);
    details.push({ key: "coverage", label: "判定覆盖",
      current: `有码 ${displayCoverage(positiveCoverage)}，无码 ${displayCoverage(negativeCoverage)}，框 ${displayCoverage(boxCoverage)}`,
      required: "有码、无码明确判定率和可评框覆盖均 ≥90%",
      action: negativeCoverage === null ? "人工确认无码样本并取得明确判定" : `为${missing.join("、")}取得更多明确有效结果` });
  }
  if (!healthy) details.push({ key: "health", label: "轮次健康",
    current: [`${row.validRuns}/${row.samples} 张有有效结果`, row.missing ? `缺行 ${row.missing} 张` : "",
      row.invalid ? `异常 ${row.invalid} 条` : "", ...row.issues.map(issue => issue.replaceAll("·", "，"))].filter(Boolean).join("，"),
    required: "全部计划样本均有有效结果且归档完整", action: "修复无效或缺失的结果后重新完成测试" });
  const anomaly = [row.status !== "完成" && !(row.status === "失败" && failedImages) ? row.status : "", failedImages > 0 ? `失败 ${failedImages} 次` : "",
    row.skipped > 0 ? `跳过 ${row.skipped} 张` : ""].filter(Boolean);
  if (anomaly.length) details.push({ key: "status", label: "运行状态", current: anomaly.join("，"),
    required: "完成且无失败、跳过", action: "处理失败或跳过原因后重新执行" });
  const group = row.freeze ? JSON.stringify([stage, row.freeze.version, row.freeze.inputs, row.freeze.truth, row.timing]) : null;
  return {
    stage, items, score, displayScore: score === null ? null : roundScore(score), effectiveWeight,
    provisional: effectiveWeight < 100 || !row.freeze, eligible: !rankingReasons.length, rankingReasons, details, group,
    delivery, boxCoverage, positiveCoverage, negativeCoverage, speed, speedUnavailableReason,
    missRate: fraction(row.fn, row.evaluatedPositive),
    reviewRate: fraction(row.review, labelled),
    negativeRetainedRate: fraction(row.fp + row.reviewNegative, row.evaluatedNegative),
  };
}

export type MosaicRunScore = ReturnType<typeof scoreMosaicRun>;

export function compareMosaicScores(a: MosaicRunScore, b: MosaicRunScore) {
  const primary = (b.displayScore ?? -1) - (a.displayScore ?? -1);
  const misses = (a.missRate ?? 1) - (b.missRate ?? 1);
  const boxes = (b.delivery ?? 0) - (a.delivery ?? 0);
  if (misses || boxes || primary) return misses || boxes || primary;
  if (a.stage === "mosaicScreen") return (a.negativeRetainedRate ?? 1) - (b.negativeRetainedRate ?? 1);
  return (a.reviewRate ?? 1) - (b.reviewRate ?? 1) ||
    (a.speed ?? Number.MAX_VALUE) - (b.speed ?? Number.MAX_VALUE);
}

export function bestMosaicRuns(rows: readonly { runId: string; configId: string; score: MosaicRunScore }[]) {
  type Row = typeof rows[number];
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const { eligible, group } = row.score;
    if (!eligible || group === null) continue;
    const groupRows = groups.get(group) ?? [];
    groupRows.push(row);
    groups.set(group, groupRows);
  }
  const best = new Set<string>();
  for (const group of groups.values()) {
    if (new Set(group.map(row => row.configId)).size < 2) continue;
    group.sort((a, b) => compareMosaicScores(a.score, b.score));
    for (const row of group) {
      if (compareMosaicScores(row.score, group[0].score) !== 0) break;
      best.add(row.runId);
    }
  }
  return best;
}
