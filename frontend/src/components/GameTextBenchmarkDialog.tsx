import { MosaicScreeningFields } from "./game-mosaic/MosaicScreeningFields";
import { allBenchmarkRecordStatuses, BenchmarkRecordStatusFilter, BenchmarkRecordStepFilter,
  matchesBenchmarkRecordStatus, matchesBenchmarkRecordStep, type BenchmarkRecordStep } from "./BenchmarkRecordFilters";
import { BuildSpeedTest } from "./BuildSpeedTest";
import { TrainingDatasetsPage } from "./TrainingDatasetsPage";
import { writeTrainingDatasetFile } from "../benchmark/trainingDatasets";
import { benchmarkRoundChanges } from "../benchmark/benchmarkRoundPlan";
import { readImageBenchmarkDetails, type ImageBenchmarkDetails } from "../benchmark/imageBenchmarkHistory";
import { scoreMosaicComparisonRuns } from "../benchmark/benchmarkMosaicReport";
import { mosaicStatusLabels } from "../gameMosaicStatus";
import { readMosaicTaskPlan } from "../benchmark/benchmarkTaskPlan";
import { openBenchmarkReview, pickRunReference, runReferenceKey } from "../gameAuxWindows";
import { formalHistoryResults, formalRecordProject, formalRecordStep } from "../benchmark/formalRunHistory";
import { ImageSampleSetBrowser } from "./ImageSampleSetBrowser";
import { defaultModelFilter, ModelFilterSelect, usePersistedModelFilter } from "./ModelFilterSelect";
import { createMosaicRefinePresetConfigs, mosaicBenchmarkSteps, type MosaicBenchmarkStep } from "../gameMosaicBenchmark";
import { mosaicDefaultSteps, mosaicModelChoices, mosaicRefineConcurrencyChoices, readMosaicSettings, type MosaicSettings } from "../gameMosaic";
import { LOCAL_REFINE_MODELS } from "../gameImageScreening";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { benchmarkChannelName, benchmarkHistoryForRecords, requestBenchmarkWindow, type BenchmarkQueueArgument, type BenchmarkQueueCommand } from "../gameBenchmarkWindow";
import { benchmarkRunner, benchmarkSampleCounts, benchmarkTargetLabel, emptyBenchmarkSnapshot, formalBlockingReason, isMosaicBenchmarkStep as isMosaicStep, type BenchmarkTarget as Target, canEditBenchmarkTask, type BenchmarkInput, type BenchmarkJob, type BenchmarkRequest, type BenchmarkSnapshot, type BenchmarkTaskConfig, type BenchmarkTaskDecision } from "../benchmark/benchmarkRunner";
export type { BenchmarkInput, BenchmarkImageSource } from "../benchmark/benchmarkRunner";
import { benchmarkRoles, groupBenchmarkTasks, inspectBenchmarkSample, readGameBenchmarkHistory, readGameFormalHistory, type ArchivedBenchmarkRef, type BenchmarkConfig, type BenchmarkResult, type BenchmarkSample } from "../gameTextBenchmark";
import { gameDuration, modelConcurrency } from "../gameModelPerformance";
import type { UnityEntry } from "../unityOffline";
import { imageBenchmarkSteps, type ImageBenchmarkStep, type ImageBenchmarkSetup } from "../gameImageBenchmark";
import { gamePromptCatalog, type GamePromptScene } from "../gamePrompts";
import { RunRecordTabs, type RunRecordMode } from "./RunRecordTabs";
import { RunPerformanceDetails } from "./RunPerformanceDetails";
import { formatBenchmarkParameters } from "../benchmark/benchmarkParameters";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { UNITY_LANGUAGES } from "../unityTranslation";
import { GameFlowPerformance } from "./GameFlowSequence";
import { GameProgressBar } from "./GameStepProgress";
import { showAppNotice } from "./AppNotice";
import { GameDialog, useGameActionConfirm } from "./GameActionConfirm";
import { AuxiliaryWindowChrome, positionWindowPopover } from "./WindowControls";

const roleLabels = { text: "正文", dialogue: "对白", names: "术语" };
type BenchmarkSetup = Pick<BenchmarkInput, "scope" | "current" | "models" | "screenModel" | "initialPart"> & {
  selectedCount: number; imageSetup?: ImageBenchmarkSetup; mosaicSetup?: MosaicSettings; mosaicRoot?: string;
} & ReturnType<typeof benchmarkSampleCounts>;
type BenchmarkPageInput = BenchmarkSetup & {
  requestSelection: () => Promise<UnityEntry[]>;
  enqueue: (request: BenchmarkRequest | BenchmarkRequest[]) => Promise<unknown>;
  control: (kind: BenchmarkQueueCommand, data?: BenchmarkQueueArgument) => Promise<unknown>;
  snapshot: BenchmarkSnapshot;
};
type QueueDraft = { configs: BenchmarkConfig[]; rounds: string; sampleLimit: number; sampleSetPath?: string; useSampleSet?: boolean };
const setupFor = (input: BenchmarkInput): BenchmarkSetup => ({
  scope: input.scope, current: input.current, models: input.models, screenModel: input.screenModel,
  initialPart: input.initialPart, selectedCount: input.getWorkload().selected.length,
  mosaicSetup: input.mosaicRoot ? readMosaicSettings(input.mosaicRoot) : undefined, mosaicRoot: input.mosaicRoot,
  imageSetup: input.images?.setup, ...benchmarkSampleCounts(input),
});
const openEvent = "llmchat-open-game-benchmark";
export function openGameTextBenchmark(input?: BenchmarkInput) {
  if (input) benchmarkRunner.bindProject(input);
  window.dispatchEvent(new CustomEvent(openEvent, { detail: input }));
}

function controlQueue(kind: BenchmarkQueueCommand, data?: BenchmarkQueueArgument, input?: BenchmarkInput) {
  if (kind === "benchmark-start-queue") return benchmarkRunner.startQueue();
  if (kind === "benchmark-pause-queue") return benchmarkRunner.pauseQueue();
  if (kind === "benchmark-continue-batch" && data && typeof data !== "string" && "queueId" in data && input)
    return benchmarkRunner.continueArchivedBatch(input, data);
  if (kind === "benchmark-show-task" && typeof data === "string") return benchmarkRunner.showTask(data);
  if (kind === "benchmark-hide-task" && typeof data === "string") return benchmarkRunner.hideTask(data);
  if (kind === "benchmark-release-task" && (data === undefined || typeof data === "string")) return benchmarkRunner.releaseTask(data);
  if (data && typeof data !== "string" && "taskId" in data) {
    if (kind === "benchmark-decide-task" && "decision" in data) return benchmarkRunner.decideTask(data.taskId, data.decision, data.round, data.configs, data.confirmed);
    if (kind === "benchmark-save-task" && "configs" in data && "round" in data && data.round !== undefined && data.configs) return benchmarkRunner.saveTask(data.taskId, data.round, data.configs, data.confirmed);
    if (kind === "benchmark-set-task-dirty" && "dirty" in data) return benchmarkRunner.setTaskDirty(data.taskId, data.dirty);
  }
  if (kind === "benchmark-restart" && typeof data === "string") return benchmarkRunner.restart(data);
  if (kind === "benchmark-start" && typeof data === "string") benchmarkRunner.start(data);
  if (kind === "benchmark-stop" && typeof data === "string") benchmarkRunner.stop(data);
  if (kind === "benchmark-remove" && typeof data === "string") return benchmarkRunner.remove(data);
}

const BenchmarkHeader = createContext<HTMLDivElement | null>(null);
const recordModeKey = "llmchat-benchmark-record-mode";

function readViewPreference(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeViewPreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* The current window still keeps the choice. */ }
}

function useRememberedBenchmarkChoice<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = readViewPreference(key);
    return allowed.find(item => item === saved) ?? fallback;
  });
  return [value, next => {
    setValue(next);
    writeViewPreference(key, next);
  }];
}

type BenchmarkSampleView = { sampleLimit?: number; sampleSetPath?: string; useSampleSet?: boolean; selection?: "checked" | "all" };

function readBenchmarkSampleView(key: string): BenchmarkSampleView {
  try {
    const value = JSON.parse(readViewPreference(key) ?? "{}");
    if (!value || typeof value !== "object") return {};
    return {
      sampleLimit: Number.isSafeInteger(value.sampleLimit) && value.sampleLimit >= 0 ? value.sampleLimit : undefined,
      sampleSetPath: typeof value.sampleSetPath === "string" ? value.sampleSetPath : undefined,
      useSampleSet: typeof value.useSampleSet === "boolean" ? value.useSampleSet : undefined,
      selection: value.selection === "checked" || value.selection === "all" ? value.selection : undefined,
    };
  } catch { return {}; }
}

function RecordsAndTestsPage({ gameView, onClose, onBuildRunning, benchmarkChannel, browser = false }: {
  gameView: ReactNode; onClose: () => void;
  onBuildRunning?: (running: boolean) => void; benchmarkChannel?: BroadcastChannel; browser?: boolean;
}) {
  const [module, setModule] = useRememberedBenchmarkChoice("llmchat-benchmark-module", "game", ["game", "build", "datasets"]);
  const [gameHeaderTools, setGameHeaderTools] = useState<HTMLDivElement | null>(null);
  const [datasetHeaderTools, setDatasetHeaderTools] = useState<HTMLDivElement | null>(null);
  const tabId = useId();
  const page = <main className={"game-benchmark-page" + (browser ? " game-benchmark-browser-fallback" : "")}>
    <header className="game-benchmark-page-header"><h2>记录与测试</h2>
      <div className="game-benchmark-tabs" role="tablist" aria-label="测试模块">
        <button type="button" role="tab" id={tabId + "-game"} aria-controls={tabId + "-game-panel"}
          aria-selected={module === "game"} onClick={() => setModule("game")}>游戏翻译</button>
        <button type="button" role="tab" id={tabId + "-build"} aria-controls={tabId + "-build-panel"}
          aria-selected={module === "build"} onClick={() => setModule("build")}>构建测速</button>
        <button type="button" role="tab" id={tabId + "-datasets"} aria-controls={tabId + "-datasets-panel"}
          aria-selected={module === "datasets"} onClick={() => setModule("datasets")}>训练与数据集</button>
      </div>
      <div className="game-benchmark-header-tools" ref={setGameHeaderTools} hidden={module !== "game"} />
      <div className="game-benchmark-header-tools" ref={setDatasetHeaderTools} hidden={module !== "datasets"} />
      {browser && <button type="button" className="unity-btn game-benchmark-close" onClick={onClose}>关闭</button>}
    </header>
    <div className="game-benchmark-module" id={tabId + "-game-panel"} role="tabpanel"
      aria-labelledby={tabId + "-game"} hidden={module !== "game"}>
      <BenchmarkHeader.Provider value={gameHeaderTools}>
        {gameView}
      </BenchmarkHeader.Provider>
    </div>
    <div className="game-benchmark-module" id={tabId + "-build-panel"} role="tabpanel"
      aria-labelledby={tabId + "-build"} hidden={module !== "build"}>
      <BuildSpeedTest onRunningChange={onBuildRunning} />
    </div>
    <div className="game-benchmark-module" id={tabId + "-datasets-panel"} role="tabpanel"
      aria-labelledby={tabId + "-datasets"} hidden={module !== "datasets"}>
      <TrainingDatasetsPage channel={benchmarkChannel} headerTools={datasetHeaderTools} />
    </div>
  </main>;
  return browser ? createPortal(page, document.body) : page;
}

function LocalGameBenchmark({ input }: { input?: BenchmarkInput }) {
  const snapshot = useSyncExternalStore(benchmarkRunner.subscribe, benchmarkRunner.snapshot);
  const setup = useMemo(() => input && setupFor(input), [input]);
  if (!input || !setup) return <StandaloneBenchmarkHistory snapshot={snapshot}
    control={async (kind, data) => controlQueue(kind, data)} />;
  return <GameBenchmarkPage {...setup} snapshot={snapshot}
    requestSelection={async () => input.getWorkload().selected}
    enqueue={async request => benchmarkRunner.enqueue(input, request)}
    control={async (kind, data) => controlQueue(kind, data, input)} />;
}

export function GameTextBenchmarkHost() {
  const [local, setLocal] = useState<{ input?: BenchmarkInput }>();
  useEffect(() => {
    let active: BenchmarkInput | undefined;
    if (!isTauri()) {
      const open = (event: Event) => {
        const input = (event as CustomEvent<BenchmarkInput | null>).detail;
        active = input ?? active;
        setLocal({ input: active });
      };
      window.addEventListener(openEvent, open);
      return () => { active = undefined; window.removeEventListener(openEvent, open); };
    }
    const channel = new BroadcastChannel(benchmarkChannelName);
    let opening: Promise<void> | undefined;
    const open = (event: Event) => {
      if (opening) return;
      const previous = active;
      const requested = (event as CustomEvent<BenchmarkInput | null>).detail;
      const input = requested ?? active;
      active = input;
      opening = invoke<boolean>("open_game_benchmark_window").then(created => {
        if (active !== input) return;
        if (!created) channel.postMessage({ type: "refresh-setup", setup: input && setupFor(input), snapshot: benchmarkRunner.snapshot() });
      }).catch(error => {
        active = previous;
        showAppNotice("打开测试队列失败：" + String(error), "error");
      }).finally(() => { opening = undefined; });
    };
    channel.onmessage = async (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== "request") return;
      try {
        let value: unknown = true;
        if (message.kind === "setup") value = active && setupFor(active);
        else if (message.kind === "benchmark-snapshot") value = benchmarkRunner.snapshot();
        else if (message.kind === "training-dataset-write") await writeTrainingDatasetFile(message.data);
        else if (typeof message.kind === "string" && message.kind.startsWith("benchmark-") &&
            message.kind !== "benchmark-enqueue" && message.kind !== "benchmark-continue-batch")
          value = await controlQueue(message.kind, message.data);
        else {
          if (!active) throw new Error("测试队列没有关联的游戏工程");
          if (message.kind === "benchmark-continue-batch") value = await controlQueue(message.kind, message.data, active);
          else if (message.kind === "selection") value = active.getWorkload().selected;
          else if (message.kind === "benchmark-enqueue") value = await benchmarkRunner.enqueue(active, message.data);
          else throw new Error("未知的测试队列请求");
        }
        channel.postMessage({ type: "response", id: message.id, value });
      } catch (error) {
        channel.postMessage({ type: "response", id: message.id, error: String(error) });
      }
    };
    const unsubscribe = benchmarkRunner.subscribe(() => {
      const state = benchmarkRunner.snapshot();
      channel.postMessage({ type: "benchmark-queue", ...state });
    });
    window.addEventListener(openEvent, open);
    return () => { active = undefined; unsubscribe(); window.removeEventListener(openEvent, open); channel.close(); };
  }, []);
  if (!local) return null;
  const close = () => {
    benchmarkRunner.releaseTask();
    setLocal(undefined);
  };
  return <RecordsAndTestsPage browser onClose={close}
    gameView={<LocalGameBenchmark key={local.input?.scope} input={local.input} />} />;
}

