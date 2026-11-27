import { useRef, useState } from "react";
import type { Settings, TranslateProvider } from "../../api";
import type { OutputLevel } from "../../appOutput";
import { type canDisableOllamaNameThinking, type prepareGameOllamaModels, type translateGameWithOllama } from "../../gameOllama";
import { createGameTranslationContext, gameTranslationRetry, isGameDialogue } from "../../gameTranslationContext";
import { type screenGameText } from "../../gameTextScreening";
import { gameTextHasSpeaker, gameDisplayTextProblem, preserveTargetGameText, translateGameDisplayText } from "../../gameDisplayText";
import type { beginGameStep, finishGameStep, measureGameWork, gameModelExecution } from "../../gameModelPerformance";
import { wrapGameTextToSource, validateGameNaturalLines, type GameWrapMode } from "../../gameTextLayout";
import { gameTaskPrompt } from "../../gamePrompts";
import { prepareGameTerms, gameTermProblem } from "../../gameTermMemory";
import type { loadLocalModelProfiles } from "../../modelPresets";
import { buildUnityTranslateOptions, localTextRequestGroup, prepareUnityTranslationRequest, prepareUnityTranslationText, restoreUnityTranslationLines } from "../../unityTranslation";
import { formatUnityStructure, planUnityStructuredLines, canReuseUnityStructuredDraft } from "../../unityTextStructure";
import { unityTranslationError, type UnityEntry, type UnityProgress, type UnityProject } from "../../unityOffline";
import { unityLanguageScope } from "../../unityWorkflow";
import { translateUnitySession, unityTranslationStats, unityTranslationCharacters, unityTranslationContextKey, textTranslationMatchesTarget, yieldUnityPreparation, type UnityTranslationQueue } from "../../unityTranslationSession";
import { smartUnityLines, planUnityLines, flattenUnityLines, applyUnityLineBreaks, parseUnityLineModel, unityLineModelInput, UNITY_LINE_MODEL_PROMPT, type UnityLineMode } from "../../unityLineLayout";
import { UnitySegmentation } from "../../unitySegmentation";
import { createUnityEnginePool } from "../../unityEnginePool";

type TextLog = (message: string, level?: OutputLevel) => void;
type ReportProgress = (progress: UnityProgress) => void;
type PromptSelection = NonNullable<Parameters<typeof gameTaskPrompt>[1]>;
type TranslateText = (project: UnityProject, controller: AbortController, options: UnityTranslationOptions, onProgress?: ReportProgress,
  languageSource?: string, mergeLines?: boolean, breakMode?: UnityLineMode, helperModel?: string, layoutOnly?: boolean, onlyIds?: Set<string>) => Promise<UnityProject>;

export function useTextOrchestration() {
  const [textScreened, setTextScreened] = useState(false);
  const [textScreening, setTextScreening] = useState(false);
  const [textScreenStarted, setTextScreenStarted] = useState(false), [textScreenPaused, setTextScreenPaused] = useState(false);
  const translationQueue = useRef<UnityTranslationQueue | null>(null);
  const retryFailureIds = useRef<Set<string> | undefined>(undefined);
  return { textScreened, setTextScreened, textScreening, setTextScreening, textScreenStarted, setTextScreenStarted,
    textScreenPaused, setTextScreenPaused, translationQueue, retryFailureIds };
}

type TextTranslationPorts = {
  settings: Settings;
  promptState: { scope: string; selection: PromptSelection };
  textLog: TextLog;
  getSettings: () => Promise<Settings>;
  loadLocalModelProfiles: typeof loadLocalModelProfiles;
  measureGameWork: typeof measureGameWork;
  translateGameWithOllama: typeof translateGameWithOllama;
  prepareGameOllamaModels: typeof prepareGameOllamaModels;
  canDisableOllamaNameThinking: typeof canDisableOllamaNameThinking;
  gameModelExecution: typeof gameModelExecution;
  readEngineStats: () => UnityProgress["engineStats"];
  saveTranslation: (project: UnityProject) => Promise<void>;
  persist: (project: UnityProject, entries: UnityEntry[]) => Promise<void>;
  setQueue: (queue: UnityTranslationQueue | null) => void;
  setDirty: (dirty: boolean) => void;
  setMessage: (message: string) => void;
};

