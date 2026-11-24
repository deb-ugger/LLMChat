import { configsForRound, type BenchmarkRoundPlan } from "./benchmark/benchmarkRoundPlan";
import { readImageBenchmarkDetails, saveImageBenchmarkDetails, type ImageBenchmarkInput, type ImageBenchmarkOutcome, type RecordImageBenchmarkOutcome } from "./benchmark/imageBenchmarkHistory";
import { mosaicWallClock, type MosaicScoreFreeze } from "./benchmark/mosaicScoreInputs";
import { mosaicBenchmarkScoreSummary, mosaicBenchmarkSteps, type MosaicBenchmarkSetup, type MosaicBenchmarkStep } from "./gameMosaicBenchmark";
import { clearMosaicReviews } from "./gameMosaicRefine";
import { api, type Settings, type OcrMode, type TranslateProvider } from "./api";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { gameTextHasSpeaker, gameTextMatchesSource, gameTextNeedsNoTranslation, preserveTargetGameText, translateGameDisplayText, translateRpgSystemMessage } from "./gameDisplayText";
import { validateGameNaturalLines, wrapGameTextToSource, type GameWrapMode } from "./gameTextLayout";
import { gameTextProblem } from "./gameTextProject";
import { createGameTranslationContext, gameDialogueReuseKey, gameTranslationRetry, isGameDialogue, type GameDialoguePage } from "./gameTranslationContext";
import { prepareGameTerms, gameTermProblem } from "./gameTermMemory";
import { gameTaskPrompt, type GamePromptSelection } from "./gamePrompts";
import { canDisableOllamaNameThinking, prepareGameOllamaModels, translateGameWithOllama } from "./gameOllama";
import { archivePausedGameStep, beginGameStep, clearGamePerformance, completeGameStep, finishGameStep, flushGamePerformanceArchive, measureGameAsync, measureGameWork, modelServiceTimingLines, pendingGameBenchmarkArchives, rememberBenchmarkExecution, stepPerformance, type StepPerformance } from "./gameModelPerformance";
import { createUnityEnginePool, type UnityEngineChoice } from "./unityEnginePool";
import { engineReady, parseEngineKeys } from "./translateEngines";
import { screenGameText } from "./gameTextScreening";
import { loadLocalModelProfiles, resolveFeatureLlm } from "./modelPresets";
import { buildUnityTranslateOptions, localTextRequestGroup, prepareUnityTranslationRequest, restoreUnityTranslationLines } from "./unityTranslation";
import { translateUnitySession } from "./unityTranslationSession";
import type { UnityEntry, UnityProgress } from "./unityOffline";

export const benchmarkRoles = ["text", "dialogue", "names"] as const;
type Role = typeof benchmarkRoles[number];
export type BenchmarkConfig = {
  id: string; label: string; source: string; target: string; enabled?: boolean;
  models: Record<Role, { id: string; lanes: number }>;
  mosaic?: MosaicBenchmarkSetup;
  imageMode?: OcrMode; imageStrategy?: "staged" | "full"; localLanes?: number; imageConfidence?: number; engines?: UnityEngineChoice[];
  prompts: GamePromptSelection; wrap: GameWrapMode; includeContext: boolean; skipTarget: boolean;
};
export type BenchmarkResult = {
  round: number; label: string; selected: number; translated: number; failed: number;
  status: "完成" | "失败" | "已中止" | "已暂停"; detail?: string; summary?: string; unobservedModels: string[]; performance: StepPerformance;
};
export type ArchivedBenchmarkRef = { queueId: string; step: MosaicBenchmarkStep };
type BenchmarkBatchPlan = BenchmarkRoundPlan & { rounds: number; sampleSetPath?: string; referenceSampleSetPath?: string };
export type BenchmarkSample = { selected: number; text: number; dialogue: number; retained: number };

