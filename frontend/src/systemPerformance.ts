import { API_BASE } from "./api";
import type { SystemPerformancePoint } from "./benchmark/systemPerformanceTypes";

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

/**
 * 磁盘这一行在界面里按「读写合计速率」展示，而不是占用率：
 * 后端只给速率，没有卷容量，硬算百分比会是假数。
 */
function toPoint(raw: RawSample | null | undefined): SystemPerformancePoint | null {
  if (!raw) return null;
  const at = raw.sampledAt ?? null;
  if (at == null) return null;
  return {
    at,
    cpu: raw.cpu ?? null,
    memory: percentOfMemory(raw.memory ?? null),
    disk: bytesPerSecondOfDisk(raw.disk ?? null),
    network: bytesPerSecondOfNetwork(raw.network ?? null),
    gpu: raw.gpu ?? null,
  };
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`系统性能读取失败（HTTP ${response.status}）`);
  }
  return (await response.json()) as T;
}

export async function fetchSystemPerformanceNow(): Promise<SystemPerformancePoint | null> {
  const body = await readJson<RawSample & { ok?: boolean }>(
    `${API_BASE}/api/system-performance/now`,
  );
  return toPoint(body);
}

export async function fetchSystemPerformanceHistory(options?: {
  from?: number;
  to?: number;
}): Promise<SystemPerformancePoint[]> {
  const params = new URLSearchParams();
  if (options?.from != null) params.set("from", String(options.from));
  if (options?.to != null) params.set("to", String(options.to));
  const query = params.toString();
  const body = await readJson<{ points?: RawSample[] }>(
    `${API_BASE}/api/system-performance/history${query ? `?${query}` : ""}`,
  );
  return (body.points ?? [])
    .map((item) => toPoint(item))
    .filter((point): point is SystemPerformancePoint => point != null);
}