export function GameTextBenchmarkWindow() {
  const [page, setPage] = useState<{ setup?: BenchmarkSetup; channel: BroadcastChannel }>();
  const [snapshot, setSnapshot] = useState(emptyBenchmarkSnapshot);
  const [error, setError] = useState("");
  const closing = useRef<"idle" | "checking" | "allowed">("idle");
  const connection = useRef<BroadcastChannel | null>(null);
  const building = useRef(false);
  const close = useCallback(async () => {
    if (closing.current !== "idle") return;
    if (building.current) { showAppNotice("构建测速正在运行，完成后可关闭"); return; }
    closing.current = "checking";
    try {
      if (connection.current) await requestBenchmarkWindow(connection.current, "benchmark-release-task");
      closing.current = "allowed";
      await getCurrentWindow().close();
    } catch (error) {
      closing.current = "idle";
      showAppNotice("关闭测试窗口失败：" + String(error), "error");
    }
  }, []);
  useEffect(() => {
    let active = true;
    const channel = new BroadcastChannel(benchmarkChannelName);
    connection.current = channel;
    const receiveSnapshot = (state: BenchmarkSnapshot) => {
      if (active) setSnapshot(previous => state.version >= previous.version ? state : previous);
    };
    const refresh = (event: MessageEvent) => {
      if (event.data?.type === "refresh-setup") {
        setPage({ setup: event.data.setup, channel });
        setSnapshot(event.data.snapshot);
      }
      if (event.data?.type === "benchmark-queue") receiveSnapshot(event.data);
    };
    channel.addEventListener("message", refresh);
    const unlisten = getCurrentWindow().onCloseRequested(event => {
      if (closing.current === "allowed") return;
      event.preventDefault();
      void close();
    });
    void unlisten.catch(error => showAppNotice(String(error), "error"));
    void Promise.all([
      requestBenchmarkWindow<BenchmarkSetup | undefined>(channel, "setup"),
      requestBenchmarkWindow<BenchmarkSnapshot>(channel, "benchmark-snapshot"),
    ]).then(([setup, state]) => {
      if (active) { receiveSnapshot(state); setPage({ setup, channel }); }
    }).catch(error => { if (active) setError(String(error)); });
    return () => {
      active = false;
      connection.current = null;
      channel.close();
      void unlisten.then(remove => remove()).catch(console.error);
    };
  }, [close]);
  const closeWindow = () => void close();
  return <AuxiliaryWindowChrome title="测试队列">
    <RecordsAndTestsPage onClose={closeWindow} benchmarkChannel={page?.channel ?? connection.current ?? undefined} onBuildRunning={value => { building.current = value; }}
      gameView={page?.setup ? <GameBenchmarkPage key={page.setup.scope} {...page.setup} snapshot={snapshot}
        requestSelection={() => requestBenchmarkWindow(page.channel, "selection")}
        enqueue={request => requestBenchmarkWindow(page.channel, "benchmark-enqueue", request)}
        control={(kind, id) => requestBenchmarkWindow(page.channel, kind, id)} />
        : (page || error
          ? <StandaloneBenchmarkHistory snapshot={snapshot} setupError={error}
            control={page && ((kind, data) => requestBenchmarkWindow(page.channel, kind, data))} />
          : <p className="game-benchmark-module-status hint" role="status">正在打开记录与测试…</p>)} />
  </AuxiliaryWindowChrome>;
}


type BenchmarkDetailRow = { label: string; value: string | number | undefined };

function BenchmarkDetailRows({ rows, fixedLabels = false }: { rows: readonly BenchmarkDetailRow[]; fixedLabels?: boolean }) {
  const visible = rows.filter(({ value }) => value !== undefined && value !== "" && value !== "—");
  if (!visible.length) return null;
  return <dl className={"game-benchmark-data-rows" + (fixedLabels ? " has-fixed-labels" : "")}>
    {visible.map(({ label, value }, index) => <div key={label + index}>
      <dt>{label}</dt><dd>{value}</dd>
    </div>)}
  </dl>;
}

function benchmarkSeconds(ms?: number) {
  return ms === undefined ? undefined : (ms / 1000).toFixed(2) + " 秒";
}

function BenchmarkQueueDetails({ progress, position, unit }: { progress: NonNullable<BenchmarkJob["progress"]>; position: number; unit: "条" | "张" }) {
  const measured = progress.performance;
  const models = Object.values(measured?.models ?? {});
  const outcomes = models.flatMap(model => model.outcomes ? [model.outcomes] : []);
  const requestCount = (key: "succeeded" | "failed" | "cancelled") =>
    outcomes.length ? outcomes.reduce((total, row) => total + row[key], 0) + " 次" : undefined;
  const counts = (value?: number) => value === undefined ? undefined : value + " 次";
  const busy = measured?.busyMs ?? measured?.wallTiming?.modelRequestMs;
  const idle = measured?.idleMs ?? (measured?.requestTimingComplete && busy !== undefined
    ? Math.max(0, measured.elapsedMs - busy) : undefined);
  const requestRows: BenchmarkDetailRow[] = [
    { label: "成功", value: requestCount("succeeded") },
    { label: "失败", value: requestCount("failed") },
    { label: "取消", value: requestCount("cancelled") },
    { label: "结果复用", value: counts(measured?.cacheHits) },
    { label: "检测推理", value: benchmarkSeconds(measured?.wallTiming?.detectorMs) },
    { label: "本地 OCR", value: benchmarkSeconds(measured?.wallTiming?.ocrMs) },
    { label: "ComfyUI 执行", value: benchmarkSeconds(measured?.timing?.workflowMs) },
    { label: "样本失败", value: progress.failed ? progress.failed + " " + unit : undefined },
    { label: "无在途模型请求", value: benchmarkSeconds(idle) },
    { label: "文本请求重试", value: counts(measured?.textRequestRetries) },
  ];
  const tokens = [
    ["promptTokens", "输入 Token"], ["completionTokens", "输出 Token"], ["totalTokens", "合计 Token"],
    ["cacheReadTokens", "缓存读取"], ["cacheWriteTokens", "缓存写入"],
  ] as const;
  for (const [key, label] of tokens) {
    const recorded = models.flatMap(model => model.usage?.[key] === undefined ? [] : [model.usage[key]]);
    if (recorded.length) requestRows.push({ label, value: recorded.reduce((total, value) => total + value, 0).toLocaleString() });
  }
  const config = (progress.parameters ?? []).filter(parameter => parameter.scope === "config" && parameter.value && parameter.value !== "—");
  const remaining = progress.current > 0 && progress.elapsedMs > 0
    ? progress.elapsedMs / progress.current * Math.max(0, progress.total - progress.current) : undefined;
  const phase = progress.state === "paused" ? "已暂停" : { prepare: "准备", execute: "执行", finish: "收尾" }[progress.phase];
  return <details className="game-benchmark-queue-details">
    <summary>进度详情</summary>
    <div className="game-benchmark-queue-breakdown">
      <div className="game-benchmark-progress-total">
        <strong>{progress.current.toLocaleString()} / {progress.total.toLocaleString()} <small>{unit}</small></strong>
        {progress.percent != null && <b>{Math.round(progress.percent)}%</b>}
      </div>
      <GameProgressBar label="整批测试进度" value={progress.percent ?? undefined} />
      <div className="game-benchmark-progress-meta">
        {progress.sampleCurrent != null && progress.sampleTotal != null && <span>本配置 <b>{progress.sampleCurrent}/{progress.sampleTotal}</b></span>}
        <span>用时 <b>{gameDuration(progress.configElapsedMs ?? progress.elapsedMs)}</b></span>
        {remaining !== undefined && <span title="根据当前整批样本处理速度估算">预计剩余 <b>{gameDuration(remaining)}</b></span>}
      </div>
      <section>
        <h4>当前位置</h4>
        <BenchmarkDetailRows rows={[
          { label: "阶段", value: phase },
          { label: "轮次", value: progress.round != null && progress.rounds != null ? progress.round + " / " + progress.rounds : undefined },
          { label: "配置序号", value: progress.configIndex != null && progress.configCount != null ? progress.configIndex + " / " + progress.configCount : undefined },
          { label: "当前样本", value: progress.sample },
          { label: "队列位置", value: position },
        ]} />
      </section>
      <GameFlowPerformance measured={measured} queue />
      {requestRows.some(row => row.value !== undefined) && <section>
        <h4>本次请求</h4>
        <BenchmarkDetailRows rows={requestRows} />
      </section>}
      {config.length > 0 && <section>
        <h4>配置来源</h4>
        <BenchmarkDetailRows rows={config} />
      </section>}
    </div>
  </details>;
}

function BenchmarkRunMeasurements({ result, formal }: { result: BenchmarkResult; formal: boolean }) {
  const { performance, unobservedModels } = result;
  const summaryRows: BenchmarkDetailRow[] = [];
  const otherSummary: string[] = [];
  for (const phrase of result.summary?.split(" · ") ?? []) {
    const count = /^(复筛确认有码|待人工复核) (\d+ 张)$/.exec(phrase);
    if (count) summaryRows.push({ label: count[1], value: count[2] });
    else if (phrase) otherSummary.push(phrase);
  }
  return <>
    <BenchmarkDetailRows fixedLabels rows={[
      { label: "检测推理", value: benchmarkSeconds(performance.wallTiming?.detectorMs) },
      { label: "本地 OCR", value: benchmarkSeconds(performance.wallTiming?.ocrMs) },
      { label: "结果复用", value: performance.cacheHits === undefined ? undefined : performance.cacheHits + " 次" },
      { label: "ComfyUI 执行", value: benchmarkSeconds(performance.timing?.workflowMs) },
      { label: "未记录模型请求", value: unobservedModels.map(id => id.split("/").at(-1)).join("、") },
    ]} />
    {Object.values(performance.models).map(model => {
      const timing = model.serviceTiming;
      return <BenchmarkDetailRows key={model.model + ":" + model.concurrency} fixedLabels rows={[
        { label: "模型", value: model.model },
        { label: "并发", value: model.concurrency },
        { label: "请求", value: model.requests + " 次" },
        { label: "Token", value: formal && model.requests ? model.usage?.completionTokens ?? model.tokens : undefined },
        { label: "纯生成", value: model.generationMs > 0 ? (model.generationTokens * 1000 / model.generationMs).toFixed(1) + "\u00a0tok/s" : undefined },
        { label: "请求平均", value: model.requestMs > 0 ? (model.tokens * 1000 / model.requestMs).toFixed(1) + "\u00a0tok/s" : undefined },
        { label: "服务总计", value: benchmarkSeconds(timing?.totalMs) },
        { label: "计时", value: timing?.requests === undefined ? undefined : timing.requests + "/" + model.requests + " 次" },
        { label: "模型就绪", value: benchmarkSeconds(timing?.loadMs) },
        { label: "输入评估", value: benchmarkSeconds(timing?.promptMs) },
        { label: "输出生成", value: benchmarkSeconds(timing?.generationMs) },
        { label: "服务外开销", value: benchmarkSeconds(timing?.outsideMs) },
      ]} />;
    })}
    <BenchmarkDetailRows fixedLabels rows={summaryRows} />
    {otherSummary.length > 0 && <ul className="game-benchmark-run-notes">{otherSummary.map((phrase, index) => <li key={index}>{phrase}</li>)}</ul>}
  </>;
}

