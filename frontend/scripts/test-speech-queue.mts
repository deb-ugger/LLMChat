import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const compile = (s: string) => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const helpers = await import("data:text/javascript;base64," + Buffer.from(compile(readFileSync(new URL("../src/speech/transcription.ts", import.meta.url), "utf8"))).toString("base64"));
const model = helpers.SPEECH_MODELS[0].id;
const pref: any = { model, concurrency: 2, formats: ["srt", "txt"], outputRoot: "fixture-root", language: "english", chineseScript: "simplified", showOutput: true };
const durable = new Map<string, any>();
const commits: any[] = [], seeks: Array<{ name: string; offset: number }> = [], removed: string[] = [];
let blockCreate: Promise<void> | null = null;
const native = {
  probe: async (path: string) => ({ path, name: path, duration: path === "short" ? 11 : 60, size: 1, modified: 1 }),
  create: async (_root: string, id: string, source: any, options: any) => {
    if (blockCreate) await blockCreate;
    const item = { id, folder: id, source, options, offset: 0, cueCount: 0 };
    durable.set(id, item); return { ...item };
  },
  resume: async (folder: string) => ({ ...durable.get(folder) }),
  decode: async (folder: string, offset: number) => {
    const job = durable.get(folder); seeks.push({ name: job.source.name, offset });
    const pcm = new Float32Array(Math.min(30, job.source.duration - offset) * 16000);
    pcm[0] = job.source.name === "first" ? 1 : job.source.name === "second" ? 2 : 3; return pcm;
  },
  commit: async (folder: string, chunk: any) => {
    const job = durable.get(folder); assert.equal(chunk.from, job.offset);
    commits.push({ folder, chunk });
    const next = { ...job, offset: chunk.to, cueCount: job.cueCount + chunk.cues.length };
    durable.set(folder, next); return next;
  },
  cancel: async (folder: string) => { removed.push(folder); durable.delete(folder); },
  list: async () => [...durable.values()].map(job => ({ ...job })),
};
const active = new Map<number, { finish: (result?: any) => void }>();
let peak = 0;
class Client {
  code = 0; reject?: (e: Error) => void;
  transcribe(pcm: Float32Array) {
    this.code = pcm[0];
    return new Promise((resolve, reject) => {
      this.reject = reject;
      active.set(this.code, { finish: result => {
        active.delete(this.code); this.reject = undefined;
        resolve(result || { text: "first tail", language: "en", cues: [{ start: 0, end: 20, text: "first" }, { start: 20, end: 30, text: "tail" }] });
      } }); peak = Math.max(peak, active.size);
    });
  }
  release() { if (this.reject) { active.delete(this.code); this.reject(new DOMException("cancelled", "AbortError")); this.reject = undefined; } }
}
const source = readFileSync(new URL("../src/speech/queue.ts", import.meta.url), "utf8");
const js = compile(source).replace(/^import .*;\s*/gm, "").replace(/^export /gm, "");
let downloads = 0;
const remoteCalls: Array<{ kind: string; resolve: (value: any) => void; options: any }> = [];
const mockOnline = async (options: any, signal: AbortSignal) => {
  const pending = (kind: string) => new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("cancel", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    remoteCalls.push({ kind, options, resolve: result => { signal.removeEventListener("abort", abort); resolve(result); } });
  });
  return { recognize: () => pending("recognize"), proofread: () => pending("proofread") };
};
const { SpeechQueue, convertChinese } = new Function("useSyncExternalStore", "SpeechClient", "speechNative", "getSpeechPreferences", "downloadSpeechModel", "cancelSpeechModelDownload", "setSpeechModelInUse", "refreshSpeechModels", "planSpeechCommit", "createSpeechOnline", `${js}; return { SpeechQueue, convertChinese };`)(
  () => {}, Client, native, () => pref, async () => { downloads++; }, () => {}, () => {}, async () => {}, helpers.planSpeechCommit, mockOnline,
);
const wait = async (condition: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 1)); }
  assert.ok(condition(), "expected asynchronous state was not reached");
};
const queue = new SpeechQueue();
await queue.add(["first", "second", "short"]);
const originalItems = queue.snapshot().items;
queue.setShowOutput(originalItems[0].id, false);
assert.equal(queue.snapshot().items[0].showOutput, false);
assert.equal(queue.snapshot().items[1].showOutput, true, "文件结果显示开关互不影响");
assert.equal(durable.size, 0, "切换结果显示不会提前创建任务输出");
queue.start();
await wait(() => active.size === 2);
const [first, second, short] = queue.snapshot().items;
assert.equal(durable.size, 3, "queued jobs are persisted before execution");
assert.equal(peak, 2, "configured concurrency must bound model workers");
active.get(1)!.finish(); await wait(() => durable.get(first.id).offset === 20 && active.has(1));
queue.pause(first.id); await wait(() => queue.snapshot().items[0].status === "paused");
assert.equal(durable.get(first.id).offset, 20, "pause retains committed breakpoint");
await wait(() => active.has(3));
pref.concurrency = 1;
active.get(3)!.finish({ text: "short", language: "en", cues: [{ start: 0, end: 11, text: "short" }] });
await wait(() => queue.snapshot().items.find((item: any) => item.id === short.id).status === "done");
await queue.cancel(second.id);
assert.ok(removed.includes(second.id)); assert.ok(!durable.has(second.id));
const reopened = new SpeechQueue(); await reopened.restore("fixture-root"); await reopened.restore("fixture-root");
assert.equal(reopened.snapshot().items.length, 1, "list only unfinished jobs and avoid duplicate discovery");
assert.equal(reopened.snapshot().items[0].id, first.id);
assert.equal(reopened.snapshot().items[0].fromHistory, true);
assert.equal(reopened.snapshot().items[0].offset, 20);
reopened.start(); await Promise.resolve();
assert.equal(active.size, 0, "batch start must not silently start historical jobs");
reopened.start(first.id); await wait(() => active.has(1));
assert.equal(reopened.snapshot().items[0].fromHistory, false);
assert.equal(seeks.at(-1)!.offset, 20, "a new queue instance resumes from disk checkpoint");
reopened.pause(first.id); await wait(() => reopened.snapshot().items[0].status === "paused");
pref.formats = []; pref.outputRoot = "";
queue.start(first.id); await wait(() => active.has(1));
assert.deepEqual(durable.get(first.id).options.formats, ["srt", "txt"], "resumed jobs keep their original output settings");
pref.formats = ["srt", "txt"]; pref.outputRoot = "fixture-root";
assert.equal(seeks.filter(item => item.name === "first").at(-1)!.offset, 20, "resume must seek to durable progress");
assert.equal(queue.snapshot().items[0].startedOffset, 20, "ETA starts from the resumed offset");
assert.equal(typeof queue.snapshot().items[0].processingStartedAt, "number");
active.get(1)!.finish(); await wait(() => durable.get(first.id).offset === 40 && active.has(1));
active.get(1)!.finish({ text: "last", language: "en", cues: [{ start: 0, end: 20, text: "last" }] });
await wait(() => queue.snapshot().items[0].status === "done");
assert.equal(queue.snapshot().items[0].processingStartedAt, undefined, "completed jobs do not retain a live timing baseline");
assert.deepEqual(commits.filter(item => item.folder === first.id).map(item => [item.chunk.from, item.chunk.to]), [[0,20],[20,40],[40,60]]);
const restored = new SpeechQueue(); await restored.restore("fixture-root");
assert.equal(restored.snapshot().items.length, 0, "completed jobs do not clutter unfinished history");
// Cancel while the initial task directory is being created: wait, then remove it.
let release!: () => void; blockCreate = new Promise<void>(resolve => release = resolve);
const staged = new SpeechQueue(); await staged.add(["staged"]); staged.start();
const stagedId = staged.snapshot().items[0].id;
const cancelling = staged.cancel(stagedId); release(); await cancelling; blockCreate = null;
assert.ok(!durable.has(stagedId)); assert.equal(staged.snapshot().items.length, 0);

