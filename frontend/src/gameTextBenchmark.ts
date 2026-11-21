import type { MosaicBenchmarkSetup } from "./gameMosaicBenchmark";
import { api, type Settings, type OcrMode, type TranslateProvider } from "./api";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { gameTextHasSpeaker, gameTextMatchesSource, gameTextNeedsNoTranslation, preserveTargetGameText, translateGameDisplayText, translateRpgSystemMessage } from "./gameDisplayText";
import { validateGameNaturalLines, wrapGameTextToSource, type GameWrapMode } from "./gameTextLayout";
import { gameTextProblem } from "./gameTextProject";
import { createGameTranslationContext, gameDialogueReuseKey, gameTranslationRetry, isGameDialogue, type GameDialoguePage } from "./gameTranslationContext";
import { prepareGameTerms, gameTermProblem } from "./gameTermMemory";
import { gameTaskPrompt, type GamePromptSelection } from "./gamePrompts";
import { canDisableOllamaNameThinking, prepareGameOllamaModels, translateGameWithOllama } from "./gameOllama";
import { beginGameStep, clearGamePerformance, finishGameStep, flushGamePerformanceArchive, measureGameWork, rememberBenchmarkExecution, stepPerformance, type StepPerformance } from "./gameModelPerformance";
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
  status: "完成" | "失败" | "已中止"; detail?: string; summary?: string; unobservedModels: string[]; performance: StepPerformance;
};
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
    return { id, runs, firstTime, rounds: new Set(runs.map(run => run.round)).size, configs: configs.size,
      failed: runs.filter(run => run.status === "失败").length,
      stopped: runs.filter(run => run.status === "已中止").length };
  }).sort((left, right) => right.firstTime.localeCompare(left.firstTime));
}

