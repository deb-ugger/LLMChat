import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { hostname: "localhost" } };
const bundle = await build({
  stdin: { contents: `export * as layout from './gameTextLayout'; export * as translation from './unityTranslation'; export {gameFormatTokens} from './gameDisplayText'; export {runTextTranslation} from './components/unity-offline/useTextOrchestration';`,
    resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "browser", external: ["fs", "path"],
  define: { "import.meta.env.VITE_API_BASE": '""' },
  plugins: [{ name: "layout-term-fixture", setup(build) {
    build.onResolve({ filter: /gameTermMemory$/ }, () => ({ path: "terms", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const prepareGameTerms = async () => ({terms:new Map(),issues:new Map()}); export const gameTermProblem = () => '';", loader: "js" }));
  } }],
});
const { layout, translation, gameFormatTokens, runTextTranslation } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

const source = "%1 の%2を得た", text = "%1 获得了它的%2。";
assert.equal(layout.wrapGameTextToSource(source, text), text, "a longer single-line UI translation stays on one line");
assert.equal(layout.wrapGameTextToSource(source, "%1 获得了它\n的%2。"), text, "remove display wrapping from a single-line source");
assert.equal(layout.wrapGameTextToSource("a", "一条很长的中文系统提示"), "一条很长的中文系统提示", "short original width is not a hard limit");
assert.equal(layout.wrapGameTextToSource("Get item", "Obtain the\nitem now"), "Obtain the item now");
assert.equal(layout.wrapGameTextToSource("第一\n第二", "连贯译文"), "连贯\n译文");
assert.equal(layout.wrapGameTextToSource("aaaa\nbbbb", "one two three four"), "one two\nthree four");
assert.equal(layout.wrapGameTextToSource("第一\r\n\r\n  第二", "你好\n\n世界"), "你好\r\n\r\n  世界");
assert.equal(layout.wrapGameTextToSource("一\n二\n三\n四", "好"), "好", "do not force short translations to fill every original row");
const listed = layout.wrapGameTextToSource("1. 説明が\n続きます\n2. 次の説明", "1. 第一项的说明\n2. 第二项的说明");
assert.ok(listed.startsWith("1."));
assert.match(listed, /\n2\./);
assert.equal(listed.match(/2\./g).length, 1);

const tokenSource = String.raw`\C[2]%1を得た\C[0]` + "\n" + String.raw`%2の説明\V[3]`;
const tokenTranslation = String.raw`\C[2]获得了%1\C[0]` + "\n" + String.raw`%2的说明\V[3]`;
const wrapped = layout.wrapGameTextToSource(tokenSource, tokenTranslation);
assert.deepEqual(wrapped.match(gameFormatTokens()), tokenTranslation.match(gameFormatTokens()));
assert.ok(!wrapped.includes("LLMCHAT_LINE_"));
assert.equal(layout.wrapGameTextToSource(String.raw`一つ\n二つ<br>三つ`, String.raw`第一项\n第二项<br>第三项`), String.raw`第一项\n第二项<br>第三项`);
console.log("PASS single-line notices, multiline semantic wrapping, paragraphs, lists, CRLF and atomic RPG placeholders/controls");

const settings = { model: "fixture", apiUrl: "http://localhost:11434/v1/chat/completions", apiKey: "" };
for (const prompt of [undefined, "自定义正文翻译规则"]) {
  const options = translation.buildUnityTranslateOptions(settings, "llm", "ja", "zh-CN", "", true, false, prompt, "natural");
  assert.ok(options.prompt.includes(layout.GAME_NATURAL_LINE_PROMPT));
  assert.ok(options.prompt.includes("根据当前原文可见文字的长度"));
  assert.ok(options.prompt.includes("原文只有一行时译文保持一行"));
  assert.ok(!options.prompt.includes("显示折行由程序计算"));
}
assert.equal(translation.prepareUnityTranslationRequest("短い\n長い行\n\n次の段落", false), "短い\n長い行\n\n次の段落");
const natural = "你好，\n最近怎么样？";
assert.equal(layout.validateGameNaturalLines("こんにちは\nお元気ですか", natural), natural, "natural mode validates without reflowing model output");
assert.equal(layout.validateGameNaturalLines("こんにちは\r\n\r\nお元気ですか", "你好\r\n\r\n最近怎么样"), "你好\r\n\r\n最近怎么样");
assert.throws(() => layout.validateGameNaturalLines(source, "%1 获得了它\n的%2。"), /单行/);
assert.throws(() => layout.validateGameNaturalLines("第一段\n\n第二段", "两个段落合成一段"), /段落数量/);
console.log("PASS natural-mode prompt uses original lengths/structure and validates single lines/paragraphs without local reflow");

const nativeRequests = [];
const original = "こんにちは\nお元気ですか";
const translated = "你好，最近\n怎么样？";
const options = { ...translation.buildUnityTranslateOptions(settings, "llm", "ja", "zh-CN", "", true, false, undefined, "natural"), wrapMode: "natural", dialogueOptions: { model: "dialogue-fixture", prompt: layout.GAME_NATURAL_LINE_PROMPT }, includeContext: false };
const nativeProject = { entries: [{ id: "1", file: "fixture", objectId: "1", container: "", locator: "/line/0", locale: "ja", source: original, translation: "", error: "", selected: true, dialoguePosition: { page: 0, line: 0 } }] };
const nativeResult = await runTextTranslation(nativeProject, new AbortController(), options, () => {}, "ja", true, "model", "unused-line-model", false, undefined, {
  settings, promptState: { scope: "fixture", selection: {} }, textLog() {}, getSettings: async () => settings,
  loadLocalModelProfiles: () => ({}), measureGameWork: (_scope, _metric, work) => work(),
  translateGameWithOllama: async (input, _init, config) => { nativeRequests.push({ input, config }); return { ok: true, translation: translated }; },
  prepareGameOllamaModels: async () => {}, canDisableOllamaNameThinking: () => false, gameModelExecution: () => ({}), readEngineStats: () => [],
  saveTranslation: async () => {}, persist: async () => {}, setQueue() {}, setDirty() {}, setMessage() {},
});
assert.equal(nativeRequests.length, 1);
assert.equal(nativeRequests[0].input, original);
assert.equal(nativeRequests[0].config.model, "dialogue-fixture");
assert.equal(nativeResult.entries[0].translation, translated);
assert.equal(nativeResult.entries[0].error, "");
console.log("PASS Unity translation also preserves the source layout and uses one selected dialogue-model request without an extra formatting call");
