import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { deriveRailView } from "../src/components/gameWorkflowRail.ts";

function section(file, from, to) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, "production section must exist: " + from);
  return stripTypeScriptTypes(source.slice(start, end));
}

const planner = section("../src/components/UnityDeploymentPanel.tsx", "export const deploymentPhases", "type CanvasNode =");
const { deploymentLayers, deploymentSequence, validateDeploymentPlan, deploymentPhases } =
  await import("data:text/javascript;base64," + Buffer.from(planner).toString("base64"));
const runner = section("../src/components/UnityOfflineView.tsx", "  function runDeployment(", "  function stopDeployment()");

const ids = ["scan", "text", "image", "mosaic", "apply"];
const edgesOf = spec => spec.split(" ").filter(Boolean).map(edge => ({
  from: ids[Number(edge[0])], to: ids[Number(edge[1])],
}));
const edgeKeys = edges => edges.map(edge => edge.from + ">" + edge.to).sort();
const layersOf = (middle: string[]) => [[ids[0]], ...middle.map(group => [...group].map(i => ids[Number(i)])), [ids[4]]];

// Each variant lists the expected processing layers and effective edges independently of the planner.
const topologies = [
  { name: "T1 串行", edges: "01 12 23 34", initial: [], variants: [
    [["1","2","3"], "01 12 23 34"], [["2","3"], "02 23 34"], [["1"], "01 14"],
  ] },
  { name: "T2 并行", edges: "01 02 14 24", initial: [], variants: [
    [["123"], "01 02 14 24"], [["23"], "02 04 24"], [["1"], "01 04 14"],
  ] },
  { name: "T3 菱形", edges: "01 03 12 32 24", initial: [], variants: [
    [["13","2"], "01 03 12 32 24"], [["3","2"], "02 03 32 24"], [["1"], "01 04 14"],
  ] },
  { name: "T4 跳过中间", edges: "01 12 23 34", initial: ["mosaic"], variants: [
    [["1","2"], "01 12 24"], [["2"], "02 24"], [["1"], "01 14"],
  ] },
  { name: "T5 只剩首尾", edges: "01 12 23 34", initial: ["text","image","mosaic"], variants: [
    [[], "04"], [[], "04"], [[], "04"],
  ] },
];
const states = ["全 pending", "首项 complete", "中间 complete", "中间 error", "末尾 running"];
const toggles = [[], ["text"], ["image","mosaic"], []];

async function runWithStubs(plan, options: { abortAfter?: string; failAt?: string; completed?: string[] } = {}) {
  const executed: string[] = [], counts: number[] = [], runSteps: string[][] = [], stopped: string[] = [], errors: string[] = [];
  let task: Promise<void> | undefined;
  const deploymentController = { current: undefined as AbortController | undefined };
  const latest = { current: { entries: [], images: [], folder: "fixture" } };
  const action = (step: string) => {
    executed.push(step);
    if (step === options.failAt) throw Error("模拟失败 " + step);
    if (step === options.abortAfter) deploymentController.current?.abort();
  };
  const noop = () => {};
  const deps = {
    root: "fixture", locked: false, deploymentController, running: {current:false}, mosaicBusy:false,
    deploymentPlan:plan, deploymentValidation:{issues:[]}, deploymentSequence, deploymentPhases,
    disabledPhases:plan.disabled, deploymentCompleted:options.completed ?? [], currentStoppedStep:undefined,
    activePatch:null, checkpointRef:{current:null}, patch:null, latest, applied:false,
    deploymentLabel:Object.fromEntries(ids.map(id => [id,id])),
    setDeploymentStop: value => { if (value) stopped.push(value.step); },
    setDeploymentRun: value => { if (value) { runSteps.push(value.steps); counts.push(value.completed); } },
    operation: (_label, fn, _flag, onError) => task = fn().catch(error => onError(error)),
    setActionError: error => errors.push(String(error)),
    save: async () => {},
    setBusy:noop, setGeneration:noop, setProject:noop, setPatch:noop, setApplied:noop, setMessage:noop,
    projectWrites:{current:Promise.resolve()}, taskWrites:{current:Promise.resolve()},
    scan:async () => { action("scan"); return latest.current; },
    projectCheckpoint:noop, publish:noop, remember:noop,
    unityRun:async command => {
      assert.ok(["finish-rescan","finish-deployment-output","save-image","save","discard-deployment-output"].includes(command), command);
      return {project:latest.current};
    },
    exportPatch:async () => { action("apply"); return {folder:"patch",files:1}; }, applyPatch:async () => {},
    runWorkflow:async (_start,_end,_resume,_auto,_rescan,part,_prepared,_chain,context) => {
      assert.deepEqual(context.parts,[part]);
      action(part === "images" ? "image" : part);
      context.finishedParts.add(part);
    },
    runDeploymentMosaic:async () => { action("mosaic"); },
    unityTranslationReadiness:() => ({imagesReady:true}), unityTranslationError:noop, target:"zh", invalidatePatch:noop,
    UnityPaused:class extends Error {}, UnityTranslationStopped:class extends Error {},
  };
  const start = new Function("deps", "const {" + Object.keys(deps).join(",") + "} = deps;\n" + runner + "\nreturn runDeployment;")(deps);
  start("automatic");
  assert.ok(task, "stub must enter the production operation");
  await task;
  assert.ok(runSteps.every(steps => steps.length <= 1), "never display a whole layer as running");
  assert.deepEqual(runSteps.slice(1).flat(), executed, "running UI must match the actual dispatch");
  return { executed, counts:counts.slice(1), stopped, errors };
}

