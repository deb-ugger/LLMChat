import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const src = fileURLToPath(new URL("../src", import.meta.url));
const mosaicSource = ts.createSourceFile("gameMosaic.ts", await readFile(new URL("../src/gameMosaic.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let labels;
function findLabels(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(mosaicSource) === "mosaicModelLabels") labels = node.initializer.getText(mosaicSource);
  ts.forEachChild(node, findLabels);
}
findLabels(mosaicSource);
// Rendering uses the real labels without initializing detector/model services.
const modelLabels = { name: "contour-model-labels", setup(builder) {
  builder.onLoad({ filter: /[\\/]gameMosaic\.ts$/ }, () => ({ contents: "export const mosaicModelLabels=" + labels, loader: "ts" }));
} };
const output = await build({ stdin: { contents: "export {MosaicPreview} from './components/game-mosaic/MosaicPreview';", resolveDir: src, loader: "tsx" },
  jsx: "automatic", bundle: true, write: false, platform: "node", format: "esm", packages: "external", loader: { ".css": "empty" }, plugins: [modelLabels] });
const code = output.outputFiles[0].text.replace(/from "(react(?:\/[^" ]+)?|react-dom(?:\/[^" ]+)?)"/g, (_, name) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const { MosaicPreview } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const boxes = [[100, 130, 240, 240], [380, 200, 480, 270], [5, 10, 70, 80]];
const blob = new Blob(["placeholder"]), active = { id: "image", name: "image.png", width: 800, height: 600, sourceHash: "source" };
const version = { id: "line", model: "illustrious-line-refine", seconds: 14.6, blob, boxes };
const noop = () => {};
const props = { active, activeResult: { source: "source", boxes, checked: true }, visibleCount: 1, paneVisible: true, activeSaved: false,
  candidate: { revision: "source", versions: [version] }, source: { id: "image", revision: "source", blob }, preferredResult: "line", setPreferredResult: noop,
  masks: { tool: null, activeBoxes: boxes, selection: new Set(), hasSelection: false, canCopy: false, canUndo: false,
    selectBox: noop, toggleTool: noop, deleteLast: noop, clear: noop, copy: noop, undo: noop, onPointerDown: noop, onPointerMove: noop, onPointerUp: noop, onPointerCancel: noop },
  actionsDisabled: false, model: "illustrious-line-refine", getViewerNeighbors: () => ({}), onViewerImage: noop, onRedraw: noop,
  onOpenComfy: async () => {}, onApprove: noop, header: "image.png", detailActions: null, notice: null, footer: null };
const render = patch => renderToStaticMarkup(createElement(MosaicPreview, { ...props, ...patch }));
const html = render({});
assert.match(html, /has-contour-compare/);
assert.equal((html.match(/class="unity-image-previews/g) ?? []).length, 1, "crops do not reuse the full-image preview grid");
assert.equal((html.match(/<canvas/g) ?? []).length, 2, "only one crop pair is mounted");
assert.equal((html.match(/class="game-mosaic-contour-toolbar"/g) ?? []).length, 1);
assert.ok(!html.includes("确认后采用") && !html.includes("40vh"));
assert.ok(!render({ source: undefined }).includes("has-contour-compare"));
assert.ok(!render({ activeSaved: true, preferredResult: "saved" }).includes("has-contour-compare"));
assert.ok(!render({ candidate: { revision: "source", versions: [{ ...version, model: "illustrious" }] } }).includes("has-contour-compare"));

if (process.env.MOSAIC_CONTOUR_TEST_PLAYWRIGHT) {
  const { createRequire } = await import("node:module");
  const { chromium } = createRequire(import.meta.url)(process.env.MOSAIC_CONTOUR_TEST_PLAYWRIGHT);
  const fixture = await build({ stdin: { resolveDir: src, loader: "tsx", contents: `
    import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import{MosaicPreview}from'./components/game-mosaic/MosaicPreview';
    import './styles/foundation.css';import './styles/unity.css';import './unityOffline.css';import './gameMosaic.css';import './styles/controls.css';
    const boxes=${JSON.stringify(boxes)};
    async function imageBlob(color){const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;
      const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,800,600);
      context.strokeStyle='#55443c';context.lineWidth=3;context.beginPath();context.moveTo(100,130);context.bezierCurveTo(150,60,220,300,240,240);context.stroke();
      return new Promise(resolve=>canvas.toBlob(resolve,'image/png'));}
    async function main(){const source=await imageBlob('#b8a090'),result=await imageBlob('#789bbe');
      const line={id:'line',model:'illustrious-line-refine',seconds:14.6,blob:result,boxes};
      const other={...line,id:'other',model:'illustrious',blob:await imageBlob('#bbbb66')};const versions=[line,other];window.approvals=[];
      function Fixture(){const[scene,setScene]=useState({width:900,height:700,saved:false,missing:false,reference:false});
        const[preferred,setPreferred]=useState('line'),[selected,setSelected]=useState(-1);
        window.setScene=patch=>setScene(value=>({...value,...patch}));window.setPreferred=setPreferred;window.selectMask=setSelected;
        const masks={tool:null,activeBoxes:boxes,selection:new Set(selected>=0?[boxes[selected]]:[]),hasSelection:selected>=0,
          canCopy:false,canUndo:false,selectBox:box=>setSelected(box?boxes.indexOf(box):-1),toggleTool(){},deleteLast(){},clear(){},copy(){},undo(){},
          onPointerDown(){},onPointerMove(){},onPointerUp(){},onPointerCancel(){}};
        const active={id:'image',name:'image.png',width:800,height:600,sourceHash:'source'};
        return <main className="game-mosaic-workbench contour-fixture" style={{width:scene.width,height:scene.height}}>
          <MosaicPreview active={active} activeResult={{source:'source',boxes,checked:true}} visibleCount={1} paneVisible activeSaved={scene.saved}
            candidate={{revision:'source',versions}} source={scene.missing?undefined:{id:'image',revision:'source',blob:source}}
            approved={{id:'image',revision:'source',blob:result}} preferredResult={preferred} setPreferredResult={setPreferred}
            masks={masks} actionsDisabled={false} model="illustrious-line-refine" referenceCandidate={scene.reference?line.blob:undefined}
            getViewerNeighbors={()=>({})} onViewerImage={()=>{}} onRedraw={()=>{}} onOpenComfy={async()=>{}}
            onApprove={blob=>{window.approvals.push(versions.find(item=>item.blob===blob)?.id);setScene(value=>({...value,saved:true}));setPreferred('saved')}}
            header={<strong>image.png</strong>} detailActions={null} notice={null} footer={null}/>
        </main>;
      }createRoot(document.getElementById('root')).render(<Fixture/>);
    }main();
  ` }, jsx: "automatic", bundle: true, write: false, platform: "browser", format: "iife", outfile: "contour.js", plugins: [modelLabels] });
  const browser = await chromium.launch({ executablePath: process.env.MOSAIC_CONTOUR_TEST_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<style>${fixture.outputFiles.find(file => file.path.endsWith(".css")).text}
      body{margin:16px}.contour-fixture{display:flex;max-width:calc(100vw - 32px)}
    </style><div id="root"></div>`);
    await page.addScriptTag({ content: fixture.outputFiles.find(file => file.path.endsWith(".js")).text });
    await page.waitForFunction(() => document.querySelector('.game-mosaic-contour-cell canvas')?.width === 236);
    const compare = page.locator(".game-mosaic-contour-compare");
    const grid = page.locator(".unity-image-previews.has-contour-compare");
    for (const theme of ["paper", "ink"]) for (const width of [700, 1000]) for (const height of [650, 850]) {
      await page.evaluate(({ theme, width, height }) => { document.documentElement.dataset.theme=theme;window.setScene({width,height}); }, { theme, width, height });
      await page.waitForTimeout(25);
      const layout = await grid.evaluate(element => {
        const original=element.querySelector(':scope > .game-mosaic-original-frame').getBoundingClientRect();
        const result=element.querySelector('.game-mosaic-result-frame').getBoundingClientRect();
        const compare=element.querySelector('.game-mosaic-contour-compare').getBoundingClientRect();
        const root=element.getBoundingClientRect(),button=element.querySelector('.game-mosaic-result-adopt').getBoundingClientRect();
        const toolbar=element.querySelector('.game-mosaic-contour-toolbar').getBoundingClientRect();
        const cells=[...element.querySelectorAll('.game-mosaic-contour-cell')].map(cell=>{const r=cell.getBoundingClientRect();const canvas=cell.querySelector('canvas');return{height:r.height,width:r.width,fit:getComputedStyle(canvas).objectFit}});
        const detail=element.parentElement;
        return {original,result,compare,root,button,toolbar,cells,overflow:detail.scrollHeight-detail.clientHeight};
      });
      const label = `${theme} ${width}x${height}`;
      assert.ok(Math.abs(layout.original.width-layout.result.width) < 1 && Math.abs(layout.original.height-layout.result.height) < 1, "full-image pair stays 1:1 and equal height: " + label);
      assert.ok(layout.compare.top >= layout.original.bottom && Math.abs(layout.compare.width-layout.root.width) < 1 && layout.compare.height >= 200, "crop comparison occupies the full second row: " + label);
      assert.ok(layout.button.left > layout.result.left && layout.button.right <= layout.result.right && layout.button.top >= layout.result.top && layout.button.top < layout.result.top+12, "adoption is inside the result's top-right corner: " + label);
      assert.ok(layout.toolbar.height <= 32 && layout.cells.every(cell=>cell.height >= 160 && cell.fit==='contain'), "single toolbar and large contained crop pair: " + label);
      assert.ok(Math.abs(layout.cells[0].width-layout.cells[1].width) < 1 && layout.overflow <= 1, "crop columns fit without a nested detail scroller: " + label);
    }
    assert.equal(await compare.locator("canvas").count(), 2);
    assert.equal((await compare.locator(".game-mosaic-contour-toolbar").innerText()).replace(/\s/g,""), "第一段裁剪对比·123·对照红框内轮廓与遮挡");
    assert.deepEqual(await page.evaluate(() => window.approvals), [], "candidate preview never auto-adopts");
    await compare.getByRole("button", { name: "区域 2", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.game-mosaic-contour-cell canvas')?.width === 196);
    assert.equal(await compare.locator("canvas").count(), 2);
    assert.equal(await compare.locator("canvas").first().getAttribute("height"), "166", "48px margins are preserved");
    await page.evaluate(() => window.selectMask(2));
    await page.waitForFunction(() => document.querySelector('.game-mosaic-contour-regions [aria-pressed="true"]')?.textContent === '3');
    await page.waitForFunction(() => document.querySelector('.game-mosaic-contour-cell canvas')?.width === 118);
    assert.equal(await compare.locator("canvas").first().getAttribute("height"), "128", "edge crops clamp the same 48px margins");
    const cell = compare.locator(".game-mosaic-contour-cell").first();
    const viewport = cell.locator(".game-mosaic-contour-viewport");
    const canvas = cell.locator("canvas");
    await cell.locator(".image-canvas-minimap-image img").waitFor({ state: "visible" });
    const pictureBefore = await canvas.boundingBox(), bounds = await viewport.boundingBox();
    await page.mouse.move(bounds.x+30,bounds.y+30);await page.mouse.down();await page.mouse.move(bounds.x+65,bounds.y+55);await page.mouse.up();
    assert.ok(Math.abs((await canvas.boundingBox()).x-pictureBefore.x) > 20, "crop uses common default panning");
    await viewport.hover();await page.mouse.wheel(0,-100);await page.waitForTimeout(50);
    assert.ok((await canvas.boundingBox()).width > pictureBefore.width, "crop uses common zooming");
    const map = cell.locator(".image-canvas-minimap");
    assert.equal(await map.locator(".image-canvas-minimap-head").count(), 0, "minimap has no extra header row");
    const close = await map.getByRole("button", { name: "收起小地图" }).boundingBox();
    const thumbnail = await map.locator(".image-canvas-minimap-image").boundingBox();
    assert.ok(close.x >= thumbnail.x && close.y >= thumbnail.y && close.x+close.width <= thumbnail.x+thumbnail.width+1 && close.y+close.height <= thumbnail.y+thumbnail.height, "close control overlays the thumbnail's top-right corner");
    await map.getByRole("button", { name: "收起小地图" }).click();
    await cell.getByRole("button", { name: "展开小地图" }).click();
    await map.waitFor({ state: "visible" });
    await compare.getByRole("button", { name: "收起第一段裁剪对比", exact: true }).click();
    assert.equal(await compare.locator("canvas").count(), 0);
    await compare.getByRole("button", { name: "展开第一段裁剪对比", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.game-mosaic-contour-cell canvas')?.width === 118);
    await page.evaluate(() => { window.setPreferred('other'); });
    await compare.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".has-contour-compare").count(), 0);
    await page.evaluate(() => { window.setPreferred('line');window.setScene({reference:true}); });
    await page.getByRole("button", { name: /采用为本组参考/ }).waitFor({ state: "visible" });
    await page.evaluate(() => window.setScene({reference:false,saved:true}));
    await page.getByRole("button", { name: /替换已采用图/ }).waitFor({ state: "visible" });
    await page.evaluate(() => window.setScene({saved:false}));
    if (process.env.MOSAIC_CONTOUR_SCREENSHOT) await page.locator(".contour-fixture").screenshot({ path: process.env.MOSAIC_CONTOUR_SCREENSHOT });
    await page.getByRole("button", { name: /采用此版/ }).click();
    await compare.waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.approvals), ["line"], "adoption receives the selected candidate blob");
    assert.equal(await page.locator(".has-contour-compare").count(), 0, "saved results leave no crop placeholder");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
console.log("Contour layout checks passed: equal full-image panes, one crop pair, chip switching, common viewer and inset adoption.");
