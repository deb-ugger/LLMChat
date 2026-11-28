import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundled = await build({
  stdin: { contents: `export * from './components/ImageBrowser'; export * from './components/ImageMaskTools';
    export { renderToStaticMarkup } from 'react-dom/server';`,
    resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, platform: "node", format: "esm", loader: { ".css": "empty" },
  packages: "external",
});
// Resolve React from this project while keeping the regression check entirely in memory.
const code = bundled.outputFiles[0].text.replace(/from "(react(?:\/[^" ]+)?|react-dom\/server)"/g,
  (_, name) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const { ImageBrowser, ImagePreviewFrame, routeImageBrowserKey, runImageToolShortcut, ImageMaskToolbar,
  MaskResizeControls, renderToStaticMarkup } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

const target = (kind = "preview") => ({ closest(selector) {
  if (selector === "[data-game-image-preview-pane]") return kind === "outside" ? null : this;
  if (selector === "[data-image-preview-dragging]") return kind === "dragging" ? this : null;
  return kind === "input" || kind === "button" ? this : null;
} });
const event = (key, options = {}) => ({ key, target: target(), currentTarget: { contains: () => true },
  defaultPrevented: false, nativeEvent: { isComposing: false },
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...options });

let navigated = 0;
for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) routeImageBrowserKey(event(key), () => navigated++);
assert.equal(navigated, 4, "all browsing arrows reach the page adapter");
for (const options of [{ defaultPrevented: true }, { nativeEvent: { isComposing: true } },
  ...["input", "button", "dragging", "outside"].map(kind => ({ target: target(kind) }))]) {
  routeImageBrowserKey(event("ArrowRight", options), () => navigated++);
}
assert.equal(navigated, 4, "typing, tool controls and mask gestures never change the active image");

let listCalls = 0, previewCalls = 0;
const browser = ImageBrowser({ list: "list", children: "picture", onListKeyDown: () => listCalls++, onPreviewKeyDown: () => previewCalls++ });
browser.props.onKeyDown(event("ArrowRight"));
assert.equal(previewCalls, 1);
assert.equal(listCalls, 0, "preview navigation does not run the list adapter twice");
const listPane = browser.props.children[0].props.children[0];
listPane.props.onKeyDown(event("ArrowDown"));
assert.equal(listCalls, 1);
let focused;
const frame = ImagePreviewFrame({ keyboardPane: true, children: "picture" });
const focusTarget = target();
frame.props.onPointerDown({ button: 0, target: focusTarget, currentTarget: Object.assign(focusTarget, { focus: options => focused = options }) });
assert.deepEqual(focused, { preventScroll: true }, "activating a preview preserves page scroll position");

let calls = [];
const tools = ["b", "v", "d", "r", "c"].map(key => ({ id: key, key, label: key, shortcut: key.toUpperCase(), icon: "", run: () => calls.push(key) }));
tools.push({ id: "clear", key: "delete", label: "清空", shortcut: "Shift+Delete", modifier: "shift", icon: "", run: () => calls.push("clear") },
  { id: "undo", key: "z", label: "撤销", shortcut: "Ctrl+Z", modifier: "command", icon: "", run: () => calls.push("undo") });
for (const key of ["b", "V", "d", "r", "c"]) {
  const e = event(key); runImageToolShortcut(e, tools); assert.equal(e.defaultPrevented, true);
}
for (const options of [{ ctrlKey: true }, { metaKey: true }]) runImageToolShortcut(event("z", options), tools);
runImageToolShortcut(event("Delete", { shiftKey: true }), tools);
assert.deepEqual(calls, ["b", "v", "d", "r", "c", "undo", "undo", "clear"]);
for (const options of [{ target: target("input") }, { altKey: true }, { ctrlKey: true }, { repeat: true },
  { defaultPrevented: true }, { nativeEvent: { isComposing: true } }]) runImageToolShortcut(event("b", options), tools);
