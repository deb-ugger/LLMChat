import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const bundled = await build({
  stdin: { contents: `export * from './components/ImageBrowser'; export * from './components/ImageMaskTools';
    export {imageCanvasMap,imageCanvasPanLimit} from './components/ImageCanvas'; export { renderToStaticMarkup } from 'react-dom/server';`,
    resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, platform: "node", format: "esm", loader: { ".css": "empty" },
  packages: "external",
});
// Resolve React from this project while keeping the regression check entirely in memory.
const code = bundled.outputFiles[0].text.replace(/from "(react(?:\/[^" ]+)?|react-dom\/server)"/g,
  (_, name) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const { ImageBrowser, ImagePreviewFrame, routeImageBrowserKey, runImageToolShortcut, ImageMaskToolbar,
  MaskResizeControls, imageCanvasMap, imageCanvasPanLimit, renderToStaticMarkup } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

const target = (kind = "preview") => ({ closest(selector) {
  if (selector === "[data-game-image-preview-pane]") return kind === "outside" ? null : this;
  if (selector === "[data-image-preview-dragging]") return kind === "dragging" ? this : null;
  return kind === "input" || kind === "button" ? this : null;
} });
const event = (key, options = {}) => ({ key, target: target(), currentTarget: { contains: () => true },
  defaultPrevented: false, nativeEvent: { isComposing: false },
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...options });

let navigated = 0;
for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown"]) routeImageBrowserKey(event(key), () => navigated++);
assert.equal(navigated, 6, "all browsing arrows and paging keys reach the page adapter");
for (const options of [{ defaultPrevented: true }, { nativeEvent: { isComposing: true } },
  ...["input", "button", "dragging", "outside"].map(kind => ({ target: target(kind) }))]) {
  routeImageBrowserKey(event("ArrowRight", options), () => navigated++);
}
assert.equal(navigated, 6, "typing, tool controls and mask gestures never change the active image");
const overview = imageCanvasMap({ left: 100, top: 50, width: 800, height: 600 }, { left: 300, top: 200, width: 400, height: 300 }, "image");
assert.deepEqual(overview.view, { left: 30, top: 22.5, width: 60, height: 45 }, "overview frame represents the visible image region");
assert.deepEqual(imageCanvasMap({ left: 100, top: 50, width: 800, height: 600 }, { left: 0, top: 0, width: 2000, height: 1500 }, "image").view,
  { left: 0, top: 0, width: 120, height: 90 }, "a fitted image has a full-image overview frame");
assert.equal(imageCanvasPanLimit(200, 400), 200);
assert.equal(imageCanvasPanLimit(800, 400), 400);

