import { benchmarkBlockingReason, isBenchmarkRunning, useBenchmarkRunning } from "../benchmark/benchmarkRunner";
import { planUnityLines, applyUnityLineBreaks, flattenUnityLines, parseUnityLineModel, unityLineModelInput, UNITY_LINE_MODEL_PROMPT } from "../unityLineLayout";
import { formatUnityStructure, planUnityStructuredLines } from "../unityTextStructure";
import { UnitySegmentation } from "../unitySegmentation";
import type { BatchRow } from "./GameBatchResults";
import type { BenchmarkInput } from "./GameTextBenchmarkDialog";
import { beginGameStep, finishGameStep, clearGamePerformance, stepPerformance, gameDuration, measureGameAsync, measureGameWork, reportGameStepItems } from "../gameModelPerformance";
import { UnityProjectLoading } from "./UnityProjectLoading";
import { canDisableOllamaNameThinking, prepareGameOllamaModels, translateGameWithOllama } from "../gameOllama";
import { screenGameText } from "../gameTextScreening";
import { createGameTranslationContext, gameDialogueReuseKey, GAME_CONTEXT_HINT, gameTranslationRetry, isGameDialogue } from "../gameTranslationContext";
import { showAppNotice } from "./AppNotice";
import { GamePageNumber } from "./GamePageNumber";
import { wrapGameTextToSource, validateGameNaturalLines } from "../gameTextLayout";
import { GamePromptContext, useGamePromptSelection, gameTaskPrompt } from "../gamePrompts";
import { GameFlowSequence, type GameStepConfigurationCommit } from "./GameFlowSequence";
import { GameStepProgress } from "./GameStepProgress";
import { applyGameTestRoles, captureGameTestRoles, loadGameWorkflowEngines, recommendedGameModels, saveGameWorkflowEngines, type GameTestConfiguration, type GameTestConfigurationAccess } from "../gameModelPreset";
import { gameAvailableModels, GameModelSelect, GameProcessingTabs, GameTranslationTabs } from "./GameTranslationTabs";
import { GameTextScreenedEditor, GameTextScreenedSource } from "./GameTextScreening";
import { unityLanguageScope } from "../unityWorkflow";
import { registerAppCloseGuard } from "../appClose";
import { useGameActionConfirm, GameDialog } from "./GameActionConfirm";
import { GameTextFilterMenu, defaultGameTextFilters, matchesGameTextFilters, limitGameText } from "./GameTextFilterMenu";
import { ClosingProgress, useClosingProgress } from "./ClosingProgress";
import { GameTextFileMenu, GAME_TEXT_IMPORT_CHOICES } from "./GameTextFileMenu";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { api, type Settings, type TranslateProvider } from "../api";
import { loadLocalModelProfiles } from "../modelPresets";
import { readFileBytes } from "../localDocFile";
import { saveOutputFile } from "../outputFiles";
import { gameTextRequest, gameTextProblem as validateGameText, createGameTextValidator, gameTextDictionary, importGameText, translateGameControls, isTextSelectionScreened, restoreGameTextState, sameTextEdit, hasMessageCoreNameOverride, dialogueRepairLabels, repairMessageCoreNameLineBreak, repairMessageCorePositionPrefix, type GameTextProject, type GameTextOptions } from "../gameTextProject";
import { translateUnitySession, unityTranslationStats, textTranslationMatchesTarget, tagLegacyTextTargets } from "../unityTranslationSession";
import { buildUnityTranslateOptions, localTextRequestGroup, prepareUnityTranslationRequest, prepareUnityTranslationText, restoreUnityTranslationLines, UNITY_LANGUAGES } from "../unityTranslation";
import { unityTranslationQuality } from "../unityTranslationQuality";
import { prepareGameTerms, gameTermProblem } from "../gameTermMemory";
import { gameFormatTokens, gameJapaneseTextIssue, gameTextHasSpeaker, gameTextMatchesSource, gameTextNeedsNoTranslation, preserveTargetGameText, translateRpgSystemMessage } from "../gameDisplayText";
import { createUnityEnginePool, normalizeUnityEngines } from "../unityEnginePool";
import { engineReady, parseEngineKeys } from "../translateEngines";
import type { UnityEntry, UnityProgress, UnityEngineProgress } from "../unityOffline";
import { UnityEngineList } from "./UnityEngineList";
import { gameTextStageLabels, UnityTranslationProgress } from "./UnityTranslationProgress";
import { SearchHighlight } from "./SearchHighlight";
import { useGameFileDrop } from "../hooks/useGameFileDrop";
import type { GameImportSource } from "../gameImageImport";

export type GameTextInfo = { count: number; selected: number; done: number; changed: number; sourcePath: string; dirty: boolean; running: boolean; state: string; translationPath: string; loadResult?: { path: string; error?: string }; messageCore?: boolean; positionRepairs?: number; target?: string };
export type GameTextHandle = { benchmark?: () => BenchmarkInput; locate?: (id: string) => void; findText?: (source: string, translation: string) => string | undefined; retryFailures?: () => void; canRetryFailures?: boolean; prepare: () => Promise<string | false>; leave: () => Promise<boolean>; automatic: (signal: AbortSignal) => Promise<boolean>; stop: () => void; captureTestConfiguration: () => GameTestConfiguration["text"]; applyTestConfiguration: (preset: GameTestConfiguration["text"]) => Promise<void>; detectedSource: string };
type Props = { gamePath: string; settings: Settings; sourcePath: string; controls: HTMLElement | null; results: HTMLElement | null; batchResults?: ReactNode; visible: boolean; step: number; active: boolean; disabled: boolean; skipped:boolean; onSkip:()=>void; handle: { current: GameTextHandle | null }; onInfo: (info: GameTextInfo) => void; onBatchFailures?: (rows: BatchRow[]) => void; onBatchCorrections?: (rows: BatchRow[]) => void; onMessage: (text: string, level?: "info" | "warning" | "error" | "success") => void; testConfigurations: GameTestConfigurationAccess; testConfigurationDisabled: boolean };