export function groupBenchmarkTasks(results: readonly BenchmarkResult[]) {
  const groups = new Map<string, BenchmarkResult[]>();
  results.forEach((result, index) => {
    const queueId = result.performance.benchmark?.queueId;
    const id = typeof queueId === "string" && queueId ? queueId : `run:${result.performance.taskId ?? index}`;
    const group = groups.get(id);
    if (group) group.push(result);
    else groups.set(id, [result]);
  });
  return [...groups].map(([id, records]) => {
    const runs = records.sort((left, right) => left.round - right.round ||
      (left.performance.beginTime || "").localeCompare(right.performance.beginTime || ""));
    const firstTime = runs[0].performance.beginTime || runs[0].performance.endedAt || "";
    const configs = new Set(runs.map(run => (run.performance.benchmark?.config as { id?: string } | undefined)?.id || run.label));
    const plan = runs.reduce<BenchmarkBatchPlan | undefined>((latest, run) =>
      (run.performance.benchmark?.batchPlan as BenchmarkBatchPlan | undefined) ?? latest, undefined);
    const latestRuns = plan ? [...new Map(runs.map(run => [run.performance.benchmark?.batchIndex, run])).values()] : runs;
    const completed = latestRuns.filter(run => run.status === "完成" || run.status === "失败");
    const meta = latestRuns[0]?.performance.benchmark;
    const rounds = plan?.rounds ?? (typeof meta?.rounds === "number" ? meta.rounds : undefined);
    const configCount = plan?.configs.length ?? (typeof meta?.configCount === "number" ? meta.configCount : undefined);
    const sampleRecord = latestRuns.find(run => run.performance.benchmark?.batchIndex === completed.length &&
      run.status === "已暂停" && run.performance.benchmark?.imageDetails);
    const sampleSource = sampleRecord ?? runs.find(run => run.performance.benchmark?.imageDetails);
    const continuation = plan && completed.length < plan.rounds * plan.configs.length && sampleSource?.performance.taskId
      ? { plan, completed, sampleSource, reuse: !!sampleRecord } : undefined;
    return { id, runs: latestRuns, firstTime, completed: completed.length, planned: rounds !== undefined && configCount !== undefined, continuation,
      rounds: rounds ?? new Set(runs.map(run => run.round)).size, configs: configCount ?? configs.size,
      failed: latestRuns.filter(run => run.status === "失败" || run.failed > 0).length,
      stopped: latestRuns.filter(run => run.status === "已中止" || run.status === "已暂停").length };
  }).sort((left, right) => right.firstTime.localeCompare(left.firstTime));
}

export function benchmarkHistoryResults(records: StepPerformance[]): BenchmarkResult[] {
  const unique = new Map<string, BenchmarkResult>();
  for (const record of records) {
    const benchmark = record.benchmark;
    if (!benchmark || typeof benchmark.round !== "number" || typeof benchmark.label !== "string" || !record.taskId) continue;
    const status = benchmark.status === "完成" || benchmark.status === "失败" || benchmark.status === "已暂停" ? benchmark.status : "已中止";
    const previous = unique.get(record.taskId);
    if (previous?.performance.endedAt && record.endedAt && previous.performance.endedAt > record.endedAt) continue;
    unique.set(record.taskId, { round: benchmark.round, label: benchmark.label,
      selected: Number(benchmark.selected) || 0, translated: Number(benchmark.translated) || 0, failed: Number(benchmark.failed) || 0,
      status, detail: typeof benchmark.detail === "string" ? benchmark.detail : undefined,
      summary: typeof benchmark.summary === "string" ? benchmark.summary : undefined,
      unobservedModels: Array.isArray(benchmark.unobservedModels) ? benchmark.unobservedModels.filter((model): model is string => typeof model === "string") : [],
      performance: record,
    });
  }
  return [...unique.values()].sort((left, right) => (right.performance.endedAt || right.performance.beginTime || "").localeCompare(left.performance.endedAt || left.performance.beginTime || ""));
}

export async function readGameBenchmarkHistory(scope?: string, step?: string): Promise<BenchmarkResult[]> {
  await flushGamePerformanceArchive();
  const records = isTauri() ? await invoke<StepPerformance[]>("read_game_performance", { scope, step }) : [];
  return benchmarkHistoryResults([...records, ...pendingGameBenchmarkArchives(scope, step)]);
}

