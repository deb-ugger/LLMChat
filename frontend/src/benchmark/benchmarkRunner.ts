import { benchmarkImageInput, type ImageBenchmarkInput } from "./imageBenchmarkHistory";
import { clearMosaicReviews } from "../gameMosaicRefine";
import { clearGameImageRefinement } from "../gameImageScreening";
import { annotatedMosaicSamples, annotatedTextSamples, loadAnnotatedSampleSet } from "./imageSampleSet";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { registerAppCloseGuard } from "../appClose";
import { imageBenchmarkRows, imageBenchmarkSteps, runGameImageSample, type ImageBenchmarkSetup, type ImageBenchmarkStep, type ImageBenchmarkWorkload } from "../gameImageBenchmark";
import { beginGameStep, clearGamePerformance, finishGameStep, flushGamePerformanceArchive, gameDuration, stepPerformance } from "../gameModelPerformance";
import { captureMosaicBenchmark, mosaicBenchmarkSteps, readEmbeddedBenchmarkImage, runMosaicBenchmark, type MosaicBenchmarkStep, type MosaicBenchmarkWorkload } from "../gameMosaicBenchmark";
import { benchmarkRoles, inspectBenchmarkSample, runGameTextBenchmarks, runGameTextScreenSample, type BenchmarkConfig, type BenchmarkStepRunner } from "../gameTextBenchmark";
import type { GameDialoguePage } from "../gameTranslationContext";
import type { UnityEntry, UnityImage, UnityProgress } from "../unityOffline";

export type BenchmarkTarget = "translate" | "screen" | ImageBenchmarkStep | MosaicBenchmarkStep;
export type BenchmarkImageSource = {
  setup: ImageBenchmarkSetup;
  getWorkload: () => ImageBenchmarkWorkload;
  readImage?: (project: NonNullable<ImageBenchmarkWorkload["project"]>, image: UnityImage) => Promise<Blob>;
};
export type BenchmarkInput = {
  scope: string;
  current: Omit<BenchmarkConfig, "id" | "label" | "models"> & { modelIds: Record<typeof benchmarkRoles[number], string> };
  getWorkload: () => { entries: UnityEntry[]; selected: UnityEntry[]; dialoguePages?: GameDialoguePage[] };
  screenModel?: string;
  images?: BenchmarkImageSource;
  initialPart?: "text" | "images" | "mosaic";
  mosaicRoot?: string;
  models: string[];
  onMessage: (text: string, level: "info" | "success" | "error") => void;
};
export type BenchmarkRequest = { scope: string; step: BenchmarkTarget; configs: BenchmarkConfig[]; rounds: number; priority?: boolean; sampleSetPath?: string; sampleLimit?: number };
type BenchmarkProgress = {
  phase: "prepare" | "execute" | "finish";
  label: string;
  current: number;
  total: number;
  sample: string;
  elapsedMs: number;
  percent: number | null;
  failed: number;
  detail?: string;
  configId?: string;
};
export type BenchmarkState = BenchmarkProgress & {
  type: "benchmark-state";
  scope: string;
  step: BenchmarkTarget;
  state: "idle" | "running" | "paused";
};
type BenchmarkJob = {
  id: string;
  scope: string;
  requestScope: string;
  step: BenchmarkTarget;
  label: string;
  progress?: BenchmarkProgress;
  status: "等待" | "运行中" | "已暂停" | "完成" | "失败";
  resumeSamples?: boolean;
};
type FormalActivity = { id: string; game: string; label: string; state: "running" | "unfinished"; completed?: number; total?: number };
export type BenchmarkSnapshot = {
  version: number;
  jobs: readonly BenchmarkJob[];
  progress: BenchmarkState | null;
  running: boolean;
  stopping: boolean;
  formalBusy: boolean;
  formalJobs: readonly FormalActivity[];
  historyRevision: number;
};

export const emptyBenchmarkSnapshot: BenchmarkSnapshot = {
  version: 0, jobs: [], progress: null, running: false, stopping: false, formalBusy: false, formalJobs: [], historyRevision: 0,
};

