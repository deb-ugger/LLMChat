import { csvRows } from "./trainingDatasets";
import type { MosaicBox } from "../gameMosaic";

export type ValidationRow = { sample: string; box: MosaicBox; scene: string; expected: string; prediction: string; confidence: number; rawConfidence?: number; diagnostics?: string };
export type TrainingComparison = { variant: string; strategy: string; agreement: number; macro_f1: number;
  seconds: number; calibration_nll: number; temperature: number; validation_samples: number;
  at_runtime_threshold: { accepted: number; matched: number; threshold: number } };
export type TrainingReport = { agreement: number; training_samples: number; validation_samples: number;
  calibration_samples?: number; unique_samples?: number; duplicate_regions?: number; split_id?: string;
  variant?: string; strategy?: string; seconds?: number; temperature?: number;
  raw_at_runtime_threshold?: { accepted: number; matched: number; threshold: number };
  comparisons?: TrainingComparison[];
  confidence_curve?: { threshold: number; accuracy: number; accepted: number; matched: number }[];
  at_runtime_threshold: { threshold: number; accepted: number; matched: number } };
export type TrainingRun = { runId: string; datasetWorkId: string; createdAt: number; state: string; report?: TrainingReport };
export type TrainingResult = { meta: TrainingRun; report: TrainingReport; csv: string; snapshotPath: string };
export type ModelStatus = { hash: string | null; source: { runId: string; createdAt: number; accuracy: number; hash: string; variant?: string } | null };

export function parseValidation(csv: string): ValidationRow[] {
  const [header, ...rows] = csvRows(csv.replace(/^\uFEFF/, ""));
  if (!header) throw new Error("验证文件为空");
  const fields = ["sample", "box", "scene", "expected", "prediction", "confidence"];
  if (fields.some(field => !header.includes(field))) throw new Error("验证文件缺少必要字段");
  return rows.filter(row => row.some(Boolean)).map(row => {
    const field = (name: string) => row[header.indexOf(name)];
    const box = JSON.parse(field("box"));
    const confidence = Number(field("confidence"));
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isInteger) || !Number.isFinite(confidence)) throw new Error("验证文件包含无效坐标或置信度");
    return { sample: field("sample"), box: box as MosaicBox, scene: field("scene"), expected: field("expected"), prediction: field("prediction"), confidence,
      rawConfidence: header.includes("raw_confidence") ? Number(field("raw_confidence")) : undefined,
      diagnostics: header.includes("diagnostics") ? field("diagnostics") : undefined };
  });
}

export const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : undefined;
export const percent = (value: number | undefined) => value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;

export function trainingMetrics(rows: ValidationRow[], report: TrainingReport) {
  const labels = [...new Set(rows.flatMap(row => [row.expected, row.prediction]))].sort();
  const matrix = labels.map(expected => labels.map(prediction => rows.filter(row => row.expected === expected && row.prediction === prediction).length));
  const classes = labels.map((label, index) => {
    const count = matrix[index].reduce((a, b) => a + b, 0);
    const predicted = matrix.reduce((total, row) => total + row[index], 0);
    const matched = matrix[index][index];
    return { label, count, precision: ratio(matched, predicted), recall: ratio(matched, count), f1: ratio(2 * matched, count + predicted) };
  });
  const definedF1 = classes.flatMap(row => row.f1 === undefined ? [] : [row.f1]);
  return { matrix, classes, labels, accuracy: ratio(rows.filter(row => row.expected === row.prediction).length, rows.length),
    macroF1: ratio(definedF1.reduce((a, b) => a + b, 0), definedF1.length),
    coverage: ratio(report.at_runtime_threshold.accepted, report.validation_samples),
    acceptedAccuracy: ratio(report.at_runtime_threshold.matched, report.at_runtime_threshold.accepted) };
}

export function readableTrainingLog(line: string) {
  if (line.startsWith("PROGRESS ")) {
    try {
      const value = JSON.parse(line.slice(9));
      return `${value.phase === "features" ? "提取特征" : "训练"} ${value.current}/${value.total}`;
    } catch { return line; }
  }
  if (line.startsWith('{"teacher"')) return "训练报告与模型已保存";
  return line;
}