/** 正式运行记录：只取正式（非测试队列）归档，用于「运行记录 → 正式运行」。 */
export async function readGameFormalHistory(scope?: string, step?: string): Promise<StepPerformance[]> {
  await flushGamePerformanceArchive();
  const records = isTauri()
    ? await invoke<StepPerformance[]>("read_game_performance", { scope, step, kind: "formal" })
    : [];
  return records.sort((left, right) => (right.endedAt || right.beginTime || "").localeCompare(left.endedAt || left.beginTime || ""));
}
export function inspectBenchmarkSample(entries: UnityEntry[], configs: BenchmarkConfig[]): Record<string, BenchmarkSample> {
  const byLanguage = new Map<string, BenchmarkSample>();
  return Object.fromEntries(configs.map(config => {
    const key = JSON.stringify([config.source, config.target, config.skipTarget]);
    let sample = byLanguage.get(key);
    if (!sample) {
      sample = { selected: entries.length, text: 0, dialogue: 0, retained: 0 };
      for (const entry of entries) {
        const outsideSource = !gameTextMatchesSource(entry.source, config.source, entry.locale);
        const alreadyTarget = config.skipTarget && gameTextNeedsNoTranslation(entry.source, config.target);
        if (outsideSource || alreadyTarget) sample.retained++;
        else if (isGameDialogue(entry.source, entry)) sample.dialogue++;
        else sample.text++;
      }
      byLanguage.set(key, sample);
    }
    return [config.id, sample];
  }));
}

type Workload = { entries: UnityEntry[]; dialoguePages?: GameDialoguePage[]; selectedIds: ReadonlySet<string> };
type Reporter = Parameters<typeof translateGameWithOllama>[3];

async function runSample(config: BenchmarkConfig, workload: Workload, settings: Settings, scope: string,
  signal: AbortSignal, report: Reporter, progress: (value: UnityProgress) => void, onSample?: (sample: string) => void) {
  const entries = workload.entries.map(entry => workload.selectedIds.has(entry.id)
    ? { ...entry, selected: true, translation: "", error: "", layoutDraft: undefined, screeningDraft: undefined }
    : { ...entry, selected: false });
  const rows = entries.filter(entry => entry.selected);
  measureGameWork(scope, "processingMs", () => preserveTargetGameText(rows, config.target, config.source, config.skipTarget));
  const references = rows; // Reuse only content produced in this sample.
  const context = createGameTranslationContext(entries, config.includeContext, workload.dialoguePages);
  const profiles = loadLocalModelProfiles();
  const models = Object.fromEntries(benchmarkRoles.map(role => {
    const selected = config.models[role].id ? config.models[role] : config.models.text;
    const resolved = buildUnityTranslateOptions(settings, "llm", config.source, config.target, selected.id, config.wrap !== "keep",
      !!profiles[selected.id], gameTaskPrompt(role, config.prompts, {source:config.source,target:config.target}), config.wrap);
    return [role, { ...resolved, llmConcurrency: selected.lanes, performanceScope: scope, performanceStep: "translate" }];
  })) as Record<Role, ReturnType<typeof buildUnityTranslateOptions>>;
  const enabledEngines = config.models.text.id ? [] : (config.engines || []).filter(engine => engine.enabled && engineReady(parseEngineKeys(settings.translateEngineKeys), engine.id));
  if (!config.models.text.id && !enabledEngines.length) throw new Error("请启用可用的文本翻译引擎");
  const pool = enabledEngines.length ? createUnityEnginePool(enabledEngines, signal, async (provider: TranslateProvider, text: string) => {
    const options = buildUnityTranslateOptions(settings, provider, config.source, config.target);
    const result = await translateGameWithOllama(text, { signal }, options, report);
    if (!result.ok) throw new Error(result.error || result.code || "翻译请求失败");
    return result.translation;
  }, { timingScope: scope }) : null;
  let terms: ReadonlyMap<string,string> = new Map();
  const request = (input: string, entry?: UnityEntry, nameContext?: string) => {
    onSample?.(entry?.source ?? input);
    const systemTranslation = translateRpgSystemMessage(entry, config.target);
    if (systemTranslation !== undefined) return Promise.resolve(systemTranslation);
    const role = nameContext ? "names" : isGameDialogue(input, entry) ? "dialogue" : "text";
    const model = models[role];
    return translateGameDisplayText(input, async (text, reference, retryReason) => {
      const prepared = prepareUnityTranslationRequest(text, config.wrap !== "keep");
      if (pool) return pool.translate(prepared);
      const result = await translateGameWithOllama(prepared, { signal },
        { ...model, ...gameTranslationRetry(context(entry, nameContext, reference), retryReason), ollamaReasoningOff: !!nameContext && canDisableOllamaNameThinking(model) }, report);
      if (!result.ok) throw new Error(result.error || result.code || "翻译请求失败");
      return result.translation;
    }, config.target, config.source, terms, config.skipTarget, !pool && role === "dialogue");
  };
  try {
    const preparedTerms = await prepareGameTerms(rows.filter(entry => !entry.translation), references, config.target, settings.textGlossary,
      (name, dialogue) => request(name, undefined, dialogue), signal,
      (detail, completed, total) => progress({ detail, completed, total, textStage: "names", model: models.names.model }));
    terms = preparedTerms.terms;
    await translateUnitySession(rows, new Map(), {
      signal, references, key: gameDialogueReuseKey, entryProblem: entry => gameTermProblem(entry.source, preparedTerms.issues), concurrency: pool ? Math.max(1, pool.concurrency) : Object.values(models).some(model => model.localModel) ? 8 : 16,
      timingScope: scope, requestGroup: pool ? undefined : localTextRequestGroup(models.text, models.dialogue), validate: gameTextProblem, persist: async () => {},
      translate: (text, entry) => request(text, entry),
      format: config.wrap === "natural" ? validateGameNaturalLines : config.wrap === "join" ? (source, translated) =>
        wrapGameTextToSource(source, gameTextHasSpeaker(source) ? translated : restoreUnityTranslationLines(source, translated)) : undefined,
      preserveLayout: !pool ? isGameDialogue : config.wrap === "keep" ? gameTextHasSpeaker : undefined, progress,
    });
  } finally { pool?.dispose(); }
  signal.throwIfAborted();
  const failed = rows.filter(entry => entry.error || !entry.translation).length;
  return { failed, translated: rows.length - failed };
}

