import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";

const source = readFileSync(new URL("../src/ocr/paddleOcr.ts", import.meta.url), "utf8");
const method = source.slice(source.indexOf("  async recognize("), source.indexOf("  dispose():"));
const { outputText } = transpileModule(`const holder = { ${method} }; return holder.recognize;`, {
  compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
});
let preparedCount = 0;
const image = new Blob(["fixture"]);
const enlarged = new Blob(["enlarged"]);
let predicted: Blob | undefined;
const runner = {
  predict: async (input: Blob) => {
    predicted = input;
    return [{ items: [], image: { width: 120, height: 160 }, metrics: { totalMs: 1 } }];
  },
  getInitializationSummary: () => null,
};
const recognize = new Function("prepareRecognitionImage", "itemToLine", outputText)(
  async () => { preparedCount++; return { image: enlarged, scale: 2 }; },
  () => null,
);
for (const mode of ["manga", "fast", "precise", "english"]) {
  const stages: string[] = [];
  const result = await recognize.call({ mode, runtime: {
    run: (work: Function) => work(runner, new AbortController().signal),
  } }, image, (stage: string) => stages.push(stage));
  assert.equal(predicted, mode === "manga" ? image : enlarged);
  assert.equal(result.image.width, mode === "manga" ? 120 : 60);
  assert.equal(stages.length, 2);
  assert.match(stages[1], mode === "manga" ? /前置 OCR/ : /检测并识别/);
}
assert.equal(preparedCount, 3, "Only non-manga modes retain upscaling");
console.log("OCR stage and manga source-resolution regression passed");