// Exercise the grouped-list page keys through the actual page adapter.
const groupSource = await readFile(new URL("../src/components/game-mosaic/MosaicGroupTree.tsx", import.meta.url), "utf8");
const groupAst = ts.createSourceFile("MosaicGroupTree.tsx", groupSource, ts.ScriptTarget.Latest, true);
let navigation;
function findNavigation(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "navigateList") navigation = node;
  ts.forEachChild(node, findNavigation);
}
findNavigation(groupAst);
const groupPageSize = Number(groupSource.match(/mosaicGroupPageSize = (\d+)/)[1]);
const groupItems = Array.from({ length: groupPageSize * 2 + 3 }, (_, index) => ({ id: "image-" + index }));
const groupPages = {}, collapsed = { group: true }, activeImage = { id: groupItems[0].id };
const groupNavigation = new Function("groups", "ordered", "groupPages", "active", "listRef", "mosaicGroupPageSize",
  "setCollapsed", "setGroupPages", "selectPreview", "setKeyboardTarget",
  ts.transpileModule("return (" + navigation.getText(groupAst) + ");", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(
  new Map([["group", { items: groupItems }]]), groupItems.map(image => ({ id: "group", image })), groupPages, activeImage, { current: null }, groupPageSize,
  change => Object.assign(collapsed, change(collapsed)), change => Object.assign(groupPages, change(groupPages)), id => { activeImage.id = id; }, () => {});
const groupedEvent = key => event(key, { target: { closest: () => null } });
groupNavigation(groupedEvent("PageDown"));
assert.equal(activeImage.id, "image-" + groupPageSize);
assert.equal(groupPages.group, 1);
assert.equal(collapsed.group, false);
groupNavigation(groupedEvent("PageUp"));
assert.equal(activeImage.id, "image-0");
const beginning = groupedEvent("PageUp"); groupNavigation(beginning);
assert.equal(beginning.defaultPrevented, true, "page boundaries do not scroll the containing page");

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
  const { chromium } = createRequire(import.meta.url)(process.env.IMAGE_BROWSER_TEST_PLAYWRIGHT);
  const fixture = await build({
    stdin: { resolveDir: fileURLToPath(new URL("../src", import.meta.url)), loader: "tsx", contents: `
      import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {ImageBrowser, ImagePreviewFrame} from './components/ImageBrowser';
      import {ImageCanvas} from './components/ImageCanvas';
      import {GameImageViewer} from './components/GameImageViewer';
      import {SampleSetContents} from './components/ImageSampleSetBrowser';
      import {TrainingDatasetImage} from './components/TrainingDatasetImage';
      import './styles/foundation.css'; import './styles/trainingDatasets.css'; import './unityOffline.css';
      const image = {id:'sample', name:'sample.svg', file:'sample.svg', sourceHash:'sample', width:800, height:600, annotation:{}};
      const src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#356787"/></svg>');
      const read=async()=>new Blob([decodeURIComponent(src.split(',')[1])],{type:'image/svg+xml'});
      window.events=[];
      function Fixture(){
        const [masks,setMasks]=useState([{box:[100,100,300,300],part:'male'}]);
        const [viewer,setViewer]=useState(false),[editing,setEditing]=useState(false);
        window.setPanEditing=setEditing;
        const sampleSet={images:Array.from({length:45},(_,i)=>({...image,id:'sample-'+i,name:'sample-'+i+'.svg'})),read};
        return <><button onClick={()=>setViewer(true)}>打开全屏测试</button><ImageBrowser className="fixture-browser" list={<button id="list-item">图片一</button>}
          onListKeyDown={e=>{window.events.push('navigate:'+e.key);e.preventDefault()}}>
          <ImagePreviewFrame keyboardPane className="fixture-frame">
            <ImageCanvas editing={editing} className="image-canvas-fit fixture-pan"><img src={src} alt="test"/></ImageCanvas>
          </ImagePreviewFrame>
        </ImageBrowser><div className="fixture-dataset"><TrainingDatasetImage image={image} read={read} masks={masks}
          editable busy={false} onChange={async next=>{window.events.push('masks:'+JSON.stringify(next));setMasks(next)}}
          onUndo={()=>window.events.push('undo')} canUndo onRedo={()=>window.events.push('redo')} canRedo
          onPreview={()=>{}} onContextMenu={()=>{}} /></div>
          <div className="fixture-samples"><SampleSetContents data={sampleSet}/></div>
          {viewer&&<GameImageViewer title="test.svg" resultLabel="去码结果"
            views={[{label:'原图',width:800,height:600,src},{label:'去码结果',width:800,height:600,
              render:zoom=><div style={{width:800*zoom,height:600*zoom}}><img src={src} alt="custom result" style={{width:'100%',height:'100%'}}/></div>}]}
            onPrevious={()=>window.events.push('previous')} onNext={()=>window.events.push('next')} onClose={()=>setViewer(false)}/>}</>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    ` },
    bundle: true, write: false, platform: "browser", format: "iife", outfile: "fixture.js",
    plugins: [{ name: "sample-browser-fixture", setup(builder) {
      builder.onLoad({ filter: /ImageSampleSetBrowser\.tsx$/ }, async args => ({
        contents: await readFile(args.path, "utf8") + "\nexport {SampleSetContents};", loader: "tsx",
      }));
    } }],
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
    for (const key of ["PageUp", "PageDown"]) {
      await page.keyboard.press(key);
      assert.ok((await page.evaluate(() => window.events)).includes("navigate:" + key));
    }

    const canvas = page.locator(".training-dataset-canvas");
    const dimensions = () => page.evaluate(() => {
      const area=document.querySelector('.training-dataset-canvas'), bitmap=area.querySelector('img'), box=area.querySelector('rect');
      const image=bitmap.getBoundingClientRect(), mask=box.getBoundingClientRect();
      return {left:image.left,top:image.top,width:image.width,height:image.height,maskWidth:mask.width,maskHeight:mask.height,
        fit:Math.min(4,(area.clientWidth-58)/800,(area.clientHeight-26)/600)};
    });
    const initial = await dimensions();
    assert.ok(Math.abs(initial.width / 800 - initial.fit) < .01, "fit uses the image's original dimensions");
    async function drag(area, dx, dy) {
      const bounds = await area.boundingBox();
      const x = bounds.x + Math.min(80,bounds.width/4), y = bounds.y + Math.min(80,bounds.height/4);
      await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+dx,y+dy); await page.mouse.up();
    }
    await canvas.locator("img").waitFor({ state: "visible" });
    await drag(canvas,80,45);
    const dragged = await dimensions();
    assert.ok(dragged.left > initial.left + 40 && dragged.top > initial.top + 20, "fitted dataset images pan immediately without selecting a drawing tool");
    const map = page.locator(".training-dataset-canvas-frame .image-canvas-minimap");
    await map.waitFor({ state: "visible" });
    assert.equal(await map.locator(".image-canvas-minimap-head").count(), 0, "minimap has no separate header");
    const closeBounds = await map.getByRole("button", { name: "收起小地图" }).boundingBox();
    const thumbnailBounds = await map.locator(".image-canvas-minimap-image").boundingBox();
    assert.ok(closeBounds.y >= thumbnailBounds.y && closeBounds.x+closeBounds.width <= thumbnailBounds.x+thumbnailBounds.width+1,
      "minimap close button overlays the thumbnail's upper-right corner");
    const positions = await map.evaluate(element => {
      const m=element.getBoundingClientRect(),p=element.parentElement.getBoundingClientRect();
      return {right:p.right-m.right,bottom:p.bottom-m.bottom};
    });
    assert.ok(positions.right >= 7 && positions.right <= 11 && positions.bottom >= 7 && positions.bottom <= 11, "dataset minimap is fixed to the viewport's bottom-right corner");
    await map.getByRole("button", { name: "收起小地图" }).click();
    const openMap = page.locator(".training-dataset-canvas-frame").getByRole("button", { name: "展开小地图" });
    await openMap.waitFor({ state: "visible" }); await openMap.click();
    await map.waitFor({ state: "visible" });
    const frameBefore = await map.locator(".image-canvas-minimap-viewport").getAttribute("style");
    const dragBounds = await canvas.boundingBox();
    await page.mouse.move(dragBounds.x+90,dragBounds.y+90); await page.mouse.down();
    await page.mouse.move(dragBounds.x+190,dragBounds.y+150);
    assert.notEqual(await map.locator(".image-canvas-minimap-viewport").getAttribute("style"), frameBefore, "overview frame follows panning before the pointer is released");
    await page.mouse.up();
    await map.getByRole("button", { name: "定位图片可见区域" }).focus(); await page.keyboard.press("Enter");
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
    await canvas.focus(); await page.keyboard.press("v");
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
    async function checkHalfVisible(area) {
      const coverage = await area.evaluate(element => {
        const v=element.getBoundingClientRect(),i=element.querySelector('img').getBoundingClientRect();
        return {width:Math.max(0,Math.min(v.right,i.right)-Math.max(v.left,i.left)),height:Math.max(0,Math.min(v.bottom,i.bottom)-Math.max(v.top,i.top)),
          minWidth:Math.min(v.width,i.width)/2,minHeight:Math.min(v.height,i.height)/2};
      });
      assert.ok(coverage.width >= coverage.minWidth-1 && coverage.height >= coverage.minHeight-1, "scroll panning retains the half-visible boundary");
    }
    await canvas.focus(); await drag(canvas,2400,1800); await checkHalfVisible(canvas);
    await map.getByRole("button", { name: "定位图片可见区域" }).focus(); await page.keyboard.press("Enter");
    await page.locator(".fixture-dataset").evaluate(element => { element.style.zoom = ".8"; });
    const scaledBefore = await dimensions(); await drag(canvas,60,35);
    assert.ok((await dimensions()).left > scaledBefore.left+40, "panning respects the application CSS zoom");
    await page.locator(".fixture-dataset").evaluate(element => { element.style.zoom = ""; });
    const palettes = [];
    for (const theme of ["paper", "ink"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme=theme; }, theme);
      palettes.push(await map.evaluate(element => getComputedStyle(element).backgroundColor));
      assert.ok(await map.getByRole("button", { name: "收起小地图" }).isVisible());
    }
    assert.notEqual(palettes[0], palettes[1], "minimap colors follow both themes");
    if (process.env.IMAGE_BROWSER_SCREENSHOT) await page.locator(".fixture-dataset").screenshot({ path: process.env.IMAGE_BROWSER_SCREENSHOT });

    const pan = page.locator(".fixture-pan"), stage = pan.locator(".image-canvas-stage");
    const beforeDefaultPan = await stage.boundingBox();
    await drag(pan,30,20);
    assert.ok((await stage.boundingBox()).x > beforeDefaultPan.x+20, "shared fit-image canvas defaults to dragging");
    await page.evaluate(() => window.setPanEditing(true)); await pan.focus();
    const bounds = await pan.boundingBox();
    await pan.hover(); await page.keyboard.down("Space");
    await page.mouse.move(bounds.x+100,bounds.y+80); await page.mouse.down();
    await page.mouse.move(bounds.x+130,bounds.y+100); await page.mouse.up(); await page.keyboard.up("Space");
    assert.notEqual(await stage.evaluate(element => getComputedStyle(element).translate), "0px", "Space+drag pans the shared canvas");
    await page.evaluate(() => window.setPanEditing(false));
    await drag(pan,1600,1000);
    const visible = await pan.evaluate(element => {
      const v=element.getBoundingClientRect(),i=element.querySelector('.image-canvas-stage > img').getBoundingClientRect();
      return {width:Math.max(0,Math.min(v.right,i.right)-Math.max(v.left,i.left)),height:Math.max(0,Math.min(v.bottom,i.bottom)-Math.max(v.top,i.top)),
        minWidth:Math.min(v.width,i.width)/2,minHeight:Math.min(v.height,i.height)/2};
    });
    assert.ok(visible.width >= visible.minWidth-1 && visible.height >= visible.minHeight-1, "panning retains half the smaller image/viewport span");

    await page.getByRole("button", { name: "打开全屏测试" }).click();
    const viewer = page.locator(".unity-original-viewer");
    await viewer.locator(".image-canvas-minimap").waitFor({ state: "visible" });
    const viewerImage = viewer.locator(".unity-viewer-bitmap > img");
    const viewerBefore = await viewerImage.boundingBox();
    await drag(viewer.locator(".unity-original-viewer-body"),60,35);
    assert.ok((await viewerImage.boundingBox()).x > viewerBefore.x+30, "fullscreen fitted images use the same default pan behavior");
    await page.keyboard.press("PageDown"); await page.keyboard.press("PageUp");
    const history = await page.evaluate(() => window.events);
    assert.ok(history.includes("next") && history.includes("previous"), "fullscreen PageUp/PageDown retain image navigation");
    await page.keyboard.press("ArrowRight");
    await page.getByRole("dialog", { name: "查看去码结果", exact: true }).waitFor({ state: "visible" });
    await viewer.locator(".image-canvas-minimap-image img").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "hidden" });

    const samples = page.locator(".fixture-samples");
    await samples.locator("[data-game-image-preview-pane]").focus();
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => document.querySelector('.fixture-samples .image-sample-set-preview header strong')?.textContent === 'sample-20.svg');
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => document.querySelector('.fixture-samples .image-sample-set-preview header strong')?.textContent === 'sample-40.svg');
    await page.keyboard.press("PageUp");
    await page.waitForFunction(() => document.querySelector('.fixture-samples .image-sample-set-preview header strong')?.textContent === 'sample-20.svg');
    assert.deepEqual(errors, []);
    console.log("Browser checks passed: default pan, half-visible bounds, live minimap/close/open, paging, fullscreen, mask alignment and editing shortcuts.");
  } finally { await browser.close(); }
}
