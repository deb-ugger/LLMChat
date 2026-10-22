import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

let prepareCount = 0;
let prepare: () => Promise<unknown> = async () => { prepareCount++; };
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: any; onerror: any; onmessageerror: any;
  sent: any[] = [];
  terminated = false;
  constructor() { workers.push(this); }
  postMessage(message: any) { this.sent.push(message); }
  terminate() { this.terminated = true; }
  reply(message: any) { this.onmessage?.({ data: message }); }
}
const source = readFileSync(new URL("../src/ocr/mangaOcr.ts", import.meta.url), "utf8")
  .replace('import { API_BASE, api } from "../api";', "")
  .replace("export class", "class")
  .replace("import.meta.url", "'https://fixture/ocr/mangaOcr.ts'");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const LocalMangaOcr = new Function("api", "API_BASE", "Worker", "document", `${js}; return LocalMangaOcr;`)(
  { ensureOcrMode: () => prepare() }, "http://127.0.0.1:17800", FakeWorker, { baseURI: "https://tauri.localhost/" },
);
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const image = new Blob(["fixture"]);
const engine = new LocalMangaOcr();
let ready = 0;
const first = engine.recognize(image, () => ready++);
await settle();
const worker = workers[0];
assert.equal(worker.sent[0].assetBase, "https://tauri.localhost/");
worker.reply({ id: 1, type: "ready" });
assert.equal(ready, 1);
worker.reply({ id: 1, type: "result", text: "テスト" });
assert.equal(await first, "テスト");
const second = engine.recognize(image);
await settle();
assert.equal(workers.length, 1); assert.equal(prepareCount, 1);
const cancelled = assert.rejects(second, /取消/);
await engine.dispose(); await cancelled;
assert.equal(worker.terminated, true);
assert.equal(worker.onmessage, null);
await assert.rejects(engine.recognize(image), /取消/);
// Cancellation before model preparation resolves must not resurrect a worker.
let release!: () => void;
prepare = () => new Promise<void>(r => release = r);
const early = new LocalMangaOcr();
const task = early.recognize(image);
const rejection = assert.rejects(task, /取消/);
await early.dispose(); await rejection;
release(); await settle(); assert.equal(workers.length, 1);
// A worker crash rejects active jobs instead of leaving the UI busy forever.
prepare = async () => {};
const failing = new LocalMangaOcr();
const failed = failing.recognize(image);
const failure = assert.rejects(failed, /fixture crash/);
await settle();
workers[1].onerror({ message: "fixture crash", preventDefault() {} });
await failure; assert.equal(workers[1].terminated, true);
console.log("Manga Worker: reuse, progress, result, early/in-flight cancellation and crash cleanup passed");
