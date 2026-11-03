import type { TextProject } from "./transProject";
import type { TransEntry } from "./textTranslate";
import type { EpubSource, TextRanges } from "./textProjectFormats";
export type TextJob =
  | { kind: "parse"; format: "epub" | "vtt" | "markdown" | "json" | "srt" | "ass"; input: string | Uint8Array }
  | { kind: "export"; project: TextProject; attachment?: Uint8Array }
  | { kind: "check"; project: TextProject; ids?: string[] };
export type ParsedText = { entries: TransEntry[]; metadata: EpubSource | TextRanges };
export type TextChecks = { id: string; error: string; warning: string }[];

/** A short-lived worker bounds memory and lets callers cancel real computation. */
export function runTextJob<T>(job: TextJob, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const worker = new Worker(new URL("./textProcessingWorker.ts", import.meta.url), { type: "module" });
    const finish = () => { worker.terminate(); signal?.removeEventListener("abort", abort); };
    const abort = () => { finish(); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = event => { finish(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result); };
    worker.onerror = event => { finish(); reject(new Error(event.message || "文本处理失败")); };
    const transfer = job.kind === "parse" && job.input instanceof Uint8Array ? [job.input.buffer] : job.kind === "export" && job.attachment ? [job.attachment.buffer] : [];
    try { worker.postMessage(job, transfer as ArrayBuffer[]); } catch (error) { finish(); reject(error); }
  });
}
