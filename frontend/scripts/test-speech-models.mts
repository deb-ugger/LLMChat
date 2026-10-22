import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const helpers = await import("data:text/javascript;base64," + Buffer.from(compile(readFileSync(new URL("../src/speech/transcription.ts", import.meta.url), "utf8"))).toString("base64"));
const cacheData = new Map<string, Response>();
const response = () => new Response("model-fixture", { headers: { "content-length": "13" } });
const cache = {
  match: async (url: string) => cacheData.get(url)?.clone(),
  put: async (url: string, incoming: Response) => {
    // Cache writes are atomic; a failed stream must not create a complete file.
    const body = await incoming.arrayBuffer();
    cacheData.set(url, new Response(body, { headers: incoming.headers }));
  },
  keys: async () => [...cacheData.keys()].map(url => new Request(url)),
  delete: async (request: Request) => cacheData.delete(request.url),
};
let calls = 0, block = false, clock = 0;
let reached!: () => void;
let didReach = new Promise<void>(resolve => reached = resolve);
const network = async (url: string, options: { signal: AbortSignal }) => {
  calls++;
  if (block && url.endsWith("encoder_model_quantized.onnx")) {
    reached();
    return new Promise<Response>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
  }
  const bytes = new TextEncoder().encode("model-fixture");
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    clock += 200;
    const end = Math.min(bytes.length, offset + 7);
    controller.enqueue(bytes.slice(offset, end)); offset = end;
    if (offset === bytes.length) controller.close();
  } }), { headers: { "content-length": String(bytes.length) } });
};
const local = new Map<string, string>();
const js = compile(readFileSync(new URL("../src/speech/models.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\s*/gm, "").replace(/^export /gm, "");
const models = new Function("useEffect", "useSyncExternalStore", "SPEECH_MODELS", "caches", "localStorage", "window", "fetch", "performance", `${js}; return {readSpeechModelStatus,downloadSpeechModel,uninstallSpeechModel,cancelSpeechModelDownload,selectSpeechModel,setSpeechModelInUse,subscribe,state:()=>state,files:SPEECH_MODEL_FILES};`)(
  () => {}, () => {}, helpers.SPEECH_MODELS, { open: async () => cache },
  { getItem: (key: string) => local.get(key), setItem: (key: string, value: string) => local.set(key, value) },
  { dispatchEvent() {} }, network, { now: () => clock },
);
const progress: any[] = [];
models.subscribe(() => { const download = models.state().download; if (download) progress.push({ ...download }); });
const tiny = helpers.SPEECH_MODELS[0].id, base = helpers.SPEECH_MODELS[1].id;
const url = (model: string, file: string) => `https://huggingface.co/${model}/resolve/main/${file}`;
let rows = await models.readSpeechModelStatus(cache);
assert.ok(rows.every((row: any) => !row.installed && row.files === 0));
cacheData.set(url(tiny, models.files[0]), response());
rows = await models.readSpeechModelStatus(cache);
assert.equal(rows[0].files, 1); assert.equal(rows[0].installed, false);
await models.downloadSpeechModel(tiny);
assert.equal(calls, models.files.length - 1);
assert.equal(models.state().rows[0].installed, true);
assert.equal(models.state().rows[0].bytes, 13 * models.files.length);
assert.ok(progress.some(value => value.loadedBytes > 0 && value.loadedBytes < value.totalBytes), "streamed byte progress is visible before completion");
assert.ok(progress.some(value => value.bytesPerSecond > 0), "download speed is measured from streamed bytes");
assert.ok(progress.some(value => value.loadedBytes === 13 && value.totalBytes === 13), "current file reaches its actual byte total");
await models.downloadSpeechModel(tiny);
assert.equal(calls, models.files.length - 1, "complete cache must not redownload");
models.selectSpeechModel(tiny); assert.equal(models.state().selected, tiny);
models.setSpeechModelInUse(tiny);
models.selectSpeechModel(base); assert.equal(models.state().selected, tiny);
await assert.rejects(models.uninstallSpeechModel(tiny), /停止/);
models.setSpeechModelInUse(null);
block = true;
const pending = models.downloadSpeechModel(base);
const stopped = assert.rejects(pending, { name: "AbortError" });
await didReach; models.cancelSpeechModelDownload(); await stopped;
assert.equal(models.state().download, null);
assert.equal(models.state().rows[1].installed, false);
assert.equal(models.state().rows[1].files, 5, "only complete files survive cancellation");
block = false;
await models.downloadSpeechModel(base);
assert.equal(models.state().rows[1].installed, true);
await models.uninstallSpeechModel(tiny);
assert.equal(models.state().rows[0].files, 0);
assert.equal(models.state().rows[1].installed, true, "uninstall must preserve other models");
console.log("Speech models: real-file status, partial/resume, cache reuse, in-use protection and scoped uninstall passed");