export function isMosaicBenchmarkStep(step: BenchmarkTarget): step is MosaicBenchmarkStep {
  return Object.hasOwn(mosaicBenchmarkSteps, step);
}

export function benchmarkTargetLabel(step: BenchmarkTarget) {
  if (isMosaicBenchmarkStep(step)) return mosaicBenchmarkSteps[step];
  return step === "screen" ? "筛选文本" : step === "translate" ? "翻译正文" : imageBenchmarkSteps[step].title;
}

type ProgressPatch = Partial<Omit<BenchmarkProgress, "elapsedMs" | "percent">>;
type JobContext = { id: string; signal: AbortSignal; report: (patch: ProgressPatch) => void };
type Prepared = { count: number; scope: string; run: (context: JobContext) => Promise<number>; cleanup: () => void };
type QueuedJob = BenchmarkJob & { prepare?: () => Promise<Prepared>; prepared?: Prepared; onMessage?: BenchmarkInput["onMessage"] };

function initialImageRows(workload: ImageBenchmarkWorkload) {
  return (workload.project?.images || []).map(clearGameImageRefinement).filter(image => image.selected);
}

function mosaicBenchmarkRows(step: MosaicBenchmarkStep, workload: MosaicBenchmarkWorkload, selection: "checked" | "all") {
  const checked = new Set(workload.checked);
  return workload.selected.filter(image => (selection === "all" || checked.has(image.id)) &&
    (step !== "mosaicRedraw" || !!workload.boxes[image.id]?.length));
}

export function benchmarkSampleCounts(input: BenchmarkInput) {
  const images = input.images;
  if (!images) return {};
  const workload = images.getWorkload();
  const imageCounts: Partial<Record<ImageBenchmarkStep, number>> = {};
  for (const step of Object.keys(images.setup.steps) as ImageBenchmarkStep[]) {
    imageCounts[step] = imageBenchmarkRows(step, step === "refine" ? initialImageRows(workload) : workload.selected).length;
  }
  if (!input.mosaicRoot) return { imageCounts };
  const mosaic = captureMosaicBenchmark(workload, input.mosaicRoot);
  return {
    imageCounts,
    mosaicCounts: {
      checked: mosaicBenchmarkRows("mosaicScreen", mosaic, "checked").length,
      refineChecked: captureMosaicBenchmark(workload,input.mosaicRoot,true).checked.length,
      all: mosaic.selected.length,
      redrawChecked: mosaicBenchmarkRows("mosaicRedraw", mosaic, "checked").length,
      redrawAll: mosaicBenchmarkRows("mosaicRedraw", mosaic, "all").length,
    },
  };
}

