import { readImageBenchmarkDetails, type ImageBenchmarkDetails } from "../benchmark/imageBenchmarkHistory";
import { readMosaicTaskPlan } from "../benchmark/benchmarkTaskPlan";
import { compareMosaicTaskWithDataset, downloadMosaicTaskReport, type MosaicTaskReport } from "../benchmark/benchmarkMosaicReport";
import { ImageSampleSetBrowser } from "./ImageSampleSetBrowser";
import { defaultModelFilter, ModelFilterSelect, usePersistedModelFilter } from "./ModelFilterSelect";
import { createMosaicRefinePresetConfigs, mosaicBenchmarkSteps, type MosaicBenchmarkStep } from "../gameMosaicBenchmark";
import { readMosaicSettings, type MosaicSettings } from "../gameMosaic";
import { LOCAL_REFINE_MODELS } from "../gameImageScreening";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { benchmarkChannelName, benchmarkHistoryForRecords, requestBenchmarkWindow, type BenchmarkQueueArgument, type BenchmarkQueueCommand } from "../gameBenchmarkWindow";
import { benchmarkRunner, benchmarkSampleCounts, benchmarkTargetLabel, emptyBenchmarkSnapshot, formalBlockingReason, isMosaicBenchmarkStep as isMosaicStep, type BenchmarkTarget as Target, canEditBenchmarkTask, type BenchmarkInput, type BenchmarkJob, type BenchmarkRequest, type BenchmarkSnapshot, type BenchmarkTaskConfig, type BenchmarkTaskDecision } from "../benchmark/benchmarkRunner";
export type { BenchmarkInput, BenchmarkImageSource } from "../benchmark/benchmarkRunner";
import { benchmarkRoles, groupBenchmarkTasks, inspectBenchmarkSample, readGameBenchmarkHistory, type ArchivedBenchmarkRef, type BenchmarkConfig, type BenchmarkResult, type BenchmarkSample } from "../gameTextBenchmark";
import { gameDuration, modelConcurrency, modelServiceTimingLines } from "../gameModelPerformance";
import type { UnityEntry } from "../unityOffline";
import { imageBenchmarkSteps, type ImageBenchmarkStep, type ImageBenchmarkSetup } from "../gameImageBenchmark";
import { gamePromptCatalog, type GamePromptScene } from "../gamePrompts";
import { RunRecordTabs, type RunRecordMode } from "./RunRecordTabs";
import { FormalRunRecords } from "./FormalRunRecords";
import { formatBenchmarkParameters } from "../benchmark/benchmarkParameters";
import { RunComparePanel } from "./RunComparePanel";
import type { BenchmarkCompareRun } from "../benchmark/benchmarkCompare";
import { OCR_MODE_OPTIONS } from "../ocr/modes";
import { UNITY_LANGUAGES } from "../unityTranslation";
import { StepRunningMetrics } from "./GameFlowSequence";
import { showAppNotice } from "./AppNotice";
import { GameDialog, useGameActionConfirm } from "./GameActionConfirm";

const roleLabels = { text: "正文", dialogue: "对白", names: "术语" };
type BenchmarkSetup = Pick<BenchmarkInput, "scope" | "current" | "models" | "screenModel" | "initialPart"> & {
  selectedCount: number; imageSetup?: ImageBenchmarkSetup; mosaicSetup?: MosaicSettings; mosaicRoot?: string;
} & ReturnType<typeof benchmarkSampleCounts>;
type BenchmarkPageInput = BenchmarkSetup & {
  requestSelection: () => Promise<UnityEntry[]>;
  enqueue: (request: BenchmarkRequest | BenchmarkRequest[]) => Promise<unknown>;
  control: (kind: BenchmarkQueueCommand, data?: BenchmarkQueueArgument) => Promise<unknown>;
  snapshot: BenchmarkSnapshot;
  onClose: () => void;
  channel?: BroadcastChannel;
};
type QueueDraft = { configs: BenchmarkConfig[]; rounds: string; sampleLimit: number; sampleSetPath?: string; useSampleSet?: boolean };
const setupFor = (input: BenchmarkInput): BenchmarkSetup => ({
  scope: input.scope, current: input.current, models: input.models, screenModel: input.screenModel,
  initialPart: input.initialPart, selectedCount: input.getWorkload().selected.length,
  mosaicSetup: input.mosaicRoot ? readMosaicSettings(input.mosaicRoot) : undefined, mosaicRoot: input.mosaicRoot,
  imageSetup: input.images?.setup, ...benchmarkSampleCounts(input),
});
const openEvent = "llmchat-open-game-benchmark";
export function openGameTextBenchmark(input: BenchmarkInput) {
  window.dispatchEvent(new CustomEvent(openEvent, { detail: input }));
}

function controlQueue(kind: BenchmarkQueueCommand, data?: BenchmarkQueueArgument, input?: BenchmarkInput) {
  if (kind === "benchmark-start-queue") return benchmarkRunner.startQueue();
  if (kind === "benchmark-pause-queue") return benchmarkRunner.pauseQueue();
  if (kind === "benchmark-continue-batch" && data && typeof data !== "string" && "queueId" in data && input)
    return benchmarkRunner.continueArchivedBatch(input, data);
  if (kind === "benchmark-show-task" && typeof data === "string") return benchmarkRunner.showTask(data);
  if (kind === "benchmark-hide-task" && typeof data === "string") return benchmarkRunner.hideTask(data);
  if (kind === "benchmark-release-task" && typeof data === "string") return benchmarkRunner.releaseTask(data);
  if (data && typeof data !== "string" && "taskId" in data) {
    if (kind === "benchmark-decide-task" && "decision" in data) return benchmarkRunner.decideTask(data.taskId, data.decision, data.configs);
    if (kind === "benchmark-save-task" && "configs" in data && data.configs) return benchmarkRunner.saveTask(data.taskId, data.configs);
    if (kind === "benchmark-set-task-dirty" && "dirty" in data) return benchmarkRunner.setTaskDirty(data.taskId, data.dirty);
  }
  if (kind === "benchmark-restart" && typeof data === "string") return benchmarkRunner.restart(data);
  if (kind === "benchmark-start" && typeof data === "string") benchmarkRunner.start(data);
  if (kind === "benchmark-stop" && typeof data === "string") benchmarkRunner.stop(data);
  if (kind === "benchmark-remove" && typeof data === "string") return benchmarkRunner.remove(data);
  if (kind === "benchmark-cleanup") return benchmarkRunner.cleanup();
}

function LocalGameBenchmark({ input, onClose }: { input: BenchmarkInput; onClose: () => void }) {
  const snapshot = useSyncExternalStore(benchmarkRunner.subscribe, benchmarkRunner.snapshot);
  const setup = useMemo(() => setupFor(input), [input]);
  return <GameBenchmarkPage {...setup} snapshot={snapshot}
    requestSelection={async () => input.getWorkload().selected}
    enqueue={async request => benchmarkRunner.enqueue(input, request)}
    control={async (kind, data) => controlQueue(kind, data, input)} onClose={() => {
      void benchmarkRunner.cleanup().then(onClose).catch(error => showAppNotice(String(error), "error"));
    }} />;
}