function railOracle(steps, expectedEdges, disabled, disconnected, state) {
  const blocked = new Set(disabled);
  const enabled = steps.map((step,i) => blocked.has(step.id) ? -1 : i).filter(i => i >= 0);
  const outgoing = id => expectedEdges.filter(edge => edge.from === id).length;
  const incoming = id => expectedEdges.filter(edge => edge.to === id).length;
  const classes = (...items) => items.filter(Boolean).sort();
  const missing = step => !blocked.has(step.id) && disconnected.includes(step.id);
  const lanes = ids.slice(1).map((_,index) => ({
    index, count:expectedEdges.filter(({from,to}) =>
      (ids.indexOf(from) <= index) !== (ids.indexOf(to) <= index)).length,
  }));
  const nodes = steps.map(step => ({
    id:step.id, className:classes("game-workflow-node", blocked.has(step.id) ? "skipped" : step.state,
      blocked.has(step.id) && "is-skipped", missing(step) && "is-unlinked",
      outgoing(step.id)>1 && "is-fan-out", incoming(step.id)>1 && "is-fan-in"),
  }));
  const connectors = steps.slice(0,-1).map((step,index) => {
    const next = steps[index+1], skipped = blocked.has(step.id) || blocked.has(next.id);
    return {index, className:classes("game-workflow-connector", index===3 && "is-linked", index===3 && "is-flow-highlight",
      !skipped && step.state==="complete" && (next.state==="complete" ? "is-done" : "is-handed-off"),
      outgoing(step.id)>1 && "is-fan-out", incoming(next.id)>1 && "is-fan-in",
      !lanes[index].count && "is-gap", missing(next) && "is-unlinked", skipped && "is-skipped")};
  });
  const from = state === 1 ? enabled[1] : enabled[0];
  const to = state === 1 && enabled.length === 2 ? from : state === 3 && enabled.includes(2) ? 2 : 4;
  return {nodes,connectors,lanes,beam:{from,to,active:enabled.length>2,isStatic:from===to}};
}

