import { mosaicScreeningStatus, mosaicStatusLabels } from "../gameMosaicStatus";
import type { MosaicScan } from "../gameMosaic";
import type { StepPerformance } from "../gameModelPerformance";
import type { BenchmarkResult } from "../gameTextBenchmark";
import { readImageBenchmarkDetails, saveImageBenchmarkDetails, type ImageBenchmarkInput, type ImageBenchmarkOutcome } from "./imageBenchmarkHistory";

export function formalRecordStep(run: StepPerformance): string | undefined {
  if (run.scope && /:mosaic:(screen|refine|redraw)$/.test(run.scope)) {
    if (run.step === "screen") return "mosaicScreen";
    if (run.step === "refine") return "mosaicRefine";
    if (run.step === "redraw") return "mosaicRedraw";
  }
  if (run.scope?.endsWith(":images") && run.step === "translate") return "imageTranslate";
  return run.step;
}

export function formalRecordProject(scope?: string) {
  return scope?.replace(/(?::(?:text|images):(?:text|images)|:unity:(?:text|images)|:(?:mosaic|deployment):\w+|:(?:text|images))$/, "");
}

export function formalHistoryResults(records: readonly StepPerformance[]): BenchmarkResult[] {
  const unique = new Map<string, BenchmarkResult>();
  for (const [index, run] of records.entries()) {
    const id = run.taskId || `legacy:${index}`;
    const previous = unique.get(id)?.performance;
    if (previous && (previous.endedAt || previous.beginTime || "") >= (run.endedAt || run.beginTime || "")) continue;
    const saved = run.formalRun;
    const failures = saved?.failed ?? run.failures ?? 0;
    const processed = run.itemsDone ?? 0;
    unique.set(id, {
      round: 1,
      label: saved?.label || [...new Set(Object.values(run.models ?? {}).filter(model => model.requests > 0).map(model => model.model))].join(" + ") || "无模型调用",
      selected: saved?.total ?? processed,
      translated: saved?.completed ?? Math.max(0, processed - failures),
      failed: failures,
      status: saved?.status ?? (run.reason === "paused" || run.reason === "cleared" ? "已暂停" : failures ? "失败" : "完成"),
      detail: saved?.detail,
      unobservedModels: [],
      performance: run.taskId ? run : { ...run, taskId: id },
    });
  }
  return [...unique.values()];
}

export function mosaicRunImageOutcome(scan: MosaicScan | undefined, refine: boolean, reason?: string): ImageBenchmarkOutcome {
  if (!scan) return { category: mosaicStatusLabels.failed, status: "失败", reason };
  return {
    category: mosaicStatusLabels[mosaicScreeningStatus({
      ...scan, scanned: true, refined: refine ? "mosaicRefine" : undefined, refineQuickExcluded: scan.quickExcluded,
    })],
    boxes: scan.review ? scan.reviewBoxes || scan.boxes : scan.boxes,
    checked: !!scan.boxes.length && !scan.review, reason: scan.review, status: "完成",
  };
}

export async function archiveFormalMosaicImages(taskId: string, targets: readonly ImageBenchmarkInput[],
  outcomes: ReadonlyMap<string, ImageBenchmarkOutcome>, resume: boolean) {
  const previous = resume ? await readImageBenchmarkDetails(taskId, taskId) : undefined;
  const samples = new Map(previous?.samples.map(sample => [sample.id, sample]));
  const indexed = new Map(previous?.samples.flatMap((sample, index) => previous.results[index] ?
    [[sample.id, previous.results[index]] as const] : []));
  for (const sample of targets) {
    const old = samples.get(sample.id);
    if (old?.sourceHash !== sample.sourceHash) {
      indexed.delete(sample.id);
      samples.set(sample.id, sample);
    }
    const result = outcomes.get(sample.id);
    if (result) indexed.set(sample.id, result);
  }
  const archived = [...samples.values()];
  const results: Record<string, ImageBenchmarkOutcome> = {};
  let completed = 0, failed = 0;
  archived.forEach((sample, index) => {
    const outcome = indexed.get(sample.id);
    if (!outcome) return;
    const row = { ...outcome, sampleId: sample.id, sourceHash: sample.sourceHash };
    results[index] = row;
    if (outcome.status === "失败") failed++;
    else if (outcome.status !== "跳过") completed++;
  });
  await saveImageBenchmarkDetails(taskId, taskId, archived, results);
  return { total: archived.length, completed, failed };
}
