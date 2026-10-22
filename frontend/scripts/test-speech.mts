import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const source = (name: string) => readFileSync(new URL(`../src/speech/${name}.ts`, import.meta.url), "utf8");
const helper = await import("data:text/javascript;base64," + Buffer.from(compile(source("transcription"))).toString("base64"));
const { normalizeSpeechChunks, exportSpeech, formatSpeechTime } = helper;
assert.deepEqual(helper.estimateSpeechProgress(100, 20, 0, 10000), { percent: 20, remainingSeconds: 40 });
assert.deepEqual(helper.estimateSpeechProgress(100, 60, 50, 5000), { percent: 60, remainingSeconds: 20 });
assert.equal(helper.estimateSpeechProgress(100, 50, 50, 1000).remainingSeconds, null, "续传首段完成前不猜测速度");
assert.deepEqual(helper.estimateSpeechProgress(100, 100, 50, 5000), { percent: 100, remainingSeconds: 0 });
assert.equal(formatSpeechTime(59.9996), "00:01:00,000");
assert.equal(formatSpeechTime(3601.002, "."), "01:00:01.002");
const cues = normalizeSpeechChunks([
  { timestamp: [0, 2.2], text: " 你好 " },
  { timestamp: [2, null], text: "第二句" },
  { timestamp: [null, 8], text: "无起点" },
  { timestamp: [8, null], text: "尾句" },
], 10);
assert.deepEqual(cues, [
  { start: 0, end: 2.2, text: "你好" }, { start: 2.2, end: 8, text: "第二句" }, { start: 8, end: 10, text: "尾句" },
]);
const fixture = { text: "编辑后的字幕\nNext line", cues: [{ start: 0.125, end: 1.5, text: "编辑后的字幕" }, { start: 2, end: 3, text: "Next line" }] };
assert.equal(exportSpeech(fixture, "txt"), "编辑后的字幕\nNext line\n");
assert.match(exportSpeech(fixture, "srt"), /^1\n00:00:00,125 --> 00:00:01,500\n编辑后的字幕/);
assert.match(exportSpeech(fixture, "vtt"), /^WEBVTT\n\n1\n00:00:00\.125/);
assert.equal(exportSpeech({ text: "没有时间戳", cues: [] }, "txt"), "没有时间戳\n");
assert.throws(() => exportSpeech({ text: "text", cues: [] }, "srt"), /时间戳/);

const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: any; onerror: any; onmessageerror: any;
  sent: any[] = []; terminated = false;
  constructor() { workers.push(this); }
  postMessage(data: any, transfer: any) { this.sent.push({ data, transfer }); }
  terminate() { this.terminated = true; }
}
const clientJs = compile(source("client")).replace(/^export /gm, "").replaceAll("import.meta.url", "'https://fixture/client.js'");
const { SpeechClient } = new Function("Worker", "document", `${clientJs};return { SpeechClient };`)(FakeWorker, { baseURI: "https://tauri.localhost/" });
const client = new SpeechClient();
const updates: unknown[] = [];
const model = helper.SPEECH_MODELS[0].id;
const pcm = new Float32Array(16000);
const first = client.transcribe(pcm, model, "auto", (p: unknown) => updates.push(p), () => {});
assert.equal(workers[0].sent[0].transfer[0], pcm.buffer);
workers[0].onmessage({ data: { id: 1, type: "progress", progress: { phase: "recognize", message: "work" } } });
workers[0].onmessage({ data: { id: 1, type: "result", result: fixture } });
assert.deepEqual(await first, fixture); assert.equal(updates.length, 1);
const second = client.transcribe(new Float32Array(4), model, "chinese", () => {}, () => {});
assert.equal(workers.length, 1, "reuse downloaded model and worker");
const obsolete = workers[0].onmessage;
const cancelled = assert.rejects(second, { name: "AbortError" });
client.release(); await cancelled; assert.equal(workers[0].terminated, true);
const third = client.transcribe(new Float32Array(4), model, "auto", () => {}, () => {});
obsolete({ data: { id: 2, type: "result", result: { text: "old", cues: [] } } });
workers[1].onmessage({ data: { id: 3, type: "result", result: fixture } });
assert.deepEqual(await third, fixture, "obsolete worker cannot resolve a new job");
client.release();