// Reset a paused task, then start with a corrected language and output format.
const resetQueue = new SpeechQueue(); await resetQueue.add(["first"]); resetQueue.start();
await wait(() => active.has(1));
const resetId = resetQueue.snapshot().items[0].id;
await resetQueue.reset(resetId);
assert.equal(resetQueue.snapshot().items[0].status, "running", "running tasks cannot be reset");
active.get(1)!.finish(); await wait(() => durable.get(resetId).offset === 20 && active.has(1));
resetQueue.pause(resetId); await wait(() => resetQueue.snapshot().items[0].status === "paused");
const previous = resetQueue.snapshot().items[0];
const cancelNative = native.cancel;
native.cancel = async () => { throw new Error("文件被占用"); };
await resetQueue.reset(resetId);
assert.equal(resetQueue.snapshot().items[0].status, "paused");
assert.equal(resetQueue.snapshot().items[0].offset, 20, "failed cleanup must not report progress as cleared");
assert.match(resetQueue.snapshot().items[0].message, /文件被占用/);
let finishCleanup!: () => void;
const cleanupWait = new Promise<void>(resolve => finishCleanup = resolve);
native.cancel = async folder => { await cleanupWait; await cancelNative(folder); };
const resetting = resetQueue.reset(resetId);
assert.equal(resetQueue.snapshot().items[0].status, "resetting");
assert.equal(await resetQueue.reset(resetId), undefined, "duplicate reset cannot delete twice");
resetQueue.start(resetId); assert.equal(active.size, 0, "start is unavailable while clearing files");
finishCleanup(); const freshId = await resetting; native.cancel = cancelNative;
const fresh = resetQueue.snapshot().items[0];
assert.notEqual(freshId, resetId, "do not reuse a directory that may retain user-added files");
assert.equal(fresh.source, previous.source, "keep the source audio in the queue");
assert.equal(fresh.status, "ready"); assert.equal(fresh.folder, "");
assert.equal(fresh.offset, 0); assert.equal(fresh.cueCount, 0); assert.equal(fresh.elapsedMs, 0);
assert.equal(fresh.processingStartedAt, undefined); assert.equal(fresh.startedOffset, undefined);
assert.ok(!durable.has(resetId), "old subtitles and checkpoint have been removed");
pref.language = "japanese"; pref.model = helpers.SPEECH_MODELS[2].id; pref.formats = ["vtt"];
resetQueue.start(freshId); await wait(() => active.has(1));
assert.equal(seeks.filter(item => item.name === "first").at(-1)!.offset, 0);
assert.equal(durable.get(freshId).options.language, "japanese");
assert.equal(durable.get(freshId).options.model, pref.model);
assert.deepEqual(durable.get(freshId).options.formats, ["vtt"]);
await resetQueue.cancel(freshId);