export function benchmarkHistoryResults(records: StepPerformance[]): BenchmarkResult[] {
  const unique = new Map<string, BenchmarkResult>();
  for (const record of records) {
    const benchmark = record.benchmark;
    if (!benchmark || typeof benchmark.round !== "number" || typeof benchmark.label !== "string" || !record.taskId) continue;
    const status = benchmark.status === "完成" || benchmark.status === "失败" ? benchmark.status : "已中止";
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

export async function readGameBenchmarkHistory(scope: string, step: string): Promise<BenchmarkResult[]> {
  await flushGamePerformanceArchive();
  const records = isTauri() ? await invoke<StepPerformance[]>("read_game_performance", { scope, step }) :
    (JSON.parse(localStorage.getItem("llmchat-game-performance-outbox") || "[]") as (StepPerformance & { scope: string; step: string })[])
      .filter(record => record.scope === scope && record.step === step);
  return benchmarkHistoryResults(records);
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

export type BenchmarkStepRunner = (config: BenchmarkConfig, settings: Settings, scope: string) => Promise<{ translated: number; failed: number; summary?: string }>;

export function benchmarkResultLines(result: BenchmarkResult) {
  const seconds = (milliseconds: number | undefined) => milliseconds === undefined ? "—" : (milliseconds / 1000).toFixed(2) + " 秒";
  const measured = result.performance;
  const speed = measured.elapsedMs > 0 ? (result.translated * 60000 / measured.elapsedMs).toFixed(1) : "—";
  const lines = [`第 ${result.round} 轮 · ${result.label} · ${result.status} · 总用时 ${seconds(measured.elapsedMs)} · 完成 ${result.translated}/${result.selected} · 失败 ${result.failed} · 每分钟完成 ${speed} 个样本`];
  for (const model of Object.values(measured.models)) {
    const generation = model.generationMs > 0 ? (model.generationTokens * 1000 / model.generationMs).toFixed(1) : "—";
    const average = model.requestMs > 0 && model.tokens > 0 ? (model.tokens * 1000 / model.requestMs).toFixed(1) : "—";
    lines.push(`${model.model} · 并发 ${model.concurrency} · 请求 ${model.requests} 次 · 输出 ${model.tokens} tokens · 纯生成 ${generation} tok/s · 请求平均 ${average} tok/s · 请求耗时合计 ${seconds(model.requestMs)}`);
  }
  const timing = measured.wallTiming || measured.timing;
  if (timing) lines.push(`分项用时 · 排队 ${seconds(timing.queueMs)} · 处理与校验 ${seconds(timing.processingMs)} · 保存 ${seconds(timing.saveMs)} · 模型请求占用 ${seconds(timing.modelRequestMs)}`);
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

export async function runGameTextBenchmarks(configs: BenchmarkConfig[], rounds: number, workload: Workload, scope: string, queueId: string, signal: AbortSignal,
  report: Reporter, onStart: (round: number, config: BenchmarkConfig) => void, onProgress: (value: UnityProgress) => void,
  onResult: (result: BenchmarkResult) => void,
  target?: { step: string; selected: number; run: BenchmarkStepRunner }, onSample?: (sample: string) => void) {
  const settings = await api.getSettings();
  const step = target?.step || "translate";
  const activeRoles = target ? ["text"] as const : benchmarkRoles;
  const local = loadLocalModelProfiles();
  await prepareGameOllamaModels(configs.flatMap(config => (target || config.models.text.id ? activeRoles : []).map(role => config.models[role]))
    .filter(model => !!model.id && !!local[model.id])
    .map(model => ({ connection: { ...resolveFeatureLlm(settings, model.id), localModel: true }, lanes: model.lanes })), signal, report);
  for (let round = 1; round <= rounds; round++) {
    signal.throwIfAborted();
    const roundStarted = performance.now();
    let finishedConfigs = 0, failedConfigs = 0;
    report(`开始第 ${round} / ${rounds} 轮测试 · ${configs.length} 个配置`, "info");
    clearGamePerformance(scope, [step], false);
    for (const config of configs) {
      signal.throwIfAborted();
      const selected = target?.selected ?? workload.selectedIds.size;
      const unobservedModels: string[] = [];
      const metadata = { queueId, round, unobservedModels, label: config.label, selected, config, translated: 0, failed: 0, status: "运行中", detail: undefined as string | undefined, summary: undefined as string | undefined };
      beginGameStep(scope, step, metadata);
      onStart(round, config);
      const roleNames = { text: "正文", dialogue: "对白", names: "术语" };
      const modelDetails = (target || config.models.text.id ? activeRoles : []).map(role => {
        const model = config.models[role].id ? config.models[role] : config.models.text;
        return model.id ? `${roleNames[role]} ${model.id} · 并发 ${model.lanes}` : "";
      }).filter(Boolean);
      report(`第 ${round} 轮 · 开始 ${config.label} · 样本 ${selected} · ${modelDetails.join("；") || "本地处理或翻译引擎"}`, "info");
      let status: BenchmarkResult["status"] = "完成", detail: string | undefined;
      try {
        const result = await (target ? target.run(config, settings, scope) : runSample(config, workload, settings, scope, signal, report, onProgress, onSample));
        Object.assign(metadata, result);
        if (result.failed) status = "失败";
      } catch (error) {
        status = signal.aborted ? "已中止" : "失败";
        detail = error instanceof Error ? error.message : String(error);
      } finally {
        const complete = metadata.translated + metadata.failed >= selected;
        const interrupted = signal.aborted && !complete;
        if (interrupted) status = "已中止";
        metadata.status = status;
        metadata.detail = detail;
        const recorded = new Set(Object.values(stepPerformance(scope, step).models).filter(model => model.requests > 0).map(model => model.model));
        for (const id of new Set((target || config.models.text.id ? activeRoles : []).map(role => config.models[role].id))) {
          if (id && !recorded.has(id)) unobservedModels.push(id);
        }
        finishGameStep(scope, !interrupted);
        const performance = stepPerformance(scope, step);
        clearGamePerformance(scope, [step], false);
        const result: BenchmarkResult = { round, label: config.label, selected, translated: metadata.translated, failed: metadata.failed, status, detail, summary: metadata.summary, unobservedModels, performance };
        onResult(result);
        for (const line of benchmarkResultLines(result)) report(line, status === "完成" ? "success" : status === "失败" ? "error" : "info");
        if (!interrupted) finishedConfigs++;
        if (status === "失败") failedConfigs++;
      }
      if (signal.aborted) {
        report(`第 ${round} 轮已中止 · 已执行 ${finishedConfigs}/${configs.length} 个配置 · 耗时 ${((performance.now() - roundStarted) / 1000).toFixed(2)} 秒`, "info");
        signal.throwIfAborted();
      }
    }
    report(`第 ${round} 轮完成 · 配置 ${finishedConfigs} · 失败配置 ${failedConfigs} · 耗时 ${((performance.now() - roundStarted) / 1000).toFixed(2)} 秒`, failedConfigs ? "error" : "success");
  }
}