let checked = 0;
for (const topology of topologies) {
  const rawEdges = edgesOf(topology.edges);
  const baseline = [];
  for (let toggle = 0; toggle < toggles.length; toggle++) {
    const disabled = [...new Set([...topology.initial, ...toggles[toggle]])];
    const plan = {edges:rawEdges,disabled,positions:{}};
    const variant = toggle === 3 ? 0 : toggle;
    const [middle, edgeSpec] = topology.variants[variant];
    const expected = layersOf(middle);
    const sequence = expected.flat();
    const validator = validateDeploymentPlan(plan);
    const projected = edgesOf(edgeSpec);
    const disconnected = topology.name.startsWith("T2") && !disabled.includes("mosaic") ? ["mosaic"] : [];
    for (let state = 0; state < states.length; state++) {
      const label = topology.name + " / " + toggle + " / " + states[state];
      assert.deepEqual(deploymentLayers(plan),expected,label+" layers");
      const actual = deploymentSequence(plan);
      assert.deepEqual(actual,sequence,label+" sequence");
      for (const id of ids) assert.equal(actual.filter(step => step === id).length, disabled.includes(id) ? 0 : 1,label+" "+id);
      assert.deepEqual(edgeKeys(validator.effectiveEdges),edgeKeys(projected),label+" effective edges");
      assert.deepEqual(validator.disconnected,disconnected,label+" disconnected");

      const steps = ids.map((id,i) => ({ id, state:state===1 && i===0 || state===2 && i===2 ? "complete" :
        state===3 && i===2 ? "error" : state===4 && i===4 ? "current" : "pending",
        selected:i===4, running:state===4 && i===4, disconnected:disconnected.includes(id) }));
      const rail = deriveRailView(steps, validator.effectiveEdges, validator.enabledSteps, disabled);
      const sorted = rows => rows.map(row => ({...row,className:row.className.split(" ").sort()}));
      assert.deepEqual({...rail,nodes:sorted(rail.nodes),connectors:sorted(rail.connectors)},
        railOracle(steps,projected,disabled,disconnected,state),label+" rail");
      if (toggle===0) baseline[state]=rail;
      if (toggle===3) {
        deriveRailView(steps,validateDeploymentPlan({...plan,disabled:[...disabled,"text"]}).effectiveEdges,undefined,[...disabled,"text"]);
        assert.deepEqual(deriveRailView(steps,validator.effectiveEdges,validator.enabledSteps,disabled),baseline[state],label+" restored state");
      }

      const stub = await runWithStubs(plan);
      assert.deepEqual(stub,{executed:sequence,counts:sequence.map((_,index)=>index),stopped:[],errors:[]},label+" dispatch");
      checked++;
    }
  }
  console.log("PASS " + topology.name + " · 4 组开关 × 5 种状态");
}

const base = {edges:edgesOf("01 02 14 24"),disabled:[],positions:{}};
assert.deepEqual(await runWithStubs(base,{abortAfter:"text",completed:["scan"]}),
  {executed:["text"],counts:[1],stopped:["image"],errors:[]});
assert.deepEqual(await runWithStubs(base,{failAt:"image"}),
  {executed:["scan","text","image"],counts:[0,1,2],stopped:[],errors:["Error: 模拟失败 image"]});
const edgeSkip = {...base,disabled:["scan","apply","mosaic"]};
assert.deepEqual(deploymentSequence(edgeSkip),["text","image"]);
assert.deepEqual((await runWithStubs(edgeSkip)).executed,["text","image"]);
console.log("PASS 阶段逐一执行、完成计数、停止和失败截断");

const ordinary = [{id:"a",state:"current",running:true},{id:"b",state:"current",running:true,selected:true}];
const rail = deriveRailView(ordinary);
assert.ok(rail.connectors[0].className.includes("is-parallel"));
assert.deepEqual(rail.lanes,[{index:0,count:2}]);
assert.deepEqual(rail.beam,{from:0,to:1,active:true,isStatic:false});
const done = deriveRailView(ordinary.map(step => ({...step,state:"complete",running:false})));
assert.ok(done.connectors[0].className.split(" ").includes("is-done"));
assert.deepEqual(done.beam,{from:1,to:1,active:true,isStatic:true});
assert.equal(deriveRailView(ordinary.slice(0,1)).beam.active,false);
assert.equal(deriveRailView([]).beam.active,false);
assert.equal(deriveRailView(ordinary,[],["a"],["b"]).beam.active,false);
assert.ok(!deriveRailView([{...ordinary[0],disconnected:true}],[],[],["a"]).nodes[0].className.includes("is-unlinked"));
console.log("PASS 普通轨道并行、空轨道、单节点及跳过告警互斥");
console.log("PASS 总计 " + checked + " 个矩阵用例及独立边界回归");
