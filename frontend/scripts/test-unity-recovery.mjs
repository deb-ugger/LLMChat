// Windows: node frontend/scripts/test-unity-recovery.mjs [--helper <exe>] [--browser <exe>] [--prove]
// Uses an isolated browser profile, a loopback translation fixture and the real Unity helper.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const repo = resolve(frontend, "..");
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--prove") options.prove = true;
  else if (["--helper", "--browser"].includes(arg) && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    options[arg.slice(2)] = resolve(process.argv[++i]);
  } else throw new Error("用法：node frontend/scripts/test-unity-recovery.mjs [--helper <exe>] [--browser <exe>] [--prove]");
}
const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8" });
const primary = common.status === 0 ? dirname(common.stdout.trim()) : repo;
const helper = options.helper ?? [repo, primary].map(root => join(root, "frontend/src-tauri/resources/unity/llmchat-unity.exe")).find(existsSync);
const browser = options.browser ?? [
  process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA,
].filter(Boolean).map(root => join(root, "Microsoft/Edge/Application/msedge.exe")).find(existsSync);
assert.ok(helper && existsSync(helper), "需要已准备好的 Unity helper（--helper 指定 llmchat-unity.exe）");
assert.ok(browser && existsSync(browser), "需要 Edge 或 Chromium（--browser 指定浏览器可执行文件）");
assert.equal(typeof WebSocket, "function", "需要 Node.js 22 或更新版本");

const tsc = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-b", "--noEmit"], { cwd: frontend, stdio: "inherit" });
assert.equal(tsc.status, 0, "tsc -b --noEmit");
const output = join(repo, "tmp", "test-t085");
await mkdir(output, { recursive: true });
const runDir = await mkdtemp(join(output, "run-"));
console.log("回归产物", runDir);
const profile = join(runDir, "browser");
const settings = { apiUrl: "", apiKey: "", model: "", translateProvider: "bing", translateSource: "ja", translateTarget: "zh-CN", translateEngineKeys: "{}", messagePageSize: 30 };
const projects = new Map();
const inFlight = new Set();
const allowed = new Set(["workspace", "inspect", "load", "save-task", "mosaic-status", "save-text-states", "save"]);
const mutationAnchor = 'else if (controller.signal.aborted || options.signal.aborted) change(part, "stopped");';
let mutated = false;
let edge;
let server;
let activePage;
let port;

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const sample = (project, index) => "T085" + project + "-" + String(index).padStart(3, "0");
const sourceText = (project, index) => "これは検証用の文章です。" + sample(project, index);
const translated = (project, index) => "这是一段用于验证的中文译文。" + sample(project, index);
const flatPath = path => resolve(path).toLowerCase();

async function waitFor(label, read, expected, timeout = 20000) {
  const end = Date.now() + timeout;
  let actual;
  do {
    actual = await read();
    if (expected(actual)) return actual;
    await delay(75);
  } while (Date.now() < end);
  assert.fail(label + " 超时，实际值 " + JSON.stringify(actual)?.slice(0, 1600));
}

