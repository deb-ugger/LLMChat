import { createMosaicDetectorRuntime, type MosaicDetectorInit } from "./mosaicDetectorRuntime";
let runtime: Awaited<ReturnType<typeof createMosaicDetectorRuntime>> | undefined;
self.onmessage = async ({ data }: MessageEvent<{ type: "init"; prepared: MosaicDetectorInit } | { type: "scan"; id: number; blob: Blob }>) => {
  const id = data.type === "scan" ? data.id : undefined;
  try {
    if (data.type === "init") {
      runtime = await createMosaicDetectorRuntime({ ...data.prepared,
        onDevice: device => self.postMessage({ type: "device", device }),
        onInference: (running, durationMs) => self.postMessage({ type: "inference", running, durationMs }),
        onCacheHit: () => self.postMessage({ type: "cache-hit" }),
      });
      self.postMessage({ type: "ready" });
    } else {
      if (!runtime) throw new Error("ONNX 工作线程尚未初始化");
      const scan = await runtime.scan(data.blob);
      self.postMessage({ type: "result", id, scan });
    }
  } catch (cause) {
    self.postMessage({ type: "error", id, error: cause instanceof Error ? cause.message : String(cause) });
  }
};
