import { benchmarkRoundChanges, configsForRound, earlierRoundConfigs, sameBenchmarkConfig, type BenchmarkRoundPlan } from "./benchmarkRoundPlan";
import { benchmarkImageInput, readImageBenchmarkDetails, type ImageBenchmarkDetails, type ImageBenchmarkInput } from "./imageBenchmarkHistory";
import { clearMosaicReviews } from "../gameMosaicRefine";
import { clearGameImageRefinement } from "../gameImageScreening";
import { annotatedMosaicSamples, annotatedTextSamples, loadAnnotatedSampleSet } from "./imageSampleSet";
import { freezeMosaicInputs, mosaicTruthLookup, type MosaicScoreFreeze } from "./mosaicScoreInputs";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { registerAppCloseGuard } from "../appClose";
import { imageBenchmarkRows, imageBenchmarkSteps, runGameImageSample, type ImageBenchmarkSetup, type ImageBenchmarkStep, type ImageBenchmarkWorkload } from "../gameImageBenchmark";
import { beginGameStep, clearGamePerformance, finishGameStep, flushGamePerformanceArchive, gameDuration, stepPerformance } from "../gameModelPerformance";
import { archivedMosaicSamples, captureMosaicBenchmark, mosaicBenchmarkSteps, readEmbeddedBenchmarkImage, runMosaicBenchmark, type MosaicBenchmarkStep, type MosaicBenchmarkWorkload } from "../gameMosaicBenchmark";
import { benchmarkRoles, inspectBenchmarkSample, runGameTextBenchmarks, runGameTextScreenSample, readGameBenchmarkHistory, groupBenchmarkTasks, type ArchivedBenchmarkRef, type BenchmarkConfig, type BenchmarkResult, type BenchmarkStepRunner } from "../gameTextBenchmark";
import type { GameDialoguePage } from "../gameTranslationContext";
import type { UnityEntry, UnityImage, UnityProgress } from "../unityOffline";

import { formatBenchmarkParameters, type BenchmarkParameter } from "./benchmarkParameters";
import type { StepPerformance } from "../gameModelPerformance";

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
export type BenchmarkRequest = BenchmarkRoundPlan & { scope: string; step: BenchmarkTarget; rounds: number; priority?: boolean; sampleSetPath?: string; sampleLimit?: number; referenceSampleSetPath?: string };
type BenchmarkProgress = {
  phase: "prepare" | "execute" | "finish";
  label: string;
  current: number;
  total: number;
  sample: string;
  elapsedMs: number;
  configElapsedMs?: number;
  percent: number | null;
  failed: number;
  detail?: string;
  configId?: string;
  configIndex?: number;
  configCount?: number;
  round?: number;
  rounds?: number;
  sampleCurrent?: number;
  sampleTotal?: number;
  performance?: StepPerformance;
  parameters?: BenchmarkParameter[];
};
export type BenchmarkState = BenchmarkProgress & {
  jobId: string;
  scope: string;
  step: BenchmarkTarget;
  state: "idle" | "running" | "paused";
};
export type BenchmarkJob = {
  id: string;
  scope: string;
  requestScope: string;
  step: BenchmarkTarget;
  label: string;
  progress?: BenchmarkState;
  failure?: string;
  startedTime?: string;
  status: "待开始" | "等待" | "运行中" | "已暂停" | "完成" | "失败";
  resumeSamples?: boolean;
  round: number;
  startedConfigIds: readonly string[];
  completedConfigIds: readonly string[];
};
type FormalActivity = { id: string; game: string; label: string; state: "running" | "unfinished"; completed?: number; total?: number; detail?: string };
export type BenchmarkSnapshot = {
  version: number;
  jobs: readonly BenchmarkJob[];
  running: boolean;
  stopping: boolean;
  formalBusy: boolean;
  formalJobs: readonly FormalActivity[];
  historyRevision: number;
  blockedTaskId?: string;
};

export const emptyBenchmarkSnapshot: BenchmarkSnapshot = {
  version: 0, jobs: [], running: false, stopping: false, formalBusy: false, formalJobs: [], historyRevision: 0,
};

export function isMosaicBenchmarkStep(step: BenchmarkTarget): step is MosaicBenchmarkStep {
  return Object.hasOwn(mosaicBenchmarkSteps, step);
}

export function benchmarkTargetLabel(step: BenchmarkTarget) {
  if (isMosaicBenchmarkStep(step)) return mosaicBenchmarkSteps[step];
  return step === "screen" ? "筛选文本" : step === "translate" ? "翻译正文" : imageBenchmarkSteps[step].title;
}

type ProgressPatch = Partial<Omit<BenchmarkProgress, "elapsedMs" | "percent">>;
type JobContext = {
  id: string;
  signal: AbortSignal;
  elapsedMs: () => number;
  report: (patch: ProgressPatch, configTiming?: "start" | "stop" | "complete") => void;
};
type Prepared = { count: number; scope: string; runScope: string; restored?: number; run: (context: JobContext) => Promise<number>;
  cleanup: (jobId: string) => void; restart: (jobId: string) => void;
  updatePlan: (plan: BenchmarkRoundPlan, started: boolean) => void };
type QueuedJob = BenchmarkJob & { request: BenchmarkRequest; prepare?: () => Promise<Prepared>; prepared?: Prepared; onMessage?: BenchmarkInput["onMessage"] };

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

export type BenchmarkTaskConfig = Pick<BenchmarkRequest, "configs" | "rounds" | "sampleLimit" | "sampleSetPath"> & {
  round: number; earlier: BenchmarkConfig[][]; fixedSlots: boolean;
};
export type BenchmarkTaskDecision = "run" | "stop" | "defer";

