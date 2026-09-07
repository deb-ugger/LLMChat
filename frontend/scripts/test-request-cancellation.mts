import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const apiSource = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8")
  .replace('import { toFriendlyError } from "./friendlyError";', 'const toFriendlyError = (e: unknown) => String(e);')
  .replace("import.meta.env.VITE_API_BASE", "undefined");
const output = ts.transpileModule(apiSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { api } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
globalThis.window = globalThis as any;
let posts: { url: string; body: any }[] = [];
try {
  const response = () => new Response(JSON.stringify({ ok: true, translation: "test", totalTokens: 7 }));
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return response();
  };
  assert.equal((await api.translate("hello")).totalTokens, 7);
  assert.equal(posts.length, 1);
  assert.ok(posts[0].body.taskId);
  const already = new AbortController();
  already.abort();
  await assert.rejects(api.translate("ignored", { signal: already.signal }), { name: "AbortError" });
  assert.equal(posts.length, 1);

  posts = [];
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (String(url).endsWith("/cancel")) return response();
    return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
  };
  const controller = new AbortController();
  const pending = api.translate("pending", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(posts.length, 2, "cancel is sent exactly once");
  assert.equal(posts[0].body.taskId, posts[1].body.taskId);
  assert.ok(posts[1].url.endsWith("/cancel"));
} finally {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
}

// Execute the real hook with minimal hook/DOM adapters; no app or React renderer needed.
const hookSource = readFileSync(new URL("../src/hooks/usePersistedSize.ts", import.meta.url), "utf8")
  .replace(/^import .* from "react";\s*/m, "")
  .replace("export function", "function");
const hookJs = ts.transpileModule(hookSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const effects: (() => unknown)[] = [];
const changes: number[] = [];
const saved: string[] = [];
const listeners = new Map<string, Set<(event: any) => void>>();
const frames = new Map<number, () => void>();
let frameId = 0;
const classes = new Set<string>();
const windowMock = {
  addEventListener: (type: string, listener: any) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
  removeEventListener: (type: string, listener: any) => listeners.get(type)?.delete(listener),
};
const hook = new Function("useCallback", "useEffect", "useRef", "useState", "localStorage", "window", "document", "requestAnimationFrame", "cancelAnimationFrame", hookJs + "\nreturn usePersistedSize;")(
  (fn: any) => fn, (fn: any) => effects.push(fn), (value: any) => ({ current: value }),
  (init: any) => [init(), (value: number) => changes.push(value)],
  { getItem: () => null, setItem: (_: string, value: string) => saved.push(value) }, windowMock,
  { body: { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } } },
  (fn: () => void) => { frames.set(++frameId, fn); return frameId; }, (id: number) => frames.delete(id),
);
const result = hook("width", 100, 50, 500, "x");
const cleanups = effects.map((effect) => effect()).filter((value) => typeof value === "function") as (() => void)[];
const start = { preventDefault() {}, stopPropagation() {}, clientX: 0 };
const dispatch = (type: string, event = {}) => { for (const listener of [...listeners.get(type) ?? []]) listener(event); };
result.beginResize(start, 1);
for (let i = 1; i <= 100; ++i) dispatch("mousemove", { clientX: i });
assert.equal(frames.size, 1, "high-frequency moves coalesce into one frame");
assert.equal(saved.length, 1, "dragging does not write storage per move");
dispatch("blur");
assert.equal(changes.at(-1), 200);
assert.equal(saved.at(-1), "200");
assert.equal(frames.size, 0);
assert.equal(classes.size, 0);
assert.ok([...listeners.values()].every((set) => set.size === 0));
result.beginResize(start, 1);
const beforeUnmount = changes.length;
cleanups.forEach((cleanup) => cleanup());
assert.equal(changes.length, beforeUnmount, "unmount does not write React state");
assert.ok([...listeners.values()].every((set) => set.size === 0));
console.log("Request cancellation and resize lifecycle tests passed");
