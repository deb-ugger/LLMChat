import type { BenchmarkResult } from "../gameTextBenchmark";
import type { MosaicTaskReport } from "./benchmarkMosaicReport";

export type BenchmarkQualityCounts = Pick<MosaicTaskReport["totals"][number], "tp" | "fp" | "tn" | "fn">;
type ScoredQuality = Partial<Pick<MosaicTaskReport["totals"][number], "confirmedPositive" | "confirmedNegative" | "score">>;
export type BenchmarkCompareRun = BenchmarkResult & { quality?: (BenchmarkQualityCounts & ScoredQuality) | null };

export type BenchmarkRunSummary = {
  model: string | null;
  concurrency: number | null;
  wallSeconds: number;
  samples: number;
  successRate: number | null;
  tokensPerSecond: number | null;
  f1: number | null;
};

export type BenchmarkQualityPoint = {
  runId: string | null;
  label: string;
  x: number;
  y: number | null;
  size: number;
  series: string | null;
};

export type BenchmarkConcurrencyCell = {
  x: number;
  y: string;
  value: number;
  runs: number;
};

const stageCategories = ["modelRequestMs", "ocrMs", "saveMs", "queueMs"] as const;
export type BenchmarkStageBar = {
  runId: string | null;
  label: string;
  stack: typeof stageCategories[number];
  seconds: number | null;
};

export function summarizeRun(run: BenchmarkCompareRun): BenchmarkRunSummary {
  const meters = Object.values(run.performance.models).filter(meter => meter.model && meter.requests > 0);
  const models = [...new Set(meters.map(meter => meter.model))].sort();
  const lanes = new Set(meters.map(meter => meter.concurrency));
  const concurrency = meters[0]?.concurrency;
  const wallSeconds = run.performance.elapsedMs / 1000;
  const tokens = meters.map(meter => meter.usage?.completionTokens ?? (meter.tokens > 0 ? meter.tokens : undefined));
  const quality = run.quality;
  const denominator = quality ? 2 * quality.tp + quality.fp + quality.fn : 0;
  return {
    model: models.length ? models.join(" + ") : null,
    concurrency: lanes.size === 1 && Number.isInteger(concurrency) && concurrency > 0 ? concurrency : null,
    wallSeconds,
    samples: run.selected,
    successRate: run.selected > 0 ? run.translated / run.selected : null,
    tokensPerSecond: wallSeconds > 0 && tokens.length && tokens.every(token => token !== undefined)
      ? tokens.reduce((sum, token) => sum + token, 0) / wallSeconds : null,
    f1: quality && denominator > 0 ? 2 * quality.tp / denominator : null,
  };
}

export function buildQualityScatter(runs: readonly BenchmarkCompareRun[], metric: "f1" | "score" = "f1"): BenchmarkQualityPoint[] {
  return runs.map(run => {
    const { wallSeconds, model, f1 } = summarizeRun(run);
    const counts = run.quality;
    return {
      runId: run.performance.taskId ?? null,
      label: run.label,
      x: wallSeconds,
      y: metric === "score" ? counts?.score?.displayScore ?? null : f1,
      size: counts?.confirmedPositive !== undefined && counts.confirmedNegative !== undefined
        ? counts.confirmedPositive + counts.confirmedNegative : counts ? counts.tp + counts.fp + counts.tn + counts.fn : 0,
      series: model,
    };
  });
}

export function buildConcurrencyHeatmap(runs: readonly BenchmarkCompareRun[]): BenchmarkConcurrencyCell[] {
  const groups = new Map<string, { x: number; y: string; successes: number; seconds: number; runs: number }>();
  for (const run of runs) {
    const { wallSeconds, model, concurrency } = summarizeRun(run);
    if (!model || concurrency === null || wallSeconds <= 0 || run.selected <= 0) continue;
    const key = JSON.stringify([model, concurrency]);
    const cell = groups.get(key) ?? { x: concurrency, y: model, successes: 0, seconds: 0, runs: 0 };
    cell.successes += run.translated;
    cell.seconds += wallSeconds;
    cell.runs++;
    groups.set(key, cell);
  }
  return [...groups.values()].map(({ x, y, successes, seconds, runs }) => ({ x, y, value: successes / seconds, runs }));
}

export function buildStageBars(runs: readonly BenchmarkCompareRun[]): BenchmarkStageBar[] {
  return runs.flatMap(run => stageCategories.map(stack => {
    const duration = run.performance.wallTiming?.[stack];
    return {
      runId: run.performance.taskId ?? null,
      label: run.label,
      stack,
      seconds: duration === undefined ? null : duration / 1000,
    };
  }));
}