export function canEditBenchmarkTask(job: BenchmarkJob) {
  return job.status === "待开始" || job.status === "等待" || job.status === "已暂停";
}

async function prepareJob(input: BenchmarkInput, request: BenchmarkRequest, queuedDuringFormal = false,
  archive?: { details: ImageBenchmarkDetails; reuse: boolean; completed: BenchmarkResult[]; configElapsedMs: number }): Promise<Prepared> {
  const { step, rounds } = request;
  let configs = structuredClone(request.configs.filter(config => config.enabled !== false));
  let roundConfigs = request.roundConfigs;
  const limit = request.sampleLimit ?? configs[0]?.mosaic?.sampleLimit ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("样本上限必须为非负整数");
  const selectSamples = <T,>(eligible: T[]) => limit ? eligible.slice(0, limit) : eligible;
  if (request.scope !== input.scope) throw new Error("游戏工程已切换，请重新打开该工程的测试队列");
  if (!configs.length || !Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error("测试配置或轮次无效");
  for (const [round, items] of Object.entries(roundConfigs ?? {})) {
    if (!Number.isInteger(Number(round)) || Number(round) < 2 || Number(round) > rounds ||
        items.length !== configs.length || items.some((item, index) => item.enabled === false || item.id !== configs[index].id))
      throw new Error("跨轮测试的配置项与原批次不一致");
  }
  const mosaic = isMosaicBenchmarkStep(step);
  const mosaicSelection = step !== "mosaicRefine" && configs[0].mosaic?.selection === "all" ? "all" : "checked";
  const imageStep = !mosaic && step !== "screen" && step !== "translate" ? step : undefined;
  const imageSource = input.images;
  let imageSetup: ImageBenchmarkSetup | undefined;
  const historyScope = imageStep && imageSource ? imageSource.setup.scope : input.scope;
  const displayScope = mosaic ? input.mosaicRoot : historyScope;
  if (!displayScope) throw new Error("当前工程没有去码测试设置");

  if (request.sampleSetPath && !mosaic && !imageStep) throw new Error("当前测试步骤不接受图片样本集");
  const useAllAnnotated = step === "mosaicScreen" && mosaicSelection === "all";
  const annotated = request.sampleSetPath ? await loadAnnotatedSampleSet(request.sampleSetPath,
    { preserveDuplicates: useAllAnnotated, includeUnannotated: useAllAnnotated, verifyContent: mosaic }) : undefined;
  const workload: Parameters<typeof runGameTextBenchmarks>[2] = { entries: [], selectedIds: new Set() };
  let count: number;
  let recoveredResults: ReturnType<typeof archivedMosaicSamples>["recovered"] | undefined;
  let readMosaicCheckpoint: ((jobId: string, runId: string) => Promise<void>) | undefined;
  let pausedRunId: string | undefined;
  let imageSamples: ImageBenchmarkInput[] | undefined;
  let scoreFreeze: MosaicScoreFreeze | undefined;
  let updateAnnotatedImageSamples: ((configs: BenchmarkConfig[]) => void) | undefined;
  let createStepRunner: ((context: JobContext, report: (value: UnityProgress) => void) => BenchmarkStepRunner) | undefined;
  if (mosaic) {
    if (!imageSource || configs.some(config => !config.mosaic)) throw new Error("当前工程没有去码测试样本或配置");
    const snapshot: MosaicBenchmarkWorkload = annotated ? {
      project: annotated.project, selected: [], embedded: false, checked: [],
      boxes: step === "mosaicRedraw" ? Object.fromEntries(annotated.images.flatMap(image => image.annotation.mosaic?.boxes?.length
        ? [[image.id,image.annotation.mosaic.boxes]] : [])) : {},
    } : structuredClone(captureMosaicBenchmark(imageSource.getWorkload(), displayScope,step === "mosaicRefine",queuedDuringFormal));
    const eligible = annotated ? useAllAnnotated ? annotated.images : annotatedMosaicSamples(annotated, step) : mosaicBenchmarkRows(step, snapshot, mosaicSelection);
    const recovered = archive && archivedMosaicSamples(annotated ? annotated.images : snapshot.selected, archive.details);
    const sample = recovered?.images ?? selectSamples(eligible);
    recoveredResults = archive?.reuse ? recovered?.recovered : undefined;
    readMosaicCheckpoint = async (jobId, runId) => {
      recoveredResults = archivedMosaicSamples(sample, await readImageBenchmarkDetails(jobId, runId)).recovered;
    };
    if (archive) {
      snapshot.boxes = Object.fromEntries(archive.details.samples.flatMap(item =>
        item.boxes?.length ? [[item.id, item.boxes] as const] : []));
      snapshot.categories = Object.fromEntries(archive.details.samples.map(item => [item.id, item.category]));
      snapshot.checked = archive.details.samples.filter(item => item.checked).map(item => item.id);
    }
    if (!sample.length) throw new Error(annotated ? "样本集中没有符合该去码步骤的已标注图片" : step === "mosaicRedraw" ? "请先在去码页准备测试蒙版" : "没有可测试的去码图片，请检查勾选或调整样本范围");
    count = sample.length;
    const checked = new Set(snapshot.checked);
    imageSamples = archive?.details.samples ?? sample.map(image => benchmarkImageInput(image, snapshot.categories?.[image.id] || "标注样本",
      annotated ? true : checked.has(image.id), snapshot.boxes[image.id]));
    if (step !== "mosaicRedraw") {
      if (!archive) {
        const reference = request.referenceSampleSetPath && request.referenceSampleSetPath !== request.sampleSetPath
          ? await loadAnnotatedSampleSet(request.referenceSampleSetPath) : annotated;
        const truth = mosaicTruthLookup(reference);
        imageSamples = imageSamples.map(item => ({ ...item, mosaicTruth: truth(item) }));
      }
      if (imageSamples.every(item => item.mosaicTruth !== undefined)) scoreFreeze = await freezeMosaicInputs(imageSamples);
    }
    createStepRunner = (context, report) => (config, settings, scope, record, runId, preceding) =>
      runMosaicBenchmark(step, sample, snapshot, context.signal, (image, signal) => {
        context.report({ sample: image.name });
        if (annotated) return annotated.read(image,signal);
        return snapshot.embedded ? readEmbeddedBenchmarkImage(snapshot.project!.root, image, signal) : imageSource.readImage!(snapshot.project!, image);
      }, report, annotated, recoveredResults)(
        config, settings, scope, record, runId, preceding);
  } else if (imageStep) {
    if (!imageSource || !Object.hasOwn(imageSource.setup.steps, imageStep)) throw new Error("当前工程没有该图片测试步骤");
    const currentImages = imageSource.getWorkload();
    const snapshot = annotated ? { project: annotated.project, selected: [], embedded: currentImages.embedded } : structuredClone(currentImages);
    const setup = structuredClone(imageSource.setup);
    imageSetup = setup;
    const chooseImages = (items: BenchmarkConfig[]) => {
      const images = selectSamples(annotated ? annotatedTextSamples(annotated, imageStep, [...new Set(items.map(config => config.target))])
        : imageBenchmarkRows(imageStep, imageStep === "refine" ? initialImageRows(snapshot) : snapshot.selected));
      if (!images.length) throw new Error(annotated ? "样本集中没有符合该步骤及目标语言的已标注图片" : "所勾选的图片没有符合当前步骤的样本");
      return images;
    };
    let sample = chooseImages(configs);
    count = sample.length;
    imageSamples = sample.map(image => benchmarkImageInput(image));
    if (annotated) updateAnnotatedImageSamples = items => {
      sample = chooseImages(items);
      count = sample.length;
      imageSamples = sample.map(image => benchmarkImageInput(image));
    };
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
  let runs = archive?.completed.length ?? 0;
  let archivedConfigElapsedMs = archive?.configElapsedMs ?? 0;
  let failures = archive?.completed.filter(result => result.status === "失败").length ?? 0;
  let failureDetail = archive?.completed.find(result => result.status === "失败")?.detail;
  let failedSamples = archive?.completed.reduce((total, result) => total + result.failed, 0) ?? 0;
  let finishedSamples = archive?.completed.reduce((total, result) => total + Math.min(count, result.translated + result.failed), 0) ?? 0;
  let unfinishedSamples = recoveredResults?.size ?? 0;
  const prepared: Prepared = { count: count * configs.length * rounds, scope: displayScope, runScope,
    restored: finishedSamples + unfinishedSamples, updatePlan: (plan, started) => {
      if (!started) updateAnnotatedImageSamples?.(plan.configs);
      configs = plan.configs;
      roundConfigs = plan.roundConfigs;
      prepared.count = count * configs.length * rounds;
    }, cleanup: jobId => {
    const meter = stepPerformance(runScope, step);
    if (meter.benchmark?.queueId === jobId) {
      if (step === "mosaicRefine" && meter.taskId) clearMosaicReviews("benchmark:" + meter.taskId);
      clearGamePerformance(runScope, [step], false);
    }
    if (stepPerformance(totalScope, "queue").benchmark?.queueId === jobId)
      clearGamePerformance(totalScope, ["queue"], false);
  }, restart: jobId => {
    prepared.cleanup(jobId);
    prepared.restored = recoveredResults = pausedRunId = undefined;
    failures = failedSamples = runs = finishedSamples = unfinishedSamples = 0;
    failureDetail = undefined;
    archivedConfigElapsedMs = 0;
  }, run: async context => {
    if (pausedRunId) await readMosaicCheckpoint?.(context.id, pausedRunId);
    context.signal.throwIfAborted();
    const sampleLabel = (sample: string) => sample.replace(/\s+/g, " ").trim().slice(0, 140);
    let runSamples = 0;
    const resumeAt = runs;
    const progress = (value: UnityProgress) => {
      // Terminology preparation counts names, not completed translation samples.
      if (step !== "translate" || value.textStage !== "names") {
        runSamples = Math.max(runSamples, Math.min(count, value.completed));
      }
      context.report({ current: finishedSamples + runSamples, sampleCurrent: runSamples, detail: value.detail,
        failed: failedSamples + (value.translation?.failedEntries ?? value.redrawFailed ?? 0) });
    };
    const target = createStepRunner ? { step, selected: count, imageSamples, scoreFreeze, reusedImages: () => recoveredResults?.size ?? 0, run: createStepRunner({
      ...context,
      report: patch => context.report(patch.sample ? { ...patch, sample: sampleLabel(patch.sample) } : patch),
    }, progress) } : undefined;
    const previousTotal = stepPerformance(totalScope, "queue");
    if (previousTotal.taskId && previousTotal.benchmark?.queueId !== context.id)
      clearGamePerformance(totalScope, ["queue"], false);
    beginGameStep(totalScope, "queue", { queueId: context.id });
    const resuming = resumeAt > 0 || !!pausedRunId || !!recoveredResults || stepPerformance(runScope, step).benchmark?.queueId === context.id;
    input.onMessage((resuming ? "继续" : "开始") + title + "测试 · " + configs.length + " 个配置 · " + rounds + " 轮", "info");
    try {
      await runGameTextBenchmarks(configs, rounds, workload, runScope, context.id, context.signal, input.onMessage,
        (round, config) => {
          runSamples = unfinishedSamples;
          context.report({ phase: "execute", label: title + " · 第 " + round + "/" + rounds + " 轮 · " + config.label,
            configId: config.id, configIndex: configs.findIndex(item => item.id === config.id) + 1, configCount: configs.length,
            round, rounds, configElapsedMs: archivedConfigElapsedMs, sampleCurrent: runSamples, sampleTotal: count,
            sample: "", detail: undefined, performance: undefined,
            parameters: formatBenchmarkParameters(step, config, { rounds, sampleLimit: archive ? null : limit,
              annotated: !!annotated, mosaicSelection, imageSetup }),
            current: finishedSamples + runSamples,
            failed: failedSamples }, "start");
          archivedConfigElapsedMs = 0;
        },
        progress,
        result => {
          const done = Math.max(runSamples, Math.min(count, result.translated + result.failed));
          const measurement = { performance: performanceForDisplay(result.performance), sampleCurrent: done };
          if (result.status === "已暂停") {
            if (mosaic) {
              unfinishedSamples = result.translated;
              if (result.performance.benchmark?.imageDetails) pausedRunId = result.performance.taskId;
            }
            context.report({ ...measurement, current: finishedSamples + done, failed: failedSamples + result.failed, detail: result.detail }, "stop");
            return;
          }
          runs++;
          pausedRunId = recoveredResults = undefined;
          unfinishedSamples = 0;
          if (result.status === "失败") {
            failures++;
            failureDetail = result.detail || failureDetail;
          }
          failedSamples += result.failed;
          finishedSamples += done;
          context.report({ ...measurement, current: finishedSamples, failed: failedSamples, detail: result.detail }, "complete");
          // The result is already in the writer's outbox. Wait for that window's flush before notifying readers.
          void Promise.resolve(flushGamePerformanceArchive()).then(() => {
            historyRevision++;
            publish();
          });
        }, target, sample => context.report({ sample: sampleLabel(sample) }), resumeAt, request.sampleSetPath, request.referenceSampleSetPath, limit, roundConfigs);
      return failures;
    } finally {
      finishGameStep(totalScope);
      const detail = "已执行 " + runs + "/" + (configs.length * rounds) + " 项" +
        (failures ? " · 失败 " + failures + " 项" : "") + " · " + gameDuration(context.elapsedMs());
      if (!context.signal.aborted) context.report({ phase: "finish", detail: failures ? failureDetail || detail : undefined });
      input.onMessage(title + "测试 · " + detail, failures ? "error" : "info");
    }
  } };
  return prepared;
}

const jobs: QueuedJob[] = [];
const listeners = new Set<() => void>();
let snapshot = emptyBenchmarkSnapshot;
let progress: BenchmarkState | null = null;
let startedAt = 0;
let configStartedAt: number | undefined;
let running = false;
let controller: AbortController | undefined;
let executing: Promise<void> | undefined;
let historyRevision = 0;
let showingTaskId: string | undefined;
let blockedTaskId: string | undefined;
let shownTaskDirty = false;
const formalWorkflows = new Map<string, FormalActivity>();
export const benchmarkBlockingReason = "测试进行中，完成后可操作";
export const formalBlockingReason = "等待正式任务结束";

export function isBenchmarkRunning() {
  return !!controller || (running && !blockedTaskId && !formalWorkflows.size);
}

export function useBenchmarkRunning() {
  return useSyncExternalStore(benchmarkRunner.subscribe, isBenchmarkRunning);
}

export function useFormalWorkflowActivity(active: boolean, game: string, label: string, completed?: number, total?: number,
  unfinished = false, detail?: string) {
  const id = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const key = id.current ??= crypto.randomUUID();
    if (active || unfinished) formalWorkflows.set(key,{ id:key,game,label,completed,total,detail, state: active ? "running" : "unfinished" });
    else formalWorkflows.delete(key);
    publish();
    if (!formalWorkflows.size && running) queueMicrotask(pumpQueue);
  }, [active, game, label, completed, total, unfinished, detail]);
  useLayoutEffect(() => () => {
    const job = id.current && formalWorkflows.get(id.current);
    if (!job) return;
    formalWorkflows.delete(job.id);
    // Leaving an unfinished workspace does not release queued tests automatically.
    if (job.state === "unfinished") {
      for (const waiting of jobs) if (waiting.status === "等待") {
        waiting.status = waiting.progress?.state === "paused" ? "已暂停" : "待开始";
      }
      requestQueuePause("已暂停测试队列");
      return;
    }
    publish();
    if (!formalWorkflows.size && running) queueMicrotask(pumpQueue);
  }, []);
}

