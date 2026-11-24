import { MosaicScreeningFields } from "./MosaicScreeningFields";
import { useRef, type CSSProperties, type ReactNode } from "react";
import type { BenchmarkState } from "../../benchmark/benchmarkRunner";
import { mosaicModelLabels, mosaicRefineConcurrencyChoices, type MosaicModel, type MosaicSettings } from "../../gameMosaic";
import { gameDuration, type StepPerformance } from "../../gameModelPerformance";
import { GameFlowCard, GameFlowNumberChip, GameFlowParameterGroup, GameFlowParameterValue, useGameFlowExpansion } from "../GameFlowCard";
import { GameFlowPerformance } from "../GameFlowSequence";
import { gameProgressLabels } from "../GameStepProgress";
import { ModelFilterSelect, type ModelFilter } from "../ModelFilterSelect";
import type { MosaicStep, StepRun } from "./mosaicWorkbenchTypes";

type Props = {
  paneVisible: boolean;
  hiddenStyle?: CSSProperties;
  busy: boolean;
  aborting?: boolean;
  actionsDisabled: boolean;
  onStop: (step: MosaicStep) => void;
  preferences: MosaicSettings;
  changePreferences: (patch: Partial<MosaicSettings>) => void;
  detectorLabels: Record<MosaicSettings["detector"], string>;
  reviewModels: string[];
  testing: boolean;
  parametersLocked: boolean;
  testTitle?: string;
  benchmarkProgress?: BenchmarkState;
  measurements: Record<MosaicStep, { formalMeasurement: StepPerformance; measured: StepPerformance }>;
  now: number;
  progress: string;
  statusLineStep?: MosaicStep;
  error: string;
  screen: {
    status: StepRun;
    summary: string;
    action: string;
    targetCount: number;
    screenedCount: number;
    remainingCount: number;
    otherDetectorCount: number;
    canClear: boolean;
    detectorFile?: File;
    changeScope: (scope: MosaicSettings["scope"]) => void;
    chooseDetectorFile: (file?: File) => void;
    useBuiltInDetector: () => void;
    start: (restart?: boolean) => void;
    clear: () => Promise<void>;
  };
  refine: {
    status: StepRun;
    targetCount: number;
    pendingCount: number;
    reviewedCount: number;
    wasStopped: boolean;
    canClear: boolean;
    modelFilter: ModelFilter;
    setModelFilter: (filter: ModelFilter) => void;
    guardFilter: ModelFilter;
    setGuardFilter: (filter: ModelFilter) => void;
    start: (restart?: boolean) => void;
    clear: () => Promise<void>;
  };
  redraw: {
    status?: StepRun;
    targetCount: number;
    groupTargetCount: number;
    automaticTargetCount: number;
    skipped: string;
    remainingCount: number;
    paused: boolean;
    canClear: boolean;
    batchReason?: string;
    groupReason?: string;
    automaticReason?: string;
    referenceFlow?: { detail: string; label?: string; reason?: string; run?: () => void };
    start: () => void;
    startGroup: () => void;
    startAutomatic: () => void;
    clear: () => Promise<void>;
  };
  unresolvedRefineFailures: number;
  retryCount: number;
};