// Exercise the production worker entry point with a local pipeline fixture.
const messages: any[] = [];
const workerSelf: any = { postMessage: (message: any) => messages.push(message) };
let options: any, builds = 0;
const wasm: any = {};
const mockPipe: any = async (_pcm: Float32Array, kwargs: any) => {
  options = kwargs; kwargs.streamer.options.callback_function("hello"); kwargs.streamer.options.on_finalize();
  return { text: "hello", chunks: [{ text: "hello", timestamp: [0, null] }] };
};
mockPipe.tokenizer = {};
mockPipe.model = { sessions: { decoder_model_merged: { inputNames: [] } } };
const dependencies = { env: { backends: { onnx: { wasm } } },
  pipeline: async () => { builds++; return mockPipe; },
  WhisperTextStreamer: class { options: any; constructor(_tokenizer: any, options: any) { this.options = options; } put(_value: unknown) {} },
  Tensor: class { data: unknown; dims: unknown; constructor(_type: string, data: unknown, dims: unknown) { this.data = data; this.dims = dims; } },
};
const workerJs = compile(source("worker"))
  .replace(/^import .*?from "\.\/transcription";\s*/m, "")
  .replace('import("@huggingface/transformers")', 'getDependencies()')
  .replace(/^export \{\};?$/gm, "");
new Function("SPEECH_MODELS", "normalizeSpeechChunks", "self", "getDependencies", workerJs)(helper.SPEECH_MODELS, normalizeSpeechChunks, workerSelf, async () => dependencies);
await workerSelf.onmessage({ data: { id: 1, pcm, model, language: "auto", assetBase: "https://tauri.localhost/" } });
assert.equal(options.task, "transcribe"); assert.equal(options.language, undefined);
assert.equal(options.return_timestamps, true); assert.equal(options.stride_length_s, 5);
assert.equal(wasm.wasmPaths.wasm, "https://tauri.localhost/manga-ort/ort-wasm-simd-threaded.asyncify.wasm");
assert.deepEqual(messages.at(-1).result.cues, [{ start: 0, end: 1, text: "hello" }]);
await workerSelf.onmessage({ data: { id: 2, pcm, model, language: "japanese", assetBase: "https://tauri.localhost/" } });
assert.equal(builds, 1); assert.equal(options.language, "japanese");
const englishWorker: any = { postMessage() {} };
new Function("SPEECH_MODELS", "normalizeSpeechChunks", "self", "getDependencies", workerJs)(helper.SPEECH_MODELS, normalizeSpeechChunks, englishWorker, async () => dependencies);
await englishWorker.onmessage({ data: { id: 1, pcm, model: helper.SPEECH_MODELS.find((item: any) => item.englishOnly).id, language: "auto", assetBase: "https://tauri.localhost/" } });
assert.equal(options.task, undefined); assert.equal(options.language, undefined, "English-only models reject multilingual generation arguments");
mockPipe.model.sessions.decoder_model_merged.inputNames = ["cache_position"];
mockPipe.model.prepare_inputs_for_generation = (ids: bigint[][], inputs: any) => ({ decoder_input_ids: { dims: [1, inputs.past_key_values ? 1 : ids[0].length] } });
const positionWorker: any = { postMessage() {} };
new Function("SPEECH_MODELS", "normalizeSpeechChunks", "self", "getDependencies", workerJs)(helper.SPEECH_MODELS, normalizeSpeechChunks, positionWorker, async () => dependencies);
await positionWorker.onmessage({ data: { id: 1, pcm, model, language: "chinese", assetBase: "https://tauri.localhost/" } });
assert.deepEqual([...mockPipe.model.prepare_inputs_for_generation([[2n,3n,4n]], {}).cache_position.data], [0n,1n,2n]);
assert.deepEqual([...mockPipe.model.prepare_inputs_for_generation([[2n,3n,4n,5n]], {past_key_values:true}).cache_position.data], [3n]);
console.log("Speech: timestamp boundaries, SRT/VTT/TXT, worker progress/model reuse, transfer and stale cancellation passed");

