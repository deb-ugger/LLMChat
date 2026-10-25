import { useSyncExternalStore } from "react";
import { SpeechClient } from "./client";
import { speechNative, type SpeechJob, type SpeechJobOptions } from "./native";
import { getSpeechPreferences, downloadSpeechModel, cancelSpeechModelDownload, setSpeechModelInUse, refreshSpeechModels } from "./models";
import { planSpeechCommit, nextSpeechWindow, validateSpeechRanges, type SpeechRange, type SpeechResult } from "./transcription";
import { createSpeechOnline } from "./online";

export type SpeechQueueItem = SpeechJob & { root: string; showOutput: boolean; status: "ready" | "queued" | "running" | "pausing" | "paused" | "resetting" | "done" | "error" | "cancelling"; message: string; elapsedMs: number; runningSince?: number; processingStartedAt?: number; startedOffset?: number; revision: number };
type Snapshot = { items: SpeechQueueItem[]; importing: boolean; error: string };
type Running = { client: SpeechClient; controller: AbortController; reason: "pause" | "cancel" | null; settled: Promise<void>; started: number };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const abort = () => new DOMException("任务已暂停或取消", "AbortError");
const chineseConverters: Partial<Record<SpeechJobOptions["chineseScript"], (text: string) => string>> = {};
function jobOptions(): SpeechJobOptions {
  const pref = getSpeechPreferences();
  return { model: pref.model, language: pref.language, formats: [...pref.formats], chineseScript: pref.chineseScript,
    processing: { mode: pref.mode ?? "local", provider: pref.onlineProvider ?? "google", model: pref.onlineModel ?? "gemini-3.8-flash", proofread: pref.proofread ?? false, proofreadModel: pref.proofreadModel ?? "" } };
}

async function convertChinese(output: SpeechResult, script: SpeechJobOptions["chineseScript"], selectedLanguage: string): Promise<SpeechResult> {
  if (script === "original" || !["zh", "chinese"].includes(output.language || selectedLanguage)) return output;
  const { Converter } = await import("opencc-js");
  const convert = chineseConverters[script] ??= Converter(script === "simplified" ? { from: "t", to: "cn" } : { from: "cn", to: "tw" });
  return { ...output, text: convert(output.text), cues: output.cues.map(cue => ({ ...cue, text: convert(cue.text) })) };
}

