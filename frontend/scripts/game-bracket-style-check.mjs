import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
Error.stackTraceLimit = 0;

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key), key: index => [...storage.keys()][index] ?? null, get length() { return storage.size; } };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { hostname: "localhost" } };
const bundle = await build({
  stdin: { contents: `export * as brackets from './gameTextStructure'; export * as display from './gameDisplayText'; export * as project from './gameTextProject'; export * as prompts from './gamePrompts'; export * as terms from './gameTermMemory'; export * as presets from './gameModelPreset';`,
    resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts" },
  bundle: true, write: false, platform: "browser", format: "esm", external: ["fs", "path"],
  define: { "import.meta.env.VITE_API_BASE": '""' },
});
const { brackets, display, project, prompts, terms, presets } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

const samples = [
  ["魔力で相殺する(MP50消費)", "用魔力抵消（消耗MP50）", "用魔力抵消(消耗MP50)"],
  ["魔法追撃(全体)：炎", "魔法追击（全体）：火", "魔法追击(全体)：火"],
  ["魔法追撃(単体)：雷", "魔法追击（单体）：雷", "魔法追击(单体)：雷"],
  ['"特別な名称"と呼ぶ', "“特别的名称”这个称呼", '"特别的名称"这个称呼'],
  ['"特別な名称"と呼ぶ', "「特别的名称」这个称呼", '"特别的名称"这个称呼'],
  ["『名前』を選ぶ", "“名称”选择", "『名称』选择"],
  ["『「名前」(説明)』", "“‘名称’（说明）”", "『「名称」(说明)』"],
  ["[説明]", "［说明］", "[说明]"],
  ["｛説明｝", "{说明}", "｛说明｝"],
  ["'name'", "‘名称’", "'名称'"],
  ['emoji😀"name"', "表情😀“名称”", '表情😀"名称"'],
];
for (const [source, value, restored] of samples) {
  assert.equal(brackets.gameBracketIssue(source), "");
  assert.equal(brackets.gameBracketIssue(value), "");
  assert.equal(brackets.gameBracketProblem(source, value), "");
  assert.equal(brackets.restoreGameBracketStyle(source, value), restored);
}
for (const value of ["don't", "Alice's sword", "James' shield", "it’s fine", "5' 10\" tall", String.raw`an escaped \"name\"`]) {
  assert.equal(brackets.gameBracketIssue(value), "", "word apostrophes, units and escapes are not quote delimiters");
}
for (const value of ["『名称」", "（说明)", "[说明", "说明】", '"name', "(『说明)』"]) assert.ok(brackets.gameBracketIssue(value));
for (const [source, value] of [["(説明)", "[说明]"], ["『説明』", "说明"], ["説明", "“说明”"], ["『説明』", "《说明》"], ["(説明[条件])", "[说明(条件)]"]]) {
  assert.ok(brackets.gameBracketProblem(source, value));
  assert.equal(brackets.restoreGameBracketStyle(source, value), value, "do not repair missing, additional, reordered or different-family delimiters");
}
console.log("PASS equivalent punctuation styles, ASCII quotes, contractions, nesting and source-style restoration without accepting malformed structures");

const input = '説明 "{LLMCHAT_FORMAT_0}の名前" を選ぶ{LLMCHAT_FORMAT_1}';
const pieces = brackets.splitGameTranslationSpans(input);
assert.ok(pieces.includes('説明 "{LLMCHAT_FORMAT_0}の名前" を選ぶ'));
assert.ok(pieces.includes("{LLMCHAT_FORMAT_1}"));
assert.equal(pieces.join(""), input);

let calls = 0;
const controlsSource = String.raw`\C[2]"選択肢"を選ぶ(MP50消費)`;
const translated = await display.translateGameDisplayText(controlsSource, async text => {
  calls++;
  return text.replace('"選択肢"', "“选项”").replace("を選ぶ", "选择").replace("(MP50消費)", "（消耗MP50）");
}, "zh-CN", "ja");
assert.equal(calls, 1, "do not retry an otherwise valid translation solely for punctuation style");
assert.equal(translated, String.raw`\C[2]"选项"选择(消耗MP50)`);
assert.equal(project.gameTextProblem(controlsSource, translated), "");
const quotedControl = String.raw`『\I[251]説明』を選ぶ`;
const result = await display.translateGameDisplayText(quotedControl, async text => {
  assert.equal(brackets.gameBracketIssue(text), "", "the model sees the opening quote even when it precedes a control marker");
  return text.replace("『", "“").replace("』", "”").replace("説明", "说明").replace("を選ぶ", "选择");
}, "zh-CN", "ja");
assert.equal(result, String.raw`『\I[251]说明』选择`);
const retainedChineseQuote = String.raw`『中文\V[19]の説明』を選ぶ`;
const retainedResult = await display.translateGameDisplayText(retainedChineseQuote, async text => {
  assert.equal(brackets.gameBracketIssue(text), "", "do not hide a half-quote with an already-target-language fragment");
  return text.replace("の説明", "的说明").replace("を選ぶ", "选择");
}, "zh-CN", "ja");
assert.equal(retainedResult, String.raw`『中文\V[19]的说明』选择`);
assert.ok(project.gameTextProblem(String.raw`\C[2]説明`, String.raw`\C[3]说明`));
assert.ok(project.gameTextProblem(String.raw`\C[2]説明`, String.raw`\C［2］说明`));
assert.ok(project.gameTextProblem("{0}の説明", "｛0｝的说明"));
assert.ok(project.gameTextProblem("%1の説明", "%2的说明"));
await assert.rejects(display.translateGameDisplayText("『こんにちは』", async () => "『你好」", "zh-CN", "ja"), /括号|引用/);
console.log("PASS actual model-output path restores source symbols in one request and still rejects changed controls, placeholders and broken pairs");

const termRows = ["魔法追撃(全体)：炎", "魔法追撃(単体)：雷"].map((source, index) => ({ id: String(index), source, translation: "", error: "", selected: true, rpgTextKind: "skill" }));
const prepared = await terms.prepareGameTerms(termRows, termRows, "zh-CN", [], name => display.translateGameDisplayText(name, async () => name.includes("全体") ? "魔法追击（全体）：火" : "魔法追击（单体）：雷", "zh-CN", "ja"), new AbortController().signal);
assert.equal(prepared.issues.size, 0);
assert.equal(prepared.terms.get(termRows[0].source), "魔法追击(全体)：火");
assert.equal(prepared.terms.get(termRows[1].source), "魔法追击(单体)：雷");
const imported = project.importGameText([{ ...termRows[0] }], JSON.stringify({ [termRows[0].source]: "魔法追击（全体）：火" }), false, "replace");
assert.equal(imported.changed, 1);
assert.equal(imported.issues.length, 0);
console.log("PASS both reported skill-name failures can pass terminology validation and equivalent imported punctuation is accepted");

const scenes = new Set(["text", "dialogue", "names", "image", "review"]);
for (const preset of prompts.BUILTIN_GAME_PROMPTS.filter(row => scenes.has(row.scene))) {
  assert.ok(preset.prompt.includes(prompts.GAME_STRUCTURE_PROMPT), preset.id);
  assert.ok(preset.prompt.includes("不自动把半角括号中文化"), preset.id);
  assert.ok(preset.prompt.includes("英文直引号"), preset.id);
  assert.ok(prompts.gameTaskPrompt(preset.scene, { [preset.scene]: preset.id }).includes(prompts.GAME_STRUCTURE_PROMPT));
}
const current = { text: { options: { kind: "llm", source: "ja", target: "zh-CN", joinLines: true, engines: [] }, roles: {} } };
for (const config of presets.builtinGameTestConfigurations(current)) for (const [scene, role] of Object.entries(config.value.text.roles)) {
  if (scenes.has(scene)) assert.ok(prompts.gameTaskPrompt(scene, { [scene]: role.prompt }).includes("不自动把半角括号中文化"));
}
prompts.saveGamePromptCatalog([{ id: "custom", name: "自定义", scene: "text", prompt: "保留我的翻译要求" }]);
const custom = prompts.gameTaskPrompt("text", { text: "custom" });
assert.ok(custom.includes("保留我的翻译要求"));
assert.ok(custom.includes(prompts.GAME_STRUCTURE_PROMPT));
console.log("PASS every related built-in prompt/default configuration and custom prompt's common rules use the updated symbol policy");
