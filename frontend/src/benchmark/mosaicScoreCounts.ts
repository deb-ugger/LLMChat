import type { MosaicBox } from "../gameMosaic";
import { isMosaicClearCategory, mosaicStatusLabels as status } from "../gameMosaicStatus";
import type { ImageBenchmarkInput, ImageBenchmarkOutcome } from "./imageBenchmarkHistory";
import { mosaicBoxCoverage, orderedMosaicBoxes, type MosaicTruth } from "./mosaicScoreInputs";

function matchesAtHalfIoU(left: MosaicBox, right: MosaicBox) {
  const overlap = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0])) *
    Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]));
  const area = (left[2] - left[0]) * (left[3] - left[1]) + (right[2] - right[0]) * (right[3] - right[1]);
  return overlap > 0 && overlap * 3 >= area;
}

/** Each augmenting path can reassign earlier pairs, maximizing the number of matches. */
export function countMosaicBoxMatches(expected: readonly MosaicBox[], predicted: readonly MosaicBox[]) {
  // Identical output boxes count as extra predictions but share one matching slot.
  const unique = [...new Map(predicted.map(box => [box.join(","), box])).values()];
  const edges = expected.map(box => unique.flatMap((other, index) => matchesAtHalfIoU(box, other) ? [index] : []));
  const owner = new Int32Array(unique.length).fill(-1);
  const visited = new Uint32Array(unique.length);
  function augment(left: number, visit: number): boolean {
    for (const right of edges[left]) {
      if (visited[right] === visit) continue;
      visited[right] = visit;
      if (owner[right] === -1 || augment(owner[right], visit)) {
        owner[right] = left;
        return true;
      }
    }
    return false;
  }
  return edges.reduce((total, _, left) => total + Number(augment(left, left + 1)), 0);
}

type Outcome = ImageBenchmarkOutcome & { sampleId?: string; sourceHash?: string };
type Verdict = "positive" | "negative" | "review" | "failed" | "skipped" | "pending" | "missing" | "invalid";
const validBox = (box: unknown, sample: ImageBenchmarkInput): box is MosaicBox =>
  Array.isArray(box) && box.length === 4 && box.every(Number.isInteger) &&
  box[0] >= 0 && box[1] >= 0 && box[2] > box[0] && box[3] > box[1] && box[2] <= sample.width && box[3] <= sample.height;

function classify(sample: ImageBenchmarkInput, result?: Outcome): { verdict: Verdict; reason?: string } {
  if (!result) return { verdict: "missing", reason: "缺少逐图结果" };
  if ((result.sampleId !== undefined && result.sampleId !== sample.id) ||
      (result.sourceHash !== undefined && result.sourceHash !== sample.sourceHash))
    return { verdict: "invalid", reason: "结果的样本身份或原图哈希不一致" };
  if (result.status === "失败" || result.category === status.failed) return { verdict: "failed", reason: result.reason || "处理失败" };
  if (result.status === "跳过") return { verdict: "skipped", reason: result.reason || "已跳过" };
  if (result.status !== undefined && result.status !== "完成") return { verdict: "invalid", reason: "未知运行状态" };
  if (result.category === status.pending) return { verdict: "pending", reason: "待筛选" };
  if (result.boxes !== undefined && (!Array.isArray(result.boxes) || !result.boxes.every(box => validBox(box, sample))))
    return { verdict: "invalid", reason: "输出框无效或越界" };
  if (result.category === status.review) return { verdict: "review" };
  if (isMosaicClearCategory(result.category))
    return result.boxes?.length ? { verdict: "invalid", reason: "负判含输出框" } : { verdict: "negative" };
  if (result.category === status.candidate || result.category === status.refinedCandidate)
    return result.boxes?.length && result.checked !== false ? { verdict: "positive" } : { verdict: "invalid", reason: "正判缺少可交付的有效框" };
  return { verdict: "invalid", reason: "未知结果分类" };
}

