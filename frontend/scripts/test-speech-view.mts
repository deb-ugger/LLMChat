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
const openedFolders: string[] = [], resized: Array<{ key: string; axis: string }> = [];
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
  "../hooks/usePersistedSize": { usePersistedSize: (key: string, size: number, _min: number, _max: number, axis: string) => ({ size, beginResize() { resized.push({ key, axis }); } }) },
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
  assert.equal(all(aside).filter(node => node.props.className === "speech-settings").length, 0, "参数区位于右侧而非队列下方");
  assert.equal(all(main).filter(node => node.props.className === "speech-settings").length, 1);
  assert.equal(text(all(main).find(node => node.props.className === "speech-results-heading")), "转写结果");
  assert.equal(all(aside).filter(node => node.props.className === "speech-file-picker").length, status ? 0 : 1, "有文件后隐藏拖放提示");
  assert.ok(all(aside).find(node => node.type === "button" && text(node) === "开始 / 继续队列"));
  assert.ok(all(aside).find(node => node.type === "button" && text(node) === "全部暂停"));
  if (status) assert.equal(text(all(aside).find(node => node.props.className === "speech-job-percent")), "33.3%");
  const locations = all(main).filter(node => node.props.className === "speech-output-location");
  assert.equal(locations.length, 1, "output path appears once in the right result area");
  assert.match(text(locations[0]), /输出到：E:\\LLMChat\\speech-output/);
  const header = all(main).find(node => node.props.className === "speech-results-header");
  assert.ok(all(header).includes(locations[0]), "输出位置与结果标题位于同一标题行");
  assert.equal(all(header).filter(node => node.type === "input" && node.props.type === "search").length, 0, "标题区不放全局搜索");
  assert.equal(all(main).filter(node => ["speech-progress", "speech-result-top", "speech-task-summary"].includes(node.props.className)).length, 0, "结果区移除重复任务信息和大进度卡");
  all(main).find(node => node.props["aria-label"] === "调整参数与结果区域高度").props.onMouseDown({});
  assert.deepEqual(resized.at(-1), { key: "llmchat-speech-options-height", axis: "y" });
  const openFolder = all(locations[0]).find(node => node.props["aria-label"] === "打开输出目录");
  if (status && !["ready", "resetting"].includes(status)) {
    assert.ok(openFolder);
    openFolder.props.onClick();
    await Promise.resolve();
    assert.equal(openedFolders.at(-1), items[0].folder);
  } else assert.equal(openFolder, undefined);
  const reset = all(aside).filter(node => node.type === "button" && text(node) === "清除进度");
  assert.equal(reset.length, status ? 1 : 0, "清除进度始终显示");
  if (status) assert.equal(reset[0].props.disabled, status !== "paused");
  if (status === "paused") { reset[0].props.onClick({ stopPropagation() {} }); await Promise.resolve(); }
  if (status === "resetting") assert.equal(all(aside).find(node => node.props["aria-label"] === "取消并清理").props.disabled, true);
  if (status === "running") {
    assert.equal(all(aside).filter(node => node.props["aria-label"] === "暂停转写").length, 1);
    assert.match(text(all(aside).find(node => node.props.className === "speech-job-timing")), /已用 0s.*预计剩余：首段完成后估算/, "用时与预计剩余放在队列中");
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
mocks["../speech/native"].speechNative.preview = (folder: string, page: number, query: string) => new Promise(resolve => pending.push({ folder, page, query, resolve }));
const renderEffects = () => { effectCursor = 0; return render(); };
const task = (id: string, started: boolean) => ({ id, showOutput: true, status: started ? "running" : "ready", source: { ...sourceAudio, path: `D:\\${id}.wav`, name: `${id}.wav` },
  folder: started ? `E:\\LLMChat\\speech-output\\${id}` : "", options: { model: model.id, formats: ["srt"] }, offset: started ? 20 : 0, cueCount: 1, elapsedMs: 500, revision: 1 });
items = [task("first", true), task("waiting", false), task("second", true)];
states = [];
let tree = renderEffects();
const tabs = () => all(tree).filter(node => node.props.role === "tab");
const title = () => text(tabs().find(node => node.props["aria-selected"]));
assert.equal(tabs().length, 2, "仅开始后的文件出现结果标签页");
assert.equal(title(), "first.wav");
pending.at(-1).resolve({ cues: [{ start: 0, end: 1, text: "FIRST-CONTENT" }], total: 1 });
await Promise.resolve(); tree = renderEffects();
assert.match(text(tree), /FIRST-CONTENT/);
const player = () => all(tree).find(node => node.props.onPlaybackChange);
player().props.onPlaybackChange({ path: items[0].source.path, analyser: { fixture: true } }); tree = renderEffects();
const firstRow = () => all(tree).find(node => node.type === "article" && text(node).includes("first.wav"));
assert.match(firstRow().props.className, /is-playing/, "只为实际试听的音频启用渐变背景");
assert.equal(all(firstRow()).filter(node => node.type === "progress").length, 0, "播放时用频谱替换细进度条");
assert.doesNotMatch(all(tree).find(node => node.type === "article" && text(node).includes("second.wav")).props.className, /is-playing/);
all(tree).find(node => node.type === "article" && text(node).includes("waiting.wav")).props.onClick(); tree = renderEffects();
assert.equal(player().props.path, items[0].source.path, "切换任务不替换正在播放的媒体元素路径");
assert.match(firstRow().props.className, /is-playing/, "切换到其他任务时原音频继续播放");
assert.equal(title(), "");
firstRow().props.onClick(); tree = renderEffects();
player().props.onPlaybackChange(null); tree = renderEffects();
assert.doesNotMatch(firstRow().props.className, /is-playing/);
assert.equal(all(firstRow()).filter(node => node.type === "progress").length, 1, "暂停试听恢复转写进度条");
assert.equal(items[0].offset, 20, "试听不改变转写断点");
tabs()[1].props.onClick(); tree = renderEffects();
assert.equal(title(), "second.wav");
assert.doesNotMatch(text(tree), /FIRST-CONTENT/, "切页后不显示上一文件的内容");
pending.at(-1).resolve({ cues: [{ start: 0, end: 1, text: "SECOND-CONTENT" }], total: 1 });
await Promise.resolve(); tree = renderEffects();
assert.match(text(tree), /SECOND-CONTENT/);
const search = () => all(tree).find(node => node.props["aria-label"] === "搜索");
const filePage = all(tree).find(node => node.props.role === "tabpanel");
assert.ok(all(filePage).includes(search()), "搜索位于当前音频结果页内");
assert.equal(search().props.placeholder, "搜索");
assert.ok(all(all(filePage).find(node => node.props.role === "search")).some(node => node.type === "svg"), "搜索框包含搜索图标");
const viewSwitch = all(tree).find(node => node.props.role === "radiogroup");
all(viewSwitch).find(node => node.props.role === "radio" && text(node) === "纯文本").props.onClick(); tree = renderEffects();
assert.equal(all(tree).find(node => node.props.role === "radio" && text(node) === "纯文本").props["aria-checked"], true);
assert.ok(all(tree).find(node => node.props.className === "speech-preview"));
all(tree).find(node => node.props.role === "radio" && text(node) === "时间轴").props.onClick(); tree = renderEffects();
search().props.onChange({ target: { value: "CONTENT" } }); tree = renderEffects();
assert.equal(pending.at(-1).query, "CONTENT");
assert.equal(pending.at(-1).page, 0);
assert.doesNotMatch(text(tree), /SECOND-CONTENT/, "新搜索完成前不显示旧预览");
pending.at(-1).resolve({ cues: [{ start: 0, end: 1, text: "matching CONTENT" }], total: 105 });
await Promise.resolve(); tree = renderEffects();
assert.match(text(tree), /找到 105 段/);
assert.equal(text(all(tree).find(node => node.type === "mark")), "CONTENT");
all(tree).find(node => node.type === "button" && text(node) === "下一页").props.onClick(); tree = renderEffects();
assert.equal(pending.at(-1).page, 1); assert.equal(pending.at(-1).query, "CONTENT", "搜索分页保留关键词");
assert.doesNotMatch(text(tree), /matching CONTENT/, "搜索翻页时不把旧页内容标为新页");
const staleSearch = pending.at(-1);
all(tree).find(node => node.type === "article" && text(node).includes("waiting.wav")).props.onClick(); tree = renderEffects();
assert.equal(title(), "", "点击未开始的文件清空右侧结果");
assert.equal(all(tree).filter(node => node.props.role === "tabpanel").length, 0);
assert.equal(tabs().length, 0, "未开始任务的空态不保留旧结果标签");
staleSearch.resolve({ cues: [{ start: 0, end: 1, text: "STALE-SEARCH-CONTENT" }], total: 1 });
await Promise.resolve(); tree = renderEffects();
assert.doesNotMatch(text(tree), /STALE-SEARCH-CONTENT/, "切换任务后丢弃旧搜索返回值");
const checkbox = (id: string) => all(all(tree).find(node => node.type === "article" && text(node).includes(`${id}.wav`))).find(node => node.type === "input" && node.props.type === "checkbox");
checkbox("first").props.onChange({ target: { checked: false } }); tree = renderEffects();
assert.equal(tabs().length, 0); assert.equal(title(), "");
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
console.log("PASS: 队列布局、拖放提示、百分比、禁用清理、任务切换空态、结果搜索与分页、过期响应隔离");
