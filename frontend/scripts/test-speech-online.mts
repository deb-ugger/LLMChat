import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const online: any = {}, requests: any[] = [];
let fail = false, block = false, blocked = false;
const connection = { useGeneral: false, apiUrl: "http://fixture/chat/completions", apiKey: "fixture-key" };
const fetchMock = async (url: string, init: any) => {
  const body = JSON.parse(init.body); requests.push({ url, body });
  if (url.endsWith("/cancel")) return { ok: true, json: async () => ({ ok: true }) };
  if (block) {
    blocked = true;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  }
  if (fail) return { ok: false, status: 401, json: async () => ({ error: "API Key 无效" }) };
  const content = body.operation === "recognize" ? { language: "zh", cues: [{ start: 0, end: 1, text: "错子" }] }
    : { cues: body.cues.map((_cue: any, id: number) => ({ id, text: "错字" })) };
  return { ok: true, json: async () => ({ content: JSON.stringify(content) }) };
};
vm.runInNewContext(compile(readFileSync(new URL("../src/speech/online.ts", import.meta.url), "utf8")), {
  exports: online, fetch: fetchMock, crypto, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout, btoa,
  require: (name: string) => name === "../api" ? { API_BASE: "http://localhost", api: { getSettings: async () => ({ model: "chat-model", apiUrl: "http://chat/", apiKey: "chat-key" }) } }
    : name === "../modelPresets" ? { vendorOfModel: () => "DeepSeek", loadVendorProfiles: () => ({ Google: { apiUrl: "http://google/", apiKey: "google-key" } }), resolveFeatureLlm: (_settings: any, model: string) => ({ apiUrl: "http://chat/", apiKey: "chat-key", model }) }
    : { getSpeechConnection: () => connection, SPEECH_ONLINE_PROVIDERS: { google: { apiUrl: "http://google/" } } },
});
const wav = Buffer.from(online.encodeSpeechWav(new Float32Array([-2, -1, 0, 1, 2])), "base64");
assert.equal(wav.toString("ascii", 0, 4), "RIFF"); assert.equal(wav.readUInt32LE(24), 16000);
assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readInt16LE(44), -32768); assert.equal(wav.readInt16LE(52), 32767);
const raw = { language: "zh", text: "错子", cues: [{ start: 0.1, end: 0.9, text: "错子" }] };
const corrected = online.applySpeechProofread(raw, JSON.stringify({ cues: [{ id: 0, text: "错字", start: 5, end: 9 }] }));
assert.equal(corrected.cues[0].start, 0.1); assert.equal(corrected.cues[0].end, 0.9); assert.equal(corrected.text, "错字");
for (const invalid of [{ cues: [] }, { cues: [{ id: 1, text: "错字" }] }, { cues: [{ id: 0, text: "" }] }]) assert.throws(() => online.applySpeechProofread(raw, JSON.stringify(invalid)));
for (const cues of [[{ start: -1, end: 1, text: "a" }], [{ start: 0, end: 2, text: "a" }], [{ start: 0, end: 0.8, text: "a" }, { start: 0.5, end: 1, text: "b" }]]) assert.throws(() => online.parseOnlineSpeech(JSON.stringify({ cues }), 1));
assert.throws(() => online.parseOnlineSpeech("not JSON", 1), /JSON/);
assert.equal(online.parseOnlineSpeech('```json\n{"cues":[]}\n```', 1).cues.length, 0);
const options = { model: "local", language: "chinese", formats: ["srt"], chineseScript: "simplified", processing: { mode: "online", provider: "google", model: "gemini-test", proofread: true, proofreadModel: "chat-model" } };
const controller = new AbortController();
const client = await online.createSpeechOnline(options, controller.signal);
const output = await client.recognize(new Float32Array(16000));
const proofread = await client.proofread(output);
assert.equal(proofread.text, "错字");
assert.equal(requests[0].body.model, "gemini-test"); assert.equal(requests[0].body.apiKey, "fixture-key");
assert.equal(requests[1].body.model, "chat-model"); assert.equal(requests[1].body.audio, undefined);
assert.equal(requests[1].body.cues[0].start, undefined, "proofreader cannot edit timestamps");
assert.doesNotMatch(JSON.stringify(options), /fixture-key|chat-key/, "task metadata never contains credentials");
fail = true; await assert.rejects(client.recognize(new Float32Array(16000)), /API Key 无效/); fail = false;
block = true;
const pending = client.recognize(new Float32Array(16000));
while (!blocked) await new Promise(resolve => setImmediate(resolve));
controller.abort(); await assert.rejects(pending, { name: "AbortError" });
assert.ok(requests.some(item => item.url.endsWith("/cancel")), "abort notifies native request registry");
const controls: any = {}, patches: any[] = [];
const preferences: any = { mode: "online", onlineProvider: "google", onlineModel: "gemini-test", proofread: true, proofreadModel: "chat-test" };
const providers = { google: { label: "Gemini", model: "gemini-test" }, qwen: { label: "通义 Omni", model: "qwen-test" } };
const jsx = (type: any, props: any) => ({ type, props });
vm.runInNewContext(compile(readFileSync(new URL("../src/components/SpeechOnlineControls.tsx", import.meta.url), "utf8")), {
  exports: controls,
  require: (name: string) => name === "react" ? { useEffect() {}, useState: (initial: any) => [initial, () => {}] }
    : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
    : name === "../speech/models" ? { useSpeechModels: () => ({ preferences, connections: { google: connection } }), SPEECH_ONLINE_PROVIDERS: providers, setSpeechPreferences: (patch: any) => patches.push(patch) } : {},
});
function nodes(node: any): any[] { return Array.isArray(node) ? node.flatMap(nodes) : node?.props ? [node, ...nodes(node.props.children)] : []; }
const run = nodes(controls.SpeechOnlineRunControls());
assert.ok(run.some(node => node.type === "input" && node.props.value === "chat-test"));
assert.ok(run.some(node => node.type === "input" && node.props.value === "gemini-test"));
const provider = run.find(node => node.type === "select" && node.props.value === "google");
provider.props.onChange({ target: { value: "qwen" } });
assert.equal(patches.at(-1).onlineModel, "qwen-test");
assert.ok(nodes(controls.SpeechOnlineSettings()).some(node => node.type === "input" && node.props.type === "password"));
console.log("PASS: WAV 编码、在线字幕校验、校对时间轴保护、凭证隔离、接口错误、网络取消");
