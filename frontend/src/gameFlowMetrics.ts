export type FlowMetricUnit = "tok/s" | "张/s" | "秒/张" | "次" | "张";

export type FlowMetric = {
  key: string;
  label: string;
  value: string;
  unit?: FlowMetricUnit;
  tooltip?: string;
};

export type FlowMetricInput = {
  tokens?: number;
  requestMs?: number;
  requests?: number;
  generationTokens?: number;
  generationMs?: number;
  items?: number;
  itemsDone?: number;
  elapsedMs?: number;
  failures?: number;
  concurrency?: number;
  queueMs?: number;
  processingMs?: number;
  saveMs?: number;
  busyMs?: number;
  idleMs?: number;
};

function nonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function formatDecimal(value: number, digits: 1 | 2): string {
  if (!Number.isFinite(value) || (value === 0 && digits === 1)) return "0";
  return value > 0 && value < 0.05 ? "<0.1" : value.toFixed(digits);
}

function formatSeconds(ms: number): string {
  return formatDecimal(ms / 1000, 2) + " 秒";
}

const timingFields = [
  ["queueMs", "排队"],
  ["processingMs", "处理与校验"],
  ["saveMs", "保存"],
  ["busyMs", "模型请求占用"],
  ["idleMs", "无在途模型请求"],
] as const;

export function deriveFlowMetrics(input: FlowMetricInput): FlowMetric[] {
  const metrics: FlowMetric[] = [];
  const tokens = nonNegative(input.tokens);
  const requestMs = nonNegative(input.requestMs);
  const generationMs = nonNegative(input.generationMs);
  const itemsDone = nonNegative(input.itemsDone);
  const elapsedMs = nonNegative(input.elapsedMs);

  if (tokens > 0 && requestMs > 0) {
    const requestRate = (tokens / requestMs) * 1000;
    const generationRate = generationMs > 0
      ? (nonNegative(input.generationTokens) / generationMs) * 1000
      : requestRate;
    metrics.push(
      { key: "generationRate", label: "纯生成", value: formatDecimal(generationRate, 1), unit: "tok/s" },
      { key: "requestRate", label: "请求平均", value: formatDecimal(requestRate, 1), unit: "tok/s" },
    );
  }

  if (itemsDone > 0 && elapsedMs > 0) {
    metrics.push(
      { key: "itemsRate", label: "处理速度", value: formatDecimal((itemsDone / elapsedMs) * 1000, 2), unit: "张/s" },
      { key: "secondsPerItem", label: "每张耗时", value: formatDecimal(elapsedMs / itemsDone / 1000, 2), unit: "秒/张" },
    );
  }

  if (metrics.length === 0) {
    const count = input.itemsDone === undefined ? nonNegative(input.items) : itemsDone;
    metrics.push(
      { key: "itemsDone", label: "已处理", value: String(count), unit: "张" },
      { key: "elapsedMs", label: "用时", value: formatSeconds(elapsedMs) },
    );
  }

  for (const [key, label] of timingFields) {
    const ms = input[key];
    if (ms !== undefined) metrics.push({ key, label, value: formatSeconds(nonNegative(ms)) });
  }

  const failures = nonNegative(input.failures);
  if (failures > 0) metrics.push({ key: "failures", label: "失败", value: String(failures), unit: "张" });
  return metrics;
}

export function formatFlowThroughput(measurement: Pick<FlowMetricInput, "itemsDone" | "elapsedMs"> | undefined, unit: "个" | "张") {
  if (!measurement) return undefined;
  const rate = deriveFlowMetrics({ itemsDone: measurement.itemsDone, elapsedMs: measurement.elapsedMs })
    .find(metric => metric.key === "itemsRate");
  return rate && rate.value + " " + unit + "/秒";
}
