import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import Zip from "jszip";

globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { hostname: "localhost" } };
const bundle = await build({
  stdin: { contents: "export * as screening from './gameImageScreening'; export * as semantic from './gameImageSemanticReview'; export * as samples from './benchmark/imageSampleSet'; export {renderGameImage} from './gameImageModel'; export {countMosaicResults} from './benchmark/mosaicScoreCounts'; export {scoreMosaicRun} from './benchmark/mosaicScore'; export {createMosaicTaskWorkbook} from './benchmark/benchmarkMosaicReport'; export {mosaicStatusLabels as categories} from './gameMosaicStatus'; export { processUnityImages } from './unityImages';",
    resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts" },
  bundle: true, write: false, platform: "browser", format: "esm", external: ["fs", "path"],
  define: { "import.meta.env.VITE_API_BASE": '""', "import.meta.env.DEV": "false" },
});
const { screening, semantic, samples, renderGameImage, countMosaicResults, scoreMosaicRun, createMosaicTaskWorkbook, categories, processUnityImages } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));
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
async function translate(images, extra = {}, mode = "translate-only") {
  let calls = 0;
  const outcomes = [];
  const result = processUnityImages({ entries: [], images }, signal, {
    targetLanguage: "zh-CN", concurrency: 2, translationConcurrency: 2, regionConcurrency: 2,
    read: async () => new Blob(), recognize: async () => [], translate: async () => { calls++; return "打开"; },
    render: async () => new Blob(), write: async () => ({ path: "", hash: "" }),
    persist: async (_, value) => outcomes.push(structuredClone(value)), validate: () => "", ...extra,
  }, () => {}, 50, mode);
  return { result: await result.catch(error => error), calls, outcomes };
}
assert.equal((await translate([image("menu", "a"), image("dialogue", "b")])).calls, 2,
  "different original images cannot share short-text translations");
assert.equal((await translate([image("copy-a", "same"), image("copy-b", "same")])).calls, 2,
  "identical pixels under different resource paths can have different meanings");
const sameResource = (id, translation = "") => ({ ...image(id, "same", translation), file: "menu.png", name: "menu.png" });
assert.equal((await translate([sameResource("copy-a"), sameResource("copy-b")])).calls, 1,
  "the same resource still shares a pending translation");
const conflict = await translate([sameResource("first", "打开"), sameResource("second", "开门"), sameResource("pending")]);
assert.ok(conflict.result instanceof Error);
assert.ok(conflict.outcomes.some(row => row.regions.some(region => /多个有效译名/.test(region.error))));

const semanticInput = image("attack", "attack");
semanticInput.regions[0].text = "攻撃力が上がる";
const firstPass = await translate([semanticInput], { reviewModel: "reviewer", translate: async () => "防御力下降", onTranslationFailures() {} });
assert.ok(!(firstPass.result instanceof Error));
assert.equal(firstPass.result.images[0].regions[0].translation, "防御力下降");
assert.match(firstPass.result.images[0].regions[0].error, /待语义复核/);
let rendered = 0;
const blockedRender = await translate(firstPass.result.images, { render: async () => { rendered++; return new Blob(); } }, "render");
assert.ok(blockedRender.result instanceof Error);
assert.equal(rendered, 0, "batch layout cannot clear pending-review warnings and render the draft");
await assert.rejects(renderGameImage({}, "", new Blob(), firstPass.result.images[0].regions, signal, undefined, { target: "zh-CN" }));
let reviewCalls = 0;
const secondPass = await translate(firstPass.result.images, { reviewModel: "reviewer", review: async (_, region) => {
  reviewCalls++; assert.equal(region.translation, "防御力下降"); return "攻击力提高";
} });
assert.equal(secondPass.calls, 0, "semantic review receives the existing draft before any retranslation");
assert.equal(reviewCalls, 1);
const accepted = secondPass.result.images[0].regions[0];
assert.equal(accepted.translation, "攻击力提高");
assert.equal(accepted.beforeReview.translation, "防御力下降");
assert.equal(semantic.needsImageSemanticReview(accepted, "reviewer", "zh-CN"), false);
assert.equal(semantic.needsImageSemanticReview({ ...accepted, text: "防御力が下がる" }, "reviewer", "zh-CN"), true);
assert.equal(semantic.needsImageSemanticReview(accepted, "another-model", "zh-CN"), true);
assert.equal(semantic.needsImageSemanticReview(accepted, "reviewer", "zh-CN", "new-prompt"), true);
assert.equal(semantic.needsImageSemanticReview({ ...accepted, text: "GUARD" }, "reviewer", "zh-CN"), true);
const resumed = await translate(secondPass.result.images, { reviewModel: "reviewer", review: async () => { throw new Error("already reviewed"); } });
assert.ok(!(resumed.result instanceof Error));
assert.equal(semantic.parseImageSemanticReview({ verdict: "accept" }, "攻击力提高"), "攻击力提高");
assert.equal(semantic.parseImageSemanticReview({ verdict: "correct", translation: "攻击力提高" }, "防御力下降"), "攻击力提高");
assert.throws(() => semantic.parseImageSemanticReview({ verdict: "uncertain", reason: "文字不清晰" }, "候选译文"), /待确认/);

