import assert from "node:assert/strict";
import { build, transform } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const storage = new Map();
let writes = 0;
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => { writes++; storage.set(key, String(value)); },
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { hostname: "localhost" } };
const bundle = await build({
  stdin: { contents: "export * as terms from './gameTermMemory'; export * as project from './gameTextProject'; export {batchFailureType} from './components/GameBatchResults';", resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "ts" },
  bundle: true, write: false, platform: "browser", format: "esm", external: ["fs", "path"], define: { "import.meta.env.VITE_API_BASE": '""' },
});
const { terms, project, batchFailureType } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

const partial = {
  id: "769", source: "\\P[1]は盃に『\\V[342]』を注いだ", translation: "\\P[1]は盃に『\\V[342]把』倒了进去", error: "", selected: true,
};
partial.importPartial = { translation: partial.translation, unmatched: ["は盃に"] };
const workspace = await readFile(new URL("../src/components/GameTextWorkspace.tsx", import.meta.url), "utf8");
const begin = workspace.indexOf("const failureReasons = useMemo"), end = workspace.indexOf("const stats = useMemo", begin);
assert.ok(begin >= 0 && end > begin);
const callback = (await transform(workspace.slice(begin, end), { loader: "ts", target: "es2022" })).code;
const review = new Function("useMemo", "entries", "importIssues", "gameTextProblem", "gameTextImportPartial", "validateGameText", "messageCore", callback + ";return failureReasons;");
const failures = review(fn => fn(), [partial], [], project.createGameTextValidator(false, "zh-CN"), project.gameTextImportPartial, project.gameTextProblem, false);
assert.match(failures.get("769"), /仍含日文/);
assert.equal(batchFailureType(failures.get("769")), "译文残留原文");
assert.ok(project.gameTextImportPartial(partial));
assert.equal(project.gameTextDictionary([partial])[partial.source], partial.translation, "partial output remains writable despite a visible residue warning");

const names = ["アリス", "炎の剣", "氷の盾"];
const canonical = new Map([[names[0], "爱丽丝"], [names[1], "炎之剑"], [names[2], "冰之盾"]]);
const row = { id: "dialogue", source: "\\nc<アリス>炎の剣と氷の盾を使う", translation: "", error: "", selected: true };
const references = [
  ...names.map((source, index) => ({ id: "term" + index, source, translation: "", error: "", selected: true, rpgTextKind: index ? "item" : "character" })), row,
];
const scope = "E:/games/terms-resume";
const aborted = new AbortController();
const firstCalls = [];
await assert.rejects(terms.prepareGameTerms([row], references, "zh-CN", [], async name => {
  firstCalls.push(name);
  if (name === names[0]) return canonical.get(name);
  return new Promise((_, reject) => aborted.signal.addEventListener("abort", () => reject(aborted.signal.reason), { once: true }));
}, aborted.signal, detail => { if (detail.startsWith("术语已确定：" + names[0])) aborted.abort(); }, scope), error => error.name === "AbortError");
assert.equal(firstCalls.length, 3);
assert.ok([...storage.values()].some(raw => JSON.parse(raw)[names[0]] === canonical.get(names[0])), "successful term is saved before aborting the stage");

const resumedCalls = [];
const resumed = await terms.prepareGameTerms([row], structuredClone(references), "zh-CN", [], async name => { resumedCalls.push(name); return canonical.get(name); }, new AbortController().signal, undefined, "e:\\games\\terms-resume\\");
assert.deepEqual(new Set(resumedCalls), new Set(names.slice(1)));
assert.equal(resumed.terms.get(names[0]), canonical.get(names[0]));
assert.equal(resumed.issues.size, 0);
const savedWrites = writes;
let reopenedCalls = 0;
await terms.prepareGameTerms([row], structuredClone(references), "zh-CN", [], async () => { reopenedCalls++; throw new Error("must reuse saved term"); }, new AbortController().signal, undefined, scope);
assert.equal(reopenedCalls, 0);
assert.equal(writes, savedWrites, "unchanged cached terms do not rewrite storage");

let otherGameCalls = 0;
await terms.prepareGameTerms([row], references, "zh-CN", [], async name => { otherGameCalls++; return canonical.get(name); }, new AbortController().signal, undefined, "E:/games/another-game");
assert.equal(otherGameCalls, 3);
let otherTargetCalls = 0;
await terms.prepareGameTerms([row], references, "en", [], async name => { otherTargetCalls++; return new Map([[names[0], "Alice"], [names[1], "Fire Sword"], [names[2], "Ice Shield"]]).get(name); }, new AbortController().signal, undefined, scope);
assert.equal(otherTargetCalls, 3);

const custom = await terms.prepareGameTerms([row], references, "zh-CN", [{ src: names[0], dst: "指定译名" }], async () => { throw new Error("glossary and cache should suffice"); }, new AbortController().signal, undefined, scope);
assert.equal(custom.terms.get(names[0]), "指定译名");
const edited = structuredClone(references); edited[1].translation = "手工确认译名"; edited[1].translationTarget = "zh-CN";
const existing = await terms.prepareGameTerms([row], edited, "zh-CN", [], async () => { throw new Error("existing translation should suffice"); }, new AbortController().signal, undefined, scope);
assert.equal(existing.terms.get(names[1]), "手工确认译名");

const failedScope = "E:/games/failed-term";
const invalid = await terms.prepareGameTerms([row], references, "zh-CN", [], async name => name === names[1] ? "未翻訳のまま" : canonical.get(name), new AbortController().signal, undefined, failedScope);
assert.ok(invalid.issues.has(names[1]));
const retryCalls = [];
await terms.prepareGameTerms([row], references, "zh-CN", [], async name => { retryCalls.push(name); return canonical.get(name); }, new AbortController().signal, undefined, failedScope);
assert.deepEqual(retryCalls, [names[1]], "only failed terms are requested again");
const badFormat = await terms.prepareGameTerms([row], references, "zh-CN", [], async name => name === names[1] ? "『炎之剑" : canonical.get(name), new AbortController().signal, undefined, "E:/games/bad-format-term");
assert.ok(badFormat.issues.has(names[1]));

let uncachedCalls = 0;
for (let run = 0; run < 2; run++) await terms.prepareGameTerms([row], references, "zh-CN", [], async name => { uncachedCalls++; return canonical.get(name); }, new AbortController().signal);
assert.equal(uncachedCalls, 6, "benchmark callers without a project scope keep independent model runs");
const originalSet = localStorage.setItem;
localStorage.setItem = () => { throw new Error("quota exceeded"); };
await assert.rejects(terms.prepareGameTerms([row], references, "zh-CN", [], async name => canonical.get(name), new AbortController().signal, undefined, "E:/games/cannot-save"), /保存工程术语缓存失败/);
localStorage.setItem = originalSet;
console.log("PASS partial Japanese residue classification, writable partial output, term abort/resume, reopen reuse, game/target isolation, glossary priority, manual references, failed-only retries and visible persistence errors");
