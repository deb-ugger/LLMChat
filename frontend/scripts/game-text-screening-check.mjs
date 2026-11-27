import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { hostname: "localhost" } };
const bundle = await build({
  stdin: { contents: `export { screenGameText } from './gameTextScreening'; export * as prompts from './gamePrompts';`,
    resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts" },
  bundle: true, write: false, platform: "browser", format: "esm", external: ["fs", "path"],
  define: { "import.meta.env.VITE_API_BASE": '""' },
  plugins: [{ name: "screening-model-fixture", setup(build) {
    build.onResolve({ filter: /gameModelRequest$/ }, () => ({ path: "model", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `export const requestGameModelJson = (...args) => globalThis.screeningRequest(...args);`, loader: "js" }));
  } }],
});
const { screenGameText, prompts } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const base = { settings: {}, model: "fixture-model", prompts: {}, source: "ja", target: "zh-CN", onlySource: true, skipTarget: true };
const row = (id, source, extra = {}) => ({ id, source, selected: true, translation: "", error: "", ...extra });
const makeRows = () => [
  row("ja", "こんにちは"), row("mixed", String.raw`\C[2]こんにちは\C[0]`),
  row("translated", "おはよう", { translation: "早上好" }),
  row("draft", "これは説明です", { layoutDraft: "说明草稿" }),
  row("screening-draft", "次の説明", { screeningDraft: "旧筛选草稿" }),
  row("zh", "已经是中文"), row("en", "Open the door"), row("symbols", "！？♡…"),
  row("numbers", "12345"), row("blank", "  "), row("path", "img/pictures/scene.png"),
  row("control", String.raw`\C[2]\V[1]%1{0}`), row("name", String.raw`\nc<アリス>`),
  row("duplicate", "こんにちは"), row("error", "错误项原文", { error: "括号未成对" }),
  row("unselected", "未选中原文", { selected: false }),
];
for (const onlySource of [true, false]) for (const skipTarget of [true, false]) {
  const rows = makeRows();
  const inputs = [], progress = [];
  globalThis.screeningRequest = async (_settings, model, prompt) => {
    assert.equal(model, base.model);
    assert.ok(prompt.includes(`仅翻译原语言：${onlySource ? "开启" : "关闭"}`));
    assert.ok(prompt.includes(`跳过目标语言：${skipTarget ? "开启" : "关闭"}`));
    assert.ok(prompt.includes(String.raw`\nc<アリス>`));
    const items = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    inputs.push(...items);
    assert.equal(rows.find(row => row.id === "zh").translation, "", "no local preservation before model request");
    assert.equal(rows.find(row => row.id === "control").selected, true, "controls reach the model without local deselection");
    return items.map(item => ({ id: item.id, keep: ["！？♡…", "12345", "  ", "img/pictures/scene.png", String.raw`\C[2]\V[1]%1{0}`, "おはよう"].includes(item.text) }));
  };
  const kept = await screenGameText(rows, { ...base, onlySource, skipTarget, signal: new AbortController().signal, onProgress: (...value) => progress.push(value) });
  assert.equal(inputs.length, 13, "all eligible rows, including existing translations and drafts, reach the model once per original");
  assert.equal(kept, 6);
  assert.equal(rows.find(row => row.id === "zh").selected, true, "a model decision is not overwritten by local language rules");
  assert.equal(rows.find(row => row.id === "ja").selected, true);
  assert.equal(rows.find(row => row.id === "duplicate").selected, true);
  assert.equal(rows.find(row => row.id === "translated").translation, "早上好", "preserve existing translations when the model skips the original");
  assert.equal(rows.find(row => row.id === "symbols").translation, "！？♡…");
  assert.equal(rows.find(row => row.id === "error").selected, true);
  assert.ok(!inputs.some(item => item.text === "错误项原文" || item.text === "未选中原文"));
  assert.deepEqual(progress.at(-1), [13, 13]);
}
console.log("PASS model screening submits original text and all text forms for all four switch combinations, retains translations and protects error rows");

globalThis.screeningRequest = async (_settings, _model, prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)).map(item => ({ id: item.id, keep: false }));
const previousLocalResult = [row("cached", "已经是中文", { translation: "已经是中文", translationTarget: "zh-CN", screeningDraft: "旧本地草稿" })];
await screenGameText(previousLocalResult, { ...base, skipTarget: false, signal: new AbortController().signal });
assert.equal(previousLocalResult[0].selected, true);
assert.equal(previousLocalResult[0].translation, "");
assert.equal(previousLocalResult[0].screeningDraft, undefined);
assert.equal(previousLocalResult[0].translationTarget, undefined);
console.log("PASS model decisions invalidate an earlier local original-as-translation cache and screening draft");

