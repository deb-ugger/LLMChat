import { benchmarkBlockingReason, useBenchmarkRunning } from "../benchmark/benchmarkRunner";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { countMissingGlyphEntries, type UnityEntry, type UnityFontPlan, type UnityPatch } from "../unityOffline";

import { deploymentMetrics, type DeploymentMetrics } from "../unityWorkflow";
import { formatFlowThroughput } from "../gameFlowMetrics";
import { GameFlowPerformance, StepRunningMetrics } from "./GameFlowSequence";
import { StandaloneGameFlowCard, type GameFlowActivity } from "./GameFlowCard";
import { GameProgressBar } from "./GameStepProgress";
import { gameImageExportWarning, subscribeGameImageExportWarnings, type GameImageExportKind } from "../gameImageExport";
import type { ImageExportActions, ImageExportPackage, LegacyImagePatch } from "../hooks/useGameImageExportPackage";
import { modelServiceTimingLines } from "../gameModelPerformance";

export function LegacyImagePatchSection({ legacy, state, actions, locked }: {
  legacy: LegacyImagePatch;
  state: ImageExportPackage;
  actions: ImageExportActions;
  locked: boolean;
}) {
  const { scan, migrating, progress, scanning } = legacy;
  if (!migrating && !scan?.totals.migratable && !scan?.totals.blocked) return null;
  const counts = { translated: 0, mosaic: 0, composed: 0 };
  const blocked = scan?.entries.filter(entry => entry.state !== "migratable") ?? [];
  for (const entry of scan?.entries ?? []) if (entry.state === "migratable") counts[entry.kind]++;
  const kinds = [["译图", counts.translated], ["去码", counts.mosaic], ["合成", counts.composed]]
    .filter(([, count]) => count).map(([label, count]) => label + " " + count).join(" · ");
  const phase = progress?.phase === "publish" ? "发布成品包" : progress?.phase === "copy" ? "复制图片" : "核对旧补丁";
  return <div className="dpl-plan" role="group" aria-label="旧补丁">
    <p>旧补丁</p>
    {migrating ? <>
      <p className="dpl-hint" role="status">{phase}{progress?.total ? " · " + progress.completed + " / " + progress.total : ""}</p>
      <div className="game-flow-progress"><GameProgressBar label="旧补丁迁移进度" value={state.percent ?? undefined} /></div>
      {progress?.relativePath && <div className="dpl-path" title={progress.relativePath}>{progress.relativePath}</div>}
      <div className="dpl-actions"><button type="button" className="dpl-btn" disabled={!state.canCancel} onClick={actions.cancel}>
        {state.cancelling ? "正在取消…" : "取消"}
      </button></div>
    </> : <div className="dpl-actions">
      {!!scan?.totals.migratable && <>
        <span>检测到 {scan.totals.migratable} 张旧补丁图片（{kinds}），可转为成品包</span>
        <button type="button" className="unity-btn" disabled={locked || scanning || !!state.path}
          title={state.path ? "请先处理当前成品包" : "已核实旧补丁和受管原件，可以转为成品包。"}
          onClick={actions.migrateLegacy}>转为成品包</button>
      </>}
      <button type="button" className="dpl-btn" disabled={scanning} onClick={actions.scanLegacy}>{scanning ? "正在检测…" : "重新检测"}</button>
    </div>}
    {blocked.length > 0 && <details>
      <summary>无法迁移 {blocked.length} 项</summary>
      <ul>
        {blocked.map(entry => <li key={entry.relativePath}>
          <div className="dpl-path" title={entry.relativePath}>{entry.relativePath}</div>
          <p className="dpl-hint">{entry.detail}</p>
        </li>)}
      </ul>
    </details>}
  </div>;
}

function imagePackageSize(bytes: number | undefined) {
  if (bytes === undefined) return "—";
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}

export function ImageExportPackageSection({ state, actions, locked }: {
  state: ImageExportPackage;
  actions: ImageExportActions;
  locked: boolean;
}) {
  const { activity, path, confirmed, needsConfirmation, percent, layers, applied, needsRecovery } = state;
  const warning = useSyncExternalStore(subscribeGameImageExportWarnings, () => gameImageExportWarning(path));
  const ready = !locked && !activity && state.canUsePackage;
  const button = (label: string, variant: "" | "primary" | "danger", disabled: boolean, onClick?: () => void) =>
    <button type="button" className={"dpl-btn" + (variant ? " dpl-btn-" + variant : "")} disabled={disabled} onClick={onClick}>{label}</button>;
  const layerLabel = (kind: GameImageExportKind) => {
    const layer = layers[kind];
    if (needsRecovery) return "需恢复";
    if (!layer) return state.canUsePackage && applied && !state.layerRestoreSupported ? "见收据" : "—";
    return layer.state === "restored" ? "已恢复" : layer.state === "partiallyRestored" ? "部分恢复" : "已应用";
  };
  const restore = (kind: GameImageExportKind, label: string) =>
    button(layers[kind]?.state === "restored" ? label + "已恢复" : "恢复" + label, "",
      !ready || !state.canRestore || !layers[kind]?.appliedFiles, () => actions.restore(kind));
  const deletePackage = button(applied ? "恢复并删除" : "删除包", "danger", !ready || needsRecovery, actions.remove);
  const cancel = () => button(state.cancelling ? "正在取消…" : "取消", "", !state.canCancel, actions.cancel);
  let hintText: string;
  let buttons: ReactNode;
  if (activity === "generate") {
    hintText = "正在合成，可取消。";
    buttons = <>{button(percent === null ? "生成中" : `生成中 ${percent}%`, "", true)}{cancel()}</>;
  } else if (activity === "apply" || activity === "restore" || activity === "remove") {
    const label = { apply: "应用中", restore: "恢复中", remove: "删除中" }[activity];
    hintText = label + "，请等待操作完成。";
    buttons = <>{button(label, "", true)}{activity !== "remove" && cancel()}</>;
  } else if (activity === "migrate") {
    hintText = "";
    buttons = null;
  } else if (needsRecovery) {
    hintText = "上次应用或恢复未完成，请先恢复原图。";
    buttons = <>{button("恢复原图", "primary", !ready, () => actions.restore())}{deletePackage}</>;
  } else if (applied) {
    hintText = layers.composed ? "合成图包含译图和去码，恢复合成图会整张还原。" : state.partiallyRestored ? "部分图片已恢复，可继续恢复其余图片。" : "图片已应用，收据已保存。";
    buttons = <>{button("重新应用", "", !ready || state.targetChanged, actions.apply)}{state.canUsePackage && (state.layerRestoreSupported ? <>
      {restore("translated", "译图")}{restore("mosaic", "去码")}
      {layers.composed && restore("composed", "合成图")}
    </> : button("恢复原图", "", !ready || !state.canRestore, () => actions.restore()))}{deletePackage}</>;
  } else if (path) {
    hintText = state.used ? "图片已恢复。删除旧包后可以生成新包。" : "成品包已生成，可以应用到游戏。";
    buttons = <>{button("应用成品包", "primary", !ready || state.used || state.legacyInstalled || state.targetChanged, actions.apply)}
      {button("打开包目录", "", locked, actions.openDirectory)}{deletePackage}</>;
  } else {
    hintText = needsConfirmation ? `有 ${needsConfirmation} 张图需要重新确认，先在图片翻译或去码页确认。`
      : confirmed ? `将把 ${confirmed} 张已确认的图合成成品包。` : "还没有已确认的译图或去码图。";
    buttons = button("生成成品包", "", locked || !state.canGenerate || state.legacyInstalled, actions.generate);
  }

  return <div className="dpl-plan" role="group" aria-label="图片成品包">
    <p>图片成品包</p>
    <dl className="dpl-stats dpl-stats-stack">
      <div><dt>已确认</dt><dd>{confirmed}</dd></div>
      <div><dt>待确认</dt><dd>{needsConfirmation}</dd></div>
      <div><dt>包大小</dt><dd>{imagePackageSize(state.bytes)}</dd></div>
      <div><dt>译图 / 去码</dt><dd><span className="dpl-hint">{layerLabel("translated")} / {layerLabel("mosaic")}</span></dd></div>
      {layers.composed && <div><dt>合成图</dt><dd><span className="dpl-hint">{layerLabel("composed")}</span></dd></div>}
    </dl>
    {path && <div className="dpl-path" title={path}>{path}</div>}
    {(activity === "generate" || activity === "apply") && <div className="game-flow-progress">
      <GameProgressBar label={activity === "generate" ? "成品包生成进度" : "成品包应用进度"} value={percent ?? undefined} />
    </div>}
    {buttons && <div className="dpl-actions">{buttons}</div>}
    {hintText && !(state.legacyInstalled && state.legacyMigrationAvailable) && <p className="dpl-hint">
      {state.legacyInstalled ? "建议先恢复旧图片补丁，再用成品包重新应用。"
        : state.targetChanged && !activity && !needsRecovery ? "游戏里的图片已被改动，需要重新生成" : hintText}
    </p>}
    {applied && !activity && !needsRecovery && warning?.message && <div className="embed-deploy-status" role="status">
      <p className="dpl-hint is-warning">{warning.message}</p>
    </div>}
  </div>;
}

