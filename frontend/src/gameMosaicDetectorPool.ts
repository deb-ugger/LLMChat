import type { MosaicDetectorInit } from "./mosaicDetectorRuntime";
import type { MosaicDevice, MosaicScan } from "./gameMosaic";
import { recordGameCacheHit, startGameTiming } from "./gameModelPerformance";

type Job = { id: number; blob: Blob; resolve: (scan: MosaicScan) => void; reject: (error: unknown) => void };
type Lane = { worker: Worker; ready: boolean; job?: Job; device?: MosaicDevice;
  resolve: () => void; reject: (error: unknown) => void; stopTiming?: (durationMs?: number) => void };
export async function openMosaicDetectorPool(prepared: MosaicDetectorInit, options: {
  concurrency: number; signal?: AbortSignal; timingScope?: string; onDevice?: (device: MosaicDevice) => void;
  createWorker?: () => Worker;
}) {
  const { signal, timingScope } = options;
  signal?.throwIfAborted();
  const lanes: Lane[] = [], pending: Job[] = [], cache = new Map<string, Promise<MosaicScan>>();
  let stopped = false, nextId = 0, reused = 0;
  const finishTiming = (lane: Lane, durationMs?: number) => { lane.stopTiming?.(durationMs); lane.stopTiming = undefined; };
  const stop = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    for (const lane of lanes) {
      finishTiming(lane); lane.reject(error); lane.job?.reject(error);
      lane.worker.onmessage = null; lane.worker.onerror = null; lane.worker.terminate();
    }
    for (const job of pending.splice(0)) job.reject(error);
    cache.clear(); signal?.removeEventListener("abort", abort);
  };
  const abort = () => stop(signal?.reason ?? new DOMException("已取消 ONNX 推理", "AbortError"));
  const dispatch = () => {
    if (stopped) return;
    for (const lane of lanes) if (lane.ready && !lane.job && pending.length) {
      lane.job = pending.shift()!;
      lane.worker.postMessage({ type: "scan", id: lane.job.id, blob: lane.job.blob });
    }
  };
  const reportDevice = () => {
    const known = lanes.flatMap(lane => lane.device ? [lane.device] : []);
    const cpu = known.find(device => device.kind === "cpu");
    if (known.length) options.onDevice?.(cpu ?? known[0]);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const count = Math.max(1, Math.min(4, Math.trunc(options.concurrency)));
  try {
    const ready: Promise<void>[] = [];
    for (let index = 0; index < count; index++) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const started = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      started.catch(() => {}); // A later Worker constructor can fail before Promise.all is reached.
      ready.push(started);
      const worker = options.createWorker?.() ?? new Worker(new URL("./gameMosaicDetectorWorker.ts", import.meta.url), { type: "module" });
      const lane: Lane = { worker, ready: false, resolve, reject }; lanes.push(lane);
      worker.onerror = event => stop(new Error(event.message || "ONNX 工作线程异常退出"));
      worker.onmessage = ({ data }) => {
        if (stopped) return;
        if (data.type === "ready") { lane.ready = true; lane.resolve(); dispatch(); }
        else if (data.type === "device") { lane.device = data.device; reportDevice(); }
        else if (data.type === "cache-hit") { reused++; recordGameCacheHit(timingScope); }
        else if (data.type === "inference") {
          if (data.running) lane.stopTiming = startGameTiming(timingScope, "detectorMs");
          else finishTiming(lane, data.durationMs);
        } else if (data.type === "error" && data.id === undefined) stop(new Error(data.error));
        else if ((data.type === "result" || data.type === "error") && lane.job && lane.job.id === data.id) {
          finishTiming(lane);
          const job = lane.job; lane.job = undefined;
          if (data.type === "error") job.reject(new Error(data.error)); else job.resolve(data.scan);
          dispatch();
        }
      };
      // The final worker takes ownership; previous workers receive independent copies.
      const transfer = index === count - 1 ? [...new Set([prepared.bytes, prepared.presenceBytes,
        ...(prepared.labelsBytes ? [prepared.labelsBytes] : [])])] : [];
      worker.postMessage({ type: "init", prepared }, transfer);
    }
    await Promise.all(ready);
    signal?.throwIfAborted();
  } catch (error) { stop(error); throw error; }
  return {
    get reused() { return reused; },
    parallelism: count,
    release: async () => stop(new DOMException("ONNX 工作线程已释放", "AbortError")),
    scan: async (blob: Blob): Promise<MosaicScan> => {
      signal?.throwIfAborted();
      if (stopped) throw new Error("ONNX 工作线程已释放");
      const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      signal?.throwIfAborted();
      if (stopped) throw new Error("ONNX 工作线程已释放");
      const key = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
      const previous = cache.get(key);
      if (previous) { reused++; recordGameCacheHit(timingScope); return previous; }
      const promise = new Promise<MosaicScan>((resolve, reject) => { pending.push({ id: ++nextId, blob, resolve, reject }); dispatch(); })
        .catch(error => { cache.delete(key); throw error; });
      cache.set(key, promise);
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
      return promise;
    },
  };
}
