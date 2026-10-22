import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const writes: any[] = [], dialogs: any[] = [];
const directories = new Map<string, string>();
let picked: string | null = "E:\\LLMChat\\结果.txt";
let failure: Error | null = null;
const output: any = {};
vm.runInNewContext(compile(read("outputFiles.ts")), {
  exports: output,
  localStorage: { getItem: (key: string) => directories.get(key), setItem: (key: string, value: string) => directories.set(key, value) },
  require: (name: string) => ({
    "@tauri-apps/api/core": { invoke: async (...args: any[]) => { if (failure) throw failure; writes.push(args); } },
    "@tauri-apps/api/path": { resourceDir: async () => "E:\\LLMChat", join: async (...parts: string[]) => parts.join("\\") },
    "@tauri-apps/plugin-dialog": { save: async (options: any) => { dialogs.push(options); return picked; } },
  })[name],
});
assert.equal(await output.saveOutputFile("结果.txt", new TextEncoder().encode("字幕"), ["txt"], "TXT", "text"), picked);
assert.equal(dialogs[0].defaultPath, "E:\\LLMChat\\结果.txt");
assert.equal(new TextDecoder().decode(new Uint8Array(writes[0][1].contents)), "字幕");
picked = null;
assert.equal(await output.saveOutputFile("image.png", new Uint8Array([1]), ["png"], "PNG", "literature"), null);
assert.equal(writes.length, 1, "取消保存不写文件");
picked = "E:\\LLMChat\\image.png"; failure = new Error("没有写入权限");
await assert.rejects(output.saveOutputFile("image.png", new Uint8Array([1]), ["png"], "PNG", "literature"), /没有写入权限/);
failure = null;
output.setOutputDirectory("text", "D:\\我的译文");
output.setOutputDirectory("literature", "D:\\文献图片");
await output.saveOutputFile("new.txt", new Uint8Array([1]), ["txt"], "TXT", "text");
assert.equal(dialogs.at(-1).defaultPath, "D:\\我的译文\\new.txt");
await output.saveOutputFile("new.png", new Uint8Array([1]), ["png"], "PNG", "literature");
assert.equal(dialogs.at(-1).defaultPath, "D:\\文献图片\\new.png");
assert.match(read("pdfImages.ts"), /saveOutputFile\(fileName/);
assert.match(read("components/TextTranslateView.tsx"), /saveOutputFile\(fileName/);

const directorySource = ts.createSourceFile("TextOutputSettings.tsx", read("components/TextOutputSettings.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let directoryChange = "";
function findChange(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(directorySource) === "change") directoryChange = node.initializer!.getText(directorySource);
  ts.forEachChild(node, findChange);
}
findChange(directorySource);
const pathWrites: any[] = [];
let selectedDirectory: string | null = "D:\\工程";
const directoryContext = {
  path: "E:\\旧工程", open: async () => selectedDirectory,
  api: {
    getStorage: async () => ({ entries: [{ id: "projects", path: "E:\\旧工程" }, { id: "data", path: "E:\\数据" }], pending: { projects: "E:\\旧工程", data: "D:\\待迁移数据" } }),
    saveStoragePaths: async (paths: any) => { pathWrites.push(paths); return {}; },
  },
  setBusy() {}, setStorage() {}, setError(value: string) { assert.equal(value, ""); }, toFriendlyError: String,
};
await vm.runInNewContext(compile(`const change = ${directoryChange}; change();`), directoryContext);
assert.equal(pathWrites[0].projects, "D:\\工程");
assert.equal(pathWrites[0].data, "D:\\待迁移数据", "修改工程目录保留其他待执行路径迁移");
selectedDirectory = null;
await vm.runInNewContext(compile(`const change = ${directoryChange}; change();`), { ...directoryContext });
assert.equal(pathWrites.length, 1, "取消目录选择不会提交迁移");

// Exercise the actual startup effect: new default, custom path, old default,
// and recovery of existing AppData tasks without moving their files.
const viewSource = ts.createSourceFile("SpeechView.tsx", read("components/SpeechView.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let startup = "";
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(viewSource) === "useEffect" && node.arguments[0]?.getText(viewSource).includes("speechNative.environment()")) startup = node.arguments[0].getText(viewSource);
  ts.forEachChild(node, visit);
}
visit(viewSource); assert.ok(startup);
const newRoot = "E:\\LLMChat\\speech-output", oldRoot = "C:\\AppData\\speech-output";
for (const chosenRoot of ["", oldRoot, "D:\\我的字幕"]) {
  let preferences = { outputRoot: chosenRoot };
  const restored: string[] = [], errors: string[] = [];
  vm.runInNewContext(compile(`const initialize = ${startup}; initialize();`), {
    active: true, initialized: { current: false }, isTauri: () => true,
    restored: { current: new Set() },
    speechNative: { environment: async () => ({ outputRoot: newRoot, legacyOutputRoot: oldRoot, toolsReady: true }) },
    speechQueue: { restore: async (root: string) => { restored.push(root); } },
    getSpeechPreferences: () => preferences,
    setSpeechPreferences: (patch: any) => { preferences = { ...preferences, ...patch }; },
    setToolsReady: () => {}, setError: (value: string) => errors.push(value), friendly: String,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(preferences.outputRoot, chosenRoot === "D:\\我的字幕" ? chosenRoot : newRoot);
  assert.deepEqual(restored, [oldRoot]); assert.deepEqual(errors, []);
}

const panel: any = {};
const model = { id: "zh", language: "chinese" };
vm.runInNewContext(compile(read("components/SpeechView.tsx")), {
  exports: panel,
  require: (name: string) => name === "react/jsx-runtime" ? { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) }
    : name === "../speech/transcription" ? { SPEECH_MODELS: [model] }
    : name === "../speech/models" ? { useSpeechModels: () => ({ selected: "zh", preferences: { language: "auto", chineseScript: "traditional", formats: ["txt"], concurrency: 1 } }) } : {},
});
const tree = panel.SpeechRunOptions();
const children = tree.props.children;
assert.equal(children[0].props.children[0], "录音语言");
assert.equal(children[0].props.children[1].props.value, "chinese");
assert.equal(children[0].props.children[1].props.disabled, true);
assert.equal(children[1].type, "fieldset", "运行页语言之后直接显示输出格式");
const settingsPanel: any = {};
vm.runInNewContext(compile(read("components/SpeechModelPanel.tsx")), {
  exports: settingsPanel,
  require: (name: string) => name === "react" ? { useEffect() {}, useState: (value: any) => [value, () => {}] }
    : name === "react/jsx-runtime" ? { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) }
    : name === "../speech/transcription" ? { SPEECH_MODELS: [model] }
    : name === "../speech/models" ? { useSpeechModels: () => ({ selected: "zh", preferences: { chineseScript: "traditional", concurrency: 1, outputRoot: "E:\\字幕" } }) } : {},
});
function descendants(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(descendants);
  return node?.props ? [node, ...descendants(node.props.children)] : [];
}
const scriptSelect = descendants(settingsPanel.SpeechModelPanel()).find(node => node.type === "select" && node.props.value === "traditional");
assert.ok(scriptSelect, "长期简繁偏好在语音设置中显示");
assert.equal(scriptSelect.props.disabled, undefined);
assert.doesNotMatch(read("speech/transcription.ts"), /配合简体|其他语言请选择|仍需复核/);
console.log("PASS: 软件目录保存起点、取消与错误、旧任务恢复、自定义路径、录音语言与简繁选项独立");