export type DeploymentStageState = "todo" | "active" | "done" | "warn" | "error";

export type DeploymentModel = {
  root: string;
  supportedPhases?: readonly DeploymentPhase[];
  plan: DeploymentPlan;
  run: DeploymentRun | null;
  stoppedStep: DeploymentStep | null;
  completed: DeploymentStep[];
  canStop: boolean;
  textCount: number;
  busyLabel: string | null;
  locked: boolean;
  patchReady: boolean;
  staged?: boolean;
  patch: UnityPatch | null;
  applied: boolean;
  installed: boolean;
  metrics?: DeploymentMetrics;
  cardActivity?: GameFlowActivity;
  fontPath: string;
  fontName: string;
  extraCharacters: string;
  fontPlan: UnityFontPlan | null;
  entries: UnityEntry[];
  images: { total: number; ready: number };
  mosaic: { enabled: boolean; count: number };
  progress: { percent: number | null; state: DeploymentStageState; detail: string; label: string } | null;
};

export type DeploymentActions = {
  execute: () => void;
  savePlan: (plan: DeploymentPlan) => boolean;
  generatePhase: (phase: DeploymentPhase) => void;
  chooseFont: () => void;
  clearFont: () => void;
  setExtraCharacters: (value: string) => void;
  checkFontPlan: () => void;
  stop: () => void;
  generate: () => void;
  openPatchFolder: () => void;
  regenerate: () => void;
  apply: () => void;
  uninstall: () => void;
  removeLayer?: (phase: DeploymentPhase) => void;
  reapply: () => void;
  launch: () => void;
  openReport: () => void;
  openGlyphFolder: () => void;
  locateText: (character: string) => void;
};

export const deploymentPhases = ["text", "image", "mosaic"] as const;
export type DeploymentPhase = typeof deploymentPhases[number];
export type DeploymentStep = "scan" | DeploymentPhase | "apply";
type Point = { x: number; y: number };
type FlowEdge = { from: DeploymentStep; to: DeploymentStep };
type FlowGraph = { positions: Record<DeploymentStep, Point>; edges: FlowEdge[] };
export type DeploymentPlan = FlowGraph & { disabled: DeploymentStep[] };
export type DeploymentFlow = Pick<DeploymentPlan, "edges" | "disabled">;
export type DeploymentRun = {
  mode: "single" | "automatic";
  steps: DeploymentStep[];
  completed: number;
  total: number;
  stopping: boolean;
};

const steps: DeploymentStep[] = ["scan", ...deploymentPhases, "apply"];
const deploymentStepLabels: Record<DeploymentStep, string> = {
  scan: "扫描资源", text: "文本翻译", image: "图片翻译", mosaic: "图片去码", apply: "生成与应用",
};
const planKey = (root: string) => "llmchat-unity-deployment:" + root.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
const fitWidth = 1050, boardHeight = 300, cardWidth = 174, cardHeight = 82;
const nodePositions: Point[] = [
  { x: 16, y: 109 }, { x: 226, y: 57 }, { x: 438, y: 109 }, { x: 650, y: 161 }, { x: 860, y: 109 },
];
const isStep = (id: unknown): id is DeploymentStep => steps.some(step => step === id);
const isPhase = (id: DeploymentStep): id is DeploymentPhase => id !== "scan" && id !== "apply";
const edgeKey = ({ from, to }: FlowEdge) => from + "-" + to;

function connectionIssue(edges: FlowEdge[], { from, to }: FlowEdge) {
  if (from === to) return "阶段不能连接自身";
  if (from === "apply" || to === "scan") return "连线须从扫描资源开始，向生成与应用汇合";
  if (edges.some(edge => edge.from === from && edge.to === to)) return "这条依赖已存在";
  const visited = new Set<DeploymentStep>();
  function reachesSource(step: DeploymentStep): boolean {
    if (step === from) return true;
    if (visited.has(step)) return false;
    visited.add(step);
    return edges.some(edge => edge.from === step && reachesSource(edge.to));
  }
  return reachesSource(to) ? "这条连线会形成循环依赖" : undefined;
}