const annotation = { text: { state: "present", regions: [{ box: [0, 0, 80, 20], text: "攻撃力が上がる", language: "ja", translations: { "zh-CN": "攻击力提高" } }] } };
const recognized = { ...semanticInput.regions[0], text: "攻撃力が下がる", translation: "防御力下降", error: "" };
assert.match(samples.textBoxScore([[annotation, []]], "ja", "zh-CN", false), /漏文字框 1.*字符错误率 100.0%/);
assert.match(samples.textBoxScore([[{ text: { state: "none", regions: [] } }, [recognized]]], "ja", "zh-CN", false), /多余文字框 1/);
assert.match(samples.imageTranslationScore([[annotation, [recognized]]], "ja", "zh-CN", false), /参考译文一致 0\/1/);
assert.match(samples.imageTranslationScore([[annotation, [{ ...recognized, translation: "攻击力提高" }]]], "ja", "zh-CN", false), /参考译文一致 1\/1.*缺失或失败 0/);
assert.match(samples.imageTranslationScore([[annotation, []]], "ja", "zh-CN", false), /缺失或失败 1/);
const box = [0, 0, 20, 20], second = [40, 0, 60, 20];
const inputs = [box, box, box].map((_, index) => ({ id: String(index), sourceHash: String(index), width: 100, height: 100,
  mosaicTruth: { state: "present", boxCoverage: "complete", boxes: index === 0 ? [box, second] : [box] } }));
const counts = countMosaicResults(inputs, {
  0: { category: categories.refinedCandidate, status: "完成", checked: true, boxes: [box] },
  1: { category: categories.refinedCandidate, status: "完成", checked: true, boxes: [box] },
});
assert.equal(counts.fullyCoveredPositiveImages, 1);
assert.equal(counts.completePositiveImages, 3, "missing results remain in the complete-annotation denominator");
const reportRow = { ...counts, runId: "fixture", label: "fixture", round: 1, seconds: 2, elapsedMs: 2000,
  status: "完成", runFailures: 0, issues: [], freeze: { version: 1, inputs: "i", truth: "t" }, timing: "whole-wall-v1" };
reportRow.score = scoreMosaicRun("mosaicRefine", reportRow);
const workbook = await createMosaicTaskWorkbook({ title: "fixture", stage: "mosaicRefine", totals: [reportRow] });
const zip = await Zip.loadAsync(await workbook.arrayBuffer());
const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
assert.match(sheet, /人工框全覆盖图片比例/);
assert.match(sheet, /33\.33/);
console.log("PASS negative rescue, scoped reuse, semantic review/resume, OCR and reference scoring, full-box delivery coverage and Excel export");
