import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, mkdir, access, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "llmchat-downloads-check-"));
const file = join(profile, "download.jsonl");
await writeFile(file, "download fixture");
const screenshot = join(root, "backend/build/incremental/logs/downloads-panel-check.png");
const bundle = await build({
  stdin: { contents: `
    import {createRoot} from 'react-dom/client';
    import {AppDownloadsButton} from './components/AppDownloadsButton';
    import {AppNotice} from './components/AppNotice';
    import * as downloads from './appDownloads';
    window.fixture={...downloads,calls:[],failDelete:false,
      async invoke(command,args){this.calls.push({command,...args});if(this.failDelete)throw Error('文件被占用');
        const response=await fetch('/delete',{method:'POST',body:JSON.stringify(args)});if(!response.ok)throw Error(await response.text());},
      open(path){this.calls.push({command:'open',path});},reveal(path){this.calls.push({command:'reveal',path});}};
    downloads.initAppDownloads(new URLSearchParams(location.search).get('secondary')!=='1');
    createRoot(document.getElementById('root')).render(<><AppDownloadsButton/><AppNotice/></>);
  `, resolveDir: join(root, "frontend/src"), loader: "tsx" },
  outdir: "fixture", bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
  plugins: [{ name: "download-io-fixture", setup(build) {
    build.onResolve({ filter: /(^|\/)api$/ }, () => ({ path: "api", namespace: "fixture" }));
    build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "core", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "js", contents: args.path === "api"
      ? "export const api={openPath:path=>window.fixture.open(path),revealPath:path=>window.fixture.reveal(path)};"
      : "export const invoke=(...args)=>window.fixture.invoke(...args);" }));
  } }],
});
const script = bundle.outputFiles.find(file => file.path.endsWith(".js")).text;
const css = bundle.outputFiles.find(file => file.path.endsWith(".css")).text;
const chrome = process.env.DOWNLOADS_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const windowCss = await readFile(join(root, "frontend/src/windowChrome.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/delete") {
    let data = ""; for await (const chunk of request) data += chunk;
    if (JSON.parse(data).path !== file) { response.writeHead(403).end("仅允许删除测试文件"); return; }
    await unlink(file); response.end("ok"); return;
  }
  response.setHeader("Content-Type", request.url === "/bundle.js" ? "application/javascript" : "text/html; charset=utf-8");
  response.end(request.url === "/bundle.js" ? script : `<!doctype html><meta charset="utf-8"><style>
    :root{--text:#1b1a16;--bg-panel:#fffdf9;--panel:#fffdf9;--border:#dcd6c6;--muted:#6a675c;--accent:#1b1a16;--accent-soft:#e8e2d4;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--fs-body:14px;--fs-caption:12px;--fs-dialog:18px;--radius-sm:4px;--radius-lg:12px}
    body{margin:0;background:#f5f2e9;color:var(--text);font:14px 'Segoe UI',sans-serif}.window-action{position:fixed;top:8px;right:18px;display:grid;place-items:center;width:32px;height:28px;border:0;border-radius:4px;background:#e8e2d4;cursor:pointer}
    ${windowCss}\n${css}
  </style><div id="root"></div><script src="/bundle.js"></script>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const tabs = [];
async function waitFor(work, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const value = await work(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error("等待超时：" + label);
}
let port;
async function openTab(secondary = false) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0; const pending = new Map(); const errors = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error("CDP 超时：" + method)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const tab = { call, evaluate, errors, socket }; tabs.push(tab);
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 900, height: 760, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/?secondary=${secondary ? 1 : 0}` });
  await waitFor(() => evaluate("!!window.fixture && !!document.querySelector('.window-action')"), "下载组件挂载");
  return tab;
}
try {
  browser = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore", windowsHide: true });
  port = await waitFor(async () => { try { return Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { return null; } }, "测试浏览器启动");
  const tab = await openTab();
  assert.equal(await tab.evaluate("document.querySelector('.app-download-panel').matches(':popover-open')"), false);
  const id = await tab.evaluate(`fixture.addDownload({name:'LLMChat-output-2026-11-28.jsonl',source:'输出日志',status:'saving',path:${JSON.stringify(file)}})`);
  await waitFor(() => tab.evaluate("document.querySelector('.app-download-panel').matches(':popover-open') && !!document.querySelector('.app-download-status')"), "开始保存自动展开");
  assert.equal(await tab.evaluate("document.querySelector('.app-download-status').textContent"), "正在保存");
  await tab.evaluate("document.querySelector('.app-download-panel').hidePopover()");
  await waitFor(() => tab.evaluate("document.querySelector('.window-action').getAttribute('aria-expanded')==='false'"), "用户收起下载面板");
  await tab.evaluate(`fixture.updateDownload(${JSON.stringify(id)},{status:'running'})`);
  assert.equal(await tab.evaluate("document.querySelector('.app-download-panel').matches(':popover-open')"), false, "progress updates do not reopen a dismissed panel");
  await tab.evaluate(`fixture.updateDownload(${JSON.stringify(id)},{status:'completed'})`);
  await tab.evaluate("document.querySelector('.window-action').click()");
  await waitFor(() => tab.evaluate("!!document.querySelector('.app-download-open')"), "下载完成操作");
  assert.equal(await tab.evaluate(`document.querySelector('.app-download-panel').textContent.includes(${JSON.stringify(profile)})`), false);
  const layout = await tab.evaluate(`(()=>{const row=document.querySelector('.app-download-row'),name=row.querySelector('.app-download-name'),open=row.querySelector('.app-download-open'),source=row.querySelector('.app-download-source'),folder=row.querySelector('[aria-label^="在文件夹中显示"]');return{below:open.getBoundingClientRect().y>name.getBoundingClientRect().y,sourceRight:source.getBoundingClientRect().x>open.getBoundingClientRect().x,folderText:folder.textContent,height:row.getBoundingClientRect().height}})()`);
  assert.ok(layout.below && layout.sourceRight);
  assert.equal(layout.folderText, "");
  assert.ok(layout.height < 100);
  await tab.evaluate("document.querySelector('.app-download-open').click();document.querySelector('[aria-label^=\"在文件夹中显示\"]').click()");
  assert.deepEqual(await tab.evaluate("fixture.calls.map(call=>call.command)"), ["open", "reveal"]);
  await tab.evaluate("fixture.failDelete=true;document.querySelector('.app-download-delete').click()");
  await waitFor(() => tab.evaluate("!document.querySelector('.app-download-delete').disabled"), "删除失败恢复按钮");
  assert.equal(await tab.evaluate("fixture.getAppDownloads().length"), 1);
  await access(file);
  await tab.evaluate("fixture.failDelete=false;document.querySelector('.app-download-delete').click()");
  await waitFor(() => tab.evaluate("fixture.getAppDownloads().length===0"), "删除文件成功后移除条目");
  await assert.rejects(access(file));
  assert.equal(await tab.evaluate("fixture.calls.at(-1).command"), "delete_download_file");
  console.log("PASS auto-open, hidden paths, compact layout, open/reveal and real fixture deletion; failed deletions retain the file and row");

  await writeFile(file, "another fixture");
  const complete = await tab.evaluate(`fixture.addDownload({name:'download.jsonl',source:'输出日志',status:'completed',path:${JSON.stringify(file)}})`);
  const active = await tab.evaluate(`fixture.addDownload({name:'download.jsonl',source:'输出日志',status:'running',path:${JSON.stringify(file)}})`);
  assert.match(await tab.evaluate(`fixture.deleteDownloadFile(${JSON.stringify(complete)}).then(()=>'',error=>error.message)`), /仍有下载任务/);
  await access(file);
  await tab.evaluate(`(async()=>{fixture.updateDownload(${JSON.stringify(active)},{status:'cancelled'});await fixture.deleteDownloadFile(${JSON.stringify(complete)})})()`);
  assert.equal(await tab.evaluate("fixture.getAppDownloads().length"), 0);
  const second = await openTab(true);
  await tab.evaluate("document.querySelector('.app-download-panel').hidePopover()");
  await second.evaluate("fixture.addDownload({name:'remote.txt',source:'文本译文',status:'running'})");
  await waitFor(() => tab.evaluate("document.querySelector('.app-download-panel').matches(':popover-open') && fixture.getAppDownloads().some(task=>task.name==='remote.txt')"), "跨窗口下载自动展开");
  await tab.evaluate("fixture.updateDownload(fixture.getAppDownloads().find(task=>task.name==='remote.txt').id,{status:'completed'})");
  await waitFor(() => tab.evaluate("document.querySelector('.app-download-status')?.textContent==='已完成'"), "没有可打开路径的下载仍显示完成状态");
  await tab.evaluate(`fixture.addDownload({name:'LLMChat-output-2026-11-28.jsonl',source:'输出日志',status:'completed',path:${JSON.stringify(file)}});fixture.addDownload({name:'这是一个很长的图片压缩包文件名用于检查省略显示和图标位置.zip',source:'游戏图片',status:'running',detail:'正在读取 12 / 80 张图片',progress:{value:12,max:80}}, {pause:()=>{},cancel:()=>{}});fixture.addDownload({name:'failed-export.txt',source:'文本译文',status:'failed',error:'写入失败，请检查文件是否被占用'})`);
  await waitFor(() => tab.evaluate("document.querySelectorAll('.app-download-row').length===4"), "各下载状态显示");
  await mkdir(dirname(screenshot), { recursive: true });
  const bounds = await tab.evaluate("(()=>{const r=document.querySelector('.app-download-panel').getBoundingClientRect();return{x:r.x-6,y:r.y-6,width:r.width+12,height:r.height+12,scale:1}})()");
  const capture = await tab.call("Page.captureScreenshot", { format: "png", clip: bounds });
  await writeFile(screenshot, Buffer.from(capture.data, "base64"));
  await tab.call("Emulation.setDeviceMetricsOverride", { width: 340, height: 650, deviceScaleFactor: 1, mobile: false });
  await tab.evaluate("document.querySelector('.app-download-panel').hidePopover();document.querySelector('.window-action').click()");
  assert.ok(await tab.evaluate("(()=>{const p=document.querySelector('.app-download-panel'),r=p.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&p.scrollWidth<=p.clientWidth+1})()"));
  assert.ok((await tab.evaluate("Array.from(document.querySelectorAll('.app-download-name')).some(name=>name.scrollWidth>name.clientWidth)")));
  assert.deepEqual(tab.errors, []); assert.deepEqual(second.errors, []);
  const permission = await readFile(join(root, "frontend/src-tauri/permissions/delete-download-file.toml"), "utf8");
  const capability = JSON.parse(await readFile(join(root, "frontend/src-tauri/capabilities/downloads.json"), "utf8"));
  assert.match(permission, /commands.allow = \["delete_download_file"\]/);
  assert.ok(capability.permissions.includes("allow-delete-download-file"));
  console.log("PASS active-path protection, duplicate cleanup, cross-window auto-open, narrow viewport and delete-command permissions");
  console.log("Screenshot: " + screenshot);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  if (tabs[0]?.socket.readyState === WebSocket.OPEN) {
    try { await tabs[0].call("Browser.close"); } catch {}
  }
  for (const tab of tabs) tab.socket.close();
  if (browser) { browser.kill(); await Promise.race([new Promise(resolve => browser.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1500))]); }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep) && basename(profile).startsWith("llmchat-downloads-check-"));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