function performanceForDisplay(meter: StepPerformance): StepPerformance {
  const { benchmark, started, ...measurement } = meter;
  return structuredClone(measurement);
}

function currentConfigElapsedMs(value: BenchmarkProgress) {
  return configStartedAt === undefined ? value.configElapsedMs : Math.max(0, Date.now() - configStartedAt);
}

function publish() {
  const activeJob = jobs.find(job => job.status === "运行中");
  const meter = activeJob?.prepared && progress?.configId && stepPerformance(activeJob.prepared.runScope, activeJob.step);
  const matches = meter && meter.benchmark?.queueId === activeJob?.id &&
    (meter.benchmark.config as BenchmarkConfig | undefined)?.id === progress?.configId;
  const visibleProgress = progress?.state === "running"
    ? { ...progress, elapsedMs: performance.now() - startedAt, configElapsedMs: currentConfigElapsedMs(progress),
      performance: progress.performance ?? (matches ? performanceForDisplay(meter) : undefined) }
    : progress;
  snapshot = {
    version: snapshot.version + 1,
    jobs: jobs.map(({ prepared, prepare, onMessage, request, ...job }) => ({
      ...job, progress: job.status === "运行中" ? visibleProgress ?? undefined : job.progress,
    })),
    running, stopping: !!controller?.signal.aborted, formalBusy: formalWorkflows.size > 0, formalJobs: [...formalWorkflows.values()], historyRevision, blockedTaskId,
  };
  for (const listener of listeners) listener();
}

