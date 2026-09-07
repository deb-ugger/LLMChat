import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";

const source = readFileSync(new URL("../src/ocr/runtime.ts", import.meta.url), "utf8");
const { outputText } = transpileModule(source, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
});
const { OcrRuntime } = await import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));
function deferred() {
  let resolve!: (value?: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Closing during initialization must release the resulting resource once,
// without running work or making the engine usable again.
{
  const ready = deferred();
  let released = 0;
  const runtime = new OcrRuntime(() => ready.promise, async () => { released++; });
  const work = runtime.run(async () => { throw new Error("must not run"); });
  const rejected = assert.rejects(work, /识别已取消/);
  const closing = runtime.dispose();
  assert.equal(runtime.dispose(), closing);
  ready.resolve({});
  await Promise.all([closing, rejected]);
  assert.equal(released, 1);
  await assert.rejects(runtime.run(async () => "late"), /识别已取消/);
}

// Closing during inference signals cancellation and waits before releasing.
{
  const started = deferred(), finished = deferred();
  let released = false;
  const runtime = new OcrRuntime(async () => ({}), async () => { released = true; });
  const work = runtime.run(async (_: unknown, signal: AbortSignal) => {
    started.resolve();
    await finished.promise;
    assert.equal(signal.aborted, true);
    assert.equal(released, false);
    return "stale result";
  });
  await started.promise;
  const rejected = assert.rejects(work, /识别已取消/);
  const closing = runtime.dispose();
  finished.resolve();
  await Promise.all([closing, rejected]);
  assert.equal(released, true);
}

// Failed initialization can be retried; a failed resource is never released.
{
  let attempts = 0, released = 0;
  const runtime = new OcrRuntime(async () => {
    if (++attempts === 1) throw new Error("load failed");
    return 42;
  }, async () => { released++; });
  await assert.rejects(runtime.run(async (v: number) => v), /load failed/);
  assert.equal(await runtime.run(async (v: number) => v), 42);
  await runtime.dispose();
  assert.equal(released, 1);
}
console.log("OCR runtime: initialization, cancellation, cleanup and retry passed");