// Optional real browser/ONNX smoke test. Uses a public spoken-audio fixture,
// an isolated browser profile, and the emitted production worker.
if (process.argv.includes("--browser")) {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, readdirSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve, join } = await import("node:path");
  const root = resolve("dist");
  const fixtureAudio = process.env.SPEECH_TEST_FIXTURE;
  const testModel = process.env.SPEECH_TEST_MODEL || "onnx-community/whisper-base";
  assert.ok(helper.SPEECH_MODELS.some((model: any) => model.id === testModel));
  const workerFile = readdirSync(join(root, "assets")).find(name => name.endsWith(".js") && readFileSync(join(root, "assets", name), "utf8").includes("正在本地识别并生成时间戳"));
  assert.ok(workerFile, "Build the frontend before running the browser smoke test");
  const html = `<!doctype html><meta charset="utf-8"><script type="module">
    window.outcome = { status: 'loading' }; window.ticks = 0; let recognitionTicks; setInterval(() => window.ticks++, 50);
    try {
      const response = await fetch('${fixtureAudio ? "/fixture.wav" : "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav"}');
      if (!response.ok) throw Error('Audio fixture HTTP ' + response.status);
      const context = new AudioContext({ sampleRate: 16000 });
      const audio = await context.decodeAudioData(await response.arrayBuffer());
      const pcm = audio.getChannelData(0).slice(); await context.close();
      const worker = new Worker('/assets/${workerFile}', { type: 'module' });
      worker.onerror = e => { window.outcome = { status: 'error', message: e.message }; worker.terminate(); };
      worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'progress') { if (m.progress.phase === 'recognize' && recognitionTicks === undefined) recognitionTicks = window.ticks; window.outcome = { status: 'working', progress: m.progress }; }
        if (m.type === 'error') { window.outcome = { status: 'error', message: m.message }; worker.terminate(); }
        if (m.type === 'result') { window.outcome = { status: 'done', result: m.result, ticks: window.ticks, recognitionTicks: window.ticks - recognitionTicks }; worker.terminate(); }
      };
      worker.postMessage({ id: 1, model: '${testModel}', language: 'auto', pcm, assetBase: location.origin + '/' }, [pcm.buffer]);
    } catch (e) { window.outcome = { status: 'error', message: e.message }; }
  </script>`;
  const server = createServer((req, res) => {
    if (req.url === "/fixture.wav" && fixtureAudio) { res.setHeader("Content-Type", "audio/wav"); res.end(readFileSync(fixtureAudio)); return; }
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end(html); return; }
    const path = resolve(root, "." + decodeURIComponent(req.url!.split("?")[0]));
    if (!path.startsWith(root + "\\") || !existsSync(path)) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", path.endsWith(".wasm") ? "application/wasm" : "application/javascript");
    res.end(readFileSync(path));
  });
  await new Promise<void>(r => server.listen(Number(process.env.SPEECH_TEST_PORT) || 0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const profile = process.env.SPEECH_TEST_PROFILE || mkdtempSync(join(tmpdir(), "llmchat-speech-browser-"));
  const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let socket: WebSocket | undefined;
  try {
    const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(Error("Chrome DevTools did not start")), 15000);
      chrome.on("error", reject);
      chrome.once("exit", code => { clearTimeout(timeout); reject(Error(`Test Chrome exited: ${code}`)); });
      chrome.stderr!.on("data", data => { output += String(data); const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); resolveEndpoint(match[1]); } });
    });
    const targets = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json() as any[];
    socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
    await new Promise<void>((r, j) => { socket!.onopen = () => r(); socket!.onerror = j; });
    let sequence = 0;
    const replies = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    socket.onclose = () => { for (const job of replies.values()) job.reject(Error("Test browser connection closed")); replies.clear(); };
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); const job = replies.get(message.id); if (job) { replies.delete(message.id); if (message.error) job.reject(Error(message.error.message)); else job.resolve(message.result); } };
    const command = (method: string, params: unknown) => new Promise<any>((resolveReply, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { replies.delete(id); reject(Error(`Browser command timed out: ${method}`)); }, 10000);
      replies.set(id, { resolve: value => { clearTimeout(timer); resolveReply(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    console.log("Test browser connected");
    await command("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    const deadline = Date.now() + 240000;
    let outcome: any;
    let previousMessage = "";
    while (Date.now() < deadline) {
      const response = await command("Runtime.evaluate", { expression: "window.outcome", returnByValue: true });
      outcome = response.result.value;
      const message = outcome?.progress?.message ?? outcome?.status;
      if (message && message !== previousMessage) { console.log(message); previousMessage = message; }
      if (outcome?.status === "done" || outcome?.status === "error") break;
      await new Promise(r => setTimeout(r, 1000));
    }
    assert.equal(outcome?.status, "done", JSON.stringify(outcome));
    assert.match(outcome.result.text, new RegExp(process.env.SPEECH_TEST_EXPECT || "country|americans|fellow", "i"));
    assert.ok(outcome.result.cues.length > 0);
    assert.ok(outcome.recognitionTicks > 5, "UI event loop remains responsive during inference");
    console.log("Real browser Whisper passed:", JSON.stringify(outcome));
  } finally { socket?.close(); chrome.kill(); server.closeAllConnections(); server.close(); }
}
