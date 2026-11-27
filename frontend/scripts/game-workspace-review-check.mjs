import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const store = new Map();
globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { hostname: "localhost" } };
const result = await build({
  stdin: { contents: `
    export * as structure from './gameTextStructure';
    export * as display from './gameDisplayText';
    export * as project from './gameTextProject';
    export * as prompts from './gamePrompts';
    export * as output from './appOutput';
    export * as filters from './components/GameTextFilterMenu';
    export * as failures from './components/GameBatchResults';
  `, resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts" },
  bundle: true, write: false, platform: "browser", format: "esm",
  external: ["fs", "path"],
  define: { "import.meta.env.VITE_API_BASE": '""' },
});
const { structure, display, project, prompts, output, filters, failures } = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));

const source = "\\P[1]は穴に『\\P[1]の母乳』を流し込んだ";
const wrong = "\\P[1]往洞口灌入『\\P[1]灌入『的母乳』";
assert.match(project.gameTextProblem(source, wrong), /括号或引用.*缺少/);
const changedQuote = "\\P[1]向洞口倒入《\\P[1]的母乳》";
assert.match(project.gameTextProblem(source, changedQuote), /类型、数量或嵌套/);
assert.equal(project.gameTextProblem(source, "\\P[1]向洞口倒入『\\P[1]的母乳』"), "");
const rejected = project.importGameText([{ id: "443", source, translation: "", error: "", selected: true }], JSON.stringify({ [source]: changedQuote }), false, "replace");
assert.equal(rejected.changed, 0);
assert.match(rejected.issues[0].reason, /类型、数量或嵌套/);

assert.equal(failures.batchFailureType("译文括号或引用未成对"), "括号与引用结构错误");
assert.equal(failures.batchFailureType("译文仍含日文，请检查正文和说话人姓名"), "译文残留原文");
assert.equal(failures.batchFailureType("同一原文对应多条不同译文"), "导入匹配歧义");
assert.equal(failures.batchFailureType("缺少 1 行译文"), "正文译文不完整");
assert.equal(failures.batchFailureType("占位符发生变化"), "译文格式校验失败");

const calls = [];
const translation = await display.translateGameDisplayText(source, async input => {
  calls.push(input);
  assert.equal(structure.gameBracketIssue(input), "", "never issue a half-quote translation request");
  if (calls.length === 1) return "错误的『译文";
  const marker = input.match(/\{LLMCHAT_FORMAT_\d+\}/g)?.[0];
  assert.ok(marker, "retry quoted text together with its internal marker");
  return `向洞口倒入『${marker}的母乳』`;
}, "zh-CN", "ja", new Map(), true);
assert.equal(calls.length, 2);
assert.equal(translation, "\\P[1]向洞口倒入『\\P[1]的母乳』");
assert.equal(structure.gameBracketProblem(source, translation), "");

const chosen = { checked: true, ...filters.defaultGameTextFilters, supplemental: true };
assert.equal(filters.matchesGameTextFilters(chosen, true, true, false, false, false, false), false);
assert.equal(filters.matchesGameTextFilters(chosen, true, true, false, false, false, true), true);
const entry = { id: "1", source: "こんにちは", translation: "你好", translationResult: { translation: "你好", target: "zh-CN" } };
assert.equal(project.gameTextSupplementResult(entry, "zh-CN"), true);
assert.equal(project.gameTextSupplementResult({ ...entry, translation: "导入的其他译文" }, "zh-CN"), false);
assert.equal(project.gameTextSupplementResult(entry, "en"), false);
assert.equal(project.gameTextSupplementResult(JSON.parse(JSON.stringify(entry)), "zh-CN"), true);

for (const scene of ["text", "dialogue", "names", "image", "review"]) {
  const prompt = prompts.gameTaskPrompt(scene);
  assert.ok(prompt.includes(prompts.GAME_STRUCTURE_PROMPT));
  assert.ok(prompt.includes("『』"));
  assert.ok(prompt.includes("整个引用连同标记"));
}
for (const scene of ["line", "layout"]) assert.ok(prompts.gameTaskPrompt(scene).includes(prompts.GAME_LAYOUT_STRUCTURE_PROMPT));
for (const preset of prompts.BUILTIN_GAME_PROMPTS.filter(item => item.id.includes("-zh-cn-r18:"))) assert.ok(preset.prompt.includes(prompts.GAME_STRUCTURE_PROMPT));
prompts.saveGamePromptCatalog([{ id: "custom", name: "自定义", scene: "text", prompt: "自定义翻译规则" }]);
assert.ok(prompts.gameTaskPrompt("text", { text: "custom" }).includes(prompts.GAME_STRUCTURE_PROMPT));

output.writeOutput(["test"], "保存成功", "success", true);
output.writeOutput(["test"], "普通重要消息", "info", true);
output.writeOutput(["test"], "步骤", "step", true);
output.writeOutput(["test"], "旧失败等级", "fail", true);
assert.equal(Number(store.get("llmchat-output-unread-warning-error") || 0), 0);
output.writeOutput(["test"], "错误", "error", false);
output.writeOutput(["test"], "警告", "warning", false);
assert.equal(Number(store.get("llmchat-output-unread-warning-error")), 2);
const stopViewing = output.viewAppOutput();
assert.equal(Number(store.get("llmchat-output-unread-warning-error")), 0);
output.writeOutput(["test"], "正在查看", "error");
assert.equal(Number(store.get("llmchat-output-unread-warning-error")), 0);
stopViewing();
output.writeOutput(["test"], "查看后新增警告", "warning");
assert.equal(Number(store.get("llmchat-output-unread-warning-error")), 1);
console.log("PASS quote validation, whole-quote retry, failure categories, supplemental filter, persistent provenance, structure prompts and warning/error badges");