async function cleanupJob(job?: QueuedJob) {
  if (job) {
    // Only a started job owns the shared meters and its run checkpoint.
    job.prepared?.cleanup(job.id);
    job.prepared = undefined;
    job.prepare = undefined;
    job.onMessage = undefined;
  }
  await flushGamePerformanceArchive();
}

function requestQueuePause(reason: string) {
  running = false;
  for (const job of jobs) if (job.status === "等待") {
    if (job.progress?.state === "paused") job.status = "已暂停";
    else if (job.id === blockedTaskId) job.status = "待开始";
  }
  blockedTaskId = undefined;
  controller?.abort(reason);
  publish();
}

async function pauseQueue(reason: string, closeViewer = false) {
  requestQueuePause(reason);
  if (closeViewer) closeShownTask();
  await executing;
  await cleanupJob();
}

function nextJob() {
  return jobs.find(item => item.status === "等待");
}

async function runJobs() {
  while (running && !blockedTaskId && !formalWorkflows.size) {
    const job = nextJob();
    if (!job) break;
    if (showingTaskId === job.id && shownTaskDirty) {
      blockedTaskId = job.id;
      publish();
      break;
    }
    job.request = { ...job.request, configs: job.request.configs.filter(config => config.enabled !== false) };
    const abort = new AbortController();
    controller = abort;
    job.status = "运行中";
    job.startedTime ??= new Date().toISOString();
    const previous = job.progress;
    startedAt = performance.now() - (previous?.elapsedMs ?? 0);
    progress = { ...previous, jobId: job.id, scope: job.scope, step: job.step, state: "running",
      phase: "prepare", label: job.label, current: previous?.current ?? job.prepared?.restored ?? 0, total: job.prepared?.count ?? 0,
      sample: "", elapsedMs: previous?.elapsedMs ?? 0, percent: previous?.percent ??
        (job.prepared?.restored ? Math.floor(100 * job.prepared.restored / job.prepared.count) : 0), failed: previous?.failed ?? 0 };
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
        id: job.id, signal: abort.signal, elapsedMs: () => performance.now() - startedAt,
        report: (patch, configTiming) => {
          if (controller !== abort || !progress) return;
          const next = { ...progress, ...patch };
          if (configTiming === "start") {
            if (next.round !== undefined && job.round !== next.round) setJobRound(job, next.round);
            if (next.configId && !job.startedConfigIds.includes(next.configId))
              job.startedConfigIds = [...job.startedConfigIds, next.configId];
            const sameConfig = progress.configId === next.configId && progress.round === next.round;
            next.configElapsedMs = (sameConfig ? progress.configElapsedMs : undefined) ?? patch.configElapsedMs ?? 0;
            configStartedAt = Date.now() - next.configElapsedMs;
          } else {
            next.configElapsedMs = currentConfigElapsedMs(progress);
            if (configTiming) configStartedAt = undefined;
            if (configTiming === "complete" && next.configId)
              job.completedConfigIds = [...job.completedConfigIds, next.configId];
          }
          next.percent = next.total > 0 ? Math.floor(100 * next.current / next.total) : null;
          progress = next;
          publish();
        },
      });
      finished = true;
    } catch (cause) {
      failed = true;
      const detail = abort.signal.aborted ? String(abort.signal.reason) : cause instanceof Error ? cause.message : String(cause);
      progress = { ...progress, phase: "finish", detail };
      job.onMessage?.(job.label + " · " + detail, abort.signal.aborted ? "info" : "error");
    } finally {
      const paused = !finished && abort.signal.aborted;
      progress = { ...progress, configElapsedMs: currentConfigElapsedMs(progress) };
      configStartedAt = undefined;
      try {
        await cleanupJob(paused || waitForFormal ? undefined : job);
        if (finished && isMosaicBenchmarkStep(job.step)) localStorage.removeItem(savedRoundPlanKey(job.id));
        historyRevision++;
      } finally {
        window.clearInterval(timer);
        controller = undefined;
        job.status = paused ? "已暂停" : waitForFormal ? running ? "等待" : "待开始" : failed ? "失败" : "完成";
        progress = { ...progress, state: job.status === "已暂停" ? "paused" : "idle", elapsedMs: performance.now() - startedAt };
        job.progress = progress;
        if (paused && job.round < job.request.rounds &&
            job.completedConfigIds.length === configsForRound(job.request, job.round).length) setJobRound(job, job.round + 1);
        if (job.status === "失败") job.failure = progress.detail || "测试任务失败";
        const index = jobs.indexOf(job);
        if (paused && index > 0) jobs.unshift(...jobs.splice(index, 1));
        else if (job.status === "完成" && showingTaskId !== job.id && !paused && !waitForFormal && (!failed || progress.total > 0)) jobs.splice(index, 1);
        publish();
      }
    }
  }
}