async function prepareJob(input: BenchmarkInput, request: BenchmarkRequest, queuedDuringFormal = false): Promise<Prepared> {
  const { step, rounds } = request;
  const configs = structuredClone(request.configs.filter(config => config.enabled !== false));
  const limit = request.sampleLimit ?? configs[0]?.mosaic?.sampleLimit ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("样本上限必须为非负整数");
  const selectSamples = <T,>(eligible: T[]) => limit ? eligible.slice(0, limit) : eligible;
  if (request.scope !== input.scope) throw new Error("游戏工程已切换，请重新打开该工程的测试队列");
  if (!configs.length || !Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error("测试配置或轮次无效");
  const mosaic = isMosaicBenchmarkStep(step);
  const imageStep = !mosaic && step !== "screen" && step !== "translate" ? step : undefined;
  const imageSource = input.images;
  const historyScope = imageStep && imageSource ? imageSource.setup.scope : input.scope;
  const displayScope = mosaic ? input.mosaicRoot : historyScope;
  if (!displayScope) throw new Error("当前工程没有去码测试设置");

  if (request.sampleSetPath && !mosaic && !imageStep) throw new Error("当前测试步骤不接受图片样本集");
  const annotated = request.sampleSetPath ? await loadAnnotatedSampleSet(request.sampleSetPath) : undefined;
  const workload: Parameters<typeof runGameTextBenchmarks>[2] = { entries: [], selectedIds: new Set() };
  let count: number;
  let imageSamples: ImageBenchmarkInput[] | undefined;
  let createStepRunner: ((context: JobContext, report: (value: UnityProgress) => void) => BenchmarkStepRunner) | undefined;
  if (mosaic) {
    if (!imageSource || configs.some(config => !config.mosaic)) throw new Error("当前工程没有去码测试样本或配置");
    const snapshot: MosaicBenchmarkWorkload = annotated ? {
      project: annotated.project, selected: [], embedded: false, checked: [],
      boxes: Object.fromEntries(annotated.images.flatMap(image => image.annotation.mosaic?.boxes?.length
        ? [[image.id,image.annotation.mosaic.boxes]] : [])),
    } : structuredClone(captureMosaicBenchmark(imageSource.getWorkload(), displayScope,step === "mosaicRefine",queuedDuringFormal));
    const options = configs[0].mosaic!;
    const eligible = annotated ? annotatedMosaicSamples(annotated,step) : mosaicBenchmarkRows(step, snapshot, step === "mosaicRefine" ? "checked" : options.selection);
    const sample = selectSamples(eligible);
    if (!sample.length) throw new Error(annotated ? "样本集中没有符合该去码步骤的已标注图片" : step === "mosaicRedraw" ? "请先在去码页准备测试蒙版" : "没有可测试的去码图片，请检查勾选或调整样本范围");
    count = sample.length;
    const checked = new Set(snapshot.checked);
    imageSamples = sample.map(image => benchmarkImageInput(image, snapshot.categories?.[image.id] || "标注样本",
      annotated ? true : checked.has(image.id), snapshot.boxes[image.id]));
    createStepRunner = (context, report) => runMosaicBenchmark(step, sample, snapshot, context.signal, (image, signal) => {
      context.report({ sample: image.name });
      if (annotated) return annotated.read(image,signal);
      return snapshot.embedded ? readEmbeddedBenchmarkImage(snapshot.project!.root, image, signal) : imageSource.readImage!(snapshot.project!, image);
    }, report, annotated);
  } else if (imageStep) {
    if (!imageSource || !Object.hasOwn(imageSource.setup.steps, imageStep)) throw new Error("当前工程没有该图片测试步骤");
    const currentImages = imageSource.getWorkload();
    const snapshot = annotated ? { project: annotated.project, selected: [], embedded: currentImages.embedded } : structuredClone(currentImages);
    const setup = structuredClone(imageSource.setup);
    const sample = selectSamples(annotated ? annotatedTextSamples(annotated,imageStep,[...new Set(configs.map(config => config.target))])
      : imageBenchmarkRows(imageStep, imageStep === "refine" ? initialImageRows(snapshot) : snapshot.selected));
    if (!sample.length) throw new Error(annotated ? "样本集中没有符合该步骤及目标语言的已标注图片" : "所勾选的图片没有符合当前步骤的样本");
    count = sample.length;
    imageSamples = sample.map(image => benchmarkImageInput(image));
    createStepRunner = (context, report) => (config, settings, scope, record) => runGameImageSample(imageStep, sample, snapshot, config,
      setup, settings, scope, context.signal, image => imageSource.readImage!(snapshot.project!, image), input.onMessage,
      report, sample => context.report({ sample }), annotated, record);
  } else {
    const text = structuredClone(input.getWorkload());
    text.selected = selectSamples(text.selected);
    if (!text.selected.length) throw new Error("请先勾选要测试的文本");
    count = text.selected.length;
    workload.entries = text.entries;
    workload.selectedIds = new Set(text.selected.map(entry => entry.id));
    workload.dialoguePages = text.dialoguePages;
    if (step === "screen") {
      createStepRunner = (context, report) => (config, settings, scope) => runGameTextScreenSample(config, text.selected, settings,
        scope, context.signal, input.onMessage, report, sample => context.report({ sample }));
    } else {
      const preview = inspectBenchmarkSample(text.selected, configs);
      if (configs.some(config => config.models.text.id && config.models.dialogue.id &&
        config.models.dialogue.id !== config.models.text.id && !preview[config.id].dialogue))
        input.onMessage("测试样本没有可进入专用对白路线的条目，此轮不能用于比较对白模型。", "info");
    }
  }

  const title = benchmarkTargetLabel(step);
  const runScope = historyScope + ":benchmark:" + (mosaic ? "mosaic" : imageStep ? "images" : "text");
  const totalScope = historyScope + ":benchmark-total";
  let failures = 0, failedSamples = 0, runs = 0, finishedSamples = 0;
  return { count: count * configs.length * rounds, scope: displayScope, cleanup: () => {
    const runId = stepPerformance(runScope, step).taskId;
    if (step === "mosaicRefine" && runId) clearMosaicReviews("benchmark:" + runId);
    clearGamePerformance(runScope, [step], false);
    clearGamePerformance(totalScope, ["queue"], false);
  }, run: async context => {
    const sampleLabel = (sample: string) => sample.replace(/\s+/g, " ").trim().slice(0, 140);
    let runSamples = 0;
    const resumeAt = runs;
    const progress = (value: UnityProgress) => {
      // Terminology preparation counts names, not completed translation samples.
      if (step !== "translate" || value.textStage !== "names") {
        runSamples = Math.max(runSamples, Math.min(count, value.completed));
      }
      context.report({ current: finishedSamples + runSamples, detail: value.detail,
        failed: failedSamples + (value.translation?.failedEntries ?? value.redrawFailed ?? 0) });
    };
    const target = createStepRunner ? { step, selected: count, imageSamples, run: createStepRunner({
      ...context,
      report: patch => context.report(patch.sample ? { ...patch, sample: sampleLabel(patch.sample) } : patch),
    }, progress) } : undefined;
    beginGameStep(totalScope, "queue");
    input.onMessage((resumeAt || stepPerformance(runScope, step).taskId ? "继续" : "开始") + title + "测试 · " + configs.length + " 个配置 · " + rounds + " 轮", "info");
    try {
      await runGameTextBenchmarks(configs, rounds, workload, runScope, context.id, context.signal, input.onMessage,
        (round, config) => {
          runSamples = 0;
          context.report({ phase: "execute", label: title + " · 第 " + round + "/" + rounds + " 轮 · " + config.label,
            configId: config.id, sample: "", detail: undefined,
            ...(step === "mosaicRefine" ? {} : { current: finishedSamples }), failed: failedSamples });
        },
        progress,
        result => {
          const done = Math.max(runSamples, Math.min(count, result.translated + result.failed));
          if (result.status === "已暂停") {
            context.report({ current: finishedSamples + done, failed: failedSamples + result.failed, detail: result.detail });
            return;
          }
          runs++;
          if (result.status === "失败") failures++;
          failedSamples += result.failed;
          finishedSamples += done;
          context.report({ current: finishedSamples, failed: failedSamples, detail: result.detail });
        }, target, sample => context.report({ sample: sampleLabel(sample) }), resumeAt);
      return failures;
    } finally {
      finishGameStep(totalScope);
      const detail = "已执行 " + runs + "/" + (configs.length * rounds) + " 项" +
        (failures ? " · 失败 " + failures + " 项" : "") + " · " + gameDuration(stepPerformance(totalScope, "queue").elapsedMs);
      context.report({ phase: "finish", configId: undefined });
      input.onMessage(title + "测试 · " + detail, failures ? "error" : "info");
    }
  } };
}

const jobs: QueuedJob[] = [];
const listeners = new Set<() => void>();
let snapshot = emptyBenchmarkSnapshot;
let progress: BenchmarkState | null = null;
let startedAt = 0;
let running = false;
let controller: AbortController | undefined;
let executing: Promise<void> | undefined;
let historyRevision = 0;
const formalWorkflows = new Map<string, FormalActivity>();
export const benchmarkBlockingReason = "测试进行中，完成后可操作";
export const formalBlockingReason = "等待正式任务结束";

export function isBenchmarkRunning() {
  return !!controller || (running && !formalWorkflows.size);
}

export function useBenchmarkRunning() {
  return useSyncExternalStore(benchmarkRunner.subscribe, isBenchmarkRunning);
}

export function useFormalWorkflowActivity(active: boolean, game: string, label: string, completed?: number, total?: number,
  unfinished = false) {
  const id = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const key = id.current ??= crypto.randomUUID();
    if (active || unfinished) formalWorkflows.set(key,{ id:key,game,label,completed,total, state: active ? "running" : "unfinished" });
    else formalWorkflows.delete(key);
    publish();
    if (!formalWorkflows.size && running) queueMicrotask(pumpQueue);
  }, [active, game, label, completed, total, unfinished]);
  useLayoutEffect(() => () => {
    const job = id.current && formalWorkflows.get(id.current);
    if (!job) return;
    formalWorkflows.delete(job.id);
    // Leaving an unfinished workspace does not release queued tests automatically.
    if (job.state === "unfinished" && nextJob()) running = false;
    publish();
    if (!formalWorkflows.size && running) queueMicrotask(pumpQueue);
  }, []);
}