export type BenchmarkStepRunner = (config: BenchmarkConfig, settings: Settings, scope: string, record?: RecordImageBenchmarkOutcome, runId?: string,
  preceding?: ReadonlyMap<string, ImageBenchmarkOutcome>) => Promise<{ translated: number; failed: number; summary?: string }>;

export function benchmarkResultLines(result: BenchmarkResult) {
  const seconds = (milliseconds: number | undefined) => milliseconds === undefined ? "—" : (milliseconds / 1000).toFixed(2) + " 秒";
  const measured = result.performance;
  const speed = measured.elapsedMs > 0 ? (result.translated * 60000 / measured.elapsedMs).toFixed(1) : "—";
  const lines = [`第 ${result.round} 轮 · ${result.label} · ${result.status} · 总用时 ${seconds(measured.elapsedMs)} · 完成 ${result.translated}/${result.selected} · 失败 ${result.failed} · 每分钟完成 ${speed} 个样本`];
  for (const model of Object.values(measured.models)) {
    const generation = model.generationMs > 0 ? (model.generationTokens * 1000 / model.generationMs).toFixed(1) : "—";
    const average = model.requestMs > 0 && model.tokens > 0 ? (model.tokens * 1000 / model.requestMs).toFixed(1) : "—";
    lines.push(`${model.model} · 并发 ${model.concurrency} · 请求 ${model.requests} 次 · 输出 ${model.tokens} tokens · 纯生成 ${generation} tok/s · 请求平均 ${average} tok/s · 请求耗时合计 ${seconds(model.requestMs)}`);
    if (model.serviceTiming) lines.push(...modelServiceTimingLines(model.serviceTiming, model.requests, seconds));
  }
  const timing = measured.wallTiming || measured.timing;
  if (timing) lines.push(`分项用时 · 排队 ${seconds(timing.queueMs)} · 处理与校验 ${seconds(timing.processingMs)} · 保存 ${seconds(timing.saveMs)} · 模型请求占用 ${seconds(timing.modelRequestMs)}`);
  if (measured.wallTiming?.detectorMs !== undefined) lines.push("检测推理 " + seconds(measured.wallTiming.detectorMs));
  if (measured.wallTiming?.ocrMs !== undefined) lines.push("本地 OCR " + seconds(measured.wallTiming.ocrMs));
  if (measured.cacheHits) lines.push("结果复用 " + measured.cacheHits + " 次");
  if (measured.timing?.workflowMs !== undefined) lines.push("ComfyUI 执行 " + seconds(measured.timing.workflowMs));
  if (result.summary) lines.push(result.summary);
  if (result.detail) lines.push(result.detail);
  if (result.unobservedModels.length) lines.push("未记录模型请求：" + result.unobservedModels.join("、"));
  return lines;
}