function effectiveDeploymentEdges(edges: FlowEdge[], enabled: DeploymentStep[]) {
  const active = new Set(enabled);
  const effective = new Map<string, FlowEdge>();
  for (const from of enabled) {
    const queue = new Set<DeploymentStep>([from]);
    for (const step of queue) {
      for (const edge of edges) {
        if (edge.from !== step) continue;
        if (active.has(edge.to)) {
          const direct = { from, to: edge.to };
          effective.set(edgeKey(direct), direct);
        } else {
          queue.add(edge.to);
        }
      }
    }
  }
  return [...effective.values()];
}

export function validateDeploymentPlan({ edges, disabled }: DeploymentFlow) {
  const issues: string[] = [];
  const disconnected: DeploymentStep[] = [];
  const accepted: FlowEdge[] = [];
  for (const edge of edges) {
    const issue = connectionIssue(accepted, edge);
    if (issue) issues.push(deploymentStepLabels[edge.from] + " → " + deploymentStepLabels[edge.to] + " · " + issue);
    else accepted.push(edge);
  }

  const reachable = (start: DeploymentStep, from: "from" | "to", to: "to" | "from") => {
    const visited = new Set<DeploymentStep>([start]);
    for (const step of visited) {
      for (const edge of accepted) if (edge[from] === step) visited.add(edge[to]);
    }
    return visited;
  };
  const fromScan = reachable("scan", "from", "to");
  const toApply = reachable("apply", "to", "from");
  const enabled = deploymentPhases.filter(phase => !disabled.includes(phase));
  if (enabled.length === 0) issues.push("请至少启用一个处理阶段");
  const missingInput = enabled.filter(phase => !fromScan.has(phase));
  const missingOutput = enabled.filter(phase => fromScan.has(phase) && !toApply.has(phase));
  const labels = (ids: DeploymentStep[]) => ids.map(id => deploymentStepLabels[id]).join("、");
  if (missingInput.length) issues.push(labels(missingInput) + "缺少来自扫描资源的路径");
  if (missingOutput.length) issues.push(labels(missingOutput) + "缺少通往生成与应用的路径");
  disconnected.push(...missingInput, ...missingOutput);
  if (!fromScan.has("apply")) {
    if (!disabled.includes("apply")) disconnected.push("apply");
    issues.push("扫描资源与生成和应用之间缺少完整路径");
  }
  const enabledSteps = steps.filter(step => !disabled.includes(step));
  return { issues, disconnected, enabledSteps, effectiveEdges: effectiveDeploymentEdges(accepted, enabledSteps) };
}

export function loadDeploymentPlan(root: string, supported: readonly DeploymentPhase[] = deploymentPhases): DeploymentPlan {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(planKey(root)) || "null"); }
  catch { saved = null; }
  const order: DeploymentStep[] = ["scan", ...new Set<DeploymentPhase>([
    ...(Array.isArray(saved?.order) ? saved.order.filter((item: unknown) => isStep(item) && isPhase(item) && supported.includes(item)) : []), ...supported,
  ]), "apply"];
  const positions = Object.fromEntries(order.map((step, index) => {
    const position = saved?.positions?.[step];
    return [step, Number.isFinite(position?.x) && Number.isFinite(position?.y) ? { x: position.x, y: position.y } : nodePositions[index]];
  })) as FlowGraph["positions"];
  const edges: FlowEdge[] = [];
  if (Array.isArray(saved?.edges)) {
    for (const edge of saved.edges) {
      if (isStep(edge?.from) && isStep(edge?.to) && order.includes(edge.from) && order.includes(edge.to) && !connectionIssue(edges, edge)) edges.push({ from: edge.from, to: edge.to });
    }
  } else {
    for (const [index, to] of order.slice(1).entries()) edges.push({ from: order[index], to });
  }
  const disabled = steps.filter(step => !order.includes(step) || Array.isArray(saved?.disabled) && saved.disabled.includes(step));
  return { positions, edges, disabled };
}

export function saveDeploymentPlan(root: string, plan: DeploymentPlan) {
  localStorage.setItem(planKey(root), JSON.stringify(plan));
}

function ready(step: DeploymentStep, edges: FlowEdge[], remaining: ReadonlySet<DeploymentStep>) {
  return !edges.some(edge => edge.to === step && remaining.has(edge.from));
}

// A skipped phase releases its dependants without using an execution wave.
function releaseSkipped(plan: DeploymentPlan, remaining: Set<DeploymentStep>) {
  let skipped = plan.disabled.find(step => remaining.has(step) && ready(step, plan.edges, remaining));
  while (skipped) {
    remaining.delete(skipped);
    skipped = plan.disabled.find(step => remaining.has(step) && ready(step, plan.edges, remaining));
  }
}

export function deploymentLayers(plan: DeploymentPlan): DeploymentStep[][] {
  // Scanning creates the project, and applying writes the combined patch.
  const layers: DeploymentStep[][] = [["scan"]];
  const remaining = new Set<DeploymentStep>(deploymentPhases);
  while (remaining.size) {
    releaseSkipped(plan, remaining);
    const layer = [...remaining].filter(step => ready(step, plan.edges, remaining));
    if (layer.length === 0 && remaining.size > 0) throw new Error("流程存在循环依赖");
    for (const step of layer) remaining.delete(step);
    if (layer.length) layers.push(layer);
  }
  layers.push(["apply"]);
  return layers;
}

export function deploymentSequence(plan: DeploymentPlan): DeploymentStep[] {
  const disabled = new Set(plan.disabled);
  return deploymentLayers(plan).flat().filter(step => !disabled.has(step));
}

type CanvasNode = { id: DeploymentStep; detail: string; state: DeploymentStageState };
type LinkDrag = { kind: "link"; pointer: number; step: DeploymentStep; side: "out" | "in"; replace?: FlowEdge };
type LinkCandidate = { edge: FlowEdge; others: FlowEdge[]; id: DeploymentStep; issue?: string };
type CanvasDrag = LinkDrag
  | { kind: "node"; pointer: number; step: DeploymentStep; start: Point; origin: Point }
  | { kind: "pan"; pointer: number; start: Point; origin: Point };