function publish() {
  const visibleProgress = progress?.state === "running"
    ? { ...progress, elapsedMs: performance.now() - startedAt }
    : progress;
  snapshot = {
    version: snapshot.version + 1,
    jobs: jobs.map(({ prepared, prepare, onMessage, ...job }) => ({
      ...job, progress: job.status === "运行中" ? visibleProgress ?? undefined : job.progress,
    })),
    progress: visibleProgress,
    running, stopping: !!controller?.signal.aborted, formalBusy: formalWorkflows.size > 0, formalJobs: [...formalWorkflows.values()], historyRevision,
  };
  for (const listener of listeners) listener();
}

async function cleanupJob(job?: QueuedJob) {
  if (job) {
    // Only a started job owns the shared meters and its run checkpoint.
    job.prepared?.cleanup();
    job.prepared = undefined;
    job.prepare = undefined;
    job.onMessage = undefined;
  }
  await flushGamePerformanceArchive();
}

function nextJob() {
  return jobs.find(item => item.status === "已暂停") ?? jobs.find(item => item.status === "等待");
}

async function runJobs() {
  while (running && !formalWorkflows.size) {
    const job = nextJob();
    if (!job) break;
    const abort = new AbortController();
    controller = abort;
    job.status = "运行中";
    const previous = job.progress;
    startedAt = performance.now() - (previous?.elapsedMs ?? 0);
    progress = { type: "benchmark-state", scope: job.scope, step: job.step, state: "running",
      phase: "prepare", label: job.label, current: previous?.current ?? 0, total: job.prepared?.count ?? 0,
      sample: "", elapsedMs: previous?.elapsedMs ?? 0, percent: previous?.percent ?? 0, failed: previous?.failed ?? 0 };
    publish();
    const timer = window.setInterval(publish, 1000);
    let failed = false, waitForFormal = false, finished = false;
    try {
      job.prepared ??= await job.prepare?.();
      abort.signal.throwIfAborted();
      if (!job.prepared) throw new Error("未能准备测试样本");
      if (formalWorkflows.size) { waitForFormal = true; continue; }
      job.scope = job.prepared.scope;
      progress = { ...progress, scope: job.scope, total: job.prepared.count };
      publish();
      failed = !!await job.prepared.run({
        id: job.id, signal: abort.signal,
        report: patch => {
          if (controller !== abort || !progress) return;
          const next = { ...progress, ...patch };
          next.percent = next.total > 0 ? Math.floor(100 * next.current / next.total) : null;
          progress = next;
          publish();
        },
      });
      finished = true;
    } catch (cause) {
      failed = true;
      const detail = abort.signal.aborted ? "测试已暂停，继续队列可恢复" : cause instanceof Error ? cause.message : String(cause);
      progress = { ...progress, phase: "finish", detail };
      job.onMessage?.(job.label + " · " + detail, abort.signal.aborted ? "info" : "error");
    } finally {
      const paused = !finished && abort.signal.aborted;
      try {
        await cleanupJob(paused || waitForFormal ? undefined : job);
        historyRevision++;
      } finally {
        window.clearInterval(timer);
        controller = undefined;
        job.status = paused ? "已暂停" : waitForFormal ? previous ? "已暂停" : "等待" : failed ? "失败" : "完成";
        progress = { ...progress, state: job.status === "已暂停" ? "paused" : "idle", elapsedMs: performance.now() - startedAt };
        job.progress = progress;
        publish();
      }
    }
  }
}