function runHelper(action, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [action, String(process.pid), "--progress"], {
      cwd: runDir, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [], stderr = [];
    inFlight.add(child);
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Unity helper 操作超时 " + action));
    }, 15000);
    child.stdout.on("data", bytes => stdout.push(bytes));
    child.stderr.on("data", bytes => stderr.push(bytes));
    child.stdin.on("error", reject);
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timeout);
      inFlight.delete(child);
      const lines = Buffer.concat(stderr).toString("utf8").split(/\r?\n/).filter(Boolean);
      try {
        const progress = lines.filter(line => line.startsWith("LLMCHAT_PROGRESS ")).map(line => JSON.parse(line.slice(17)));
        if (code !== 0) throw new Error("Unity helper " + action + " (" + code + ") " + lines.filter(line => !line.startsWith("LLMCHAT_PROGRESS ")).join("\n"));
        resolve({ result: JSON.parse(Buffer.concat(stdout).toString("utf8")), progress });
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function seed(name, total) {
  const root = join(runDir, name);
  await mkdir(root);
  const work = join(root, "LLMChat-Unity");
  await runHelper("translation-directory", { root });
  const folder = join(work, "projects", "unity-project-" + name);
  await mkdir(folder);
  const entries = Array.from({ length: total }, (_, i) => ({
    id: String(i + 1), file: "fixture.assets", container: "fixture", objectId: String(i + 1),
    locator: "/m_Text", kind: "游戏文本", locale: "ja", source: sourceText(name, i + 1), selected: true,
  }));
  const project = { version: 1, scanRevision: 12, textMode: "lines", root, folder, entries, imagesSkipped: true };
  const task = {
    step: 2, endStep: 2, automatic: false, finished: false, projectFolder: folder, scanFolder: "", patchFolder: "",
    scopeVersion: 1, translationKind: "engine", engine: "bing", engines: [{ id: "bing", enabled: true }],
    source: "ja", target: "zh-CN", onlySourceLanguage: true, skipTargetLanguage: false, includeCode: false,
    joinLines: false, wrapMode: "keep", textMode: "lines", llmModel: "", imageModel: "", fontPath: "",
    progress: { step: 2, state: "stopped", completed: 0, total, detail: "回归工程已准备" },
    translationRuns: {
      text: { step: 2, state: "stopped", completed: 0, total, detail: "回归工程已准备" },
      images: { step: 2, state: "skipped", completed: 0, total: 0, detail: "夹具仅含文本" },
    },
  };
  await runHelper("save", { project });
  await runHelper("save-task", { root, task });
  const fixture = {
    name, root, folder, total, taskFile: join(work, "task-state.json"),
    projectFile: join(folder, "unity-project.json"), journalFile: join(folder, "text-translation-states.jsonl"),
    calls: [], sent: [], pending: [], writes: [], cap: total,
  };
  projects.set(name, fixture);
  return fixture;
}

async function payload(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function json(response, value, status = 200) {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function serveFixture(request, response, next) {
  const route = new URL(request.url, "http://127.0.0.1").pathname;
  const serve = async () => {
    if (route === "/__unity_recovery.html") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(await server.transformIndexHtml(route, '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/__unity_recovery.tsx"></script>'));
    } else if (route === "/__unity_recovery/config") {
      json(response, { projects: [...projects.values()].map(({ name, root }) => ({ name, root })), runDir, settings });
    } else if (route === "/__unity_recovery/helper") {
      const { action, request: input } = await payload(request);
      assert.ok(allowed.has(action), "夹具不允许执行 helper 操作 " + action);
      const root = input.root || input.project?.root;
      const path = input.path || input.project?.folder;
      const project = [...projects.values()].find(item => root
        ? flatPath(item.root) === flatPath(root)
        : path && flatPath(item.projectFile) === flatPath(path));
      assert.ok(project, action + " 请求越出夹具工程");
      if (path) assert.ok([project.folder, project.projectFile].map(flatPath).includes(flatPath(path)), action + " 工程路径与 root 不符");
      const result = await runHelper(action, input);
      if (action === "inspect" && project.holdInspection) {
        project.holdInspection = false;
        await new Promise(resolve => { project.releaseInspection = resolve; });
      }
      if (action === "save-task") project.writes.push({
        folder: input.task.projectFolder, progress: input.task.progress, text: input.task.translationRuns?.text,
      });
      json(response, result);
    } else if (route === "/api/settings") {
      json(response, settings);
    } else if (route === "/api/translate/cancel") {
      json(response, { ok: true });
    } else if (route === "/api/translate") {
      const { text, provider } = await payload(request);
      const match = /T085([A-Z]+)-(\d+)$/.exec(text);
      assert.ok(match && projects.has(match[1]), "翻译请求原文不匹配夹具：" + text);
      const [_, name, indexText] = match;
      const project = projects.get(name), index = Number(indexText);
      assert.equal(provider, "bing", "夹具应只走单个翻译引擎");
      project.calls.push(index);
      const send = () => {
        if (!response.destroyed) project.sent.push(index);
        json(response, { ok: true, provider, source: "ja", translation: translated(name, index) });
      };
      if (index > project.cap) project.pending.push({ index, send, disconnected: () => response.destroyed });
      else {
        // Ensure item 237 crosses the production time-based batch flush, then hold 238.
        if (name === "EDGE" && index === 237) await delay(1200);
        send();
      }
    } else if (route.startsWith("/api/")) {
      json(response, { error: "夹具未实现 " + route }, 404);
    } else next();
  };
  void serve().catch(error => {
    console.error(error);
    json(response, { error: String(error) }, 500);
  });
}

const fixture = String.raw`
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { UnityOfflineView } from "/src/components/UnityOfflineView";
import "/src/styles.css";
import "/src/unityOffline.css";

const { projects, runDir, settings } = await (await fetch("/__unity_recovery/config")).json();
const callbacks = new Map();
window.unityRecoveryInspections = [];
let sequence = 0;
localStorage.setItem("llmchat-unity-output-directory", runDir);
window.__TAURI_INTERNALS__ = {
  transformCallback: callback => { const id = ++sequence; callbacks.set(id, callback); return id; },
  unregisterCallback: id => callbacks.delete(id),
  invoke: async (command, args) => {
    if (command === "unity_offline_stop") return;
    if (command !== "unity_offline_run") throw new Error("夹具不支持 " + command);
    const response = await fetch("/__unity_recovery/helper", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: args.action, request: args.request }),
    });
    const data = await response.json();
    const callback = callbacks.get(args.onProgress.id);
    if (!response.ok) {
      callback?.({ index: 0, end: true });
      throw new Error(data.error);
    }
    data.progress.forEach((message, index) => callback?.({ index, message }));
    callback?.({ index: data.progress.length, end: true });
    if (args.action === "inspect") window.unityRecoveryInspections.push(args.request.root);
    return data.result;
  },
};
function Fixture() {
  const [current, setCurrent] = useState(new URL(location.href).searchParams.get("project"));
  const [busy, setBusy] = useState(false);
  const [installedRoot, setInstalledRoot] = useState(null);
  const view = useRef(null);
  const project = projects.find(item => item.name === current);
  window.unityRecovery = {
    current, busy, ready: installedRoot === project.root,
    switchTo: async name => {
      const result = await view.current.prepareToLeave();
      if (result) setCurrent(name);
      return result;
    },
  };
  return <UnityOfflineView ref={view} active game={{
    isUnity: true, gameDir: project.root, gameExe: "", runtime: "mono", hasAutoTranslator: false, hasBepInEx: false, installMethod: "",
  }} settings={settings} toolbarTarget={null} onBusyChange={setBusy} onInstallationChange={setInstalledRoot}/>;
}
createRoot(document.querySelector("#root")).render(<Fixture/>);
`;

async function openPage(project) {
  const target = await (await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      const detail = message.params.exceptionDetails;
      errors.push(detail.exception?.description || detail.text);
    }
    if (!pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("CDP 超时 " + method));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  activePage = {
    evaluate, errors,
    close: async () => {
      const response = await fetch("http://127.0.0.1:" + port + "/json/close/" + target.id);
      assert.ok(response.ok, "关闭测试标签页 " + target.id);
      socket.close();
      activePage = undefined;
    },
  };
  await call("Runtime.enable");
  await call("Page.navigate", { url: "http://127.0.0.1:" + server.httpServer.address().port + "/__unity_recovery.html?project=" + project.name });
  await waitFor(project.name + " 挂载真实组件", () => evaluate("window.unityRecovery?.current || null"), value => value === project.name);
  return activePage;
}

const button = label => 'Array.from(document.querySelectorAll("button")).find(b=>(' + JSON.stringify(label) + '.includes(b.getAttribute("aria-label")) || ' + JSON.stringify(label) + '.includes(b.textContent.trim()))&&!b.disabled&&b.getClientRects().length)';
async function click(page, label) {
  const target = button(Array.isArray(label) ? label : [label]);
  await waitFor("可用按钮 " + label, async () => ({
    found: await page.evaluate("Boolean(" + target + ")"),
    buttons: await page.evaluate('Array.from(document.querySelectorAll("button")).filter(b=>b.getClientRects().length).map(b=>[b.getAttribute("aria-label") || b.textContent.trim(), b.disabled]).slice(0,40)'),
  }), value => value.found);
  await page.evaluate("(" + target + ").click(); true");
}
async function restored(page, project, completed, finished = false) {
  await waitFor(project.name + " 工程已启动", () => page.evaluate("Boolean(window.unityRecovery?.ready && !window.unityRecovery.busy)"), Boolean);
  await waitFor(project.name + " 恢复后的检查点", async () => {
    const data = await readJson(project.taskFile);
    return { state: data.progress.state, finished: data.finished, completed: data.translationRuns?.text.completed, writes: project.writes.length };
  }, data => data.state === (finished ? "done" : "stopped") && data.finished === finished && data.completed === completed);
  if (finished) {
    const textTab = await page.evaluate("document.getElementById('unity-step-2.1')?.getAttribute('aria-selected')");
    assert.equal(textTab, "true", project.name + " 重开显示文本翻译阶段");
    assert.equal(await page.evaluate("Boolean(" + button(["继续翻译正文", "恢复文本翻译"]) + ")"), false, project.name + " 500/500 不应提示恢复");
  }
  assert.deepEqual(page.errors, [], project.name + " 页面运行错误");
}

async function inspect(project, count, state) {
  const task = await readJson(project.taskFile);
  assert.equal(task.progress.state, state, project.name + " task-state.json 主状态");
  assert.equal(task.finished, state === "done", project.name + " finished");
  assert.equal(task.translationRuns.text.completed, count, project.name + " 文本检查点完成数");
  assert.equal(task.translationRuns.text.total, project.total, project.name + " 文本检查点总数");
  const { result } = await runHelper("load", { path: project.projectFile });
  assert.equal(result.entries.length, project.total, project.name + " 磁盘工程条目数");
  for (const [i, entry] of result.entries.entries()) {
    const label = project.name + " unity-project.json 项 " + (i + 1);
    assert.equal(entry.id, String(i + 1), label + " ID");
    assert.equal(entry.source, sourceText(project.name, i + 1), label + " 原文");
    assert.equal(entry.translation, i < count ? translated(project.name, i + 1) : "", label + " 译文");
    assert.equal(entry.error, "", label + " 错误");
    assert.equal(entry.selected, true, label + " 选中状态");
    if (i < count) assert.equal(entry.translationTarget, "zh-CN", label + " 目标语言");
  }
  return task;
}
async function stopped(project, label) {
  // A wrong terminal transition should fail immediately, instead of only timing out.
  const task = await waitFor(label, () => readJson(project.taskFile), value => ["done", "stopped", "error"].includes(value.progress.state));
  assert.equal(task.progress.state, "stopped", label + " 应把主检查点标记为 stopped");
}
const through = (start, count) => Array.from({ length: count }, (_, index) => start + index);
const replies = (project, first, count) => assert.deepEqual(project.sent, through(first, count), project.name + " 成功回复序列（不得重复或漏项）");
const gate = (project, index) => waitFor(project.name + " 阻塞请求 #" + index, () => project.pending.map(item => item.index), indexes => indexes.includes(index));
async function resume(page) {
  await click(page, ["开始筛选文本", "继续筛选文本"]);
  await click(page, ["开始翻译正文", "继续翻译正文"]);
}
async function releaseGate(project) {
  const item = project.pending.shift();
  assert.ok(item, project.name + " 应有被延迟的请求");
  const disconnected = await waitFor(project.name + " 旧请求已取消", () => item.disconnected(), Boolean);
  item.send();
  return { entry: item.index, disconnected };
}
async function terminal(project) {
  const task = await waitFor(project.name + " 等待终态落盘", () => readJson(project.taskFile), value => value.finished || value.progress.state === "error");
  assert.equal(task.progress.state, "done", project.name + " 翻译应结束。实际：" + JSON.stringify(task.progress));
}

try {
  const pause = await seed("PAUSE", 24);
  const boundary = await seed("EDGE", 500);
  const a = await seed("A", 24), b = await seed("B", 24);
  process.env.VITE_API_BASE = "";
  const fixturePath = join(frontend, "__unity_recovery.tsx").replaceAll("\\", "/");
  server = await createServer({
    root: frontend, cacheDir: join(runDir, "vite"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, hmr: false },
    plugins: [{
      name: "unity-recovery", enforce: "pre",
      resolveId(id) { if (id === "/__unity_recovery.tsx") return fixturePath; },
      load(id) { if (id === fixturePath) return fixture; },
      transform(code, id) {
        if (!options.prove || !id.replaceAll("\\", "/").endsWith("/src/unityTranslationJobs.ts")) return;
        assert.ok(code.includes(mutationAnchor), "故障注入找不到中止分支，需更新 --prove");
        mutated = true;
        return code.replace(mutationAnchor, mutationAnchor.replace('"stopped"', '"done"'));
      },
      configureServer(dev) { dev.middlewares.use(serveFixture); },
    }],
  });
  await server.listen();
  edge = spawn(browser, ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + profile,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], {
    windowsHide: true, stdio: "ignore",
  });
  const portFile = join(profile, "DevToolsActivePort");
  port = await waitFor("Edge CDP 端口", async () => {
    if (edge.exitCode !== null) throw new Error("隔离浏览器启动失败，退出码 " + edge.exitCode);
    return existsSync(portFile) ? Number((await readFile(portFile, "utf8")).split("\n")[0]) : 0;
  }, Boolean);

  pause.cap = 9;
  let page = await openPage(pause);
  await restored(page, pause, 0);
  await resume(page);
  await gate(pause, 10);
  await click(page, "中止翻译正文");
  await stopped(pause, "中途点击中止");
  const pausedTask = await inspect(pause, 9, "stopped");
  assert.ok(pausedTask.translationRuns.text.elapsedMs > 0, "中止后保存本轮耗时");
  await releaseGate(pause);
  replies(pause, 1, 9);
  await page.close();
  pause.cap = 24;
  page = await openPage(pause);
  await restored(page, pause, 9);
  const priorPause = pause.calls.length;
  await resume(page);
  await terminal(pause);
  await inspect(pause, 24, "done");
  assert.deepEqual(pause.calls.slice(priorPause), through(10, 15), "重开只请求未完成的 10–24 项");
  replies(pause, 1, 24);
  console.log("PASS 中止后续跑 | 9/24 落盘，重开 24/24，每项只成功处理一次");
  await page.close();

  boundary.cap = 237;
  page = await openPage(boundary);
  await restored(page, boundary, 0);
  await resume(page);
  await gate(boundary, 238);
  await waitFor("EDGE 237/500 running 检查点", () => readJson(boundary.taskFile), task => task.progress.state === "running" && task.translationRuns?.text.completed === 237);
  await page.close();
  await releaseGate(boundary);
  await inspect(boundary, 237, "running");
  boundary.cap = 500;
  page = await openPage(boundary);
  await restored(page, boundary, 237);
  const priorBoundary = boundary.calls.length;
  await resume(page);
  await terminal(boundary);
  await inspect(boundary, 500, "done");
  assert.deepEqual(boundary.calls.slice(priorBoundary), through(238, 263), "237/500 重开后只请求未完成的 238–500 项");
  replies(boundary, 1, 500);
  const completedCalls = boundary.calls.length;
  await page.close();
  page = await openPage(boundary);
  await restored(page, boundary, 500, true);
  await inspect(boundary, 500, "done");
  assert.equal(boundary.calls.length, completedCalls, "500/500 重开不应再发翻译请求");
  console.log("PASS 断点重开   | 关闭于 237/500 和 500/500，逐项核对译文与完成数");
  await page.close();

  a.cap = 12;
  a.holdInspection = true;
  b.cap = 6;
  page = await openPage(a);
  await restored(page, a, 0);
  await resume(page);
  await gate(a, 13);
  assert.equal(await page.evaluate('window.unityRecovery.switchTo("B")'), false, "A 运行时应被切工程守卫拦住");
  await click(page, "中止翻译正文");
  await stopped(a, "工程 A 半程中止");
  await inspect(a, 12, "stopped");
  await restored(page, a, 12);
  const aHash = sha(await readFile(a.taskFile));
  const aProjectHash = sha(await readFile(a.projectFile));
  assert.equal(await page.evaluate('window.unityRecovery.switchTo("B")'), true, "A 停止落盘后允许切 B");
  await restored(page, b, 0);
  await resume(page);
  await gate(b, 7);
  const late = await releaseGate(a);
  assert.equal(late.entry, 13, "切 B 后释放 A 的在途回复");
  assert.ok(a.releaseInspection, "A 的原生预检回调应仍在等待");
  a.releaseInspection();
  await waitFor("B 运行期间收到晚到的 A 原生回调",
    () => page.evaluate("window.unityRecoveryInspections.includes(" + JSON.stringify(a.root) + ")"), Boolean);
  assert.equal(await page.evaluate("window.unityRecovery.current"), "B", "A 的晚到回调不能切回 A");
  late.inspectionDelivered = true;
  await click(page, "中止翻译正文");
  await stopped(b, "工程 B 停止");
  await releaseGate(b);
  await inspect(b, 6, "stopped");
  await restored(page, b, 6);
  const bHash = sha(await readFile(b.taskFile));
  const bProjectHash = sha(await readFile(b.projectFile));
  assert.equal(sha(await readFile(a.taskFile)), aHash, "工程 B 运行期间 A 的检查点字节保持不变");
  assert.equal(sha(await readFile(a.projectFile)), aProjectHash, "工程 B 运行期间 A 的工程文件保持不变");
  assert.equal(await page.evaluate('window.unityRecovery.switchTo("A")'), true, "B 停止落盘后允许切回 A");
  await restored(page, a, 12);
  a.cap = 24;
  await resume(page);
  await terminal(a);
  await inspect(a, 24, "done");
  assert.equal(sha(await readFile(b.taskFile)), bHash, "工程 A 续跑期间 B 的检查点字节保持不变");
  assert.equal(sha(await readFile(b.projectFile)), bProjectHash, "工程 A 续跑期间 B 的工程文件保持不变");
  assert.ok(b.writes.every(write => flatPath(write.folder) === flatPath(b.folder)), "A 的工程路径不得出现在任何 B 检查点请求");
  replies(a, 1, 24);
  replies(b, 1, 6);
  console.log("PASS 工程隔离   | A 12/24 → B 6/24 → A 24/24，迟到请求隔离，双方检查点散列匹配");
  await writeFile(join(runDir, "results.json"), JSON.stringify({ cases: 3, boundaries: [237, 500], isolation: { aStoppedSha256: aHash, bStoppedSha256: bHash, late } }, null, 2) + "\n");
  console.log("总计 3/3 PASS");
} catch (error) {
  if (activePage) {
    await writeFile(join(runDir, "failure-page.txt"), await activePage.evaluate("document.body.innerText").catch(() => ""));
  }
  throw error;
} finally {
  for (const project of projects.values()) {
    project.releaseInspection?.();
    for (const item of project.pending) item.send();
  }
  await activePage?.close().catch(() => {});
  for (const child of inFlight) child.kill();
  if (edge && edge.exitCode === null) {
    const exited = new Promise(resolve => edge.once("exit", resolve));
    edge.kill();
    await exited;
  }
  server?.httpServer?.closeAllConnections();
  await server?.close();
  if (existsSync(profile)) {
    const actualProfile = await realpath(profile);
    assert.equal(dirname(actualProfile), await realpath(runDir), "只能清理本次隔离的浏览器目录");
    await rm(actualProfile, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
  }
  if (options.prove && mutated) console.log("故障注入已启用：只在内存中将 aborted 分支写成 done");
}
