import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const playwrightPath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(isAbsolute(playwrightPath) ? pathToFileURL(playwrightPath).href : playwrightPath);
const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));
const baseline = process.argv.includes("--baseline");
const built = await build({
  stdin: { contents: `
    import {useRef, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import OutputVimLog from './components/OutputVimLog';
    import {usePersistedHeight} from './hooks/usePersistedHeight';
    const rows=Array.from({length:500},(_,i)=>({id:String(i),time:'2026-11-28T01:00:00Z',level:'info',text:'log-entry-'+i+' '+('sample long wrapped log message '.repeat(i%4+1))}));
    function Harness(){
      const size=usePersistedHeight('test-output-height',360,120,700), editor=useRef(null);
      const [cursor,setCursor]=useState('499'),[query,setQuery]=useState('');
      window.outputResizeTest={highlight:()=>setQuery('log-entry'),target:id=>setCursor(id)};
      return <section id="drawer" style={{position:'fixed',bottom:0,left:0,right:0,height:size.height,display:'flex',flexDirection:'column',overflow:'hidden'}}>
        <button id="divider" style={{height:10,flex:'none',cursor:'row-resize'}} onMouseDown={event=>size.beginResize(event,'grow-up')}>resize</button>
        <header style={{height:30,flex:'none'}}>Output</header>
        <div style={{display:'flex',flex:1,minHeight:0,overflow:'hidden'}}>
          <OutputVimLog ref={editor} rows={rows} targetId={cursor} query={query} searchOpen={false} onSelect={setCursor} onClose={()=>{}}/>
        </div>
      </section>;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  `, resolveDir: sourceDirectory, loader: "tsx" },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
  define: { "import.meta.env.VITE_API_BASE": '""' },
  plugins: baseline ? [{ name: "baseline", setup(builder) {
    builder.onLoad({ filter: /OutputVimLog\.tsx$/ }, () => ({
      contents: execFileSync("git", ["show", "HEAD:frontend/src/components/OutputVimLog.tsx"], { cwd: resolve(sourceDirectory, "../.."), encoding: "utf8" }),
      resolveDir: resolve(sourceDirectory, "components"), loader: "tsx",
    }));
  } }] : [],
});
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/bundle.js" ? "application/javascript" : "text/html; charset=utf-8");
  response.end(request.url === "/bundle.js" ? built.outputFiles[0].text : `<!doctype html><style>
    body{margin:0;font:16px monospace;--fs-body:16px}#root{height:100vh}.output-vim-editor{flex:1;min-height:0;min-width:0}
  </style><div id="root"></div><script src="/bundle.js"></script>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || "msedge" });
  const page = await browser.newPage({ viewport: { width: 1000, height: 820 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector(".cm-scroller");
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  const measure = () => page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller"), drawer = document.querySelector("#drawer");
    return { bottom: scroller.scrollTop + scroller.clientHeight, height: scroller.clientHeight, drawerBottom: drawer.getBoundingClientRect().bottom, pageScroll: window.scrollY };
  });
  const drag = async delta => {
    const handle = await page.locator("#divider").boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + delta, { steps: 12 });
    await settle();
    const during = await measure();
    await page.mouse.up(); await settle();
    return { during, after: await measure() };
  };
  const unchanged = (before, after, label) => {
    assert.ok(Math.abs(before.bottom - after.bottom) <= 2, `${label}: visible bottom moved ${after.bottom - before.bottom}px`);
    assert.equal(after.drawerBottom, 820, label + ": drawer bottom moved");
    assert.equal(after.pageScroll, 0, label + ": page scrolled");
  };
  await settle();
  await page.locator(".cm-scroller").evaluate(node => { node.scrollTop = node.scrollHeight; });
  await settle();
  let before = await measure();
  let result = await drag(120);
  unchanged(before, result.during, "tail while shrinking"); unchanged(before, result.after, "tail after shrinking");
  before = result.after; result = await drag(-190);
  unchanged(before, result.during, "tail while expanding"); unchanged(before, result.after, "tail after expanding");
  await page.locator(".cm-scroller").evaluate(node => { node.scrollTop = 2800; }); await settle();
  before = await measure(); result = await drag(100);
  unchanged(before, result.during, "history while shrinking"); unchanged(before, result.after, "history after shrinking");
  before = result.after; result = await drag(-140);
  unchanged(before, result.during, "history while expanding"); unchanged(before, result.after, "history after expanding");
  before = result.after;
  await page.evaluate(() => window.outputResizeTest.highlight()); await settle();
  unchanged(before, await measure(), "highlight without navigation");
  assert.deepEqual(errors, []);
  console.log("PASS actual output editor: drag up/down preserves visible bottom at tail and in history, no page scroll, highlights preserve viewport");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
