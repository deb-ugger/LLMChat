import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { File } from "node:buffer";
import { createHash } from "node:crypto";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";

const compile = (source: string) => transpileModule(source, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText;
async function loadHelper(name: string) {
  const source = readFileSync(new URL(`../src/ocr/${name}.ts`, import.meta.url), "utf8");
  return import("data:text/javascript;base64," + Buffer.from(compile(source)).toString("base64"));
}
const { TaskScope, throwIfAborted, isAbortError } = await loadHelper("taskScope");
const { planPdfOcrTiles, tileOwnsLine } = await loadHelper("pdfOcrLayout");

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// Use the production callbacks with injected browser/API mocks: no model or network.
function callback(file: string, name: string, nextName: string, bindings: Record<string, unknown>) {
  const source = readFileSync(new URL(`../src/components/${file}.tsx`, import.meta.url), "utf8");
  const start = source.indexOf(`  const ${name} = useCallback(`);
  const end = source.indexOf(`  const ${nextName} =`, start);
  assert.ok(start >= 0 && end > start, `Cannot locate ${name}`);
  const body = compile(source.slice(start, end));
  const context = { useCallback: (fn: unknown) => fn, ...bindings };
  return new Function(...Object.keys(context), `${body}\nreturn ${name};`)(...Object.values(context));
}

// Replacing one page does not cancel another; stale completion cannot remove its successor.
{
  const scope = new TaskScope();
  const first = scope.start("one"), other = scope.start("two");
  const replacement = scope.start("one");
  assert.equal(first.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
  scope.finish("one", first);
  scope.cancel("two");
  assert.equal(scope.active, true);
  scope.cancelAll();
  assert.equal(replacement.signal.aborted, true);
  assert.equal(scope.active, false);
  assert.throws(() => throwIfAborted(first.signal), { name: "AbortError" });
}

// Raster budgets, exact core coverage, and unique overlap ownership across sizes.
for (const [width, height] of [[1, 1], [1980, 2800], [5960, 8425], [14000, 900], [900, 14000], [3201, 1876]]) {
  const tiles = planPdfOcrTiles(width, height);
  let covered = 0;
  for (const tile of tiles) {
    assert.ok(tile.width <= 3200 && tile.height <= 3200);
    assert.ok(tile.width * tile.height <= 6_000_000);
    assert.ok(tile.x >= 0 && tile.y >= 0);
    assert.ok(tile.x + tile.width <= width && tile.y + tile.height <= height);
    covered += (tile.coreX1 - tile.coreX0) * (tile.coreY1 - tile.coreY0);
    for (const [x, y] of [[tile.coreX0, tile.coreY0], [(tile.coreX0 + tile.coreX1) / 2, (tile.coreY0 + tile.coreY1) / 2]]) {
      const owners = tiles.filter((candidate: any) => tileOwnsLine(candidate, {
        x0: x - candidate.x - 0.1, x1: x - candidate.x + 0.1,
        y0: y - candidate.y - 0.1, y1: y - candidate.y + 0.1,
      }));
      assert.equal(owners.length, 1);
    }
  }
  assert.equal(covered, width * height);
}

const blocks = [{ id: "p-b1", pageId: "p", text: "hello world", translation: "", status: "idle" }];
function imageTranslationHarness(provider: string) {
  const scope = new TaskScope();
  const requests: { signal: AbortSignal; resolve: (value: { translation: string }) => void; reject: (error: Error) => void }[] = [];
  const patches: unknown[] = [];
  const translate = callback("ImageOcrView", "translateBlocks", "runOcrForPage", {
    translationTasksRef: { current: scope }, pagesRef: { current: [{ id: "p" }] },
    patchPage: (...args: unknown[]) => patches.push(args),
    isLiteralOcrToken: () => false, translateOpts: {}, translateProvider: provider,
    throwIfAborted, isAbortError, toFriendlyError: (e: Error) => e.message,
    api: { translate: (_text: string, init: RequestInit) => new Promise((resolve, reject) => {
      const signal = init.signal!;
      assert.ok(signal instanceof AbortSignal);
      requests.push({ signal, resolve: resolve as (value: { translation: string }) => void, reject });
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }) },
  });
  return { scope, requests, patches, translate };
}

// Cancelling a batch must not fall back to individual translations or publish errors.
{
  const h = imageTranslationHarness("llm");
  const pending = h.translate("p", blocks);
  assert.equal(h.requests.length, 1);
  const writes = h.patches.length;
  h.scope.cancelAll();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.requests.length, 1);
  assert.equal(h.patches.length, writes);
}

// Replacing a request keeps the new task alive after the old finally block runs.
{
  const h = imageTranslationHarness("llm");
  const old = h.translate("p", blocks);
  const rejected = assert.rejects(old, { name: "AbortError" });
  const current = h.translate("p", blocks);
  await rejected;
  assert.equal(h.scope.active, true);
  assert.equal(h.requests[1].signal.aborted, false);
  h.requests[1].resolve({ translation: "你好" });
  assert.equal((await current)[0].translation, "你好");
  assert.equal(h.scope.active, false);
}

// Per-block requests share cancellation and stop before another concurrency batch.
{
  const h = imageTranslationHarness("bing");
  const pending = h.translate("p", Array.from({ length: 6 }, (_, i) => ({ ...blocks[0], id: `b${i}` })));
  assert.equal(h.requests.length, 2);
  const writes = h.patches.length;
  h.scope.cancel("p");
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.requests.length, 2);
  assert.equal(h.patches.length, writes);
}