// Pausing a queued task can precede the initial directory creation finishing.
blockCreate = new Promise<void>(resolve => release = resolve);
const waitingReset = new SpeechQueue(); await waitingReset.add(["staged"]); waitingReset.start();
const waitingId = waitingReset.snapshot().items[0].id;
waitingReset.pause(waitingId); const pendingReset = waitingReset.reset(waitingId);
release(); await pendingReset; blockCreate = null;
assert.equal(waitingReset.snapshot().items[0].status, "ready");
assert.ok(!durable.has(waitingId), "reset waits for staging before cleaning the created files");
pref.mode = "online"; pref.onlineProvider = "google"; pref.onlineModel = "gemini-test"; pref.proofread = true; pref.proofreadModel = "chat-test";
const beforeDownloads = downloads;
const cloud = new SpeechQueue(); await cloud.add(["short"]); cloud.start();
await wait(() => remoteCalls.length === 1);
const cloudId = cloud.snapshot().items[0].id;
remoteCalls.shift()!.resolve({ text: "raw", language: "en", cues: [{ start: 0, end: 11, text: "raw" }] });
await wait(() => remoteCalls[0]?.kind === "proofread");
assert.equal(durable.get(cloudId).offset, 0, "do not commit before proofreading completes");
remoteCalls.shift()!.resolve({ text: "corrected", language: "en", cues: [{ start: 0, end: 11, text: "corrected" }] });
await wait(() => cloud.snapshot().items[0].status === "done");
assert.equal(downloads, beforeDownloads, "online recognition never downloads a local model");
assert.equal(commits.at(-1).chunk.cues[0].text, "corrected");
assert.equal(commits.at(-1).chunk.cues[0].end, 11);
const pausable = new SpeechQueue(); await pausable.add(["short"]); pausable.start();
await wait(() => remoteCalls.length === 1);
const pauseCloudId = pausable.snapshot().items[0].id;
pausable.pause(pauseCloudId); await wait(() => pausable.snapshot().items[0].status === "paused");
assert.equal(durable.get(pauseCloudId).offset, 0);
remoteCalls.shift();
pref.mode = "local"; pref.proofread = false; pref.onlineModel = "changed";
pausable.start(pauseCloudId); await wait(() => remoteCalls.length === 1);
assert.equal(remoteCalls[0].options.processing.model, "gemini-test", "resume retains online mode and model");
assert.equal(remoteCalls[0].options.processing.proofread, true);
await pausable.cancel(pauseCloudId); remoteCalls.shift();
const simplified = await convertChinese({ text: "臺灣的音樂", language: "zh", cues: [{ start: 0, end: 1, text: "臺灣的音樂" }] }, "simplified", "auto");
assert.equal(simplified.text, "台湾的音乐");
const japanese = { text: "図書館の音楽", language: "ja", cues: [] };
assert.equal(await convertChinese(japanese, "simplified", "auto"), japanese, "Japanese must not be converted to Chinese characters");
console.log("Speech queue: concurrency, pause/resume, reset/restart with changed settings, cleanup failures/races, exact offsets and Chinese conversion passed");
