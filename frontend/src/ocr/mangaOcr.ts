import { API_BASE, api } from "../api";

type Pending = { resolve: (text: string) => void; reject: (error: Error) => void; ready?: () => void };

/** Model loading and inference live in an isolated, cancellable Worker. */
export class LocalMangaOcr {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private prepared: Promise<unknown> | null = null;

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./mangaWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      const message = event.data;
      const task = this.pending.get(message.id);
      if (!task) return;
      if (message.type === "ready") { task.ready?.(); return; }
      this.pending.delete(message.id);
      if (message.type === "result") task.resolve(message.text);
      else task.reject(new Error(message.error || "漫画识别失败"));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.stop(new Error(event.message || "漫画识别 Worker 运行失败"));
    };
    worker.onmessageerror = () => this.stop(new Error("漫画识别 Worker 消息读取失败"));
    this.worker = worker;
    return worker;
  }

  recognize(image: Blob, onReady?: () => void): Promise<string> {
    if (this.closed) return Promise.reject(new Error("识别已取消"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ready: onReady });
      this.prepared ??= api.ensureOcrMode("manga").catch((error) => {
        this.prepared = null;
        throw error;
      });
      void this.prepared.then(() => {
        if (this.closed || !this.pending.has(id)) return;
        this.getWorker().postMessage({ id, image, apiBase: API_BASE, assetBase: document.baseURI });
      }).catch((error) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private stop(error: Error) {
    this.closed = true;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
    this.prepared = null;
  }

  dispose(): Promise<void> {
    // Also stops a running WASM call and releases the isolated worker heap.
    this.stop(new Error("识别已取消"));
    return Promise.resolve();
  }
}