function pumpQueue() {
  if (!running || executing || blockedTaskId || formalWorkflows.size) return;
  if (!nextJob()) {
    running = false;
    publish();
    return;
  }
  // Claim execution before any synchronous progress callback can start a second pump.
  executing = Promise.resolve().then(runJobs);
  void executing.finally(() => { executing = undefined; if (running) pumpQueue(); else publish(); }).catch(console.error);
}

function scheduleJob(job: QueuedJob) {
  const head = jobs[0];
  if (controller?.signal.aborted || (head?.status === "已暂停" && job !== head)) return false;
  if (head?.status !== "已暂停") {
    jobs.splice(jobs.indexOf(job), 1);
    const firstWaiting = jobs.findIndex(item => item.status === "等待" || item.status === "待开始");
    jobs.splice(firstWaiting < 0 ? jobs.length : firstWaiting, 0, job);
  }
  job.status = "等待";
  running = true;
  publish();
  pumpQueue();
  return true;
}

export function resumeBenchmarkJob(jobId: string): boolean {
  const job = jobs[0];
  return job?.id === jobId && job.status === "已暂停" && scheduleJob(job);
}

type ArchivedTask = ReturnType<typeof groupBenchmarkTasks>[number];
const savedRoundPlanKey = (id: string) => "llmchat-benchmark-round-plan:" + id;

