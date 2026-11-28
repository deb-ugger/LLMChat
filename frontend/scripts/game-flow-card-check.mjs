import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const src = fileURLToPath(new URL("../src", import.meta.url));
// Isolate card rendering from performance persistence and model services.
const performance = { name: "card-performance-format", setup(builder) {
  builder.onLoad({ filter: /gameModelPerformance\.ts$/ }, async args => ({
    contents: (await readFile(args.path, "utf8")).split("\n").find(line => line.startsWith("export function gameDuration")), loader: "ts",
  }));
} };
const output = await build({
  stdin: { contents: "export {GameFlowCard} from './components/GameFlowCard';", resolveDir: src, loader: "tsx" },
  jsx: "automatic", bundle: true, write: false, platform: "node", format: "esm", packages: "external", plugins: [performance],
});
const code = output.outputFiles[0].text.replace(/from "(react(?:\/[^" ]+)?|react-dom(?:\/[^" ]+)?)"/g,
  (_, name) => `from ${JSON.stringify(import.meta.resolve(name))}`);
const { GameFlowCard } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const first = "qwen3-vl:2b-instruct", second = "qwen3.5:4b", file = "Dungeon_C.png";
const meter = model => ({ model, concurrency: 2, tokens: 100, requestMs: 1000, generationTokens: 100, generationMs: 500, requests: 1 });
const measured = { elapsedMs: 10000, models: { first: meter(first), second: meter(second) } };
const base = { title: "复筛打码图片", state: "running", groupedParameters: true, label: "正在处理", elapsed: "00:02:00",
  disclosure: { expanded: false, toggle() {} }, progress: { sample: file, current: 18, total: 663, remainingMs: 60000, configuration: { current: 1, total: 1 } },
  statusLine: second + " · " + file + " · 合并复核 · 3 个候选 · 等待模型返回",
  foldedSummary: { models: [first, second] }, stepMeasurement: measured };
const render = patch => renderToStaticMarkup(createElement(GameFlowCard, { ...base, ...patch }));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const active = html => html.match(/game-flow-fold-lane is-active[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
check(active(render({})).includes(second), "waiting refinement must show the current model, not the sample filename");
check(active(render({})).includes("200.0"), "the current model retains its pure-generation rate");
check(active(render({ statusLine: first + " · " + file })).includes(first), "model changes follow the status line");
check(active(render({ statusLine: "候选区域准备 · 18/663 张", progress: { ...base.progress, sample: "准备图片" } })).includes(first),
  "preparation status must not create a fake model lane");
check(active(render({ stepMeasurement: { ...measured, models: { first: meter(first) } } })).includes(second),
  "configured models remain available before their first completed request");
for (const state of ["done", "stopped", "error"]) for (const expanded of [false, true]) {
  check(render({ state, disclosure: { expanded, toggle() {} } }).includes("game-flow-elapsed"), `${state} retains elapsed time when expanded=${expanded}`);
}
check(!render({ state: "pending", benchmark: { state: "paused", elapsedMs: 120000, sample: file, sampleCurrent: 18, sampleTotal: 663 } })
  .includes("game-flow-folded-compact"), "paused tests must not retain a running compact progress display");
check(!active(render({ stepMeasurement: { elapsedMs: 10000, models: { second: { model: second, tokens: 100, requestMs: 1000 } } } }))
  .includes("纯生成"), "request-average throughput must not be labelled pure generation");
const compact = html => html.split('class="game-flow-folded-compact"')[1]?.split("<div id=")[0] ?? "";
const preparedHtml = compact(render({ progress: { ...base.progress, phase: "prepare", prepared: 407 }, statusLine: "扫描复筛候选区域…" }));
check(preparedHtml.includes("game-flow-fold-prep-label") && preparedHtml.includes("407"), "prepare phase shows its own count");
check(!preparedHtml.includes("game-flow-progress-pct") && !preparedHtml.includes("game-flow-fold-model-row"), "prepare phase has neither percent text nor model row");
check(!preparedHtml.includes(first) && !preparedHtml.includes(second), "prepare phase does not announce a model lane");
check(!render({ progress: { ...base.progress, phase: "prepare", prepared: 407 } }).includes("game-flow-timing-sep"), "prepare phase omits remaining time");
const runHtml = compact(render({ progress: { ...base.progress, phase: "run", prepared: 407 } }));
check(runHtml.indexOf("game-flow-fold-model-row") < runHtml.indexOf("game-flow-fold-primary"), "formal model row precedes the progress bar");
check(!runHtml.split('class="game-flow-fold-secondary"')[1]?.includes('class="game-flow-fold-model"'), "bottom row no longer contains the model");
const statusText = runHtml.match(/class="game-flow-fold-status"[^>]*>(.*?)<\/span>/)?.[1];
check(statusText?.startsWith(file) && !statusText.includes(second), "bottom status strips only the current model prefix");
check(compact(render({ statusLine: "等待模型资源", progress: { ...base.progress, phase: "run" } })).includes("等待模型资源"), "non-model status prefixes remain intact");

// Exercise the caller's actual phase/field mapping without starting a model or a workbench.
const caller = ts.createSourceFile("MosaicStepCards.tsx", await readFile(new URL("../src/components/game-mosaic/MosaicStepCards.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let prepareDeclaration, progressAttribute, summaryDeclaration;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(caller) === "preparing") prepareDeclaration = node;
  if (ts.isVariableDeclaration(node) && node.name.getText(caller) === "headerSummary") summaryDeclaration = node;
  if (ts.isJsxAttribute(node) && node.name.getText(caller) === "progress") progressAttribute = node;
  ts.forEachChild(node, visit);
}
visit(caller);
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
const callerProgress = new Function("id", "running", "status", "sample", "processed", "percent", "remainingMs", "successRate",
  compile("const " + prepareDeclaration.getText(caller) + "; return " + progressAttribute.initializer.expression.getText(caller) + ";"));
const status = { prepared: 407, total: 663, completed: 18, processed: 18, parameters: [{}] };
const preparing = callerProgress("refine", true, status, file, 18, 18 / 663 * 100, 60000, 0);
check(preparing.phase === "prepare" && preparing.current === 407 && preparing.prepared === 407 && preparing.completed === 18,
  "refine caller switches progress to preparation without changing inference completion count");
check(preparing.remainingMs === undefined, "refine caller omits preparation ETA");
const inference = callerProgress("refine", true, { ...status, prepared: 663 }, file, 18, 18 / 663 * 100, 60000, 0);
check(inference.phase === "run" && inference.current === 18 && inference.remainingMs === 60000, "prepared=total switches back to inference progress");
for (const id of ["screen", "redraw"]) {
  const other = callerProgress(id, true, status, file, 18, 18 / 663 * 100, 60000, 0);
  check(other.phase === undefined && other.prepared === undefined && other.current === 18, id + " cannot enter refine preparation");
}
const summary = new Function("id", "running", "benchmark", "refineSelection", compile("return " + summaryDeclaration.initializer.getText(caller) + ";"));
check(summary("refine", true, undefined, "已勾选 663 张") === undefined, "running refinement has no preparation header summary");
check(summary("refine", false, undefined, "已勾选 663 张") === "已勾选 663 张", "idle refinement retains the selection summary");

if (process.env.GAME_FLOW_TEST_PLAYWRIGHT) {
  const { createRequire } = await import("node:module");
  const { chromium } = createRequire(import.meta.url)(process.env.GAME_FLOW_TEST_PLAYWRIGHT);
  const fixture = await build({
    stdin: { resolveDir: src, loader: "tsx", contents: `
      import React,{useState} from 'react'; import{createRoot}from'react-dom/client';
      import{GameFlowCard}from'./components/GameFlowCard';
      import './styles/foundation.css'; import './styles/unity.css'; import './unityOffline.css';
      const first=${JSON.stringify(first)},second=${JSON.stringify(second)},file=${JSON.stringify(file)};
      const meter=model=>({model,concurrency:2,tokens:100,requestMs:1000,generationTokens:100,generationMs:500,requests:1});
      function Fixture(){
        const [options,setOptions]=useState({expanded:false,model:second,width:600,single:false,unknown:false,state:'running',phase:'run'});
        window.setCard=patch=>setOptions(value=>({...value,...patch}));
        const models=options.single?{second:meter(second)}:{first:meter(first),second:meter(second)};
        return <div style={{width:options.width,maxWidth:'100%'}}><GameFlowCard title="复筛打码图片" state={options.state}
          label="正在处理" current groupedParameters elapsed="00:02:00" stepMeasurement={{elapsedMs:10000,models}}
          disclosure={{expanded:options.expanded,toggle:()=>setOptions(value=>({...value,expanded:!value.expanded}))}}
          progress={{phase:options.phase,prepared:options.phase==='prepare'?407:663,sample:file,current:options.unknown?undefined:18,total:options.unknown?undefined:663,remainingMs:60000,configuration:{current:1,total:1}}}
          foldedSummary={{models:Object.values(models).map(value=>value.model)}}
          statusLine={options.phase==='prepare'?'扫描复筛候选区域…':options.model+' · '+file+' · 合并复核 · 3 个候选 · 等待模型返回'}
          performance={<table aria-label="模型性能"><tbody><tr><td>模型性能</td></tr></tbody></table>}
          actions={<button type="button" className="unity-btn">中止</button>} />
        </div>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    ` }, jsx: "automatic", bundle: true, write: false, platform: "browser", format: "iife", outfile: "card.js", plugins: [performance],
  });
  const browser = await chromium.launch({ executablePath: process.env.GAME_FLOW_TEST_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent(`<style>${fixture.outputFiles.find(file => file.path.endsWith(".css")).text}
      body{margin:20px;font-family:Arial,sans-serif} .game-flow-item{margin:0}
    </style><div id="root"></div>`);
    await page.addScriptTag({ content: fixture.outputFiles.find(file => file.path.endsWith(".js")).text });
    await page.waitForFunction(() => window.setCard);
    const headerHeights = new Map();
    for (const theme of ["paper", "ink"]) for (const width of [320, 480, 760]) for (const single of [false, true]) for (const phase of ["prepare", "run"]) {
      await page.evaluate(({ theme, width, single, phase }) => {
        document.documentElement.dataset.theme = theme; window.setCard({ width, single, phase, expanded: false, unknown: false });
      }, { theme, width, single, phase });
      await page.locator(phase === "prepare" ? ".game-flow-fold-prep-label" : ".game-flow-fold-model-row").waitFor({ state: "visible" });
      const layout = await page.locator(".game-flow-folded-compact").evaluate(element => {
        const bar=element.querySelector('.game-flow-progress-bar'),fill=bar.querySelector('i'),stats=element.querySelector('.game-flow-fold-stats');
        const row=element.querySelector('.game-flow-fold-secondary'),modelRow=element.querySelector('.game-flow-fold-model-row'),lane=modelRow?.querySelector('.is-active'),model=lane?.querySelector('.game-flow-fold-model'),speed=lane?.querySelector('.game-flow-fold-speed');
        const b=bar.getBoundingClientRect(),s=stats.getBoundingClientRect(),m=model?.getBoundingClientRect(),v=speed?.getBoundingClientRect(),l=lane?.getBoundingClientRect();
        return {barWidth:b.width,barHeight:b.height,barColor:getComputedStyle(bar).backgroundColor,fillImage:getComputedStyle(fill).backgroundImage,
          fillWidth:fill.getBoundingClientRect().width,barRight:b.right,statsLeft:s.left,modelCenter:m&&m.y+m.height/2,speedCenter:v&&v.y+v.height/2,
          speedRight:v?.right,laneRight:l?.right,overflow:element.scrollWidth-element.clientWidth,model:model?.textContent,
          cardOverflow:element.closest('article').scrollWidth-element.closest('article').clientWidth,
          modelBottom:modelRow?.getBoundingClientRect().bottom,barTop:b.top,bottomModels:row.querySelectorAll('.game-flow-fold-model').length,
          hasPercent:!!stats.querySelector('.game-flow-progress-pct'),hasPreparation:!!stats.querySelector('.game-flow-fold-prep-label'),counts:stats.textContent,
          progressPercent:Number(bar.getAttribute('aria-valuenow')),speedFontSize:speed&&parseFloat(getComputedStyle(speed).fontSize),
          status:row.querySelector('.game-flow-fold-status')?.textContent,headerHeight:element.previousElementSibling.getBoundingClientRect().height};
      });
      const label = `${theme}, ${width}px, ${single ? "single" : "dual"}`;
      check(layout.barWidth >= 48 && layout.barHeight === 7, "visible progress geometry: " + label);
      check(layout.barColor !== "rgba(0, 0, 0, 0)" && layout.fillImage !== "none", "progress track and fill have visible paint: " + label);
      check(layout.fillWidth > 0 && layout.barRight <= layout.statsLeft, "progress fill and stats remain separate: " + label);
      check(layout.overflow <= 1 && layout.cardOverflow <= 1 && layout.bottomModels === 0, "card and bottom status row fit without model duplication: " + label);
      if (phase === "prepare") {
        check(layout.hasPreparation && !layout.hasPercent && !layout.model && layout.counts.includes("407"), "preparation has count only: " + label);
        check(Math.abs(layout.progressPercent-407/663*100) < .01, "prepare bar uses prepared count: " + label);
        headerHeights.set(label, layout.headerHeight);
      } else {
        check(Math.abs(layout.modelCenter-layout.speedCenter) < 1 && Math.abs(layout.speedRight-layout.laneRight) < 1, "model/rate alignment: " + label);
        check(layout.model === second && layout.modelBottom <= layout.barTop, "model row is above progress: " + label);
        check(layout.speedFontSize === 10.5 && Math.abs(layout.progressPercent-18/663*100) < .01, "model row retains compact type and inference progress: " + label);
        check(layout.status.startsWith(file) && !layout.status.includes(second), "bottom status has no repeated model: " + label);
        check(Math.abs(layout.headerHeight-headerHeights.get(label)) <= 1 && layout.headerHeight <= 38,
          "both phases share a compact header height: " + label + ` (${headerHeights.get(label)} / ${layout.headerHeight})`);
      }
    }
    await page.evaluate(model => window.setCard({ width: 600, single: false, model }), first);
    await page.waitForTimeout(400);
    check((await page.locator(".game-flow-fold-lane.is-active").textContent()).includes(first), "browser model lane switches correctly");
    check(await page.locator('.game-flow-fold-lane:not(.is-active)[aria-hidden="true"]').count() === 1, "inactive lanes are hidden from assistive technology");
    await page.emulateMedia({ reducedMotion: "reduce" });
    check(await page.locator(".game-flow-fold-lane.is-active").evaluate(element => getComputedStyle(element).transitionDuration) === "0s", "reduced motion disables model transitions");
    await page.getByRole("button", { name: "展开复筛打码图片详情", exact: true }).click();
    check(await page.locator(".game-flow-progress").isVisible(), "expanded progress remains visible");
    check(await page.getByRole("table", { name: "模型性能" }).isVisible(), "expanded performance remains visible");
    check(await page.locator(".game-flow-progress-remaining").count() === 0, "remaining time is not duplicated in expanded progress");
    await page.evaluate(() => window.setCard({ expanded: false, unknown: true }));
    await page.locator(".game-flow-fold-bar .is-indeterminate").waitFor({ state: "visible" });
    check(await page.locator(".game-flow-fold-bar .is-indeterminate").count() === 1, "unknown totals retain indeterminate progress");
    check(errors.length === 0, "browser has no runtime errors: " + errors.join(", "));
    if (process.env.GAME_FLOW_SCREENSHOT) {
      await page.evaluate(() => window.setCard({ unknown: false, model: "qwen3.5:4b" }));
      await page.locator(".game-flow-fold-bar [aria-valuenow]").waitFor({ state: "visible" });
      await page.waitForTimeout(450);
      await page.screenshot({ path: process.env.GAME_FLOW_SCREENSHOT });
      await page.evaluate(() => window.setCard({ phase: "prepare" }));
      await page.locator(".game-flow-fold-prep-label").waitFor({ state: "visible" });
      await page.waitForTimeout(450);
      await page.screenshot({ path: process.env.GAME_FLOW_SCREENSHOT.replace(/\.png$/, ".prepare.png") });
    }
  } finally { await browser.close(); }
}
assert.deepEqual(failures, [], "Game flow card regressions:\n" + failures.join("\n"));
console.log("Game flow card checks passed: compact layout, model/rate display, timing and expanded/paused states.");