function stopQueue() {
  running = false;
  controller?.abort();
  publish();
  if (!executing) void cleanupJob().catch(console.error);
}

function pumpQueue() {
  if (!running || executing || formalWorkflows.size) return;
  if (!nextJob()) {
    running = false;
    publish();
    return;
  }
  // Claim execution before any synchronous progress callback can start a second pump.
  executing = Promise.resolve().then(runJobs);
  void executing.finally(() => { executing = undefined; if (running) pumpQueue(); else publish(); }).catch(console.error);
}

function startQueue() {
  if (!nextJob()) return;
  running = true;
  publish();
  pumpQueue();
}

export const benchmarkRunner = {
  async enqueue(input: BenchmarkInput, request: BenchmarkRequest) {
    if (request.scope !== input.scope) throw new Error("游戏工程已切换，请重新打开该工程的测试队列");
    const occupied = formalWorkflows.size > 0;
    const frozen = structuredClone(request);
    const deferred = occupied && !request.sampleSetPath;
    const prepare = deferred ? () => prepareJob(input,frozen,true) : undefined;
    const prepared = deferred ? undefined : await prepareJob(input,frozen);
    if (request.priority && controller?.signal.aborted) throw new Error("正在暂停当前测试，请稍候");
    const configs = request.configs.filter(config => config.enabled !== false);
    const title = benchmarkTargetLabel(request.step);
    const label = configs.length === 1 ? title + " · " + configs[0].label : title + " · " + configs.length + " 个配置";
    const job: QueuedJob = { id: crypto.randomUUID(), scope: prepared?.scope || input.mosaicRoot || input.scope, requestScope: request.scope, step: request.step,
      label, status: "等待", prepared, prepare, onMessage: input.onMessage, resumeSamples: request.step === "mosaicRefine" };
    const firstWaiting = request.priority ? jobs.findIndex(item => item.status === "等待") : -1;
    jobs.splice(firstWaiting < 0 ? jobs.length : firstWaiting, 0, job);
    publish();
    if (request.priority) startQueue();
    else if (running) pumpQueue();
    return job.id;
  },
  start: startQueue,
  stop: stopQueue,
  async remove(id: string) {
    const index = jobs.findIndex(job => job.id === id && job.status !== "运行中");
    if (index < 0) return;
    const [job] = jobs.splice(index, 1);
    publish();
    await cleanupJob(job.status === "已暂停" ? job : undefined);
    pumpQueue();
  },
  cleanup: () => cleanupJob(),
  snapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

export function useBenchmarkProgress(scope: string) {
  return useSyncExternalStore(benchmarkRunner.subscribe, () => {
    const state = benchmarkRunner.snapshot().progress;
    return state?.scope === scope && state.state === "running" ? state : undefined;
  });
}

export function attachBenchmarkRunner() {
  let disposed = false, unregister: (() => void) | undefined;
  const discardPaused = () => {
    for (const job of jobs) if (job.status === "已暂停") job.prepared?.cleanup();
  };
  window.addEventListener("pagehide", discardPaused);
  void registerAppCloseGuard(async () => {
    stopQueue();
    await executing;
    await cleanupJob();
    return true;
  }).then(remove => { if (disposed) remove(); else unregister = remove; }).catch(console.error);
  return () => { disposed = true; unregister?.(); window.removeEventListener("pagehide", discardPaused); };
}
