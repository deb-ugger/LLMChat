import { API_BASE } from "./api";
import type { SystemPerformanceMetric, SystemPerformancePoint, SystemPerformanceSample, SystemPerformanceSource } from "./benchmark/systemPerformanceTypes";

type RawPercent = number | null;
type RawMemory = { availableBytes?: number | null; usedBytes?: number | null } | null;
type RawDisk = { readBytesPerSec?: number | null; writeBytesPerSec?: number | null } | null;
type RawNetwork = { receiveBytesPerSec?: number | null; sendBytesPerSec?: number | null } | null;

type RawSample = {
  sampledAt?: number | null;
  cpu?: RawPercent;
  memory?: RawMemory;
  disk?: RawDisk;
  network?: RawNetwork;
  gpu?: RawPercent;
  /** 新增字段：后端未提供时保持 undefined，前端显示「—」 */
  diskPercent?: RawPercent;
  cpuTempC?: number | null;
  gpuTempC?: number | null;
  tempSource?: "lhm" | "acpi" | null;
  tokensPerSecond?: number | null;
  modelCount?: number | null;
};

function percentOfMemory(memory: RawMemory): number | null {
  const used = memory?.usedBytes ?? null;
  const available = memory?.availableBytes ?? null;
  if (used == null || available == null) return null;
  const total = used + available;
  if (total <= 0) return null;
  return (used / total) * 100;
}

function bytesPerSecondOfDisk(disk: RawDisk): number | null {
  const read = disk?.readBytesPerSec ?? null;
  const write = disk?.writeBytesPerSec ?? null;
  if (read == null && write == null) return null;
  return (read ?? 0) + (write ?? 0);
}

function bytesPerSecondOfNetwork(network: RawNetwork): number | null {
  const receive = network?.receiveBytesPerSec ?? null;
  const send = network?.sendBytesPerSec ?? null;
  if (receive == null && send == null) return null;
  return (receive ?? 0) + (send ?? 0);
}

function toPoint(raw: RawSample, at: number | null | undefined): SystemPerformancePoint | null {
  if (at == null) return null;
  return {
    at,
    cpu: raw.cpu ?? null,
    memory: percentOfMemory(raw.memory ?? null),
    disk: bytesPerSecondOfDisk(raw.disk ?? null),
    network: bytesPerSecondOfNetwork(raw.network ?? null),
    gpu: raw.gpu ?? null,
    diskPercent: raw.diskPercent ?? null,
    cpuTempC: raw.cpuTempC ?? null,
    gpuTempC: raw.gpuTempC ?? null,
    tempSource: raw.tempSource ?? null,
    tokensPerSecond: raw.tokensPerSecond ?? null,
    modelCount: raw.modelCount ?? null,
  };
}

async function readJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`系统性能读取失败（HTTP ${response.status}）`);
  }
  return (await response.json()) as T;
}

export async function fetchSystemPerformanceNow(): Promise<SystemPerformancePoint | null> {
  const body = await readJson<RawSample & { ok?: boolean }>(
    `${API_BASE}/api/system-performance/now`,
  );
  return toPoint(body, body.sampledAt);
}

export async function fetchSystemPerformanceHistory(options?: {
  from?: number;
  to?: number;
}): Promise<SystemPerformancePoint[]> {
  const params = new URLSearchParams();
  if (options?.from != null) params.set("from", String(options.from));
  if (options?.to != null) params.set("to", String(options.to));
  const query = params.toString();
  const body = await readJson<{ points?: (Omit<RawSample, "sampledAt"> & { t: number })[] }>(
    `${API_BASE}/api/system-performance/history${query ? `?${query}` : ""}`,
  );
  return (body.points ?? [])
    .map(item => toPoint(item, item.t))
    .filter((point): point is SystemPerformancePoint => point != null);
}

type SystemRunKey = { taskId: string; source: SystemPerformanceSource; beginTime: string };

export function startSystemPerformanceRun(run: SystemRunKey) {
  return postRun("/start", run);
}

export function stopSystemPerformanceRun(run: SystemRunKey & { endedAt: string }) {
  return postRun("", run);
}

function postRun(suffix: string, run: SystemRunKey) {
  return readJson(`${API_BASE}/api/system-performance/runs${suffix}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(run), signal: AbortSignal.timeout(3000),
  });
}

type Stats = { mean: number | null; peak: number | null; samples: number };
type ArchiveSlice = {
  startedAt: number; endedAt: number; sampleCount?: number;
  points?: (RawSample & { t: number })[];
  summary?: Partial<Record<SystemPerformanceMetric, Stats>>;
  metrics?: Partial<Record<"cpu" | "gpu", Stats>>;
};

export async function fetchRunSystemPerformance(taskId: string, source: SystemPerformanceSource, endedAt?: string,
  signal?: AbortSignal): Promise<SystemPerformanceSample> {
  const query = new URLSearchParams({ taskId, source });
  const result = await readJson<{ runs: ArchiveSlice[] }>(`${API_BASE}/api/system-performance/runs?${query}`, { signal });
  const end = endedAt ? Date.parse(endedAt) : Infinity;
  const eligible = result.runs.filter(run => run.endedAt <= end).sort((a, b) => a.startedAt - b.startedAt);
  const segments = eligible.some(run => run.summary) ? eligible.filter(run => run.summary) : eligible;
  const average = { cpu: null, memory: null, disk: null, network: null, gpu: null } as SystemPerformanceSample["average"];
  const peak = { ...average };
  for (const key of Object.keys(average) as SystemPerformanceMetric[]) {
    const rows = segments.flatMap(run => {
      const stats = run.summary?.[key] ?? (key === "cpu" || key === "gpu" ? run.metrics?.[key] : undefined);
      return stats && stats.samples > 0 ? [stats] : [];
    });
    if (!rows.length) continue;
    const valid = rows.filter(row => row.mean !== null);
    const peaks = rows.flatMap(row => row.peak === null ? [] : [row.peak]);
    if (valid.length) average[key] = valid.reduce((sum, row) => sum + row.mean! * row.samples, 0) /
      valid.reduce((sum, row) => sum + row.samples, 0);
    if (peaks.length) peak[key] = Math.max(...peaks);
  }
  return {
    average, peak,
    samples: segments.reduce((sum, run) => sum + (run.sampleCount ?? Math.max(run.metrics?.cpu?.samples ?? 0, run.metrics?.gpu?.samples ?? 0)), 0),
    timelines: segments.map(run => (run.points ?? []).flatMap(point => {
      const mapped = toPoint(point, point.t);
      return mapped ? [mapped] : [];
    })).filter(points => points.length > 0),
  };
}