runImageToolShortcut(event("z", { ctrlKey: true, shiftKey: true }), tools);
runImageToolShortcut(event("Delete"), tools);
runImageToolShortcut(event("b"), tools.map(tool => ({ ...tool, disabled: true })));
assert.equal(calls.length, 8, "disabled tools, modifiers and editor-owned shortcuts are left alone");
const selectedTools = tools.map(tool => tool.id === "clear" ? { ...tool, modifier: undefined, shortcut: "Delete" } : tool);
for (const shiftKey of [false, true]) runImageToolShortcut(event("Delete", { shiftKey }), selectedTools, true);
assert.equal(calls.length, 10, "Delete and Shift+Delete still clear selected masks");
const toolbar = renderToStaticMarkup(ImageMaskToolbar({ tools: selectedTools, hasSelection: true }));
assert.match(toolbar, /aria-keyshortcuts="Control\+Z Meta\+Z"/);
assert.match(toolbar, /aria-keyshortcuts="Delete Shift\+Delete"/);
const handles = renderToStaticMarkup(MaskResizeControls({ box: [10, 20, 80, 90] }));
assert.equal((handles.match(/data-mosaic-resize=/g) ?? []).length, 8);
assert.equal((handles.match(/vector-effect="non-scaling-stroke"/g) ?? []).length, 8,
  "resize hit areas remain aligned at every image zoom");
console.log("Image browser keyboard, focus and mask controls checks passed.");