/** Owns the queue; the UI only subscribes to light job summaries. */
export class SpeechQueue {
  private state: Snapshot = { items: [], importing: false, error: "" };
  private listeners = new Set<() => void>();
  private running = new Map<string, Running>();
  private staging = new Map<string, Promise<void>>();
  private preparation = Promise.resolve();
  private imports = Promise.resolve();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private publish(patch: Partial<Snapshot>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private patch(id: string, patch: Partial<SpeechQueueItem>) { this.publish({ items: this.state.items.map(item => item.id === id ? { ...item, ...patch } : item) }); }
  clearError() { this.publish({ error: "" }); }
  setShowOutput(id: string, showOutput: boolean) { this.patch(id, { showOutput }); }
  setRanges(id: string, ranges: SpeechRange[] | undefined) {
    const item = this.state.items.find(item => item.id === id);
    if (!item || item.folder || !["ready", "error"].includes(item.status)) return;
    this.patch(id, { options: { ...item.options, ranges: ranges?.map(range => ({ ...range })) } });
  }

  add(paths: string[]): Promise<void> {
    const run = async () => {
      this.publish({ importing: true, error: "" });
      const errors: string[] = [];
      for (const path of paths) {
        try {
          const source = await speechNative.probe(path);
          const pref = getSpeechPreferences();
          const item: SpeechQueueItem = { id: crypto.randomUUID(), source, root: pref.outputRoot, folder: "", offset: 0, cueCount: 0,
            options: jobOptions(),
            status: "ready", showOutput: true, message: "等待开始", elapsedMs: 0, revision: 0 };
          this.publish({ items: [...this.state.items, item] });
        } catch (error) { errors.push(`${path.split(/[\\/]/).at(-1)}：${message(error)}`); }
      }
      this.publish({ importing: false, error: errors.join("\n") });
    };
    this.imports = this.imports.then(run, run);
    return this.imports;
  }
  async restore(root: string) {
    if (!root) return;
    const jobs = await speechNative.list(root);
    const known = new Set(this.state.items.map(item => item.id));
    this.publish({ items: [...this.state.items, ...jobs.filter(job => !known.has(job.id)).map(job => {
      const done = job.offset >= job.source.duration - 0.01;
      return { ...job, root, status: done ? "done" as const : "paused" as const,
        showOutput: true, message: done ? "识别完成，输出文件已保存" : "可从已保存断点继续", elapsedMs: 0, revision: 0 };
    })] });
  }
  start(id?: string) {
    const pref = getSpeechPreferences();
    const eligible = (item: SpeechQueueItem) => (!id || item.id === id) && ["ready", "paused", "error"].includes(item.status);
    const createsNew = this.state.items.some(item => eligible(item) && !item.folder);
    try { for (const item of this.state.items.filter(item => eligible(item) && !item.folder)) validateSpeechRanges(item.options.ranges, item.source.duration); }
    catch (error) { this.publish({ error: message(error) }); return; }
    if (createsNew && !pref.formats.length) { this.publish({ error: "至少选择一种输出格式" }); return; }
    if (createsNew && !pref.outputRoot) { this.publish({ error: "请选择输出目录" }); return; }
    if (createsNew && pref.mode === "online" && !pref.onlineModel.trim()) { this.publish({ error: "请选择在线识别模型" }); return; }
    if (createsNew && pref.proofread && !pref.proofreadModel.trim()) { this.publish({ error: "请选择校对模型" }); return; }
    this.publish({ error: "", items: this.state.items.map(item => {
      if (!eligible(item)) return item;
      return { ...item, status: "queued", message: "排队等待",
        ...(!item.folder ? { root: pref.outputRoot, options: { ...jobOptions(), ranges: item.options.ranges } } : {}) };
    }) });
    for (const item of this.state.items.filter(job => job.status === "queued" && !job.folder && !this.staging.has(job.id))) {
      const staged = speechNative.create(item.root, item.id, item.source, item.options)
        .then(saved => this.patch(item.id, saved))
        .catch(error => this.patch(item.id, { status: "error", message: message(error) }))
        .finally(() => { this.staging.delete(item.id); this.pump(); });
      this.staging.set(item.id, staged);
    }
    this.pump();
  }
  pump() {
    const limit = getSpeechPreferences().concurrency;
    while (this.running.size < limit) {
      const item = this.state.items.find(job => job.status === "queued" && job.folder && !this.staging.has(job.id) && !this.running.has(job.id));
      if (!item) break;
      const run: Running = { client: new SpeechClient(), controller: new AbortController(), reason: null, settled: Promise.resolve(), started: performance.now() };
      this.running.set(item.id, run);
      this.patch(item.id, { status: "running", message: "准备任务", runningSince: run.started });
      setSpeechModelInUse(this.state.items.find(job => this.running.has(job.id) && job.options.processing?.mode !== "online")?.options.model ?? null);
      run.settled = this.execute(item, run).finally(() => {
        run.client.release(); this.running.delete(item.id);
        setSpeechModelInUse(this.state.items.find(job => this.running.has(job.id) && job.options.processing?.mode !== "online")?.options.model ?? null);
        this.pump();
      });
    }
  }
  private async execute(original: SpeechQueueItem, run: Running) {
    let item = original;
    const started = run.started;
    const check = () => { if (run.reason) throw abort(); };
    try {
      const saved = await speechNative.resume(item.folder);
      item = { ...item, ...saved }; this.patch(item.id, saved); check();
      const processing = item.options.processing;
      const online = processing?.mode === "online" || processing?.proofread ? await createSpeechOnline(item.options, run.controller.signal) : null;
      check();
      if (processing?.mode !== "online") {
        const ready = this.preparation.then(async () => {
          check(); this.patch(item.id, { message: "准备识别模型" });
          await downloadSpeechModel(item.options.model);
        });
        this.preparation = ready.catch(() => {});
        await ready; check();
      }
      this.patch(item.id, { processingStartedAt: performance.now(), startedOffset: item.offset });
      while (item.offset < item.source.duration - 0.01) {
        const window = nextSpeechWindow(item.options.ranges, item.source.duration, item.offset);
        this.patch(item.id, { message: `解码 ${window.start.toFixed(1)} 秒处的音频` });
        const pcm = await speechNative.decode(item.folder, window.start); check();
        const length = pcm.length / 16000;
        this.patch(item.id, { message: processing?.mode === "online" ? "正在在线识别音频" : "正在识别音频" });
        let output = processing?.mode === "online" ? await online!.recognize(pcm) : await run.client.transcribe(pcm, item.options.model, item.options.language,
          progress => { if (!run.reason) this.patch(item.id, { message: progress.message }); },
          () => {}, false);
        check();
        if (processing?.proofread) {
          this.patch(item.id, { message: "正在进行大模型校对" });
          output = await online!.proofread(output); check();
        }
        const converted = await convertChinese(output, item.options.chineseScript, item.options.language); check();
        const final = window.start + length >= window.rangeEnd - 0.1;
        const chunk = planSpeechCommit(converted, window.start, Math.min(length, window.end - window.start), final);
        // Checkpoints span skipped gaps; cue timestamps stay on the original timeline.
        chunk.from = item.offset;
        if (final) chunk.to = window.lastRange ? item.source.duration : window.rangeEnd;
        const committed = await speechNative.commit(item.folder, chunk);
        item = { ...item, ...committed };
        this.patch(item.id, { ...committed, revision: (this.state.items.find(job => job.id === item.id)?.revision ?? 0) + 1 });
        check();
      }
      this.patch(item.id, { status: "done", message: "识别完成，输出文件已保存" });
    } catch (error) {
      if (run.reason === "pause") this.patch(item.id, { status: "paused", message: "已暂停，断点已保留" });
      else if (run.reason !== "cancel") this.patch(item.id, { status: "error", message: message(error) });
    } finally {
      this.patch(item.id, { elapsedMs: original.elapsedMs + performance.now() - started, runningSince: undefined, processingStartedAt: undefined, startedOffset: undefined });
      void refreshSpeechModels();
    }
  }
  pause(id?: string) {
    const ids = this.state.items.filter(item => (!id || item.id === id) && ["queued", "running"].includes(item.status)).map(item => item.id);
    for (const key of ids) {
      const run = this.running.get(key);
      if (run) { run.reason = "pause"; run.controller.abort(); run.client.release(); }
      this.patch(key, { status: run ? "pausing" : "paused", message: run ? "正在暂停，等待本段写入结束" : "已暂停，已写入的片段保留" });
    }
    if (![...this.running.values()].some(run => !run.reason)) cancelSpeechModelDownload();
  }
  async reset(id: string): Promise<string | undefined> {
    const item = this.state.items.find(job => job.id === id);
    if (item?.status !== "paused") return;
    this.patch(id, { status: "resetting", message: "正在清除进度和任务输出" });
    try {
      await this.running.get(id)?.settled;
      await this.staging.get(id);
      const current = this.state.items.find(job => job.id === id)!;
      if (current.folder) await speechNative.cancel(current.folder);
      // A fresh ID avoids reusing a folder that contains user-added files.
      const nextId = crypto.randomUUID();
      this.patch(id, { id: nextId, folder: "", offset: 0, cueCount: 0, status: "ready", message: "等待开始",
        elapsedMs: 0, runningSince: undefined, processingStartedAt: undefined, startedOffset: undefined, revision: current.revision + 1 });
      return nextId;
    } catch (error) { this.patch(id, { status: "paused", message: `清除进度失败：${message(error)}` }); }
  }
  async cancel(id: string) {
    const run = this.running.get(id);
    this.patch(id, { status: "cancelling", message: "正在取消并清理生成文件" });
    if (run) {
      run.reason = "cancel"; run.controller.abort(); run.client.release();
      if (![...this.running.values()].some(active => !active.reason)) cancelSpeechModelDownload();
      await run.settled;
    }
    await this.staging.get(id);
    const current = this.state.items.find(item => item.id === id);
    try {
      if (current?.folder) await speechNative.cancel(current.folder);
      this.publish({ items: this.state.items.filter(item => item.id !== id) });
    } catch (error) { this.patch(id, { status: "error", message: `清理失败：${message(error)}` }); }
  }
}

export const speechQueue = new SpeechQueue();
export const useSpeechQueue = () => useSyncExternalStore(speechQueue.subscribe, speechQueue.snapshot);