type TextScreeningPorts = {
  latestProject: () => UnityProject | null;
  startScreening: (controller: AbortController) => void;
  endScreening: () => void;
  promptState: { scope: string; selection: PromptSelection };
  settings: Settings;
  textScreenModel?: string;
  source: string;
  onlySourceLanguage: boolean;
  target: string;
  skipTargetLanguage: boolean;
  logAction: TextLog;
  reportScreening: (completed: number, total: number) => void;
  saveTranslation: (project: UnityProject) => Promise<void>;
  setTextScreened: (screened: boolean) => void;
  setTextScreenPaused: (paused: boolean) => void;
  setMessage: (message: string) => void;
  beginGameStep: typeof beginGameStep;
  finishGameStep: typeof finishGameStep;
  screenGameText: typeof screenGameText;
};

type TextCheckpointProgress = UnityProgress & { step: number; state: "pending" | "running" | "done" | "stopped" | "error" | "skipped"; failure?: string };
type TextRetryCheckpoint = { step: number; progress: TextCheckpointProgress; translationRuns?: Record<"text" | "images", TextCheckpointProgress> };
type TextRetryPorts<T extends TextRetryCheckpoint> = {
  setController: (controller: AbortController | null) => void;
  getCheckpoint: () => T | null;
  projectCheckpoint: (project: UnityProject) => T;
  remember: (checkpoint: T) => void;
  getCurrent: () => UnityProject | null;
  selectedIds: ReadonlySet<string>;
  translateProject: TranslateText;
  translationOptions: () => Promise<UnityTranslationOptions>;
  source: string;
  joinLines: boolean;
  lineMode: UnityLineMode;
  lineModel: string;
  setError: (message: string) => void;
  clearRowIssue: () => void;
  setMessage: (message: string) => void;
};
type TextBranchRun = { automatic: boolean; source: string; target: string; onlySourceLanguage?: boolean; skipTargetLanguage?: boolean;
  textScreenModel?: string; layoutOnly?: boolean; translationKind: string; joinLines?: boolean; lineMode?: UnityLineMode; lineModel?: string };
type TextBranchPorts<T extends TextBranchRun> = {
  getRun: () => T;
  deployment: boolean;
  textScreened: boolean;
  commitConfiguration: (stage: "screen" | "translate") => boolean | Promise<boolean> | undefined;
  getExecution: () => { parameters: Partial<T>; prompts: PromptSelection; translateProject: TranslateText; translationOptions: (run: T) => Promise<UnityTranslationOptions> };
  settings: Settings;
  logAction: TextLog;
  saveTranslation: (project: UnityProject) => Promise<void>;
  setTextScreened: (screened: boolean) => void;
  getCurrent: () => UnityProject | null;
  screenGameText: typeof screenGameText;
  takeRetryIds: () => Set<string> | undefined;
};

export type UnityTranslationOptions = ReturnType<typeof buildUnityTranslateOptions> & { wrapMode?: GameWrapMode; dialogueOptions?: ReturnType<typeof buildUnityTranslateOptions>; nameOptions?: ReturnType<typeof buildUnityTranslateOptions>; imageReviewOptions?: ReturnType<typeof buildUnityTranslateOptions>; engineIds?: TranslateProvider[]; includeContext?: boolean; skipTargetLanguage?: boolean; onlySourceLanguage?: boolean };