if (process.env.IMAGE_BROWSER_TEST_PLAYWRIGHT) {
  const { createRequire } = await import("node:module");
  const { readFile } = await import("node:fs/promises");
  const { chromium } = createRequire(import.meta.url)(process.env.IMAGE_BROWSER_TEST_PLAYWRIGHT);
  const fixture = await build({
    stdin: { resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "tsx", contents: `
      import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {ImageBrowser, ImagePreviewFrame} from './components/ImageBrowser';
      import {ImageCanvas} from './components/ImageCanvas';
      import {TrainingDatasetImage} from './components/TrainingDatasetImage';
      import './styles/trainingDatasets.css'; import './unityOffline.css';
      const image = {id:'sample', name:'sample.svg', file:'sample.svg', sourceHash:'sample', width:800, height:600, annotation:{}};
      const src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#356787"/></svg>');
      const read=async()=>new Blob([decodeURIComponent(src.split(',')[1])],{type:'image/svg+xml'});
      window.events=[];
      function Fixture(){
        const [masks,setMasks]=useState([{box:[100,100,300,300],part:'male'}]);
        return <><ImageBrowser className="fixture-browser" list={<button id="list-item">图片一</button>}
          onListKeyDown={e=>{window.events.push('navigate:'+e.key);e.preventDefault()}}>
          <ImagePreviewFrame keyboardPane className="fixture-frame">
            <ImageCanvas className="image-canvas-fit fixture-pan"><img src={src} alt="test"/></ImageCanvas>
          </ImagePreviewFrame>
        </ImageBrowser><div className="fixture-dataset"><TrainingDatasetImage image={image} read={read} masks={masks}
          editable busy={false} onChange={async next=>{window.events.push('masks:'+JSON.stringify(next));setMasks(next)}}
          onUndo={()=>window.events.push('undo')} canUndo onRedo={()=>window.events.push('redo')} canRedo
          onPreview={()=>{}} onContextMenu={()=>{}} /></div></>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    ` },
    bundle: true, write: false, platform: "browser", format: "iife", outfile: "fixture.js",
    define: { "import.meta.env.DEV": "false", "import.meta.env.VITE_API_BASE": '""' },
  });
  const browser = await chromium.launch({ executablePath: process.env.IMAGE_BROWSER_TEST_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const css = fixture.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
    const theme = await readFile(new URL("../src/components/imageBrowser.css", import.meta.url), "utf8");
    await page.setContent(`<style>${css}\n${theme}
      :root {--bg:#f8f8f8;--bg-panel:white;--bg-muted:#eee;--bg-hover:#ddd;--text:#222;--border:#ccc;--border-strong:#aaa;--signal:#2670b0;--space-1:4px;--space-2:8px;--radius-md:6px;--radius-sm:4px;--fs-caption:12px;--fs-body:14px;--dataset-stage:#ddd}
      body{margin:0}.fixture-browser{display:flex;height:200px}.fixture-browser>.image-browser-list{width:200px}
      .fixture-frame{margin:0;width:400px;height:180px}.fixture-frame>.unity-image-preview-surface{width:100%;height:100%}
      .fixture-pan{width:100%;height:100%}.fixture-pan>.image-canvas-stage{width:220px}
      .fixture-dataset{display:flex;width:1300px;height:700px}
    </style><div id="root"></div>`);
    await page.addScriptTag({ content: fixture.outputFiles.find(file => file.path.endsWith(".js")).text });
    await page.waitForFunction(() => document.querySelector(".training-dataset-canvas img")?.complete);
    await page.locator(".fixture-frame").focus();
    await page.keyboard.press("ArrowRight");
    assert.ok((await page.evaluate(() => window.events)).includes("navigate:ArrowRight"));

    const canvas = page.locator(".training-dataset-canvas");
    const dimensions = () => page.evaluate(() => {
      const area=document.querySelector('.training-dataset-canvas'), bitmap=area.querySelector('img'), box=area.querySelector('rect');
      const image=bitmap.getBoundingClientRect(), mask=box.getBoundingClientRect();
      return {width:image.width,height:image.height,maskWidth:mask.width,maskHeight:mask.height,
        fit:Math.min(4,(area.clientWidth-58)/800,(area.clientHeight-26)/600)};
    });
    const initial = await dimensions();
    assert.ok(Math.abs(initial.width / 800 - initial.fit) < .01, "fit uses the image's original dimensions");
    let previous = initial;
    for (const delta of [-100, 100]) {
      await canvas.hover(); await page.mouse.wheel(0, delta);
      await page.waitForTimeout(70);
      const current = await dimensions();
      assert.ok(delta < 0 ? current.width > previous.width : current.width < previous.width, "wheel events change the image zoom");
      assert.ok(Math.abs(current.maskWidth / current.width - .25) < .002, "mask horizontal coordinates survive zoom");
      assert.ok(Math.abs(current.maskHeight / current.height - 1/3) < .002, "mask vertical coordinates survive zoom");
      previous = current;
    }
    await canvas.locator("rect[data-mosaic-box]").click();
    await page.keyboard.press("ArrowRight");
    assert.ok((await page.evaluate(() => window.events)).some(item => item.includes('[101,100,301,300]')), "selected masks move by one original pixel");
    await page.keyboard.press("Shift+ArrowDown");
    assert.ok((await page.evaluate(() => window.events)).some(item => item.includes('[101,110,301,310]')), "Shift moves masks by ten pixels");
    await page.keyboard.press("b");
    assert.equal(await canvas.getAttribute("data-drawing"), "true");
    await page.keyboard.press("v");
    assert.equal(await canvas.getAttribute("data-drawing"), "false");
    for (const key of ["Control+z", "Control+Shift+z", "Control+y"]) await page.keyboard.press(key);
    assert.equal((await page.evaluate(() => window.events)).filter(item => item === "undo").length, 1);
    assert.equal((await page.evaluate(() => window.events)).filter(item => item === "redo").length, 2);
    const part = page.getByRole("combobox", { name: "蒙版 1 部位" });
    await part.focus(); await page.keyboard.press("b");
    assert.equal(await canvas.getAttribute("data-drawing"), "false", "editing a form field does not activate a canvas tool");

    const pan = page.locator(".fixture-pan"), stage = pan.locator(".image-canvas-stage");
    const bounds = await pan.boundingBox();
    await pan.hover(); await page.keyboard.down("Space");
    await page.mouse.move(bounds.x+100,bounds.y+80); await page.mouse.down();
    await page.mouse.move(bounds.x+130,bounds.y+100); await page.mouse.up(); await page.keyboard.up("Space");
    assert.notEqual(await stage.evaluate(element => getComputedStyle(element).translate), "0px", "Space+drag pans the shared canvas");
    assert.deepEqual(errors, []);
    console.log("Browser checks passed: image fit, zoom/mask alignment, canvas shortcuts, undo/redo and Space+drag.");
  } finally { await browser.close(); }
}
