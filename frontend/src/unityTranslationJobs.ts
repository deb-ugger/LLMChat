import type { UnityProject } from "./unityOffline";

export type UnityTranslationPart = "text" | "images";
export type UnityJobState = "pending" | "running" | "done" | "stopped" | "error" | "skipped";
export class UnityTranslationStopped extends Error { constructor() { super("翻译任务已中止，进度已保存"); } }

/** Each translation lane owns only its data; saves are serialized by the caller. */
export function mergeUnityTranslationProject(current: UnityProject, update: UnityProject, part: UnityTranslationPart): UnityProject {
  if (current.folder !== update.folder) throw new Error("翻译结果不属于当前工程");
  return part === "text" ? { ...current, entries: update.entries } : { ...current, images: update.images };
}

export function createUnityTranslationJobs(options: {
  signal: AbortSignal;
  initial: Record<UnityTranslationPart, UnityJobState>;
  run: (part: UnityTranslationPart, controller: AbortController) => Promise<void>;
  changed: (part: UnityTranslationPart, state: UnityJobState, failure?: string) => void;
}) {
  const states = { ...options.initial }, controllers = new Map<UnityTranslationPart, AbortController>();
  const jobs = new Map<UnityTranslationPart, Promise<void>>(), participants = new Set<UnityTranslationPart>(), skipped = new Set<UnityTranslationPart>();
  const failures = new Map<UnityTranslationPart, string>();
  let settled = false, resolve!: () => void, reject!: (error: Error) => void;
  const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const change = (part: UnityTranslationPart, state: UnityJobState, failure?: string) => { states[part] = state; options.changed(part, state, failure); };
  const cleanup = () => options.signal.removeEventListener("abort", abort);
  const check = () => {
    if (settled || jobs.size || !participants.size) return;
    settled = true; cleanup();
    if (options.signal.aborted || [...participants].some(part => states[part] === "stopped")) reject(new UnityTranslationStopped());
    else if ([...participants].some(part => states[part] === "error")) reject(new Error([...participants].filter(part => states[part] === "error").map(part => `${part === "text" ? "2.1" : "2.2"}：${failures.get(part)}`).join("；")));
    else resolve();
  };
  const abort = () => { for (const controller of controllers.values()) controller.abort(); };
  options.signal.addEventListener("abort", abort, { once: true });
  return {
    start(part: UnityTranslationPart) {
      if (settled || options.signal.aborted || jobs.has(part)) return false;
      participants.add(part);
      if (states[part] === "done" || states[part] === "skipped") { queueMicrotask(check); return false; }
      const controller = new AbortController(); controllers.set(part, controller); failures.delete(part); skipped.delete(part); change(part, "running");
      const job = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return options.run(part, controller); }).then(() => {
        change(part, skipped.has(part) ? "skipped" : controller.signal.aborted ? "stopped" : "done");
      }, error => {
        if (skipped.has(part)) change(part, "skipped");
        else if (controller.signal.aborted || options.signal.aborted) change(part, "stopped");
        else { const message = error instanceof Error ? error.message : String(error); failures.set(part, message); change(part, "error", message); }
      }).finally(() => { jobs.delete(part); controllers.delete(part); check(); });
      jobs.set(part, job); return true;
    },
    stop(part: UnityTranslationPart) { controllers.get(part)?.abort(); },
    async skip(part: UnityTranslationPart) {
      if (settled) return;
      participants.add(part); skipped.add(part); controllers.get(part)?.abort();
      const job = jobs.get(part);
      if (job) await job;
      else { change(part, "skipped"); check(); }
    },
    isStopping(part: UnityTranslationPart) { return controllers.get(part)?.signal.aborted || false; },
    state(part: UnityTranslationPart) { return states[part]; },
    wait(parts: UnityTranslationPart[]) { for (const part of parts) this.start(part); return finished; },
  };
}
