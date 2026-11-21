import { useSyncExternalStore } from "react";
import { registerAppCloseGuard } from "../appClose";
import { imageBenchmarkRows, imageBenchmarkSteps, runGameImageSample, type ImageBenchmarkSetup, type ImageBenchmarkStep, type ImageBenchmarkWorkload } from "../gameImageBenchmark";
import { beginGameStep, clearGamePerformance, finishGameStep, flushGamePerformanceArchive, gameDuration, stepPerformance } from "../gameModelPerformance";
import { captureMosaicBenchmark, mosaicBenchmarkSteps, readEmbeddedBenchmarkImage, runMosaicBenchmark, type MosaicBenchmarkStep } from "../gameMosaicBenchmark";
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
export type BenchmarkRequest = { scope: string; step: BenchmarkTarget; configs: BenchmarkConfig[]; rounds: number };
export type BenchmarkState = {
  type: "benchmark-state";
  scope: string;
  step: BenchmarkTarget;
  state: "idle" | "running" | "paused";
  label: string;
  done: number;
  total: number;
  sample: string;
  elapsedMs: number;
  failed: number;
};
type BenchmarkJob = {
  id: string;
  scope: string;
  step: BenchmarkTarget;
  label: string;
  detail: string;
  count: number;
  status: "等待" | "运行中" | "完成" | "失败" | "已中止";
};
export type BenchmarkSnapshot = {
  version: number;
  jobs: readonly BenchmarkJob[];
  progress: BenchmarkState | null;
  running: boolean;
  stopping: boolean;
  historyRevision: number;
};

export const emptyBenchmarkSnapshot: BenchmarkSnapshot = {
  version: 0, jobs: [], progress: null, running: false, stopping: false, historyRevision: 0,
};

export function isMosaicBenchmarkStep(step: BenchmarkTarget): step is MosaicBenchmarkStep {
  return Object.hasOwn(mosaicBenchmarkSteps, step);
}

export function benchmarkTargetLabel(step: BenchmarkTarget) {
  if (isMosaicBenchmarkStep(step)) return mosaicBenchmarkSteps[step];
  return step === "screen" ? "筛选文本" : step === "translate" ? "翻译正文" : imageBenchmarkSteps[step].title;
}

type ProgressPatch = Partial<Pick<BenchmarkState, "label" | "done" | "total" | "sample" | "failed">>;
type JobContext = { id: string; signal: AbortSignal; update: (patch: ProgressPatch) => void; detail: (message: string) => void };
type Prepared = { count: number; scope: string; run: (context: JobContext) => Promise<number> };
type QueuedJob = BenchmarkJob & { prepared?: Prepared; onMessage?: BenchmarkInput["onMessage"] };

