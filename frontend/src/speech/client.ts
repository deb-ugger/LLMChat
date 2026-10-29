import type { SpeechModel, SpeechProgress, SpeechRequest, SpeechResponse, SpeechResult } from "./transcription";
import { runtimeAssetBase } from "../runtimeAssets";

export class SpeechClient {
  private worker: Worker | null = null;
  private model: SpeechModel | null = null;
  private nextId = 0;
  private job: { id: number; resolve: (result: SpeechResult) => void; reject: (error: Error) => void; progress: (progress: SpeechProgress) => void; preview: (text: string) => void } | null = null;

  transcribe(pcm: Float32Array, model: SpeechModel, language: string,
    progress: (progress: SpeechProgress) => void, preview: (text: string) => void, previewEnabled = true): Promise<SpeechResult> {
    if (this.job) return Promise.reject(new Error("已有音频正在识别"));
    if (this.model !== model) this.release();
    if (!this.worker) {
      const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<SpeechResponse>) => {
        const message = event.data, job = this.job;
        if (!job || message.id !== job.id) return;
        if (message.type === "progress") job.progress(message.progress);
        else if (message.type === "preview") job.preview(message.text);
        else if (message.type === "result") { this.job = null; job.resolve(message.result); }
        else { this.job = null; this.release(); job.reject(new Error(message.message)); }
      };
      worker.onerror = event => { event.preventDefault(); this.release(new Error(event.message || "语音识别线程出错")); };
      worker.onmessageerror = () => this.release(new Error("语音识别结果读取失败"));
      this.worker = worker;
      this.model = model;
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.job = { id, resolve, reject, progress, preview };
      const request: SpeechRequest = { id, pcm, model, language, assetBase: runtimeAssetBase(), preview: previewEnabled };
      try { this.worker!.postMessage(request, [pcm.buffer as ArrayBuffer]); }
      catch (error) { this.release(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  release(error: Error = new DOMException("语音识别已取消", "AbortError")) {
    if (this.worker) {
      this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = null;
    }
    const job = this.job; this.job = null; this.model = null;
    job?.reject(error);
  }
}