function setJobRound(job: QueuedJob, round: number) {
  job.round = round;
  job.startedConfigIds = [];
  job.completedConfigIds = [];
}

async function prepareArchivedJob(input: BenchmarkInput, step: MosaicBenchmarkStep, task: ArchivedTask, history: BenchmarkResult[]): Promise<QueuedJob> {
  const { id, firstTime, continuation } = task;
  if (!continuation) throw new Error("这条记录没有可继续的完整测试批次");
  const { plan, completed, sampleSource, reuse } = continuation;
  const runs = history.filter(run => run.performance.benchmark?.queueId === id);
  const configElapsedMs = runs.reduce((total, run) => run.status === "已暂停" &&
    run.performance.benchmark?.batchIndex === completed.length ? total + run.performance.elapsedMs : total, 0);
  const details = await readImageBenchmarkDetails(id, sampleSource.performance.taskId!);
  if (details.samples.length !== sampleSource.selected) throw new Error("原测试样本清单不完整");
  const pendingPlan = JSON.parse(localStorage.getItem(savedRoundPlanKey(id)) || "null") as BenchmarkRoundPlan | null;
  const request: BenchmarkRequest = structuredClone({ ...plan, ...pendingPlan, scope: input.scope, step });
  const prepared = await prepareJob(input, request, false, { details, reuse, completed, configElapsedMs });
  const round = Math.floor(completed.length / request.configs.length) + 1;
  const configs = configsForRound(request, round);
  const completedConfigIds = configs.slice(0, completed.length % request.configs.length).map(config => config.id);
  const pausedRun = task.runs.find(run => run.status === "已暂停" && run.performance.benchmark?.batchIndex === completed.length);
  const pausedId = (pausedRun?.performance.benchmark?.config as BenchmarkConfig | undefined)?.id;
  const startedConfigIds = pausedId ? [...completedConfigIds, pausedId] : completedConfigIds;
  const label = benchmarkTargetLabel(step) + " · " + request.configs.length + " 个配置 × " + request.rounds + " 轮";
  const current = prepared.restored ?? 0;
  return { id, scope: prepared.scope, requestScope: input.scope, step, label, startedTime: firstTime || undefined,
    status: "已暂停", request, round, startedConfigIds, completedConfigIds, prepared, onMessage: input.onMessage, resumeSamples: true,
    progress: { jobId: id, scope: prepared.scope, step, state: "paused", phase: "finish",
      label, sample: "", current, total: prepared.count, percent: prepared.count ? Math.floor(current * 100 / prepared.count) : null,
      elapsedMs: runs.reduce((total, run) => total + run.performance.elapsedMs, 0),
      round, rounds: request.rounds, configId: pausedId, configElapsedMs, failed: completed.reduce((total, run) => total + run.failed, 0),
      performance: reuse ? performanceForDisplay(sampleSource.performance) : undefined } };
}

async function createQueuedJob(input: BenchmarkInput, request: BenchmarkRequest): Promise<QueuedJob> {
    if (request.scope !== input.scope) throw new Error("游戏工程已切换，请重新打开该工程的测试队列");
    const occupied = formalWorkflows.size > 0;
    const frozen = structuredClone(request);
    const deferred = occupied && !request.sampleSetPath;

    const prepared = deferred ? undefined : await prepareJob(input,frozen);
    const configs = frozen.configs.filter(config => config.enabled !== false);
    const title = benchmarkTargetLabel(request.step);
    const label = title + " · " + configs.length + " 个配置 × " + frozen.rounds + " 轮";
    const job: QueuedJob = { id: crypto.randomUUID(), scope: prepared?.scope || input.mosaicRoot || input.scope, requestScope: request.scope, step: request.step,
      label, status: running ? "等待" : "待开始", request: frozen, round: 1, startedConfigIds: [], completedConfigIds: [], prepared, onMessage: input.onMessage,
      resumeSamples: isMosaicBenchmarkStep(request.step) };
    if (deferred) job.prepare = () => prepareJob(input, job.request, true);
    return job;
}

function closeShownTask(id = showingTaskId) {
  if (!id || showingTaskId !== id) return;
  if (blockedTaskId === id) throw new Error("请先选择如何处理轮到的任务");
  showingTaskId = undefined;
  shownTaskDirty = false;
  const index = jobs.findIndex(job => job.id === id &&
    (job.status === "完成" || job.status === "失败" && !!job.progress?.total));
  if (index >= 0) { jobs.splice(index, 1); publish(); }
}

function shownJob(id: string) {
  const job = showingTaskId === id ? jobs.find(item => item.id === id) : undefined;
  if (!job) throw new Error("当前未显示此任务");
  return job;
}

