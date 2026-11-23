import { useRef, type RefObject } from "react";
import type { Settings, OcrMode } from "../../api";
import type { OutputLevel } from "../../appOutput";
import { isBenchmarkRunning } from "../../benchmark/benchmarkRunner";
import { gameImageRedrawSelected } from "../../gameImagePlacement";
import { defaultUnityImageScreening, needsUnityImageScreening, unityImageRefinementPending } from "../../unityImageFiltering";
import { beginGameStep, completeGameStep, finishGameStep, reportGameStepItems, stepPerformance } from "../../gameModelPerformance";
import { screenGameText } from "../../gameTextScreening";
import { UnityPaused, unityRun, unityTranslationError, type UnityPatch, type UnityProgress, type UnityProject } from "../../unityOffline";
import { sameUnityGamePath } from "../../unityTranslation";
import { createUnityTranslationJobs, UnityTranslationStopped, type UnityTranslationPart } from "../../unityTranslationJobs";
import { unityTranslationReadiness } from "../../unityTranslationReadiness";
import { yieldUnityPreparation } from "../../unityTranslationSession";
import { UNITY_STEPS as GENERATION_STEPS, unityLanguageScope, unityScanOptionChanges, type unityScanUpdate } from "../../unityWorkflow";
import type { useGameActionConfirm } from "../GameActionConfirm";
import type { GameStepConfigurationCommit } from "../GameFlowSequence";
import type { DeploymentPatch } from "./offlineExport";
import type { RunCheckpoint } from "./useCheckpointWriter";
import { runImagePasses, unityImagePhaseNames, unityImagePhases, type UnityImagePhase } from "./useImageOrchestration";
import { runTextBranch } from "./useTextOrchestration";

type ScanOptions = Parameters<typeof unityScanOptionChanges>[1];
type Progress = (value: UnityProgress) => void;
type Execution = ReturnType<Parameters<typeof runTextBranch<RunCheckpoint>>[3]["getExecution"]> & {
  translateImages: (project: UnityProject, controller: AbortController, run: RunCheckpoint, report: Progress) => Promise<UnityProject>;
};

type WorkflowOptions = ScanOptions & Pick<RunCheckpoint,
  "translationKind" | "llmModel" | "dialogueModel" | "nameModel" | "imageModel" | "imageReviewModel" | "engine" |
  "source" | "target" | "joinLines" | "wrapMode" | "textScreenModel" | "includeContext" | "skipTargetLanguage" |
  "onlySourceLanguage" | "lineMode" | "lineModel" | "imageOcrMode" | "imageVisionModel" | "imageLayoutModel" |
  "imageRedrawProfile" | "imageConcurrency" | "imageConfidenceThreshold" | "imageScreeningOptions" | "fontPath" | "extraCharacters"
> & {
  root: string;
  project: UnityProject | null;
  patch: DeploymentPatch | null;
  checkpoint: RunCheckpoint | null;
  checkpointRef: RefObject<RunCheckpoint | null>;
  latest: RefObject<UnityProject | null>;
  running: RefObject<Promise<void> | null>;
  taskWrites: RefObject<Promise<unknown>>;
  projectWrites: RefObject<Promise<unknown>>;
  elapsedOrigins: RefObject<Partial<Record<"scan" | UnityTranslationPart, number>>>;
  engineChoices: RunCheckpoint["engines"];
  picture: { source: string; target: string };
  imagePart: boolean;
  imageTask: RefObject<UnityImagePhase>;
  imageThreshold: RefObject<number>;
  imageMode: RefObject<OcrMode>;
  imageEditorAbort: RefObject<AbortController | null>;
  imageEditorWork: RefObject<Promise<void> | null>;
  imageConfigurationCommit: RefObject<GameStepConfigurationCommit | null>;
  textConfigurationCommit: RefObject<GameStepConfigurationCommit | null>;
  retryFailureIds: RefObject<Set<string> | undefined>;
  textScreened: boolean;
  followProgress: RefObject<boolean>;
  importPreviewRef: RefObject<unknown>;
  applyingTestConfiguration: boolean;
  restoring: boolean;
  preparingRescan: boolean;
  needsScan: boolean;
  scanUpdate: Pick<ReturnType<typeof unityScanUpdate>, "reasons">;
  busy: string;
  dirty: boolean;
  mosaicBusy: boolean;
  settings: Settings;
  promptState: { scope: string };
  isTextReady: () => boolean;
  getExecution: () => Execution;
  publish: (project: UnityProject) => void;
  projectCheckpoint: (project: UnityProject) => RunCheckpoint;
  remember: (checkpoint: RunCheckpoint) => void;
  save: () => Promise<void>;
  saveTranslation: (project: UnityProject, part: UnityTranslationPart) => Promise<void>;
  loadProject: (folder: string, previousFolder?: string) => Promise<UnityProject>;
  scan: (report?: Progress, signal?: AbortSignal, checkpoint?: RunCheckpoint) => Promise<UnityProject>;
  exportPatch: (project: UnityProject, report?: Progress, signal?: AbortSignal, checkpoint?: RunCheckpoint) => Promise<DeploymentPatch>;
  applyPatch: (patch: UnityPatch, report?: Progress, signal?: AbortSignal) => Promise<unknown>;
  operation: (label: string, task: () => Promise<void>, keepProgress?: boolean) => Promise<boolean>;
  confirm: ReturnType<typeof useGameActionConfirm>["confirm"];
  logAction: (text: string, level?: OutputLevel) => void;
  setActionError: (message: string) => void;
  setPreparingRescan: (value: boolean) => void;
  setPatch: (value: null) => void;
  setFontPlan: (value: null) => void;
  setActiveStep: (value: number) => void;
  setImagePart: (value: boolean) => void;
  setBusy: (message: string) => void;
  setMessage: (message: string) => void;
  setTextScreened: (value: boolean) => void;
  setLocalActivity: (value: null) => void;
};