// A server-side cancellation is not a batch-format failure: abort siblings, no retry.
for (const provider of ["llm", "bing"]) {
  const h = imageTranslationHarness(provider);
  const pending = h.translate("p", Array.from({ length: 4 }, (_, i) => ({ ...blocks[0], id: `b${i}` })));
  const count = h.requests.length;
  const reason = Object.assign(new Error("request cancelled"), { code: "CANCELLED" });
  h.requests[0].reject(reason);
  await assert.rejects(pending, (error: unknown) => isAbortError(error));
  assert.equal(h.requests.length, count);
  assert.ok(h.requests.every(({ signal }) => signal.aborted));
  assert.equal(h.scope.active, false);
  assert.deepEqual(h.patches.at(-1), ["p", { busy: false, statusText: null }]);
}

// PDF.js may transfer a read buffer: File and the original IPC bytes remain reusable.
{
  const original = new Uint8Array([37, 80, 68, 70]).buffer;
  const file = new File([original], "sample.pdf", { type: "application/pdf" });
  const read = await file.arrayBuffer();
  const hash = createHash("sha256").update(new Uint8Array(read)).digest("hex");
  const transferred = structuredClone(read, { transfer: [read] });
  assert.equal(read.byteLength, 0);
  assert.equal(original.byteLength, 4);
  assert.equal(file.size, 4);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array(transferred));
  assert.equal(createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex"), hash);
}

// Old document extraction must neither publish text nor clear a successor's busy flag.
{
  const started = deferred<void>(), native = deferred<unknown[]>();
  const selected: string[] = [], busy: boolean[] = [];
  const pdfRef = { current: { numPages: 2, getPage: async () => ({
    getViewport: () => ({ width: 595, height: 842 }),
  }) } };
  const extractionRef: { current: any } = { current: null };
  const cache = new Map();
  const extract = callback("PdfPane", "extractCurrentPage", "readPdfSelection", {
    pdfRef, extractionRef, pageNumberRef: { current: 1 },
    normalizeOcrMode: () => "fast", ocrMode: "fast", OCR_MODE_LABELS: { fast: "快速" },
    contentHashRef: { current: "old-pdf" }, fileMetaRef: { current: null }, file: null,
    pageTextCacheRef: { current: cache }, onTextSelected: (text: string) => selected.push(text),
    setPageOcrStatus: () => {}, setPageOcrBusy: (value: boolean) => busy.push(value),
    collectPageImageRects: async () => [],
    extractNativePdfLines: () => { started.resolve(); return native.promise; },
    nativeTextLooksUsable: () => true,
    buildStructuredPdfText: () => ({ text: "old text", keptLines: 1 }),
    throwIfAborted, isAbortError,
  });
  const pending = extract();
  await started.promise;
  extractionRef.current.controller.abort();
  const replacement = { controller: new AbortController(), renderTask: null };
  extractionRef.current = replacement;
  native.resolve([]);
  await pending;
  assert.deepEqual(selected, []);
  assert.equal(cache.size, 0);
  assert.equal(extractionRef.current, replacement);
  assert.deepEqual(busy, [true]);
}

console.log("OCR optimizations: task replacement/cancellation, bounded tiles, overlap ownership, stale PDF suppression passed");