export function countMosaicResults(samples: readonly ImageBenchmarkInput[], results: Readonly<Record<string, Outcome>>,
  lookup?: (sample: ImageBenchmarkInput) => MosaicTruth | null) {
  const counts = {
    samples: samples.length, originals: 0, validRuns: 0, confirmedPositive: 0, confirmedNegative: 0,
    evaluatedPositive: 0, evaluatedNegative: 0, annotatedImages: 0, completePositiveImages: 0, completeEvaluatedImages: 0,
    tp: 0, fp: 0, tn: 0, fn: 0, review: 0, reviewPositive: 0, reviewNegative: 0, fullyCoveredPositiveImages: 0,
    failed: 0, skipped: 0, pending: 0, missing: 0, invalid: 0, unlabelled: 0, unlabelledPositive: 0, unlabelledReview: 0,
    expectedBoxes: 0, evaluatedBoxes: 0, foundBoxes: 0, completeMatchedBoxes: 0, completePredictedBoxes: 0, extraBoxes: 0,
    reasons: Object.create(null) as Record<string, number>,
  };
  const reason = (key: string) => { counts.reasons[key] = (counts.reasons[key] ?? 0) + 1; };
  const originals = new Map<string, string>(), ids = new Set<string>();
  for (const [index, sample] of samples.entries()) {
    const truth = sample.mosaicTruth === undefined ? lookup?.(sample) : sample.mosaicTruth;
    const known = truth?.state === "present" || truth?.state === "none";
    const positive = truth?.state === "present";
    const expected = positive ? truth.boxes ?? [] : [];
    const full = !!truth && mosaicBoxCoverage(truth) === "complete" && (positive ? expected.length > 0 : truth.state === "none");
    const signature = JSON.stringify([sample.width, sample.height, sample.category, sample.checked, orderedMosaicBoxes(sample.boxes),
      truth?.state, orderedMosaicBoxes(truth?.boxes), full]);
    const original = originals.get(sample.sourceHash);
    const collision = ids.has(sample.id) || (original !== undefined && original !== signature);
    ids.add(sample.id);
    const result = Object.hasOwn(results, index) ? results[index] : undefined;
    const outcome = collision ? { verdict: "invalid" as const, reason: "样本身份重复或原图标注/种子冲突" } : classify(sample, result);
    const { verdict } = outcome;
    const valid = verdict === "positive" || verdict === "negative" || verdict === "review";
    if (valid) counts.validRuns++;
    else { counts[verdict]++; if (outcome.reason) reason(outcome.reason); }
    if (original !== undefined) continue;
    originals.set(sample.sourceHash, signature);
    counts.originals++;
    if (!known) {
      counts.unlabelled++;
      if (verdict === "positive") counts.unlabelledPositive++;
      if (verdict === "review") counts.unlabelledReview++;
      continue;
    }
    if (positive) {
      counts.confirmedPositive++;
      counts.expectedBoxes += expected.length;
      if (expected.length) counts.annotatedImages++;
      if (full) counts.completePositiveImages++;
    } else counts.confirmedNegative++;
    if (!valid) continue;
    if (positive) counts.evaluatedPositive++; else counts.evaluatedNegative++;
    if (verdict === "review") {
      counts.review++;
      if (positive) counts.reviewPositive++; else counts.reviewNegative++;
      continue;
    }
    if (positive) { if (verdict === "positive") counts.tp++; else counts.fn++; }
    else if (verdict === "positive") counts.fp++; else counts.tn++;
    const predicted = verdict === "positive" ? result!.boxes! : [];
    const matched = countMosaicBoxMatches(expected, predicted);
    counts.evaluatedBoxes += expected.length;
    counts.foundBoxes += matched;
    if (full && positive && verdict === "positive" && matched === expected.length) counts.fullyCoveredPositiveImages++;
    if (full) {
      counts.completeEvaluatedImages++;
      counts.completeMatchedBoxes += matched;
      counts.completePredictedBoxes += predicted.length;
      counts.extraBoxes += predicted.length - matched;
    }
  }
  for (const index of Object.keys(results)) {
    if (/^(0|[1-9]\d*)$/.test(index) && Number(index) < samples.length) continue;
    counts.invalid++;
    reason("逐图结果下标越界或无效");
  }
  return counts;
}

export type MosaicScoreCounts = ReturnType<typeof countMosaicResults>;
