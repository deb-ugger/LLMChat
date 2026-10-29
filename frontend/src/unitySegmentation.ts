import { runtimeAssetBase } from "./runtimeAssets";

/** One task owns one Worker. Completion or cancellation releases its model heap. */
export class UnitySegmentation {
  private worker: Worker | null = null;
  private next = 0;
  private pending = new Map<number, { resolve: (ends: number[]) => void; reject: (error: Error) => void }>();
  private closed = false;

  sentenceEnds(text: string, signal: AbortSignal): Promise<number[]> {
    if (this.closed || signal.aborted) return Promise.reject(new Error("本地多语言分段已中止"));
    if (!this.worker) {
      this.worker = new Worker(new URL("./unitySegmentationWorker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = event => {
        const task = this.pending.get(event.data.id);
        if (!task) return;
        this.pending.delete(event.data.id);
        if (event.data.error) task.reject(new Error(event.data.error)); else task.resolve(event.data.ends);
      };
      this.worker.onerror = event => { event.preventDefault(); this.dispose(new Error(event.message || "本地多语言分段 Worker 运行失败")); };
      this.worker.onmessageerror = () => this.dispose(new Error("本地多语言分段 Worker 消息读取失败"));
    }
    return new Promise<number[]>((resolve, reject) => {
      const abort = () => this.dispose(new Error("本地多语言分段已中止"));
      const cleanup = () => signal.removeEventListener("abort", abort);
      const id = ++this.next;
      this.pending.set(id, { resolve: ends => { cleanup(); resolve(ends); }, reject: error => { cleanup(); reject(error); } });
      signal.addEventListener("abort", abort, { once: true });
      this.worker!.postMessage({ id, text, base: runtimeAssetBase() });
    });
  }
  dispose(error = new Error("本地多语言分段任务已结束")) {
    this.closed = true;
    this.worker?.terminate(); this.worker = null;
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
  }
}