type MenuTarget = { kind: "node"; step: DeploymentStep } | { kind: "edge"; edge: FlowEdge };
type CanvasMenu = MenuTarget & { at: Point };
const clampZoom = (value: number) => Math.max(.6, Math.min(1.6, Math.round(value * 100) / 100));
const portPoint = (point: Point, side: "in" | "out"): Point => ({ x: point.x + (side === "out" ? cardWidth : 0), y: point.y + cardHeight / 2 });
const linkBend = (from: Point, to: Point) => Math.max(42, Math.abs(to.x - from.x) / 2);
function linkPoint(from: Point, to: Point, t: number): Point {
  const r = 1 - t;
  const bend = linkBend(from, to);
  const chord = 3 * r * t * t + t ** 3;
  return { x: from.x + (to.x - from.x) * chord + 3 * r * t * (r - t) * bend,
    y: from.y + (to.y - from.y) * chord };
}
function linkPath(from: Point, to: Point) {
  const bend = linkBend(from, to);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

export function DeploymentCanvas({ model, actions, percent, running, onFocusStep }: { model: DeploymentModel; actions: Pick<DeploymentActions, "execute" | "savePlan" | "stop">; percent: number; running: boolean; onFocusStep?: (step: DeploymentStep) => void }) {
  const testing = useBenchmarkRunning();
  const testTitle = testing ? benchmarkBlockingReason : undefined;
  const cardPrefix = useId();
  const viewport = useRef<HTMLDivElement>(null), board = useRef<HTMLDivElement>(null), menuRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [fit, setFit] = useState(1);
  const [menu, setMenu] = useState<CanvasMenu>();
  const [motion, setMotion] = useState<{ step: DeploymentStep; at: Point }>();
  const [wire, setWire] = useState<{ drag: LinkDrag; at: Point; candidate?: LinkCandidate }>();
  const [selected, setSelected] = useState<string>();
  const pointer = useRef<CanvasDrag>(undefined);
  const history = useRef<{ undo: FlowGraph[]; redo: FlowGraph[] }>({ undo: [], redo: [] });
  const { plan, run, locked } = model;
  const [, refreshMetrics] = useState(0);
  useEffect(() => {
    if (!run) return;
    const timer = window.setInterval(() => refreshMetrics(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [!!run]);
  const liveMetrics = run ? deploymentMetrics(model.root) : undefined;
  const nodes: CanvasNode[] = steps.filter(id => !isPhase(id) || !model.supportedPhases || model.supportedPhases.includes(id)).map(id => ({
    id, state: run?.steps.includes(id) ? "active" : id !== model.stoppedStep && model.completed.includes(id) ? "done" : "todo",
    detail: id === model.stoppedStep ? "未生成" : id === "scan" ? model.completed.includes(id) ? "已就绪" : "未扫描"
      : id === "text" ? `${model.textCount} 条`
      : id === "image" ? `${model.images.ready} / ${model.images.total}`
      : id === "mosaic" ? `${model.mosaic.count} 张`
      : model.completed.includes("apply") ? "已应用" : model.patch || model.staged ? "待应用" : model.installed ? "已有补丁" : "未生成",
  }));
  const enabled = (id: DeploymentStep) => !plan.disabled.includes(id);
  const validation = validateDeploymentPlan(plan);
  const savedEdgeKeys = new Set(plan.edges.map(edgeKey));
  const bypassEdges = validation.effectiveEdges.filter(edge => !savedEdgeKeys.has(edgeKey(edge)));
  const candidate = wire?.candidate;
  const previewIssues = candidate
    ? candidate.issue ? [candidate.issue] : validateDeploymentPlan({ edges: [...candidate.others, candidate.edge], disabled: plan.disabled }).issues
    : validation.issues;
  const remaining = new Set(steps.filter(id => id === model.stoppedStep || !model.completed.includes(id)));
  releaseSkipped({ ...plan, disabled: plan.disabled.filter(isPhase) }, remaining);
  const canRun = !!model.root && !locked && !run && !running;
  const canApply = !model.applied && (!!model.patch || model.staged || model.patchReady && !deploymentPhases.some(id => enabled(id) && remaining.has(id)));
  const nodePoint = (step: DeploymentStep) => motion?.step === step ? motion.at : plan.positions[step];
  const graph = (): FlowGraph => ({ positions: plan.positions, edges: plan.edges });
  const point = (element: HTMLElement, clientX: number, clientY: number): Point => {
    const rect = element.getBoundingClientRect();
    const scale = rect.width / element.offsetWidth;
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  };
  const zoomAt = (delta: number, at: Point) => setView(previous => {
    const zoom = clampZoom(previous.zoom + delta);
    const x = at.x - viewport.current!.clientWidth / 2;
    const y = at.y - viewport.current!.clientHeight / 2;
    return { zoom, x: x - (x - previous.x) * zoom / previous.zoom, y: y - (y - previous.y) * zoom / previous.zoom };
  });

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setFit(Math.max(.1, Math.min(1.27, (entry.contentRect.width - 24) / fitWidth))));
    observer.observe(el);
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest(".dpl-canvas-tools, .dpl-menu")) return;
      event.preventDefault();
      if (!pointer.current) zoomAt(event.deltaY < 0 ? .1 : -.1, point(el, event.clientX, event.clientY));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => { observer.disconnect(); el.removeEventListener("wheel", wheel); };
  }, []);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);

  function edit(next: FlowGraph) {
    if (locked || !actions.savePlan({ ...plan, ...next })) return false;
    history.current.undo.push(graph());
    history.current.redo = [];
    return true;
  }

  function undoOrRedo(redo: boolean) {
    const { undo, redo: redoStack } = history.current;
    const source = redo ? redoStack : undo;
    const previous = source.at(-1);
    if (!locked && previous && actions.savePlan({ ...plan, ...previous })) {
      (redo ? undo : redoStack).push(graph());
      source.pop();
      setSelected(undefined);
      setMenu(undefined);
    }
  }

  function deleteEdge(edge: FlowEdge) {
    if (edit({ ...graph(), edges: plan.edges.filter(value => edgeKey(value) !== edgeKey(edge)) })) {
      setSelected(undefined);
      setMenu(undefined);
      viewport.current?.focus({ preventScroll: true });
    }
  }

  function connectCandidate(drag: LinkDrag, clientX: number, clientY: number): LinkCandidate | undefined {
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-flow-port]");
    const id = target?.closest<HTMLElement>("[data-flow-node]")?.dataset.flowNode;
    if (!isStep(id)) return undefined;
    const edge = drag.side === "out" ? { from: drag.step, to: id } : { from: id, to: drag.step };
    const others = plan.edges.filter(value => !drag.replace || edgeKey(value) !== edgeKey(drag.replace));
    const issue = target?.dataset.flowPort === drag.side ? "请将输出端接到输入端" : connectionIssue(others, edge);
    return { edge, others, id, issue };
  }

  function beginLink(event: ReactPointerEvent, step: DeploymentStep, side: "out" | "in", replace?: FlowEdge) {
    event.stopPropagation();
    if (locked || pointer.current || event.button !== 0) return;
    event.preventDefault();
    const el = viewport.current!;
    const drag: LinkDrag = { kind: "link", pointer: event.pointerId, step, side, replace };
    pointer.current = drag;
    el.focus({ preventScroll: true });
    el.setPointerCapture(event.pointerId);
    setWire({ drag, at: point(board.current!, event.clientX, event.clientY) });
    if (!replace) setSelected(undefined);
  }

  function begin(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as Element;
    if (pointer.current || event.button !== 0 || target.closest("button, .dpl-canvas-tools, .dpl-menu, .dpl-edge")) return;
    const step = target.closest<HTMLElement>("[data-flow-node]")?.dataset.flowNode;
    if (isStep(step) && locked) return;
    const el = event.currentTarget;
    const start = point(el, event.clientX, event.clientY);
    pointer.current = isStep(step) ? { kind: "node", pointer: event.pointerId, step, start, origin: plan.positions[step] }
      : { kind: "pan", pointer: event.pointerId, start, origin: view };
    el.focus({ preventScroll: true });
    el.setPointerCapture(event.pointerId);
    setSelected(undefined);
  }

  function nodeDragPoint(event: ReactPointerEvent, drag: Extract<CanvasDrag, { kind: "node" }>) {
    const at = point(viewport.current!, event.clientX, event.clientY);
    const scale = fit * view.zoom;
    return { x: drag.origin.x + (at.x - drag.start.x) / scale, y: drag.origin.y + (at.y - drag.start.y) / scale };
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = pointer.current;
    if (drag?.pointer !== event.pointerId) return;
    if (drag.kind === "link") {
      setWire({ drag, at: point(board.current!, event.clientX, event.clientY), candidate: connectCandidate(drag, event.clientX, event.clientY) });
    } else if (drag.kind === "node") {
      setMotion({ step: drag.step, at: nodeDragPoint(event, drag) });
    } else {
      const at = point(event.currentTarget, event.clientX, event.clientY);
      setView(previous => ({ ...previous, x: drag.origin.x + at.x - drag.start.x, y: drag.origin.y + at.y - drag.start.y }));
    }
  }

  function finish(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const drag = pointer.current;
    if (drag?.pointer !== event.pointerId) return;
    pointer.current = undefined;
    setWire(undefined);
    setMotion(undefined);
    if (cancelled) return;
    if (drag.kind === "node") {
      const at = nodeDragPoint(event, drag);
      if (Math.hypot(at.x - drag.origin.x, at.y - drag.origin.y) >= 2) {
        const position = { x: Math.round(at.x), y: Math.round(at.y) };
        edit({ ...graph(), positions: { ...plan.positions, [drag.step]: position } });
      }
    } else if (drag.kind === "link") {
      const target = connectCandidate(drag, event.clientX, event.clientY);
      if (target && !target.issue && (!drag.replace || edgeKey(drag.replace) !== edgeKey(target.edge)) &&
          edit({ ...graph(), edges: [...target.others, target.edge] })) setSelected(edgeKey(target.edge));
    }
  }

  function toggle(id: DeploymentPhase) {
    if (!locked) actions.savePlan({ ...plan, disabled: enabled(id) ? [...plan.disabled, id] : plan.disabled.filter(item => item !== id) });
  }

  function openMenu(target: MenuTarget, x: number, y: number) {
    const el = viewport.current!;
    const at = point(el, x, y);
    const height = target.kind === "edge" ? 70 : 102;
    if (target.kind === "edge") setSelected(edgeKey(target.edge));
    setMenu({ ...target, at: { x: Math.max(0, Math.min(at.x, el.clientWidth - 194)), y: Math.max(0, Math.min(at.y, el.clientHeight - height)) } });
  }

  function canvasKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      if (menu) viewport.current?.focus({ preventScroll: true });
      setMenu(undefined);
      setSelected(undefined);
      return;
    }
    if (locked || pointer.current) return;
    const key = event.key.toLowerCase();
    if (event.ctrlKey && (key === "z" || key === "y")) {
      event.preventDefault();
      undoOrRedo(key === "y" || event.shiftKey);
    } else if (key === "delete" || key === "backspace") {
      const edge = plan.edges.find(edge => edgeKey(edge) === selected);
      if (edge) { event.preventDefault(); deleteEdge(edge); }
    }
  }

  const zoomCenter = (delta: number) => zoomAt(delta, { x: viewport.current!.clientWidth / 2, y: viewport.current!.clientHeight / 2 });
  const quick = run?.mode === "automatic";
  const menuStep = menu?.kind === "node" ? menu.step : undefined;
  const jump = (step: DeploymentStep) => { setMenu(undefined); onFocusStep?.(step); };
  const wireTarget = wire && candidate && !candidate.issue
    ? portPoint(nodePoint(candidate.id), wire.drag.side === "out" ? "in" : "out") : wire?.at;
  const wireStart = wire ? portPoint(nodePoint(wire.drag.step), wire.drag.side) : undefined;

  return <><div className="dpl-canvas" ref={viewport} tabIndex={0} aria-label="生成与应用流程画布"
    onKeyDown={canvasKeys} onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}>
    <div className="dpl-canvas-tools">
      <span className="dpl-mode">{quick ? `一键执行中 · ${run.completed} / ${run.total}`
        : model.stoppedStep ? "已停止 · 单步模式" : "单步模式"}</span>
      <span className="dpl-meter" role="group" aria-label="整体进度">
        <span className="dpl-meter-value">{Math.max(0, Math.min(100, Math.round(percent)))}<i>%</i></span>
        <span className="dpl-meter-caption">{running ? model.progress?.label || "处理中" : model.completed.includes("apply") ? "已完成" : "未完成"}</span>
      </span>
      <div className="dpl-zoom" role="group" aria-label="画布缩放">
        <output>{Math.round(view.zoom * 100)}%</output>
        <button type="button" aria-label="缩小画布" disabled={view.zoom <= .6} onClick={() => zoomCenter(-.1)}>−</button>
        <button type="button" aria-label="放大画布" disabled={view.zoom >= 1.6} onClick={() => zoomCenter(.1)}>＋</button>
        <button type="button" aria-label="复位画布" onClick={() => setView({ x: 0, y: 0, zoom: 1 })}>⤢</button>
      </div>
      {run || model.canStop && model.busyLabel
        ? <button type="button" className="dpl-run-trigger is-stop" disabled={!model.canStop || !!run?.stopping} onClick={actions.stop}>{run?.stopping ? "正在停止…" : "■ 停止"}</button>
        : <button type="button" className="dpl-run-trigger" disabled={testing || !model.root || locked || validation.issues.length > 0} title={testTitle} onClick={actions.execute}>▶ 一键执行</button>}
    </div>
    <div className="dpl-board" ref={board} style={{ transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${fit * view.zoom})` }}>
      <svg className="dpl-rails" width={fitWidth} height={boardHeight} aria-label="阶段依赖">
        {bypassEdges.map(edge => <g key={edgeKey(edge)} className="dpl-edge" data-flow-bypass={edgeKey(edge)} aria-hidden="true">
          <path className="dpl-edge-line" d={linkPath(portPoint(nodePoint(edge.from), "out"), portPoint(nodePoint(edge.to), "in"))} />
        </g>)}
        {[...plan.edges].sort((a, b) => Number(edgeKey(a) === selected) - Number(edgeKey(b) === selected)).map(edge => {
          const key = edgeKey(edge), active = selected === key;
          const from = portPoint(nodePoint(edge.from), "out"), to = portPoint(nodePoint(edge.to), "in");
          const path = linkPath(from, to);
          const sourceHandle = active ? linkPoint(from, to, .16) : from;
          const targetHandle = active ? linkPoint(from, to, .84) : to;
          return <g key={key} className={`dpl-edge${active ? " is-selected" : ""}${!enabled(edge.from) || !enabled(edge.to) ? " is-skipped" : ""}${wire?.drag.replace && key === edgeKey(wire.drag.replace) ? " is-reconnecting" : ""}`}>
            <path className="dpl-edge-hit" d={path} tabIndex={0} role="button" aria-pressed={active} data-flow-edge={key}
              aria-label={`${deploymentStepLabels[edge.from]} → ${deploymentStepLabels[edge.to]}`}
              onClick={event => { event.currentTarget.focus({ preventScroll: true }); setSelected(key); }}
              onFocus={() => setSelected(key)}
              onContextMenu={event => { event.preventDefault(); openMenu({ kind: "edge", edge }, event.clientX, event.clientY); }}
              onKeyDown={event => {
                if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                openMenu({ kind: "edge", edge }, box.x + box.width / 2, box.y + box.height / 2);
              }} />
            <path className="dpl-edge-line" d={path} aria-hidden="true" />
            {active && !locked && <>
              <circle className="dpl-edge-end is-output" data-flow-reconnect="source" cx={sourceHandle.x} cy={sourceHandle.y} r={6}
                onPointerDown={event => beginLink(event, edge.to, "in", edge)} />
              <circle className="dpl-edge-end is-input" data-flow-reconnect="target" cx={targetHandle.x} cy={targetHandle.y} r={6}
                onPointerDown={event => beginLink(event, edge.from, "out", edge)} />
            </>}
          </g>;
        })}
        {wire && wireStart && wireTarget && <path className={`dpl-link-preview${candidate ? candidate.issue ? " is-invalid" : " is-valid" : ""}`}
          d={wire.drag.side === "out" ? linkPath(wireStart, wireTarget) : linkPath(wireTarget, wireStart)} aria-hidden="true" />}
      </svg>
      {nodes.map(node => {
        const pos = nodePoint(node.id), editable = isPhase(node.id);
        const runnable = canRun && node.state === "todo" && enabled(node.id) && (node.id === "scan" ||
          !remaining.has("scan") && !validation.disconnected.includes(node.id) && ready(node.id, plan.edges, remaining) && (node.id !== "apply" || canApply));
        const incomplete = validation.disconnected.includes(node.id);
        const titleId = `${cardPrefix}-${node.id}-title`, detailId = `${cardPrefix}-${node.id}-detail`;
        return <div key={node.id} data-flow-node={node.id} role="group" tabIndex={0} aria-labelledby={titleId} aria-describedby={detailId}
          className={`dpl-card is-${enabled(node.id) ? node.state : "skipped"}${runnable ? " is-runnable" : ""}${incomplete ? " is-incomplete" : ""}${!locked ? " is-movable" : ""}${motion?.step === node.id ? " is-dragging" : ""}`}
          style={{ left: pos.x, top: pos.y, width: cardWidth, height: cardHeight }}
          onContextMenu={event => { event.preventDefault(); openMenu({ kind: "node", step: node.id }, event.clientX, event.clientY); }}
          onKeyDown={event => {
            if (event.target !== event.currentTarget || event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            openMenu({ kind: "node", step: node.id }, box.x + box.width / 2, box.y + box.height / 2);
          }}>
          <b id={titleId}>{deploymentStepLabels[node.id]}</b>
          <span id={detailId} className="dpl-card-detail">{runnable ? "可以执行" : incomplete ? "依赖路径不完整" : enabled(node.id) ? node.state === "active" ? `进行中 · ${node.detail}`
            : node.state === "done" && editable ? `已完成 · ${node.detail}` : node.detail : "已跳过"}</span>
          {node.id !== "scan" && <span className={`dpl-port is-input${candidate?.id === node.id && !candidate.issue && wire?.drag.side === "out" ? " is-target" : ""}`}
            data-flow-port="in" aria-label="输入" />}
          {node.id !== "apply" && <span className={`dpl-port is-output${candidate?.id === node.id && !candidate.issue && wire?.drag.side === "in" ? " is-target" : ""}`}
            data-flow-port="out" aria-label="输出" onPointerDown={event => beginLink(event, node.id, "out")} />}
          {editable && <button type="button" role="switch" aria-label={`启用${deploymentStepLabels[node.id]}`} aria-checked={enabled(node.id)}
            className="dpl-switch" disabled={locked} onClick={() => { if (isPhase(node.id)) toggle(node.id); }} />}
        </div>;
      })}
    </div>
    <div className="dpl-canvas-hint">
      <strong className={previewIssues.length ? "is-invalid" : ""} role="status">
        {candidate ? "连线预览" : "排布校验"} · {previewIssues.length ? previewIssues.join("。") : "依赖完整"}
      </strong>
      <span>{selected ? "拖动选中连线的端点以重连，按 Delete 删除" : "从输出拖到输入建立依赖 · 滚轮缩放 · 拖动空白处平移"}</span>
    </div>
    {menu && <div className="dpl-menu" ref={menuRef} role="menu" style={{ left: menu.at.x, top: menu.at.y }}
      aria-label={menuStep ? deploymentStepLabels[menuStep] : "依赖连线"}>
      {menu.kind === "edge" ? <>
        <strong>{deploymentStepLabels[menu.edge.from]} → {deploymentStepLabels[menu.edge.to]}</strong>
        <button type="button" role="menuitem" disabled={locked} onClick={() => deleteEdge(menu.edge)}>删除连线</button>
      </> : <>
        <strong>{deploymentStepLabels[menu.step]}</strong>
        <button type="button" role="menuitem" disabled={!onFocusStep || !!run} onClick={() => jump(menu.step)}>跳转到该步骤</button>
        {isPhase(menu.step) && <button type="button" role="menuitem" disabled={locked} onClick={() => { if (isPhase(menu.step)) toggle(menu.step); setMenu(undefined); }}>
          {enabled(menu.step) ? "关闭该阶段" : "启用该阶段"}
        </button>}
      </>}
    </div>}
  </div>
  {run?.steps.map(step => {
    const candidates: (keyof DeploymentMetrics)[] = step === "scan" ? ["scan", "scanImages"]
      : step === "text" ? ["generate"] : step === "image" ? ["generateImages"]
      : step === "mosaic" ? ["mosaic", "generateMosaic"] : ["apply", "applyImages", "applyMosaic"];
    const measured = candidates.map(stage => liveMetrics?.[stage]).find(meter => meter?.started !== undefined);
    return <section key={step} className="dpl-panel" aria-label={deploymentStepLabels[step] + "运行指标"}>
      <h4 className="game-step-metrics-label">{deploymentStepLabels[step]} · 进行中</h4>
      <StepRunningMetrics measured={measured} parameters={[
        { scope: "task", label: "部署阶段", value: deploymentStepLabels[step] }, { scope: "task", label: "项目", value: model.root },
        { scope: "task", label: "执行方式", value: run.mode === "automatic" ? "一键执行" : "单步执行" },
      ]} />
    </section>;
  })}
  </>;
}


const throughputStages = [
  ["mosaic", "筛选与重绘", "张"],
  ["generate", "生成补丁", "个"],
  ["generateImages", "生成译图", "张"],
  ["generateMosaic", "生成去码补丁", "张"],
  ["apply", "应用写入", "个"],
  ["applyImages", "写入译图", "张"],
  ["applyMosaic", "写入去码图", "张"],
] as const;

export function DeploymentThroughput({ metrics }: { metrics?: DeploymentMetrics }) {
  const rates = throughputStages.flatMap(([stage, label, unit]) => {
    const rate = formatFlowThroughput(metrics?.[stage], unit);
    return rate ? [{ stage, label, rate }] : [];
  });
  const mosaic = metrics?.mosaic;
  const detectorMs = mosaic?.wallTiming?.detectorMs;
  const workflowMs = mosaic?.timing?.workflowMs;
  const seconds = (ms: number) => (ms / 1000).toFixed(1) + " 秒";
  const modelLines = Object.values(mosaic?.models ?? {}).flatMap(model => model.serviceTiming
    ? [{ name: model.model, lanes: model.concurrency, timing: modelServiceTimingLines(model.serviceTiming, model.requests, seconds).join(" · ") }] : []);
  return rates.length || detectorMs !== undefined || workflowMs !== undefined || modelLines.length > 0
    ? <div className="game-flow-stage-throughput" role="group" aria-label="生成与应用性能">
    {rates.map(({ stage, label, rate }) => <span key={stage}>{label} <b>{rate}</b></span>)}
    {detectorMs !== undefined && <span>检测推理 <b>{seconds(detectorMs)}</b></span>}
    {workflowMs !== undefined && <span>ComfyUI 执行 <b>{seconds(workflowMs)}</b></span>}
    {modelLines.map(({ name, lanes, timing }) => <span key={name + ":" + lanes}>{name.split("/").at(-1)} · {timing}</span>)}
  </div> : null;
}

export function UnityDeploymentPanel({ model, actions, mosaic, onFocusStep, onFlowChange }: {
  model: DeploymentModel;
  actions: DeploymentActions;
  mosaic: ReactNode;
  onFocusStep?: (step: DeploymentStep) => void;
  onFlowChange?: (flow: DeploymentFlow) => void;
}) {
  const { edges, disabled } = model.plan;
  const testing = useBenchmarkRunning();
  const testTitle = testing ? benchmarkBlockingReason : undefined;
  useLayoutEffect(() => { onFlowChange?.({ edges, disabled }); }, [onFlowChange, model.root, edges, disabled]);

  const plan = model.fontPlan;
  const missing = plan?.missing.length ?? 0;
  const running = model.progress?.state === "active";
  const textReady = model.textCount;
  const fontChecked = !!plan?.fontChecked;

  const enabled = (phase: DeploymentPhase) => !model.plan.disabled.includes(phase);
  const generate = (phase: DeploymentPhase) => <button type="button" className="dpl-btn" disabled={testing || !enabled(phase) || model.locked || !model.completed.includes("scan")} title={testTitle} onClick={() => actions.generatePhase(phase)}>生成</button>;

  const percent = model.progress?.percent ?? (model.completed.includes("apply") ? 100 : model.patch ? 80 : 0);

  return (
    <div className={`dpl${running ? " is-running" : ""}`}>
      <DeploymentCanvas key={model.root} model={model} actions={actions} percent={percent} running={running} onFocusStep={onFocusStep} />

      <div><StandaloneGameFlowCard stepId="apply" title="生成与应用" state={running ? "running" : model.cardActivity?.state ?? (model.applied ? "done" : "pending")}
        label={model.progress?.label ?? model.cardActivity?.label ?? (model.applied ? "已应用" : model.patch ? "已生成" : "未生成")}
        elapsed={model.cardActivity?.elapsed} actions={model.cardActivity?.actions}
        progress={{ ...model.cardActivity?.progress,
          percent: model.run?.total ? 100 * model.run.completed / model.run.total : model.progress?.percent ?? model.cardActivity?.progress?.percent,
          current: model.run?.completed ?? model.cardActivity?.progress?.current,
          total: model.run?.total ?? model.cardActivity?.progress?.total,
          sample: model.progress?.detail }} details={model.cardActivity?.details}
        performance={<GameFlowPerformance measured={model.applied || model.run?.steps.includes("apply") ? model.metrics?.apply : model.metrics?.generate} />}
        body={<div className="dpl-grid">
        <section className="dpl-panel" aria-label="文本补丁">
          <div className="dpl-panel-head">
            <h4>文本补丁</h4>
            <span className="dpl-tag">{textReady} 条</span>
          </div>
          <div className="dpl-field">
            <label htmlFor="dpl-font">替换字体</label>
            <div className="dpl-input-row">
              <input id="dpl-font" className="dpl-input" readOnly value={model.fontPath === ":original:" ? "" : model.fontName} placeholder="未替换 · 选字体" />
              <button className="dpl-btn" disabled={model.locked} onClick={actions.chooseFont}>选择</button>
            </div>
            {model.fontPath && <button className="dpl-link" disabled={model.locked} onClick={actions.clearFont}>取消替换</button>}
          </div>
          <div className="dpl-field">
            <label htmlFor="dpl-extra">补充字符</label>
            <div className="dpl-input-row">
              <input id="dpl-extra" className="dpl-input" value={model.extraCharacters} disabled={model.locked} placeholder="角色名等动态内容" onChange={event => actions.setExtraCharacters(event.currentTarget.value)} />
              <button className="dpl-btn" disabled={testing || model.locked} title={testTitle} onClick={actions.checkFontPlan}>检查字库</button>
            </div>
          </div>
          <dl className="dpl-stats">
            <div><dt>字符集</dt><dd>{plan ? plan.characterCount : "—"}</dd></div>
            <div><dt>缺字</dt><dd className={missing ? "is-warn" : undefined}>{plan ? (fontChecked ? missing : "原字体") : "—"}</dd></div>
            <div><dt>替换字体</dt><dd>{model.patch ? model.patch.fontReplacements : model.fontPath ? 1 : 0}</dd></div>
          </dl>
          <div className="dpl-panel-foot">{generate("text")}</div>
          {plan && <div className="dpl-plan">
            <p>{plan.fontChecked ? `${plan.missing.length} 个缺字` : "保留游戏原字体"} · 译文 {plan.translatedReferences} 处 · 原文 {plan.originalReferences} 处</p>
            {plan.requirements.map(item => <p key={item} className="dpl-plan-note">{item}</p>)}
            {missing > 0 && <details className="dpl-glyph-details">
              <summary>查看 {missing} 个缺字</summary>
              <ul className="dpl-glyphs">
              {plan.missing.slice(0, 12).map(code => {
                const character = String.fromCodePoint(code);
                const references = countMissingGlyphEntries(model.entries, [code]).get(character) ?? 0;
                return <li key={code}>
                  <code>{character}</code>
                  <span>U+{code.toString(16).toUpperCase().padStart(4, "0")}</span>
                  <small>{references ? `${references} 条` : "动态字形"}</small>
                  {references > 0 && <button className="dpl-link" onClick={() => actions.locateText(character)}>定位</button>}
                </li>;
              })}
              {plan.missing.length > 12 && <li className="dpl-glyphs-more">另有 {plan.missing.length - 12} 个缺字</li>}
              </ul>
            </details>}
            <div className="dpl-plan-actions">
              <button className="dpl-link" onClick={actions.openReport}>检查报告</button>
              <button className="dpl-link" onClick={actions.openGlyphFolder}>字符集目录</button>
            </div>
          </div>}
        </section>

        <section className="dpl-panel" aria-label="图片补丁">
          <div className="dpl-panel-head">
            <h4>图片补丁</h4>
            <span className="dpl-tag">{model.images.ready}/{model.images.total} 张</span>
          </div>
          <dl className="dpl-stats dpl-stats-stack">
            <div><dt>可用译图</dt><dd>{model.images.ready}</dd></div>
            <div><dt>图片总数</dt><dd>{model.images.total}</dd></div>
            <div><dt>已译比例</dt><dd>{model.images.total ? (model.images.ready / model.images.total * 100).toFixed(1) + "%" : "—"}</dd></div>
          </dl>
          <p className="dpl-hint">
            {model.images.total === 0
              ? "当前工程没有需要嵌字的图片，补丁只写入文本与字体。"
              : model.images.ready === 0
                ? "译图尚未生成，可在「图片翻译」中处理后加入补丁。"
                : `将写入 ${model.images.ready} 张译图，与文本补丁一起生成。`}
          </p>
          <div className="dpl-panel-foot">
            <button className="dpl-link" onClick={actions.openPatchFolder} disabled={!model.patch}>补丁目录</button>
            {generate("image")}
          </div>
        </section>

        <section className="dpl-panel" aria-label="去码补丁">
          <div className="dpl-panel-head"><h4>去码补丁</h4><span className="dpl-tag">{enabled("mosaic") ? model.mosaic.count + " 张" : "已跳过"}</span></div>
          <dl className="dpl-stats dpl-stats-stack">
            <div><dt>已选去码图</dt><dd>{model.mosaic.enabled ? model.mosaic.count : "未启用"}</dd></div>
            <div><dt>覆盖区域</dt><dd>{model.mosaic.count ? "已纳入选中图片" : "—"}</dd></div>
          </dl>
          <p className="dpl-hint">{enabled("mosaic") ? "纳入的去码图随补丁一起应用。" : "此阶段关闭，本次不写入去码图。"}</p>
          <div className="dpl-panel-foot">{generate("mosaic")}</div>
        </section>

        <section className="dpl-panel dpl-panel-apply" aria-label="应用到游戏">
          <div className="dpl-panel-head">
            <h4>应用到游戏</h4>
            <span className={`dpl-tag${model.applied ? " is-ok" : ""}`}>{model.applied ? "已应用" : model.installed ? "已安装" : "未安装"}</span>
          </div>
          <div className="dpl-path" title={model.root}>{model.root || "尚未选择游戏目录"}</div>
          <p className="dpl-hint">
            {model.applied ? "补丁已写入游戏，启动后检查实际显示。" : model.patch ? "生成完成，关闭游戏后应用。" : "先生成补丁，再应用到游戏。"}
          </p>
          <div className="dpl-actions">
            {model.applied
              ? <>
                <button className="dpl-btn dpl-btn-primary" disabled={model.locked} onClick={actions.launch}>启动游戏</button>
                <button className="dpl-btn" disabled={testing || model.locked} title={testTitle} onClick={actions.reapply}>重新应用</button>
              </>
              : <button className="dpl-btn dpl-btn-primary" disabled={testing || !model.patch || model.locked} title={testTitle} onClick={actions.apply}>应用到游戏</button>}
            <button className="dpl-btn dpl-btn-danger" disabled={testing || !model.installed || model.locked} title={testTitle} onClick={actions.uninstall}>卸载</button>
          </div>
          {model.applied && model.installed && model.patch && actions.removeLayer && <div className="dpl-actions">
            {deploymentPhases.filter(phase => phase === "text" ? model.patch!.entries > 0 || model.patch!.fontReplacements > 0
              : phase === "image" ? !!model.patch!.images : !!(model.patch as UnityPatch & {mosaicImages?: number}).mosaicImages)
              .map(phase => <button key={phase} className="dpl-btn" disabled={testing || model.locked} title={testTitle} onClick={()=>actions.removeLayer?.(phase)}>卸载{phase === "text" ? "文本" : phase === "image" ? "译图" : "去码图"}</button>)}
          </div>}
          <div className="dpl-mosaic">
            <span>第三方去码补丁</span>
            {mosaic}
          </div>
        </section>
      </div>} /></div>

      <DeploymentThroughput metrics={model.metrics} />

      <footer className="dpl-foot">
        <p className="dpl-foot-note">
          {model.patch
            ? `已生成 ${model.patch.files} 个文件 · ${model.patch.entries} 条译文 · ${model.patch.images ?? 0} 张译图${model.applied ? " · 已写入游戏" : ""}`
            : `本次将写入 ${enabled("text") ? textReady : 0} 条译文 · ${enabled("image") ? model.images.ready : 0} 张译图 · ${enabled("mosaic") ? model.mosaic.count : 0} 张去码图`}
        </p>
      </footer>
    </div>
  );
}