function ImageBenchmarkRunDetails({ queueId, runId }: { queueId: string; runId: string }) {
  const [open,setOpen] = useState(false);
  const [detail,setDetail] = useState<ImageBenchmarkDetails>();
  const [error,setError] = useState("");
  const [changedOnly,setChangedOnly] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const [page,setPage] = useState(0);
  const size = 40;
  useEffect(() => {
    if (!open || detail) return;
    let alive = true;
    setError("");
    void readImageBenchmarkDetails(queueId,runId).then(value => { if (alive) setDetail(value); })
      .catch(cause => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, [queueId, runId, open, detail]);
  const rows = useMemo(() => detail?.samples.flatMap((sample,index) => {
    const outcome = detail.results[index];
    const changed = !!outcome && (outcome.category !== sample.category || outcome.checked !== undefined && outcome.checked !== sample.checked);
    if (failedOnly && outcome?.status !== "失败" || changedOnly && !changed) return [];
    return [{ sample, outcome }];
  }) || [], [detail, changedOnly, failedOnly]);
  const failures = useMemo(() => Object.values(detail?.results ?? {}).filter(outcome => outcome.status === "失败").length, [detail]);
  return <details open={open} onToggle={event => {
    const expanded = event.currentTarget.open;
    setOpen(expanded);
    if (!expanded) setDetail(undefined);
  }}>
    <summary>逐图结果</summary>
    {open && (error ? <p role="alert">{error}</p> : !detail ? <p role="status">正在读取逐图结果…</p> : <>
      <label><input type="checkbox" checked={changedOnly} onChange={event => { setChangedOnly(event.target.checked); setPage(0); }} />只看变动</label>
      {(failures > 0 || failedOnly) && <label><input type="checkbox" checked={failedOnly}
        onChange={event => { setFailedOnly(event.target.checked); setPage(0); }} />只看失败 · {failures} 张</label>}
      {!rows.length && <p className="hint">没有符合条件的图片</p>}
      {rows.slice(page*size,(page+1)*size).map(({sample,outcome}) => <details key={sample.id}>
        <summary>{sample.file} · {outcome?.status === "失败" ? "处理失败" : sample.category + " → " + (outcome?.category || "未执行")}
          {outcome?.status === "失败" && outcome.reason && " · " + outcome.reason}
          {outcome?.status && outcome.status !== "失败" && " · " + outcome.status}
          {outcome?.checked !== undefined && " · " + (sample.checked ? "已勾选" : "未勾选") + " → " + (outcome.checked ? "已勾选" : "未勾选")}
        </summary>
        {sample.boxes?.length ? <p>原定位框 {JSON.stringify(sample.boxes)}</p> : null}
        {outcome?.boxes?.length ? <p>结果定位框 {JSON.stringify(outcome.boxes)}</p> : null}
        {outcome?.reason && <p>{outcome.reason}</p>}
        {outcome?.regions?.map((region,i) => <p key={i}>
          {JSON.stringify(region.box)} · {region.text}{region.translation && " → " + region.translation}{region.reason && " · " + region.reason}
        </p>)}
      </details>)}
      {rows.length > size && <div className="game-benchmark-toolbar">
        <button type="button" className="unity-btn" disabled={!page} onClick={() => setPage(page - 1)}>上一页</button>
        <span>{page + 1} / {Math.ceil(rows.length / size)}</span>
        <button type="button" className="unity-btn" disabled={(page+1)*size >= rows.length} onClick={() => setPage(page+1)}>下一页</button>
      </div>}
    </>)}
  </details>;
}

function BenchmarkSection({ title, className = "", action, children }: {
  title: string; className?: string; action?: ReactNode; children: ReactNode;
}) {
  return <section className={"game-benchmark-section " + className} aria-label={title}>
    <header className="game-benchmark-records-head">
      <h3>{title}</h3>{action}
    </header>
    {children}
  </section>;
}

function useBenchmarkArchive(historyRevision: number, formal = false, enabled = true) {
  const [records, setRecords] = useState<BenchmarkResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true); setError("");
    const reading = formal ? readGameFormalHistory().then(formalHistoryResults) : readGameBenchmarkHistory();
    void reading.then(history => { if (active) setRecords(history); })
      .catch(error => { if (active) setError(String(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [historyRevision, reload, formal, enabled]);
  return { records, loading, error, refresh: () => setReload(value => value + 1) };
}

function latestBenchmarkRunsByConfig(history: readonly BenchmarkResult[]) {
  const latest = new Map<string, { run: BenchmarkResult; finishedAt: number }>();
  for (const run of history) {
    if (run.performance.benchmark?.continuedFrom) continue;
    const config = run.performance.benchmark?.config as { id?: unknown } | undefined;
    const id = config?.id;
    if (typeof id !== "string" || !id) continue;
    const finishedAt = Date.parse(run.performance.endedAt || run.performance.beginTime || "") || 0;
    const previous = latest.get(id);
    if (!previous || finishedAt > previous.finishedAt || finishedAt === previous.finishedAt && run.round > previous.run.round) {
      latest.set(id, { run, finishedAt });
    }
  }
  return latest;
}

function archivedBenchmarkStep(step?: string): Target | undefined {
  return step && (step === "screen" || step === "translate" ||
    Object.hasOwn(mosaicBenchmarkSteps, step) || Object.hasOwn(imageBenchmarkSteps, step)) ? step as Target : undefined;
}

const filename = (path: string) => path.split(/[\\/]/).pop() || path;

function BenchmarkQueueContents({ snapshot, onControl, onShow, showingTaskId, taskAction }: {
  snapshot: BenchmarkSnapshot; onControl?: BenchmarkPageInput["control"]; onShow?: (id: string) => void | Promise<void>;
  showingTaskId?: string; taskAction?: boolean;
}) {
  const { jobs, running, stopping, formalBusy, formalJobs } = snapshot;
  const queue = jobs.filter(job => job.status !== "完成");
  const control = (kind: BenchmarkQueueCommand, id: string) =>
    void onControl?.(kind, id).catch(error => showAppNotice(String(error), "error"));
  return <div className="game-benchmark-results">
      {!queue.length && !formalJobs.length && <p className="hint">暂无正在运行或排队的任务。</p>}
      {formalJobs.map(job => <div key={job.id} className="game-benchmark-queue-item" data-status={job.state === "running" ? "运行中" : "等待"} role="status">
        <div><strong>{job.state === "unfinished" ? "正式任务未完成" : "正式任务"} · {job.label}</strong>
          <div className="hint">{job.game}{job.total ? " · " + (job.completed ?? 0) + "/" + job.total : ""}</div>
          {job.detail && job.detail !== job.label && <div className="hint" title={job.detail}>{job.detail}</div>}
        </div>
      </div>)}
      {queue.map((job, index) => {
        const progress = job.progress;
        const statusLabel = job.status === "已暂停" ? "已中止" : job.status;
        const detailProgress = job.status === "运行中" || job.status === "已暂停" ? progress : undefined;
        return <div key={job.id} className="game-benchmark-queue-item" data-status={job.status}>
          <div className="game-benchmark-queue-copy">
            <div className="game-benchmark-queue-title">
              <span role="img" aria-label={statusLabel} title={statusLabel} style={{ flex: "0 0 8px", height: 8, borderRadius: "50%",
                background: job.status === "运行中" ? "#3265b6" : job.status === "完成" ? "var(--success)" :
                  job.status === "失败" ? "var(--danger)" : "var(--text-muted)" }} />
              <strong role={job.status === "运行中" ? "status" : undefined} title={progress?.label}>{job.label}</strong>
              {progress?.percent != null && <span className="game-flow-metric game-benchmark-queue-percent" style={{ marginInlineStart: "auto" }}>
                {progress.percent}%
              </span>}
            </div>
            <div style={{ marginInlineStart: "calc(8px + var(--space-2))" }}>
              {stopping && job.status === "运行中" && <div>正在中止并保存…</div>}
              {job.status === "运行中" && progress?.phase === "execute" && <div className="hint">{progress.label}</div>}
              {!detailProgress && <div className="hint" title={progress?.detail}>
                {job.status === "待开始" ? statusLabel : job.status === "等待" ? (snapshot.blockedTaskId === job.id ? "等待保存配置" : !running ? "队列已暂停" : formalBusy ? formalBlockingReason : "等待前一任务") :
                  job.status === "失败" ? job.failure || progress?.detail : progress &&
                  <>{statusLabel} · {progress.current}/{progress.total} · {gameDuration(progress.elapsedMs)}
                    {progress.failed > 0 && " · 失败 " + progress.failed}</>}
              </div>}
              {job.status === "已暂停" && <div className="hint" title={job.needsProject ? job.requestScope : undefined}>{job.needsProject
                ? "打开原游戏工程后可继续" : progress?.detail ||
                  (job.resumeSamples ? "继续时复用已有样本结果" : "继续时从暂停的配置重新计时")}</div>}
            </div>
          </div>
          {onShow && <button type="button" className="unity-btn game-benchmark-show-open" aria-pressed={showingTaskId === job.id}
            disabled={taskAction} onClick={() => onShow(job.id)}>显示</button>}
          {job.status === "运行中" &&
            <button type="button" className="unity-btn" disabled={stopping || !onControl} onClick={() => control("benchmark-stop", job.id)}>中止任务</button>}
          {(job.status === "待开始" || job.status === "已暂停") &&
            <button type="button" className="unity-btn" data-tooltip={job.needsProject ? "打开原游戏工程后可继续"
              : job.status === "已暂停" ? "从已保存的进度继续" : undefined}
              disabled={stopping || taskAction || job.needsProject || !onControl} onClick={() => control("benchmark-start", job.id)}>
              {job.status === "已暂停" ? "继续任务" : "开始任务"}</button>}
          {job.status === "已暂停" &&
            <button type="button" className="unity-btn" disabled={showingTaskId === job.id || job.needsProject || stopping || !onControl} data-tooltip="新建任务，从零重跑"
              onClick={() => control("benchmark-restart", job.id)}>从头运行</button>}
          {job.status !== "运行中" && <button type="button" className="unity-btn" disabled={showingTaskId === job.id || !onControl}
            data-tooltip={showingTaskId === job.id ? "请先退出显示" : "移出队列，保留测试记录"}
            onClick={() => control("benchmark-remove", job.id)}>移除</button>}
          {detailProgress && <BenchmarkQueueDetails progress={detailProgress} position={index + 1}
            unit={job.step === "screen" || job.step === "translate" ? "条" : "张"} />}
        </div>;
      })}
    </div>;
}

function GameBenchmarkPage(props: BenchmarkPageInput) {
  const imageSteps = Object.keys(props.imageSetup?.steps || {}) as ImageBenchmarkStep[];
  const viewKey = "llmchat-benchmark-view:" + props.scope + ":";
  const availableParts: Array<"text" | "images" | "mosaic"> = ["text"];
  if (imageSteps.length) availableParts.push("images");
  if (props.mosaicSetup) availableParts.push("mosaic");
  const initialPart = props.initialPart && availableParts.includes(props.initialPart) ? props.initialPart : "text";
  const [part, setPart] = useRememberedBenchmarkChoice(viewKey + "part", initialPart, availableParts);
  const [recordMode, setRecordMode] = useRememberedBenchmarkChoice(recordModeKey, "test", ["test", "formal"]);
  const [textStep, setTextStep] = useRememberedBenchmarkChoice(viewKey + "text", "translate", ["translate", "screen"]);
  const [imageStep, setImageStep] = useRememberedBenchmarkChoice(viewKey + "images", imageSteps[0] || "recognize", imageSteps);
  const queuedMosaic = props.snapshot.jobs.find(job => job.requestScope === props.scope &&
    (job.status === "运行中" || job.status === "已暂停") && isMosaicStep(job.step))?.step;
  const initialMosaicStep = queuedMosaic && isMosaicStep(queuedMosaic) ? queuedMosaic :
    props.snapshot.formalJobs.some(job => job.label === "复筛打码图片") ? "mosaicRefine" : "mosaicScreen";
  const [mosaicStep, setMosaicStep] = useRememberedBenchmarkChoice("llmchat-game-benchmark-mosaic-step:" + props.scope,
    initialMosaicStep, Object.keys(mosaicBenchmarkSteps) as MosaicBenchmarkStep[]);
  const drafts = useRef<Partial<Record<Target, QueueDraft>>>({});
  const step = part === "text" ? textStep : part === "mosaic" ? mosaicStep : imageStep;
  const { jobs, historyRevision } = props.snapshot;
  const archive = useBenchmarkArchive(historyRevision);
  const queue = jobs.filter(job => job.status !== "完成");
  const [taskDraft, setTaskDraft] = useState<{ id: string; parameters: BenchmarkTaskConfig; configs: BenchmarkConfig[] }>();
  const [taskAction, setTaskAction] = useState(false);
  const actionRef = useRef(false);
  const viewerSession = useRef<{ id?: string; control: BenchmarkPageInput["control"]; mounted: boolean }>({ control: props.control, mounted: true });
  viewerSession.current.control = props.control;
  const discard = useGameActionConfirm();
  const showingTaskId = taskDraft?.id;
  const shownJob = showingTaskId ? jobs.find(job => job.id === showingTaskId) : undefined;
  const viewIsCurrent = !!shownJob && shownJob.round === taskDraft?.parameters.round;
  const shownRound = shownJob?.round;
  const shownStep = shownJob?.step;
  const taskRuns = useMemo(() => latestBenchmarkRunsByConfig(archive.records.filter(run =>
    !!showingTaskId && run.performance.benchmark?.queueId === showingTaskId && run.performance.step === shownStep &&
    run.round === shownRound && (run.status === "完成" || run.status === "失败"))),
    [archive.records, showingTaskId, shownStep, shownRound]);
  const changes = useMemo(() => taskDraft && shownJob &&
    benchmarkRoundChanges(shownJob.step, taskDraft.configs, taskDraft.parameters.configs, taskDraft.parameters.earlier),
    [taskDraft, shownJob?.step]);
  const dirty = changes?.dirty ?? false;
  const canSave = viewIsCurrent && !!shownJob && canEditBenchmarkTask(shownJob) && dirty;
  const blocking = !!shownJob && props.snapshot.blockedTaskId === shownJob.id;
  const resuming = shownJob?.progress?.state === "paused";
  useLayoutEffect(() => {
    if (!showingTaskId) return;
    void viewerSession.current.control("benchmark-set-task-dirty", { taskId: showingTaskId, dirty })
      .catch(error => showAppNotice(error instanceof Error ? error.message : String(error), "error"));
  }, [showingTaskId, dirty]);
  const canDefer = jobs.some(job => job.id !== showingTaskId && (job.status === "等待" || job.status === "待开始"));
  useEffect(() => {
    const session = viewerSession.current;
    session.mounted = true;
    return () => {
      session.mounted = false;
      if (session.id) void session.control("benchmark-release-task", session.id).catch(console.error);
    };
  }, []);
  useEffect(() => {
    if (showingTaskId && !shownJob) {
      viewerSession.current.id = undefined;
      setTaskDraft(undefined);
    }
  }, [showingTaskId, shownJob]);
  useEffect(() => {
    if (!showingTaskId || !shownJob || viewIsCurrent) return;
    let cancelled = false;
    void viewerSession.current.control("benchmark-show-task", showingTaskId).then(value => {
      if (cancelled || viewerSession.current.id !== showingTaskId) return;
      const parameters = value as BenchmarkTaskConfig;
      setTaskDraft({ id: showingTaskId, parameters, configs: structuredClone(parameters.configs) });
    }).catch(error => {
      if (!cancelled) showAppNotice(error instanceof Error ? error.message : String(error), "error");
    });
    return () => { cancelled = true; };
  }, [showingTaskId, shownJob?.round, viewIsCurrent]);
  const actOnTask = async (action: () => Promise<void>) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setTaskAction(true);
    try { await action(); }
    catch (error) { showAppNotice(error instanceof Error ? error.message : String(error), "error"); }
    finally {
      actionRef.current = false;
      if (viewerSession.current.mounted) setTaskAction(false);
    }
  };
  const allowDiscard = () => !dirty || discard.confirm("此任务的配置尚未保存，确定丢弃修改？",
    { title: "退出显示", okLabel: "丢弃并退出", cancelLabel: "继续编辑" });
  const showTask = async (id: string) => {
    if (actionRef.current || id === showingTaskId || !await allowDiscard()) return;
    await actOnTask(async () => {
      const parameters = await props.control("benchmark-show-task", id) as BenchmarkTaskConfig;
      if (!viewerSession.current.mounted) {
        await props.control("benchmark-release-task", id);
        return;
      }
      viewerSession.current.id = id;
      setTaskDraft({ id, parameters, configs: structuredClone(parameters.configs) });
    });
  };
  const exitTask = async () => {
    if (actionRef.current || !showingTaskId || !await allowDiscard()) return;
    await actOnTask(async () => {
      await props.control("benchmark-hide-task", showingTaskId);
      viewerSession.current.id = undefined;
      setTaskDraft(undefined);
    });
  };
  const setTaskConfigs: Dispatch<SetStateAction<BenchmarkConfig[]>> = action => setTaskDraft(previous =>
    previous && { ...previous, configs: typeof action === "function" ? action(previous.configs) : action });
  const acknowledgeSave = (configs: BenchmarkConfig[]) => setTaskDraft(previous => previous && {
    ...previous, parameters: { ...previous.parameters, configs: structuredClone(configs) }, configs,
  });
  // Each run commits to the enabled configuration list. Keep the clean viewer in sync with it.
  useEffect(() => {
    if (shownJob?.status !== "运行中" || !viewIsCurrent || dirty) return;
    setTaskDraft(previous => {
      if (!previous?.configs.some(config => config.enabled === false)) return previous;
      const configs = previous.configs.filter(config => config.enabled !== false);
      return { ...previous, parameters: { ...previous.parameters, configs: structuredClone(configs) }, configs };
    });
  }, [shownJob?.status, viewIsCurrent, dirty]);
  const confirmRoundChange = () => {
    const count = changes?.needsConfirmation.size ?? 0;
    if (!count || !taskDraft) return true;
    const round = taskDraft.parameters.round;
    return discard.confirm("第 " + round + " 轮有 " + count + " 项参数与前面轮次不同，结果将按各轮实际配置记录。本次修改只影响这一轮。",
      { title: "确认本轮使用不同配置", okLabel: "确认修改", cancelLabel: "返回" });
  };
  const saveTask = () => void actOnTask(async () => {
    if (!taskDraft || !canSave || !await confirmRoundChange()) return;
    await props.control("benchmark-save-task", { taskId: taskDraft.id, round: taskDraft.parameters.round, configs: taskDraft.configs,
      confirmed: !!changes?.needsConfirmation.size });
    acknowledgeSave(taskDraft.configs);
    showAppNotice("任务配置已保存");
  });
  const decide = (decision: BenchmarkTaskDecision) => void actOnTask(async () => {
    if (!taskDraft) return;
    if (decision === "run" && (!viewIsCurrent || !await confirmRoundChange())) return;
    const configs = decision === "run" ? taskDraft.configs : undefined;
    await props.control("benchmark-decide-task", { taskId: taskDraft.id, decision, round: taskDraft.parameters.round, configs,
      confirmed: decision === "run" && !!changes?.needsConfirmation.size });
    if (decision === "run") acknowledgeSave(taskDraft.configs.filter(config => config.enabled !== false));
  });
  const taskView = shownJob && taskDraft && (viewIsCurrent && changes
    ? <BenchmarkTaskView key={shownJob.id + ":" + shownJob.round} job={shownJob} number={queue.indexOf(shownJob) + 1}
        parameters={taskDraft.parameters} configs={taskDraft.configs} changes={changes} setConfigs={setTaskConfigs} models={props.models}
        latestRunByConfig={taskRuns} saving={taskAction} canSave={canSave} onSave={saveTask} onExit={exitTask} />
    : <BenchmarkSection title="任务测试配置"><p className="hint" role="status">正在读取第 {shownJob.round} 轮配置…</p></BenchmarkSection>);
  const taskDialogs = <>
    {discard.dialog}
    {blocking && <GameDialog title="任务配置未保存"
      description={shownJob.label + (resuming ? "。保存修改后可从上次进度继续。" : "。保存修改后可开始测试。")}
      dismissible={false} disabled={taskAction} className="game-benchmark-show-decision">
      <button type="button" className="game-confirm-primary" autoFocus disabled={taskAction} onClick={() => decide("run")}>{resuming ? "保存并继续" : "保存并开始"}</button>
      <button type="button" className="game-confirm-accept" disabled={taskAction} onClick={() => decide("stop")}>中止队列</button>
      <button type="button" className="unity-btn" disabled={taskAction || !canDefer}
        title={canDefer ? undefined : "队列中没有其他待开始的任务"} onClick={() => decide("defer")}>当前任务后移</button>
    </GameDialog>}
  </>;
  return <GameTextBenchmarkDialog key={step} {...props} step={step} draft={drafts.current[step]}
    onDraft={draft => { drafts.current[step] = draft; }} archive={archive}
    recordMode={recordMode} onRecordModeChange={setRecordMode} taskView={taskView} taskDialogs={taskDialogs}
    queueContents={<BenchmarkQueueContents snapshot={props.snapshot} onControl={props.control}
      showingTaskId={showingTaskId} taskAction={taskAction} onShow={showTask} />}
    targetControls={<div className="game-benchmark-toolbar game-benchmark-target">
      <label>内容<select value={part} onChange={event => setPart(event.target.value as typeof part)}>
        <option value="text">翻译文本</option>
        {imageSteps.length > 0 && <option value="images">图片翻译</option>}
        {props.mosaicSetup && <option value="mosaic">图片去码</option>}
      </select></label>
      <label>步骤{part === "text" ?
        <select value={textStep} onChange={event => setTextStep(event.target.value as typeof textStep)}>
          <option value="screen">筛选文本</option><option value="translate">翻译正文</option>
        </select> : part === "mosaic" ? <select value={mosaicStep} onChange={event => setMosaicStep(event.target.value as MosaicBenchmarkStep)}>
          {Object.entries(mosaicBenchmarkSteps).map(([id, title]) => <option key={id} value={id}>{title}</option>)}
        </select> : <select value={imageStep} onChange={event => setImageStep(event.target.value as ImageBenchmarkStep)}>
          {imageSteps.map(id => <option key={id} value={id}>{imageBenchmarkSteps[id].title}</option>)}
        </select>}</label>
    </div>} />;
}


function BenchmarkTaskRunSummary({ run, queueId, step }: { run: BenchmarkResult; queueId: string; step: Target }) {
  const { taskId: runId, endedAt, elapsedMs, scope, benchmark } = run.performance;
  const [metrics, setMetrics] = useState<{ review?: number; score?: string; matches?: string }>({});
  const referenceKey = runReferenceKey(queueId);
  const [reference, setReference] = useState(() => readViewPreference(referenceKey));
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === referenceKey || event.key === null) setReference(readViewPreference(referenceKey));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [referenceKey]);
  const archivedReference = benchmark?.referenceSampleSetPath ?? benchmark?.sampleSetPath;
  const referencePath = reference || (typeof archivedReference === "string" ? archivedReference : undefined);
  const stage = step === "mosaicScreen" || step === "mosaicRefine" ? step : undefined;
  const hasDetails = benchmark?.imageDetails === true;

  useEffect(() => {
    if (!hasDetails || !runId) return;
    let active = true;
    setMetrics({});
    void (async () => {
      const details = await readImageBenchmarkDetails(queueId, runId);
      if (!active) return;
      const outcomes = Object.values(details.results);
      const review = outcomes.length ? outcomes.filter(outcome => outcome.category === mosaicStatusLabels.review &&
        outcome.status !== "失败" && outcome.status !== "跳过").length : undefined;
      setMetrics({ review });
      if (!stage) return;
      const report = await scoreMosaicComparisonRuns([{ run, runId, details }], referencePath, stage, !!reference);
      const row = report.totals[0];
      if (!active || !row) return;
      const score = stage === "mosaicRefine" && row.score.displayScore != null
        ? (row.score.provisional ? "暂定 " : "") + row.score.displayScore.toFixed(1) + " 分" : undefined;
      setMetrics({ review, score, matches: row.evaluatedBoxes > 0 ? row.foundBoxes + "/" + row.evaluatedBoxes : undefined });
    })().catch(() => { /* Optional archive metrics can be unavailable for older runs. */ });
    return () => { active = false; };
  }, [hasDetails, queueId, runId, run, stage, referencePath, reference]);

  const archivedReview = /(?:^| · )待(?:人工)?复核 (\d+) 张/.exec(run.summary || "")?.[1];
  const failed = run.status === "失败" || run.failed > 0;
  const itemUnit = step === "screen" || step === "translate" ? "条" : "张";
  const stats = [
    ["样本", run.selected], ["成功", run.translated], ["失败", run.failed],
    ["待复核", metrics.review ?? archivedReview ?? "—"], ["复筛综合分", metrics.score ?? "—"],
    ["匹配框", metrics.matches ?? "—"],
  ];
  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "var(--space-2) var(--space-4)" };
  return <section className="game-benchmark-run-summary" aria-label="配置运行结果"
    style={{ gridTemplateColumns: "minmax(0, 1fr)", cursor: "auto", borderBlockStart: "1px solid var(--border)", padding: "var(--space-3)" }}>
    <header className="game-benchmark-run-summary-head" style={rowStyle}>
      <strong className="game-benchmark-run-badge" data-tone={failed ? "failure" : "complete"}>{failed ? "失败" : "已完成"}</strong>
      <span>结束 {endedAt ? <time dateTime={endedAt}>{new Date(endedAt).toLocaleString("zh-CN", { hour12: false })}</time> : "—"}</span>
      <span>用时 {gameDuration(elapsedMs)}</span>
    </header>
    <dl className="game-benchmark-run-summary-stats" style={{ ...rowStyle, margin: 0 }}>
      {stats.map(([label, value]) => <div key={label} className="game-benchmark-run-summary-stat">
        <dt className="hint">{label}</dt>
        <dd style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}><strong>{value}</strong></dd>
      </div>)}
    </dl>
    <footer className="game-benchmark-run-summary-foot">
      <button type="button" className="unity-btn" onClick={() => void openBenchmarkReview({
        kind: "benchmark-review", queueId, scope, step, label: benchmarkTargetLabel(step), itemUnit,
      }).catch(error => showAppNotice(String(error), "error"))}>查看对照</button>
    </footer>
  </section>;
}

