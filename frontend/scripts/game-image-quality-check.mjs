import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { hostname: "localhost" } };
const bundle = await build({
  stdin: { contents: "export * as screening from './gameImageScreening'; export { processUnityImages } from './unityImages';",
    resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts" },
  bundle: true, write: false, platform: "browser", format: "esm", external: ["fs", "path"],
  define: { "import.meta.env.VITE_API_BASE": '""', "import.meta.env.DEV": "false" },
});
const { screening, processUnityImages } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
const signal = new AbortController().signal;
const screened = { id: "missed", sourceFile: "source", sourceHash: "hash", selected: false,
  ocrCompleted: false, completed: false, regions: [], screening: { version: 1, sourceHash: "hash",
    state: "no-text", source: "ja", target: "zh-CN", reason: "未检测到文字区域", boxes: 0 } };
assert.equal(screening.needsGameImageRefinement(screened, "audit"), true);
assert.equal(screening.needsGameImageRefinement({ ...screened, selectionManual: true }, "audit"), false);
assert.equal(screening.needsGameImageRefinement({ ...screened, screening: { ...screened.screening,
  state: "not-needed", reason: "粗筛跳过 tilesets 素材，可手动改选或使用完整筛选" } }, "audit"), true);
let saved;
await screening.refineGameImages([screened], signal, { refineKey: "audit", local: true, confidenceThreshold: 50 }, {
  read: async () => new Blob(), recognize: async () => ({ detectedBoxes: 1,
    lines: [{ text: "攻撃", confidence: 20, x0: 1, y0: 1, x1: 20, y1: 20 }] }),
  persist: async rows => { saved = rows[0]; },
}, () => {});
assert.equal(saved.screening.state, "review", "low-confidence text remains available for review");
assert.equal(screening.needsGameImageRefinement(saved, "audit"), false);

const image = (id, hash, translation = "") => ({ id, sourceFile: "source", sourceHash: hash, file: `${id}.png`,
  selected: true, ocrCompleted: true, completed: !!translation, error: "", regions: [
    { text: "Open", translation, translationTarget: "zh-CN", selected: true, confidence: 99,
      x0: 0, y0: 0, x1: 80, y1: 20, error: "", ocrConfirmed: true },
  ] });
async function translate(images) {
  let calls = 0;
  const outcomes = [];
  const result = processUnityImages({ entries: [], images }, signal, {
    targetLanguage: "zh-CN", concurrency: 2, translationConcurrency: 2, regionConcurrency: 2,
    read: async () => new Blob(), recognize: async () => [], translate: async () => { calls++; return "打开"; },
    render: async () => new Blob(), write: async () => ({ path: "", hash: "" }),
    persist: async (_, value) => outcomes.push(structuredClone(value)), validate: () => "",
  }, () => {}, 50, "translate-only");
  return { result: await result.catch(error => error), calls, outcomes };
}
assert.equal((await translate([image("menu", "a"), image("dialogue", "b")])).calls, 2,
  "different original images cannot share short-text translations");
assert.equal((await translate([image("copy-a", "same"), image("copy-b", "same")])).calls, 1,
  "byte-identical originals still share a pending translation");
const conflict = await translate([image("first", "same", "打开"), image("second", "same", "开门"), image("pending", "same")]);
assert.ok(conflict.result instanceof Error);
assert.ok(conflict.outcomes.some(row => row.regions.some(region => /多个有效译名/.test(region.error))));
console.log("PASS missed-image rescue, manual exclusion, low-confidence review, scoped translation reuse and visible conflicts");
