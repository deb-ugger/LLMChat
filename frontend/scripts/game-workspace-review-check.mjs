import assert from "node:assert/strict";
import { build, transform } from "esbuild";
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
const entry = { id: "1", source: "こんにちは", translation: "你好", error: "", selected: true, translationTarget: "zh-CN" };
assert.equal(project.gameTextNeedsSupplement(entry, "zh-CN", "ja"), false);
assert.equal(project.gameTextNeedsSupplement({ ...entry, translation: "" }, "zh-CN", "ja"), true);
assert.equal(project.gameTextNeedsSupplement({ ...entry, translation: "", error: "请求失败" }, "zh-CN", "ja"), true);
assert.equal(project.gameTextNeedsSupplement({ ...entry, source: "已经完成了。", translation: "" }, "zh-CN", "ja"), false);
assert.equal(project.gameTextNeedsSupplement({ ...entry, translationTarget: "en" }, "zh-CN", "ja"), true);
assert.equal(project.gameTextNeedsSupplement({ ...entry, importPartial: { translation: "你好", unmatched: ["残留"] } }, "zh-CN", "ja"), true);
const initialProject = { sourcePath: "fixture", translationPath: "", options: {}, entries: [entry] };
assert.equal(project.isGameTextScreened(initialProject), false);
assert.equal(project.isGameTextScreened({ ...initialProject, workflow: { screened: true, screenedIds: ["1"] } }), false);
const screenedProject = { ...initialProject, entries: [{ ...entry, selected: false }], workflow: {
  screened: true, version: project.gameTextScreeningVersion, screenedIds: ["1"], skippedIds: ["1"],
} };
assert.equal(project.isGameTextScreened(screenedProject), true);
const reset = project.resetGameTextScreening(screenedProject);
assert.equal(reset.entries[0].selected, true);
assert.equal(reset.entries[0].translation, "你好");
assert.equal(project.isGameTextScreened(reset), false);
assert.deepEqual(reset.workflow, { screened: false });
assert.equal(project.resetGameTextScreening({ ...initialProject, entries: [{ ...entry, selected: false }] }).entries[0].selected, false);

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

const workspaceCode = await (await import("node:fs/promises")).readFile(fileURLToPath(new URL("../src/components/GameTextWorkspace.tsx", import.meta.url)), "utf8");
const screenStart = workspaceCode.indexOf("  const screen = async");
const screenEnd = workspaceCode.indexOf("  const resetTranslation", screenStart);
const complete = { ...entry, id: "done" };
const missing = { ...entry, id: "missing", source: "おはようございます", translation: "" };
const partial = { ...entry, id: "partial", source: "次の説明です", translation: "部分译文", importPartial: { translation: "部分译文", unmatched: ["待翻译段落"] } };
const broken = { ...entry, id: "broken", source: "これは説明です", translation: "错误译文", error: "括号错误" };
const nativeTarget = { ...entry, id: "target", source: "你好，已经完成了。", translation: "" };
const manuallyExcluded = { ...entry, id: "manual", source: "手動で除外した文です", translation: "", selected: false };
const context = {
  isBenchmarkRunning: () => false, controller: { current: null }, loading: false, busy: false,
  current: { current: { ...initialProject, entries: [complete, missing, partial, broken, nativeTarget, manuallyExcluded] } },
  resetGameTextScreening: project.resetGameTextScreening, gameTextScreeningVersion: project.gameTextScreeningVersion,
  gameTextNeedsSupplement: project.gameTextNeedsSupplement, gameTextImportPartial: project.gameTextImportPartial,
  gameTextNeedsNoTranslation: display.gameTextNeedsNoTranslation, messageCore: false, sourceFilter: "ja",
  options: { target: "zh-CN", skipTargetLanguage: true }, settings: {}, promptState: { scope: "fixture", selection: {} },
  failureReasons: new Map([["broken", "括号错误"]]),
  beginGameStep() {}, finishGameStep() {}, reportGameStepItems() {}, report() {},
  setScreenStarted() {}, setSaving() {}, setState() {}, setProgressFailure() {}, setProgress() {}, setDirty() {}, setScreened() {},
  screenGameText: async rows => {
    const eligible = rows.filter(row => !row.error);
    display.preserveTargetGameText(eligible, "zh-CN", "ja", true);
    let count = 0;
    for (const row of eligible) if (display.gameTextScreeningResult(row.source, "zh-CN", "ja", true).unchanged) {
      row.selected = false; count++;
    }
    return count;
  },
  unityTranslationStats: rows => ({ total: rows.length, completed: 0 }),
  gameTextProblem: project.createGameTextValidator(false, "zh-CN"),
  gameDialogueReuseKey: row => row.source,
};
let savedScreen;
context.persist = async next => { savedScreen = JSON.parse(JSON.stringify(next)); };
context.publish = next => { context.current.current = next; };
const actualScreen = (await transform(workspaceCode.slice(screenStart, screenEnd), { loader: "ts", target: "es2022" })).code;
const runScreen = new Function("context", "with(context) {" + actualScreen + ";return screen;}")(context);
assert.equal(await runScreen(), true);
assert.equal(savedScreen.entries.find(row => row.id === "done").selected, false);
assert.equal(savedScreen.entries.find(row => row.id === "missing").selected, true);
assert.equal(savedScreen.entries.find(row => row.id === "partial").selected, true);
assert.equal(savedScreen.entries.find(row => row.id === "broken").selected, true);
assert.equal(savedScreen.entries.find(row => row.id === "target").selected, false);
assert.equal(savedScreen.entries.find(row => row.id === "manual").selected, false);
assert.deepEqual(savedScreen.workflow.skippedIds.sort(), ["done", "target"]);
assert.equal(project.isGameTextScreened(savedScreen), true);
assert.equal(await runScreen(), true);
assert.equal(savedScreen.entries.find(row => row.id === "done").selected, false);
assert.ok(workspaceCode.includes("const screenComplete = screened;"));
assert.ok(workspaceCode.includes('publish(resetGameTextScreening({ ...importing, entries }))'));
assert.ok(!workspaceCode.includes("screened || textReady"));
console.log("PASS actual screening transition, completed/empty/partial/error selection, rerun, legacy state invalidation and import reset");

const editStart = workspaceCode.indexOf("  const editEntries =");
const editEnd = workspaceCode.indexOf("  const edit =", editStart);
const editCode = (await transform(workspaceCode.slice(editStart, editEnd), { loader: "ts", target: "es2022" })).code;
const editContext = {
  current: { current: savedScreen }, baseline: { current: JSON.parse(JSON.stringify(savedScreen)) }, options: { target: "zh-CN" },
  isTextSelectionScreened: project.isTextSelectionScreened, gameTextScreeningVersion: project.gameTextScreeningVersion,
  sameTextEdit: project.sameTextEdit, setScreened() {}, setImportIssues() {}, setDirty: value => { editContext.dirty = value; },
};
editContext.publish = value => { editContext.current.current = value; };
const editRows = new Function("context", "with(context) {" + editCode + ";return editEntries;}")(editContext);
editRows(new Set(["done"]), { selected: false });
assert.equal(editContext.current.current.entries.find(row => row.id === "done").selected, false);
assert.ok(!editContext.current.current.workflow.skippedIds.includes("done"));
assert.equal(editContext.dirty, true);
console.log("PASS manual deselection removes retained writeback eligibility and is saved even when checkbox value was already false");