export async function runGameTextScreenSample(config: BenchmarkConfig, selected: UnityEntry[], settings: Settings, scope: string,
  signal: AbortSignal, report: Reporter, progress: (value: UnityProgress) => void, onSample?: (sample: string) => void) {
  const rows = selected.map(entry => ({ ...entry, translation: "", error: "", layoutDraft: undefined, screeningDraft: undefined }));
  const prompts = { ...config.prompts };
  rememberBenchmarkExecution(prompts, scope, "screen", config.models.text.lanes);
  if (rows[0]) onSample?.(rows[0].source);
  await screenGameText(rows, {
    settings, prompts, signal, onOllamaStatus: report, model: config.models.text.id || undefined,
    source: config.source, target: config.target, skipTarget: config.skipTarget,
    onProgress: (completed, total) => progress({ completed, total, detail: "正在筛选文本 " + completed + " / " + total }),
    onSample,
  });
  return { translated: rows.length, failed: 0 };
}

export async function runGameTextBenchmarks(baseConfigs: BenchmarkConfig[], rounds: number, workload: Workload, scope: string, queueId: string, signal: AbortSignal,
  report: Reporter, onStart: (round: number, config: BenchmarkConfig) => void, onProgress: (value: UnityProgress) => void,
  onResult: (result: BenchmarkResult) => void,
  target?: { step: string; selected: number; imageSamples?: ImageBenchmarkInput[]; scoreFreeze?: MosaicScoreFreeze; reusedImages?: () => number; run: BenchmarkStepRunner }, onSample?: (sample: string) => void,
  resumeAt = 0, sampleSetPath?: string, referenceSampleSetPath?: string, sampleLimit?: number,
  roundConfigs?: BenchmarkRoundPlan["roundConfigs"]) {
  const plan = { configs: baseConfigs, roundConfigs };
  let settings: Settings | undefined;
  let modelsReady = false;
  const step = target?.step || "translate";
  const mosaic = Object.hasOwn(mosaicBenchmarkSteps, step);
  const activeRoles = target ? ["text"] as const : benchmarkRoles;
  const local = loadLocalModelProfiles();
  const prepareModels = (settings: Settings) => prepareGameOllamaModels(baseConfigs.concat(...Object.values(roundConfigs ?? {}))
    .flatMap(config => (target || config.models.text.id ? activeRoles : []).map(role => config.models[role]))
    .filter(model => !!model.id && !!local[model.id])
    .map(model => ({ connection: { ...resolveFeatureLlm(settings, model.id), localModel: true }, lanes: model.lanes })), signal, report);
  const samples = target?.imageSamples;
  const index = samples ? new Map(samples.map((sample, number) => [sample.id,number])) : undefined;
  let savedSamples = false;
  for (let round = Math.floor(resumeAt / baseConfigs.length) + 1; round <= rounds; round++) {
    signal.throwIfAborted();
    const configs = configsForRound(plan, round);
    const roundStarted = performance.now();
    const firstConfig = Math.max(0, resumeAt - (round - 1) * configs.length);
    let finishedConfigs = firstConfig, failedConfigs = 0;
    report(`开始第 ${round} / ${rounds} 轮测试 · ${configs.length} 个配置`, "info");
    for (const [offset, config] of configs.slice(firstConfig).entries()) {
      signal.throwIfAborted();
      const selected = target?.selected ?? workload.selectedIds.size;
      const unobservedModels: string[] = [];
      const saved = stepPerformance(scope, step);
      const former = saved.benchmark?.queueId === queueId && saved.benchmark.round === round &&
        (saved.benchmark.config as Pick<BenchmarkConfig, "id"> | undefined)?.id === config.id ? saved.benchmark : undefined;
      if (saved.taskId && !former) {
        if (step === "mosaicRefine" && saved.benchmark?.status !== "已暂停") clearMosaicReviews("benchmark:" + saved.taskId);
        clearGamePerformance(scope, [step], false);
      }
      const batchIndex = (round - 1) * configs.length + firstConfig + offset;
      const batchPlan: BenchmarkBatchPlan | undefined = mosaic && batchIndex === resumeAt ? { ...plan, rounds, sampleSetPath, referenceSampleSetPath } : undefined;
      const reusedImages = target?.reusedImages?.() ?? 0;
      const scoreTiming = target?.scoreFreeze ? former
        ? former.scoreTiming === mosaicWallClock && saved.elapsedMs > 0 ? mosaicWallClock : "segment-only"
        : reusedImages ? "reused-output" : mosaicWallClock : undefined;
      // Shared model preparation happens once per batch and is outside each scored wall clock.
      let preparationFailure: { cause: unknown } | undefined;
      if (target?.scoreFreeze && !modelsReady) {
        try {
          settings ??= await api.getSettings();
          await prepareModels(settings);
          modelsReady = true;
        } catch (cause) { preparationFailure = { cause }; }
      }
      const metadata = { queueId, round, rounds, configCount: configs.length, sampleLimit, unobservedModels, sampleSetPath, referenceSampleSetPath, batchPlan, batchIndex: mosaic ? batchIndex : undefined,
        scoreFreeze: target?.scoreFreeze, scoreTiming, reusedImages,
        label: config.label, selected, config, translated: 0, failed: 0, status: "运行中",
        detail: undefined as string | undefined, summary: undefined as string | undefined, imageDetails: false };
      beginGameStep(scope, step, metadata);
      const runId = stepPerformance(scope,step).taskId!;
      onStart(round, config);
      const roleNames = { text: "正文", dialogue: "对白", names: "术语" };
      const modelDetails = (target || config.models.text.id ? activeRoles : []).map(role => {
        const model = config.models[role].id ? config.models[role] : config.models.text;
        return model.id ? `${roleNames[role]} ${model.id} · 并发 ${model.lanes}` : "";
      }).filter(Boolean);
      report(`第 ${round} 轮 · ${former ? "继续" : "开始"} ${config.label} · 样本 ${selected} · ${modelDetails.join("；") || "本地处理或翻译引擎"}`, "info");
      const results: Record<string, ImageBenchmarkOutcome> = {};
      const record: RecordImageBenchmarkOutcome | undefined = index && ((id, outcome) => {
        const number = index.get(id);
        if (number !== undefined) results[number] = outcome;
      });
      let status: BenchmarkResult["status"] = "完成", detail: string | undefined;
      let partialTranslated = 0, partialFailed = 0;
      const progress = (value: UnityProgress) => {
        if (step === "translate" && value.coverageCompleted !== undefined) {
          partialTranslated = value.coverageCompleted;
          partialFailed = value.translation?.failedEntries ?? 0;
        } else if (step === "screen") partialTranslated = value.completed;
        onProgress(value);
      };
      try {
        if (preparationFailure) throw preparationFailure.cause;
        if (former?.imageDetails) {
          const previous = await readImageBenchmarkDetails(queueId, runId);
          Object.assign(results, previous.results);
          savedSamples = true;
        }
        settings ??= await api.getSettings();
        if (!modelsReady) { await prepareModels(settings); modelsReady = true; }
        signal.throwIfAborted();
        const preceding = former?.imageDetails && mosaic && samples ? new Map(samples.flatMap((sample, index) => {
          const outcome = results[index];
          return outcome && outcome.status !== "失败" ? [[sample.id, outcome] as const] : [];
        })) : undefined;
        const result = await (target ? target.run(config, settings, scope, record, runId, preceding) : runSample(config, workload, settings, scope, signal, report, progress, onSample));
        Object.assign(metadata, result);
        if (result.failed) status = "失败";
      } catch (error) {
        status = signal.aborted ? "已暂停" : "失败";
        detail = signal.aborted ? String(signal.reason || "测试已暂停") : error instanceof Error ? error.message : String(error);
      } finally {
        const complete = metadata.translated + metadata.failed >= selected;
        const interrupted = signal.aborted && !complete;
        if (interrupted) {
          status = "已暂停";
          detail ??= String(signal.reason || "测试已暂停");
          if (!samples) {
            metadata.translated = Math.min(selected, partialTranslated);
            metadata.failed = Math.min(selected - metadata.translated, partialFailed);
          }
        }
        metadata.status = status;
        metadata.detail = detail;
        const recorded = new Set(Object.values(stepPerformance(scope, step).models).filter(model => model.requests > 0).map(model => model.model));
        for (const id of new Set((target || config.models.text.id ? activeRoles : []).map(role => config.models[role].id))) {
          if (id && !recorded.has(id)) unobservedModels.push(id);
        }
        if (samples) {
          if (interrupted) {
            const outcomes = Object.values(results);
            metadata.failed = outcomes.filter(row => row.status === "失败").length;
            metadata.translated = outcomes.length - metadata.failed;
          }
          try {
            await measureGameAsync(scope, "saveMs", () => saveImageBenchmarkDetails(queueId, runId, savedSamples ? undefined : samples, results));
            savedSamples = true;
            metadata.imageDetails = true;
          } catch (error) {
            status = interrupted ? "已暂停" : "失败";
            metadata.status = status;
            metadata.detail = detail = [detail, "逐图记录保存失败：" + String(error)].filter(Boolean).join(" · ");
          }
        }
        if (samples && target?.scoreFreeze && (step === "mosaicScreen" || step === "mosaicRefine")) {
          finishGameStep(scope);
          const accuracy = mosaicBenchmarkScoreSummary(step, samples, results, {
            status, runFailures: metadata.failed, elapsedMs: stepPerformance(scope, step).elapsedMs,
            freeze: target.scoreFreeze, timing: scoreTiming, issues: metadata.imageDetails ? [] : ["逐图记录保存失败"],
          });
          metadata.summary = [metadata.summary, accuracy].filter(Boolean).join(" · ");
        }
        const checkpointed = interrupted && mosaic;
        if (checkpointed) archivePausedGameStep(scope, step);
        else completeGameStep(scope, step);
        const performance = stepPerformance(scope,step);
        if (!checkpointed) {
          if (step === "mosaicRefine") clearMosaicReviews("benchmark:" + runId);
          clearGamePerformance(scope, [step], false);
        }
        const result: BenchmarkResult = { round, label: config.label, selected, translated: metadata.translated, failed: metadata.failed, status, detail, summary: metadata.summary, unobservedModels, performance };
        onResult(result);
        for (const line of benchmarkResultLines(result)) report(line, status === "完成" ? "success" : status === "失败" ? "error" : "info");
        if (!interrupted) finishedConfigs++;
        if (status === "失败") failedConfigs++;
      }
      if (signal.aborted) {
        report(`第 ${round} 轮已暂停 · 已执行 ${finishedConfigs}/${configs.length} 个配置 · 耗时 ${((performance.now() - roundStarted) / 1000).toFixed(2)} 秒`, "info");
        signal.throwIfAborted();
      }
    }
    report(`第 ${round} 轮完成 · 配置 ${finishedConfigs} · 失败配置 ${failedConfigs} · 耗时 ${((performance.now() - roundStarted) / 1000).toFixed(2)} 秒`, failedConfigs ? "error" : "success");
  }
}