function taskConfigView(job: QueuedJob): BenchmarkTaskConfig {
  const { rounds, sampleLimit, sampleSetPath, roundConfigs } = job.request;
  return structuredClone({ configs: configsForRound(job.request, job.round), rounds, sampleLimit, sampleSetPath,
    round: job.round, earlier: earlierRoundConfigs(job.request, job.round),
    fixedSlots: job.round > 1 || !!roundConfigs && Object.keys(roundConfigs).length > 0 });
}

function saveTaskConfigs(job: QueuedJob, round: number, draft: BenchmarkConfig[], confirmed = false) {
  if (!canEditBenchmarkTask(job) || round !== job.round) throw new Error("任务已切换轮次或开始执行，请重新查看配置");
  const view = taskConfigView(job);
  const changes = benchmarkRoundChanges(job.step, draft, view.configs, view.earlier);
  if (!changes.dirty) return;
  if (changes.needsConfirmation.size && !confirmed) throw new Error("请确认本轮参数与前面轮次不同");
  const configs = structuredClone(draft);
  const enabled = configs.filter(config => config.enabled !== false);
  if (!enabled.length) throw new Error("请至少启用一张配置卡");
  if (new Set(configs.map(config => config.id)).size !== configs.length) throw new Error("任务配置编号重复");
  if (view.fixedSlots && (configs.length !== enabled.length || enabled.length !== view.configs.length ||
      enabled.some((config, index) => config.id !== view.configs[index].id)))
    throw new Error("跨轮测试保留原有配置项和顺序，请修改未开始项的参数");
  const started = new Set(job.startedConfigIds);
  const startedConfigs = view.configs.filter(config => started.has(config.id));
  if (startedConfigs.some((config, index) => !enabled[index] || !sameBenchmarkConfig(job.step, config, enabled[index])))
    throw new Error("本轮已开始的配置及顺序不可修改");
  if (isMosaicBenchmarkStep(job.step) && enabled.some(config => !config.mosaic)) throw new Error("缺少去码测试配置");
  const roundConfigs = { ...job.request.roundConfigs };
  if (round > 1) {
    if (benchmarkRoundChanges(job.step, enabled, job.request.configs).dirty) roundConfigs[round] = enabled;
    else delete roundConfigs[round];
  }
  const plan: BenchmarkRoundPlan = { configs: round === 1 ? enabled : job.request.configs,
    roundConfigs: Object.keys(roundConfigs).length ? roundConfigs : undefined };
  const startedAny = started.size > 0 || round > 1;
  if (startedAny && isMosaicBenchmarkStep(job.step))
    localStorage.setItem(savedRoundPlanKey(job.id), JSON.stringify(plan));
  job.prepared?.updatePlan(plan, startedAny);
  job.request = { ...job.request, ...plan, configs: round === 1 && !startedAny && !view.fixedSlots ? configs : plan.configs };
  job.label = benchmarkTargetLabel(job.step) + " · " + plan.configs.length + " 个配置 × " + job.request.rounds + " 轮";
  if (job.prepared && job.progress) {
    const total = job.prepared.count;
    job.progress = { ...job.progress, total, configCount: plan.configs.length,
      percent: total ? Math.floor(100 * job.progress.current / total) : null };
  }
}