export function getPausedScanState(checkpoint: RunCheckpoint | null, scanOptions: ScanOptions) {
  const pausedScan = checkpoint?.step === 1 && !checkpoint.finished && (checkpoint.progress.state === "stopped" || checkpoint.progress.state === "error");
  const scanOptionsChanged = !!pausedScan && unityScanOptionChanges(checkpoint!, scanOptions).length > 0;
  return { pausedScan, scanOptionsChanged };
}

export function usePauseResume(getOptions: () => WorkflowOptions) {
  const translationJobs = useRef<ReturnType<typeof createUnityTranslationJobs> | null>(null);
  const abort = useRef<AbortController | null>(null);
  async function startWorkflow(startStep: number, endStep: number, resume = false, automatic = startStep < endStep, updateScan = false, part?: UnityTranslationPart, imageChain = false) {
    const { importPreviewRef, setActionError, busy, applyingTestConfiguration, imageEditorWork, restoring, running,
      checkpointRef, includeCode, textMode, typeDirectory, codeAssemblies, needsScan, preparingRescan, confirm, scanUpdate,
      setPreparingRescan, operation } = getOptions();
    if (importPreviewRef.current) { setActionError("请先应用或取消右侧的导入预览"); return; }
    if (isBenchmarkRunning() || busy || applyingTestConfiguration || imageEditorWork.current || restoring || running.current) return;
    const changedScanOptions = resume && checkpointRef.current?.step === 1
      ? unityScanOptionChanges(checkpointRef.current, { includeCode, textMode, typeDirectory, codeAssemblies }) : [];
    const rescan = (needsScan || updateScan || preparingRescan || changedScanOptions.length > 0) && (resume ? checkpointRef.current?.step ?? startStep : startStep) <= 2;
    if (rescan && !preparingRescan && !await confirm(`重新扫描将保留旧工程，复用原文、原图及定位匹配的译文、图片识别结果和译图；未安装补丁与字库检查会失效，已安装补丁及原件备份保留至再次应用。新工程及复用结果保存完成后清理可移除的旧工程。${scanUpdate.reasons.length ? "\n" + scanUpdate.reasons.join("\n") : ""}${endStep >= 2 ? "扫描完成后再继续翻译。" : ""}`, { title: needsScan ? "需要重新扫描" : "可选更新扫描", kind: "warning", okLabel: "重新扫描并继续", cancelLabel: "取消" })) return;
    setPreparingRescan(false);
    await operation("准备任务", () => runWorkflow(startStep, endStep, resume, automatic, rescan, part, preparingRescan, imageChain), true);
  }
  async function runWorkflow(startStep: number, endStep: number, resume = false, automatic = startStep < endStep, rescan = false, part?: UnityTranslationPart, preparedRescan = false, imageChain = false, deployment?: { parts: UnityTranslationPart[]; finishedParts: Set<UnityTranslationPart>; controller: AbortController }) {
    const {
      root, project, patch, checkpointRef, latest, taskWrites, projectWrites, elapsedOrigins,
      translationKind, llmModel, dialogueModel, nameModel, imageModel, imageReviewModel, engine, engineChoices,
      source, target, joinLines, wrapMode, textScreenModel, includeContext, skipTargetLanguage, onlySourceLanguage,
      lineMode, lineModel, imageOcrMode, imageVisionModel, imageLayoutModel, imageRedrawProfile, imageConcurrency,
      imageConfidenceThreshold, imageScreeningOptions, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters,
      picture, imagePart, imageTask, imageThreshold, imageMode, imageConfigurationCommit, textConfigurationCommit,
      retryFailureIds, textScreened, followProgress, dirty, settings, promptState, isTextReady, getExecution, logAction,
      publish, projectCheckpoint, remember, save, saveTranslation, loadProject, scan, exportPatch, applyPatch,
      setPatch, setFontPlan, setActiveStep, setImagePart, setBusy, setMessage, setTextScreened,
    } = getOptions();
    const controller = deployment?.controller ?? new AbortController(); abort.current = controller;
    let run: RunCheckpoint = resume && checkpointRef.current ? { ...checkpointRef.current, endStep } : {
      step: startStep, endStep, automatic, finished: false, imageOnly: startStep === 2 && (part ? part === "images" : automatic ? isTextReady() : imagePart), imageChain, imageScreeningOptions, imageOcrMode, imageVisionModel, imageLayoutModel, imageRedrawProfile, imageConcurrency, imageConfidenceThreshold,
      projectFolder: startStep === 1 && endStep === 1 ? "" : project?.folder || "", scanFolder: "", patchFolder: "", patch: startStep === 4 ? patch : null,
      previousProjectFolder: startStep === 1 && endStep === 1 ? checkpointRef.current?.previousProjectFolder || project?.folder : undefined,
      translationKind, llmModel, dialogueModel, nameModel, imageModel, imageReviewModel, engine, engines: engineChoices, source, target, joinLines, wrapMode, textScreenModel, includeContext, skipTargetLanguage, onlySourceLanguage, lineMode, lineModel, includeCode, fontPath, textMode, codeAssemblies, typeDirectory, extraCharacters, scopeVersion: 1,
      partial: !!project?.textSkipped || startStep >= 3 && !!checkpointRef.current?.partial,
      translationRuns: checkpointRef.current?.translationRuns,
      scanElapsedMs: startStep === 1 ? 0 : checkpointRef.current?.scanElapsedMs || 0,
      progress: { step: startStep, state: "running", detail: "准备处理", completed: 0, total: null },
    };
    if (automatic) run.automatic = true;
    if (resume && run.step === 1) run.source = source;
    if (part) run.imageOnly = part === "images";
    if (rescan) {
      run = { ...run, step: 1, imageOnly: !!run.imageChain || part === "images", projectFolder: "", scanFolder: "", previousProjectFolder: checkpointRef.current?.previousProjectFolder || project?.folder || checkpointRef.current?.projectFolder || checkpointRef.current?.scanFolder, source, includeCode, textMode, codeAssemblies, typeDirectory,
        translationFailure: run.progress.step === 2 && run.progress.state === "error" ? run.progress.failure : run.translationFailure,
        progress: { step: 1, state: "running", detail: "重新提取游戏组件文本，已有工程和译文保留", completed: 0, total: null } };
      run.scanElapsedMs = 0;
    }
    let lastReported = 0;
    const report = (progress: UnityProgress) => {
      const urgent = run.progress.step !== run.step || !!progress.folder && progress.folder !== (run.step === 1 ? run.scanFolder : run.patchFolder) || progress.total !== null && progress.completed === progress.total;
      if (progress.total === null && run.progress.step === run.step && run.progress.total !== null)
        progress = { ...progress, completed: run.progress.completed, total: run.progress.total };
      if (progress.folder) {
        if (run.step === 1) run.scanFolder = progress.folder;
        if (run.step === 3) run.patchFolder = progress.folder;
      }
      run = { ...run, progress: { ...progress, step: run.step, state: "running" } };
      checkpointRef.current = run;
      if (urgent || performance.now() - lastReported >= 100) { remember(run); lastReported = performance.now(); }
    };
    try {
      followProgress.current = !deployment;
      if (rescan && project && !preparedRescan) {
        if (dirty) await save();
        await taskWrites.current;
        await unityRun("reset-step", { root, step: 3, path: project.folder, task: { ...(checkpointRef.current || projectCheckpoint(project)), previousProjectFolder: undefined } });
        setPatch(null); setFontPlan(null);
        run.patch = null; run.patchFolder = "";
      }
      remember(run);
      let p = latest.current || project;
      for (let index = run.step; index <= endStep; index++) {
        if (followProgress.current) { setActiveStep(index); if (index === 2) setImagePart(!!run.imageOnly); }
        run.step = index; if (!deployment) setBusy(GENERATION_STEPS[index - 1]);
        if (index === 2) delete run.translationFailure;
        const onProgress = (progress: UnityProgress) => { if (run.step === index && !run.finished) report(progress); };
        report({ detail: `准备${GENERATION_STEPS[index - 1]}`, completed: 0, total: null });
        await taskWrites.current;
        if (controller.signal.aborted) throw new UnityPaused("");
        if (index === 1) {
          const reuse = run.projectFolder && !run.scanFolder && p;
          if (reuse) p = reuse;
          else {
            const started = performance.now(), elapsed = run.scanElapsedMs || 0;
            elapsedOrigins.current.scan = started - elapsed;
            remember(run);
            try { p = await scan(onProgress, controller.signal, run); }
            finally {
              delete elapsedOrigins.current.scan;
              run = { ...run, scanElapsedMs: elapsed + performance.now() - started };
              remember(run);
            }
          }
          const previousFolder = run.previousProjectFolder;
          run.projectFolder = p.folder; run.scanFolder = "";
          if (previousFolder && !sameUnityGamePath(previousFolder, p.folder)) {
            remember(run); await taskWrites.current;
            const reused = await unityRun<{ project: UnityProject; reusedText: number; reusedImages: number }>("finish-rescan", { root, path: previousFolder, task: { ...run, previousProjectFolder: undefined } }, onProgress);
            p = reused.project; publish(p); setMessage(`扫描完成：复用 ${reused.reusedText} 条译文和 ${reused.reusedImages} 张图片的处理结果`);
          }
          run.previousProjectFolder = undefined;
          if (reuse) report({ detail: `复用当前工程：${p.entries.length} 条文本，保留选取和已有译文`, completed: 1, total: 1 });
        } else if (index === 2) {
          if (!p) throw new Error("请先扫描当前游戏资源");
          await yieldUnityPreparation(controller.signal);
          const preparationScope = unityLanguageScope(p.entries, run.source, run.onlySourceLanguage !== false);
          const rows = p.entries.filter(entry => entry.selected && preparationScope.ids.has(entry.id));
          const live = unityTranslationReadiness(p, rows, unityTranslationError, false, run.target, picture.target);
          const textComplete = !run.layoutOnly && live.textReady;
          const screening = run.imageScreeningOptions ?? defaultUnityImageScreening;
          const imageComplete = live.imagesReady && !(p.images || []).some(image =>
            needsUnityImageScreening(image, picture.source, picture.target, screening) || unityImageRefinementPending(image, screening.refine) ||
            gameImageRedrawSelected(image));
          const initial = { text: p.textSkipped && !run.layoutOnly ? "skipped" : textComplete ? "done" : "pending", images: p.imagesSkipped ? "skipped" : imageComplete ? "done" : "pending" } as const;
          const oldParts = run.translationRuns;
          const requestedParts: UnityTranslationPart[] = deployment?.parts ??
            (automatic && !run.layoutOnly ? ["text", "images"] : [part || (run.imageOnly ? "images" : "text")]);
          run = { ...run, translationRuns: {
            text: !automatic && !requestedParts.includes("text") && oldParts?.text ? oldParts.text : { ...(oldParts?.text || run.progress), step: 2, state: initial.text, detail: textComplete ? "文本结果已保留" : "等待开始翻译文本" },
            images: !automatic && !requestedParts.includes("images") && oldParts?.images ? oldParts.images : { ...(oldParts?.images || { completed: 0, total: null }), step: 2, state: initial.images, detail: imageComplete ? "图片结果已保留" : "等待开始图片翻译" },
          }, progress: { step: 2, state: "running", completed: 0, total: null, detail: "文本和图片任务分别处理并保存" } };
          const partReported = { text: 0, images: 0 };
          const reportPart = (part: UnityTranslationPart, value: UnityProgress) => {
            const scope = promptState.scope + ":" + part;
            const phase = part === "text" ? value.textStage === "screening" ? "screen" : "translate" : run.imageTask || imageTask.current;
            const alreadyComplete = value.total === 0 && !!stepPerformance(scope,phase).endedAt;
            if (!alreadyComplete) beginGameStep(scope, phase);
            if (!alreadyComplete && value.translation)
              reportGameStepItems(scope, phase, value.translation.processed, value.translation.failed);
            else if (!alreadyComplete && value.total !== null && (part === "images" || phase === "screen"))
              reportGameStepItems(scope, phase, value.completed, value.redrawFailed);
            run = { ...run, translationRuns: { ...run.translationRuns!, [part]: { ...run.translationRuns![part], ...value,
              elapsedMs: run.translationRuns![part].elapsedMs, textStage: value.textStage, model: value.model,
              redrawFailed: value.redrawFailed, step: 2, state: "running" } } };
            checkpointRef.current = run;
            if (value.total !== null && value.completed === value.total || performance.now() - partReported[part] >= 100) { remember(run); partReported[part] = performance.now(); }
          };
          const jobs = createUnityTranslationJobs({
            signal: controller.signal, initial,
            changed: (part, state, failure) => {
              if (state === "done" || state === "skipped") completeGameStep(promptState.scope + ":" + part, part === "text" ? "translate" : run.imageTask || imageTask.current);
              const previous = run.translationRuns![part];
              run = { ...run, translationRuns: { ...run.translationRuns!, [part]: { ...previous, state, failure, detail: state === "stopped" ? "已中止，进度已保存" : state === "skipped" ? "已跳过剩余内容，已完成结果保留" : previous.detail } } }; remember(run);
            },
            run: async (part, job) => {
              const started = performance.now(), previousElapsed = run.translationRuns![part].elapsedMs || 0;
              elapsedOrigins.current[part] = started - previousElapsed;
              remember(run);
              try {
              const current = latest.current || p!;
              if (part === "images") {
                run.imageTask = resume && run.imageTask ? run.imageTask : imageTask.current;
                if (run.automatic || run.imageChain) {
                  const firstPhase = resume ? Math.max(0,unityImagePhases.indexOf(run.imageTask)) : 0;
                  await runImagePasses(unityImagePhases.slice(firstPhase), job.signal, {
                    hasRedrawTargets: () => !!(latest.current || current).images?.some(gameImageRedrawSelected),
                    beginPhase: phase => { run.imageTask = phase; imageTask.current = phase; remember(run); },
                    commitConfiguration: phase => imageConfigurationCommit.current?.(phase),
                    executePhase: () => {
                      const latestConfig = getExecution();
                      return latestConfig.translateImages(latest.current || current, job, { ...run, ...latestConfig.parameters }, value => reportPart(part, value));
                    },
                    completePhase: phase => completeGameStep(promptState.scope + ":images", phase),
                  });
                } else await getExecution().translateImages(current, job, { ...run, ...getExecution().parameters, imageConfidenceThreshold: imageThreshold.current, imageOcrMode: imageMode.current }, value => reportPart(part, value));
                return;
              }
              await runTextBranch(current, job, value => reportPart(part, value), {
                getRun: () => run, deployment: !!deployment, textScreened,
                commitConfiguration: stage => textConfigurationCommit.current?.(stage), getExecution,
                settings, logAction, saveTranslation: project => saveTranslation(project, "text"), setTextScreened,
                getCurrent: () => latest.current, screenGameText,
                takeRetryIds: () => { const ids = retryFailureIds.current; retryFailureIds.current = undefined; return ids; },
              });
              } finally {
                finishGameStep(promptState.scope + ":" + part);
                delete elapsedOrigins.current[part];
                run = { ...run, translationRuns: { ...run.translationRuns!, [part]: {
                  ...run.translationRuns![part], elapsedMs: previousElapsed + performance.now() - started,
                } } };
                remember(run);
              }
            },
          });
          translationJobs.current = jobs; remember(run);
          try { await jobs.wait(requestedParts); }
          finally {
            if (deployment) {
              for (const part of requestedParts) {
                const state = jobs.state(part);
                if (state === "done" || state === "skipped") deployment.finishedParts.add(part);
              }
            }
            translationJobs.current = null; await projectWrites.current;
          }
          p = latest.current || p;
          if (automatic && !unityTranslationReadiness(p, [], unityTranslationError, false, run.target, picture.target).imagesReady) {
            run.endStep = 2; run.automatic = false; run.progress = { ...run.progress, step: 2, state: "done", detail: "图片识别结果已保存" };
            if (followProgress.current) { setActiveStep(2); setImagePart(true); }
            break;
          }
        } else if (index === 3) {
          if (!p) throw new Error("请先扫描当前游戏资源");
          const result = await exportPatch(p, onProgress, controller.signal, run);
          run.patch = result; run.patchFolder = result.folder;
        } else {
          if (!run.patch) throw new Error("请先生成补丁");
          await applyPatch(run.patch, onProgress, controller.signal);
        }
        if (controller.signal.aborted) throw new UnityPaused("");
        if (followProgress.current) {
          if (index === 2 && (run.imageOnly || (!run.layoutOnly && !automatic && !unityTranslationReadiness(p, [], unityTranslationError, false, run.target, picture.target).imagesReady))) {
            setActiveStep(2);
            setImagePart(true);
          } else setActiveStep(run.layoutOnly ? 2 : Math.min(index + 1, GENERATION_STEPS.length));
        }
        if (index < endStep) { run.step = index + 1; run.progress = { step: index + 1, state: "running", detail: "等待开始下一步", completed: 0, total: null }; remember(run); }
      }
      run.finished = true; run.progress = { ...run.progress, state: "done" }; remember(run);
    } catch (e) {
      if (deployment) throw e;
      const paused = e instanceof UnityPaused ? e : e instanceof UnityTranslationStopped ? new UnityPaused("") : null;
      if (paused || controller.signal.aborted) {
        if (paused?.folder) {
          if (run.step === 1) { run.scanFolder = paused.folder; run.projectFolder = paused.folder; }
          if (run.step === 3) run.patchFolder = paused.folder;
        }
        run.progress = { ...run.progress, state: "stopped", detail: "处理已中止，检查点已保存" }; remember(run);
        if (run.step === 1 && run.scanFolder) publish(await loadProject(run.scanFolder, run.previousProjectFolder));
        setMessage(run.step === 4 ? "应用已中止，部分文件可能已写入。请勿启动游戏，恢复后继续应用。原件备份已保留。" : "任务已中止，检查点已保存，点击恢复继续未完成部分。");
      } else { run.progress = { ...run.progress, state: "error", failure: e instanceof Error ? e.message : String(e) }; remember(run); throw e; }
    } finally { abort.current = null; await taskWrites.current; }
  }
  const startTranslationPart = (part: UnityTranslationPart, phase?: UnityImagePhase) => {
    const { mosaicBusy, setLocalActivity, logAction, imageTask, imageEditorWork, checkpoint } = getOptions();
    if (mosaicBusy) return;
    setLocalActivity(null); logAction(part === "text" ? "开始翻译文本" : "开始" + unityImagePhaseNames[phase || imageTask.current]);
    if(part==="images"&&imageEditorWork.current)return;
    if (phase) imageTask.current = phase;
    const jobs = translationJobs.current;
    if (jobs) { jobs.start(part, part === "images" && !!phase); return; }
    void startWorkflow(2, checkpoint?.automatic && !checkpoint.finished ? checkpoint.endStep : 2, !!checkpoint && !checkpoint.finished, !!checkpoint?.automatic && !checkpoint.finished, false, part);
  };
  const stop = () => {
    const { logAction, imageEditorAbort, setMessage } = getOptions();
    logAction("请求中止当前任务", "warning");
    abort.current?.abort();imageEditorAbort.current?.abort();
    setMessage("正在中止，完成当前文件的安全写入并保存检查点后停止，请勿退出或启动游戏。");
  };
  const stopPart = (part: UnityTranslationPart) => {
    const { setMessage } = getOptions();
    translationJobs.current?.stop(part);
    setMessage(part === "images" ? "正在中止图片处理，已保存的结果会保留。" : "正在中止文本处理，已保存的结果会保留。");
  };
  const resumeTask = () => {
    const { checkpoint } = getOptions();
    return checkpoint && void startWorkflow(checkpoint.step, checkpoint.endStep, true, checkpoint.automatic);
  };

  return { translationJobs, abort, startWorkflow, runWorkflow, startTranslationPart, stop, stopPart, resumeTask };
}