export async function runTextTranslation(p: UnityProject, controller: AbortController, options: UnityTranslationOptions, onProgress: ReportProgress | undefined,
  languageSource: string, mergeLines: boolean, breakMode: UnityLineMode, helperModel: string, layoutOnly: boolean, onlyIds: Set<string> | undefined,
  ports: TextTranslationPorts) {
  const { settings, promptState, textLog, getSettings, loadLocalModelProfiles, measureGameWork, translateGameWithOllama,
    prepareGameOllamaModels, canDisableOllamaNameThinking, gameModelExecution, readEngineStats, saveTranslation, persist,
    setQueue, setDirty, setMessage } = ports;
  await yieldUnityPreparation(controller.signal);
  const next = structuredClone(p);
  const cache = new Map<string, string>();
  const contextForEntry = createGameTranslationContext(next.entries, options.provider === "llm" && !!options.includeContext);
  const glossary: { src: string; dst: string; info?: string }[] = typeof options.glossary === "string" ? JSON.parse(options.glossary || "[]") : options.glossary || [];
  const ids = unityLanguageScope(next.entries, languageSource, options.onlySourceLanguage !== false).ids;
  const selectedEntries = next.entries.filter(e => (onlyIds ? onlyIds.has(e.id) : e.selected && ids.has(e.id)) && (!layoutOnly || !!e.layoutDraft));
  if (!layoutOnly) {
    onProgress?.({ completed: 0, total: selectedEntries.length, detail: "正在筛查目标语言", textStage: "screening" });
    await yieldUnityPreparation(controller.signal);
    const preserved = options.skipTargetLanguage ? measureGameWork(promptState.scope + ":text", "processingMs", () => preserveTargetGameText(selectedEntries, options.target || "zh-CN")) : 0;
    for (const entry of selectedEntries)
      if (entry.translation === entry.source) entry.translationTarget = options.target;
    if (preserved) await saveTranslation(next);
  }
  const localProfilesForRetry = loadLocalModelProfiles();
  const helperCache = new Map<string, string>();
  const segmenter = new UnitySegmentation();
  const sentenceCache = new Map<string, number[]>();
  const helperOptions = options.wrapMode!=="natural" && mergeLines && breakMode === "model" && selectedEntries.some(e => /[\r\n]/.test(e.source) && (layoutOnly || e.error || !e.translation || unityTranslationError(e.source, e.translation)))
    ? { ...(options.localModel
        ? options
        : buildUnityTranslateOptions(await getSettings(), "llm", "auto", options.target || "zh-CN", helperModel)),
        ...gameModelExecution(promptState.selection, "line", helperModel),
        prompt: gameTaskPrompt("line",promptState.selection)+"\n"+UNITY_LINE_MODEL_PROMPT, autoChunk: false } : null;
  setDirty(true);
  const formatUnbounded = async (original: string, translated: string) => {
    if(gameTextHasSpeaker(original))return translated;
    if (!/[\r\n]/.test(original)) return translated;
    if (breakMode === "ratio") return formatUnityStructure(original, translated, restoreUnityTranslationLines);
    if (breakMode === "wtp") {
      const texts = new Set<string>();
      planUnityStructuredLines(original, translated, (s, t) => { const plan = planUnityLines(s, t); if (plan.slots.length > 1) texts.add(flattenUnityLines(t)); return plan; });
      for (const text of texts) if (!sentenceCache.has(text)) sentenceCache.set(text, await segmenter.sentenceEnds(text, controller.signal));
      return applyUnityLineBreaks(planUnityStructuredLines(original, translated, (s, t) => planUnityLines(s, t, undefined, sentenceCache.get(flattenUnityLines(t)))));
    }
    if (breakMode !== "model") return formatUnityStructure(original, translated, smartUnityLines);
    const plan = planUnityStructuredLines(original, translated, planUnityLines);
    if (!plan.breaks.length) return smartUnityLines(original, translated);
    const key = JSON.stringify([original.replace(/\r\n?/g, "\n"), plan.units]);
    let response = helperCache.get(key);
    if (!response) {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
      try {
        const result = await translateGameWithOllama(unityLineModelInput(original, plan), { signal }, {...helperOptions!,llmBatch:false}, textLog);
        if (!result.ok) throw new Error(result.code || "断行辅助请求失败");
        response = result.translation;
      } catch (error) {
        if (!controller.signal.aborted && signal.reason?.name === "TimeoutError") throw new Error("断行辅助模型超过 120 秒未响应，译文草稿已保存");
        throw error;
      }
    }
    const formatted = parseUnityLineModel(plan, response); helperCache.set(key, response); return formatted;
  };
  const format=async(original:string,translated:string)=>options.wrapMode==="natural"?validateGameNaturalLines(original,translated):breakMode==="local"?wrapGameTextToSource(original,translated):formatUnbounded(original,translated);
  let formatQueue = Promise.resolve();
  const queuedFormat = (original: string, translated: string) => {
    const work = formatQueue.then(() => { controller.signal.throwIfAborted(); return format(original, translated); });
    formatQueue = work.then(() => {}, () => {});
    return work;
  };
  let terminology: ReadonlyMap<string, string> = new Map();
  let termIssues: ReadonlyMap<string, string> = new Map();
  const requestTranslation = async (text: string, provider = options.provider, entry?: UnityEntry, nameContext?: string) => {
    const { engineIds: _engines, includeContext: withContext, skipTargetLanguage: _skipTargetLanguage, dialogueOptions, nameOptions, ...mainOptions } = options;
    const dialogue = provider === "llm" && isGameDialogue(text, entry);
    const preserveDialogue = dialogue && options.wrapMode !== "natural";
    const primaryOptions = provider === "llm" ? (nameContext ? nameOptions : dialogue ? dialogueOptions : undefined) || mainOptions : mainOptions;
    const context = provider === "llm" ? contextForEntry(entry, nameContext) : undefined;
    const relevantText = text + (context || []).map(item => item.source).join("\n");
    const terms = glossary.filter(term => term.src?.trim() && term.dst?.trim() && relevantText.includes(term.src));
    const request = async (block: string, originalContext?: string, retryReason?: string) => {
      const reviewer = retryReason && provider === "llm" && primaryOptions.localModel
        ? Object.keys(localProfilesForRetry).find(id => /^qwen3\.5(?::|$)/i.test(id)) : undefined;
      const requestOptions = reviewer && reviewer !== primaryOptions.model
        ? { ...primaryOptions, ...buildUnityTranslateOptions(settings, "llm", options.source || "auto", options.target || "zh-CN", reviewer, mergeLines, true, undefined, options.wrapMode) }
        : primaryOptions;
      const seconds = provider === "llm" ? 120 : 30;
      const signal = provider === "llm" ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(seconds * 1000)]);
      const background = provider === "llm" ? gameTranslationRetry(contextForEntry(entry, nameContext, originalContext), retryReason) : {};
      try { const response = await translateGameWithOllama(prepareUnityTranslationRequest(block, mergeLines && options.wrapMode !== "natural"), { signal }, { ...requestOptions, glossary: terms, provider, ...background, autoFallback: provider === "llm" ? undefined : false, ...((nameContext || retryReason) && canDisableOllamaNameThinking(requestOptions) ? { ollamaReasoningOff: true } : {}) }, textLog); if (!response.ok) throw Object.assign(new Error(response.error || response.code || "翻译请求失败"), { code: response.code });
        return preserveDialogue && !/[\r\n]/.test(block) && /[\r\n]/.test(response.translation)
          ? prepareUnityTranslationText(response.translation) : response.translation; }
      catch (error) { if (!controller.signal.aborted && signal.reason?.name === "TimeoutError") throw new Error(`${requestOptions.model || provider} 请求超过 ${seconds} 秒未响应`); if (provider === "llm" && !controller.signal.aborted) throw new Error(`${requestOptions.model || "大模型"}：${error instanceof Error ? error.message : String(error)}`); throw error; }
    };
    return translateGameDisplayText(text, request, options.skipTargetLanguage ? options.target : "", "auto", terminology,
      !!options.skipTargetLanguage, preserveDialogue);
  };
  const measure = (text: string) => [...prepareUnityTranslationRequest(text, mergeLines)].length;
  const engineTargetCharacters = !layoutOnly && options.provider !== "llm" ? unityTranslationCharacters(selectedEntries, next.entries, unityTranslationError, text => prepareUnityTranslationRequest(text, mergeLines), mergeLines ? canReuseUnityStructuredDraft : undefined, unityTranslationContextKey).pendingCharacters : 0;
  let engineStats: NonNullable<UnityProgress["engineStats"]> = readEngineStats() || [];
  const initialStats = engineStats;
  let translationProgress: UnityProgress | undefined;
  const reportTranslation = (progress: UnityProgress) => {
    translationProgress = progress;
    onProgress?.(engineStats.length ? { ...progress, engineStats, engineTargetCharacters } : progress);
  };
  const persistTextChanges = async (entries: UnityEntry[]) => {
    if (!entries.length) return;
    await persist(next, entries);
  };
  const pool = !layoutOnly && options.provider !== "llm" ? createUnityEnginePool((options.engineIds || [options.provider as TranslateProvider]).map(id => ({ id, enabled: true })), controller.signal, async (id, text) => {
    const translated = await requestTranslation(text, id);
    const problem = unityTranslationError(text, translated); if (problem) throw new Error(problem);
    return translated;
  }, { timingScope: promptState.scope + ":text", initialStats, measure, onStats: value => { engineStats = value; if (translationProgress) onProgress?.({ ...translationProgress, engineStats, engineTargetCharacters }); } }) : null;
  try {
    if (!layoutOnly) {
      if (options.provider === "llm") {
        const connections = [options, options.dialogueOptions, options.nameOptions];
        await prepareGameOllamaModels(connections.flatMap(connection => connection?.llmConcurrency && connection.llmConcurrency > 1
          ? [{ connection, lanes: connection.llmConcurrency }] : []), controller.signal, textLog);
      }
      const prepared = await prepareGameTerms(selectedEntries.filter(entry => !entry.translation || !textTranslationMatchesTarget(entry, options.target) || entry.error || unityTranslationError(entry.source, entry.translation)), next.entries, options.target || "zh-CN", glossary,
      (name, context) => pool ? pool.translate(name) : requestTranslation(name, options.provider, undefined, context), controller.signal,
      (detail, completed, total) => onProgress?.({ detail, completed, total, textStage: "names", model: options.nameOptions?.model || options.model }));
      terminology = prepared.terms;
      termIssues = prepared.issues;
    }
    if (layoutOnly) {
      const total = next.entries.filter(e => e.selected && ids.has(e.id) && /[\r\n]/.test(e.source) && (e.layoutDraft || e.translation && !unityTranslationError(e.source, e.translation))).length;
      let completed = total - selectedEntries.length, failures = 0;
      onProgress?.({ detail: "仅重新断行，未请求重新翻译", textStage: "layout", completed, total });
      for (const entry of selectedEntries) {
        if (controller.signal.aborted) break;
        try {
          const body = await format(entry.source.trim(), entry.layoutDraft!.trim());
          if (controller.signal.aborted) break;
          const value = (entry.source.match(/^[\t \u3000]*/)?.[0] || "") + body;
          const problem = unityTranslationError(entry.source, value); if (problem) throw new Error(problem);
          entry.translation = value; entry.error = ""; delete entry.layoutDraft; completed++;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          entry.error = `译文排版失败：${error instanceof Error ? error.message : String(error)}`;
          failures++;
        }
        await persistTextChanges([entry]);
        onProgress?.({ textStage: "layout", detail: `仅重新断行，未请求重新翻译${failures ? ` · ${failures} 条失败已记录，继续处理` : ""}`, completed: completed + failures, total });
      }
      return next;
    }
    await translateUnitySession(selectedEntries, cache, {
      references: next.entries,
      key: unityTranslationContextKey, targetLanguage: options.target, entryProblem: entry => gameTermProblem(entry.source, termIssues),
      requestGroup: localTextRequestGroup(options, options.dialogueOptions),
      signal: controller.signal, validate: (s, t) => unityTranslationError(s, t) || gameDisplayTextProblem(s, t), progress: reportTranslation,
      onQueue: setQueue,
      // Prepare enough rows for batching; the scheduler serializes requests to each local service.
      concurrency: (options.localModel || options.dialogueOptions?.localModel || options.nameOptions?.localModel) ? 8 : options.provider==="llm"?16:pool?.concurrency||1,
      timingScope: promptState.scope + ":text", modelFormats: breakMode === "model" && options.wrapMode !== "natural",
      canReuseDraft: mergeLines ? canReuseUnityStructuredDraft : undefined,
      preserveLayout: options.wrapMode === "natural" ? undefined : options.provider === "llm" || !mergeLines ? gameTextHasSpeaker : undefined, format: mergeLines || options.wrapMode === "natural" ? queuedFormat : undefined, retainDraft: mergeLines || options.wrapMode === "natural", persistDraftBeforeFormat: options.wrapMode !== "natural" && (breakMode === "model" || breakMode === "wtp"),
      translate: pool ? (text, entry) => pool.translate(text, entry?.id) : (text, entry) => requestTranslation(text, options.provider, entry),
      persist: persistTextChanges,
    });
  } finally {
    pool?.dispose();
    segmenter.dispose();
    const final = { ...next, entries: [...next.entries] };
    await saveTranslation(final);
    setMessage(controller.signal.aborted ? "已停止，已保存译文和排版草稿" : layoutOnly ? "断行处理已保存，未重新翻译；检查排版后可生成补丁" : "本轮翻译已结束，可检查译文后生成补丁");
  }
  return next;
}