export function GameTextBenchmarkHost() {
  const [local, setLocal] = useState<BenchmarkInput>();
  useEffect(() => {
    let active: BenchmarkInput | undefined;
    const restore = (input: BenchmarkInput) => {
      const isCurrent = () => active === input;
      void benchmarkRunner.restoreLatestArchivedBatch(input, isCurrent).catch(error => {
        if (isCurrent()) showAppNotice("恢复中止的测试失败：" + String(error), "error");
      });
    };
    if (!isTauri()) {
      const open = (event: Event) => {
        const input = (event as CustomEvent<BenchmarkInput>).detail;
        active = input;
        setLocal(input);
        restore(input);
      };
      window.addEventListener(openEvent, open);
      return () => { active = undefined; window.removeEventListener(openEvent, open); };
    }
    const channel = new BroadcastChannel(benchmarkChannelName);
    let opening: Promise<void> | undefined;
    const open = (event: Event) => {
      if (opening) return;
      const previous = active;
      const input = (event as CustomEvent<BenchmarkInput>).detail;
      active = input;
      opening = invoke<boolean>("open_game_benchmark_window").then(created => {
        if (active !== input) return;
        if (!created) channel.postMessage({ type: "refresh-setup", setup: setupFor(input), snapshot: benchmarkRunner.snapshot() });
        restore(input);
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
        if (message.kind === "benchmark-snapshot") value = benchmarkRunner.snapshot();
        else if (typeof message.kind === "string" && message.kind.startsWith("benchmark-") &&
            message.kind !== "benchmark-enqueue" && message.kind !== "benchmark-continue-batch")
          value = await controlQueue(message.kind, message.data);
        else {
          if (!active) throw new Error("测试队列没有关联的游戏工程");
          if (message.kind === "benchmark-continue-batch") value = await controlQueue(message.kind, message.data, active);
          else if (message.kind === "setup") value = setupFor(active);
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
  return local ? <LocalGameBenchmark key={local.scope} input={local} onClose={() => setLocal(undefined)} /> : null;
}

export function GameTextBenchmarkWindow() {
  const [page, setPage] = useState<{ setup: BenchmarkSetup; channel: BroadcastChannel }>();
  const [snapshot, setSnapshot] = useState(emptyBenchmarkSnapshot);
  const [error, setError] = useState("");
  const closing = useRef<"idle" | "checking" | "allowed">("idle");
  const connection = useRef<BroadcastChannel | null>(null);
  const close = useCallback(async () => {
    if (closing.current !== "idle") return;
    closing.current = "checking";
    try {
      if (connection.current) await requestBenchmarkWindow(connection.current, "benchmark-cleanup");
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
      requestBenchmarkWindow<BenchmarkSetup>(channel, "setup"),
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
  if (!page) return <main className="game-benchmark-page"><p role="status">{error || "正在读取测试队列…"}</p>
    <button type="button" className="unity-btn" onClick={() => void close()}>关闭</button></main>;
  return <GameBenchmarkPage key={page.setup.scope} {...page.setup} channel={page.channel} snapshot={snapshot}
    requestSelection={() => requestBenchmarkWindow(page.channel, "selection")}
    enqueue={request => requestBenchmarkWindow(page.channel, "benchmark-enqueue", request)}
    control={(kind, id) => requestBenchmarkWindow(page.channel, kind, id)} onClose={() => void close()} />;
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

function useBenchmarkArchive(historyRevision: number) {
  const [records, setRecords] = useState<BenchmarkResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void readGameBenchmarkHistory().then(history => { if (active) setRecords(history); })
      .catch(error => { if (active) setError(String(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [historyRevision, reload]);
  return { records, loading, error, refresh: () => setReload(value => value + 1) };
}

function archivedBenchmarkStep(step?: string): Target | undefined {
  return step && (step === "screen" || step === "translate" ||
    Object.hasOwn(mosaicBenchmarkSteps, step) || Object.hasOwn(imageBenchmarkSteps, step)) ? step as Target : undefined;
}

const filename = (path: string) => path.split(/[\\/]/).pop() || path;

function GameBenchmarkPage(props: BenchmarkPageInput) {
  const imageSteps = Object.keys(props.imageSetup?.steps || {}) as ImageBenchmarkStep[];
  const [part, setPart] = useState<"text" | "images" | "mosaic">(
    props.initialPart === "mosaic" && props.mosaicSetup ? "mosaic" : props.initialPart === "images" && imageSteps.length ? "images" : "text");
  const [recordMode, setRecordMode] = useState<RunRecordMode>("test");
  const [textStep, setTextStep] = useState<"translate" | "screen">("translate");
  const [imageStep, setImageStep] = useState<ImageBenchmarkStep>(imageSteps[0] || "recognize");
  const mosaicStepKey = "llmchat-game-benchmark-mosaic-step:" + props.scope;
  const [mosaicStep, setMosaicStep] = useState<MosaicBenchmarkStep>(() => {
    const queued = props.snapshot.jobs.find(job => job.requestScope === props.scope &&
      (job.status === "运行中" || job.status === "已暂停") && isMosaicStep(job.step));
    if (queued && isMosaicStep(queued.step)) return queued.step;
    const saved = localStorage.getItem(mosaicStepKey);
    if (saved && Object.hasOwn(mosaicBenchmarkSteps, saved)) return saved as MosaicBenchmarkStep;
    return props.snapshot.formalJobs.some(job => job.label === "复筛打码图片") ? "mosaicRefine" : "mosaicScreen";
  });
  useEffect(() => { localStorage.setItem(mosaicStepKey, mosaicStep); }, [mosaicStepKey, mosaicStep]);
  const drafts = useRef<Partial<Record<Target, QueueDraft>>>({});
  const step = part === "text" ? textStep : part === "mosaic" ? mosaicStep : imageStep;
  const { jobs, running, stopping, formalBusy, formalJobs, historyRevision } = props.snapshot;
  const archive = useBenchmarkArchive(historyRevision);
  const queue = jobs.filter(job => job.status !== "完成");
  const control = (kind: BenchmarkQueueCommand, id: string) =>
    void props.control(kind, id).catch(error => showAppNotice(String(error), "error"));
  const [taskDraft, setTaskDraft] = useState<{ id: string; parameters: BenchmarkTaskConfig; configs: BenchmarkConfig[] }>();
  const [taskAction, setTaskAction] = useState(false);
  const actionRef = useRef(false);
  const viewerSession = useRef<{ id?: string; control: BenchmarkPageInput["control"]; mounted: boolean }>({ control: props.control, mounted: true });
  viewerSession.current.control = props.control;
  const discard = useGameActionConfirm();
  const showingTaskId = taskDraft?.id;
  const shownJob = showingTaskId ? jobs.find(job => job.id === showingTaskId) : undefined;
  const dirty = useMemo(() => !!taskDraft &&
    JSON.stringify(taskDraft.configs) !== JSON.stringify(taskDraft.parameters.configs), [taskDraft]);
  const canSave = !!shownJob && canEditBenchmarkTask(shownJob) && dirty;
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
    if (shownJob?.status !== "运行中" || dirty) return;
    setTaskDraft(previous => {
      if (!previous?.configs.some(config => config.enabled === false)) return previous;
      const configs = previous.configs.filter(config => config.enabled !== false);
      return { ...previous, parameters: { ...previous.parameters, configs: structuredClone(configs) }, configs };
    });
  }, [shownJob?.status, dirty]);
  const saveTask = () => void actOnTask(async () => {
    if (!taskDraft || !canSave) return;
    await props.control("benchmark-save-task", { taskId: taskDraft.id, configs: taskDraft.configs });
    acknowledgeSave(taskDraft.configs);
    showAppNotice("任务配置已保存");
  });
  const decide = (decision: BenchmarkTaskDecision) => void actOnTask(async () => {
    if (!taskDraft) return;
    const configs = decision === "run" ? taskDraft.configs : undefined;
    await props.control("benchmark-decide-task", { taskId: taskDraft.id, decision, configs });
    if (decision === "run") acknowledgeSave(taskDraft.configs.filter(config => config.enabled !== false));
  });
  const taskView = shownJob && taskDraft && <BenchmarkTaskView key={shownJob.id} job={shownJob} number={queue.indexOf(shownJob) + 1}
    parameters={taskDraft.parameters} configs={taskDraft.configs} setConfigs={setTaskConfigs} models={props.models}
    saving={taskAction} stopping={stopping} canSave={canSave} onSave={saveTask} onExit={exitTask}
    onStop={() => control("benchmark-stop", shownJob.id)} />;
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
    queueContents={<div className="game-benchmark-results">
      {!queue.length && !formalJobs.length && <p className="hint">暂无正在运行或排队的任务。</p>}
      {formalJobs.map(job => <div key={job.id} className="game-benchmark-queue-item" data-status={job.state === "running" ? "运行中" : "等待"} role="status">
        <div><strong>{job.state === "unfinished" ? "正式任务未完成" : "正式任务"} · {job.label}</strong>
          <div className="hint">{job.game}{job.total ? " · " + (job.completed ?? 0) + "/" + job.total : ""}</div>
          {job.detail && job.detail !== job.label && <div className="hint" title={job.detail}>{job.detail}</div>}
        </div>
      </div>)}
      {queue.map((job, index) => {
        const progress = job.progress;
        const heldByPausedTask = jobs[0]?.status === "已暂停" && jobs[0].id !== job.id;
        const statusLabel = job.status === "已暂停" ? "已中止" : job.status;
        const phase = progress?.phase === "prepare" ? "准备样本与模型" :
          progress?.phase === "finish" ? "正在收尾" : "正在处理样本";
        return <div key={job.id} className="game-benchmark-queue-item" data-status={job.status}>
          <div className="game-benchmark-queue-copy">
            <div className="game-benchmark-queue-title">
              <span role="img" aria-label={statusLabel} title={statusLabel} style={{ flex: "0 0 8px", height: 8, borderRadius: "50%",
                background: job.status === "运行中" ? "#3265b6" : job.status === "完成" ? "var(--success)" :
                  job.status === "失败" ? "var(--danger)" : "var(--text-muted)" }} />
              <strong role={job.status === "运行中" ? "status" : undefined} title={progress?.label}>{job.label}</strong>
              <span className="game-flow-metric" style={{ marginInlineStart: "auto" }}>
                {progress?.percent == null ? "—" : progress.percent + "%"}
              </span>
            </div>
            <div style={{ marginInlineStart: "calc(8px + var(--space-2))" }}>
              {stopping && job.status === "运行中" && <div>正在中止并保存…</div>}
              {job.status === "运行中" && progress?.phase === "execute" && <div className="hint">{progress.label}</div>}
              <div className="hint" title={progress?.detail}>
                {job.status === "待开始" ? statusLabel : job.status === "等待" ? (props.snapshot.blockedTaskId === job.id ? "等待保存配置" : !running ? "队列已暂停" : formalBusy ? formalBlockingReason : "等待前一任务") :
                  job.status === "失败" ? job.failure || progress?.detail : progress &&
                  <>{job.status === "运行中" ? progress.sample || phase : statusLabel} · {progress.current}/{progress.total} · {gameDuration(progress.elapsedMs)}
                    {progress.failed > 0 && " · 失败 " + progress.failed}</>}
              </div>
              {job.status === "已暂停" && <div className="hint">{progress?.detail ||
                (job.resumeSamples ? "继续时复用已有样本结果" : "继续时从暂停的配置重新计时")}</div>}
              {progress && (job.status === "运行中" || job.status === "已暂停") &&
                <StepRunningMetrics measured={progress.performance} benchmark={progress}
                  itemUnit={job.step === "screen" || job.step === "translate" ? "条" : "张"}
                  queue={{ position: index + 1, ahead: job.status === "运行中" ? 0 : undefined, startedTime: job.startedTime }} />}
            </div>
          </div>
          <button type="button" className="unity-btn game-benchmark-show-open" aria-pressed={showingTaskId === job.id}
            disabled={taskAction} onClick={() => showTask(job.id)}>显示</button>
          {job.status === "运行中" &&
            <button type="button" className="unity-btn" disabled={stopping} onClick={() => control("benchmark-stop", job.id)}>中止任务</button>}
          {(job.status === "待开始" || job.status === "已暂停") &&
            <button type="button" className="unity-btn" data-tooltip={heldByPausedTask ? "请先处理队首已中止的任务"
              : job.status === "已暂停" ? "从已保存的进度继续" : undefined}
              disabled={stopping || taskAction || heldByPausedTask} onClick={() => control("benchmark-start", job.id)}>
              {job.status === "已暂停" ? "继续任务" : "开始任务"}</button>}
          {job.status === "已暂停" &&
            <button type="button" className="unity-btn" disabled={showingTaskId === job.id} data-tooltip="新建任务，从零重跑"
              onClick={() => control("benchmark-restart", job.id)}>从头运行</button>}
          {job.status !== "运行中" && <button type="button" className="unity-btn" disabled={showingTaskId === job.id}
            data-tooltip={showingTaskId === job.id ? "请先退出显示" : "移出队列，保留测试记录"}
            onClick={() => control("benchmark-remove", job.id)}>移除</button>}
        </div>;
      })}
    </div>}
    targetControls={<div className="game-benchmark-toolbar game-benchmark-target">
      <label>{recordMode === "formal" ? "工作流" : "测试内容"}<select value={part} onChange={event => setPart(event.target.value as typeof part)}>
        <option value="text">翻译文本</option>
        {imageSteps.length > 0 && <option value="images">图片翻译</option>}
        {props.mosaicSetup && <option value="mosaic">图片去码</option>}
      </select></label>
      <label className="game-benchmark-scope-step">步骤{part === "text" ?
        <select value={textStep} onChange={event => setTextStep(event.target.value as typeof textStep)}>
          <option value="screen">筛选文本</option><option value="translate">翻译正文</option>
        </select> : part === "mosaic" ? <select value={mosaicStep} onChange={event => setMosaicStep(event.target.value as MosaicBenchmarkStep)}>
          {Object.entries(mosaicBenchmarkSteps).map(([id, title]) => <option key={id} value={id}>{title}</option>)}
        </select> : <select value={imageStep} onChange={event => setImageStep(event.target.value as ImageBenchmarkStep)}>
          {imageSteps.map(id => <option key={id} value={id}>{imageBenchmarkSteps[id].title}</option>)}
        </select>}</label>
    </div>} />;
}


function BenchmarkConfigCards({ step, configs, setConfigs, readOnly, started = new Set<string>(), expanded, toggleConfig,
  images, engines, models, currentProgress, latestRunByConfig, samplePreview, onEdited, refineFilter, guardFilter }: {
  step: Target; configs: BenchmarkConfig[]; setConfigs: Dispatch<SetStateAction<BenchmarkConfig[]>>;
  readOnly: boolean; started?: ReadonlySet<string>; expanded: ReadonlySet<string>; toggleConfig: (id: string, open: boolean) => void;
  images?: ImageBenchmarkSetup; engines?: BenchmarkConfig["engines"]; models: string[]; currentProgress?: BenchmarkJob["progress"];
  latestRunByConfig?: ReadonlyMap<string, { run: BenchmarkResult }>; samplePreview?: Record<string, BenchmarkSample>;
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
    if (readOnly || started.has(id)) return;
    setConfigs(previous => previous.map(config => config.id === id ? change(config) : config));
    onEdited?.(id);
  };
  const changeMosaic = (id: string, patch: Partial<NonNullable<BenchmarkConfig["mosaic"]>>) => {
    update(id, config => ({ ...config, mosaic: { ...config.mosaic!, ...patch } }));
  };
  const move = (index: number, other: number) => setConfigs(previous => {
    if (readOnly || started.has(previous[index].id) || started.has(previous[other].id)) return previous;
    const next = previous.slice();
    [next[index], next[other]] = [next[other], next[index]];
    return next;
  });
  return configs.map((config, index) => {
        const lastRun = latestRunByConfig?.get(config.id)?.run;
        const alreadyStarted = started.has(config.id);
        const locked = readOnly || alreadyStarted;
        const activeProgress = currentProgress?.configId === config.id ? currentProgress : undefined;
        return <details key={config.id} className={"game-benchmark-item" + (lastRun ? " has-run" : "") + (activeProgress ? " is-running" : "")} open={expanded.has(config.id)}
        onToggle={event => toggleConfig(config.id, event.currentTarget.open)}>
        <summary>
          {activeProgress && <span className="game-benchmark-item-live-dot" aria-hidden="true" />}
          <span className="game-benchmark-item-badge">Q{index + 1}</span>
          <strong>{config.label || "配置 " + (index + 1)}</strong>
          {alreadyStarted && <span className="game-benchmark-show-executed">已执行</span>}
          <span className="game-benchmark-item-model">{mosaicStep && config.mosaic ? mosaicStep === "mosaicScreen"
            ? (config.mosaic.detector === "grid" ? "方格规则" : "分类＋定位") + " · 并发 " + (config.mosaic.concurrency ?? 2)
            : mosaicStep === "mosaicRefine" ? (config.mosaic.refineModel || "").split("/").at(-1)
            : config.mosaic.model === "turbo" ? "Qwen Image 2.1 Turbo" : "Qwen Image Edit 2511"
            : config.models.text.id ? config.models.text.id.split("/").at(-1) + " · 并发 " + config.models.text.lanes : requiresModel ? "未选模型" : localLabel}</span>
          {activeProgress ? <span className="game-benchmark-item-score is-live">
            正在跑 · {activeProgress.sampleCurrent ?? activeProgress.current}/{activeProgress.sampleTotal ?? activeProgress.total} · 用时 {gameDuration(activeProgress.configElapsedMs ?? activeProgress.elapsedMs)}
            {activeProgress.failed > 0 && " · 失败 " + activeProgress.failed}
          </span> : lastRun && <span className="game-benchmark-item-score">上次 {gameDuration(lastRun.performance.elapsedMs)} · {lastRun.translated}/{lastRun.selected}</span>}
        </summary>
        <fieldset key={locked ? "read" : "edit"} disabled={locked} className="game-benchmark-item-fields">
        <div className="game-benchmark-toolbar">
          <label><input type="checkbox" aria-label={"启用第 " + (index + 1) + " 项配置"} checked={config.enabled !== false}
            onChange={event => { const enabled = event.target.checked; update(config.id, previous => ({ ...previous, enabled })); }} />启用</label>
          <input aria-label={"第 " + (index + 1) + " 项名称"} value={config.label} onChange={event => update(config.id, previous => ({ ...previous, label: event.target.value }))} />
          <button type="button" className="unity-btn" disabled={index === 0 || started.has(configs[index - 1].id)} onClick={() => move(index, index - 1)}>上移</button>
          <button type="button" className="unity-btn" disabled={index === configs.length - 1 || started.has(configs[index + 1].id)} onClick={() => move(index, index + 1)}>下移</button>
          <button type="button" className="unity-btn" onClick={() => setConfigs(previous => previous.filter(item => item.id !== config.id))}>移除</button>
        </div>
        {mosaicStep && config.mosaic && <div className="game-benchmark-toolbar">
          {mosaicStep === "mosaicScreen" && <>
            <label>筛选方式<select value={config.mosaic.detector} onChange={event => changeMosaic(config.id, { detector: event.target.value as MosaicSettings["detector"] })}>
              <option value="anime">分类＋定位</option><option value="grid">方格规则</option>
            </select></label>
            <label>视觉补检<select value={config.mosaic.screenVisionModel || ""}
              onChange={event => changeMosaic(config.id, { screenVisionModel: event.target.value || undefined })}>
              <option value="">关闭</option>{[...new Set([config.mosaic.screenVisionModel, ...models])].filter((model): model is string => !!model).map(model =>
                <option key={model} value={model}>{model}</option>)}
            </select></label>
            <label>并发<select value={config.mosaic.concurrency ?? 2} onChange={event => changeMosaic(config.id, { concurrency: Number(event.target.value) })}>
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
              <option>1</option><option>2</option><option>4</option>
            </select></label>
          </>}
          {mosaicStep === "mosaicRedraw" && <>
            <label>重绘模型<select value={config.mosaic.model} onChange={event => changeMosaic(config.id,
              { model: event.target.value as MosaicSettings["model"], steps: event.target.value === "turbo" ? 8 : 20 })}>
              <option value="turbo">Qwen Image 2.1 Turbo</option><option value="2511">Qwen Image Edit 2511</option>
            </select></label>
            <label>步数<input type="number" min={1} max={100} value={config.mosaic.steps}
              onChange={event => changeMosaic(config.id, { steps: Math.max(1, Math.min(100, Math.trunc(Number(event.target.value)))) })} /></label>
            <label><input type="checkbox" checked={config.mosaic.protect} onChange={event => changeMosaic(config.id, { protect: event.target.checked })} />保护已识别文字</label>
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
          {(config.engines || images?.engines || engines || []).map(engine => <label key={engine.id}>
            <input type="checkbox" checked={engine.enabled} onChange={event => {
              const enabled = event.target.checked;
              update(config.id, previous => ({ ...previous, engines: (previous.engines || images?.engines || engines || [])
                .map(item => item.id === engine.id ? { ...item, enabled } : item) }));
            }} />{engine.id}
          </label>)}
        </div>}
        {step === "recognize" && config.models.text.id && <label className="unity-inline-check"><input type="checkbox" checked={(config.imageMode || images?.mode) === "manga"}
          onChange={event => update(config.id, previous => ({ ...previous, imageMode: event.target.checked ? "manga" : "precise" }))} />用 Manga OCR 复读日文竖排</label>}
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
          {["translate", "imageTranslate", "review", "screen"].includes(step) && <label><input type="checkbox" checked={config.skipTarget} onChange={event => update(config.id, previous => ({ ...previous, skipTarget: event.target.checked }))}/>跳过目标语言</label>}</>}
          {step === "translate" && <><label>换行处理<select value={config.wrap} onChange={event => update(config.id, previous => ({ ...previous, wrap: event.target.value as BenchmarkConfig["wrap"] }))}>
            <option value="keep">保留换行</option><option value="join">合并后恢复换行</option><option value="natural">大模型自然断行</option>
          </select></label><label><input type="checkbox" checked={config.includeContext} onChange={event => update(config.id, previous => ({ ...previous, includeContext: event.target.checked }))}/>附带上下文</label></>}
        </div>}
        </fieldset>
        {samplePreview?.[config.id] && <p style={{ padding: "0 12px 8px" }}>
          共 {samplePreview?.[config.id].selected} 条 · 正文候选 {samplePreview?.[config.id].text} · 对白候选 {samplePreview?.[config.id].dialogue} · 原样保留 {samplePreview?.[config.id].retained}
          {config.models.dialogue.id && config.models.dialogue.id !== config.models.text.id && samplePreview?.[config.id].dialogue === 0 &&
            <strong> · 此样本测不到专用对白模型</strong>}
        </p>}
        </details>;
      });
}

function BenchmarkTaskView({ job, number, parameters, configs, setConfigs, models, saving, stopping, canSave, onSave, onExit, onStop }: {
  job: BenchmarkJob; number: number; parameters: BenchmarkTaskConfig; configs: BenchmarkConfig[];
  setConfigs: Dispatch<SetStateAction<BenchmarkConfig[]>>; models: string[]; saving: boolean; stopping: boolean; canSave: boolean;
  onSave: () => void; onExit: () => void; onStop: () => void;
}) {
  const [expanded, setExpanded] = useState(() => new Set(configs[0] ? [configs[0].id] : []));
  const refineFilter = useState(defaultModelFilter);
  const guardFilter = useState(defaultModelFilter);
  const editing = canEditBenchmarkTask(job);
  const running = job.status === "运行中";
  const started = useMemo(() => new Set(job.startedConfigIds), [job.startedConfigIds]);
  const status = job.status === "已暂停" ? "已中止" : job.status;
  const title = number ? `正在查看任务 Q${number} 的配置` : "正在查看任务配置";
  const template = configs[0] ?? parameters.configs[0];
  return <BenchmarkSection title="任务测试配置" className="game-benchmark-show-section">
    <div className="game-benchmark-show-head">
      <div><strong>{job.label}</strong>
        <p>{title}（{status}{!editing ? " · 只读" : ""}）</p></div>
      <div className="game-benchmark-show-actions">
        {running && <button type="button" className="unity-btn" disabled={stopping || saving} onClick={onStop}>中止任务</button>}
        <button type="button" className={`unity-btn${canSave && !saving ? " is-primary" : ""}`} disabled={!canSave || saving} onClick={onSave}>保存</button>
        <button type="button" className="unity-btn" disabled={saving} onClick={onExit}>退出显示</button>
      </div>
    </div>
    {running && <p className="hint">任务运行中，配置不可修改。中止后可编辑未开始的配置。</p>}
    {job.status === "已暂停" && <p className="hint">可修改未开始的配置。已执行的配置保留，只读。</p>}
    <div className="game-benchmark-toolbar game-benchmark-show-parameters">
      <label>循环轮次 <input type="number" value={parameters.rounds} disabled /></label>
      <span className="hint">样本上限 {parameters.sampleLimit || "不限"}</span>
      {parameters.sampleSetPath && <span className="hint" title={parameters.sampleSetPath}>已标注样本集</span>}
      {editing && !started.size && <button type="button" className="unity-btn" disabled={saving || !template} onClick={() => {
        const config = { ...structuredClone(template), id: crypto.randomUUID(), label: "配置 " + (configs.length + 1), enabled: true };
        setConfigs(previous => [...previous, config]);
        setExpanded(previous => new Set([...previous, config.id]));
      }}>添加配置</button>}
    </div>
    <BenchmarkConfigCards step={job.step} configs={configs} setConfigs={setConfigs} readOnly={!editing || saving}
      started={started} expanded={expanded} toggleConfig={(id, open) => setExpanded(previous => {
        if (previous.has(id) === open) return previous;
        const next = new Set(previous);
        if (open) next.add(id); else next.delete(id);
        return next;
      })} models={models} currentProgress={running ? job.progress : undefined}
      refineFilter={refineFilter} guardFilter={guardFilter} />
  </BenchmarkSection>;
}

function GameTextBenchmarkDialog({ scope: textScope, current, screenModel, step, draft, onDraft, enqueue, targetControls,
  requestSelection, imageSetup, mosaicSetup, mosaicRoot, imageCounts, mosaicCounts, selectedCount, models, onClose, channel, snapshot, control, queueContents, archive, recordMode, onRecordModeChange, taskView, taskDialogs }:
  BenchmarkPageInput & { step: Target; draft?: QueueDraft; onDraft: (draft: QueueDraft) => void;
    targetControls: ReactNode; queueContents: ReactNode; archive: ReturnType<typeof useBenchmarkArchive>; recordMode: RunRecordMode;
    onRecordModeChange: (mode: RunRecordMode) => void; taskView: ReactNode; taskDialogs: ReactNode }) {
  const mosaicStep = isMosaicStep(step) ? step : undefined;
  const imageStep = !isMosaicStep(step) && step !== "screen" && step !== "translate" ? step : undefined;
  const images = imageStep ? imageSetup : undefined;
  const scope = images?.scope || textScope;
  const formalStep = mosaicStep ? { mosaicScreen: "screen", mosaicRefine: "refine", mosaicRedraw: "redraw" }[mosaicStep]
    : step === "imageTranslate" ? "translate" : step;
  const formalScope = mosaicStep ? mosaicRoot + ":mosaic:" + formalStep
    : imageStep ? scope + ":images" : textScope + ":text";
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
  const [configs, setConfigs] = useState(() => draft?.configs || saved.configs || [capture(1)]);
  const [rounds, setRounds] = useState(draft?.rounds || String(saved.rounds || 1));
  const [sampleLimit, setSampleLimit] = useState(draft?.sampleLimit ?? saved.sampleLimit ?? configs[0]?.mosaic?.sampleLimit ?? 0);
  const sampleSetKey = "llmchat-annotated-image-samples:" + textScope;
  const [sampleSetPath,setSampleSetPath] = useState(() => draft?.sampleSetPath || saved.sampleSetPath || localStorage.getItem(sampleSetKey) || "");
  const [useSampleSet,setUseSampleSet] = useState(() => draft?.useSampleSet ?? !!saved.sampleSetPath);
  const [browseSampleSet,setBrowseSampleSet] = useState(false);
  const sampleSetMode = !!(imageStep || mosaicStep) && useSampleSet;
  const chooseSampleSet = (path: string) => {
    setSampleSetPath(path);
    localStorage.setItem(sampleSetKey,path);
    setUseSampleSet(true);
  };
  const [savedQueue, setSavedQueue] = useState(() =>
    saved.configs ? JSON.stringify({ configs: saved.configs, rounds: saved.rounds || 1, sampleLimit: saved.sampleLimit, sampleSetPath: saved.sampleSetPath }) : "");
  const [expanded, setExpanded] = useState(() => new Set(configs[0] ? [configs[0].id] : []));
  const { records: history, loading: historyLoading, error: historyError, refresh: refreshHistory } = archive;
  const [comparison, setComparison] = useState<{ runs: readonly BenchmarkCompareRun[]; itemUnit: "条" | "张"; loading?: boolean; qualityError?: string }>();
  const closeComparison = useCallback(() => setComparison(undefined), []);
  const [samplePreview, setSamplePreview] = useState<Record<string, BenchmarkSample>>({});
  const [checking, setChecking] = useState(false);
  const [selectionCount, setSelectionCount] = useState(selectedCount);
  const [adding, setAdding] = useState(false);
  const planFile = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<{ data?: MosaicTaskReport; error?: string }>();
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
  async function showTaskReport(id: string, runs: readonly BenchmarkResult[], reference: string) {
    const request = {};
    setReport(request);
    try {
      const data = await compareMosaicTaskWithDataset(id, runs, reference);
      setReport(current => current === request ? { data } : current);
    } catch (error) {
      setReport(current => current === request ? { error: error instanceof Error ? error.message : String(error) } : current);
    }
  }
  async function compareTask(id: string, runs: readonly BenchmarkResult[], reference: unknown, taskStep: Target | undefined) {
    const loading = (taskStep === "mosaicScreen" || taskStep === "mosaicRefine") && typeof reference === "string";
    const itemUnit = taskStep === "translate" || taskStep === "screen" ? "条" as const : "张" as const;
    const opened = { runs, loading, itemUnit };
    setComparison(opened);
    if (!loading || typeof reference !== "string") return;
    try {
      const report = await compareMosaicTaskWithDataset(id, runs, reference);
      const byRun = new Map(report.totals.map(row => [row.runId, row]));
      setComparison(current => current === opened ? { itemUnit, runs: runs.map(run => ({
        ...run, quality: run.performance.taskId ? byRun.get(run.performance.taskId) : undefined,
      })) } : current);
    } catch (error) {
      setComparison(current => current === opened ? { runs, itemUnit, qualityError: error instanceof Error ? error.message : String(error) } : current);
    }
  }
  const totalRounds = Number(rounds);
  const validRounds = Number.isInteger(totalRounds) && totalRounds >= 1 && totalRounds <= 100;
  const serializeConfigs = (items: BenchmarkConfig[]) =>
    JSON.stringify({ configs: items, rounds: totalRounds, sampleLimit, sampleSetPath: sampleSetMode ? sampleSetPath || undefined : undefined });
  const serialized = serializeConfigs(configs);
  const running = snapshot.running || snapshot.stopping;
  const queueStartIssue = snapshot.jobs[0]?.status === "已暂停" ? "请先继续已中止的任务"
    : snapshot.jobs.some(job => job.status === "待开始" || job.status === "等待") ? undefined : "请先将任务加入队列";
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
  const changeSample = (patch: Pick<Partial<NonNullable<BenchmarkConfig["mosaic"]>>, "selection">) =>
    setConfigs(previous => previous.map(config => config.mosaic ? { ...config, mosaic: { ...config.mosaic, ...patch } } : config));
  const toggleConfig = (id: string, open: boolean) => setExpanded(previous => {
    if (previous.has(id) === open) return previous;
    const next = new Set(previous);
    if (open) next.add(id); else next.delete(id);
    return next;
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

  const tasks = useMemo(() => groupBenchmarkTasks(benchmarkHistoryForRecords(history, snapshot.jobs)), [history, snapshot.jobs]);
  const [restoringRun, setRestoringRun] = useState<string>();
  const continueBatch = async (reference: ArchivedBenchmarkRef) => {
    setRestoringRun(reference.queueId);
    try { await control("benchmark-continue-batch", reference); }
    catch (error) { showAppNotice(String(error), "error"); }
    finally { setRestoringRun(undefined); }
  };
  const latestRunByConfig = useMemo(() => {
    const latest = new Map<string, { run: BenchmarkResult; finishedAt: number }>();
    for (const run of history) {
      if (run.performance.scope !== runScope || run.performance.step !== step || run.performance.benchmark?.continuedFrom) continue;
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
  }, [history, runScope, step]);
  const page = <main className={"game-benchmark-page" + (running ? " is-running" : "") + (channel ? "" : " game-benchmark-browser-fallback")}>
    <header className="game-benchmark-page-header"><h2>运行记录</h2>
      <div className="game-benchmark-tabs" role="tablist" aria-label="测试模块">
        <button type="button" role="tab" aria-selected="true">运行记录</button>
        <button type="button" role="tab" aria-selected="false" onClick={() => {
          const channel = new BroadcastChannel("llmchat-run-records");
          channel.postMessage({ type: "open-build-speed" });
          channel.close();
        }}>构建测速</button>
      </div>
      <RunRecordTabs mode={recordMode} onChange={onRecordModeChange} />
    </header>
    <div className="game-benchmark-scroll"><div className="game-text-benchmark">
      {recordMode === "test" && !taskView && <div className="game-benchmark-runbar">
        <div className="game-benchmark-scope" role="region" aria-label="测试范围">
        {targetControls}
        <p className="hint" style={{ margin: 0 }}>{sampleSetMode ? "使用独立样本集，同一任务的所有配置使用同一批样本。" : mosaicStep === "mosaicRefine" || imageStep === "refine" ? "复筛测试优先使用正式复筛前的初筛快照。" : mosaicStep ? "使用去码工作台的原图和蒙版，结果独立归档。" : imageStep ? "当前步骤有 " + (imageCounts?.[imageStep] ?? 0) + " 张可测试图片。测试结果独立归档。" : "已勾选 " + selectionCount + " 条文本。测试结果独立归档。"}</p>
        <div className="game-benchmark-toolbar game-benchmark-sample-tools">
        {(imageStep || mosaicStep) ? <><label>样本范围<select value={sampleSetMode ? "annotated" : mosaicStep === "mosaicRefine" ? "checked" : sampleSettings?.selection || "checked"}
          onChange={event => {
            const value = event.target.value;
            setUseSampleSet(value === "annotated");
            if (value === "annotated" && !sampleSetPath) setBrowseSampleSet(true);
            else if (value === "checked" || value === "all") changeSample({ selection: value });
          }}>
          <option value="checked">{mosaicStep ? "去码页已勾选" : "当前项目已勾选"}</option>
          {mosaicStep && mosaicStep !== "mosaicRefine" && <option value="all">当前项目全部可用图片</option>}
          {isTauri() && <option value="annotated">已标注样本集</option>}
        </select></label>
        {isTauri() && <button type="button" className="unity-btn" onClick={() => setBrowseSampleSet(true)}>查看测试集</button>}
        {sampleSetMode && sampleSetPath && <span className="hint" title={sampleSetPath}>
          {sampleSetPath.replaceAll("\\\\", "/").split("/").slice(-2,-1)[0] || sampleSetPath}
        </span>}
        </> : <span className="hint">样本范围 · 当前项目已勾选文本</span>}
        <label>样本上限<input type="number" min={0} step={1} value={sampleLimit || ""} placeholder="不限"
          title="留空时测试范围内的全部样本" onChange={event => setSampleLimit(Math.max(0, Math.trunc(Number(event.target.value))))} /></label>
        {step === "translate" && <button type="button" className="unity-btn game-benchmark-inspect" disabled={checking || !enabledConfigs.length} onClick={() => void inspect()}>检查样本</button>}
        </div>
        {browseSampleSet && <ImageSampleSetBrowser path={sampleSetPath} onChoose={chooseSampleSet} onClose={() => setBrowseSampleSet(false)} />}
        </div>
        <div className="game-benchmark-task-actions">
        <button type="button" className={running ? "unity-btn" : "settings-panel-save"}
          disabled={adding || snapshot.stopping || (!running && !!queueStartIssue)}
          title={running ? undefined : queueStartIssue}
          onClick={() => controlQueueAction(running ? "benchmark-pause-queue" : "benchmark-start-queue")}>
          {running ? "暂停测试队列" : "启动队列"}
        </button>
        <button type="button" className="unity-btn" disabled={!!issue || adding} title={issue} onClick={() => void start(false)}>加入队列</button>
        {mosaicSetup && <>
          <button type="button" className="unity-btn" disabled={adding}
            title="读取 JSON 配置单，按文件顺序加入测试队列" onClick={() => planFile.current?.click()}>导入配置单</button>
          <input ref={planFile} type="file" accept=".json,application/json" hidden onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void importTaskPlan(file);
          }} />
        </>}
        <span role="status">{adding && "正在准备样本…"}</span>
        </div>
      </div>}
      {recordMode === "test" ? <>
      <div className="game-benchmark-columns">
      {taskView || <BenchmarkSection title="测试配置" action={
        <button type="button" className="unity-btn game-benchmark-start-here" disabled={!!issue || adding}
          title={issue} onClick={() => void start(true)}>立即开始任务</button>}>
        <div className="game-benchmark-toolbar">
          <label>循环轮次 <input type="number" min={1} max={100} step={1} value={rounds} disabled={adding} onChange={event => setRounds(event.target.value)} /></label>
          <button type="button" className="unity-btn" disabled={adding} onClick={() => {
            const config = capture(configs.length + 1);
            if (config.mosaic && sampleSettings) config.mosaic.selection = sampleSettings.selection;
            setConfigs(previous => [...previous, config]);
            toggleConfig(config.id, true);
          }}>添加配置</button>
          {mosaicStep === "mosaicRefine" && <button type="button" className="unity-btn"
            disabled={adding || !validRounds || !mosaicSetup}
            title="替换当前工程的复筛配置并保存，保留循环轮次、样本设置和测试记录"
            onClick={replaceWithMosaicRefinePresets}>替换并保存 24 组对照</button>}
        </div>
      <BenchmarkConfigCards step={step} configs={configs} setConfigs={setConfigs} readOnly={adding} expanded={expanded}
        toggleConfig={toggleConfig} images={images} engines={current.engines} models={models} currentProgress={currentProgress}
        latestRunByConfig={latestRunByConfig} samplePreview={samplePreview} onEdited={id =>
          setSamplePreview(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)))}
        refineFilter={[refineModelFilter, setRefineModelFilter]} guardFilter={[refineGuardFilter, setRefineGuardFilter]} />
      </BenchmarkSection>}
      <BenchmarkSection title="当前任务队列" className={"game-benchmark-queue" + (running ? " is-active" : "")}>
        {queueContents}
      </BenchmarkSection>
      <BenchmarkSection title="测试记录" className="game-benchmark-results" action={
        <button type="button" className="unity-btn" disabled={historyLoading} onClick={refreshHistory}>刷新</button>}>
        {historyLoading && <p className="hint" role="status">正在读取测试记录…</p>}
        {historyError && <p className="unity-offline-error" role="alert">{historyError}</p>}
        {!historyLoading && !historyError && !tasks.length && <p className="hint">暂无测试记录。</p>}
        {tasks.map(task => {
          const first = task.runs[0];
          const { scope: archivedScope, step: archivedStep, benchmark: metadata } = first.performance;
          const taskStep = archivedBenchmarkStep(archivedStep);
          const mosaicTask = !!taskStep && isMosaicStep(taskStep);
          const content = mosaicTask ? "图片去码" : taskStep === "screen" || taskStep === "translate" ? "文本翻译" : "图片翻译";
          const taskLabel = taskStep ? content + " · " + benchmarkTargetLabel(taskStep) : "未记录步骤";
          const projectPath = archivedScope?.replace(/(?::text|:images)?:benchmark:(?:text|images|mosaic)$/, "");
          const reference = metadata?.referenceSampleSetPath ?? metadata?.sampleSetPath;
          const inputSet = typeof metadata?.sampleSetPath === "string" ? metadata.sampleSetPath : undefined;
          const config = metadata?.config as BenchmarkConfig | undefined;
          const sampleUnit = taskStep === "screen" || taskStep === "translate" ? "条" : "张";
          const sampleScope = inputSet ? "数据集 · " + filename(inputSet.replace(/[\\/]manifest\.json$/i, "")) :
            taskStep === "mosaicRefine" ? "工程初筛快照" :
            mosaicTask && config?.mosaic?.selection === "all" ? "工程全部可用图片" :
            sampleUnit === "条" ? "工程已勾选文本" : "工程已勾选图片";
          return <details key={task.id} className={"game-benchmark-record-task" + (task.failed ? " has-failure" : "")}>
          <summary><strong>{taskLabel}</strong>{" · "}<span className="game-benchmark-record-date">{task.firstTime && new Date(task.firstTime).toLocaleString("zh-CN", { hour12: false })}</span>
            {task.planned ? task.rounds + " 轮 · " + task.configs + " 个配置 · 已完成 " + task.completed + "/" + task.rounds * task.configs + " 项" :
              "已归档 " + task.runs.length + " 项"}{task.failed > 0 && <strong className="game-benchmark-record-failure"> · {task.failed} 项含失败</strong>}{task.stopped > 0 && ` · ${task.stopped} 项暂停或中止`}
          </summary>
          <div className="game-benchmark-record-runs">
          <p className="hint" title={projectPath}>{projectPath && <>{filename(projectPath)} · </>}{sampleScope} · {first.selected} {sampleUnit}
            {typeof metadata?.sampleLimit === "number" && (metadata.sampleLimit > 0 ? " · 上限 " + metadata.sampleLimit + " " + sampleUnit : " · 样本不限")}
            {typeof reference === "string" && reference !== inputSet && <> · 对照集 {filename(reference.replace(/[\\/]manifest\.json$/i, ""))}</>}
          </p>
          {task.runs.length > 1 ? <button type="button" className="unity-btn is-secondary"
            onClick={() => void compareTask(task.id, task.runs, reference, taskStep)}>
            比较这次记录（{task.runs.length} 项）
          </button> : null}
          {(taskStep === "mosaicScreen" || taskStep === "mosaicRefine") && typeof reference === "string" &&
            <button type="button" className="unity-btn"
              onClick={() => void showTaskReport(task.id, task.runs, reference)}>数据集对照总结</button>}
          {taskStep && isMosaicStep(taskStep) && archivedScope === textScope + ":benchmark:mosaic" &&
            task.continuation && !snapshot.jobs.some(job => job.id === task.id) &&
            <button type="button" className="unity-btn" disabled={!!restoringRun || snapshot.stopping}
              onClick={() => void continueBatch({ queueId: task.id, step: taskStep })}>继续此任务</button>}
          {mosaicTask && task.stopped > 0 && !task.planned &&
            <p className="hint">此记录缺少原批次配置，无法从记录续跑。</p>}
          {task.runs.map((result, index) => {
            const runConfig = result.performance.benchmark?.config as BenchmarkConfig | undefined;
            const parameters = taskStep && runConfig?.models?.text && runConfig.prompts
              ? formatBenchmarkParameters(taskStep, runConfig, { rounds: task.rounds, sampleLimit: 0, annotated: !!inputSet })
                .filter(parameter => parameter.scope === "config")
              : [];
            const failed = result.status === "失败" || result.failed > 0;
            return <details key={result.performance.taskId || index} className={failed ? "has-failure" : undefined}>
          <summary>第 {result.round} 轮 · {result.label} · <span className={failed ? "game-benchmark-record-failure" : undefined}>
            {result.status}{result.failed > 0 ? "（" + result.failed + " " + sampleUnit + "失败）" : ""}</span> · {gameDuration(result.performance.elapsedMs)} · 完成 {result.translated}/{result.selected}</summary>
          {parameters.length > 0 && <dl className="game-benchmark-record-parameters">
            {parameters.map(parameter => <div key={parameter.label}><dt>{parameter.label}</dt><dd>{parameter.value}</dd></div>)}
          </dl>}
          {result.detail && <p>{result.detail}</p>}
          {result.summary && <p>{result.summary}</p>}
          {Boolean(result.performance.benchmark?.continuedFrom) && <p className="hint">耗时仅统计续跑阶段。</p>}
          {result.performance.benchmark?.imageDetails === true && result.performance.taskId &&
            <ImageBenchmarkRunDetails queueId={task.id} runId={result.performance.taskId} />}
          {!!result.unobservedModels.length && <p>未记录模型请求：{result.unobservedModels.map(id => id.split("/").at(-1)).join("、")}</p>}
          {result.performance.wallTiming?.detectorMs !== undefined && <div>检测推理 {(result.performance.wallTiming.detectorMs / 1000).toFixed(2)} 秒</div>}
          {result.performance.wallTiming?.ocrMs !== undefined && <div>本地 OCR {(result.performance.wallTiming.ocrMs / 1000).toFixed(2)} 秒</div>}
          {!!result.performance.cacheHits && <div>结果复用 {result.performance.cacheHits} 次</div>}
          {result.performance.timing?.workflowMs !== undefined && <div>ComfyUI 执行 {(result.performance.timing.workflowMs / 1000).toFixed(2)} 秒</div>}
          {Object.values(result.performance.models).map(model => <div key={model.model + model.concurrency}>
            {model.model.split("/").at(-1)} · 并发 {model.concurrency} · {model.requests} 次 · 纯生成 {model.generationMs ? (model.generationTokens * 1000 / model.generationMs).toFixed(1) : "—"} tok/s · 请求平均 {model.requestMs ? (model.tokens * 1000 / model.requestMs).toFixed(1) : "—"} tok/s
            {model.serviceTiming && modelServiceTimingLines(model.serviceTiming, model.requests, ms => (ms / 1000).toFixed(2) + " 秒")
              .map(line => <div key={line}>{line}</div>)}
          </div>)}
          </details>})}
          </div>
        </details>})}
      </BenchmarkSection>
      </div>
      </> : <>
        <div className="game-benchmark-formal-target">{targetControls}</div>
        <FormalRunRecords scope={formalScope} step={formalStep} />
      </>}
    </div></div>
    {report && <GameDialog title="数据集对照总结" className="game-benchmark-report-dialog"
      onCancel={() => setReport(undefined)}
      description={report.data ? report.data.title + "。未确认样本独立计数，定位框按 IoU ≥ 0.5 一对一匹配。" :
        report.error || "正在读取逐图结果并对照数据集…"}
      details={report.data && <table><thead><tr><th>配置</th><th>轮次</th><th>漏检</th><th>误报</th><th>待复核</th>
        <th>匹配框 / 人工框</th><th>多余框</th><th>未确认判有码</th><th>用时</th></tr></thead>
        <tbody>{report.data.totals.map((row, index) => <tr key={index}>
          <td>{row.label}</td><td>{row.round}</td><td>{row.fn}</td><td>{row.fp}</td><td>{row.review}</td>
          <td>{row.foundBoxes} / {row.expectedBoxes}</td><td>{row.extraBoxes}</td><td>{row.unlabelledPositive}</td><td>{gameDuration(row.seconds * 1000)}</td>
        </tr>)}</tbody></table>}>
      {report.data && <button type="button" className="unity-btn" onClick={() => {
        if (report.data) void downloadMosaicTaskReport(report.data).catch(error => showAppNotice(String(error), "error"));
      }}>下载 Excel</button>}
      <button type="button" className="game-confirm-cancel" onClick={() => setReport(undefined)}>关闭</button>
    </GameDialog>}
    {taskDialogs}
    {comparison && <RunComparePanel {...comparison} onClose={closeComparison} />}
    <footer className="game-benchmark-footer">
    {recordMode === "test" && !taskView && <button type="button" className="unity-btn" disabled={!validRounds || serialized === savedQueue} onClick={() => { try { if (saveQueue()) showAppNotice("测试配置已保存"); } catch (error) { showAppNotice("测试配置保存失败：" + String(error), "error"); } }}>保存配置</button>}
    <button type="button" className="unity-btn" onClick={onClose}>关闭</button>
    </footer>
  </main>;
  return channel ? page : createPortal(page, document.body);
}
