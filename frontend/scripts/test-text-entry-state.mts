import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/text-entry-state.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { IndexedTextEntries } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const original = Array.from({ length: 10000 }, (_, i) => ({
  id: String(i), src: `source ${i}`, dst: "", status: "pending",
}));
const state = new IndexedTextEntries(original);
let visits = 0;
state.update(["17", "9000", "missing"], (entry) => {
  visits++;
  return { ...entry, status: "running" };
});
assert.equal(visits, 2, "only requested entries are visited");
assert.equal(original[17].status, "pending", "input remains immutable");
const first = state.snapshot();
assert.equal(first[17].status, "running");
assert.equal(first[18], original[18], "untouched entry references are retained");
state.update(["17"], (entry) => ({ ...entry, dst: "translated", status: "done" }));
const second = state.snapshot();
assert.equal(first[17].status, "running", "published snapshots are not mutated");
assert.equal(second[17].dst, "translated");
assert.equal(second[9000].status, "running");
assert.equal(second.length, original.length);
console.log("text entry state: indexed updates and immutable snapshots passed");