export async function runTextScreening(ports: TextScreeningPorts) {
  const { latestProject, startScreening, endScreening, promptState, settings, textScreenModel, source, onlySourceLanguage,
    target, skipTargetLanguage, logAction, reportScreening, saveTranslation, setTextScreened, setTextScreenPaused,
    setMessage, beginGameStep, finishGameStep, screenGameText } = ports;
  if (!latestProject()) return;
  const controller = new AbortController(); startScreening(controller);
  beginGameStep(promptState.scope + ":text", "screen");
  try {
    await yieldUnityPreparation(controller.signal);
    const current = latestProject()!;
    const next = { ...current, entries: current.entries.map(entry => ({ ...entry })) };
    const rows = next.entries.filter(entry => entry.selected);
    const screeningSource = unityLanguageScope(next.entries, source, onlySourceLanguage).language;
    const kept = await screenGameText(rows, {
      settings, model: textScreenModel, prompts: promptState.selection, source: onlySourceLanguage ? screeningSource : "auto",
      onlySource: onlySourceLanguage, target, skipTarget: skipTargetLanguage, signal: controller.signal, onOllamaStatus: logAction,
      onProgress: (completed, total) => {
        reportScreening(completed, total);
      },
    });
    controller.signal.throwIfAborted(); await saveTranslation(next); controller.signal.throwIfAborted(); setTextScreened(true);
    finishGameStep(promptState.scope + ":text", true);
    setMessage(`筛选完成，${kept} 条无需翻译已取消勾选，可开始翻译`);
  } catch (error) { if (!controller.signal.aborted) throw error; setTextScreenPaused(true); setMessage("文本筛选已中止"); }
  finally { finishGameStep(promptState.scope + ":text"); endScreening(); }
}