export function GameTextWorkspace({ gamePath, settings, sourcePath, controls, results, batchResults, visible, step, active, disabled, skipped, onSkip, handle, onInfo, onBatchFailures, onBatchCorrections, onMessage, testConfigurations, testConfigurationDisabled }: Props) {
  const {phase:closingPhase,show:showClosing,clear:clearClosing}=useClosingProgress();
  const promptState=useGamePromptSelection(gamePath + ":text");
  const [project, setProject] = useState<GameTextProject | null>(null), current = useRef(project); current.current = project;
  const baseline = useRef<GameTextProject | null>(null);
  const openedGame = useRef("");
  const [loadResult, setLoadResult] = useState<GameTextInfo["loadResult"]>();
  const [options, setOptions] = useState<GameTextOptions>({ kind: "llm", model: "", source: "auto", target: "zh-CN", joinLines: true, skipTargetLanguage: true, onlySourceLanguage: true });
  const [engines, setEngines] = useState(() => loadGameWorkflowEngines(promptState.scope)), [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [dirty, setDirty] = useState(false);
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const configurationCommit = useRef<GameStepConfigurationCommit | null>(null);
  const [configured, setConfigured] = useState<string | null>(null);
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const wrapMode=options.wrapMode||(options.joinLines?"join":"keep");
  const [screened, setScreened] = useState(false);
  const [screenStarted, setScreenStarted] = useState(false);
  const confirmation = useGameActionConfirm(text => report(text)); const { confirm } = confirmation;
  const [textFilters, setTextFilters] = useState({ ...defaultGameTextFilters });
  useEffect(() => { setScreened(false); setScreenStarted(false); }, [gamePath, sourcePath]);
  useEffect(() => {
    if (loading || !baseline.current) return;
    const signature = (value: Partial<GameTextOptions>) => JSON.stringify([value.source || "auto", value.target || "zh-CN", value.skipTargetLanguage !== false, !!value.onlySourceLanguage]);
    if (signature(options) !== signature(baseline.current.options)) {
      setScreened(false); setState("idle"); setProgress(null);
      if (current.current) current.current.workflow = { screened: false };
      baseline.current.workflow = { screened: false };
    }
  }, [loading, options.source, options.target, options.skipTargetLanguage, options.onlySourceLanguage]);
  const [importPreview, setImportPreview] = useState<{ project: GameTextProject; rows: UnityEntry[]; page: number }>();
  const [importIssues, setImportIssues] = useState<{ id: string; reason: string }[]>([]);
  useEffect(() => setImportIssues([]), [gamePath, sourcePath]);
  const [progressFailure, setProgressFailure] = useState("");
  const [state, setState] = useState("idle"), [progress, setProgress] = useState<UnityProgress | null>(null);
  const [search, setSearch] = useState(""), [filter, setFilter] = useState("all"), [page, setPage] = useState(0), [importMode, setImportMode] = useState<"fill" | "replace">("fill");
  const optionWrite = useRef<(() => void) | null>(null);
  const [pendingLeave, setPendingLeave] = useState<((choice: "save" | "discard" | "cancel") => void) | null>(null);
  const queue = useRef<import("../unityTranslationSession").UnityTranslationQueue | null>(null);
  const controller = useRef<AbortController | null>(null), work = useRef<Promise<boolean> | null>(null), writes = useRef(Promise.resolve());
  const callbacks = useRef({ onMessage, onInfo }); callbacks.current = { onMessage, onInfo };
  const publish = (value: GameTextProject) => { current.current = value; setProject(value); };
  const saveConfiguration=async(nextOptions = options, resetScreening = false)=>{
    optionWrite.current?.();
    const job = writes.current.then(async () => {
      const saved = baseline.current;
      if (!saved?.sourcePath) throw new Error("请先扫描资源");
      if (JSON.stringify(saved.options) === JSON.stringify(nextOptions) && !resetScreening) return;
      const next = { ...saved, options: nextOptions, workflow: resetScreening ? { screened: false } : saved.workflow };
      await gameTextRequest("save", { gamePath, ...next });
      baseline.current = next;
      if (resetScreening && current.current) current.current.workflow = next.workflow;
    });
    writes.current=job.then(()=>{},()=>{});await job;
  };
  const report = (text: string, level: "info" | "warning" | "error" | "success" = "info") => callbacks.current.onMessage(text, level);
  useEffect(() => { let alive = true; setLoading(true); setLoadResult(undefined); current.current = null; setProject(null); baseline.current = null; setProgress(null); setProgressFailure("");
    void gameTextRequest<GameTextProject>("load", { gamePath, sourcePath }).then(value => {
      if (!alive) return;
      tagLegacyTextTargets(value.entries, value.options.target || "zh-CN");
      // Recover retained rows affected by the old repeated-screening transition.
      preserveTargetGameText(value.entries.filter(entry => entry.screeningDraft === entry.source &&
        !(value.messageCore && hasMessageCoreNameOverride(entry.source, entry.translation))), value.options.target || "zh-CN", value.options.onlySourceLanguage ? value.options.source || "auto" : "auto", value.options.skipTargetLanguage !== false);
      publish(value); baseline.current = value; setDirty(false); setSearch(""); setPage(0);
      const selected = value.entries.filter(entry => entry.selected);
      const started = value.workflow?.screened ?? value.entries.some(entry => !!(entry.translation || entry.layoutDraft || entry.screeningDraft || entry.error));
      const screenedIds = value.workflow?.screenedIds ?? (started ? selected.map(entry => entry.id) : []);
      const selectionScreened = isTextSelectionScreened(value.entries, screenedIds);
      value.workflow = { screened: selectionScreened, screenedIds };
      setScreened(selectionScreened); setScreenStarted(screenedIds.length > 0);
      const validate = createGameTextValidator(!!value.messageCore, value.options.target || "zh-CN");
      const completed = selected.filter(entry => entry.translation && !entry.error && textTranslationMatchesTarget(entry, value.options.target) && !validate(entry.source, entry.translation)).length;
      const failed = selected.filter(entry => !!entry.error).length;
      const recordedRun = stepPerformance(promptState.scope + ":text", "translate");
      const restored = restoreGameTextState(selectionScreened, selected.length, completed, failed, !!recordedRun.taskId && !recordedRun.endedAt);
      setState(restored);
      setProgress(restored !== "idle" ? { completed, total: selected.length, detail: `已恢复工程 · 有效译文 ${completed}/${selected.length} 条 · 失败 ${failed} 条` } : null);
      setProgressFailure("");
      const merged: GameTextOptions = { kind: "llm", source: "auto", target: "zh-CN", joinLines: true, skipTargetLanguage: true, onlySourceLanguage: true,
        ...value.options, model: value.options.model || recommendedGameModels().text || "" };
      baseline.current = { ...value, options: merged };
      setOptions(merged);
      setLoadResult({ path: sourcePath });
    }).catch(error => { if (alive) { const message = `读取文本工程失败：${String(error)}`; setLoadResult({ path: sourcePath, error: message }); setState("error"); setProgressFailure(message); report(message, "error"); } }).finally(() => { if (alive) { openedGame.current = gamePath; setLoading(false); } });
    return () => { alive = false; };
  }, [gamePath, sourcePath]);
  useEffect(() => {
    if (loading || !baseline.current?.sourcePath) return;
    let timer: number;
    const commit = () => {
      window.clearTimeout(timer); optionWrite.current = null;
      const job = writes.current.then(async () => {
        const saved = baseline.current;
        if (!saved || saved.sourcePath !== current.current?.sourcePath || JSON.stringify(saved.options) === JSON.stringify(options)) return;
        await gameTextRequest("save", { gamePath, ...saved, options });
        if (baseline.current) baseline.current = { ...baseline.current, options };
      });
      writes.current = job.then(() => {}, () => {});
      void job.catch(error => report(`参数自动保存失败：${String(error)}`, "error"));
    };
    optionWrite.current = commit; timer = window.setTimeout(commit, 350);
    return () => { window.clearTimeout(timer); if (optionWrite.current === commit) optionWrite.current = null; };
  }, [options, loading, gamePath, project?.sourcePath]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { saveGameWorkflowEngines(promptState.scope, engines); }, [engines, promptState.scope]);
  const entries = project?.entries || [];
  const messageCore = !!project?.messageCore;
  const gameTextProblem = useMemo(() => createGameTextValidator(messageCore, options.target), [gamePath, sourcePath, messageCore, options.target]);
  const detectedSource = useMemo(() => unityLanguageScope(entries, options.source).language, [entries, options.source]);
  const sourceFilter = options.onlySourceLanguage === false ? "auto" : detectedSource;
  const selected = useMemo(() => entries.filter(entry => entry.selected), [entries]);
  const stats = useMemo(() => unityTranslationStats(selected, gameTextProblem, gameDialogueReuseKey, options.target), [selected, gameTextProblem, options.target]);
  useEffect(() => { callbacks.current.onInfo({ count: entries.length, selected: selected.length, sourcePath: project?.sourcePath || "", done: stats.coverageCompleted, changed: stats.coverageChanged, dirty, running, state, translationPath: project?.translationPath || "", loadResult, messageCore, target: options.target, positionRepairs: project?.positionRepairs }); }, [entries.length, selected.length, project?.sourcePath, stats.coverageCompleted, stats.coverageChanged, dirty, running, state, project?.translationPath, loadResult, messageCore, options.target, project?.positionRepairs]);
  useEffect(() => {
    if (!onBatchFailures) return;
    const issues = new Map(importIssues.map(issue => [issue.id, issue.reason]));
    onBatchFailures(project?.entries.flatMap((entry): BatchRow[] => {
      const reason = entry.error || (!entry.translation.trim() && issues.get(entry.id));
      return reason ? [{ id: entry.id, label: "#" + entry.id, detail: reason, kind: "text" }] : [];
    }) || []);
  }, [project?.entries, importIssues, onBatchFailures]);
  useEffect(() => {
    onBatchCorrections?.(project?.entries.flatMap(entry => {
      if (!entry.dialogueRepairs?.length) return [];
      const labels = entry.dialogueRepairs.map(kind => dialogueRepairLabels[kind]);
      return [{ id: entry.id, label: "#" + entry.id, detail: labels.join("、"), group: labels[0], kind: "text" }];
    }) || []);
  }, [project?.entries, onBatchCorrections]);
  const targetTextIds = useMemo(() => new Set(entries.filter(entry => !gameTextMatchesSource(entry.source, sourceFilter, entry.locale) || options.skipTargetLanguage !== false && gameTextNeedsNoTranslation(entry.source, options.target)).map(entry => entry.id)), [project?.sourcePath, entries.length, sourceFilter, options.target, options.skipTargetLanguage]);
  const busy = disabled || loading || running || saving;
  const testing = useBenchmarkRunning();
  const testTitle = testing ? benchmarkBlockingReason : undefined;
  const persist = async (value = current.current, silent = false) => {
    if (!value?.sourcePath) throw new Error("请先在步骤 1 扫描资源");
    const timingScope = promptState.scope + ":text";
    const snapshot = measureGameWork(timingScope, "processingMs", () => ({
      ...value, options, entries: value.entries.map(entry => ({
        ...entry,
        error: entry.error || (entry.translation ? textTranslationMatchesTarget(entry, options.target)
          ? gameTextProblem(entry.source, entry.translation)
          : validateGameText(entry.source, entry.translation, messageCore) : ""),
      })),
    }));
    const job = writes.current.then(async () => {
      // A running step keeps its settings for processing. Its result writes retain newer UI options.
      snapshot.options = latestOptions.current;
      const result = await measureGameAsync(timingScope, "saveMs", () => gameTextRequest<{ translationPath: string }>("save", { gamePath, ...snapshot }));
      baseline.current = snapshot;
      return result.translationPath;
    });
    writes.current = job.then(() => {}, () => {});
    const path = await job;
    if (!silent) { publish(snapshot); setDirty(false); report("保存成功", "success"); }
    return path;
  };
  const save = async () => { setSaving(true); try { return await persist(); } catch (error) { report(String(error), "error"); return false as const; } finally { setSaving(false); } };
  const discard = () => { setScreened(!!baseline.current?.workflow?.screened); if (baseline.current) { publish({ ...baseline.current, options }); } setDirty(false); report("未保存的文本修改已取消"); };
  const leave = async () => {
    optionWrite.current?.(); await writes.current;
    if (controller.current) { report("请先中止文本翻译或等待任务完成", "warning"); return false; }
    if (!dirty) return true;
    const choice = await new Promise<"save" | "discard" | "cancel"> (resolve => setPendingLeave(() => resolve));
    if (choice === "cancel") return false;
    if (choice === "save") return !!await save();
    discard(); return true;
  };
  handle.current = { detectedSource,
    captureTestConfiguration: () => {
      const { model, screeningModel, dialogueModel, nameModel, ...currentOptions } = latestOptions.current;
      const main = model || settings.model;
      return { options: { ...currentOptions, lineMode: currentOptions.lineMode || "local", engines }, roles: captureGameTestRoles({ text: model, textScreen: screeningModel, dialogue: dialogueModel, names: nameModel, line: currentOptions.lineModel },
        promptState, { text: main, textScreen: screeningModel, dialogue: dialogueModel || main, names: nameModel || main }) };
    },
    applyTestConfiguration: async preset => {
      if (busy || controller.current || !baseline.current?.sourcePath) throw new Error("请先完成文本工程读取或等待当前任务结束");
      const { engines: nextEngines, ...currentOptions } = preset.options;
      const next: GameTextOptions = { ...currentOptions, lineModel: preset.roles.line?.model, model: preset.roles.text?.model || "", dialogueModel: preset.roles.dialogue?.model,
        nameModel: preset.roles.names?.model, screeningModel: preset.roles.textScreen?.model };
      const previous = latestOptions.current;
      const reset = next.source !== previous.source || next.target !== previous.target || next.onlySourceLanguage !== previous.onlySourceLanguage || next.skipTargetLanguage !== previous.skipTargetLanguage;
      await saveConfiguration(next, reset);
      if (reset) { setScreened(false); setScreenStarted(false); setState("idle"); setProgress(null); }
      setOptions(next);
      setEngines(normalizeUnityEngines(nextEngines));
      const main = next.model || settings.model;
      applyGameTestRoles(preset.roles, promptState, { text: main, dialogue: next.dialogueModel || main, names: next.nameModel || main });
      setConfigurationRevision(value => value + 1);
    },
    prepare: async () => { if (controller.current || loading) return false; return save(); }, leave, stop: () => controller.current?.abort(), automatic: async signal => {
    const stop = () => controller.current?.abort(); signal.addEventListener("abort", stop, { once: true });
    try {
      if (!current.current?.entries.length) return true;
      if (signal.aborted || !screened && (await configurationCommit.current?.("screen") === false ||
          signal.aborted || !await automaticSteps.current.screen(true))) return false;
      if (signal.aborted) return false;
      const rows = current.current?.entries.filter(entry => entry.selected) || [];
      if (rows.every(entry => !!entry.translation && textTranslationMatchesTarget(entry, options.target) && !gameTextProblem(entry.source, entry.translation) && !entry.error)) return true;
      if (await configurationCommit.current?.("translate") === false || signal.aborted) return false;
      return !!await automaticSteps.current.run(true);
    }
    finally { signal.removeEventListener("abort", stop); }
  } };
  const closeState=useRef({leave});closeState.current={leave};
  const needsCloseGuard=dirty||running||!!project?.sourcePath;
  useEffect(() => {
    if (!needsCloseGuard || !isTauri()) return;
    let cancelled = false, unlisten: (() => void) | undefined;
    void registerAppCloseGuard(async () => {
      try {
        if(controller.current){await showClosing("正在中止文本翻译并保存已完成结果…");controller.current.abort();await work.current;}
        clearClosing();
        return await closeState.current.leave();
      } catch(error){report(`退出失败：${String(error)}`,"error");return false;}
      finally{clearClosing();}
    }).then(stop => { if (cancelled) stop(); else unlisten = stop; }).catch(error=>report(String(error),"error"));
    return () => { cancelled = true; unlisten?.(); };
  }, [needsCloseGuard,showClosing,clearClosing]);
  const editEntries = (ids: ReadonlySet<string>, patch: Partial<UnityEntry>) => {
    const project = current.current;
    if (!project) return;
    const saved = new Map(baseline.current?.entries.map(entry => [entry.id, entry]));
    const entries = project.entries.map(entry => {
      if (!ids.has(entry.id)) return entry;
      const original = saved.get(entry.id);
      if (patch.translation === undefined) return { ...entry, ...patch };
      if (original && patch.translation === original.translation) return { ...original, selected: entry.selected };
      return { ...entry, ...patch, translationTarget: options.target, error: "" };
    });
    const screened = isTextSelectionScreened(entries, project.workflow?.screenedIds);
    publish({ ...project, entries, workflow: { ...project.workflow, screened } });
    setScreened(screened);
    setDirty(entries.some(entry => {
      const original = saved.get(entry.id);
      return !original || !sameTextEdit(entry, original);
    }));
  };
  const edit = (id: string, patch: Partial<UnityEntry>) => editEntries(new Set([id]), patch);
  const screen = async (automatic = false) => {
    if (isBenchmarkRunning()) return false;
    if (controller.current || loading || !automatic && busy || !current.current?.entries.length) return false;
    const next = { ...current.current, entries: current.current.entries.map(entry => ({ ...entry })) };
    const screening = new AbortController(); controller.current = screening;
    beginGameStep(promptState.scope + ":text", "screen");
    report("开始筛选文本");
    setScreenStarted(true); setSaving(true); setState("screening"); setProgressFailure(""); setProgress(null);
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (screening.signal.aborted) { setState("screen-stopped"); return false; }
      const selectedEntries = next.entries.filter(entry => entry.selected);
      const screeningEntries = selectedEntries.filter(entry => !messageCore || !hasMessageCoreNameOverride(entry.source, entry.translation));
      const repaired = screeningEntries.filter(entry => entry.translation && entry.translation !== entry.source && gameTextNeedsNoTranslation(entry.source, options.target));
      const preserved = await screenGameText(screeningEntries, {
        settings, model: options.screeningModel, prompts: promptState.selection, source: sourceFilter,
        target: options.target, skipTarget: options.skipTargetLanguage !== false, signal: screening.signal, onOllamaStatus: report,
        onProgress: (completed, total) => {
          reportGameStepItems(promptState.scope + ":text", "screen", completed);
          setProgress({ completed, total, detail: "正在用大模型筛选文本", textStage: "screening", model: options.screeningModel });
        },
      });
      for (const entry of screeningEntries)
        if (entry.translation === entry.source) entry.translationTarget = options.target;
      screening.signal.throwIfAborted();
      next.workflow = { screened: true, screenedIds: [...new Set([...(next.workflow?.screenedIds || []), ...selectedEntries.map(entry => entry.id)])] };
      await persist(next, true); publish(next); setDirty(false); setScreened(!screening.signal.aborted); setState(screening.signal.aborted ? "screen-stopped" : "screened");
      const result = unityTranslationStats(selectedEntries, gameTextProblem, gameDialogueReuseKey, options.target);
      report(`筛查完成：${preserved} 条原样保留，${result.total - result.completed} 种原文待翻译`, "success");
      if (options.skipTargetLanguage !== false && repaired.length) report(`已将 ${repaired.length} 条目标语言原文恢复为原样，替换此前重复翻译的结果。条目：${repaired.slice(0, 20).map(entry => "#" + entry.id).join("、")}`, "warning");
      finishGameStep(promptState.scope + ":text", !screening.signal.aborted);
      return !screening.signal.aborted;
    } catch (error) { setState(screening.signal.aborted ? "screen-stopped" : "error"); setScreened(false); if (!screening.signal.aborted) { const detail = error instanceof Error ? error.message : String(error); setProgressFailure(detail); report(detail, "error"); } return false; }
    finally { finishGameStep(promptState.scope + ":text"); controller.current = null; setSaving(false); }
  };
  const resetTranslation = async (forTranslation = false) => {
    if (busy || !current.current || !await confirmation.ask(forTranslation ? "重新翻译" : "清理译文缓存", "将清除本次翻译统计及所选条目的已有译文和草稿。")) return;
    const next = { ...current.current, entries: current.current.entries.map(entry => entry.selected ? { ...entry, translation: "", error: "", layoutDraft: undefined, screeningDraft: undefined } : entry) };
    if (screened) preserveTargetGameText(next.entries.filter(entry=>entry.selected),options.target,sourceFilter,options.skipTargetLanguage!==false);
    const cleared = current.current.entries.filter(entry => entry.selected);
    const counts = { text: cleared.filter(entry => !!entry.translation).length, drafts: cleared.filter(entry => !!entry.layoutDraft).length, errors: cleared.filter(entry => !!entry.error).length };
    setSaving(true); setState("clearing");
    setProgress({ detail: `正在清理 ${cleared.length} 条文本并保存工程：译文 ${counts.text} 条，草稿 ${counts.drafts} 条`, completed: 0, total: cleared.length });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    try {
      await persist(next, true); publish(next); setDirty(false);
      report(`清理完成：译文 ${counts.text} 条，排版草稿 ${counts.drafts} 条，错误记录 ${counts.errors} 条；原文保留`, "success");
      clearGamePerformance(promptState.scope + ":text", ["translate"]);
      setScreened(screened || forTranslation); setProgress(null); setState(screened || forTranslation ? "screened" : "idle");
      if (!screened && !forTranslation) setScreenStarted(false);
      report(forTranslation ? "所选译文已清除，点击开始翻译继续" : "所选译文已清除，点击开始筛选继续");
    } catch (error) { setState("error"); report(String(error), "error"); }
    finally { setSaving(false); }
  };
  const run = async (automatic = false, failedOnly = false, entryId?: string) => {
    if (isBenchmarkRunning()) return false;
    if (options.kind !== "engine" && !models.includes(options.model)) { report("请选择常规文本模型", "warning"); return false; }
    if (controller.current || loading || !automatic && (busy || !screened) || !current.current?.entries.length) return false;
    const next = { ...current.current, entries: current.current.entries.map(entry => ({ ...entry })) };
    const retryIds = entryId ? new Set([entryId]) : failedOnly ? new Set(next.entries.filter(entry => entry.error).map(entry => entry.id)) : undefined;
    report(failedOnly ? "开始重试失败文本" : "开始翻译文本");
    const segmenter = new UnitySegmentation();
    const abort = new AbortController(); controller.current = abort; beginGameStep(promptState.scope + ":text", "translate"); setRunning(true); setState("running"); setProgressFailure(""); setProgress(null);
    publish(next); setDirty(false);
    let pool: ReturnType<typeof createUnityEnginePool> | undefined;
    const indexes = new Map(next.entries.map((entry, index) => [entry.id, index]));
    let checkpointFailed = false;
    const checkpoint = async (changes: UnityEntry[], initial = false) => {
      const entries = changes.map(entry => ({
        source: entry.source, selected: entry.selected, translation: entry.translation, error: entry.error,
        layoutDraft: entry.layoutDraft, screeningDraft: entry.screeningDraft,
        translationTarget: entry.translationTarget, layoutDraftTarget: entry.layoutDraftTarget,
      }));
      const job = writes.current.then(async () => {
        await measureGameAsync(promptState.scope + ":text", "saveMs", () => gameTextRequest("checkpoint", {
          gamePath, sourcePath: next.sourcePath, entries, ...(initial ? { options, workflow: next.workflow } : {}),
        }));
        const saved = baseline.current;
        if (saved?.sourcePath === next.sourcePath) {
          for (const entry of changes) saved.entries[indexes.get(entry.id)!] = entry;
          if (initial) { saved.options = options; saved.workflow = next.workflow; }
        }
      });
      writes.current = job.then(() => {}, () => {});
      try { await job; } catch (error) { checkpointFailed = true; throw error; }
    };
    const task = async () => {
      try {
        optionWrite.current?.();
        await writes.current;
        if (baseline.current?.sourcePath === next.sourcePath)
          baseline.current = { ...baseline.current, entries: [...baseline.current.entries] };
        let engineStats: UnityEngineProgress[] = [], currentProgress: UnityProgress | null = null;
        let last = 0;
        const reportedFailures = new Map<string, string>();
        const entriesById = new Map(next.entries.map(entry => [entry.id, entry]));
        const reportProgress = (value: UnityProgress) => {
          currentProgress = value;
          if (value.translation)
            reportGameStepItems(promptState.scope + ":text", "translate", value.translation.processed, value.translation.failed);
          const failed = value.translation?.last;
          if (failed?.failed) {
            const entry = entriesById.get(failed.id);
            if (entry?.error && reportedFailures.get(entry.id) !== entry.error) {
              reportedFailures.set(entry.id, entry.error);
              report(`第 ${entry.id} 条翻译失败：${entry.error}`, "error");
            }
          }
          if (performance.now() - last > 120 || value.completed === value.total) {
            setProgress({ ...value, engineStats }); publish({ ...next, entries: [...next.entries] }); last = performance.now();
          }
        };
        measureGameWork(promptState.scope + ":text", "processingMs", () => {
          preserveTargetGameText(next.entries.filter(entry => entry.selected && (!messageCore || !hasMessageCoreNameOverride(entry.source, entry.translation))),
            options.target, sourceFilter, options.skipTargetLanguage !== false);
          for (const entry of next.entries)
            if (entry.selected && entry.translation === entry.source) entry.translationTarget = options.target;
        });
        const savedEntries = new Map(baseline.current?.entries.map(entry => [entry.id, entry]));
        const dirtyEntries = next.entries.filter(entry => {
          const saved = savedEntries.get(entry.id);
          return !saved || !sameTextEdit(entry, saved);
        });
        await checkpoint(dirtyEntries.map(entry => ({ ...entry })), true);
        const general = await api.getSettings();
        let terminology: ReadonlyMap<string, string> = new Map();
        const contextForEntry = createGameTranslationContext(next.entries, options.kind !== "engine" && !!options.includeContext, next.dialoguePages);
        const localProfiles = loadLocalModelProfiles();
        type Role = "text" | "dialogue" | "names" | "line";
        const llmOptions = new Map<Role, ReturnType<typeof buildUnityTranslateOptions>>();
        const reviewModel = Object.keys(localProfiles).find(model => /^qwen3\.5(?::|$)/i.test(model));
        const getOptions = (provider: TranslateProvider, scene: Role, override?: string) => {
          const cached = !override && provider === "llm" && llmOptions.get(scene);
          if (cached) return cached;
          const model = override || (scene === "names" ? options.nameModel : scene === "dialogue" ? options.dialogueModel : "") || options.model;
          const config = buildUnityTranslateOptions(general, provider, sourceFilter, options.target, model, options.joinLines,
            !!localProfiles[model || general.model] || options.kind === "local" && !model,
            provider === "llm" ? gameTaskPrompt(scene, promptState.selection, { source: sourceFilter, target: options.target }) : undefined,
            wrapMode, { selection: promptState.selection, role: scene });
          if (!override && provider === "llm") llmOptions.set(scene, config);
          return config;
        };
        const formatLines = async (original: string, translated: string) => {
          if (options.lineMode === "ratio") return formatUnityStructure(original, translated, restoreUnityTranslationLines);
          if (options.lineMode === "wtp") {
            const texts = new Set<string>();
            planUnityStructuredLines(original, translated, (src, dst) => {
              const plan = planUnityLines(src, dst);
              if (plan.slots.length > 1) texts.add(flattenUnityLines(dst));
              return plan;
            });
            const ends = new Map<string, number[]>();
            for (const text of texts) ends.set(text, await segmenter.sentenceEnds(text, abort.signal));
            return applyUnityLineBreaks(planUnityStructuredLines(original, translated, (src, dst) =>
              planUnityLines(src, dst, undefined, ends.get(flattenUnityLines(dst)))));
          }
          if (options.lineMode === "model") {
            const plan = planUnityStructuredLines(original, translated, planUnityLines);
            if (!plan.breaks.length) return translated;
            const config = getOptions("llm", "line", options.lineModel || general.model);
            const response = await translateGameWithOllama(unityLineModelInput(original, plan), { signal: abort.signal }, {
              ...config, prompt: gameTaskPrompt("line", promptState.selection) + "\n" + UNITY_LINE_MODEL_PROMPT, autoChunk: false
            }, report);
            if (!response.ok) throw new Error(response.error || "断行失败");
            return parseUnityLineModel(plan, response.translation);
          }
          return wrapGameTextToSource(original,gameTextHasSpeaker(original)?translated:restoreUnityTranslationLines(original,translated));
        };
        if (options.kind !== "engine") {
          const roles: Role[] = ["text", "dialogue", "names"];
          const connections = roles.map(role => getOptions("llm", role)).flatMap(connection =>
            connection.llmConcurrency && connection.llmConcurrency > 1 ? [{ connection, lanes: connection.llmConcurrency }] : []);
          await prepareGameOllamaModels(connections, abort.signal, report);
        }
        const requestGroup = options.kind === "engine" || !options.dialogueModel
          ? undefined : localTextRequestGroup(getOptions("llm", "text"), getOptions("llm", "dialogue"));
        const request = async (provider: TranslateProvider, text: string, nameContext?: string, entry?: UnityEntry) => {
          const input = messageCore ? repairMessageCoreNameLineBreak(repairMessageCorePositionPrefix(text)) : text;
          const scene = nameContext ? "names" : isGameDialogue(input, entry) ? "dialogue" : "text";
          const primary = getOptions(provider, scene);
          const preserveDialogueLines = provider === "llm" && scene === "dialogue";
          const signal = provider === "llm" ? abort.signal : AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]);
          return translateGameControls(input, async (protectedText, originalContext, retryReason) => {
            const config = retryReason && reviewModel && reviewModel !== primary.model
              ? getOptions(provider, scene, reviewModel) : primary;
            try {
              const context = provider === "llm" ? gameTranslationRetry(contextForEntry(entry, nameContext, originalContext), retryReason) : {};
              const response = await translateGameWithOllama(prepareUnityTranslationRequest(protectedText, options.joinLines), { signal }, { ...config, ...context, autoFallback: false, ...((nameContext || retryReason) && canDisableOllamaNameThinking(config) ? { ollamaReasoningOff: true } : {}) }, report);
              if (!response.ok) throw Object.assign(new Error(response.error || response.code || "翻译失败"), { code: response.code });
              // The protected request already carries the original display breaks as tokens.
              return preserveDialogueLines && !/[\r\n]/.test(protectedText) && /[\r\n]/.test(response.translation)
                ? prepareUnityTranslationText(response.translation)
                : response.translation;
            } catch (error) {
              abort.signal.throwIfAborted();
              if (provider !== "llm") throw error;
              throw new Error(`${config.model || provider}：${signal.reason?.name === "TimeoutError" ? "请求超时" : error instanceof Error ? error.message : String(error)}`);
            }
          }, options.target, sourceFilter, terminology, options.skipTargetLanguage !== false, preserveDialogueLines);
        };
        if (options.kind === "engine") pool = createUnityEnginePool(engines.filter(row => engineReady(parseEngineKeys(general.translateEngineKeys), row.id)), abort.signal, request, { timingScope: promptState.scope + ":text", onStats: value => { engineStats = value; if (currentProgress) setProgress({ ...currentProgress, engineStats }); } });
        const preparedTerms = await prepareGameTerms(next.entries.filter(entry => (retryIds ? retryIds.has(entry.id) : entry.selected) && (!entry.translation || !textTranslationMatchesTarget(entry, options.target) || entry.error || gameTextProblem(entry.source, entry.translation))), next.entries, options.target, general.textGlossary,
          (name, context) => options.kind !== "engine" ? request("llm", name, context) : pool!.translate(name), abort.signal,
          (detail, completed, total) => setProgress({ detail, completed, total, textStage: "names", model: options.kind !== "engine" ? options.nameModel || options.model : undefined }));
        terminology = preparedTerms.terms;
        await translateUnitySession(next.entries.filter(entry => retryIds ? retryIds.has(entry.id) : entry.selected), new Map(), { onQueue: value => { queue.current = value; }, signal: abort.signal, concurrency: options.kind === "engine" ? Math.max(1, pool!.concurrency) : options.kind === "local" || [options.model || general.model, options.nameModel, options.dialogueModel].some(model => model && loadLocalModelProfiles()[model]) ? 8 : 16, references: next.entries,
          translate: (text, entry) => {
            const systemTranslation = translateRpgSystemMessage(entry, options.target);
            if (systemTranslation !== undefined) return Promise.resolve(systemTranslation);
            return options.kind !== "engine" ? request("llm", text, undefined, entry) : pool!.translate(text, entry?.id);
          },
          format: wrapMode === "natural" ? validateGameNaturalLines : options.joinLines ? formatLines : undefined,
          preserveLayout: options.kind !== "engine" ? isGameDialogue : options.joinLines ? undefined : gameTextHasSpeaker,
          timingScope: promptState.scope + ":text", requestGroup,
          key: gameDialogueReuseKey, targetLanguage: options.target, entryProblem: entry => gameTermProblem(entry.source, preparedTerms.issues),
          retainDraft: wrapMode === "natural",
          validate: gameTextProblem, persist: checkpoint,
          progress: reportProgress,
        });
        publish({ ...next, entries: [...next.entries] }); setDirty(false);
        const failed = next.entries.filter(entry => entry.selected && entry.error);
        setState(failed.length ? "error" : "done"); report(failed.length ? `文本翻译结束，${failed.length} 条失败，可筛选后修改或恢复翻译` : "文本翻译完成", failed.length ? "warning" : "success");
        const completed = !abort.signal.aborted && next.entries.every(entry => !entry.selected || (!!entry.translation && !entry.error));
        finishGameStep(promptState.scope + ":text", completed);
        return !failed.length && !abort.signal.aborted;
      } catch (error) {
        publish({ ...next, entries: [...next.entries] }); setDirty(checkpointFailed || !abort.signal.aborted); setState(abort.signal.aborted && !checkpointFailed ? "stopped" : "error");
        const detail = error instanceof Error ? error.message : String(error);
        if (!abort.signal.aborted || checkpointFailed) setProgressFailure(detail);
        report(abort.signal.aborted && !checkpointFailed ? "文本翻译已中止，已完成结果保留" : detail, abort.signal.aborted && !checkpointFailed ? "warning" : "error");
        return false;
      } finally { segmenter.dispose(); finishGameStep(promptState.scope + ":text"); pool?.dispose(); controller.current = null; setRunning(false); work.current = null; }
    };
    work.current = task(); return await work.current;
  };
  const importFile = async (file: GameImportSource, mode = importMode) => {
    if (!current.current) return;
    const contents = new TextDecoder("utf-8", { fatal: true }).decode(typeof file === "string" ? await readFileBytes(file) : await file.arrayBuffer());
    const value = importGameText(current.current.entries, contents, /\.csv$/i.test(typeof file === "string" ? file : file.name), mode, messageCore);
    setImportIssues(value.reassemblyIssues);
    if (value.changed) {
      const previous = new Map(current.current.entries.map(entry => [entry.id, entry.translation]));
      for (const entry of value.entries) if (entry.translation !== previous.get(entry.id)) entry.translationTarget = options.target;
      const rows = value.entries.filter(entry => entry.translation !== previous.get(entry.id));
      setImportPreview({ project: current.current, rows, page: 0 });
    }
    const parts = ["导入 " + value.changed + " 条译文"];
    if (value.reassembled) parts.push("按原换行重组 " + value.reassembled + " 条");
    if (value.reassemblyIssues.length) parts.push(value.reassemblyIssues.length + " 条重组失败，详情见「批量结果」");
    if (value.unmatched) parts.push(value.unmatched + " 条导入原文未匹配");
    report(parts.join("，") + (value.changed ? "，请检查导入预览" : ""), value.unmatched || value.reassemblyIssues.length ? "warning" : "success");
  };
  const finishImport = () => {
    if (!importPreview || !current.current || current.current !== importPreview.project) {
      setImportPreview(undefined); showAppNotice("工程已更新，请重新导入", "error"); return;
    }
    const errors = importPreview.rows.filter(entry => entry.translation && gameTextProblem(entry.source, entry.translation));
    if (errors.length) { showAppNotice(`还有 ${errors.length} 条译文需要校验`, "error"); return; }
    const changes = new Map(importPreview.rows.map(entry => [entry.id, { ...entry, error: "" }]));
    publish({ ...current.current, entries: current.current.entries.map(entry => changes.get(entry.id) || entry) });
    setDirty(true); setState("idle"); setImportPreview(undefined);
  };
  const root = useRef<HTMLElement>(null);
  const drop = useGameFileDrop({ root, active: active && visible && !busy, busy: saving, match: (_target, names) => names.length === 1 && /\.(json|csv)$/i.test(names[0]) ? root.current : null, label: () => "松开以导入翻译文件", drop: async file => { if (await leave()) await importFile(file); }, error: text => report(text, "error") });
  const pickImport = async (mode: "fill"|"replace") => { try { if (!await leave()) return; setImportMode(mode); const path = await open({ defaultPath: gamePath, multiple: false, filters: [{ name: "翻译文件", extensions: ["json", "csv"] }] }); if (typeof path === "string") await importFile(path,mode); } catch (error) { report(String(error), "error"); } };
  const download = async (range:"all"|"filtered") => { try { const path = await saveOutputFile("游戏译文.json", new TextEncoder().encode(JSON.stringify(gameTextDictionary(range==="all"?entries:filtered, true, options.target), null, 2)), ["json"], "MTool JSON", "text", gamePath); if (path) report("译文已导出", "success"); } catch (error) { report(String(error), "error"); } };
  const qualityCache = useMemo(() => new WeakMap<UnityEntry, { translation: string; warnings: string[] }>(), [options.target]);
  const qualityIssues = useMemo(() => {
    const ids = new Set<string>();
    if (!textFilters.quality && filter !== "quality") return ids;
    for (const entry of entries) {
      let cached = qualityCache.get(entry);
      if (!cached || cached.translation !== entry.translation) {
        const warnings = unityTranslationQuality(entry.source, entry.translation, options.target);
        const residue = gameJapaneseTextIssue(entry.source, entry.translation, options.target);
        if (residue) warnings.push(residue);
        const repeatedText = /([\p{Script=Han}]{3,8})\1/u;
        if (options.target.startsWith("zh") && entry.source !== entry.translation &&
          repeatedText.test(entry.translation.replace(gameFormatTokens(), "")) &&
          !repeatedText.test(entry.source.replace(gameFormatTokens(), ""))) warnings.push("译文有连续重复的文字，请核对译名或术语");
        cached = { translation: entry.translation, warnings };
        qualityCache.set(entry, cached);
      }
      if (cached.warnings.length) ids.add(entry.id);
    }
    return ids;
  }, [entries, options.target, qualityCache, textFilters.quality, filter]);
  const membership = useRef<{ key: string; ids: Set<string> } | null>(null);
  const matched = useMemo(() => {
    const key = `${search}\n${filter}\n${options.target}\n${JSON.stringify(textFilters)}`;
    if (dirty && membership.current?.key === key) return entries.filter(entry => membership.current!.ids.has(entry.id));
    const rows = entries.filter(entry => matchesGameTextFilters(textFilters, entry.selected, !(textFilters.pending && textFilters.failed && textFilters.done) && !!entry.translation && !gameTextProblem(entry.source, entry.translation), !!entry.error, qualityIssues.has(entry.id), targetTextIds.has(entry.id)) && (filter === "all" || filter === "target" && targetTextIds.has(entry.id) || filter === "quality" && qualityIssues.has(entry.id) || filter === "unfinished" && (!!entry.error || !!gameTextProblem(entry.source, entry.translation))) && (!search || `#${entry.id}\n${entry.source}\n${entry.translation}\n${entry.file}`.toLowerCase().includes(search.toLowerCase())));
    membership.current = { key, ids: new Set(rows.map(entry => entry.id)) }; return rows;
  }, [entries, search, filter, dirty, targetTextIds, qualityIssues, textFilters, gameTextProblem]);
  const filtered = useMemo(() => limitGameText(matched, textFilters.limit), [matched, textFilters.limit]);
  const checkedCount = filtered.reduce((count, entry) => count + Number(entry.selected), 0);
  const hasMixedSelection = checkedCount > 0 && checkedCount < filtered.length;
  const pages = Math.max(1, Math.ceil(filtered.length / 40)), visiblePage = Math.min(page, pages - 1), rows = filtered.slice(visiblePage * 40, (visiblePage + 1) * 40);
  const [rowJump, setRowJump] = useState<{ id: string; sequence: number } | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const locateEntry = (id: string) => {
    let index = filtered.findIndex(entry => entry.id === id);
    if (index < 0) {
      index = entries.findIndex(entry => entry.id === id);
      if (index < 0) return;
      membership.current = null;
      setSearch(""); setFilter("all"); setTextFilters({ ...defaultGameTextFilters });
    }
    setPage(Math.floor(index / 40));
    setRowJump(previous => ({ id, sequence: (previous?.sequence || 0) + 1 }));
  };
  useEffect(() => {
    if (!rowJump) return;
    const row = tableRef.current?.querySelector<HTMLTableRowElement>("tr[data-entry-id='" + CSS.escape(rowJump.id) + "']");
    row?.scrollIntoView({ block: "center", inline: "nearest" });
    row?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setRowJump(previous => previous === rowJump ? null : previous), 2200);
    return () => window.clearTimeout(timer);
  }, [rowJump]);
  const changeView = async (change: () => void) => { if (!dirty || running || await leave()) { membership.current = null; change(); setPage(0); } };
  const models = gameAvailableModels(settings);
  const benchmarkWorkload = useRef({ entries, selected, dialoguePages: project?.dialoguePages });
  benchmarkWorkload.current = { entries, selected, dialoguePages: project?.dialoguePages };
  const benchmark = (): BenchmarkInput => ({
    scope: promptState.scope, screenModel: options.screeningModel, getWorkload: () => benchmarkWorkload.current, models, onMessage: report,
    current: { source: sourceFilter, target: options.target, wrap: wrapMode, includeContext: !!options.includeContext,
      skipTarget: options.skipTargetLanguage !== false, engines, prompts: promptState.selection,
      modelIds: {text:options.kind === "engine" ? "" : options.model, dialogue:options.dialogueModel || "", names:options.nameModel || ""} },
  });
  if (handle.current) {
    handle.current.benchmark = benchmark;
    handle.current.locate = locateEntry;
    handle.current.findText = (source, translation) => {
      const matches = entries.filter(entry => entry.source === source && entry.translation === translation);
      return matches.length === 1 ? matches[0].id : undefined;
    };
    handle.current.canRetryFailures = !busy && screened;
    handle.current.retryFailures = () => { if (!busy && screened) void run(false, true); };
  }
  const textCleanupAvailable = !!stepPerformance(promptState.scope + ":text", "translate").taskId ||
    selected.some(entry => entry.layoutDraft || entry.error || (entry.translation && entry.translation !== entry.source));
  const clearScreen = async () => {
    if (busy || !current.current || !await confirmation.ask("清理筛选及后续结果", "清除筛选状态、译文和排版草稿，保留原文。")) return;
    setSaving(true); setState("clearing");
    setProgress({ completed: 0, total: current.current.entries.length, detail: "正在清理全部文本的筛选状态、译文和草稿…" });
    try {
      optionWrite.current?.(); await writes.current;
      const next = {...current.current,workflow:{screened:false},entries:current.current.entries.map(entry=>({...entry,translation:"",error:"",layoutDraft:undefined,screeningDraft:undefined}))};
      await persist(next,true);
      const saved = await gameTextRequest<GameTextProject>("load", { gamePath, sourcePath: next.sourcePath });
      if (saved.entries.some(entry => entry.translation || entry.layoutDraft || entry.screeningDraft || entry.error)) throw new Error("清理后仍存在文本结果，工程未恢复为空，请重试");
      publish(saved); baseline.current = saved; setDirty(false); setProgressFailure("");
      setScreened(false); setScreenStarted(false); setProgress(null); setState("idle");
      clearGamePerformance(promptState.scope + ":text", ["screen", "translate"]);
      report("筛选及后续译文、排版草稿已清理", "success");
    } catch(error) { setState("error"); report(String(error), "error"); }
    finally { setSaving(false); }
  };
  const textReady = !!project?.sourcePath && stats.coverageCompleted === selected.length;
  const screenComplete = screened || textReady;
  const screeningProgress = !screenComplete || ["screening", "screen-stopped", "screened"].includes(state);
  const currentPhase = screeningProgress ? "screen" : "translate";
  const automaticSteps = useRef({ screen, run });
  automaticSteps.current = { screen, run };
  const configLocked = loading || (busy && (configured === currentPhase || configured === "screen" && screened));

  const [, refreshElapsed] = useState(0);
  useEffect(() => {
    const refresh = () => refreshElapsed(value => value + 1);
    window.addEventListener("llmchat-game-performance", refresh);
    const timer = running || state === "screening" ? window.setInterval(refresh, 1000) : undefined;
    return () => {
      window.removeEventListener("llmchat-game-performance", refresh);
      window.clearInterval(timer);
    };
  }, [running, state]);
  const elapsedLabel = gameDuration(stepPerformance(promptState.scope + ":text", currentPhase).elapsedMs);
  const stepLabel = progress?.textStage ? gameTextStageLabels[progress.textStage] : screeningProgress ? "筛选文本" : "翻译正文";
  const progressLabel = loading ? "正在读取" : state === "clearing" ? "正在清理"
    : state === "screening" ? "正在筛选" : state === "screen-stopped" || state === "stopped" ? "已中止"
    : running ? "正在处理"
    : state === "error" ? progressFailure ? "失败" : "有条目失败" : screeningProgress && screenComplete || textReady ? "已完成" : "待开始";
  const progressCompleted = screeningProgress ? screenComplete ? selected.length : progress?.completed ?? 0 : progress?.completed ?? stats.completed;
  const progressTotal = screeningProgress ? screenComplete ? selected.length : progress?.total ?? selected.length : progress?.total ?? stats.total;
  const percent = progressTotal ? Math.min(100, Math.floor(progressCompleted / progressTotal * 100)) : textReady ? 100 : 0;
  const prompt = (scene: keyof typeof promptState.selection) => promptState.selection[scene] || "builtin:" + scene;
  const languageConfiguration = [options.source, options.target, options.onlySourceLanguage !== false, options.skipTargetLanguage !== false];
  const modelConfiguration = options.kind !== "engine" ? [
    options.model, prompt("text"), options.dialogueModel || "", prompt("dialogue"), options.nameModel || "", prompt("names"),
  ] : [];
  const configuration = {
    screen: JSON.stringify([...languageConfiguration, options.screeningModel ?? null, options.screeningModel !== undefined ? prompt("textScreen") : null]),
    translate: JSON.stringify([options.kind, ...languageConfiguration, wrapMode,
      options.kind === "engine" ? engines : [modelConfiguration, !!options.includeContext]]),
  };
  const restoreConfiguration = (step: string) => {
    if (step === "screen") {
      const { screeningModel, source, target, onlySourceLanguage, skipTargetLanguage } = options;
      setOptions(current => ({ ...current, screeningModel, source, target, onlySourceLanguage, skipTargetLanguage }));
      promptState.select("textScreen", prompt("textScreen"));
      return;
    }
    setOptions(current => ({ ...options, screeningModel: current.screeningModel }));
    setEngines(engines);
    for (const scene of ["text", "dialogue", "names"] as const) promptState.select(scene, prompt(scene));
  };
  const languageFields = <>
    <div className="unity-language-setting"><div className="unity-language-heading"><span>原文语言</span><label className="unity-inline-check" data-tooltip="仅翻译含原语言的内容；自动时使用检测到的主语言。"><input type="checkbox" checked={options.onlySourceLanguage !== false} disabled={busy} onChange={event => setOptions({ ...options, onlySourceLanguage: event.target.checked })} />仅翻译原语言</label></div><select aria-label="原文语言" disabled={busy} value={options.source} onChange={event => { setOptions({ ...options, source: event.target.value }); }}><option value="auto">自动检测</option>{UNITY_LANGUAGES.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}</select></div>
    <div className="unity-language-setting"><div className="unity-language-heading"><span>目标语言</span><label className="unity-inline-check" data-tooltip="仅跳过能明确判断已符合目标语言的条目，原样保留；中日共用汉字短词仍翻译。关闭后重做可强制翻译。"><input type="checkbox" checked={options.skipTargetLanguage !== false} disabled={busy} onChange={event => { setOptions({ ...options, skipTargetLanguage: event.target.checked }); }} />跳过目标语言</label></div><select aria-label="目标语言" disabled={busy} value={options.target} onChange={event => { setOptions({ ...options, target: event.target.value }); }}>{UNITY_LANGUAGES.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}</select></div>
  </>;
  const progressState = loading || state === "clearing" || state === "screening" || running ? "running"
    : state === "screen-stopped" || state === "stopped" ? "stopped"
    : state === "error" ? "error" : screeningProgress && screenComplete || textReady ? "done" : "pending";
  const progressContent = <GameStepProgress title={stepLabel} state={progressState} label={progressLabel}
    elapsed={elapsedLabel} percent={loading || state === "clearing" || !progressTotal && progressState === "running" ? undefined : percent}
    count={!loading && state !== "clearing" && progressTotal ? `${progressCompleted} / ${progressTotal} 条` : undefined}>
    {state === "clearing" && <p className="unity-task-detail">{progress?.detail}</p>}
    {progress && (!screeningProgress || progress.textStage === "screening") && <UnityTranslationProgress progress={progress} running={running || state === "screening"} failure={state === "error" ? progressFailure : undefined} onLocate={locateEntry} />}
    {!progress && state === "error" && progressFailure && <p className="game-text-progress-failure" role="alert">{progressFailure}</p>}
  </GameStepProgress>;
  return <>{active && visible && loading && openedGame.current !== gamePath && <UnityProjectLoading project={gamePath.split(/[\\/]/).filter(Boolean).at(-1) || "游戏工程"} path={gamePath} detail="正在读取文本、译文和处理进度…"/>}{confirmation.dialog}{active && visible && importPreview && createPortal(<div className="game-import-backdrop"><section role="dialog" aria-modal="true" aria-label="导入预览" className="game-import-dialog">
      <header><strong>导入预览 · {importPreview.rows.length} 条</strong><button type="button" className="unity-btn" onClick={()=>setImportPreview(undefined)}>取消</button></header>
      <div className="game-import-rows">{importPreview.rows.slice(importPreview.page*40,importPreview.page*40+40).map(entry=><label key={entry.id}><span>#{entry.id} · {entry.source}</span><textarea value={entry.translation} onChange={event=>{const translation=event.target.value;setImportPreview({...importPreview,rows:importPreview.rows.map(row=>row.id===entry.id?{...row,translation}:row)});}}/><small>{entry.translation && gameTextProblem(entry.source, entry.translation)}</small></label>)}</div>
      <footer><button className="unity-btn" disabled={!importPreview.page} onClick={()=>setImportPreview({...importPreview,page:importPreview.page-1})}>上一页</button><span>{importPreview.page+1} / {Math.ceil(importPreview.rows.length/40)}</span><button className="unity-btn" disabled={(importPreview.page+1)*40>=importPreview.rows.length} onClick={()=>setImportPreview({...importPreview,page:importPreview.page+1})}>下一页</button><button className="unity-btn unity-btn-primary" onClick={finishImport}>校验并应用</button></footer></section></div>, document.body)}{closingPhase&&<ClosingProgress phase={closingPhase}/>}{drop.overlay}{controls && createPortal(<div className="engine-workflow-content" hidden={!visible || step !== 2}><div className="unity-step-panel"><GamePromptContext.Provider value={promptState}><GameFlowSequence runningParameters={[
      { scope: "config", label: "原文语言", value: UNITY_LANGUAGES.find(language => language.value === options.source)?.label ?? "自动检测" },
      { scope: "config", label: "目标语言", value: UNITY_LANGUAGES.find(language => language.value === options.target)?.label ?? options.target },
      { scope: "config", label: "仅翻译原语言", value: options.onlySourceLanguage !== false ? "开启" : "关闭" },
      { scope: "config", label: "跳过目标语言", value: options.skipTargetLanguage !== false ? "开启" : "关闭" },
      { scope: "config", label: "合并换行", value: options.joinLines ? "开启" : "关闭" },
    ]} configurationCommit={configurationCommit} configurationRevision={configurationRevision} testConfigurations={testConfigurations} testConfigurationDisabled={testConfigurationDisabled || busy || !project} onSaveConfiguration={saveConfiguration} configurationScope={project && !loading ? gamePath + ':' + sourcePath : null} configuration={configuration} restoreConfiguration={restoreConfiguration} actions={<button className="unity-btn unity-btn-warning unity-skip-remaining" disabled={busy || !entries.length || skipped || stats.coverageCompleted === selected.length} onClick={onSkip}>跳过剩余内容</button>} activity={{step: currentPhase, state: state === "screening" || running ? "running" : state === "screen-stopped" ? "stopped" : state, progress: progressContent}} configured={configured} onConfigure={setConfigured}
    onRun={!busy && !textReady && selected.length ? () => void handle.current?.automatic(new AbortController().signal) : undefined}
    steps={[
      { id: "screen", title: "筛选文本", models: [{role:"textScreen",id:options.screeningModel}], summary: options.screeningModel !== undefined ? "大模型判断是否需要翻译" : "按语言规则筛选",
        state: screenComplete ? "done" : "current",
        run: !screenComplete && selected.length ? () => void screen() : undefined,
        stop: state === "screening" ? () => controller.current?.abort() : undefined,
        runLabel: state === "screen-stopped" ? "继续" : "开始", runDisabled: busy && state !== "screening",
        clear: !busy && (screenStarted || screenComplete) ? () => void clearScreen() : undefined },
      { id: "translate", title: "翻译正文",
        models: options.kind === "engine" ? [] : [
        {role:"names",id:options.nameModel || options.model}, {role:"text",id:options.model}, {role:"dialogue",id:options.dialogueModel || options.model},
      ], summary: options.kind === "engine" ? "翻译引擎" : options.model.split("/").pop(),
        state: textReady ? "done" : screenComplete ? "current" : "waiting",
        run: screenComplete && !textReady ? () => void run() : undefined,
        stop: running ? () => controller.current?.abort() : undefined,
        runLabel: state === "stopped" || state === "error" ? "继续" : "开始",
        runDisabled: !running && (busy || options.kind !== "engine" && !models.includes(options.model)),
        clear: !busy && textCleanupAvailable ? () => void resetTranslation(true) : undefined },
    ]}><div className="unity-translation-settings">
    {configured === "screen" && <GameProcessingTabs label="筛选方式" localLabel="本地筛选" value={options.screeningModel === undefined ? "local" : "llm"}
      disabled={configLocked} onChange={method => setOptions(current => ({ ...current, screeningModel: method === "llm" ? "" : undefined }))}>
      <div className="unity-control-group"><div className="unity-group-fields unity-translation-fields">
        {options.screeningModel !== undefined && <GameModelSelect label="文本筛选模型" promptKey="textScreen" models={models} value={options.screeningModel}
          disabled={configLocked} onChange={model => setOptions(current => ({ ...current, screeningModel: model }))} />}
        {languageFields}
      </div></div>
    </GameProcessingTabs>}
    {configured === "translate" && <GameTranslationTabs kind={options.kind} disabled={configLocked} onChange={kind => setOptions({ ...options, kind, ...(kind==="engine"&&wrapMode==="natural"?{wrapMode:"join",joinLines:true}:{}) })}><div className="unity-control-group unity-translation-group"><div className="unity-group-fields unity-translation-fields">
    {configured === "translate" && options.kind !== "engine" && <>
      <GameModelSelect label="常规文本模型" promptKey="text" models={models} value={options.model} disabled={configLocked} onChange={model => setOptions({ ...options, model })} />
      <GameModelSelect optional label="对白模型（可选）" promptKey="dialogue" models={models} value={options.dialogueModel || ""} disabled={configLocked} onChange={dialogueModel => setOptions({ ...options, dialogueModel })} />
      <GameModelSelect optional label="术语模型（可选）" promptKey="names" models={models} value={options.nameModel || ""} disabled={configLocked} onChange={nameModel => setOptions({ ...options, nameModel })} />
    </>}
    {languageFields}
    </div>
    {configured === "translate" && options.kind !== "engine" && <div className="unity-run-options"><label className="unity-inline-check" data-tooltip={GAME_CONTEXT_HINT + " 词典型工程仅有独立原文时，使用条目自身的语境。"}><input type="checkbox" checked={!!options.includeContext} disabled={configLocked} onChange={event => setOptions({ ...options, includeContext: event.target.checked })} />附带上下文</label></div>}
    </div>{configured === "translate" && options.kind === "engine" && <UnityEngineList choices={engines} keys={parseEngineKeys(settings.translateEngineKeys)} disabled={configLocked} expanded={expanded} onExpandedChange={setExpanded} onChange={setEngines} />}</GameTranslationTabs>}
    {configured === "translate" && options.joinLines && wrapMode!=="natural" && <div className="unity-control-group"><label>断行方式<select value={options.lineMode || "local"} disabled={configLocked} onChange={e=>setOptions({...options,lineMode:e.target.value as GameTextOptions["lineMode"]})}><option value="local">本地智能断行</option><option value="ratio">按比例断行</option><option value="wtp">WtP 断句</option><option value="model">大模型断行</option></select></label>
      {options.lineMode==="model" && <GameModelSelect label="断行辅助模型" promptKey="line" models={models} value={options.lineModel || settings.model} disabled={configLocked} onChange={lineModel=>setOptions({...options,lineModel})}/>}</div>}
    {configured === "translate" && <div className="unity-control-group"><label data-tooltip="恢复换行以原文最长行的估算显示宽度为上限；自然断行由翻译模型安排。">换行处理<select disabled={configLocked} value={wrapMode} onChange={event => { setOptions({ ...options, wrapMode:event.target.value as typeof wrapMode, joinLines:event.target.value!=="keep" }); }}><option value="join">合并翻译后恢复换行</option><option value="keep">保留换行翻译</option>{options.kind!=="engine"&&<option value="natural">大模型自然断行</option>}</select></label></div>}
    </div></GameFlowSequence></GamePromptContext.Provider>{batchResults && <div className="unity-step-batch">{batchResults}</div>}</div>
    </div>, controls)}
    {results && createPortal(<section hidden={!visible} ref={root} data-game-drop-zone="text" {...drop.handlers} className="unity-offline-workbench game-text-workbench"><div className="unity-offline-toolbar"><div className="unity-result-filters"><strong>文本与译文</strong><GameTextFileMenu kind="download" active={active&&visible} disabled={busy||!entries.length} options={[
      {value:"all",label:"下载全部",title:`下载工程全部 ${entries.length} 条，包含未勾选条目`},
      {value:"filtered",label:"下载筛选内容",title:`下载当前筛选匹配的全部 ${filtered.length} 条，包含其他分页`,disabled:!filtered.length},
    ]} onSelect={range=>void download(range)}/><GameTextFileMenu kind="import" active={active&&visible} disabled={busy||!entries.length} options={GAME_TEXT_IMPORT_CHOICES} onSelect={mode=>void pickImport(mode)}/><GameTextFilterMenu active={active && visible} value={textFilters} matched={matched.length} shown={filtered.length}
          onLimitChange={limit => { setTextFilters(previous => ({ ...previous, limit })); setPage(0); }}
          onChange={value => { void changeView(() => { setTextFilters(value); setFilter("all"); }); }} /></div><div className="unity-result-tools"><input type="search" placeholder="搜索" aria-label="搜索原文和译文" value={search} onChange={event => { const value = event.target.value; void changeView(() => setSearch(value)); }} /><button className="unity-btn unity-text-discard" disabled={!dirty || busy} onClick={async () => { if (await confirm("取消尚未保存的文本修改？", { title: "取消修改", kind: "warning", okLabel: "取消修改", cancelLabel: "返回" })) discard(); }}>取消修改</button><button className="unity-btn" disabled={busy || !dirty || !project?.sourcePath} onClick={() => void save()}>保存</button></div></div>
    {loading ? <div className="unity-offline-empty">正在读取文本工程…</div> : !entries.length ? <div className="unity-offline-empty">请先在步骤 1 扫描资源</div> : <><div className="unity-offline-table-scroll"><table ref={tableRef} className="unity-offline-table"><colgroup><col style={{ width: 32 }} /><col style={{ width: 125 }} /><col /><col /></colgroup><thead><tr><th><input type="checkbox" aria-label="勾选当前筛选结果"
        data-tooltip="仅勾选或取消当前筛选结果，包含其他分页。" disabled={busy || !filtered.length}
        checked={filtered.length > 0 && checkedCount === filtered.length}
        ref={input => { if (input) input.indeterminate = hasMixedSelection; }} onChange={event => { membership.current = null; editEntries(new Set(filtered.map(entry => entry.id)), { selected: event.target.checked }); }} /></th><th>来源</th><th>原文</th><th>译文</th></tr></thead><tbody>{rows.map(entry => <tr key={rowJump?.id === entry.id ? entry.id + ":" + rowJump.sequence : entry.id} data-entry-id={entry.id} tabIndex={-1} className={(entry.error ? "has-error " : "") + (rowJump?.id === entry.id ? "unity-entry-target" : "")}><td><input type="checkbox" aria-label={`选择第 ${entry.id} 条`} disabled={busy} checked={entry.selected} onChange={event => edit(entry.id, { selected: event.target.checked })} /></td><td><span><SearchHighlight text={`#${entry.id} · 游戏文本`} query={search} /></span><small>MTool.json</small></td><td className="unity-offline-source"><div className="unity-source-text"><GameTextScreenedSource repairs={entry.dialogueRepairs} completed={!!entry.translation && !entry.error && !gameTextProblem(entry.source, entry.translation)} source={entry.source} target={options.target} sourceLanguage={sourceFilter} locale={entry.locale} skipTarget={options.skipTargetLanguage !== false} screened={entry.selected && (screened || entry.screeningDraft !== undefined || entry.translation === entry.source)} query={search} /></div></td><td><div className="unity-entry-editor"><GameTextScreenedEditor repairPreview={entry.dialogueRepairPreview} repairs={entry.dialogueRepairs} screening={{ source: entry.source, target: options.target, sourceLanguage: sourceFilter, locale: entry.locale, skipTarget: options.skipTargetLanguage !== false, screened: entry.selected && (screened || entry.screeningDraft !== undefined || entry.translation === entry.source) }} screeningDraft={entry.screeningDraft} query={search} aria-label={`第 ${entry.id} 条译文`} value={entry.translation} rows={1} readOnly={busy} onChange={event => edit(entry.id, { translation: event.target.value, screeningDraft: undefined })} />{entry.error && <><button type="button" className="unity-btn" title={testTitle} disabled={testing || (busy ? queue.current?.status(entry.id)!=="failed" : !screened)} onClick={()=>{ if(queue.current){queue.current.retry(entry.id);}else void run(false,true,entry.id); }}>重试此条</button><button className="unity-row-error" data-tooltip={entry.error} aria-label={entry.error} onClick={() => { report(`第 ${entry.id} 条翻译失败：${entry.error}`, "error"); showAppNotice(`第 ${entry.id} 条：${entry.error}`, "error"); }}>!</button></>}</div></td></tr>)}</tbody></table>{!filtered.length && <div className="game-text-no-matches" role="status"><strong>没有匹配的文本</strong><span>请修改搜索词或筛选条件后重试。</span></div>}</div><div className="unity-results-footer"><span>{options.onlySourceLanguage === false ? "全部语言" : UNITY_LANGUAGES.find(language => language.value === detectedSource)?.label || "自动检测"} · 可回写 {stats.coverageCompleted} / {selected.length} 条</span><div className="unity-offline-pagination" aria-label="文本结果分页"><button className="unity-btn" disabled={!visiblePage} onClick={() => setPage(Math.max(0, visiblePage - 10))}>-10 页</button><button className="unity-btn" disabled={!visiblePage} onClick={() => setPage(visiblePage - 1)}>上一页</button><GamePageNumber page={visiblePage} pages={pages} onPage={setPage} /><button className="unity-btn" disabled={visiblePage + 1 >= pages} onClick={() => setPage(visiblePage + 1)}>下一页</button><button className="unity-btn" disabled={visiblePage + 1 >= pages} onClick={() => setPage(Math.min(pages - 1, visiblePage + 10))}>+10 页</button></div></div></>}
    </section>, results)}
    {pendingLeave && <GameDialog title="文本修改尚未保存" description="保存修改后继续，或放弃尚未保存的文本修改。" onCancel={()=>{pendingLeave("cancel");setPendingLeave(null);}}>{([["cancel", "返回"], ["discard", "放弃修改"], ["save", "保存后继续"]] as const).map(([choice,label])=><button key={choice} autoFocus={choice==="cancel"} className={choice==="save"?"game-confirm-primary":choice==="discard"?"game-confirm-accept":"game-confirm-cancel"} onClick={()=>{pendingLeave(choice);setPendingLeave(null);}}>{label}</button>)}</GameDialog>}
  </>;
}
