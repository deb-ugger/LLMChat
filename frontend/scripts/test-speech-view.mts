import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/SpeechView.tsx", import.meta.url), "utf8");
const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const pref = { outputRoot: "E:\\LLMChat\\speech-output", formats: ["srt"], concurrency: 1 };
const model = { id: "test", label: "Whisper", description: "识别录音", sizeMiB: 41 };
const sourceAudio = { path: "D:\\录音.wav", name: "录音.wav", duration: 60 };
const exports: any = {}, resets: string[] = [];
const cancelled: string[] = [], confirmations: string[] = [];
const openedFolders: string[] = [];
let confirmResult = false;
let items: any[] = [];
let states: any[] = [], stateCursor = 0;
const helpers: any = {};
vm.runInNewContext(compile(readFileSync(new URL("../src/speech/transcription.ts", import.meta.url), "utf8")), { exports: helpers });
const jsx = (type: any, props: any) => ({ type, props });
const mocks: Record<string, any> = {
  react: { useEffect() {}, useRef: (current: any) => ({ current }), useState: (initial: any) => {
    const index = stateCursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], (value: any) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
  } },
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "../api": { api: { openPath: async (path: string) => { openedFolders.push(path); } } },
  "@tauri-apps/api/core": { isTauri: () => false },
  "@tauri-apps/plugin-dialog": { confirm: async (message: string) => { confirmations.push(message); return confirmResult; } },
  "../speech/native": { speechNative: {} },
  "../hooks/usePersistedSize": { usePersistedSize: (_key: string, size: number) => ({ size, beginResize() {} }) },
  "../speech/models": { useSpeechModels: () => ({ preferences: pref, selected: model.id, rows: [], download: null }) },
  "../speech/queue": { useSpeechQueue: () => ({ items }), speechQueue: {
    reset: async (id: string) => { resets.push(id); return "fresh"; },
    setShowOutput: (id: string, showOutput: boolean) => { items = items.map(item => item.id === id ? { ...item, showOutput } : item); },
    start: (id: string) => { items = items.map(item => item.id === id ? { ...item, fromHistory: false, status: "queued", folder: `E:\\LLMChat\\speech-output\\${id}` } : item); },
    cancel: async (id: string) => { cancelled.push(id); },
    pump() {}, pause() {}, restore: async () => {},
  } },
  "../speech/transcription": { ...helpers, SPEECH_MODELS: [model] },
};
vm.runInNewContext(compile(source), { exports, require: (name: string) => mocks[name] ?? {}, performance, window: { innerWidth: 1200, innerHeight: 800 } });
function all(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(all);
  return node?.props ? [node, ...all(node.props.children)] : [];
}
function text(node: any): string {
  if (Array.isArray(node)) return node.map(text).join("");
  return node?.props ? text(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render(reset = false) {
  if (reset) states = [];
  stateCursor = 0;
  return exports.SpeechView({ active: true });
}
for (const status of [null, "ready", "running", "pausing", "paused", "resetting"]) {
  items = status ? [{ id: "task", status, showOutput: true, source: sourceAudio, folder: status === "ready" ? "" : "E:\\LLMChat\\speech-output\\speech-task", options: { model: model.id, formats: ["srt"] }, offset: 20, cueCount: 1, elapsedMs: 500, revision: 1 }] : [];
  const tree = render(true);
  const aside = all(tree).find(node => node.type === "aside");
  const main = all(tree).find(node => node.type === "main");
  assert.equal(all(aside).filter(node => node.props.className === "speech-output-location").length, 0);
  const locations = all(main).filter(node => node.props.className === "speech-output-location");
  assert.equal(locations.length, 1, "output path appears once in the right result area");
  assert.match(text(locations[0]), /输出到：E:\\LLMChat\\speech-output/);
  const openFolder = all(locations[0]).find(node => node.type === "button" && text(node) === "打开输出目录");
  if (status && !["ready", "resetting"].includes(status)) {
    assert.ok(openFolder);
    openFolder.props.onClick();
    await Promise.resolve();
    assert.equal(openedFolders.at(-1), items[0].folder);
  } else assert.equal(openFolder, undefined);
  const reset = all(aside).filter(node => node.type === "button" && text(node) === "清除进度");
  assert.equal(reset.length, status === "paused" ? 1 : 0, "clear progress is available only after pause finishes");
  if (status === "paused") { reset[0].props.onClick({ stopPropagation() {} }); await Promise.resolve(); }
  if (status === "resetting") assert.equal(all(aside).filter(node => node.type === "button" && ["开始转写", "继续转写", "取消并清理"].includes(node.props["aria-label"])).length, 0);
  if (status === "running") {
    assert.equal(all(aside).filter(node => node.props["aria-label"] === "暂停转写").length, 1);
    assert.equal(text(all(main).filter(node => node.props.className === "speech-stat")[1]), "0s本次处理用时", "processing time uses integer seconds");
  }
  if (status === "paused") {
    const trash = all(aside).find(node => node.props["aria-label"] === "取消并清理");
    assert.equal(text(trash), "", "cleanup is an accessible icon, not a text button");
    trash.props.onClick({ stopPropagation() {} }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled.length, 0, "rejecting confirmation must preserve the task");
    confirmResult = true;
    trash.props.onClick({ stopPropagation() {} }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(cancelled, ["task"]);
    assert.match(confirmations[0], /原音频文件将保留/);
  }
}
assert.deepEqual(resets, ["task"]);

const pending: any[] = [];
const effects: any[] = [];
let effectCursor = 0;
mocks.react.useEffect = (run: any, deps: any[]) => {
  const index = effectCursor++, previous = effects[index];
  if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
  previous?.cleanup?.();
  effects[index] = { deps, cleanup: run() };
};
mocks["../speech/native"].speechNative.preview = (folder: string) => new Promise(resolve => pending.push({ folder, resolve }));
const renderEffects = () => { effectCursor = 0; return render(); };
const task = (id: string, started: boolean) => ({ id, showOutput: true, status: started ? "running" : "ready", source: { ...sourceAudio, name: `${id}.wav` },
  folder: started ? `E:\\LLMChat\\speech-output\\${id}` : "", options: { model: model.id, formats: ["srt"] }, offset: started ? 20 : 0, cueCount: 1, elapsedMs: 500, revision: 1 });
items = [task("waiting", false), task("first", true), task("second", true)];
states = [];
let tree = renderEffects();
const tabs = () => all(tree).filter(node => node.props.role === "tab");
const title = () => text(all(tree).find(node => node.type === "h2"));
assert.equal(tabs().length, 2, "仅开始后的文件出现结果标签页");
assert.equal(title(), "first.wav");
pending.at(-1).resolve({ cues: [{ start: 0, end: 1, text: "FIRST-CONTENT" }], total: 1 });
await Promise.resolve(); tree = renderEffects();
assert.match(text(tree), /FIRST-CONTENT/);
tabs()[1].props.onClick(); tree = renderEffects();
assert.equal(title(), "second.wav");
assert.doesNotMatch(text(tree), /FIRST-CONTENT/, "切页后不显示上一文件的内容");
pending.at(-1).resolve({ cues: [{ start: 0, end: 1, text: "SECOND-CONTENT" }], total: 1 });
await Promise.resolve(); tree = renderEffects();
assert.match(text(tree), /SECOND-CONTENT/);
all(tree).find(node => node.type === "article" && text(node).includes("waiting.wav")).props.onClick(); tree = renderEffects();
assert.equal(title(), "second.wav", "点击未开始的文件只切换左侧选中项");
const checkbox = (id: string) => all(all(tree).find(node => node.type === "article" && text(node).includes(`${id}.wav`))).find(node => node.type === "input" && node.props.type === "checkbox");
checkbox("first").props.onChange({ target: { checked: false } }); tree = renderEffects();
assert.equal(tabs().length, 1); assert.equal(title(), "second.wav");
checkbox("second").props.onChange({ target: { checked: false } }); tree = renderEffects();
assert.equal(tabs().length, 0);
assert.equal(all(tree).filter(node => node.props.role === "tabpanel").length, 0);
const waitingCard = all(tree).find(node => node.type === "article" && text(node).includes("waiting.wav"));
all(waitingCard).find(node => node.props["aria-label"] === "开始转写").props.onClick({ stopPropagation() {} }); tree = renderEffects();
assert.equal(tabs().length, 1); assert.equal(title(), "waiting.wav", "开始后新增对应文件页面");

items.push({ ...task("history", true), status: "paused", fromHistory: true }); tree = renderEffects();
assert.equal(tabs().length, 1, "history does not create a result page before explicit resume");
const historySection = all(tree).find(node => node.props["aria-label"] === "未完成任务");
assert.match(text(historySection), /history.wav/);
all(historySection).find(node => node.props["aria-label"] === "继续转写").props.onClick({ stopPropagation() {} }); tree = renderEffects();
assert.equal(tabs().length, 2); assert.equal(title(), "history.wav");
assert.equal(all(tree).filter(node => node.props["aria-label"] === "未完成任务").length, 0);
let focused = false;
tabs()[1].props.onKeyDown({ key: "Home", preventDefault() {}, currentTarget: { parentElement: { querySelectorAll: () => [{ focus() { focused = true; } }] } } }); tree = renderEffects();
assert.equal(title(), "waiting.wav"); assert.equal(focused, true, "tab keyboard navigation focuses the selected tab");
effects.forEach(effect => effect?.cleanup?.());
console.log("PASS: 图标操作与清理确认、整数秒、未完成任务、选项卡键盘切换、文件内容隔离");