function prepareJob(input: BenchmarkInput, request: BenchmarkRequest): Prepared {
  const { step, rounds } = request;
  const configs = structuredClone(request.configs);
  if (request.scope !== input.scope) throw new Error("游戏工程已切换，请重新打开该工程的测试队列");
  if (!configs.length || !Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error("测试配置或轮次无效");
  const mosaic = isMosaicBenchmarkStep(step);
  const imageStep = !mosaic && step !== "screen" && step !== "translate" ? step : undefined;
  const imageSource = input.images;
  const historyScope = imageStep && imageSource ? imageSource.setup.scope : input.scope;
  const displayScope = mosaic ? input.mosaicRoot : historyScope;
  if (!displayScope) throw new Error("当前工程没有去码测试设置");

  const workload: Parameters<typeof runGameTextBenchmarks>[2] = { entries: [], selectedIds: new Set() };
  let count: number;
  let createStepRunner: ((context: JobContext, report: (value: UnityProgress) => void) => BenchmarkStepRunner) | undefined;
  if (mosaic) {
    if (!imageSource || configs.some(config => !config.mosaic)) throw new Error("当前工程没有去码测试样本或配置");
    const snapshot = structuredClone(captureMosaicBenchmark(imageSource.getWorkload(), displayScope));
    const options = configs[0].mosaic!;
    const checked = new Set(snapshot.checked);
    const eligible = snapshot.selected.filter(image => (options.selection === "all" || checked.has(image.id)) &&
      (step !== "mosaicRedraw" || !!snapshot.boxes[image.id]?.length));
    const sample = options.sampleLimit ? eligible.slice(0, options.sampleLimit) : eligible;
    if (!sample.length) throw new Error(step === "mosaicRedraw" ? "请先在去码页准备测试蒙版" : "没有可测试的去码图片，请检查勾选或调整样本范围");
    count = sample.length;
    createStepRunner = (context, report) => runMosaicBenchmark(step, sample, snapshot, context.signal, (image, signal) => {
      context.update({ sample: image.name });
      return snapshot.embedded ? readEmbeddedBenchmarkImage(snapshot.project!.root, image, signal) : imageSource.readImage!(snapshot.project!, image);
    }, report);
  } else if (imageStep) {
    if (!imageSource || !Object.hasOwn(imageSource.setup.steps, imageStep)) throw new Error("当前工程没有该图片测试步骤");
    const snapshot = structuredClone(imageSource.getWorkload());
    const setup = structuredClone(imageSource.setup);
    const sample = imageBenchmarkRows(imageStep, snapshot.selected);
    if (!sample.length) throw new Error("所勾选的图片没有符合当前步骤的样本，请检查选择及前置结果。");
    count = sample.length;
    createStepRunner = (context, report) => (config, settings, scope) => runGameImageSample(imageStep, sample, snapshot, config,
      setup, settings, scope, context.signal, image => imageSource.readImage!(snapshot.project!, image), input.onMessage,
      report, sample => context.update({ sample }));
  } else {
    const text = structuredClone(input.getWorkload());
    if (!text.selected.length) throw new Error("请先勾选要测试的文本");
    count = text.selected.length;
    workload.entries = text.entries;
    workload.selectedIds = new Set(text.selected.map(entry => entry.id));
    workload.dialoguePages = text.dialoguePages;
    if (step === "screen") {
      createStepRunner = (context, report) => (config, settings, scope) => runGameTextScreenSample(config, text.selected, settings,
        scope, context.signal, input.onMessage, report, sample => context.update({ sample }));
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
  return { count, scope: displayScope, run: async context => {
    const sampleLabel = (sample: string) => sample.replace(/\s+/g, " ").trim().slice(0, 140);
    let failures = 0, failedSamples = 0, runs = 0;
    const onSample = (sample: string) => context.update({ sample: sampleLabel(sample) });
    const progress = (value: UnityProgress) => {
      context.update({ done: value.completed, total: value.total ?? count,
        failed: failedSamples + (value.translation?.failedEntries ?? value.redrawFailed ?? 0) });
      context.detail(value.detail);
    };
    const target = createStepRunner ? { step, selected: count, run: createStepRunner({
      ...context,
      update: patch => context.update(patch.sample ? { ...patch, sample: sampleLabel(patch.sample) } : patch),
    }, progress) } : undefined;
    clearGamePerformance(totalScope, ["queue"]);
    const metadata = { part: mosaic ? "mosaic" : imageStep ? "images" : "text", step, queueId: context.id,
      rounds, configs: configs.length, selected: count, status: "运行中", runs: 0, failedRuns: 0 };
    beginGameStep(totalScope, "queue", metadata);
    input.onMessage("开始" + title + "测试 · " + configs.length + " 个配置 · " + rounds + " 轮", "info");
    try {
      await runGameTextBenchmarks(configs, rounds, workload, runScope, context.id, context.signal, input.onMessage,
        (round, config) => context.update({ label: title + " · 第 " + round + "/" + rounds + " 轮 · " + config.label,
          done: 0, total: count, sample: "", failed: failedSamples }),
        progress,
        result => {
          runs++;
          if (result.status === "失败") failures++;
          failedSamples += result.failed;
          context.update({ done: result.translated + result.failed, total: result.selected, failed: failedSamples });
        }, target, onSample);
      metadata.status = failures ? "测试失败" : "队列完成";
      return failures;
    } catch (cause) {
      metadata.status = context.signal.aborted ? "测试已中止" : "测试失败";
      throw cause;
    } finally {
      metadata.runs = runs;
      metadata.failedRuns = failures;
      finishGameStep(totalScope, true);
      const detail = "已执行 " + runs + "/" + (configs.length * rounds) + " 项" +
        (failures ? " · 失败 " + failures + " 项" : "") + " · " + gameDuration(stepPerformance(totalScope, "queue").elapsedMs);
      context.detail(detail);
      input.onMessage(title + "测试 · " + detail, failures ? "error" : "info");
      clearGamePerformance(totalScope, ["queue"]);
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

function publish() {
  snapshot = {
    version: snapshot.version + 1,
    jobs: jobs.map(({ prepared, onMessage, ...job }) => job),
    progress: progress && { ...progress, elapsedMs: progress.state === "running" ? performance.now() - startedAt : progress.elapsedMs },
    running, stopping: !!controller?.signal.aborted, historyRevision,
  };
  for (const listener of listeners) listener();
}

async function runJobs() {
  while (running) {
    const job = jobs.find(item => item.status === "等待");
    if (!job?.prepared) break;
    const abort = new AbortController();
    controller = abort;
    job.status = "运行中";
    startedAt = performance.now();
    progress = { type: "benchmark-state", scope: job.scope, step: job.step, state: "running",
      label: job.label, done: 0, total: job.count, sample: "", elapsedMs: 0, failed: 0 };
    publish();
    const timer = window.setInterval(publish, 1000);
    try {
      const failures = await job.prepared.run({
        id: job.id, signal: abort.signal,
        update: patch => { if (controller === abort) { progress = { ...progress!, ...patch }; publish(); } },
        detail: message => { if (controller === abort) { job.detail = message; publish(); } },
      });
      job.status = abort.signal.aborted ? "已中止" : failures ? "失败" : "完成";
    } catch (cause) {
      job.status = abort.signal.aborted ? "已中止" : "失败";
      job.detail = cause instanceof Error ? cause.message : String(cause);
      job.onMessage?.(job.label + " · " + job.status + " · " + job.detail, job.status === "失败" ? "error" : "info");
    } finally {
      window.clearInterval(timer);
      controller = undefined;
      job.prepared = undefined;
      job.onMessage = undefined;
      progress = { ...progress!, state: abort.signal.aborted ? "paused" : "idle", elapsedMs: performance.now() - startedAt };
      await flushGamePerformanceArchive();
      historyRevision++;
      publish();
    }
  }
}

function stopQueue() {
  running = false;
  controller?.abort();
  publish();
}

export const benchmarkRunner = {
  enqueue(input: BenchmarkInput, request: BenchmarkRequest) {
    const prepared = prepareJob(input, request);
    const job: QueuedJob = { id: crypto.randomUUID(), scope: prepared.scope, step: request.step,
      label: benchmarkTargetLabel(request.step), detail: request.configs.length + " 个配置 · " + request.rounds + " 轮",
      status: "等待", count: prepared.count, prepared, onMessage: input.onMessage };
    jobs.push(job);
    publish();
    return job.id;
  },
  start() {
    if (executing || !jobs.some(job => job.status === "等待")) return;
    running = true;
    publish();
    const work = runJobs();
    executing = work;
    void work.finally(() => { executing = undefined; running = false; publish(); }).catch(console.error);
  },
  stop: stopQueue,
  remove(id: string) {
    const index = jobs.findIndex(job => job.id === id && job.status !== "运行中");
    if (index < 0) return;
    jobs.splice(index, 1);
    publish();
  },
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
  void registerAppCloseGuard(async () => {
    stopQueue();
    await executing;
    await flushGamePerformanceArchive();
    return true;
  }).then(remove => { if (disposed) remove(); else unregister = remove; }).catch(console.error);
  return () => { disposed = true; unregister?.(); };
}