export const benchmarkRunner = {
  async enqueue(input: BenchmarkInput, request: BenchmarkRequest | BenchmarkRequest[]) {
    if (!Array.isArray(request)) {
      const job = await createQueuedJob(input, request);
      jobs.push(job);
      if (!request.priority || !scheduleJob(job)) { publish(); pumpQueue(); }
      return job.id;
    }
    if (!request.length) throw new Error("配置单没有测试任务");
    const imported = await Promise.all(request.map(item => createQueuedJob(input, item)));
    const runNext = running || request[0].priority && !controller?.signal.aborted && jobs[0]?.status !== "已暂停";
    imported.forEach(job => { job.status = runNext ? "等待" : "待开始"; });
    jobs.push(...imported);
    if (runNext) running = true;
    publish();
    pumpQueue();
    return imported.map(job => job.id);
  },
  async restoreLatestArchivedBatch(input: BenchmarkInput, isCurrent: () => boolean) {
    const canRestore = () => isCurrent() && !running && !executing &&
      !jobs.some(job => job.status === "已暂停" || job.status === "运行中");
    if (!input.mosaicRoot || !input.images || !canRestore()) return;
    const candidates = (await Promise.all((Object.keys(mosaicBenchmarkSteps) as MosaicBenchmarkStep[]).map(async step => {
      const history = await readGameBenchmarkHistory(input.scope + ":benchmark:mosaic", step);
      return groupBenchmarkTasks(history).filter(task => task.continuation).map(task => ({
        step, task, history, lastActivity: task.runs.reduce((latest, run) =>
          Math.max(latest, Date.parse(run.performance.endedAt || run.performance.beginTime || "") || 0), 0),
      }));
    }))).flat().sort((left, right) => right.lastActivity - left.lastActivity);
    let firstError: unknown;
    for (const { step, task, history } of candidates) {
      if (!canRestore()) return;
      if (jobs.some(job => job.id === task.id)) continue;
      try {
        const restored = await prepareArchivedJob(input, step, task, history);
        if (!canRestore()) return;
        if (jobs.some(job => job.id === restored.id)) continue;
        jobs.unshift(restored);
        publish();
        return;
      } catch (error) { firstError ??= error; }
    }
    if (firstError && canRestore()) throw firstError;
  },
  async continueArchivedBatch(input: BenchmarkInput, { queueId, step }: ArchivedBenchmarkRef) {
    if (!isMosaicBenchmarkStep(step)) throw new Error("该测试步骤不支持归档续跑");
    const findJob = () => jobs.find(job => job.id === queueId);
    const existing = findJob();
    if (existing) {
      if (existing.status === "已暂停" || existing.status === "待开始") scheduleJob(existing);
      return;
    }
    const history = await readGameBenchmarkHistory(input.scope + ":benchmark:mosaic", step);
    const task = groupBenchmarkTasks(history).find(task => task.id === queueId);
    if (!task) throw new Error("这条记录没有可继续的完整测试批次");
    const job = await prepareArchivedJob(input, step, task, history);
    if (!findJob()) {
      job.status = "待开始";
      jobs.push(job);
      if (!scheduleJob(job)) publish();
    }
  },
  startQueue(): string | null {
    const active = jobs.find(job => job.status === "运行中");
    if (active) return active.id;
    if (jobs[0]?.status === "已暂停") return null;

    const pending = jobs.filter(job => job.status === "待开始" || job.status === "等待");
    if (!pending.length) return null;
    pending.forEach(job => { job.status = "等待"; });
    running = true;
    publish();
    pumpQueue();
    return pending[0].id;
  },
  pauseQueue: () => pauseQueue("已暂停测试队列"),
  showTask(id: string): BenchmarkTaskConfig {
    const job = jobs.find(item => item.id === id);
    if (!job) throw new Error("此任务已离开队列");
    if (showingTaskId !== id) closeShownTask();
    showingTaskId = id;
    return taskConfigView(job);
  },
  hideTask: closeShownTask,
  releaseTask(id: string) {
    if (showingTaskId === id && blockedTaskId === id) requestQueuePause("已中止队列");
    closeShownTask(id);
  },
  setTaskDirty(id: string, dirty: boolean) {
    if (showingTaskId !== id) return;
    if (dirty && !canEditBenchmarkTask(shownJob(id))) throw new Error("任务已开始，当前修改尚未用于测试");
    shownTaskDirty = dirty;
    if (!dirty && blockedTaskId === id) {
      blockedTaskId = undefined;
      publish();
      pumpQueue();
    }
  },
  saveTask(id: string, round: number, configs: BenchmarkConfig[], confirmed?: boolean) {
    saveTaskConfigs(shownJob(id), round, configs, confirmed);
    shownTaskDirty = false;
    if (blockedTaskId === id) blockedTaskId = undefined;
    publish();
    pumpQueue();
  },
  decideTask(id: string, decision: BenchmarkTaskDecision, round?: number, configs?: BenchmarkConfig[], confirmed?: boolean) {
    const job = shownJob(id);
    if (blockedTaskId !== id) throw new Error("此任务已不在启动确认中");
    if (decision === "stop") { requestQueuePause("已中止队列"); return; }
    if (decision === "run") {
      if (!configs || round === undefined) throw new Error("请先保存本次修改的任务配置");
      saveTaskConfigs(job, round, configs, confirmed);
      shownTaskDirty = false;
      jobs.splice(jobs.indexOf(job), 1);
      jobs.unshift(job);
    } else {
      const eligible = (item: QueuedJob) => item !== job && (item.status === "等待" || item.status === "待开始");
      const next = jobs.find(eligible);
      if (!next) throw new Error("队列中没有其他待开始的任务");
      jobs.splice(jobs.indexOf(job), 1);
      jobs.push(job);
      next.status = "等待";
    }
    blockedTaskId = undefined;
    publish();
    pumpQueue();
  },

  start(id: string) {
    const job = jobs.find(item => item.id === id && (item.status === "待开始" || item.status === "已暂停"));
    if (job) scheduleJob(job);
  },
  stop(id: string) {
    if (!jobs.some(job => job.id === id && job.status === "运行中")) return;
    requestQueuePause("已中止此任务");
  },
  restart(id: string) {
    const job = jobs.find(item => item.id === id && item.status === "已暂停");
    if (!job) return;
    job.prepared?.restart(job.id);
    job.id = crypto.randomUUID();
    job.progress = undefined;
    job.startedTime = undefined;
    setJobRound(job, 1);
    scheduleJob(job);
  },
  async remove(id: string) {
    if (blockedTaskId === id) throw new Error("请先选择如何处理轮到的任务");
    const index = jobs.findIndex(job => job.id === id && job.status !== "运行中");
    if (index < 0) return;
    const [job] = jobs.splice(index, 1);
    publish();
    await cleanupJob(job.status === "已暂停" ? job : undefined);
    pumpQueue();
  },
  cleanup: () => pauseQueue("关闭测试窗口时中止此任务", true),
  snapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

export function useBenchmarkProgress(scope: string) {
  return useSyncExternalStore(benchmarkRunner.subscribe, () => {
    const state = benchmarkRunner.snapshot().jobs.find(job => job.status === "运行中")?.progress;
    return state?.scope === scope && state.state === "running" ? state : undefined;
  });
}

export function usePausedBenchmarkProgress(scope: string, steps: readonly BenchmarkTarget[]) {
  return useSyncExternalStore(benchmarkRunner.subscribe, () => {
    return benchmarkRunner.snapshot().jobs.find(job =>
      job.scope === scope && job.status === "已暂停" && steps.includes(job.step))?.progress;
  });
}

export function attachBenchmarkRunner() {
  let disposed = false, unregister: (() => void) | undefined;
  void registerAppCloseGuard(async () => {
    await pauseQueue("退出应用时中止此任务", true);
    return true;
  }).then(remove => { if (disposed) remove(); else unregister = remove; }).catch(console.error);
  return () => { disposed = true; unregister?.(); };
}
