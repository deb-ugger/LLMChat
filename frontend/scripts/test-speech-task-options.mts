import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const compile = (code: string) => ts.transpileModule(code, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const helpers: any = {};
vm.runInNewContext(compile(readFileSync(new URL("../src/speech/transcription.ts", import.meta.url), "utf8")), { exports: helpers });
const [localModel, nextModel] = helpers.SPEECH_MODELS;
const chineseModel = helpers.SPEECH_MODELS.find((model: any) => model.language === "chinese");
const pref: any = { model: nextModel.id, mode: "local", outputRoot: "E:\\new-output", concurrency: 1,
  language: "english", chineseScript: "traditional", formats: ["vtt"],
  onlineProvider: "google", onlineModel: "new-online-model", proofread: false, proofreadModel: "new-proofreader" };
const savedOptions = { model: localModel.id, language: "japanese", chineseScript: "original", formats: ["srt", "txt"] };
const task = (id: string, options: any = savedOptions, extra: any = {}) => ({
  id, source: { path: `E:\\${id}.wav`, name: `${id}.wav`, duration: 60 }, options,
  folder: `E:\\old-output\\${id}`, status: "paused", fromHistory: false, showOutput: true,
  offset: 20, cueCount: 3, elapsedMs: 1000, revision: 0, ...extra,
});
let items: any[] = [];
let states: any[] = [], cursor = 0;
const starts: string[] = [];
const jsx = (type: any, props: any) => ({ type, props });
const mocks: Record<string, any> = {
  react: { useEffect() {}, useRef: (current: any) => ({ current }), useState: (initial: any) => {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], (value: any) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
  } },
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "@tauri-apps/api/core": { isTauri: () => false },
  "../hooks/usePersistedSize": { usePersistedSize: (_key: string, size: number) => ({ size, beginResize() {} }) },
  "../speech/transcription": helpers,
  "../speech/models": {
    useSpeechModels: () => ({ preferences: pref, selected: pref.model, rows: [], download: null }),
    setSpeechPreferences: (patch: any) => Object.assign(pref, patch),
    selectSpeechModel: (model: string) => { pref.model = model; },
    SPEECH_ONLINE_PROVIDERS: { google: { label: "Gemini" }, qwen: { label: "通义 Omni" }, custom: { label: "自定义音频接口" } },
  },
  "../speech/queue": { useSpeechQueue: () => ({ items }), speechQueue: { start: (id: string) => starts.push(id) } },
};
const exports: any = {};
const onlineControls: any = {};
vm.runInNewContext(compile(readFileSync(new URL("../src/components/SpeechOnlineControls.tsx", import.meta.url), "utf8")), {
  exports: onlineControls, require: (name: string) => mocks[name] ?? {},
});
mocks["./SpeechOnlineControls"] = onlineControls;
vm.runInNewContext(compile(readFileSync(new URL("../src/components/SpeechView.tsx", import.meta.url), "utf8")), {
  exports, require: (name: string) => mocks[name] ?? {}, performance, window: { innerWidth: 1200, innerHeight: 800 },
});
function all(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!node?.props) return [];
  return [node, ...all(node.props.children)];
}
function text(node: any): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (!node?.props) return typeof node === "string" || typeof node === "number" ? String(node) : "";
  return text(node.props.children);
}
function expand(node: any): any {
  if (Array.isArray(node)) return node.map(expand);
  if (!node?.props) return node;
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props.children) } };
}
function render(reset = true) {
  if (reset) states = [];
  cursor = 0;
  return expand(exports.SpeechView({ active: true }));
}
const section = (tree: any, label: string) => all(tree).find(node => node.props["aria-label"] === label);
const params = (tree: any) => section(tree, "当前任务参数");
const control = (scope: any, label: string) => all(all(scope).find(node => node.type === "label" && text(node).startsWith(label)))
  .find(node => node.type === "select" || node.type === "input");
const format = (scope: any, name: string) => all(all(scope).find(node => node.type === "label" && text(node) === name))
  .find(node => node.type === "input");
const script = (scope: any) => text(all(scope).find(node => node.props.className === "speech-chinese-script"));

for (const status of ["queued", "running", "pausing", "paused", "error", "done"]) {
  items = [task("saved", savedOptions, { status })];
  const tree = render();
  const current = params(tree);
  assert.equal(current.type, "fieldset");
  assert.equal(current.props.disabled, true, "旧任务的全部参数控件由原生 fieldset 禁用");
  assert.equal(section(tree, "新任务选项"), undefined, "旧任务不同时显示新任务选项");
  assert.equal(control(current, "识别模型").props.value, localModel.id);
  assert.equal(control(current, "录音语言").props.value, "japanese");
  assert.equal(control(current, "识别方式").props.value, "local");
  assert.equal(control(current, "大模型校对").props.checked, false);
  assert.equal(control(current, "校对模型").props.value, "未开启大模型校对");
  assert.equal(control(current, "校对模型").props.disabled, true);
  assert.equal(format(current, "SRT").props.checked, true);
  assert.equal(format(current, "VTT").props.checked, false);
  assert.equal(format(current, "TXT").props.checked, true);
  assert.equal(script(current), "中文简繁转换不转换");
  assert.equal(control(current, "中文简繁转换"), undefined, "操作页仅展示简繁设置，不提供编辑控件");
}