export async function runTextRetry<T extends TextRetryCheckpoint>(p: UnityProject, id: string, ports: TextRetryPorts<T>) {
  const { setController, getCheckpoint, projectCheckpoint, remember, getCurrent, selectedIds, translateProject,
    translationOptions, source, joinLines, lineMode, lineModel, setError, clearRowIssue, setMessage } = ports;
  const controller = new AbortController(); setController(controller);
  const previous = getCheckpoint();
  const task = { ...(previous || projectCheckpoint(p)), step: 2, endStep: 2, automatic: false, finished: false, layoutOnly: false, imageOnly: false, patch: null, patchFolder: "" };
  const rememberTextRetry = (value: T) => remember({ ...value, translationRuns: value.translationRuns ? { ...value.translationRuns, text: value.progress } : undefined });
  let lastProgress: UnityProgress = { detail: `正在重试条目 #${id}`, completed: 0, total: null };
  const report = (progress: UnityProgress) => {
    const current = getCurrent() || p;
    const stats = unityTranslationStats(current.entries.filter(entry => entry.selected && selectedIds.has(entry.id)), unityTranslationError, unityTranslationContextKey);
    lastProgress = { ...progress, ...stats, completed: Math.min(stats.total, Math.max(stats.completed, previous?.step === 2 ? previous.progress.completed : 0)), translation: progress.translation && { ...progress.translation, successful: stats.completed } };
    rememberTextRetry({ ...task, progress: { ...lastProgress, step: 2, state: "running" } });
  };
  try {
    const next = await translateProject(p, controller, await translationOptions(), report, source, joinLines, lineMode, lineModel, false, new Set([id]));
      controller.signal.throwIfAborted();
    const retried = next.entries.find(entry => entry.id === id)!;
    const problem = retried.error || unityTranslationError(retried.source, retried.translation);
    const remaining = next.entries.filter(entry => entry.selected && selectedIds.has(entry.id) && (entry.error || unityTranslationError(entry.source, entry.translation))).length;
    const detail = problem ? `条目 #${id} 重试失败：${problem}` : `条目 #${id} 重试成功${remaining ? `，另有 ${remaining} 条未完成` : ""}`;
    rememberTextRetry({ ...task, finished: !problem && !remaining, progress: { ...lastProgress, step: 2, state: problem ? "error" : remaining ? "stopped" : "done", failure: problem || undefined, detail } });
    if (problem) setError(detail); else { clearRowIssue(); setMessage(detail); }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    const detail = `已中止条目 #${id} 的重试，已有译文和草稿保留`;
    rememberTextRetry({ ...task, progress: { ...lastProgress, step: 2, state: "stopped", detail } }); setMessage(detail);
  } finally { setController(null); }
}

