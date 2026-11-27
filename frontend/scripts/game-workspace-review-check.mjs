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
    export * as session from './unityTranslationSession';
    export * as layout from './gameTextLayout';
    export * as translation from './unityTranslation';
  `, resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts" },
  bundle: true, write: false, platform: "browser", format: "esm",
  external: ["fs", "path"],
  define: { "import.meta.env.VITE_API_BASE": '""' },
});
const { structure, display, project, prompts, output, filters, failures, session, layout, translation: translationModule } = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));

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
for (const preset of prompts.BUILTIN_GAME_PROMPTS.filter(item => item.id.includes("-zh-cn-r18:"))) {
  if (["text", "dialogue", "names", "image", "review"].includes(preset.scene)) assert.ok(preset.prompt.includes(prompts.GAME_STRUCTURE_PROMPT));
  else if (["line", "layout"].includes(preset.scene)) assert.ok(preset.prompt.includes(prompts.GAME_LAYOUT_STRUCTURE_PROMPT));
  else assert.ok(!preset.prompt.includes("只翻译当前正文"), "screening and OCR prompts must retain their own task");
}
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
const errorCode = (await transform(workspaceCode.slice(workspaceCode.indexOf("function createTextRunErrors"), workspaceCode.indexOf("export function GameTextWorkspace")), { loader: "ts", target: "es2022" })).code;
const createTextRunErrors = new Function("batchFailureType", errorCode + ";return createTextRunErrors;")(failures.batchFailureType);
const errorMessages = [];
const runErrors = createTextRunErrors("翻译正文", (message, level) => errorMessages.push({ message, level }));
for (let i = 0; i < 500; i++) runErrors.notify();
runErrors.status("连接错误明细", "error");
assert.equal(errorMessages.length, 1, "report the first error immediately, without per-entry log spam");
runErrors.finish(["括号未成对", "括号错配", "译文仍含日文"], "文本翻译结束");
assert.equal(errorMessages.length, 2);
assert.equal(errorMessages[1].message, "文本翻译结束，错误共 3 条：括号与引用结构错误 2 条，译文残留原文 1 条");
const cleanMessages = [];
createTextRunErrors("筛选文本", message => cleanMessages.push(message)).finish([], "筛选文本结束");
assert.deepEqual(cleanMessages, [], "successful tasks have no error notification");
const screenMessages = [];
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
  textTranslationMatchesTarget: session.textTranslationMatchesTarget,
  createTextRunErrors,
  textScreeningErrorPrefix: "文本筛选失败：",
  gameTextNeedsNoTranslation: display.gameTextNeedsNoTranslation, messageCore: false, sourceFilter: "ja",
  options: { target: "zh-CN", skipTargetLanguage: true }, settings: {}, promptState: { scope: "fixture", selection: {} },
  failureReasons: new Map([["broken", "括号错误"]]),
  beginGameStep() {}, finishGameStep() {}, reportGameStepItems() {}, report: (message, level) => screenMessages.push({ message, level }),
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
assert.deepEqual(savedScreen.workflow.supplementalIds, ["missing", "partial", "broken"]);
assert.deepEqual(screenMessages.filter(row => row.level === "error").map(row => row.message), [
  "筛选文本出现错误，详情见文本翻译区域，结束后汇总", "筛选文本结束，错误共 1 条：括号与引用结构错误 1 条",
]);
assert.equal(project.isGameTextScreened(savedScreen), true);
assert.equal(await runScreen(), true);
assert.equal(savedScreen.entries.find(row => row.id === "done").selected, false);
assert.ok(workspaceCode.includes("const screenComplete = screened;"));
assert.ok(workspaceCode.includes('publish(resetGameTextScreening({ ...importing, entries }))'));
assert.ok(!workspaceCode.includes("screened || textReady"));
console.log("PASS actual screening transition, completed/empty/partial/error selection, rerun, legacy state invalidation and import reset");

const supplementalProject = JSON.parse(JSON.stringify(savedScreen));
for (const row of supplementalProject.entries) {
  row.translation = "完整译文"; row.error = ""; delete row.importPartial;
}
const supplementalIds = project.gameTextSupplementIds(supplementalProject);
assert.deepEqual([...supplementalIds], ["missing", "partial", "broken"], "the saved screening cohort survives translating and reopening");
const oldWorkflow = { ...supplementalProject.workflow };
delete oldWorkflow.supplementalIds;
assert.deepEqual([...project.gameTextSupplementIds({ workflow: oldWorkflow })], [...supplementalIds], "restore the cohort from previously saved screening results");
assert.equal(project.gameTextSupplementIds(project.resetGameTextScreening(supplementalProject)).size, 0);
const matchStart = workspaceCode.indexOf("    const rows = entries.filter(entry => matchesGameTextFilters");
const matchEnd = workspaceCode.indexOf("    membership.current", matchStart);
const matchCode = (await transform(workspaceCode.slice(matchStart, matchEnd), { loader: "ts", target: "es2022" })).code;
const matchContext = { entries: supplementalProject.entries, matchesGameTextFilters: filters.matchesGameTextFilters,
  textFilters: { ...filters.defaultGameTextFilters, supplemental: true }, failureReasons: new Map(), qualityIssues: new Set(), targetTextIds: new Set(),
  supplementalIds, gameTextNeedsSupplement: project.gameTextNeedsSupplement, gameTextImportPartial: project.gameTextImportPartial,
  options: { target: "zh-CN" }, sourceFilter: "ja", messageCore: false, filter: "all", search: "",
};
const matchRows = new Function("context", "with(context) {" + matchCode + ";return rows;}")(matchContext);
assert.deepEqual(matchRows.map(row => row.id), ["missing", "partial", "broken"], "completed rows stay visible in the supplemental filter");
console.log("PASS stable supplemental rows after translation, project reload, legacy screening and reset");

const editStart = workspaceCode.indexOf("  const editEntries =");
const editEnd = workspaceCode.indexOf("  const edit =", editStart);
const editCode = (await transform(workspaceCode.slice(editStart, editEnd), { loader: "ts", target: "es2022" })).code;
const editContext = {
  current: { current: savedScreen }, baseline: { current: JSON.parse(JSON.stringify(savedScreen)) }, options: { target: "zh-CN" },
  isTextSelectionScreened: project.isTextSelectionScreened, gameTextScreeningVersion: project.gameTextScreeningVersion,
  gameTextSupplementIds: project.gameTextSupplementIds,
  sameTextEdit: project.sameTextEdit, setScreened() {}, setImportIssues() {}, setDirty: value => { editContext.dirty = value; },
};
editContext.publish = value => { editContext.current.current = value; };
const editRows = new Function("context", "with(context) {" + editCode + ";return editEntries;}")(editContext);
editRows(new Set(["done"]), { selected: false });
assert.equal(editContext.current.current.entries.find(row => row.id === "done").selected, false);
assert.ok(!editContext.current.current.workflow.skippedIds.includes("done"));
assert.equal(editContext.dirty, true);
assert.deepEqual(editContext.current.current.workflow.supplementalIds, ["missing", "partial", "broken"]);
console.log("PASS manual deselection removes retained writeback eligibility and is saved even when checkbox value was already false");

const runStart = workspaceCode.indexOf("  const run = async");
const runEnd = workspaceCode.indexOf("  const importFile =", runStart);
const runCode = (await transform(workspaceCode.slice(runStart, runEnd), { loader: "ts", target: "es2022" })).code;
const runMessages = [], savedBatches = [], liveFailures = [];
const fixtureRows = ["一番目の説明", "二番目の説明", "三番目の説明", "四番目の説明"].map((source, index) => ({ ...entry, source, id: String(index + 1), translation: "" }));
const runningProject = { ...initialProject, entries: fixtureRows, workflow: { screened: true, version: project.gameTextScreeningVersion, screenedIds: fixtureRows.map(row => row.id), skippedIds: [] } };
const runtime = {
  ...context, createTextRunErrors, gameTextSupplementIds: project.gameTextSupplementIds,
  models: [], screened: true, baseline: { current: JSON.parse(JSON.stringify(runningProject)) },
  current: { current: runningProject }, controller: { current: null }, writes: { current: Promise.resolve() }, optionWrite: { current: null }, work: { current: null }, queue: { current: null },
  options: { kind: "engine", target: "zh-CN", skipTargetLanguage: true, joinLines: false }, wrapMode: "source", gamePath: "fixture", engines: [], failureReasons: new Map(),
  UnitySegmentation: class { dispose() {} }, setRunning() {}, setProgress: value => { if (value?.translation) liveFailures.push(value.translation.failedEntries); },
  setProgressFailure: value => { runtime.progressFailure = value; },
  importIssues: fixtureRows.map(row => ({ id: row.id, reason: "导入译文括号错误" })),
  setImportIssues: update => { runtime.importIssues = update(runtime.importIssues); },
  report: (message, level) => runMessages.push({ message, level }),
  publish: value => { runtime.current.current = value; },
  measureGameAsync: async (_scope, _metric, work) => work(), measureGameWork: (_scope, _metric, work) => work(),
  gameTextRequest: async (_action, value) => savedBatches.push(JSON.parse(JSON.stringify(value))),
  api: { getSettings: async () => ({}) }, createGameTranslationContext: () => () => ({}), loadLocalModelProfiles: () => ({}),
  preserveTargetGameText: display.preserveTargetGameText, textTranslationMatchesTarget: session.textTranslationMatchesTarget,
  sameTextEdit: project.sameTextEdit,
  parseEngineKeys: () => ({}), prepareGameTerms: async () => ({ terms: new Map(), issues: [] }), gameTermProblem: () => "",
  translateRpgSystemMessage: () => undefined, gameTextHasSpeaker: () => false,
  createUnityEnginePool: () => ({ concurrency: 1, dispose() {}, translate: async (_text, id) => {
    if (id === "1" || id === "2") throw new Error("译文括号未成对");
    if (id === "3") throw new Error("译文仍含日文");
    return "完成的译文";
  } }),
  translateUnitySession: session.translateUnitySession,
};
const runTranslation = new Function("context", "with(context) {" + runCode + ";return run;}")(runtime);
assert.equal(await runTranslation(), false);
const translationErrors = runMessages.filter(row => row.level === "error");
assert.deepEqual(translationErrors.map(row => row.message), [
  "翻译正文出现错误，详情见文本翻译区域，结束后汇总",
  "文本翻译结束，错误共 3 条：括号与引用结构错误 2 条，译文残留原文 1 条",
], runtime.progressFailure);
assert.equal(runtime.current.current.entries.filter(row => row.error).length, 3);
assert.ok(liveFailures.some(count => count > 0), "failure counts remain visible while translation is running");
assert.equal(savedBatches.flatMap(batch => batch.entries).filter(row => row.error).length, 3, "persist individual error details for review and retry");
assert.deepEqual(savedBatches[0].workflow.supplementalIds, ["1", "2", "3", "4"]);
assert.equal(runtime.current.current.entries[3].translation, "完成的译文");
assert.deepEqual(runtime.importIssues.map(issue => issue.id), ["1", "2", "3"], "a repaired row no longer carries a stale import error");
console.log("PASS actual translation session: immediate single alert, live failure counts, saved details and single final category summary");

runMessages.length = 0;
runtime.current.current.entries[0].selected = false;
assert.equal(await runTranslation(false, true, "1"), false, "an unselected row retried explicitly still contributes its failure");
assert.equal(runMessages.filter(row => row.level === "error").length, 2);
assert.equal(runMessages.at(-1).message, "文本翻译结束，错误共 1 条：括号与引用结构错误 1 条");
console.log("PASS explicit row retry summarizes only the retried row, including an unselected failure");

screenMessages.length = 0;
const successfulScreen = context.screenGameText;
context.screenGameText = async (_rows, options) => {
  options.onOllamaStatus("HTTP 503", "error");
  throw new Error("HTTP 503 服务异常");
};
assert.equal(await runScreen(), false);
const screeningErrors = screenMessages.filter(row => row.level === "error");
assert.equal(screeningErrors.length, 2);
assert.match(screeningErrors[1].message, /括号与引用结构错误 1 条，连接或服务异常 1 条/);
context.screenGameText = successfulScreen;
console.log("PASS screening service failure produces one notification and one aggregated final error line");

const modelRows = [complete, missing, partial, broken, nativeTarget, manuallyExcluded].map(row => ({ ...row }));
context.current.current = { ...initialProject, entries: modelRows };
context.options.screeningModel = "fixture-model";
context.screenGameText = async (rows, options) => {
  assert.equal(options.onlySource, true);
  assert.equal(options.model, "fixture-model");
  assert.ok(rows.some(row => row.id === "target"));
  assert.ok(rows.some(row => row.id === "done"));
  return 0; // Model requests translation even for the Chinese original.
};
assert.equal(await runScreen(), true);
assert.equal(savedScreen.entries.find(row => row.id === "target").selected, true, "model screening is not followed by local target-language deselection");
assert.equal(savedScreen.entries.find(row => row.id === "broken").selected, true);
assert.equal(savedScreen.entries.find(row => row.id === "done").selected, false, "existing valid completed translations remain reusable");
assert.ok(savedScreen.workflow.supplementalIds.includes("target"));
assert.ok(!workspaceCode.slice(screenStart, screenEnd).includes('if (!options.screeningModel'));

runMessages.length = 0;
runtime.options.screeningModel = "fixture-model";
runtime.current.current = { ...initialProject, entries: [{ ...nativeTarget, id: "4", translation: "" }], workflow: { screened: true, version: project.gameTextScreeningVersion, screenedIds: ["4"], skippedIds: [], supplementalIds: ["4"] } };
runtime.baseline.current = JSON.parse(JSON.stringify(runtime.current.current));
assert.equal(await runTranslation(), true);
assert.equal(runtime.current.current.entries[0].translation, "完成的译文", "translation does not locally preserve a model-selected target-language original");
console.log("PASS model decisions survive workspace completion, supplemental filtering and subsequent translation");

screenMessages.length = 0;
context.current.current = { ...initialProject, entries: [{ ...missing, id: "retained" }, { ...missing, id: "failure" }] };
context.screenGameText = async (rows, options) => {
  rows[0].translation = rows[0].source; rows[0].selected = false;
  rows[1].error = "文本筛选失败：筛选模型 JSON 条目不匹配";
  options.onProgress(2, 2);
  return 1;
};
assert.equal(await runScreen(), true, "item-level failures do not stop the screening stage");
assert.equal(savedScreen.entries.find(row => row.id === "retained").selected, false);
assert.match(savedScreen.entries.find(row => row.id === "failure").error, /文本筛选失败/);
assert.equal(screenMessages.filter(row => row.level === "error").length, 2);
assert.match(screenMessages.at(-1).message, /模型输出格式无效 1 条/);

context.current.current = { ...initialProject, entries: [{ ...missing, id: "retained" }, { ...missing, id: "pending" }] };
context.screenGameText = async rows => {
  rows[0].translation = rows[0].source; rows[0].selected = false;
  throw new Error("HTTP 503 服务异常");
};
assert.equal(await runScreen(), false);
assert.equal(savedScreen.entries[0].translation, savedScreen.entries[0].source, "save completed screening results after a fatal request error");
assert.equal(context.controller.current, null, "release the active task after screening failure");

context.current.current = { ...initialProject, entries: [{ ...missing, id: "retained" }, { ...missing, id: "pending" }] };
context.screenGameText = async rows => {
  rows[0].translation = rows[0].source; rows[0].selected = false;
  context.controller.current.abort();
  context.controller.current.signal.throwIfAborted();
};
assert.equal(await runScreen(), false);
assert.equal(savedScreen.entries[0].selected, false, "save completed screening results when interrupted");
assert.equal(context.controller.current, null);
console.log("PASS screen failures stay selected with one final error summary, while completed results survive request failure and interruption");

const importStart = workspaceCode.indexOf("  const importFile = async");
const importEnd = workspaceCode.indexOf("  const downloadImportReport", importStart);
const importCode = (await transform(workspaceCode.slice(importStart, importEnd), { loader: "ts", target: "es2022" })).code;
const importStates = [];
const importContext = { ...context, importMode: "replace", importGameText: project.importGameText,
  current: { current: { ...initialProject, entries: [entry] } }, options: { target: "zh-CN", source: "ja" }, detectedSource: "ja", membership: { current: null },
  setImportingFile: value => importStates.push(value), setImportIssues() {}, setImportReport() {},
};
const runImport = new Function("context", "with(context) {" + importCode + ";return importFile;}")(importContext);
await runImport({ name: "fixture.json", arrayBuffer: async () => {
  assert.deepEqual(importStates, [true], "only a real file import turns on the import overlay");
  return new TextEncoder().encode(JSON.stringify({ [entry.source]: "您好" }));
} });
assert.deepEqual(importStates, [true, false]);
importStates.length = 0;
await assert.rejects(runImport({ name: "broken.json", arrayBuffer: async () => { throw new Error("读取失败"); } }), /读取失败/);
assert.deepEqual(importStates, [true, false], "clear the import overlay even if reading fails");
console.log("PASS importing indicator is limited to file imports and clears after success or read errors");

const naturalRequests = [];
store.set("llmchat-model-profiles", JSON.stringify({ "fixture-dialogue": { apiUrl: "http://localhost:11434/v1/chat/completions", apiKey: "" } }));
runtime.models = ["fixture-model"];
runtime.options = { kind: "llm", model: "fixture-model", dialogueModel: "fixture-dialogue", target: "zh-CN", source: "ja", joinLines: true, wrapMode: "natural", lineMode: "model", lineModel: "unused-line-model" };
runtime.wrapMode = "natural";
runtime.api.getSettings = async () => ({ model: "fixture-model", apiUrl: "http://localhost:11434/v1/chat/completions", apiKey: "" });
runtime.buildUnityTranslateOptions = translationModule.buildUnityTranslateOptions;
runtime.gameTaskPrompt = prompts.gameTaskPrompt;
runtime.prepareGameOllamaModels = async () => {};
runtime.localTextRequestGroup = translationModule.localTextRequestGroup;
runtime.translateGameControls = project.translateGameControls;
runtime.prepareUnityTranslationRequest = translationModule.prepareUnityTranslationRequest;
runtime.gameTranslationRetry = () => ({});
runtime.canDisableOllamaNameThinking = () => false;
runtime.isGameDialogue = () => true;
let validations = 0;
runtime.validateGameNaturalLines = (source, translated) => { validations++; return layout.validateGameNaturalLines(source, translated); };
const naturalSource = "こんにちは\nお元気ですか";
const naturalTranslation = "你好，最近\n怎么样？";
runtime.translateGameWithOllama = async (input, _init, config) => {
  naturalRequests.push({ input, config });
  return { ok: true, translation: naturalTranslation };
};
runtime.current.current = { ...initialProject, entries: [{ ...entry, source: naturalSource, translation: "" }], workflow: { screened: true, version: project.gameTextScreeningVersion, screenedIds: ["1"], skippedIds: [] } };
runtime.baseline.current = JSON.parse(JSON.stringify(runtime.current.current));
assert.equal(await runTranslation(), true, runtime.progressFailure);
assert.equal(naturalRequests.length, 1, "natural wrapping is integrated into the translation request, with no extra line-model call");
assert.equal(naturalRequests[0].input, naturalSource, "the model sees original line lengths and line breaks");
assert.equal(naturalRequests[0].config.model, "fixture-dialogue", "natural wrapping still uses the selected dialogue model");
assert.ok(naturalRequests[0].config.prompt.includes(layout.GAME_NATURAL_LINE_PROMPT));
assert.equal(runtime.current.current.entries[0].translation, naturalTranslation, "keep the model's chosen line breaks without local reflow");
assert.equal(validations, 1, "dialogue output also goes through paragraph/line structure validation");

const noticeSource = "%1 の%2を得た", noticeTranslation = "%1 获得了它的%2。";
runtime.options = { ...runtime.options, kind: "engine", wrapMode: "join", lineMode: "local" };
runtime.wrapMode = "join";
runtime.wrapGameTextToSource = layout.wrapGameTextToSource;
runtime.createUnityEnginePool = () => ({ concurrency: 1, dispose() {}, translate: async () => noticeTranslation });
runtime.current.current = { ...initialProject, entries: [{ ...entry, source: noticeSource, translation: "" }], workflow: { screened: true, version: project.gameTextScreeningVersion, screenedIds: ["1"], skippedIds: [] } };
runtime.baseline.current = JSON.parse(JSON.stringify(runtime.current.current));
assert.equal(await runTranslation(), true, runtime.progressFailure);
assert.equal(runtime.current.current.entries[0].translation, noticeTranslation, "the real local-formatting path keeps the screenshot's short notice on one line");
console.log("PASS actual natural translation keeps original layout in one model request, validates dialogue and avoids hard wrapping short system notices");

const resetStart = workspaceCode.indexOf("  const resetTranslation = async");
const resetEnd = workspaceCode.indexOf("  const run = async", resetStart);
const resetCode = (await transform(workspaceCode.slice(resetStart, resetEnd), { loader: "ts", target: "es2022" })).code;
const removedCaches = [];
const resetContext = { ...context, busy: false, screened: true, gamePath: "fixture-game", confirmation: { ask: async () => true },
  current: { current: { ...initialProject, entries: [{ ...entry, translationResult: { translation: "旧译文", target: "zh-CN" } }, { ...entry, id: "kept", selected: false }], workflow: { screened: true, version: project.gameTextScreeningVersion, screenedIds: ["1"] } } },
  clearGameTermMemory: (...args) => removedCaches.push(args), clearGamePerformance() {},
};
resetContext.publish = value => { resetContext.current.current = value; };
resetContext.persist = async value => { resetContext.saved = JSON.parse(JSON.stringify(value)); };
const resetTranslation = new Function("context", "with(context) {" + resetCode + ";return resetTranslation;}")(resetContext);
await resetTranslation();
assert.deepEqual(removedCaches, [["fixture-game", "zh-CN"]]);
assert.equal(resetContext.saved.entries[0].translation, "");
assert.equal(resetContext.saved.entries[0].translationResult, undefined);
assert.equal(resetContext.saved.entries[1].translation, entry.translation, "clearing selected rows keeps other translations");
assert.equal(resetContext.saved.workflow.freshTerms, true);

const clearScreenStart = workspaceCode.indexOf("  const clearScreen = async");
const clearScreenEnd = workspaceCode.indexOf("  const textReady =", clearScreenStart);
const clearScreenCode = (await transform(workspaceCode.slice(clearScreenStart, clearScreenEnd), { loader: "ts", target: "es2022" })).code;
const clearContext = { ...resetContext, current: { current: { ...initialProject, entries: [entry] } }, optionWrite: { current: null }, writes: { current: Promise.resolve() }, baseline: { current: null }, setImportIssues() {}, setImportReport() {} };
clearContext.persist = async value => { clearContext.saved = JSON.parse(JSON.stringify(value)); };
clearContext.publish = value => { clearContext.current.current = value; };
clearContext.gameTextRequest = async () => clearContext.saved;
const clearScreen = new Function("context", "with(context) {" + clearScreenCode + ";return clearScreen;}")(clearContext);
await clearScreen();
assert.equal(removedCaches.length, 2, "clearing either screening results or translation results deletes the terminology cache");
assert.equal(clearContext.saved.entries[0].translation, "");
assert.equal(clearContext.saved.workflow.freshTerms, true);

runtime.current.current = { ...initialProject, entries: [{ ...entry, id: "4", source: "こんにちは", translation: "" }], workflow: { screened: true, version: project.gameTextScreeningVersion, freshTerms: true, screenedIds: ["4"] } };
runtime.baseline.current = JSON.parse(JSON.stringify(runtime.current.current));
runtime.prepareGameTerms = async (...args) => { assert.equal(args.at(-1), false); return { terms: new Map(), issues: [] }; };
runtime.persist = async value => { runtime.finalFile = JSON.parse(JSON.stringify(value)); };
runtime.createUnityEnginePool = () => ({ concurrency: 1, dispose() {}, translate: async () => "你好" });
assert.equal(await runTranslation(), true, runtime.progressFailure);
assert.equal(runtime.finalFile.entries[0].translation, "你好", "write the complete file after the last result, not just incremental checkpoints");
assert.equal(runtime.finalFile.workflow.freshTerms, false, "finish the fresh-term mode after all selected rows are complete");
console.log("PASS actual clear removes terminology/provenance cache and completed runs refresh the complete translation file");