export function MosaicStepCards({ paneVisible, hiddenStyle, busy, aborting, actionsDisabled,
  onStop, preferences, changePreferences, detectorLabels, reviewModels, testing, parametersLocked, testTitle, benchmarkProgress,
  measurements, now, progress, statusLineStep, error, screen, refine, redraw, unresolvedRefineFailures, retryCount }: Props) {
  const { scope, detector: detectorKind, model, steps, protect } = preferences;
  const benchmarkSteps = { screen: "mosaicScreen", refine: "mosaicRefine", redraw: "mosaicRedraw" } as const;
  const expansion = useGameFlowExpansion();
  const detectorInput = useRef<HTMLInputElement>(null);
  const refineSelection = "已勾选 " + refine.targetCount.toLocaleString() + " 张";
  const redrawSelection = "当前列表可重绘 " + redraw.targetCount.toLocaleString() + " 张";
  const stage = { screen, refine, redraw };
  const order = ["screen", "refine", "redraw"] as const;
  const defaultStep = order.find(id => stage[id].status?.state === "running") ??
    order.find(id => benchmarkProgress?.state === "running" && benchmarkProgress.step === benchmarkSteps[id]) ??
    order.find(id => stage[id].status?.state !== "done" && stage[id].status?.state !== "skipped" &&
      (id !== "refine" || preferences.refine !== false && refine.pendingCount > 0)) ??
    "redraw";
  const stepCard = (id: MosaicStep, title: string, actions: ReactNode, settings: ReactNode) => {
    const status = stage[id].status;
    const state = status?.state || "pending";
    const running = state === "running";
    const screeningMethodChanged = id === "screen" && state === "pending" && screen.otherDetectorCount > 0;
    const failed = status?.failed ?? 0;
    const processed = status && Math.min(status.total, status.completed + (id === "refine" ? failed : 0));
    const percent = status?.total && processed !== undefined ? processed / status.total * 100 : undefined;
    const { measured } = measurements[id];
    const elapsed = measured.taskId ? measured.elapsedMs : status?.elapsed ??
      (status?.started == null ? undefined : now - status.started);
    const expanded = expansion.isExpanded(benchmarkSteps[id], id === defaultStep);
    const models = Object.values(measured.models);
    const recordedModelNames = status?.parameters?.filter(parameter => parameter.label.endsWith("模型"))
      .map(parameter => parameter.value);
    const recordedLanes = status?.parameters?.find(parameter => parameter.label.endsWith("并发"))?.value;
    const benchmark = !running && benchmarkProgress?.step === benchmarkSteps[id] ? benchmarkProgress : undefined;
    const statusLine = !benchmark && statusLineStep === id ? progress : undefined;
    const sample = running && id === "refine" ? statusLine?.match(/^.+? · (.+) · (?:候选区域 \d+\/\d+|整图) · 等待模型返回$/)?.[1] : undefined;
    const batchElapsed = status?.batchElapsed ?? (status?.batchStarted == null ? undefined : now - status.batchStarted);
    const remainingMs = running && status?.processed && batchElapsed != null && batchElapsed > 0 && processed != null
      ? batchElapsed / status.processed * Math.max(0, status.total - processed) : undefined;
    const successRate = id === "refine" && status && status.total > 0 ? 100 * status.completed / status.total : undefined;
    const unresolved = id === "refine" ? unresolvedRefineFailures : 0;
    const retrying = running && retryCount > 0;
    const refineSummary = id === "refine" && status && state !== "pending" ? [
      "成功 " + status.completed + " 张", "本轮失败 " + failed + " 张",
      unresolved > 0 ? "未解决 " + unresolved + " 张" + (retrying ? "（重试中）" : "（待处理）") : undefined,
    ].filter(Boolean).join(" · ") : undefined;
    const device = status?.device;
    const headerSummary = id === "screen" ? (
      <span title={device?.reason}>{device && !screen.detectorFile
        ? device.kind === "gpu" ? "GPU（WebGPU）" : "CPU"
        : screen.summary}</span>
    ) : id === "refine" ? (
      !benchmark && status?.prepared != null
        ? "候选已准备 " + status.prepared.toLocaleString() + " / " + status.total.toLocaleString()
        : refineSelection
    ) : redrawSelection;
    return <li key={id} style={{ minInlineSize: 0 }}><GameFlowCard title={title} state={state} benchmark={benchmark} current={running || !!benchmark}
      groupedParameters headerSummary={headerSummary}
      disclosure={{ expanded, toggle: () => expansion.setExpanded(benchmarkSteps[id], !expanded) }}
      label={screeningMethodChanged ? "待按当前方式筛选" : gameProgressLabels[state]}
      elapsed={elapsed != null && !screeningMethodChanged ? gameDuration(elapsed) : undefined}
      progress={{ sample, current: processed, total: status?.total || undefined,
        completed: status?.completed, unit: "张", percent, remainingMs, successRate,
        configuration: running && status?.parameters?.length ? { current: 1, total: 1 } : undefined }}
      statusLine={statusLine}
      resultLine={unresolved > 0 ? unresolved.toLocaleString() + " 张失败待处理" : undefined}
      foldedSummary={{
        failed: Math.max(failed, unresolved),
        models: recordedModelNames?.length ? recordedModelNames : models.map(model => model.model),
        concurrency: Number(recordedLanes) || Math.max(0, ...models.map(model => model.concurrency)),
      }}
      runningParameters={status?.parameters} parametersLocked={busy || testing || parametersLocked}
      performance={expanded &&
        <GameFlowPerformance measured={benchmark ? benchmark.performance : measured} />}
      details={!benchmark && (screeningMethodChanged || refineSummary || id !== "refine" && failed > 0) && <small className="game-flow-model-rates">
        {screeningMethodChanged && <span>其他筛选方式已有 {screen.otherDetectorCount} 张</span>}
        {refineSummary && <span className="game-flow-refine-summary">{refineSummary}</span>}
        {id !== "refine" && failed > 0 && <span>失败 {failed} 张</span>}
      </small>}
      actions={running ? <button type="button" className="unity-btn game-flow-start" disabled={aborting} onClick={() => onStop(id)}>
        {aborting ? "正在中止" : "中止"}</button> : actions}
      configuration={expanded && settings} /></li>;
  };
  const screenRuntime = <>
        <label>筛选范围<select aria-label="筛选范围" value={scope} disabled={busy} onChange={event => screen.changeScope(event.target.value as typeof scope)}>
          <option value="scenes">场景图片</option><option value="all">全部图片</option>
        </select></label>
        <label>筛选方式<select aria-label="打码筛选方式" value={detectorKind} disabled={busy} onChange={event => changePreferences({ detector: event.target.value as typeof detectorKind })}>
          <option value="grid">{detectorLabels.grid}</option><option value="anime">{detectorLabels.anime}</option>
        </select></label>
  </>;
  const screenConcurrency = <GameFlowNumberChip label="处理并发" ariaLabel="图片处理并发" choices={[1, 2, 4]}
    value={preferences.concurrency ?? 2} disabled={busy} onChange={concurrency => changePreferences({ concurrency })} />;
  const screenAction = screen.screenedCount > 0 && screen.remainingCount > 0 &&
    <button type="button" className="unity-btn is-secondary" disabled={testing || actionsDisabled} title={testTitle}
          onClick={() => screen.start(true)}>重新筛选已勾选图片</button>;
  const customDetector = <>
    <label><input type="checkbox" role="switch" checked={!!screen.detectorFile} disabled={busy}
      onChange={event => event.target.checked ? detectorInput.current?.click() : screen.useBuiltInDetector()} />自定义定位 ONNX</label>
    <input ref={detectorInput} type="file" accept=".onnx" hidden disabled={busy} onChange={event => {
      const file = event.target.files?.[0];
      if (file) screen.chooseDetectorFile(file);
      event.target.value = "";
    }} />
    {screen.detectorFile && <button type="button" className="unity-btn is-secondary" disabled={busy}
      onClick={() => detectorInput.current?.click()}>更换模型文件</button>}
  </>;
  return <div className="game-mosaic-controls game-flow" hidden={!paneVisible} style={hiddenStyle}>
    <div className="game-flow-list"><ol>
      {stepCard("screen", "筛选打码图片", <>
        <button type="button" className="unity-btn unity-btn-primary game-flow-start" disabled={testing || actionsDisabled || !screen.targetCount} title={testTitle}
          onClick={() => screen.start()}>{screen.action}</button>
        {screen.canClear && <button type="button" className="unity-btn game-flow-clear" disabled={actionsDisabled}
          onClick={() => void screen.clear()}>清理</button>}
      </>, detectorKind === "grid" ? <>
        <GameFlowParameterGroup kind="scope" title="范围与方式">{screenRuntime}</GameFlowParameterGroup>
        <GameFlowParameterGroup kind="runtime" title="运行"><div className="game-flow-chip-row">{screenConcurrency}</div></GameFlowParameterGroup>
        <GameFlowParameterGroup kind="actions">{screenAction}</GameFlowParameterGroup>
      </> : <MosaicScreeningFields value={preferences.screening} disabled={busy}
        onChange={screening => changePreferences({ screening })}
        groups={{ scope: screenRuntime, concurrency: screenConcurrency, actions: screenAction, customDetector }} />)}
      {stepCard("refine","复筛打码图片", <>
        <button type="button" className="unity-btn game-flow-start" disabled={testing || actionsDisabled || !refine.targetCount} title={testTitle}
          onClick={()=>refine.start(!refine.pendingCount)}>{!refine.pendingCount&&refine.targetCount?"重新复筛":refine.reviewedCount||refine.wasStopped?"继续复筛":"开始复筛"}</button>
        {refine.canClear && <button type="button" className="unity-btn game-flow-clear"
          aria-label="清理复筛" disabled={actionsDisabled} onClick={() => void refine.clear()}>清理</button>}
      </>,<>
        <GameFlowParameterGroup kind="models" title="模型">
          <div className="game-mosaic-model-field">
            <span>候选区域</span>
            <ModelFilterSelect label="候选区域推理模型" value={preferences.refineModel || "qwen3.5:latest"}
              models={[...new Set(["qwen3.5:latest",...reviewModels])]} disabled={busy}
              filter={refine.modelFilter} setFilter={refine.setModelFilter}
              onChange={model=>changePreferences({refineModel:model})} />
          </div>
          <div className="game-mosaic-model-field">
            <span>纹理复核</span>
            <ModelFilterSelect label="纹理与漏检复核模型" value={preferences.refineGuardModel || "qwen3-vl:8b-instruct"}
              models={[...new Set(["qwen3-vl:8b-instruct",...reviewModels])]} disabled={busy}
              filter={refine.guardFilter} setFilter={refine.setGuardFilter}
              onChange={model=>changePreferences({refineGuardModel:model})} />
          </div>
        </GameFlowParameterGroup>
        <GameFlowParameterGroup kind="runtime" title="运行">
          <div className="game-flow-chip-row">
            <GameFlowNumberChip label="复筛并发" choices={mosaicRefineConcurrencyChoices} value={preferences.refineConcurrency ?? 1}
              disabled={busy} onChange={refineConcurrency => changePreferences({ refineConcurrency })} />
            <GameFlowParameterValue label="手动复筛范围" value={refineSelection} />
          </div>
          <div className="game-flow-chip-row">
            <label data-tooltip="自动流程对未检出打码区域的图片再用大模型整图补查，可能增加整批耗时。">
              <input type="checkbox" role="switch" checked={!!preferences.refineIncludeMissed} disabled={busy}
                onChange={e => changePreferences({ refineIncludeMissed: e.target.checked })} />补查未发现</label>
            <label data-tooltip="自动流程把初筛候选区域交给模型核对。关闭后可在工作台逐张确认。">
              <input type="checkbox" role="switch" checked={preferences.refine !== false} disabled={busy}
                onChange={e => changePreferences({ refine: e.target.checked })} />执行视觉复筛</label>
          </div>
          <p className="hint">推理模型核对检测候选，复核模型检查纹理补检和未检出图片。按模型分批处理，思考模型逐图复筛耗时较长。</p>
        </GameFlowParameterGroup>
        <GameFlowParameterGroup kind="actions">
          {refine.reviewedCount > 0 && refine.pendingCount > 0 && <button type="button" className="unity-btn is-secondary"
            disabled={testing || actionsDisabled} onClick={() => refine.start(true)}>重新复筛已勾选图片</button>}
        </GameFlowParameterGroup>
      </>)}
      {stepCard("redraw", "重绘打码区域", <>
        <button type="button" className="unity-btn game-flow-start" disabled={!!redraw.batchReason} title={testTitle}
          data-tooltip={redraw.batchReason ?? (redraw.paused ? "按上一次重绘的图片及配置继续" :
            ["重绘当前列表中已勾选且已就绪的图片", redraw.skipped].filter(Boolean).join("\n"))}
          onClick={redraw.start}>
          {redraw.paused ? "继续重绘 · 剩余 " + redraw.remainingCount : "重绘列表已勾选 · " + redraw.targetCount} 张
        </button>
        {!redraw.paused && <>
          <button type="button" className="unity-btn is-secondary" disabled={!!redraw.groupReason}
            data-tooltip={redraw.groupReason ?? "重绘当前图片所在的画风组"} onClick={redraw.startGroup}>
            重绘本组所选 · {redraw.groupTargetCount} 张
          </button>
          <button type="button" className="unity-btn is-secondary" disabled={!!redraw.automaticReason}
            data-tooltip={redraw.automaticReason ?? "当前列表中每组首张无参考重绘，再用该候选重绘同组选中图片"}
            onClick={redraw.startAutomatic}>自动按组重绘 · {redraw.automaticTargetCount} 张</button>
        </>}
        {redraw.canClear && <button type="button" className="unity-btn game-flow-clear"
          aria-label="清理重绘" disabled={actionsDisabled} onClick={() => void redraw.clear()}>清理</button>}
      </>, <>
        <GameFlowParameterGroup kind="generation" title="生成">
          <label className="game-flow-field-wide">工作流<select aria-label="去码模型工作流" value={model} disabled={busy} onChange={event => {
            const next = event.target.value as MosaicModel; changePreferences({ model: next, steps: next === "turbo" ? 8 : 20 });
          }}>
            <option value="turbo">{mosaicModelLabels.turbo}</option><option value="2511">{mosaicModelLabels["2511"]}</option>
          </select></label>
          <div className="game-flow-chip-row">
            {model === "2511" && <GameFlowNumberChip label="步数" min={1} max={100} value={steps} disabled={busy}
              onChange={steps => changePreferences({ steps })} />}
            <GameFlowParameterValue label="重绘范围" value={redraw.paused
              ? "上次选择 · 剩余 " + redraw.remainingCount.toLocaleString() + " 张" : redrawSelection} />
          </div>
          {!redraw.paused && redraw.skipped && <p className="hint">{redraw.skipped}</p>}
          <div className="game-flow-chip-row"><label><input type="checkbox" role="switch" checked={protect} disabled={busy}
            onChange={event => changePreferences({ protect: event.target.checked })} />保护已识别文字</label></div>
        </GameFlowParameterGroup>
        {redraw.referenceFlow && <GameFlowParameterGroup kind="generation" title="本组参考重绘">
          <p className="hint">{redraw.referenceFlow.detail}</p>
          {redraw.referenceFlow.label && <button type="button" className="unity-btn is-secondary"
            disabled={!!redraw.referenceFlow.reason} data-tooltip={redraw.referenceFlow.reason}
            onClick={redraw.referenceFlow.run}>{redraw.referenceFlow.label}</button>}
        </GameFlowParameterGroup>}
      </>)}
    </ol></div>
    {(progress && !statusLineStep || error) && <div className="game-flow-progress">
      {progress && !statusLineStep && <p className="game-mosaic-progress" role="status">{progress}</p>}
      {error && <p className="game-mosaic-error" role="alert">{error}</p>}
    </div>}
  </div>;
}