export async function runTextBranch<T extends TextBranchRun>(current: UnityProject, job: AbortController, onProgress: ReportProgress,
  ports: TextBranchPorts<T>) {
  const { getRun, deployment, textScreened, commitConfiguration, getExecution, settings, logAction, saveTranslation,
    setTextScreened, getCurrent, screenGameText, takeRetryIds } = ports;
  const languageScope = unityLanguageScope(current.entries, getRun().source, getRun().onlySourceLanguage !== false);
  const selectedIds = languageScope.ids;
  const needsScreening = (getRun().automatic || deployment) && !getRun().layoutOnly && !textScreened;
  if (!needsScreening && current.entries.length && !current.entries.some(entry => entry.selected && selectedIds.has(entry.id))) throw new Error("当前原文语言范围内没有所选文本，请调整语言或选取文本");
  let textProject = current;
  if (needsScreening) {
    if (await commitConfiguration("screen") === false) throw new Error("文本筛选配置保存失败");
    const latestConfig = getExecution();
    textProject = { ...current, entries: current.entries.map(entry => ({ ...entry })) };
    const rows = textProject.entries.filter(entry => entry.selected);
    await screenGameText(rows, {
      settings, model: latestConfig.parameters.textScreenModel, prompts: latestConfig.prompts, source: getRun().onlySourceLanguage === false ? "auto" : languageScope.language,
      onlySource: getRun().onlySourceLanguage !== false, target: getRun().target, skipTarget: getRun().skipTargetLanguage !== false, signal: job.signal, onOllamaStatus: logAction,
      onProgress: (completed, total) => onProgress({ completed, total, detail: getRun().textScreenModel === undefined ? "正在按语言规则筛选文本" : "正在用大模型筛选文本", textStage: "screening", model: getRun().textScreenModel }),
    });
    job.signal.throwIfAborted();
    await saveTranslation(textProject);
    setTextScreened(true);
  }
  const retryIds = takeRetryIds();
  if (textProject.entries.some(entry => retryIds ? retryIds.has(entry.id) : entry.selected && selectedIds.has(entry.id))) {
    if (getRun().automatic && await commitConfiguration("translate") === false) throw new Error("正文翻译配置保存失败");
    const latestConfig = getExecution();
    const options = getRun().automatic || deployment ? { ...getRun(), ...latestConfig.parameters } : getRun();
    await latestConfig.translateProject(textProject, job, options.layoutOnly && options.translationKind !== "local"
      ? { provider: "llm", source: options.source, target: options.target } : await latestConfig.translationOptions(options),
      onProgress, options.source, options.joinLines ?? true, options.lineMode || "local", options.lineModel || "", !!options.layoutOnly, retryIds);
  }
  const final = getCurrent() || current;
  const failed = final.entries.filter(entry => (retryIds ? retryIds.has(entry.id) : entry.selected && selectedIds.has(entry.id)) && (!getRun().layoutOnly || !!entry.layoutDraft) && (entry.error || unityTranslationError(entry.source, entry.translation)));
  if (failed.length) throw new Error(`${failed.length} 条文本翻译或排版未完成，已有译文和草稿已保存`);
}
