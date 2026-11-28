import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const files = await Promise.all(["components/GameMosaicWorkbench.tsx", "gameMosaicRefine.ts"].map(async name =>
  ts.createSourceFile(name, await readFile(new URL("../src/" + name, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true)));
function find(source, predicate) {
  let match;
  function visit(node) { if (predicate(node)) match = node; else ts.forEachChild(node, visit); }
  visit(source);
  assert.ok(match, "Missing production declaration");
  return match;
}
const declaration = (source, name) => find(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
const functionDeclaration = (source, name) => find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === name);
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const storage = new Map();
const localStorage = { get length() { return storage.size; }, key: index => [...storage.keys()][index] ?? null,
  getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
const checkpointSource = ["checkpointPath", "regionCheckpointPrefix"].map(name =>
  "const " + name + " = " + declaration(files[1], name).initializer.getText(files[1]) + ";").join("\n");
const clearSource = functionDeclaration(files[1], "clearMosaicReviews").getText(files[1]).replace(/^export\s+/, "");
const clearCache = new Function("localStorage", compile(checkpointSource + "\n" + clearSource + "\nreturn clearMosaicReviews;"))(localStorage);
const clearProgressSource = declaration(files[0], "clearReviews").initializer.getText(files[0]);
const restartCall = find(files[0], node => ts.isCallExpression(node) && node.expression.getText(files[0]) === "runMosaicRefine");
const restartClear = restartCall.arguments.at(-1).properties.find(node => node.name?.getText(files[0]) === "clearReviews");

for (const ids of [undefined, ["one"]]) {
  const root = "test-project", checkpoint = "llmchat-game-mosaic-refine:" + root;
  storage.clear();
  storage.set(checkpoint, JSON.stringify({ key: "policy", images: { one: { source: "one" }, two: { source: "two" } },
    proposals: { one: { source: "one" }, two: { source: "two" } } }));
  for (const id of ["one", "two"]) storage.set(checkpoint + ":regions:" + id, "partial");
  storage.set("llmchat-game-mosaic-refine:other-project", "untouched");
  const screen = { state: "done", completed: 663, total: 663 };
  const redraw = { state: "pending", completed: 0, total: 663 };
  let stepRuns = { screen, redraw, refine: { state: "stopped", completed: 0, prepared: 413, total: 663, elapsed: 12000 } };
  const lastReview = { current: { key: "old-session", images: new Map([["one", "one"]]) } };
  const clear = new Function("clearMosaicReviews", "gamePath", "lastReview", "setStepRuns",
    compile("return (" + clearProgressSource + ");"))(clearCache, root, lastReview, change => { stepRuns = change(stepRuns); });
  clear(ids);
  assert.equal(stepRuns.refine, undefined, "clearing candidate caches also invalidates the old prepared counter and run status");
  assert.equal(lastReview.current, null, "the cleared review session cannot restore stale status");
  assert.equal(stepRuns.screen, screen, "initial screening progress remains intact");
  assert.equal(stepRuns.redraw, redraw, "review-cache invalidation does not clear redraw progress");
  if (ids) {
    const saved = JSON.parse(storage.get(checkpoint));
    assert.deepEqual(Object.keys(saved.images), ["two"]);
    assert.deepEqual(Object.keys(saved.proposals), ["two"]);
    assert.equal(storage.get(checkpoint + ":regions:one"), undefined);
    assert.equal(storage.get(checkpoint + ":regions:two"), "partial");
  } else {
    assert.equal(storage.has(checkpoint), false);
    assert.equal(storage.has(checkpoint + ":regions:one"), false);
    assert.equal(storage.has(checkpoint + ":regions:two"), false);
  }
  assert.equal(storage.get("llmchat-game-mosaic-refine:other-project"), "untouched");
  storage.set(checkpoint, JSON.stringify({ key: "policy", images: { one: { source: "one" } } }));
  const running = { state: "running", completed: 0, total: 663 };
  stepRuns = { screen, redraw, refine: running };
  const newSession = { key: "new-session", images: new Map() };
  lastReview.current = newSession;
  const clearOnRestart = new Function("clearMosaicReviews", "gamePath", "clearReviews",
    compile("return (" + (restartClear.initializer?.getText(files[0]) ?? "clearReviews") + ");"))(clearCache, root, clear);
  clearOnRestart(["one"]);
  assert.deepEqual(Object.keys(JSON.parse(storage.get(checkpoint)).images), []);
  assert.equal(stepRuns.refine, running, "restarting drops old caches without removing the newly started run");
  assert.equal(lastReview.current, newSession, "restarting preserves the new review session");
}
console.log("Mosaic review cleanup passed: prepared counter/session reset, full/scoped caches cleared, other steps preserved.");
