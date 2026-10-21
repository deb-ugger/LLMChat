import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import ts from "typescript";
import { Window } from "@tauri-apps/api/window";

const source = readFileSync(new URL("../src/components/TextTranslateView.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("TextTranslateView.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let closeCallback: ts.Node | undefined;
let persistCallback: ts.Node | undefined;
let stopCallback: ts.Node | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" &&
      node.arguments[0]?.getText(ast).includes("win.onCloseRequested")) closeCallback = node.arguments[0];
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
    if (node.name.text === "persistFullSnapshot") persistCallback = node.initializer.arguments[0];
    if (node.name.text === "stop") stopCallback = node.initializer.arguments[0];
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(closeCallback && persistCallback && stopCallback);
function load(node: ts.Node, env: Record<string, unknown>) {
  const js = ts.transpileModule(`const callback = ${node.getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), js + "\nreturn callback;")(...Object.values(env));
}
const friendly = (error: unknown) => error instanceof Error ? error.message : String(error);
const tick = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };
function setup({ hasProject = true, native = true, busy = false, confirmed = true, save, destroyError }: {
  hasProject?: boolean; native?: boolean; busy?: boolean; confirmed?: boolean;
  save?: () => Promise<void>; destroyError?: Error;
} = {}) {
  const calls: string[] = [], errors: string[] = [], dialogs: string[] = [];
  const browserListeners = new Map<string, any>();
  const closingRef = { current: false }, busyRef = { current: busy };
  let listener: ((event: any) => Promise<void>) | null = null;
  const destroy = async () => { calls.push("destroy"); if (destroyError) throw destroyError; };
  const win = {
    destroy,
    onCloseRequested(handler: any) {
      calls.push("register");
      // Exercise the real SDK wrapper, including its automatic destroy behavior.
      return Window.prototype.onCloseRequested.call({
        listen: async (_type: string, callback: any) => {
          listener = callback;
          return () => { calls.push("unlisten"); listener = null; };
        }, destroy,
      } as any, handler);
    },
  };
  const env = {
    hasProjectToClose: hasProject, isTauri: () => native, getCurrentWindow: () => win,
    busyRef, closingRef,
    persistFullSnapshotRef: { current: async (opts: any) => { assert.equal(opts?.requireSave, true); calls.push("save"); await save?.(); } },
    stopRef: { current: async (opts: any) => { assert.equal(opts.requireSave, true); calls.push("stop"); await save?.(); } },
    confirmDialog: async () => { calls.push("confirm"); return confirmed; },
    messageDialog: async (detail: string) => { dialogs.push(detail); },
    toFriendlyError: friendly, setError: (detail: string) => errors.push(detail), setStatusLine() {},
    window: {
      addEventListener: (name: string, callback: any) => browserListeners.set(name, callback),
      removeEventListener: (name: string) => browserListeners.delete(name),
    },
  };
  const cleanup = load(closeCallback!, env)();
  return {
    calls, errors, dialogs, closingRef, browserListeners, cleanup,
    fire: async () => { assert.ok(listener); await listener({ event: "tauri://close-requested", id: 1, payload: null }); },
    hasListener: () => !!listener,
  };
}

{
  const h = setup({ hasProject: false }); await tick();
  assert.equal(h.hasListener(), false, "home page leaves native window close untouched");
  assert.deepEqual(h.calls, []);
}
{
  const h = setup(); await tick(); await h.fire();
  assert.deepEqual(h.calls, ["register", "save", "destroy"]);
  assert.equal(h.closingRef.current, false);
  h.cleanup(); assert.equal(h.hasListener(), false);
}
{
  const h = setup({ busy: true, confirmed: false }); await tick(); await h.fire(); await h.fire();
  assert.deepEqual(h.calls, ["register", "confirm", "confirm"], "cancel keeps the app and translation running, with close retryable");
  assert.equal(h.closingRef.current, false); h.cleanup();
}
{
  const h = setup({ busy: true }); await tick(); await h.fire();
  assert.deepEqual(h.calls, ["register", "confirm", "stop", "destroy"]); h.cleanup();
}
{
  let release!: () => void;
  const saving = new Promise<void>(resolve => { release = resolve; });
  const h = setup({ save: () => saving }); await tick();
  const first = h.fire(); await tick(); await h.fire();
  assert.deepEqual(h.calls, ["register", "save"], "repeated close does not bypass a pending save");
  release(); await first;
  assert.equal(h.calls.filter(c => c === "destroy").length, 1); h.cleanup();
}
for (const busy of [false, true]) {
  const h = setup({ busy, save: async () => { throw new Error("disk full"); } }); await tick(); await h.fire();
  assert.ok(!h.calls.includes("destroy"), "a failed save must never close the window");
  assert.match(h.dialogs[0], /disk full/);
  assert.equal(h.closingRef.current, false); h.cleanup();
}
{
  const h = setup({ destroyError: new Error("destroy denied") }); await tick(); await h.fire();
  assert.equal(h.calls.filter(c => c === "destroy").length, 1, "failed destroy is reported, not silently retried");
  assert.match(h.dialogs[0], /destroy denied/);
  assert.equal(h.closingRef.current, false); h.cleanup();
}
{
  let release!: () => void;
  const h = setup({ save: () => new Promise<void>(resolve => { release = resolve; }) }); await tick();
  const pending = h.fire(); await tick(); h.cleanup(); release(); await pending;
  assert.ok(!h.calls.includes("destroy"), "a disposed workbench cannot close a newer view");
}
{
  const h = setup({ native: false, busy: true });
  assert.equal(h.hasListener(), false);
  let prevented = false;
  h.browserListeners.get("beforeunload")({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); h.cleanup(); assert.equal(h.browserListeners.size, 0);
}
{
  const project = { entries: [{ status: "running" }], model: "test", elapsedMs: 0 };
  const errors: string[] = [];
  const persist = load(persistCallback!, {
    projectRef: { current: project }, computeElapsedNow: () => 123,
    promptDraftRef: { current: "prompt" }, textLlm: { model: "test" }, projectFolderRef: { current: "fixture" },
    setProject() {}, setElapsedMs() {}, setProjectFolder() {}, setProjectFolderPath() {},
    api: { saveTextProject: async () => { throw new Error("save failed"); } },
    serializeProject: JSON.stringify, toFriendlyError: friendly, setError: (detail: string) => errors.push(detail),
  });
  await assert.rejects(persist({ requireSave: true }), /save failed/, "close must receive the real persistence failure");
  assert.ok(await persist(), "ordinary autosave keeps its existing behavior");
  assert.equal(errors.length, 1);
  let saveOptions: any;
  const stop = load(stopCallback!, {
    flushProgressRef: { current: null }, abortRef: { current: new AbortController() }, genRef: { current: 0 },
    setBusy() {}, busyRef: { current: true }, pipelineActiveRef: { current: false }, setPipeline() {},
    persistFullSnapshot: async (opts: any) => { saveOptions = opts; throw new Error("save failed"); },
    runStartedAtRef: { current: null }, setStatusLine() {},
  });
  await assert.rejects(stop({ silent: true, requireSave: true }), /save failed/);
  assert.equal(saveOptions.requireSave, true); assert.equal(saveOptions.resetRunning, true);
}
console.log("PASS: native home close, save-before-close, translation confirmation/cancel, repeated clicks, save/destroy errors, disposal and browser unload.");

// Optional staging for a real native-window smoke test, without user data/profile.
if (process.argv.includes("--stage-native")) {
  const root = mkdtempSync(join(tmpdir(), "llmchat-close-test-"));
  const frontend = resolve(import.meta.dirname, "..");
  const paths = Object.fromEntries(["data", "projects", "ocr", "unity", "temp", "webview"].map(key => [key, join(root, key)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  copyFileSync(join(frontend, "src-tauri/target/release/llmchat.exe"), join(root, "llmchat.exe"));
  copyFileSync(join(frontend, "src-tauri/binaries/llmchat-backend-x86_64-pc-windows-msvc.exe"), join(root, "llmchat-backend.exe"));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  writeFileSync(join(paths.data, "config.ini"), `[General]\nport=${port}\n`, "utf8");
  writeFileSync(join(root, "storage-paths.json"), JSON.stringify({ active: paths }), "utf8");
  console.log(JSON.stringify({ nativeTestExe: join(root, "llmchat.exe"), backendPort: port }));
}