globalThis.screeningRequest = async () => [{ id: 0, keep: true }];
const otherTarget = [row("old-target", "已经是中文", { translation: "Already Chinese", translationTarget: "en" })];
await screenGameText(otherTarget, { ...base, signal: new AbortController().signal });
assert.equal(otherTarget[0].selected, false);
assert.equal(otherTarget[0].translation, "已经是中文");
assert.equal(otherTarget[0].translationTarget, "zh-CN");

for (const preset of prompts.BUILTIN_GAME_PROMPTS.filter(prompt => prompt.scene === "textScreen")) {
  assert.ok(preset.prompt.includes("控制结构"));
  assert.ok(preset.prompt.includes("开关状态"));
  assert.ok(!preset.prompt.includes("只翻译当前正文"));
  for (const skipTarget of [true, false]) {
    const prompt = prompts.gameTextScreeningPrompt({ textScreen: preset.id }, { ...base, skipTarget });
    assert.ok(prompt.includes("每个请求 id 必须恰好出现一次"));
    assert.ok(prompt.includes("keep=false"));
    assert.ok(prompt.includes(`跳过目标语言：${skipTarget ? "开启" : "关闭"}`));
  }
}
prompts.saveGamePromptCatalog([{ id: "custom", name: "自定义筛选", scene: "textScreen", prompt: "判断内容是否需要翻译" }]);
const custom = prompts.gameTextScreeningPrompt({ textScreen: "custom" }, { ...base, onlySource: false, skipTarget: false });
assert.ok(custom.startsWith("判断内容是否需要翻译"));
assert.ok(custom.includes("控制结构"));
assert.ok(custom.includes("仅翻译原语言：关闭"));
assert.ok(custom.includes("跳过目标语言：关闭"));
console.log("PASS general, Japanese, adult-game and custom screening prompts include symbol/control handling and current switches");

globalThis.screeningRequest = async () => { throw new Error("local screening must not request a model"); };
const localRows = [row("zh", "这是中文。"), row("ja", "こんにちは"), row("control", String.raw`\C[2]\V[1]`)];
await screenGameText(localRows, { ...base, model: undefined, signal: new AbortController().signal });
assert.equal(localRows[0].selected, false);
assert.equal(localRows[1].selected, true);
assert.equal(localRows[2].selected, false);
console.log("PASS local screening still uses local rules without model requests");

for (const reply of [[], [{ id: 0, keep: "true" }], [{ id: 0, keep: true }, { id: 0, keep: true }]]) {
  globalThis.screeningRequest = async () => reply;
  const rows = [row("1", "こんにちは"), row("2", "已经是中文")];
  await assert.rejects(screenGameText(rows, { ...base, signal: new AbortController().signal }), /条目与请求不一致/);
  assert.ok(rows.every(row => row.selected && !row.translation), "invalid model responses never silently fall back to local screening");
}
globalThis.screeningRequest = async () => { throw new Error("HTTP 503"); };
const failed = [row("failed", "こんにちは")];
await assert.rejects(screenGameText(failed, { ...base, signal: new AbortController().signal }), /HTTP 503/);
assert.equal(failed[0].selected, true);
console.log("PASS invalid output and service errors remain visible and retain selection");