items = [task("saved"), task("ready", savedOptions, { folder: "", status: "ready" })];
let tree = render();
const selectTask = (id: string) => all(tree).find(node => node.type === "article" && text(node).includes(`${id}.wav`)).props.onClick();
selectTask("ready");
tree = render(false);
assert.equal(params(tree), undefined);
let next = section(tree, "新任务选项");
assert.equal(next.props.disabled, false, "切换到未开始任务后恢复编辑");
assert.equal(control(next, "识别模型").props.value, nextModel.id);
assert.equal(control(next, "录音语言").props.value, "english");
assert.equal(script(next), "中文简繁转换转为繁体");
assert.equal(control(next, "校对模型").props.disabled, true);
control(next, "大模型校对").props.onChange({ target: { checked: true } }); tree = render(false);
next = section(tree, "新任务选项");
assert.equal(control(next, "校对模型").props.disabled, false, "开启大模型校对后才允许编辑模型");
assert.equal(control(next, "校对模型").props.value, "new-proofreader", "关闭时不丢失原来选择的校对模型");
control(next, "大模型校对").props.onChange({ target: { checked: false } }); tree = render(false);
next = section(tree, "新任务选项");
format(next, "SRT").props.onChange({ target: { checked: true } });
control(next, "识别模型").props.onChange({ target: { value: chineseModel.id } });
assert.deepEqual(Array.from(pref.formats), ["vtt", "srt"]);
selectTask("saved"); tree = render(false);
assert.equal(control(params(tree), "识别模型").props.value, localModel.id);
assert.equal(format(params(tree), "VTT").props.checked, false, "切回旧任务后恢复其保存值");
assert.equal(params(tree).props.disabled, true);
all(tree).find(node => node.props["aria-label"] === "继续转写").props.onClick({ stopPropagation() {} });
assert.deepEqual(starts, ["saved"], "继续按钮仍只启动已有任务");
assert.deepEqual(savedOptions, { model: localModel.id, language: "japanese", chineseScript: "original", formats: ["srt", "txt"] });

items = [task("fixed-language", { ...savedOptions, model: chineseModel.id, language: "auto" })];
assert.equal(control(params(render()), "录音语言").props.value, "chinese", "特化模型显示实际使用的语言");
items = [task("online", { ...savedOptions, language: "auto", processing: {
  mode: "online", provider: "qwen", model: "saved-online-model", proofread: true, proofreadModel: "saved-proofreader",
} }, { showOutput: false })];
tree = render();
const online = params(tree);
assert.equal(online.props.disabled, true);
assert.equal(control(online, "识别方式").props.value, "online");
assert.equal(control(online, "在线服务").props.value, "qwen");
assert.equal(control(online, "音频模型").props.value, "saved-online-model");
assert.equal(control(online, "校对模型").props.value, "saved-proofreader");
assert.equal(control(online, "大模型校对").props.checked, true);
assert.equal(control(online, "录音语言").props.value, "auto");
assert.equal(control(online, "识别模型"), undefined, "在线旧任务不受新任务的本地模型选择影响");

items = [task("first"), task("second", { ...savedOptions, language: "korean" }, { fromHistory: true })];
tree = render();
all(tree).find(node => node.type === "article" && text(node).includes("second.wav")).props.onClick();
assert.equal(control(params(render(false)), "录音语言").props.value, "korean", "选择历史任务时展示该任务自己的参数");
items = [task("staging", savedOptions, { folder: "", status: "queued" })];
assert.equal(params(render()).props.disabled, true, "启动后等待任务落盘期间也禁用参数");
for (const initialItems of [[], [task("ready", savedOptions, { folder: "", status: "ready" })]]) {
  items = initialItems;
  tree = render();
  assert.equal(params(tree), undefined, "未启动任务不展示导入时的旧参数快照");
  assert.ok(section(tree, "新任务选项"));
}

const settings = readFileSync(new URL("../src/components/SpeechModelPanel.tsx", import.meta.url), "utf8");
assert.match(settings, /中文简繁转换<select/, "中文简繁转换的编辑入口仅在设置页");
assert.doesNotMatch(readFileSync(new URL("../src/components/SpeechView.tsx", import.meta.url), "utf8"), /speech-current-task|speech-parameter-list|中文简繁转换<select/, "删除额外摘要卡片和操作页简繁编辑控件");
console.log("PASS: 任务切换、旧任务整组禁用与保存值、新任务编辑、在线和历史任务、简繁仅设置页可编辑");
