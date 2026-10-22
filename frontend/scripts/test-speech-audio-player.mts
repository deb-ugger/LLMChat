import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/SpeechAudioPlayer.tsx", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
let cursor = 0, refCursor = 0;
const states: any[] = [];
const refs: any[] = [], playback: any[] = [], calls: string[] = [];
const fakeAudio = { play: async () => { calls.push("play"); }, pause: () => { calls.push("pause"); } };
const analyser = { frequencyBinCount: 128, connect: () => calls.push("destination"), getByteFrequencyData: (data: Uint8Array) => data.fill(128) };
let contexts = 0;
class FakeAudioContext {
  destination = {};
  constructor() { contexts++; }
  createAnalyser() { return analyser; }
  createMediaElementSource(element: any) { assert.equal(element, fakeAudio); return { connect: (node: any) => { assert.equal(node, analyser); calls.push("source"); } }; }
  async resume() { calls.push("resume"); }
  async suspend() { calls.push("suspend"); }
  async close() { calls.push("close"); }
}
const jsx = (type: any, props: any) => ({ type, props });
const exports: any = {};
const mocks: any = {
  react: { useEffect() {}, useRef: (current: any) => { const index = refCursor++; return refs[index] ??= { current: index === 0 ? fakeAudio : current }; }, useState: (initial: any) => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
    return [states[index], (value: any) => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
  } },
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "@tauri-apps/api/core": { convertFileSrc: (path: string) => path },
  "../speech/transcription": { formatSpeechTime: () => "00:00:00.000" },
};
let frameId = 0;
const frames = new Map<number, (time: number) => void>(), cancelled: number[] = [];
vm.runInNewContext(js, { exports, require: (name: string) => mocks[name], localStorage: { getItem: () => "1" }, AudioContext: FakeAudioContext,
  window: { devicePixelRatio: 1 }, getComputedStyle: () => ({ color: "#365b8a" }),
  requestAnimationFrame: (run: (time: number) => void) => { frames.set(++frameId, run); return frameId; }, cancelAnimationFrame: (id: number) => cancelled.push(id) });
function all(node: any): any[] { return Array.isArray(node) ? node.flatMap(all) : node?.props ? [node, ...all(node.props.children)] : []; }
const onPlaybackChange = (value: any) => playback.push(value);
const render = () => { cursor = 0; refCursor = 0; return exports.SpeechAudioPlayer({ path: "fixture.wav", onPlaybackChange }); };
let tree = render();
const volume = () => all(tree).find(node => node.props.className?.startsWith("speech-volume") && !node.props.className.includes("popup"));
const button = () => all(tree).find(node => node.props["aria-label"] === "调整音量");
assert.equal(button().props["aria-expanded"], false);
const audio = () => all(tree).find(node => node.type === "audio");
assert.equal(audio().props.crossOrigin, "anonymous", "本地资产以 CORS 模式进入音频分析器");
all(tree).find(node => node.props["aria-label"] === "播放音频").props.onClick();
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(calls.slice(0, 4), ["source", "destination", "resume", "play"]);
audio().props.onPlay(); tree = render();
assert.equal(playback.at(-1).path, "fixture.wav"); assert.equal(playback.at(-1).analyser, analyser);
all(tree).find(node => node.props["aria-label"] === "暂停试听").props.onClick();
audio().props.onPause(); tree = render();
assert.equal(playback.at(-1), null);
assert.ok(calls.includes("suspend"));
all(tree).find(node => node.props["aria-label"] === "播放音频").props.onClick();
await new Promise(resolve => setImmediate(resolve));
assert.equal(contexts, 1, "反复播放复用同一音频节点，不重复连接音频元素");
audio().props.onPlay(); audio().props.onEnded(); tree = render();
assert.equal(playback.at(-1), null, "自然播放结束也停止队列动画");
volume().props.onPointerEnter(); tree = render();
assert.equal(button().props["aria-expanded"], true);
button().props.onClick(); tree = render();
assert.equal(button().props["aria-expanded"], true, "悬停后点击仍保持打开，不反向关闭");
volume().props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} }); tree = render();
assert.equal(button().props["aria-expanded"], true, "焦点从图标移到滑块不关闭");
all(tree).find(node => node.props["aria-label"] === "音量").props.onChange({ target: { value: "0.42" } }); tree = render();
assert.equal(all(tree).find(node => node.props["aria-label"] === "音量").props.value, 0.42);
volume().props.onPointerLeave(); tree = render();
assert.equal(button().props["aria-expanded"], false);
volume().props.onFocus(); tree = render();
assert.equal(button().props["aria-expanded"], true, "键盘聚焦可打开音量");
volume().props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: {} }); tree = render();
assert.equal(button().props["aria-expanded"], false);
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
assert.match(css, /\.speech-volume-popup::after\s*\{[^}]*top:\s*100%[^}]*height:\s*8px/, "浮层和图标之间有连续的鼠标命中区域");
assert.match(css, /\.speech-job\.is-playing\s*\{[^}]*10s[^}]*infinite alternate/, "播放行使用缓慢循环渐变");
const effects: any[] = [];
mocks.react.useEffect = (run: any) => effects.push(run);
render(); effects[1]()();
assert.ok(calls.includes("close"), "卸载时关闭 AudioContext");
let cleanup: any;
const heights: number[] = [];
const drawing = { clearRect() { heights.length = 0; }, beginPath() {}, roundRect(_x: number, _y: number, _w: number, height: number) { heights.push(height); }, fill() {} };
mocks.react.useRef = () => ({ current: { clientWidth: 240, clientHeight: 28, width: 0, height: 0, getContext: () => drawing } });
mocks.react.useEffect = (run: any) => { cleanup = run(); };
exports.SpeechWaveform({ analyser });
frames.get(frameId)!(40);
assert.equal(heights.length, 48); assert.ok(heights.every(height => height > 2));
analyser.getByteFrequencyData = data => data.fill(0);
frames.get(frameId)!(80);
assert.ok(heights.every(height => height === 2), "静音时波形收缩，柱高来自真实分析数据而非随机动画");
cleanup(); assert.equal(cancelled.at(-1), frameId, "暂停或切换任务后停止绘制循环");
console.log("PASS: 音量浮层、Web Audio 链路复用、播放和结束通知、真实频谱柱高、动画清理");