function BenchmarkConfigCards({ step, configs, setConfigs, readOnly, started, completed, changes, fixedSlots, expanded, toggleConfig,
  images, engines, models, currentProgress, latestRunByConfig, resultQueueId, samplePreview, onEdited, refineFilter, guardFilter }: {
  step: Target; configs: BenchmarkConfig[]; setConfigs: Dispatch<SetStateAction<BenchmarkConfig[]>>;
  readOnly: boolean; started?: ReadonlySet<string>; completed?: ReadonlySet<string>;
  changes?: ReturnType<typeof benchmarkRoundChanges>; fixedSlots?: boolean; expanded: ReadonlySet<string>; toggleConfig: (id: string, open: boolean) => void;
  images?: ImageBenchmarkSetup; engines?: BenchmarkConfig["engines"]; models: string[]; currentProgress?: BenchmarkJob["progress"];
  latestRunByConfig?: ReadonlyMap<string, { run: BenchmarkResult }>; resultQueueId?: string; samplePreview?: Record<string, BenchmarkSample>;
  onEdited?: (id: string) => void;
  refineFilter: ReturnType<typeof usePersistedModelFilter>; guardFilter: ReturnType<typeof usePersistedModelFilter>;
}) {
  const mosaicStep = isMosaicStep(step) ? step : undefined;
  const imageStep = !mosaicStep && step !== "screen" && step !== "translate" ? step as ImageBenchmarkStep : undefined;
  const mainRole = imageStep ? imageBenchmarkSteps[imageStep].role : "textScreen";
  const roles = step === "translate" ? benchmarkRoles : ["text"] as const;
  const requiresModel = step === "review";
  const localLabel = step === "translate" || step === "imageTranslate" ? "翻译引擎" : step === "render" ? "本地原位排版" : step === "recognize" ? "本地 OCR" : "本地筛选";
  const [refineModelFilter, setRefineModelFilter] = refineFilter;
  const [refineGuardFilter, setRefineGuardFilter] = guardFilter;
  const update = (id: string, change: (config: BenchmarkConfig) => BenchmarkConfig) => {
    if (readOnly || started?.has(id)) return;
    setConfigs(previous => previous.map(config => config.id === id ? change(config) : config));
    onEdited?.(id);
  };
  const changeMosaic = (id: string, patch: Partial<NonNullable<BenchmarkConfig["mosaic"]>>) => {
    update(id, config => ({ ...config, mosaic: { ...config.mosaic!, ...patch } }));
  };
  const move = (index: number, other: number) => setConfigs(previous => {
    if (readOnly || fixedSlots || started?.has(previous[index].id) || started?.has(previous[other].id)) return previous;
    const next = previous.slice();
    [next[index], next[other]] = [next[other], next[index]];
    return next;
  });
  const index = configs.findIndex(config => expanded.has(config.id));
  const config = configs[index];
  const list = useRef<HTMLUListElement>(null);
  const [listWidth, setListWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem("llmchat-benchmark-config-list-w"));
    return Number.isFinite(saved) && saved >= 200 && saved <= 460 ? saved : 248;
  });
  useEffect(() => {
    try { window.localStorage.setItem("llmchat-benchmark-config-list-w", String(listWidth)); } catch { /* 忽略存储失败 */ }
  }, [listWidth]);
  const listDrag = useRef<{ x: number; width: number } | null>(null);
  const resizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    listDrag.current = { x: event.clientX, width: listWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const resizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = listDrag.current;
    if (!drag) return;
    setListWidth(Math.min(460, Math.max(200, drag.width + event.clientX - drag.x)));
  };
  const resizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    listDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
    event.preventDefault();
    if (event.key === "Home") { setListWidth(248); return; }
    setListWidth(width => Math.min(460, Math.max(200, width + (event.key === "ArrowLeft" ? -16 : 16))));
  };
  useLayoutEffect(() => {
    const scroller = list.current;
    const selected = scroller?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!scroller || !selected) return;
    const row = selected.getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    if (row.top < bounds.top) scroller.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom) scroller.scrollTop += row.bottom - bounds.bottom;
  }, [config?.id, index]);
  const runStateOf = (id: string): "running" | "done" | "failed" | "stopped" | "idle" => {
    if (currentProgress?.configId === id && !completed?.has(id)) return "running";
    const run = latestRunByConfig?.get(id)?.run;
    if (run?.status === "已中止" || run?.status === "已暂停") return "stopped";
    if (run) return run.status === "失败" || run.failed > 0 ? "failed" : "done";
    if (completed?.has(id)) return "done";
    if (started?.has(id)) return "stopped";
    return "idle";
  };
  const runStateText = { running: "运行中", done: "已完成", failed: "失败", stopped: "已中止", idle: "未运行" } as const;
  const lastRun = config && latestRunByConfig?.get(config.id)?.run;
  const alreadyStarted = !!config && (started?.has(config.id) ?? false);
  const locked = readOnly || alreadyStarted;
  const finished = config && completed?.has(config.id);
  const modified = config && changes?.changed.has(config.id);
  const differs = config && changes?.different.has(config.id);
  const activeProgress = config && !finished && currentProgress?.configId === config.id ? currentProgress : undefined;
  return <div className="game-benchmark-config-layout" style={{ "--config-list-w": listWidth + "px" } as React.CSSProperties}>
    <ul ref={list} className="game-benchmark-config-list" aria-label="测试配置列表">
      {configs.map((item, itemIndex) => {
        const name = item.label || "配置 " + (itemIndex + 1);
        const state = runStateOf(item.id);
        return <li key={item.id} data-run={state}><button type="button" aria-pressed={item.id === config?.id}
          title={name + " · " + runStateText[state] + (item.enabled === false ? " · 未启用" : "")}
          onClick={() => toggleConfig(item.id, item.id !== config?.id)}>
          <span className={"game-benchmark-config-enabled" + (item.enabled === false ? " is-off" : "")}
            aria-hidden="true" />
          <span className="game-benchmark-item-badge">Q{itemIndex + 1}</span>
          <span className="game-benchmark-config-name">{name}</span>
          <span className="game-benchmark-config-state">{runStateText[state]}</span>
        </button></li>;
      })}
    </ul>
    <div className="game-benchmark-config-resizer" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label="拖动调整配置列表宽度" aria-valuenow={listWidth} aria-valuemin={200} aria-valuemax={460}
      onPointerDown={resizeStart} onPointerMove={resizeMove} onPointerUp={resizeEnd} onPointerCancel={resizeEnd}
      onKeyDown={resizeKey} onDoubleClick={() => setListWidth(248)} />
    {config ? <div className="game-benchmark-editor" data-run={runStateOf(config.id)}>
        <fieldset key={config.id + (locked ? ":read" : ":edit")} disabled={locked} className="game-benchmark-item-fields">
        <div className="game-benchmark-editor-head">
          <label className="game-benchmark-switch">
            <input type="checkbox" role="switch" aria-label={"启用第 " + (index + 1) + " 项配置"} checked={config.enabled !== false} disabled={fixedSlots}
              onChange={event => { const enabled = event.target.checked; update(config.id, previous => ({ ...previous, enabled })); }} />
            <span className="game-benchmark-switch-track" aria-hidden="true" />
            <span>启用</span>
          </label>
          <label className="game-benchmark-editor-name">名称
            <input aria-label={"第 " + (index + 1) + " 项名称"} value={config.label}
              onChange={event => update(config.id, previous => ({ ...previous, label: event.target.value }))} />
          </label>
        </div>
        {mosaicStep && config.mosaic && <div className="game-benchmark-toolbar">
          {mosaicStep === "mosaicScreen" && <>
            <label>筛选方式<select value={config.mosaic.detector} onChange={event => changeMosaic(config.id, { detector: event.target.value as MosaicSettings["detector"] })}>
              <option value="anime">分类＋定位</option><option value="grid">方格规则</option>
            </select></label>
            {config.mosaic.detector !== "grid" && <div className="game-benchmark-screening-fields">
              <MosaicScreeningFields value={config.mosaic.screening} disabled={locked}
                onChange={screening => changeMosaic(config.id, { screening })} />
            </div>}
            <label>视觉补检<select value={config.mosaic.screenVisionModel || ""}
              onChange={event => changeMosaic(config.id, { screenVisionModel: event.target.value || undefined })}>
              <option value="">关闭</option>{[...new Set([config.mosaic.screenVisionModel, ...models])].filter((model): model is string => !!model).map(model =>
                <option key={model} value={model}>{model}</option>)}
            </select></label>
            <label>图片处理并发<select value={config.mosaic.concurrency ?? 2} onChange={event => changeMosaic(config.id, { concurrency: Number(event.target.value) })}>
              {[1, 2, 4].map(value => <option key={value}>{value}</option>)}
            </select></label>
          </>}
          {mosaicStep === "mosaicRefine" && <>
            <div className="game-mosaic-model-field">
              <span>候选区域推理模型</span>
              <ModelFilterSelect label="候选区域推理模型" value={config.mosaic.refineModel || "qwen3.5:latest"}
                models={[...new Set([config.mosaic.refineModel || "qwen3.5:latest", ...models])]}
                filter={refineModelFilter} setFilter={setRefineModelFilter} disabled={locked}
                onChange={model => changeMosaic(config.id, { refineModel: model })} />
            </div>
            <div className="game-mosaic-model-field">
              <span>纹理与漏检复核模型</span>
              <ModelFilterSelect label="纹理与漏检复核模型" value={config.mosaic.refineGuardModel || "qwen3-vl:8b-instruct"}
                models={[...new Set([config.mosaic.refineGuardModel || "qwen3-vl:8b-instruct", ...models])]}
                filter={refineGuardFilter} setFilter={setRefineGuardFilter} disabled={locked}
                onChange={model => changeMosaic(config.id, { refineGuardModel: model })} />
            </div>
            <label>并发<select value={config.mosaic.refineConcurrency ?? 1} onChange={event => changeMosaic(config.id, { refineConcurrency: Number(event.target.value) })}>
              {mosaicRefineConcurrencyChoices.map(value => <option key={value} value={value}>{value}</option>)}
            </select></label>
          </>}
          {mosaicStep === "mosaicRedraw" && <>
            <label>重绘模型<select value={config.mosaic.model} onChange={event => {
              const model = event.target.value as MosaicSettings["model"];
              changeMosaic(config.id, { model, steps: mosaicDefaultSteps[model] });
            }}>
              {mosaicModelChoices.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            <label>步数<input type="number" min={1} max={100} value={config.mosaic.steps}
              onChange={event => changeMosaic(config.id, { steps: Math.max(1, Math.min(100, Math.trunc(Number(event.target.value)))) })} /></label>
            <label>保护已识别文字<input type="checkbox" checked={config.mosaic.protect} onChange={event => changeMosaic(config.id, { protect: event.target.checked })} /></label>
          </>}
        </div>}
        {!mosaicStep && roles.filter(role => role === "text" || !!config.models.text.id).map(role => {
          const promptRole: GamePromptScene = step === "translate" ? role : mainRole;
          return <div className="game-benchmark-model" key={role}>
            <label>{step === "translate" ? roleLabels[role] : "处理方式"}<select value={config.models[role].id}
              onChange={event => update(config.id, previous => ({ ...previous, models: { ...previous.models, [role]: { ...previous.models[role], id: event.target.value } } }))}>
              <option value="">{role !== "text" ? "跟随正文模型" : requiresModel ? "请选择模型" : localLabel}</option>
              {[...new Set([...models, config.models[role].id].filter(Boolean))].map(model => <option key={model} value={model}>{model.split("/").at(-1)}</option>)}
            </select></label>
            <label>并发<select disabled={!config.models[role].id} value={config.models[role].lanes}
              onChange={event => update(config.id, previous => ({ ...previous, models: { ...previous.models, [role]: { ...previous.models[role], lanes: Number(event.target.value) } } }))}>
              {[1, 2, 3, 4].map(lanes => <option key={lanes} value={lanes}>{lanes}</option>)}
            </select></label>
            {config.models[role].id && <label>提示词<select value={config.prompts[promptRole] || "builtin:" + promptRole}
              onChange={event => update(config.id, previous => ({ ...previous, prompts: { ...previous.prompts, [promptRole]: event.target.value } }))}>
              {gamePromptCatalog().filter(entry => entry.scene === promptRole).map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select></label>}
          </div>;
        })}
        {(step === "filter" || step === "recognize" || step === "refine") && !config.models.text.id && <div className="game-benchmark-toolbar">
          {step === "filter" ? <label>筛选策略<select value={config.imageStrategy || "staged"}
            onChange={event => update(config.id, previous => ({ ...previous, imageStrategy: event.target.value as BenchmarkConfig["imageStrategy"] }))}>
            <option value="staged">分级快速筛选</option><option value="full">完整范围筛选</option>
          </select></label> : <label>{step === "refine" ? "本地模型" : "识别模式"}<select value={config.imageMode || (step === "refine" ? "precise" : "fast")}
            onChange={event => update(config.id, previous => ({ ...previous, imageMode: event.target.value as BenchmarkConfig["imageMode"] }))}>
            {(step === "refine" ? LOCAL_REFINE_MODELS : OCR_MODE_OPTIONS).map(option => <option key={option.id} value={option.id}>{option.title}</option>)}
          </select></label>}
          <label>本地并发<select value={config.localLanes || 1}
            onChange={event => update(config.id, previous => ({ ...previous, localLanes: Number(event.target.value) }))}>
            {(step === "refine" ? [1, 2, 3, 4] : [1, 2, 3, 4, 6, 8]).map(value => <option key={value} value={value}>{value}</option>)}
          </select></label>
        </div>}
        {(step === "translate" || step === "imageTranslate") && !config.models.text.id && <div className="game-benchmark-toolbar" role="group" aria-label="翻译引擎">
          {(config.engines || images?.engines || engines || []).map(engine => <label key={engine.id}>{engine.id}
            <input type="checkbox" checked={engine.enabled} onChange={event => {
              const enabled = event.target.checked;
              update(config.id, previous => ({ ...previous, engines: (previous.engines || images?.engines || engines || [])
                .map(item => item.id === engine.id ? { ...item, enabled } : item) }));
            }} />
          </label>)}
        </div>}
        {step === "recognize" && config.models.text.id && <label className="unity-inline-check">用 Manga OCR 复读日文竖排<input type="checkbox" checked={(config.imageMode || images?.mode) === "manga"}
          onChange={event => update(config.id, previous => ({ ...previous, imageMode: event.target.checked ? "manga" : "precise" }))} /></label>}
        {(step === "refine" || step === "recognize" && images?.confidence !== undefined) && <div className="game-benchmark-toolbar"><label>置信度阈值（%）
          <input type="number" min={0} max={100} value={config.imageConfidence ?? (step === "refine" ? images?.refineConfidence : images?.confidence) ?? 50}
            onChange={event => update(config.id, previous => ({ ...previous, imageConfidence: Math.min(100, Math.max(0, Number(event.target.value))) }))} />
        </label></div>}
        {!mosaicStep && <div className="game-benchmark-toolbar">
          {step !== "render" && <><label>原文语言<select value={config.source} onChange={event => update(config.id, previous => ({ ...previous, source: event.target.value }))}>
            <option value="auto">自动检测</option>{UNITY_LANGUAGES.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}
          </select></label>
          <label>目标语言<select value={config.target} onChange={event => update(config.id, previous => ({ ...previous, target: event.target.value }))}>
            {UNITY_LANGUAGES.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}
          </select></label>
          {["translate", "imageTranslate", "review", "screen"].includes(step) && <label>跳过目标语言<input type="checkbox" checked={config.skipTarget} onChange={event => update(config.id, previous => ({ ...previous, skipTarget: event.target.checked }))}/></label>}</>}
          {step === "translate" && <><label>换行处理<select value={config.wrap} onChange={event => update(config.id, previous => ({ ...previous, wrap: event.target.value as BenchmarkConfig["wrap"] }))}>
            <option value="keep">保留换行</option><option value="join">合并后恢复换行</option><option value="natural">大模型自然断行</option>
          </select></label><label>附带上下文<input type="checkbox" checked={config.includeContext} onChange={event => update(config.id, previous => ({ ...previous, includeContext: event.target.checked }))}/></label></>}
        </div>}
        </fieldset>
        {samplePreview?.[config.id] && <p style={{ padding: "0 12px 8px" }}>
          共 {samplePreview?.[config.id].selected} 条 · 正文候选 {samplePreview?.[config.id].text} · 对白候选 {samplePreview?.[config.id].dialogue} · 原样保留 {samplePreview?.[config.id].retained}
          {config.models.dialogue.id && config.models.dialogue.id !== config.models.text.id && samplePreview?.[config.id].dialogue === 0 &&
            <strong> · 此样本测不到专用对白模型</strong>}
        </p>}
        {resultQueueId && lastRun && <BenchmarkTaskRunSummary key={lastRun.performance.taskId} run={lastRun} queueId={resultQueueId} step={step} />}
        <footer className="game-benchmark-editor-foot">
          {started && <span>{finished ? "已执行" : activeProgress ? "运行中" : alreadyStarted ? "已开始" : "未开始"}</span>}
          {differs && <span className="game-benchmark-difference-label">跨轮差异</span>}
          {modified && <span className="game-benchmark-draft-label">未保存</span>}
          {activeProgress ? <span>样本 {activeProgress.sampleCurrent ?? activeProgress.current}/{activeProgress.sampleTotal ?? activeProgress.total}
            {" · 用时 " + gameDuration(activeProgress.configElapsedMs ?? activeProgress.elapsedMs)}
            {activeProgress.failed > 0 && " · 失败 " + activeProgress.failed}</span>
            : <span>上次 {lastRun ? gameDuration(lastRun.performance.elapsedMs) + " · " + lastRun.translated + "/" + lastRun.selected : "—"}</span>}
          {!locked && <span>{started ? "改完点保存，本轮未开始的配置生效" : "改完点保存，下次打开沿用配置"}</span>}
          <div className="game-benchmark-editor-order">
            <button type="button" className="unity-btn" disabled={locked || fixedSlots || index === 0 || started?.has(configs[index - 1].id)} onClick={() => move(index, index - 1)}>上移</button>
            <button type="button" className="unity-btn" disabled={locked || fixedSlots || index === configs.length - 1 || started?.has(configs[index + 1].id)} onClick={() => move(index, index + 1)}>下移</button>
            <button type="button" className="unity-btn" disabled={locked || fixedSlots} onClick={() => {
              setConfigs(previous => previous.filter(item => item.id !== config.id));
              toggleConfig(config.id, false);
            }}>移除</button>
          </div>
        </footer>
      </div> : <p className="game-benchmark-editor-empty hint">从左侧选一条配置</p>}
  </div>;
}

function BenchmarkTaskView({ job, number, parameters, configs, changes, setConfigs, models, latestRunByConfig, saving, canSave, onSave, onExit }: {
  job: BenchmarkJob; number: number; parameters: BenchmarkTaskConfig; configs: BenchmarkConfig[];
  setConfigs: Dispatch<SetStateAction<BenchmarkConfig[]>>; models: string[]; saving: boolean; canSave: boolean; changes: ReturnType<typeof benchmarkRoundChanges>;
  latestRunByConfig: ReadonlyMap<string, { run: BenchmarkResult }>;
  onSave: () => void; onExit: () => void;
}) {
  const [expanded, setExpanded] = useState(() => new Set(configs[0] ? [configs[0].id] : []));
  const refineFilter = useState(defaultModelFilter);
  const guardFilter = useState(defaultModelFilter);
  const editing = canEditBenchmarkTask(job);
  const running = job.status === "运行中";
  const started = useMemo(() => new Set(job.startedConfigIds), [job.startedConfigIds]);
  const completed = useMemo(() => new Set(job.completedConfigIds), [job.completedConfigIds]);
  const status = job.status === "已暂停" ? "已中止" : job.status;
  const title = number ? `正在查看任务 Q${number} 的配置` : "正在查看任务配置";
  const template = configs[0] ?? parameters.configs[0];
  return <BenchmarkSection title="任务测试配置" className="game-benchmark-show-section">
    <div className="game-benchmark-show-head">
      <div><strong>{job.label}</strong>
        <p>{title} · 第 {job.round} / {parameters.rounds} 轮（{status}{!editing ? " · 只读" : ""}）</p></div>
      <div className="game-benchmark-show-actions">
        <button type="button" className={`unity-btn${canSave && !saving ? " is-primary" : ""}`} disabled={!canSave || saving} onClick={onSave}>保存</button>
        <button type="button" className="unity-btn" disabled={saving} onClick={onExit}>退出显示</button>
      </div>
    </div>
    {job.status === "已暂停" && <p className="hint">可修改本轮未开始的配置。{parameters.fixedSlots ? "各轮使用相同的配置项和顺序。" : "本轮已开始的配置只读。"}</p>}
    {changes.different.size > 0 && <p className="game-benchmark-round-warning" role="status">
      第 {job.round} 轮有 {changes.different.size} 项参数与前面轮次不同。{changes.needsConfirmation.size > 0 && "保存修改前需再次确认。"}
    </p>}
    {changes.removed > 0 && <p className="hint">已移除 {changes.removed} 项配置，尚未保存。</p>}
    <div className="game-benchmark-toolbar game-benchmark-show-parameters">
      <label>循环轮次 <input type="number" value={parameters.rounds} disabled /></label>
      <span className="hint">样本上限 {parameters.sampleLimit || "不限"}</span>
      {parameters.sampleSetPath && <span className="hint" title={parameters.sampleSetPath}>已标注样本集</span>}
      {editing && !started.size && !parameters.fixedSlots && <button type="button" className="unity-btn" disabled={saving || !template} onClick={() => {
        const config = { ...structuredClone(template), id: crypto.randomUUID(), label: "配置 " + (configs.length + 1), enabled: true };
        setConfigs(previous => [...previous, config]);
        setExpanded(new Set([config.id]));
      }}>添加配置</button>}
    </div>
    <BenchmarkConfigCards step={job.step} configs={configs} setConfigs={setConfigs} readOnly={!editing || saving}
      started={started} completed={completed} changes={changes} fixedSlots={parameters.fixedSlots} expanded={expanded} toggleConfig={(id, open) => setExpanded(previous => {
        if (previous.has(id) === open) return previous;
        return open ? new Set([id]) : new Set();
      })} models={models} currentProgress={running && job.progress?.round === job.round ? job.progress : undefined}
      latestRunByConfig={latestRunByConfig} resultQueueId={job.id} refineFilter={refineFilter} guardFilter={guardFilter} />
  </BenchmarkSection>;
}

function StandaloneBenchmarkHistory({ snapshot, setupError, control }: {
  snapshot: BenchmarkSnapshot; setupError?: string; control?: BenchmarkPageInput["control"];
}) {
  const archive = useBenchmarkArchive(snapshot.historyRevision);
  const headerTools = useContext(BenchmarkHeader);
  const [recordMode, setRecordMode] = useRememberedBenchmarkChoice(recordModeKey, "test", ["test", "formal"]);
  return <section className="game-benchmark-game">
    {headerTools && createPortal(<RunRecordTabs mode={recordMode} onChange={setRecordMode} />, headerTools)}
    <div className="game-benchmark-scroll"><div className="game-text-benchmark">
      {setupError && <p className="unity-offline-error" role="alert">{setupError}</p>}
      {recordMode === "test" && snapshot.jobs.some(job => job.status !== "完成") &&
        <BenchmarkSection title="当前任务队列" className="game-benchmark-queue">
          <BenchmarkQueueContents snapshot={snapshot} onControl={control} />
        </BenchmarkSection>}
      <BenchmarkRunRecords key={recordMode} archive={archive} snapshot={snapshot} formal={recordMode === "formal"} />
    </div></div>
  </section>;
}

function BenchmarkRunRecords({ archive, snapshot, formal = false, projectScope, onContinue }: {
  archive: ReturnType<typeof useBenchmarkArchive>; snapshot: BenchmarkSnapshot; formal?: boolean; projectScope?: string;
  onContinue?: (reference: ArchivedBenchmarkRef) => Promise<unknown>;
}) {
  const formalArchive = useBenchmarkArchive(snapshot.historyRevision, true, formal);
  const { records: history, loading: historyLoading, error: historyError, refresh: refreshHistory } = formal ? formalArchive : archive;
  const title = formal ? "正式记录" : "测试记录";
  const tasks = useMemo(() => groupBenchmarkTasks(formal ? history : benchmarkHistoryForRecords(history, snapshot.jobs)), [formal, history, snapshot.jobs]);
  const [referenceRevision, setReferenceRevision] = useState(0);
  useEffect(() => {
    if (!formal) return;
    const refresh = (event: StorageEvent) => {
      if (event.key?.startsWith("llmchat-run-reference:") || event.key === null) setReferenceRevision(value => value + 1);
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [formal]);

  const customReference = useMemo(() => new Map((formal ? tasks : []).map(task => [task.id,
    localStorage.getItem(runReferenceKey(task.id, true)) || undefined])), [tasks, formal, referenceRevision]);
  function setReference(id: string, path?: string) {
    const key = runReferenceKey(id, true);
    if (path) localStorage.setItem(key, path);
    else localStorage.removeItem(key);
    setReferenceRevision(value => value + 1);
  }
  const [recordStep, setRecordStep] = useState<BenchmarkRecordStep>();
  const [recordStatus, setRecordStatus] = useState(allBenchmarkRecordStatuses);
  const [recordRange, setRecordRange] = useState<"1" | "7" | "30" | "all">("7");
  const recordToday = new Date();
  const dayStart = new Date(recordToday.getFullYear(), recordToday.getMonth(), recordToday.getDate()).getTime();
  const filteredTasks = useMemo(() => {
    const firstDay = new Date(dayStart);
    const nextDay = new Date(dayStart);
    if (recordRange !== "all") firstDay.setDate(firstDay.getDate() - (Number(recordRange) - 1));
    nextDay.setDate(nextDay.getDate() + 1);
    return tasks.filter(task => {
      const run = task.runs[0].performance;
      if (!matchesBenchmarkRecordStep(recordStep, archivedBenchmarkStep(formal ? formalRecordStep(run) : run.step))) return false;
      if (recordRange !== "all") {
        const time = Date.parse(task.firstTime);
        if (!(time >= firstDay.getTime() && time < nextDay.getTime())) return false;
      }
      return matchesBenchmarkRecordStatus(task, recordStatus);
    });
  }, [tasks, formal, recordStep, recordStatus, recordRange, dayStart]);
  const taskDays = useMemo(() => {
    const days = new Map<string, { date: Date | null; records: typeof tasks }>();
    for (const task of [...filteredTasks].sort((left, right) => (Date.parse(right.firstTime) || 0) - (Date.parse(left.firstTime) || 0))) {
      const date = new Date(task.firstTime);
      const day = Number.isNaN(date.getTime()) ? null : date;
      const key = day ? day.toDateString() : "";
      let group = days.get(key);
      if (!group) { group = { date: day, records: [] }; days.set(key, group); }
      group.records.push(task);
    }
    return days;
  }, [filteredTasks]);
  const recordYesterday = new Date(recordToday);
  recordYesterday.setDate(recordYesterday.getDate() - 1);
  const [restoringRun, setRestoringRun] = useState<string>();
  const continueBatch = async (reference: ArchivedBenchmarkRef) => {
    if (!onContinue) return;
    setRestoringRun(reference.queueId);
    try { await onContinue(reference); }
    catch (error) { showAppNotice(String(error), "error"); }
    finally { setRestoringRun(undefined); }
  };
  return <BenchmarkSection title={title} className="game-benchmark-records game-benchmark-results" action={
   <button type="button" className="unity-btn" disabled={historyLoading} onClick={refreshHistory}>刷新</button>}>
   <div className="game-benchmark-record-filters" role="group" aria-label={title + "筛选"}>
     <BenchmarkRecordStepFilter value={recordStep} onChange={setRecordStep} />
     <BenchmarkRecordStatusFilter value={recordStatus} onChange={setRecordStatus} />
     <select aria-label="时间范围" value={recordRange} onChange={event => setRecordRange(event.target.value as typeof recordRange)}>
       <option value="1">今天</option><option value="7">近 7 天</option>
       <option value="30">近 30 天</option><option value="all">全部</option>
     </select>
     <output aria-live="polite">{filteredTasks.length} 条</output>
   </div>
   <div className="game-benchmark-history-results" tabIndex={0} aria-label={title + "列表"} role="region">
   {historyLoading && <p className="hint" role="status">正在读取{title}…</p>}
   {historyError && <p className="unity-offline-error" role="alert">{historyError}</p>}
   {!historyLoading && !historyError && !filteredTasks.length && <p className="hint">{tasks.length ? `没有符合筛选条件的${title}。` : `暂无${title}。`}</p>}
   {[...taskDays].map(([day, { date, records }]) => <section className="game-benchmark-record-day" key={day}>
     <h4>{date
       ? `${day === recordToday.toDateString() ? "今天 · " : day === recordYesterday.toDateString() ? "昨天 · " : date.getFullYear() !== recordToday.getFullYear() ? date.getFullYear() + "/" : ""}${date.getMonth() + 1}/${date.getDate()}`
       : "日期未记录"}</h4>
   {records.map(task => {
     const first = task.runs[0];
     const { scope: archivedScope, step: archivedStep, benchmark: metadata } = first.performance;
     const taskStep = archivedBenchmarkStep(formal ? formalRecordStep(first.performance) : archivedStep);
     const mosaicTask = !!taskStep && isMosaicStep(taskStep);
     const content = mosaicTask ? "图片去码" : taskStep === "screen" || taskStep === "translate" ? "文本翻译" : "图片翻译";
     const stepName = taskStep ? benchmarkTargetLabel(taskStep) :
       formal ? ({ scan: "扫描资源", scanImages: "扫描图片", mosaic: "图片去码", generate: "生成补丁",
         generateImages: "生成图片补丁", generateMosaic: "生成去码补丁", apply: "应用补丁",
         applyImages: "应用图片补丁", applyMosaic: "应用去码补丁", redraw: "AI 风格重绘" }[archivedStep ?? ""] ?? archivedStep) || "未记录步骤" : "未记录步骤";
     const taskLabel = taskStep ? content + " · " + stepName : stepName;
     const projectPath = formal ? formalRecordProject(archivedScope) : archivedScope?.replace(/(?::text|:images)?:benchmark:(?:text|images|mosaic)$/, "");
     const reference = metadata?.referenceSampleSetPath ?? metadata?.sampleSetPath;
     const selectedReference = customReference.get(task.id);
     const referencePath = selectedReference ?? (typeof reference === "string" ? reference : undefined);
     const inputSet = typeof metadata?.sampleSetPath === "string" ? metadata.sampleSetPath : undefined;
     const config = metadata?.config as BenchmarkConfig | undefined;
     const sampleUnit = taskStep === "screen" || taskStep === "translate" ? "条" : "张";
     const sampleScope = inputSet ? filename(inputSet.replace(/[\\/]manifest\.json$/i, "")) :
       taskStep === "mosaicRefine" ? "工程初筛快照" :
       mosaicTask && config?.mosaic?.selection === "all" ? "工程全部可用图片" :
       sampleUnit === "条" ? "工程已勾选文本" : "工程已勾选图片";
     const sampleLimit = typeof metadata?.sampleLimit === "number" ? metadata.sampleLimit : undefined;
     const referenceName = referencePath ? filename(referencePath.replace(/[\\/]manifest\.json$/i, "")) :
       formal ? "未选择" : sampleScope;
     const referenceDetails = [referencePath, referencePath !== inputSet ? sampleScope : undefined,
       sampleLimit === undefined ? undefined : sampleLimit > 0 ? "样本上限 " + sampleLimit + " " + sampleUnit : "样本不限"]
       .filter(Boolean).join("\n");
     const total = task.planned ? task.rounds * task.configs : task.runs.length;
     const incomplete = task.stopped > 0 || task.completed < total;
     const tone = task.failed ? "failure" : incomplete ? "incomplete" : "complete";
     const stoppedLabel = task.runs.some(run => run.status === "已中止") ? "已中止" : "已暂停";
     const status = task.failed ? `含 ${task.failed} 项失败` : incomplete
       ? task.stopped ? stoppedLabel : "未完成" : "全部完成";
     const scoringStep = taskStep === "mosaicScreen" || taskStep === "mosaicRefine";
     const canCompareDataset = scoringStep && task.runs.some(run => run.performance.formalRun?.imageDetails);
     const canCompare = task.runs.length > 1 || (formal ? canCompareDataset : scoringStep && typeof reference === "string");
     const openComparison = () => {
       void openBenchmarkReview({ kind: "benchmark-review", queueId: task.id,
         scope: archivedScope, step: archivedStep, label: taskLabel, itemUnit: sampleUnit, formal })
         .catch(error => showAppNotice(String(error), "error"));
     };
     return <details key={task.id} className={`game-benchmark-record-task is-${tone}`}>
     <summary>
       <span className="game-benchmark-record-main">
         <strong>{stepName}</strong>
         <span className="game-benchmark-record-tags">
           <span className="game-benchmark-record-status">{status}</span>
           <span>{task.rounds} 轮</span>
           <span>{task.configs} 个配置</span>
           <span>{first.selected} {sampleUnit}</span>
         </span>
       </span>
       <span className="game-benchmark-record-result">
         <strong>{task.completed}/{total}</strong>
         <span className="game-benchmark-record-meta">
           {date && <time dateTime={task.firstTime}>{new Date(task.firstTime).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })}</time>}
           {canCompare ? <span className="game-benchmark-record-compare">
             {date && " · "}<button type="button" onClick={event => { event.preventDefault(); openComparison(); }}>打开对照</button>
           </span> : <span>{date && " · "}{incomplete ? "已停止" : "查看记录"}</span>}
         </span>
       </span>
     </summary>
     <div className="game-benchmark-record-runs">
     <dl className="game-benchmark-record-context">
       <div><dt>步骤</dt><dd title={taskLabel}>{stepName}</dd></div>
       <div><dt>工程</dt><dd title={projectPath}>{projectPath ? filename(projectPath) : "未记录"}</dd></div>
       {!formal ? <div><dt>对照集</dt><dd title={referenceDetails || referenceName}>{referenceName}</dd></div> :
         mosaicTask && <div><dt>对照集</dt><dd className="game-benchmark-record-reference">
           <span title={referenceDetails || referenceName}>{referenceName}</span>
           {canCompareDataset && isTauri() && <button type="button" className="unity-btn" onClick={() =>
             void pickRunReference(referencePath).then(path => { if (path) setReference(task.id, path); })
               .catch(error => showAppNotice(String(error), "error"))}>{referencePath ? "更换" : "选择"}</button>}
           {selectedReference && <button type="button" className="unity-btn" onClick={() => setReference(task.id)}>恢复默认</button>}
         </dd></div>}
     </dl>
     {canCompare && <button type="button" className="unity-btn is-secondary" onClick={openComparison}>{formal ? "正式结果对照" : "测试结果对照"}（{task.runs.length} 项）</button>}
      {taskStep && isMosaicStep(taskStep) && task.continuation && !snapshot.jobs.some(job => job.id === task.id) &&
        (onContinue && projectScope && archivedScope === projectScope + ":benchmark:mosaic"
          ? <button type="button" className="unity-btn" disabled={!!restoringRun || snapshot.stopping}
              onClick={() => void continueBatch({ queueId: task.id, step: taskStep })}>继续此任务</button>
          : <p className="hint">打开对应的游戏工程后可继续此任务。</p>)}
     {formal && (taskStep === "mosaicScreen" || taskStep === "mosaicRefine") && !canCompareDataset &&
       <p className="hint">这条记录没有逐图结果，无法计算对照分。</p>}
     {!formal && mosaicTask && task.stopped > 0 && !task.planned &&
       <p className="hint">此记录缺少原批次配置，无法从记录续跑。</p>}
     {task.runs.map((result, index) => {
       const runConfig = result.performance.benchmark?.config as BenchmarkConfig | undefined;
       const parameters = formal ? result.performance.formalRun?.parameters ?? [] : taskStep && runConfig?.models?.text && runConfig.prompts
         ? formatBenchmarkParameters(taskStep, runConfig, { rounds: task.rounds, sampleLimit: 0, annotated: !!inputSet })
           .filter(parameter => parameter.scope === "config")
         : [];
       const failed = result.status === "失败" || result.failed > 0;
       const observed = Object.values(result.performance.models);
       const refine = taskStep === "mosaicRefine";
       const configuredModels = refine ? [runConfig?.mosaic?.refineModel, runConfig?.mosaic?.refineGuardModel]
         : Object.values(runConfig?.models ?? {}).map(model => model.id);
       const configuredNames = configuredModels.filter(Boolean);
       const modelNames = (configuredNames.length ? (refine ? configuredNames : [...new Set(configuredNames)])
         : [...new Set(observed.map(model => model.model))]).map(id => id?.split("/").at(-1));
       const concurrency = [...new Set(parameters.filter(parameter => parameter.label.endsWith("并发")).map(parameter => parameter.value))];
       const lanes = concurrency.length ? concurrency : [...new Set(observed.map(model => model.concurrency))];
       const modelLabel = modelNames.join(refine ? " → " : "、") || result.label;
       const tone = failed ? "failure" : result.status === "完成" ? "complete" : "incomplete";
       return <details key={result.performance.taskId || index} className={failed ? "has-failure" : undefined}>
         <summary className="game-benchmark-run-summary">
           <span className="game-benchmark-run-model" title={result.label}>
             <strong>#{index + 1} {modelLabel}</strong><small>第 {result.round} 轮</small>
           </span>
           <span className="game-benchmark-run-columns">
             <span>{lanes.length > 0 && <><small>并发</small><b>{lanes.join(" / ")}</b></>}</span>
             <span><small>耗时</small><b>{gameDuration(result.performance.elapsedMs)}</b></span>
             <span><small>完成数</small><b>{result.translated}/{result.selected}</b></span>
             <span><b className="game-benchmark-run-badge" data-tone={tone}>{result.status}</b>
               {result.failed > 0 && <small>{result.failed} {sampleUnit}失败</small>}</span>
           </span>
         </summary>
         <BenchmarkDetailRows rows={parameters} fixedLabels />
         {result.detail && <p>{result.detail}</p>}
         <BenchmarkRunMeasurements result={result} formal={formal} />
         <RunPerformanceDetails run={result.performance} source={formal ? "formal" : "benchmark"} />
         {Boolean(result.performance.benchmark?.continuedFrom) && <p className="hint">耗时仅统计续跑阶段。</p>}
         {(result.performance.formalRun?.imageDetails || result.performance.benchmark?.imageDetails === true) && result.performance.taskId &&
           <ImageBenchmarkRunDetails queueId={formal ? result.performance.taskId : task.id} runId={result.performance.taskId} />}
       </details>;
     })}
     </div>
   </details>})}
   </section>)}
   </div>
 </BenchmarkSection>;
}

function GameTextBenchmarkDialog({ scope: textScope, current, screenModel, step, draft, onDraft, enqueue, targetControls,
  requestSelection, imageSetup, mosaicSetup, imageCounts, mosaicCounts, selectedCount, models, snapshot, control, queueContents, archive, recordMode, onRecordModeChange, taskView, taskDialogs }:
  BenchmarkPageInput & { step: Target; draft?: QueueDraft; onDraft: (draft: QueueDraft) => void;
    targetControls: ReactNode; queueContents: ReactNode; archive: ReturnType<typeof useBenchmarkArchive>; recordMode: RunRecordMode;
    onRecordModeChange: (mode: RunRecordMode) => void; taskView: ReactNode; taskDialogs: ReactNode }) {
  const mosaicStep = isMosaicStep(step) ? step : undefined;
  const imageStep = !isMosaicStep(step) && step !== "screen" && step !== "translate" ? step : undefined;
  const images = imageStep ? imageSetup : undefined;
  const scope = images?.scope || textScope;
  const mainRole = imageStep ? imageBenchmarkSteps[imageStep].role : "textScreen";
  const roles = step === "translate" ? benchmarkRoles : ["text"] as const;
  const requiresModel = step === "review";

  const key = "llmchat-game-benchmark:" + scope + (step === "translate" ? "" : ":" + step);
  const [refineModelFilter, setRefineModelFilter] = usePersistedModelFilter("mosaic:refineModel");
  const [refineGuardFilter, setRefineGuardFilter] = usePersistedModelFilter("mosaic:refineGuardModel");
  const capture = (number: number): BenchmarkConfig => {
    const { modelIds, ...settings } = current;
    const id = imageStep ? (images?.steps[imageStep] || "") : (screenModel || "");
    const selectedModels = {} as BenchmarkConfig["models"];
    for (const role of benchmarkRoles) {
      const model = step === "translate" ? modelIds[role] : role === "text" ? id : "";
      selectedModels[role] = { id: model, lanes: modelConcurrency(scope, step === "translate" ? role : mainRole, model || modelIds.text) };
    }
    return { ...settings, ...(mosaicStep && mosaicSetup ? { mosaic: { ...mosaicSetup, sampleLimit: 0, selection: "checked" } } : {}), ...(images ? { source: images.source, target: images.target, skipTarget: images.skipTarget,
      imageMode: imageStep === "refine" ? images.refineMode || "precise" : images.mode, imageStrategy: images.strategy, localLanes: imageStep === "refine" ? images.refineConcurrency || 2 : images.concurrency,
      imageConfidence: imageStep === "refine" ? images.refineConfidence : images.confidence, engines: images.engines } : {}),
      prompts: { ...(images?.prompts || settings.prompts) }, id: crypto.randomUUID(), label: "配置 " + number, models: selectedModels };
  };
  const [saved] = useState<{ configs?: BenchmarkConfig[]; rounds?: number; sampleSetPath?: string; sampleLimit?: number }>(() => {
    try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
  });
  const sampleViewKey = key + ":sample-view";
  const [rememberedSamples] = useState(() => readBenchmarkSampleView(sampleViewKey));
  const [configs, setConfigs] = useState(() => {
    if (draft?.configs) return draft.configs;
    const initial = saved.configs || [capture(1)];
    const selection = rememberedSamples.selection;
    return selection ? initial.map(config => config.mosaic ? { ...config, mosaic: { ...config.mosaic, selection } } : config) : initial;
  });
  const [rounds, setRounds] = useState(draft?.rounds || String(saved.rounds || 1));
  const [sampleLimit, setSampleLimit] = useState(draft?.sampleLimit ?? rememberedSamples.sampleLimit ?? saved.sampleLimit ?? configs[0]?.mosaic?.sampleLimit ?? 0);
  const sampleSetKey = "llmchat-annotated-image-samples:" + textScope;
  const [sampleSetPath,setSampleSetPath] = useState(() => draft?.sampleSetPath ?? rememberedSamples.sampleSetPath ?? saved.sampleSetPath ?? readViewPreference(sampleSetKey) ?? "");
  const [useSampleSet,setUseSampleSet] = useState(() => draft?.useSampleSet ?? rememberedSamples.useSampleSet ?? !!saved.sampleSetPath);
  const [browseSampleSet,setBrowseSampleSet] = useState(false);
  const sampleSetMode = !!(imageStep || mosaicStep) && useSampleSet;
  const chooseSampleSet = (path: string) => {
    setSampleSetPath(path);
    writeViewPreference(sampleSetKey, path);
    setUseSampleSet(true);
  };
  const [savedQueue, setSavedQueue] = useState(() =>
    saved.configs ? JSON.stringify({ configs: saved.configs, rounds: saved.rounds || 1, sampleLimit: saved.sampleLimit, sampleSetPath: saved.sampleSetPath }) : "");
  const [expanded, setExpanded] = useState(() => new Set(configs[0] ? [configs[0].id] : []));
  const { records: history } = archive;
  const [samplePreview, setSamplePreview] = useState<Record<string, BenchmarkSample>>({});
  const [checking, setChecking] = useState(false);
  const [selectionCount, setSelectionCount] = useState(selectedCount);
  const [adding, setAdding] = useState(false);
  const planFile = useRef<HTMLInputElement>(null);
  const headerTools = useContext(BenchmarkHeader);
  const moreId = useId();
  const taskTitleId = useId();
  const morePanel = useRef<HTMLDivElement>(null);
  async function importTaskPlan(file: File) {
    if (!mosaicSetup || adding) return;
    setAdding(true);
    try {
      const requests = readMosaicTaskPlan(await file.text(), textScope, current, mosaicSetup, models)
        .map(request => ({ ...request, priority: false }));
      await enqueue(requests);
      showAppNotice("已导入 " + requests.length + " 个测试任务");
    } catch (error) {
      showAppNotice(error instanceof Error ? error.message : String(error), "error");
    } finally { setAdding(false); }
  }
  const totalRounds = Number(rounds);
  const validRounds = Number.isInteger(totalRounds) && totalRounds >= 1 && totalRounds <= 100;
  const serializeConfigs = (items: BenchmarkConfig[]) =>
    JSON.stringify({ configs: items, rounds: totalRounds, sampleLimit, sampleSetPath: sampleSetMode ? sampleSetPath || undefined : undefined });
  const serialized = serializeConfigs(configs);
  const running = snapshot.running || snapshot.stopping;
  const queueStartIssue = snapshot.jobs.some(job => job.status === "待开始" || job.status === "等待")
    ? undefined : "队列中没有待开始的任务";
  const controlQueueAction = (command: "benchmark-start-queue" | "benchmark-pause-queue") =>
    void control(command).catch(error => showAppNotice(String(error), "error"));
  const currentProgress = snapshot.jobs.find(job => job.status === "运行中" && job.requestScope === textScope && job.step === step)?.progress;
  const configIssue = (config: BenchmarkConfig) => {
    if (!validRounds) return "循环轮次必须为 1 至 100";
    if (sampleSetMode && !sampleSetPath) return "请先选择已标注样本集";
    if (mosaicStep) {
      const options = config.mosaic;
      if (!options) return "缺少去码测试配置";
      if (mosaicStep === "mosaicRefine" && (!options.refineModel || !options.refineGuardModel))
        return "请先选择候选区域推理模型和纹理与漏检复核模型";
      const checked = mosaicStep === "mosaicRefine" || options.selection === "checked";
      if (mosaicStep === "mosaicRedraw") {
        if (!sampleSetMode && !snapshot.formalBusy && !(checked ? mosaicCounts?.redrawChecked : mosaicCounts?.redrawAll)) return "请先为测试图片准备蒙版";
      } else if (!sampleSetMode && !snapshot.formalBusy && !(mosaicStep === "mosaicRefine" ? mosaicCounts?.refineChecked : checked ? mosaicCounts?.checked : mosaicCounts?.all)) {
        return "没有可测试的去码图片，请检查勾选或调整样本范围";
      }
      return "";
    }
    if (!sampleSetMode && !snapshot.formalBusy && !(imageStep ? imageCounts?.[imageStep] : selectionCount))
      return imageStep ? "没有符合当前步骤的图片样本" : "请先勾选要测试的文本";
    if (!config.models.text.id) {
      if (requiresModel) return "请先选择复核模型";
      if ((step === "translate" || step === "imageTranslate") &&
        !(config.engines || images?.engines || current.engines)?.some(engine => engine.enabled)) return "请先选择模型或启用翻译引擎";
    } else if (roles.some(role => config.models[role].id && !models.includes(config.models[role].id))) {
      return "所选模型不可用，请重新选择";
    }
    return "";
  };
  const enabledConfigs = configs.filter(config => config.enabled !== false);
  const issue = !enabledConfigs.length ? "请至少启用一张配置卡" :
    enabledConfigs.map(configIssue).find(Boolean);
  useEffect(() => { onDraft({ configs, rounds, sampleLimit, sampleSetPath, useSampleSet }); }, [configs, rounds, sampleLimit, sampleSetPath, useSampleSet]);
  const saveQueue = (items = configs) => {
    if (!validRounds) return false;
    const next = items === configs ? serialized : serializeConfigs(items);
    if (next === savedQueue) return false;
    localStorage.setItem(key, next);
    setSavedQueue(next);
    return true;
  };
  const replaceWithMosaicRefinePresets = () => {
    const next = createMosaicRefinePresetConfigs(capture(1));
    if (!next.length) return;
    try {
      if (!saveQueue(next)) return;
      setConfigs(next);
      setExpanded(new Set([next[0].id]));
      showAppNotice(`已替换并保存 ${next.length} 组复筛配置`);
    } catch (error) {
      showAppNotice("测试配置保存失败：" + String(error), "error");
    }
  };
  const sampleSettings = configs[0]?.mosaic;
  const sampleSelection = sampleSettings?.selection;
  useEffect(() => {
    writeViewPreference(sampleViewKey, JSON.stringify({ sampleLimit, sampleSetPath, useSampleSet, selection: sampleSelection }));
  }, [sampleViewKey, sampleLimit, sampleSetPath, useSampleSet, sampleSelection]);
  const changeSample = (patch: Pick<Partial<NonNullable<BenchmarkConfig["mosaic"]>>, "selection">) =>
    setConfigs(previous => previous.map(config => config.mosaic ? { ...config, mosaic: { ...config.mosaic, ...patch } } : config));
  const toggleConfig = (id: string, open: boolean) => setExpanded(previous => {
    if (previous.has(id) === open) return previous;
    return open ? new Set([id]) : new Set();
  });
  const runScope = scope + (mosaicStep ? ":benchmark:mosaic" : imageStep ? ":benchmark:images" : ":benchmark:text");
  const inspect = async () => {
    setChecking(true);
    try {
      const selected = await requestSelection();
      setSelectionCount(selected.length);
      setSamplePreview(inspectBenchmarkSample(selected, configs));
    } catch (error) { showAppNotice(String(error), "error"); }
    finally { setChecking(false); }
  };
  const start = async (priority: boolean) => {
    if (adding || issue) return;
    const configsSnapshot = structuredClone(enabledConfigs).map(config => ({ ...config, engines: config.engines || (imageStep ? images?.engines : current.engines) }));
    setAdding(true);
    try {
      await enqueue({ scope: textScope, step, configs: configsSnapshot, rounds: totalRounds, priority, sampleLimit, sampleSetPath: sampleSetMode ? sampleSetPath : undefined });
    } catch (error) {
      showAppNotice(String(error), "error");
    } finally { setAdding(false); }
  };

  const latestRunByConfig = useMemo(() => latestBenchmarkRunsByConfig(history.filter(run =>
    run.performance.scope === runScope && run.performance.step === step)), [history, runScope, step]);
  const scopeDescription = sampleSetMode ? "使用独立样本集，同一任务的所有配置使用同一批样本。"
    : mosaicStep === "mosaicRefine" || imageStep === "refine" ? "复筛测试优先使用正式复筛前的初筛快照。"
    : mosaicStep ? "使用去码工作台的原图和蒙版，结果独立归档。"
    : imageStep ? "当前步骤有 " + (imageCounts?.[imageStep] ?? 0) + " 张可测试图片。测试结果独立归档。"
    : "已勾选 " + selectionCount + " 条文本。测试结果独立归档。";
  const testDraftVisible = recordMode === "test" && !taskView;
  const taskMenu = <>
      <button type="button" className="unity-btn game-benchmark-more-trigger" popoverTarget={moreId}
        aria-controls={moreId} aria-haspopup="dialog" onClick={event => positionWindowPopover(event.currentTarget, morePanel.current)}>更多 ▾</button>
      <div id={moreId} ref={morePanel} className="window-action-popover game-benchmark-more" role="dialog"
        aria-label="更多测试操作" popover="auto">
        {isTauri() && (imageStep || mosaicStep) && <button type="button" className="unity-btn"
          onClick={() => { morePanel.current?.hidePopover(); setBrowseSampleSet(true); }}>查看测试集</button>}
        {step === "translate" && <button type="button" className="unity-btn" disabled={checking || !enabledConfigs.length}
          onClick={() => { morePanel.current?.hidePopover(); void inspect(); }}>检查样本</button>}
        {mosaicSetup && <button type="button" className="unity-btn" disabled={adding}
          title="读取 JSON 配置单，按文件顺序加入测试队列" onClick={() => { morePanel.current?.hidePopover(); planFile.current?.click(); }}>导入配置单</button>}
        {mosaicStep === "mosaicRefine" && <button type="button" className="unity-btn"
          disabled={adding || !validRounds || !mosaicSetup}
          title="替换当前工程的复筛配置并保存，保留循环轮次、样本设置和测试记录"
          onClick={() => { morePanel.current?.hidePopover(); replaceWithMosaicRefinePresets(); }}>替换并保存 24 组对照</button>}
        <button type="button" className="unity-btn" disabled={adding || snapshot.stopping || (!running && !!queueStartIssue)}
          title={running ? undefined : queueStartIssue} onClick={() => {
            morePanel.current?.hidePopover();
            controlQueueAction(running ? "benchmark-pause-queue" : "benchmark-start-queue");
          }}>{running ? "暂停测试队列" : "启动队列"}</button>
      </div>
  </>;
  const toolbar = <>
    {testDraftVisible && <div className="game-benchmark-scope"
      role="group" aria-label="测试范围"
      aria-description={testDraftVisible ? scopeDescription : undefined}>
      {targetControls}
      {testDraftVisible && <div className="game-benchmark-toolbar game-benchmark-sample-tools">
        {(imageStep || mosaicStep) ? <label data-tooltip={sampleSetMode && sampleSetPath ? sampleSetPath : scopeDescription}>
          范围<select value={sampleSetMode ? "annotated" : mosaicStep === "mosaicRefine" ? "checked" : sampleSettings?.selection || "checked"}
            onChange={event => {
              const value = event.target.value;
              setUseSampleSet(value === "annotated");
              if (value === "annotated" && !sampleSetPath) setBrowseSampleSet(true);
              else if (value === "checked" || value === "all") changeSample({ selection: value });
            }}>
            <option value="checked">{mosaicStep ? "去码页已勾选" : "当前项目已勾选"}</option>
            {mosaicStep && mosaicStep !== "mosaicRefine" && <option value="all">当前项目全部可用图片</option>}
            {isTauri() && <option value="annotated">已标注样本集</option>}
          </select>
        </label> : <span className="game-benchmark-scope-static" data-tooltip={scopeDescription}>范围 <b>已勾选文本</b></span>}
        <label>上限<input type="number" min={0} step={1} value={sampleLimit || ""} placeholder="不限"
          title="留空时测试范围内的全部样本" onChange={event => setSampleLimit(Math.max(0, Math.trunc(Number(event.target.value))))} /></label>
      </div>}
    </div>}
    {testDraftVisible && <span className="game-benchmark-header-divider" aria-hidden="true" />}
    <RunRecordTabs mode={recordMode} onChange={onRecordModeChange} />
  </>;
  return <section className={"game-benchmark-game" + (running ? " is-running" : "")}>
    {headerTools && createPortal(toolbar, headerTools)}
    {browseSampleSet && <ImageSampleSetBrowser path={sampleSetPath} onChoose={chooseSampleSet} onClose={() => setBrowseSampleSet(false)} />}
    {mosaicSetup && <input ref={planFile} type="file" accept=".json,application/json" hidden onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) void importTaskPlan(file);
    }} />}
    <div className="game-benchmark-scroll"><div className="game-text-benchmark">
      {adding && <p className="hint" role="status">正在准备样本…</p>}
      {recordMode === "test" ? <>
      <div className="game-benchmark-columns">
      {taskView || <section className="game-benchmark-section game-benchmark-config" aria-labelledby={taskTitleId}>
        <header className="game-benchmark-task-head">
          <div className="game-benchmark-task-actions">
            <h3 id={taskTitleId}>测试任务 <small>· {configs.length} 组</small></h3>
            <div className="game-benchmark-rounds" role="group" aria-label="循环轮次">
              <span>循环轮次</span>
              <button type="button" aria-label="减少轮次" disabled={adding || Number(rounds) <= 1}
                onClick={() => setRounds(String(Math.max(1, Number(rounds) - 1)))}>−</button>
              <input type="number" min={1} max={100} step={1} value={rounds} disabled={adding} aria-label="循环轮次"
                onChange={event => setRounds(event.target.value)} />
              <button type="button" aria-label="增加轮次" disabled={adding || Number(rounds) >= 100}
                onClick={() => setRounds(String(Math.min(100, Number(rounds) + 1)))}>+</button>
            </div>
            <button type="button" className="unity-btn" disabled={!!issue || adding} title={issue}
              onClick={() => void start(true)}>立即开始</button>
            <button type="button" className="unity-btn is-primary" disabled={!!issue || adding} title={issue}
              onClick={() => void start(false)}>加入队列</button>
          </div>
          <div className="game-benchmark-task-manage">
            <button type="button" className="unity-btn" disabled={adding} onClick={() => {
              const config = capture(configs.length + 1);
              if (config.mosaic && sampleSettings) config.mosaic.selection = sampleSettings.selection;
              setConfigs(previous => [...previous, config]);
              toggleConfig(config.id, true);
            }}>添加任务</button>
            <button type="button" className="unity-btn" disabled={!validRounds || serialized === savedQueue}
              onClick={() => {
                try { if (saveQueue()) showAppNotice("任务配置已保存"); }
                catch (error) { showAppNotice("任务配置保存失败：" + String(error), "error"); }
              }}>保存任务配置</button>
            {taskMenu}
          </div>
        </header>
      <BenchmarkConfigCards step={step} configs={configs} setConfigs={setConfigs} readOnly={adding} expanded={expanded}
        toggleConfig={toggleConfig} images={images} engines={current.engines} models={models} currentProgress={currentProgress}
        latestRunByConfig={latestRunByConfig} samplePreview={samplePreview} onEdited={id =>
          setSamplePreview(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)))}
        refineFilter={[refineModelFilter, setRefineModelFilter]} guardFilter={[refineGuardFilter, setRefineGuardFilter]} />
      </section>}
      <BenchmarkSection title="当前任务队列" className={"game-benchmark-queue" + (running ? " is-active" : "")}>
        {queueContents}
      </BenchmarkSection>
      <BenchmarkRunRecords archive={archive} snapshot={snapshot} projectScope={textScope}
         onContinue={reference => control("benchmark-continue-batch", reference)} />
      </div>
      </> : <>
        <BenchmarkRunRecords archive={archive} snapshot={snapshot} formal />
      </>}
    </div></div>
    {taskDialogs}
  </section>;
}
