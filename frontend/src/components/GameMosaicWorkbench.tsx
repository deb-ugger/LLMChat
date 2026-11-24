import { formatMosaicParameters, type BenchmarkParameter } from "../benchmark/benchmarkParameters";
import { archiveFormalMosaicImages } from "../benchmark/formalRunHistory";
import { benchmarkImageInput, type ImageBenchmarkInput, type ImageBenchmarkOutcome } from "../benchmark/imageBenchmarkHistory";
import { publishMosaicBenchmarkSource } from "../gameMosaicBenchmark";
import { mosaicInitialScreening, mosaicManualStatuses, mosaicProcessingError, mosaicScreeningStatus, mosaicStatusChoices, mosaicStatusLabels, mosaicStatusOrder, type MosaicStatus } from "../gameMosaicStatus";
import { api } from "../api";
import { prepareMosaicReviewModel, requestGameModelJson } from "../gameModelRequest";
import { gameAvailableModels } from "./GameTranslationTabs";
import { refineMosaicBatch, mosaicReviewKey, matchesMosaicReviewKey, mergeMosaicErrorUpdates, mosaicErrorUpdateEvent, writeMosaicRows, readMosaicRows, readMosaicReviews, savedMosaicScan, clearMosaicReviews, type MosaicErrorUpdate } from "../gameMosaicRefine";
import { createContext, useContext, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "../api";
import { beginGameStep, clearGamePerformance, finishFormalGameStep, finishGameStep, recordGameCacheHit, recordGameRequest, gameStepSelections, measureGameAsync, reportGameStepItems, stepPerformance, sumModelServiceTiming, type FormalRunSummary, type StepPerformance } from "../gameModelPerformance";
import { cancelMosaicRedraw, mosaicRefineConcurrency, readMosaicSettings, saveMosaicSettings, clearGameDetectorFile, gameDetectorFile, openDeploymentDetector, loadMosaicDetector, matchesMosaicDetectorKey, mosaicDetectorKey, mosaicInputKey, mosaicModelLabels, redrawMosaic, createMosaicGridScanner, openMosaicComfyWorkflowEvent, prepareMosaicComfyWorkflow, type MosaicModel } from "../gameMosaic";
import type { UnityImage } from "../unityOffline";
import { deploymentMetricScope, measureDeploymentStage } from "../unityWorkflow";
import { showAppNotice } from "./AppNotice";
import { registerAppCloseGuard } from "../appClose";
import { useGameActionConfirm } from "./GameActionConfirm";
import { usePersistedModelFilter } from "./ModelFilterSelect";
import { benchmarkBlockingReason, isBenchmarkRunning, useBenchmarkProgress, useBenchmarkRunning, useFormalWorkflowActivity } from "../benchmark/benchmarkRunner";
import { allGameImageFilters, gameImageFilterMatch, type GameImageFilters } from "./GameImageBrowserLayout";
import { type GameProgressState } from "./GameStepProgress";
import { SearchHighlight } from "./SearchHighlight";
import { UnityDescriptionSelect } from "./UnityDescriptionSelect";
import { getFixedMenuPoint } from "../viewportLayout";
import { MosaicGroupTree, mosaicGroupCollapsed, mosaicGroupPageSize, type MosaicListGroup, type MosaicListView } from "./game-mosaic/MosaicGroupTree";
import { MosaicImageBadges } from "./game-mosaic/MosaicImageBadges";
import { MosaicOriginalGallery, mosaicGalleryPageSize } from "./game-mosaic/MosaicOriginalGallery";
import { assignMosaicRedrawReference, canResumeMosaicRedraw, clearReviewResult, defaultResult, keepText, performMosaicReviews, refineMovementFor,
  existingMosaicRedrawReferences, mosaicRedrawReferences, mosaicRedrawStyle, mosaicRedrawStepCount, restoreDefaultSelection, resultFor, reviewedResult, runAutomaticMosaic, runMosaicBatch, runMosaicRedraw, runMosaicRefine,
  runMosaicScreen, sameReview, stopMosaicBatch } from "./game-mosaic/mosaicBatchRunner";
import { MosaicStepCards } from "./game-mosaic/MosaicStepCards";
import { MosaicPreview } from "./game-mosaic/MosaicPreview";
import { clearMosaicRedrawArchive, readMosaicRedrawArchive, restoreMosaicRedrawPlan,
  writeMosaicRedrawCandidates, writeMosaicRedrawPlan } from "./game-mosaic/mosaicRedrawArchive";
import { confirmationBoxes, saveGameImageConfirmation, supportsGameImageConfirmation, useImageConfirmationNotice } from "../gameImageConfirmation";
import { useMosaicMasks } from "./game-mosaic/useMosaicMasks";
import { applyMosaicDrafts, discardMosaicDraft, hasMosaicDrafts, mosaicDraftSavedEvent, mosaicDraftsOf, notifyMosaicAdoptionChanged,
  registerMosaicRows, saveMosaicDrafts, stageMosaicEdits,
  useMosaicDrafts, type MosaicDraftSaved } from "./game-mosaic/mosaicDrafts";
import type { ImagePreview, MosaicMaskCommit, MosaicCandidate, MosaicGroupMenu, MosaicStep, MosaicWorkbenchProps as Props, RedrawPlan,
  MosaicBatchStep, MosaicBatchWork, MosaicReviewMetrics, MosaicReviewSession, MosaicStepUsage, Result, Results, StepRun } from "./game-mosaic/mosaicWorkbenchTypes";
import "../gameMosaic.css";

function groupMosaicModels(snapshot: StepPerformance): StepPerformance {
  const models = new Map<string, StepPerformance["models"][string]>();
  for (const row of Object.values(snapshot.models)) {
    const previous = models.get(row.model);
    models.set(row.model, previous ? {
      model: row.model,
      concurrency: Math.max(previous.concurrency, row.concurrency),
      tokens: previous.tokens + row.tokens,
      requests: previous.requests + row.requests,
      requestMs: previous.requestMs + row.requestMs,
      generationTokens: previous.generationTokens + row.generationTokens,
      generationMs: previous.generationMs + row.generationMs,
      serviceTiming: sumModelServiceTiming(previous.serviceTiming, row.serviceTiming),
    } : { ...row });
  }
  return { ...snapshot, models: Object.fromEntries(models) };
}

function mosaicMetricScope(gamePath: string, step: MosaicStep) {
  return gamePath + ":mosaic:" + step;
}

function mosaicCardMetrics(gamePath: string, step: MosaicStep): StepPerformance {
  const local = stepPerformance(mosaicMetricScope(gamePath, step), step);
  if (step !== "refine" || local.started !== undefined) return local;

  const deployment = stepPerformance(deploymentMetricScope(gamePath, "mosaic"), "mosaic");
  if (!Object.keys(deployment.models).length) return local;
  const localTime = local.endedAt ?? local.beginTime ?? "";
  const deploymentTime = deployment.endedAt ?? deployment.beginTime ?? "";
  return !local.taskId || deployment.started !== undefined || deploymentTime > localTime ? deployment : local;
}

function resumableMosaicMetrics(gamePath: string, step: MosaicStep, resume: boolean) {
  if (!resume) return undefined;
  const previous = stepPerformance(mosaicMetricScope(gamePath,step),step);
  return previous.taskId && !previous.endedAt ? previous : undefined;
}

function beginMosaicStepUsage(gamePath: string, step: MosaicStep, resume: boolean, refresh = () => {},
  run?: { summary: string; total: number; parameters?: readonly BenchmarkParameter[]; samples: readonly ImageBenchmarkInput[] }): MosaicStepUsage {
  const scope = mosaicMetricScope(gamePath,step);
  const previous = resumableMosaicMetrics(gamePath,step,resume);
  if (!previous) clearGamePerformance(scope,[step]);
  beginGameStep(scope, step);
  const taskId = stepPerformance(scope, step).taskId;
  const outcomes = new Map<string, ImageBenchmarkOutcome>();
  return {
    scope,
    snapshot: () => groupMosaicModels(stepPerformance(scope, step)),
    recordItems: (itemsDone: number, failures?: number) => reportGameStepItems(scope, step,
      (previous?.itemsDone ?? 0) + itemsDone, failures === undefined ? undefined : (previous?.failures ?? 0) + failures),
    async measure<T>(model: string, concurrency: number, work: () => Promise<T>) {
      const started = performance.now();
      try { return await measureGameAsync(scope, "processingMs", work); }
      finally {
        recordGameRequest({ performanceScope: scope, performanceStep: step, llmConcurrency: concurrency }, model, 0, performance.now() - started);
      }
    },
    refresh,
    recordImage: run ? (id, outcome) => outcomes.set(id, outcome) : undefined,
    async finish(completed, failed, detail) {
      if (!run) { finishGameStep(scope, completed); return; }
      finishGameStep(scope);
      const formal: FormalRunSummary = {
        label: run.summary, total: run.total, status: completed ? "完成" : failed ? "失败" : "已暂停",
        parameters: run.parameters, detail,
      };
      if (taskId && run.samples.length) {
        try {
          Object.assign(formal, await archiveFormalMosaicImages(taskId, run.samples, outcomes, !!previous?.formalRun?.imageDetails),
            { imageDetails: true });
        } catch (error) {
          const message = "逐图归档保存失败：" + String(error);
          formal.detail = [detail, message].filter(Boolean).join("\n");
          showAppNotice(message, "error");
        }
      }
      finishFormalGameStep(scope, step, formal);
    },
  };
}
export const GameMosaicCompletionContext = createContext<((completed: boolean) => void) | null>(null);

export type { GameMosaicDeploymentHandle, MosaicCandidateIndex } from "./game-mosaic/mosaicWorkbenchTypes";

function mosaicStatus(row: Result, included: boolean): MosaicStatus {
  if (row.manualStatus && !row.saved) return row.manualStatus;
  const state = mosaicScreeningStatus(row);
  return state === "failed" || !row.saved ? state : included ? "included" : "confirmed";
}
const mosaicFilterPhase = (row: Result) => row.manualStatus === "failed" || mosaicProcessingError(row)
  ? "failed" : row.saved ? "done" : "pending";

const pictureGroupKey = (row: Result) => "picture:" + (row.group || "");
const detectorLabels = { grid: "方格规则", anime: "高召回初筛（分类＋定位）" };
function editedCandidates(candidates: Record<string, MosaicCandidate>, rows: Results, drafts: MosaicDraftSaved["drafts"]) {
  if (!drafts.size) return candidates;
  let next = candidates;
  for (const [id, edit] of drafts) {
    if (!edit.candidate || rows[id]?.source !== edit.base.source) continue;
    if (next === candidates) next = { ...candidates };
    if (edit.candidate.value) next[id] = edit.candidate.value; else delete next[id];
  }
  return next;
}
function isIndependentGroup(key: string | undefined) {
  return !!key && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(key);
}

function dissolveIndependentGroup(rows: Results, key: string): Results {
  if (!isIndependentGroup(key)) return rows;
  let next = rows;
  for (const [id, row] of Object.entries(rows)) {
    if (row.group !== key) continue;
    if (next === rows) next = { ...rows };
    next[id] = { ...row, group: undefined, manualGroup: undefined, reference: undefined };
  }
  return next;
}

async function mosaicResponse(response: Response) {
  if (!response.ok) throw new Error((await response.json()).error || "图片去码操作失败");
  return response;
}

async function readSavedMosaicSources(gamePath: string, signal: AbortSignal): Promise<Record<string, string>> {
  const response = await mosaicResponse(await fetch(API_BASE + "/api/game-images/mosaic-status", {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gamePath }),
  }));
  const { candidates } = await response.json() as { candidates: Record<string, string> };
  return candidates;
}

export function GameMosaicWorkbench({ settings, gamePath, images, backupMode, storage, read, prepareSources, controls, visible: paneVisible = true, disabled = false, onBusy, deploymentHandle, packageOnly = false, onDeploymentSelectionChange }: Props & { packageOnly?: boolean; onDeploymentSelectionChange?: (ids: string[]) => void }) {
  const task = useRef<AbortController | null>(null);
  const onCompletionChange = useContext(GameMosaicCompletionContext);
  const [rows, setRows] = useState<Results>(() => {
    try {
      const saved = readMosaicRows<Result>(gamePath);
      for (const id of Object.keys(saved)) saved[id] = restoreDefaultSelection(saved[id]);
      return saved;
    } catch { return {}; }
  });
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const writtenRows = useRef(rows);
  useLayoutEffect(() => registerMosaicRows(gamePath, () => latestRows.current), [gamePath]);
  const drafts = useMosaicDrafts(gamePath);
  const draftRows = useMemo(() => applyMosaicDrafts(rows, drafts), [rows, drafts]);
  const draftReason = drafts.size ? "请先点击右上角保存去码修改" : undefined;
  useLayoutEffect(() => {
    publishMosaicBenchmarkSource(gamePath,rows);
  }, [gamePath,rows]);
  useLayoutEffect(() => () => publishMosaicBenchmarkSource(gamePath),[gamePath]);
  useEffect(() => {
    const onErrors = (event: Event) => {
      const { root, updates } = (event as CustomEvent<{ root: string; updates: readonly MosaicErrorUpdate[] }>).detail;
      if (root !== gamePath) return;
      setRows(previous => mergeMosaicErrorUpdates(previous, updates));
    };
    window.addEventListener(mosaicErrorUpdateEvent, onErrors);
    return () => window.removeEventListener(mosaicErrorUpdateEvent, onErrors);
  }, [gamePath]);
  useEffect(() => {
    if (!storage) return;
    setRows(previous => {
      const next = { ...previous };
      for (const image of images) {
        const entry = storage.index[image.id];
        const row = resultFor(previous, image);
        const freshDraft = entry?.source === image.sourceHash && storage.savedDrafts?.has(image.id);
        const discardedHash = freshDraft ? undefined : row.discardedHash;
        const saved = entry?.source === image.sourceHash && (entry.included ||
          entry.hash !== discardedHash && entry.source !== discardedHash);
        if (saved !== !!row.saved || discardedHash !== row.discardedHash)
          next[image.id] = { ...row, saved, discardedHash, checked: row.manualChecked ? row.checked : saved || row.checked };
      }
      return next;
    });
    if (storage.savedDrafts) storage.consumeSavedDrafts?.();
  }, [images, storage?.index, storage?.savedDrafts]);
  const [query, setQuery] = useState("");
  const [groupPages, setGroupPages] = useState<Partial<Record<string, number>>>({});
  const [collapsed, setCollapsed] = useState<Partial<Record<string, boolean>>>(() =>
    Object.fromEntries(mosaicStatusOrder.map(id => [id, id !== "failed"])));
  const listId = useId();
  const filterMenu = useRef<HTMLDivElement>(null);
  const [groupMenu, setGroupMenu] = useState<MosaicGroupMenu | null>(null);
  const closeGroupMenu = useCallback(() => setGroupMenu(null), []);
  const [preferences, setPreferences] = useState(() => readMosaicSettings(gamePath));
  const { scope, detector: detectorKind, model, steps, protect } = preferences;
  const changePreferences = (patch: Partial<typeof preferences>) => {
    if (task.current || disabled || isBenchmarkRunning()) return;
    saveMosaicSettings(gamePath, { ...preferences, ...patch });
  };
  useEffect(() => {
    const refresh = () => setPreferences(readMosaicSettings(gamePath));
    refresh(); window.addEventListener("game-mosaic-settings", refresh);
    return () => window.removeEventListener("game-mosaic-settings", refresh);
  }, [gamePath]);
  const [detectorFile, setDetectorFile] = useState(() => gameDetectorFile(gamePath));
  const [imageFilters, setImageFilters] = useState(allGameImageFilters);
  const failuresOnly = imageFilters.failed && !imageFilters.pending && !imageFilters.done;
  const [activeId, setActiveId] = useState("");
  const [listView, setListView] = useState<MosaicListView>("status");
  const [galleryPage, setGalleryPage] = useState(0);
  const [gallerySelectedIds, setGallerySelectedIds] = useState(() => new Set<string>());
  const galleryNavigation = useRef<((event: ReactKeyboardEvent<HTMLElement>) => void) | null>(null);
  const [busy, setBusy] = useState("");
  const [progressStep, setProgressStep] = useState<MosaicStep>();
  const [stepRuns, setStepRuns] = useState<Partial<Record<MosaicStep, StepRun>>>({});
  const pendingRedraw = useRef<RedrawPlan | null>(null);
  const redrawTask = useRef<Promise<void> | undefined>(undefined);
  const redrawCancelRequested = useRef(false);
  const [redrawCancelling, setRedrawCancelling] = useState(false);
  const redrawPromptKey = "llmchat-mosaic-active-prompt:" + gamePath;
  const lastReview = useRef<MosaicReviewSession | null>(null);
  const [refineRetries, setRefineRetries] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [, refreshElapsed] = useState(0);
  const [{ text: progress, step: statusLineStep }, setStatusLine] = useState<{ text: string; step?: MosaicStep }>({ text: "" });
  const setProgress = useCallback((text: string, step?: MosaicStep) => setStatusLine({ text, step }), []);
  const [error, setError] = useState("");
  const [source, setSource] = useState<ImagePreview>();
  const [approved, setApproved] = useState<ImagePreview>();
  const [candidates, setCandidateRows] = useState<Record<string, MosaicCandidate>>({});
  const candidateRows = useRef(candidates);
  const updateCandidates = useCallback((next: Record<string, MosaicCandidate>) => {
    candidateRows.current = next;
    setCandidateRows(next);
  }, []);
  const [preferredResult, setPreferredResult] = useState<string>();
  const [archiveState, setArchiveState] = useState<{ gamePath: string; error?: string }>();
  const archiveReason = archiveState?.gamePath === gamePath ? archiveState.error : "正在读取重绘记录";
  const archiveWrites = useRef(Promise.resolve());
  const enqueueArchiveWrite = useCallback((write: () => Promise<void>) => {
    const next = archiveWrites.current.then(write);
    archiveWrites.current = next.catch(() => {});
    return next;
  }, []);
  useEffect(() => {
    let active = true;
    let unregister: (() => void) | undefined;
    void registerAppCloseGuard(async () => {
      await archiveWrites.current;
      return true;
    }).then(remove => { if (active) unregister = remove; else remove(); }).catch(console.error);
    return () => { active = false; unregister?.(); };
  }, []);
  const reportArchiveError = (error: unknown) => showAppNotice("无法保存重绘记录：" + String(error), "error");
  const storePendingRedraw = async (plan: RedrawPlan | null) => {
    await enqueueArchiveWrite(() => writeMosaicRedrawPlan(gamePath, plan));
    pendingRedraw.current = plan;
  };
  useEffect(() => {
    let active = true;
    pendingRedraw.current = null;
    updateCandidates({});
    void readMosaicRedrawArchive(gamePath).then(archive => {
      if (!active) return;
      updateCandidates(archive.candidates);
      const plan = restoreMosaicRedrawPlan(archive.plan, archive.candidates);
      pendingRedraw.current = plan;
      setStepRuns(previous => ({ ...previous, redraw: plan ? {
        state: "stopped", total: plan.targets.length, completed: plan.targets.filter(target => !target.pending.size).length,
        summary: plan.models.map(model => mosaicModelLabels[model]).join("、"),
      } : undefined }));
      setArchiveState({ gamePath });
    }).catch(error => {
      if (active) setArchiveState({ gamePath, error: "无法读取重绘记录：" + String(error) });
    });
    return () => { active = false; };
  }, [gamePath, updateCandidates]);
  const confirmation = useGameActionConfirm(() => {});
  const usable = useMemo(() => images.filter(image => image.sourceFile && image.width > 0 && image.height > 0)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), [images]);
  useEffect(() => () => onCompletionChange?.(false), [onCompletionChange]);
  const scenes = useMemo(() => {
    const files = usable.filter(image => /(?:^|[\\/])img[\\/]pictures[\\/]/i.test(image.file));
    return files.length ? files : usable;
  }, [usable]);
  const scoped = scope === "scenes" ? scenes : usable;
  useEffect(() => {
    if (!onCompletionChange) return;
    onCompletionChange(scoped.length > 0 && scoped.every(image => {
      const row = resultFor(rows, image);
      return row.manualChecked && !row.checked || !mosaicProcessingError(row) && (
        row.saved && (!storage || !!storage.index[image.id]?.included) ||
        (row.scanned || row.refined) && (!row.checked || !!row.refined && !row.refineQuickExcluded) && !row.boxes.length && !row.review
      );
    }));
  }, [onCompletionChange, rows, scoped, storage?.index]);
  const needle = query.trim().toLowerCase();
  const currentScope = useMemo(() => needle ? scoped.filter(image => (image.name + " " + image.file).toLowerCase().includes(needle)) : scoped, [needle, scoped]);
  const imageGroup = useMemo(() => {
    const grouped = new Map<string, UnityImage[]>();
    for (const image of usable) {
      const key = resultFor(rows, image).group || image.id;
      const listed = grouped.get(key);
      if (listed) listed.push(image); else grouped.set(key, [image]);
    }
    return grouped;
  }, [rows, usable]);
  const imageStatus = useCallback((image: UnityImage) => mosaicStatus(resultFor(rows, image),
    !!storage?.index[image.id]?.included), [rows, storage?.index]);
  const isRefineRetrying = (image: UnityImage) => refineRetries.get(image.id) === image.sourceHash;
  const visible = useMemo(() => Object.values(imageFilters).every(Boolean) ? currentScope : currentScope.filter(image => {
    const row = resultFor(rows, image);
    return gameImageFilterMatch(imageFilters, row.checked, mosaicFilterPhase(row));
  }), [currentScope, imageFilters, rows]);
  const groups = useMemo(() => {
    const groups = new Map<string, MosaicListGroup>();
    if (listView === "picture") {
      const ungrouped: UnityImage[] = [];
      for (const image of visible) {
        const row = resultFor(rows, image);
        if (!row.group) { ungrouped.push(image); continue; }
        const key = pictureGroupKey(row);
        const group = groups.get(key);
        if (group) group.items.push(image);
        else groups.set(key, { items: [image], label: imageGroup.get(row.group)?.[0].name ?? image.name, pictureGroup: row.group });
      }
      if (ungrouped.length) groups.set("picture:", { items: ungrouped, label: "未分组 · 各自重绘" });
      return groups;
    }
    const grouped = new Map<MosaicStatus, UnityImage[]>();
    for (const image of visible) {
      const status = imageStatus(image);
      const list = grouped.get(status);
      if (list) list.push(image);
      else grouped.set(status, [image]);
    }
    for (const status of mosaicStatusOrder) {
      const images = grouped.get(status);
      if (!images?.length) continue;
      if (status === "review") {
        const priority = (image: UnityImage) => {
          const row = resultFor(rows, image);
          return row.boxes.length ? (mosaicInitialScreening(row).boxes.length ? 0 : 1) : 2;
        };
        images.sort((a, b) => priority(a) - priority(b));
      }
      groups.set(status, { items: images, label: mosaicStatusLabels[status], status });
    }
    return groups;
  }, [visible, imageStatus, imageGroup, rows, listView]);
  const ordered = useMemo(() => [...groups].filter(([id]) => !mosaicGroupCollapsed(collapsed, id))
    .flatMap(([id, group]) => group.items.map(image => ({ id, image }))), [groups, collapsed]);
  const refineChanges = useMemo(() => {
    const changes = new Map<MosaicStatus, { added: number; removed: number }>();
    for (const image of currentScope) {
      const row = resultFor(rows,image);
      const movement = refineMovementFor(row);
      if (!movement || movement.from === movement.to) continue;
      const from = changes.get(movement.from) ?? { added:0, removed:0 };
      from.removed++;
      changes.set(movement.from,from);
      const to = changes.get(movement.to) ?? { added:0, removed:0 };
      to.added++;
      changes.set(movement.to,to);
    }
    return changes;
  }, [currentScope, rows]);
  const active = currentScope.find(image => image.id === activeId) ?? ordered[0]?.image;
  useLayoutEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);
  const previewedImage = useRef(active);
  previewedImage.current = active;
  useLayoutEffect(() => {
    const onSave = (event: Event) => {
      const { root, changes, drafts } = (event as CustomEvent<MosaicDraftSaved>).detail;
      if (root !== gamePath) return;
      const nextRows = { ...latestRows.current, ...changes };
      const nextActive = previewedImage.current;
      if (nextActive) {
        const before = imageStatus(nextActive);
        const after = mosaicStatus(resultFor(nextRows, nextActive), !!storage?.index[nextActive.id]?.included);
        if (before !== after) {
          setCollapsed(previous => ({ ...previous, [after]: false }));
          const index = currentScope.filter(image => {
            const row = resultFor(nextRows, image);
            return gameImageFilterMatch(imageFilters, row.checked, mosaicFilterPhase(row)) &&
              mosaicStatus(row, !!storage?.index[image.id]?.included) === after;
          }).findIndex(image => image.id === nextActive.id);
          if (index >= 0) setGroupPages(previous => ({ ...previous, [after]: Math.floor(index / mosaicGroupPageSize) }));
        }
      }
      latestRows.current = nextRows;
      writtenRows.current = nextRows;
      setRows(nextRows);
      const previous = candidateRows.current;
      const nextCandidates = editedCandidates(previous, nextRows, drafts);
      if (nextCandidates !== previous) {
        const changed = [...drafts.keys()].flatMap(id =>
          previous[id] === nextCandidates[id] ? [] : [[id, nextCandidates[id]] as const]);
        updateCandidates(nextCandidates);
        void enqueueArchiveWrite(() => writeMosaicRedrawCandidates(gamePath, changed)).catch(reportArchiveError);
      }
    };
    window.addEventListener(mosaicDraftSavedEvent, onSave);
    return () => window.removeEventListener(mosaicDraftSavedEvent, onSave);
  }, [gamePath, imageStatus, currentScope, imageFilters, storage?.index, enqueueArchiveWrite, updateCandidates]);

  const isPreviewing = (image: UnityImage) => previewedImage.current?.id === image.id && previewedImage.current.sourceHash === image.sourceHash;
  const activeResult = active && resultFor(draftRows, active);
  const committedResult = active && resultFor(rows, active);
  const draftCandidates = useMemo(() => editedCandidates(candidates, draftRows, drafts), [candidates, draftRows, drafts]);
  const group = active && (committedResult?.group || active.id);
  const members = group ? imageGroup.get(group) || [] : [];
  const redrawReferences = useMemo(() => mosaicRedrawReferences(usable, rows), [usable, rows]);
  const reference = group ? redrawReferences.get(group) : undefined;
  const existingRedraw = useMemo(() => existingMosaicRedrawReferences(usable, rows, candidates, model),
    [usable, rows, candidates, model]);
  const draftReference = members.find(image => resultFor(draftRows, image).reference && resultFor(draftRows, image).saved);
  const actionsDisabled = !!busy || disabled || redrawCancelling;
  const masks = useMosaicMasks({ gamePath, active, activeResult, members, usable, rows: draftRows, candidates: draftCandidates,
    getRows: () => applyMosaicDrafts(latestRows.current, mosaicDraftsOf(gamePath)), blocked: () => !!task.current || disabled,
    actionsDisabled, commit: commitMaskEdits });

  function selectPreview(id: string) {
    setActiveId(id);
    if (!busy && !disabled) setError("");
  }

  function switchListView(next: MosaicListView) {
    if (next === listView) return;
    setListView(next);
    if (next === "picture" && active) {
      const key = pictureGroupKey(resultFor(rows, active));
      const index = visible.filter(image => pictureGroupKey(resultFor(rows, image)) === key).indexOf(active);
      if (index >= 0) {
        setCollapsed(previous => ({ ...previous, [key]: false }));
        setGroupPages(previous => ({ ...previous, [key]: Math.floor(index / mosaicGroupPageSize) }));
      }
    }
    setGalleryPage(0);
    setGallerySelectedIds(new Set());
  }

  function getViewerNeighbors() {
    if (listView !== "browse") {
      const index = ordered.findIndex(item => item.image.id === active?.id);
      if (index >= 0) return { previous: ordered[index - 1]?.image, next: ordered[index + 1]?.image };
    }
    const index = visible.findIndex(image => image.id === active?.id);
    return { previous: index > 0 ? visible[index - 1] : undefined, next: index >= 0 ? visible[index + 1] : undefined };
  }

  function selectViewerImage(image: UnityImage) {
    if (listView === "browse") {
      const index = visible.findIndex(item => item.id === image.id);
      if (index >= 0) setGalleryPage(Math.floor(index / mosaicGalleryPageSize));
      setGallerySelectedIds(new Set([image.id]));
    } else {
      const key = listView === "picture" ? pictureGroupKey(resultFor(rows, image)) : imageStatus(image);
      const local = groups.get(key)?.items.findIndex(item => item.id === image.id) ?? -1;
      if (local >= 0) {
        setGroupPages(previous => ({ ...previous, [key]: Math.floor(local / mosaicGroupPageSize) }));
        setCollapsed(previous => mosaicGroupCollapsed(previous, key) ? { ...previous, [key]: false } : previous);
      }
    }
    selectPreview(image.id);
  }

  const selected = members.filter(image => resultFor(rows, image).checked);
  const saved = selected.filter(image => resultFor(rows, image).saved);
  const included = saved.filter(image => storage?.index[image.id]?.included);
  const activeSaved = !!committedResult?.saved;
  const activeIsReference = !!active && draftReference?.id === active.id;
  const withdrawalStaged = activeSaved && activeResult?.saved === false;
  const confirmationNotice = useImageConfirmationNotice(gamePath, active, "mosaic", activeSaved && !storage && !busy);
  const counts = useMemo(() => visible.reduce((total, image) => {
    const row = resultFor(rows, image);
    if (resultFor(draftRows, image).checked) total.checked++;
    if (row.saved && !storage?.index[image.id]?.included) total.saved++;
    return total;
  }, { checked: 0, saved: 0 }), [visible, rows, draftRows, storage?.index]);

  useEffect(() => () => { task.current?.abort(); onBusy?.(false); }, [onBusy]);
  useEffect(() => {
    if (!disabled) return;
    masks.resetDrawing();
  }, [disabled, masks.resetDrawing]);
  useEffect(() => {
    if (!paneVisible) filterMenu.current?.hidePopover();
  }, [paneVisible]);
  useEffect(() => {
    if (!paneVisible) return;
    const timer = busy && progressStep ? window.setInterval(() => refreshElapsed(value => value + 1), 1000) : undefined;
    let frame: number | undefined;
    const refresh = () => {
      frame ??= window.requestAnimationFrame(() => {
        frame = undefined;
        refreshElapsed(value => value + 1);
      });
    };
    window.addEventListener("llmchat-game-performance",refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("llmchat-game-performance",refresh);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [paneVisible, busy, progressStep]);
  useEffect(() => {
    if (writtenRows.current === rows) return;
    try {
      writeMosaicRows(gamePath, rows);
      writtenRows.current = rows;
    }
    catch { showAppNotice("无法保存图片去码筛选记录", "error"); }
  }, [gamePath, rows]);

  function replaceRows(next: Results) {
    writeMosaicRows(gamePath, next);
    writtenRows.current = next;
    setRows(next);
  }

  function resetDerivedRedraw(ids: ReadonlySet<string>) {
    const redraw = pendingRedraw.current;
    const affected = !!redraw?.targets.some(({ image }) => ids.has(image.id)) ||
      Object.keys(candidates).some(id => ids.has(id));
    if (redraw) {
      const targets = redraw.targets.filter(({ image }) => !ids.has(image.id));
      const next = targets.length ? { ...redraw, targets } : null;
      pendingRedraw.current = next;
      void enqueueArchiveWrite(() => writeMosaicRedrawPlan(gamePath, next)).catch(reportArchiveError);
    }
    const previous = candidateRows.current;
    const removed = [...ids].filter(id => !!previous[id]).map(id => [id, undefined] as const);
    if (removed.length) {
      updateCandidates(Object.fromEntries(Object.entries(previous).filter(([id]) => !ids.has(id))));
      void enqueueArchiveWrite(() => writeMosaicRedrawCandidates(gamePath, removed)).catch(reportArchiveError);
    }
    if (active && ids.has(active.id)) setPreferredResult(undefined);
    return affected && !pendingRedraw.current && !Object.keys(candidates).some(id => !ids.has(id));
  }

  const candidatePath = (image: UnityImage) => API_BASE + "/api/game-images/mosaic?" +
    new URLSearchParams({ gamePath, id: image.id, sourceHash: image.sourceHash });
  const renderedMosaics = useRef(new WeakMap<Blob, Pick<Parameters<typeof redrawMosaic>[0], "boxes" | "keep" | "model">>());
  const redrawWithConfirmation = async (input: Parameters<typeof redrawMosaic>[0]) => {
    const clone = (rect: typeof input.boxes[number]): typeof input.boxes[number] => [...rect];
    const evidence = { boxes: input.boxes.map(clone), keep: input.keep.map(clone), model: input.model };
    if (input.promptId) localStorage.setItem(redrawPromptKey, input.promptId);
    const blob = await redrawMosaic({ ...input, ...evidence });
    if (input.promptId && localStorage.getItem(redrawPromptKey) === input.promptId)
      localStorage.removeItem(redrawPromptKey);
    renderedMosaics.current.set(blob, evidence);
    return blob;
  };

  const saveCandidate = async (image: UnityImage, blob: Blob, signal: AbortSignal) => {
    const metadata = renderedMosaics.current.get(blob) ?? candidateRows.current[image.id]?.versions.find(version => version.blob === blob);
    if (!metadata && supportsGameImageConfirmation(image)) throw new Error("候选缺少重绘框，请重新生成后采用");
    await mosaicResponse(await fetch(candidatePath(image), { method: "POST", headers: { "Content-Type": "image/png" }, body: blob, signal }));
    notifyMosaicAdoptionChanged(gamePath, [image.id]);
    if (metadata) {
      await saveGameImageConfirmation(gamePath, image, blob, {
        layer: "mosaic", groupId: resultFor(rows, image).group ?? null, modelId: metadata.model, maskMode: "boxes",
        boxes: [...confirmationBoxes(image, "repair", metadata.boxes), ...confirmationBoxes(image, "protect", metadata.keep)],
      }, undefined, signal);
    }
  };
  const writeMosaicPatch = async (ids: string[], undo = false, signal?: AbortSignal, patchId?: string) => {
    const response = await mosaicResponse(await fetch(API_BASE + "/api/game-images/" + (undo ? "mosaic-uninstall" : "mosaic-apply"), {
      method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gamePath, imageIds: ids, backupMode, patchId }),
    }));
    return await response.json() as { files: number; retained?: number; composed?: number };
  };

  const hasImages = usable.length > 0;
  useEffect(() => {
    if (!deploymentHandle || !hasImages) return;
    const controller = new AbortController();
    void readSavedMosaicSources(gamePath, controller.signal).then(candidates => {
      if (controller.signal.aborted) return;
      setRows(previous => {
        const next = { ...previous };
        for (const [id, source] of Object.entries(candidates)) {
          const row = next[id]?.source === source ? next[id] : { source, boxes: [], checked: false };
          if (row.discardedHash !== source && !row.saved)
            next[id] = { ...row, saved: true, checked: row.manualChecked ? row.checked : true };
        }
        return next;
      });
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [deploymentHandle, gamePath, hasImages]);

  useEffect(() => {
    if (!deploymentHandle) return;
    const selected = usable.filter(image => {
      const row = resultFor(rows, image);
      return row.checked && row.saved;
    });
    const selectedIds = selected.map(image => image.id);
    onDeploymentSelectionChange?.(selectedIds);
    deploymentHandle.current = {
      selectedIds: () => selectedIds,
      automatic: signal => measureDeploymentStage(gamePath, "mosaic", () => runAutomaticMosaic({
        selected, scoped, usable, rows, detectorKey, protect, refine: preferences.refine, model, steps, timingScope: deploymentMetricScope(gamePath, "mosaic"),
      }, signal, {
        read, readSaved, performReviews, openDetector: (signal, timingScope) => openDeploymentDetector(gamePath, preferences, signal, timingScope),
        savedMosaicScan, redrawMosaic: redrawWithConfirmation, reportGameStepItems, recordGameCacheHit, measureGameAsync, update, setProgress, clearReviews,
        readExisting: signal => readSavedMosaicSources(gamePath, signal),
        writeCandidate: saveCandidate,
      })),
      prepare: async (signal, imageIds = selected.map(image => image.id)) => {
        const patchId = crypto.randomUUID().replaceAll("-", "");
        const response = await mosaicResponse(await fetch(API_BASE + "/api/game-images/mosaic-prepare", {
          method: "POST", signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gamePath, imageIds, patchId }),
        }));
        return await response.json() as { ids: string[]; patchId: string; path: string };
      },
      apply: async (ids, undo, patchId) => (await writeMosaicPatch(ids, undo, undefined, patchId)).files,
    };
    return () => { deploymentHandle.current = null; };
  });

  const readSaved = async (image: UnityImage, signal: AbortSignal) =>
    storage ? storage.read(image, signal) : (await mosaicResponse(await fetch(candidatePath(image), { signal, cache: "no-store" }))).blob();

  const loadPreviews = !deploymentHandle || paneVisible;
  useEffect(() => {
    const image = active;
    if (!loadPreviews || !image) return;
    const controller = new AbortController();
    setPreferredResult(undefined); masks.resetDrawing();
    void read(image, controller.signal).then(blob => {
      if (!controller.signal.aborted) setSource({ id: image.id, revision: image.sourceHash, blob });
    }).catch(cause => {
      if (!controller.signal.aborted) setSource({ id: image.id, revision: image.sourceHash, error: String(cause) });
    });
    return () => controller.abort();
  }, [active, read, loadPreviews, masks.resetDrawing]);

  useEffect(() => {
    if (!loadPreviews || !activeSaved || !active) return;
    const controller = new AbortController();
    void readSaved(active, controller.signal).then(blob => {
      if (!controller.signal.aborted) setApproved({ id: active.id, revision: active.sourceHash, blob });
    }).catch(cause => {
      if (!controller.signal.aborted) setApproved({ id: active.id, revision: active.sourceHash, error: String(cause) });
    });
    return () => controller.abort();
  }, [active, activeSaved, loadPreviews]);

  function update(image: UnityImage, edit: Partial<Result>) {
    setRows(previous => ({ ...previous, [image.id]: { ...resultFor(previous, image), ...edit } }));
  }

  function stageImageEdits(images: readonly UnityImage[], edit: (image: UnityImage) => Partial<Result>) {
    const current = latestRows.current;
    stageMosaicEdits(gamePath, images.map(image => ({
      id: image.id, base: resultFor(current, image), storedSource: current[image.id]?.source, patch: edit(image),
    })));
  }

  function draftChanges(image: UnityImage) {
    const edit = drafts.get(image.id);
    if (edit?.base.source !== image.sourceHash) return { checked: false, mask: false };
    return { checked: edit.patch.checked !== undefined, mask: edit.patch.boxes !== undefined };
  }

  async function saveImageDraft(image: UnityImage) {
    if (actionsDisabled || task.current || isBenchmarkRunning()) return;
    if (storage) { await storage.saveDraftChanges(image.id); return; }
    try {
      if (saveMosaicDrafts(gamePath, image.id)) showAppNotice("已保存当前图片改动");
    } catch (error) {
      showAppNotice(error instanceof Error ? error.message : "无法保存图片改动", "error");
    }
  }

  function discardImageDraft(image: UnityImage) {
    if (actionsDisabled || task.current || isBenchmarkRunning() || !discardMosaicDraft(gamePath, image.id)) return;
    masks.clearUndo(image.id);
    if (isPreviewing(image)) masks.resetDrawing();
    showAppNotice("已撤销这张图片的未保存改动");
  }

  function setMosaicChecked(images: readonly UnityImage[], checked: boolean) {
    const current = latestRows.current;
    const pending = mosaicDraftsOf(gamePath);
    const changed = images.filter(image => {
      const row = resultFor(current, image);
      const edit = pending.get(image.id);
      const effective = edit?.base.source === row.source ? edit.patch.checked ?? row.checked : row.checked;
      return effective !== checked;
    });
    stageImageEdits(changed, image => {
      const row = resultFor(current, image);
      return { checked, manualChecked: checked === row.checked ? row.manualChecked : true };
    });
  }

  function moveToStatus(value: string) {
    if (!active || !activeResult || activeResult.saved || actionsDisabled || isBenchmarkRunning()) return;
    const manualStatus = mosaicManualStatuses.find(status => status === value);
    if (!manualStatus && value !== "auto") return;
    stageImageEdits([active], () => ({ manualStatus }));
  }

  function toggleAdoptionWithdrawal() {
    if (!active || !committedResult?.saved || actionsDisabled || isBenchmarkRunning()) return;
    const hash = storage?.index[active.id]?.hash ?? active.sourceHash;
    stageImageEdits([active], () => withdrawalStaged
      ? { saved: true, reference: committedResult.reference, discardedHash: committedResult.discardedHash }
      : { saved: false, reference: false, discardedHash: hash });
  }

  function waitForDraftSave() {
    if (!hasMosaicDrafts(gamePath)) return false;
    showAppNotice("请先点击右上角保存去码修改");
    return true;
  }

  function run(label: string, work: MosaicBatchWork, step?: MosaicBatchStep) {
    if (waitForDraftSave()) return;
    return runMosaicBatch(label, work, step, {
      blocked: () => !!task.current || disabled || isBenchmarkRunning(),
      start: (controller, id) => {
        task.current = controller;
        if (id === "screen" || id === "refine") masks.clearUndo();
        onBusy?.(true);
      },
      resumableElapsed: step => resumableMosaicMetrics(gamePath, step.id, !!step.resume)?.elapsedMs ?? 0,
      setProgressStep, setStepRuns,
      setRunning: label => {
        masks.resetDrawing();
        setBusy(label); setProgress(label, step?.id); setError("");
      },
      beginUsage: (step, refresh) => {
        const samples = step.targets?.map(image => {
          const row = resultFor(latestRows.current, image);
          const seed = step.id === "refine" ? mosaicInitialScreening(row) : row;
          return benchmarkImageInput(image, mosaicStatusLabels[mosaicScreeningStatus(seed)], row.checked, seed.boxes);
        }) ?? [];
        return beginMosaicStepUsage(gamePath, step.id, !!step.resume, refresh, { ...step, samples });
      },
      setProgress: text => setProgress(text, step?.id), setError,
      finish: () => {
        task.current = null; setBusy("");
        onBusy?.(false);
      },
    });
  }

  const resetRedraw = (ids: ReadonlySet<string>) => {
    if (resetDerivedRedraw(ids)) clearStepProgress("redraw");
  };
  const clearReviews = (ids: string[]) => clearMosaicReviews(gamePath, ids);

  const detectorKey = mosaicDetectorKey(detectorKind, detectorFile, preferences.screening);
  const reviewKey = mosaicReviewKey(preferences, detectorFile);
  const reviewModels = settings ? gameAvailableModels(settings) : ["qwen3-vl:8b-instruct"];
  const [refineModelFilter, setRefineModelFilter] = usePersistedModelFilter("mosaic:refineModel");
  const [refineGuardFilter, setRefineGuardFilter] = usePersistedModelFilter("mosaic:refineGuardModel");
  useEffect(() => {
    const completed=readMosaicReviews(gamePath,reviewKey);
    setRows(previous => {
      const next={...previous};let changed=false;
      for(const image of usable) {
        const record=completed[image.id],old=resultFor(previous,image);
        if(record?.source!==image.sourceHash || sameReview(old, record.scan, reviewKey) || old.manualBoxes || old.saved)continue;
        next[image.id] = reviewedResult(old, record.scan, reviewKey);
        changed=true;
      }
      return changed?next:previous;
    });
  },[gamePath,usable,reviewKey]);
  const reviewSessionKey = JSON.stringify([reviewKey, detectorKey, scope, needle]);
  const previousReview = lastReview.current?.key === reviewSessionKey ? lastReview.current : undefined;
  const isReviewed = (row: Result) => matchesMosaicReviewKey(row.refined, reviewKey) && !row.refineQuickExcluded && !row.refineError;
  const checkedReviewScope: UnityImage[] = [];
  const pendingReview: UnityImage[] = [];
  let reviewedCount = 0, hasOlderReviews = false;
  for (const image of currentScope) {
    const row = resultFor(rows,image);
    if ((!row.scanned && !row.refined && !row.refineError) || row.saved || row.manualBoxes) continue;
    const olderReview = !!row.refined && !matchesMosaicReviewKey(row.refined, reviewKey);
    const selectedForReview = row.checked || (olderReview && !row.manualChecked && !!row.beforeRefine?.checked);
    if (selectedForReview) checkedReviewScope.push(image);
    if (isReviewed(row)) {
      if (row.checked || row.beforeRefine?.checked && !row.manualChecked ||
          previousReview?.images.get(image.id) === image.sourceHash) reviewedCount++;
    } else if (selectedForReview) {
      pendingReview.push(image);
      if (olderReview) hasOlderReviews = true;
    }
  }
  const reviewTotal = reviewedCount + pendingReview.length;
  async function performReviews(targets: readonly UnityImage[], signal: AbortSignal, report?: (completed: number, detail: string) => void,
    restart = false, automatic = false, metrics?: MosaicReviewMetrics, deploymentScope?: string) {
    const configuration = settings || await api.getSettings();
    return performMosaicReviews({ targets, rows, gamePath, preferences, reviewKey, detectorFile, restart, automatic, metrics, deploymentScope },
      signal, report, {
        read, prepareSources, refineBatch: refineMosaicBatch, readMosaicReviews, setRows, setRefineRetries,
        beginUsage: resume => beginMosaicStepUsage(gamePath, "refine", resume),
        gameStepSelections,
        prepareRequest: (model, lanes) => prepareMosaicReviewModel(configuration, model, lanes, signal, detail => setProgress(detail, automatic ? undefined : "refine")),
        request: (model, prompt, image, signal, selection) =>
          requestGameModelJson(configuration, model, prompt, signal, image, "game-images", undefined, { role: "mosaic", selection }),
      });
  }
  function refine(restart=false) {
    const targets = restart ? checkedReviewScope : pendingReview;
    if (!targets.length) return;
    const initial = restart ? 0 : reviewedCount;
    void run("复筛打码图片", (signal, report, usage) => runMosaicRefine({
      targets, rows, restart, initial, previousReview, checkedReviewScope, reviewSessionKey,
    }, signal, report, usage, {
      replaceRows, clearReviews, resetRedraw, performReviews, setProgress: text => setProgress(text, "refine"), setError,
      trackReview: session => { lastReview.current = session; },
    }), {id:"refine",targets,total:restart ? targets.length : reviewTotal,completed:initial,summary:preferences.refineModel || "qwen3.5:latest",
      parameters: formatMosaicParameters("mosaicRefine", {
        ...preferences, refineConcurrency: Math.min(targets.length, mosaicRefineConcurrency(preferences.refineConcurrency)),
      }), resume: !restart && (!hasOlderReviews || reviewedCount > 0)});
  }
  const lastScreen = useRef<{ scope: readonly UnityImage[]; detector: string } | null>(null);
  const screenTargets: UnityImage[] = [];
  const remaining: UnityImage[] = [];
  let screenedCount = 0, otherDetectorCount = 0, hasScreenFailure = false;
  for (const image of currentScope) {
    const row = resultFor(rows, image);
    const initial = mosaicInitialScreening(row);
    const needsScreening = row.checked || (initial.scanned && !row.manualChecked && !row.saved && !row.manualBoxes && !row.manualStatus);
    if (needsScreening) screenTargets.push(image);
    if (initial.scanned && !initial.reason && matchesMosaicDetectorKey(initial.detector, detectorKey)) {
      screenedCount++;
      continue;
    }
    if (initial.scanned && !initial.reason) otherDetectorCount++;
    if (initial.reason) hasScreenFailure = true;
    if (needsScreening) remaining.push(image);
  }
  const screenTotal = screenedCount + remaining.length;

  function screen(checkedOnly = false) {
    const restart = checkedOnly || remaining.length === 0 || (screenedCount === 0 && otherDetectorCount > 0);
    const targets = checkedOnly ? screenTargets.filter(image => resultFor(rows, image).checked) : restart ? screenTargets : remaining;
    if (!targets.length) return;
    lastScreen.current = { scope: currentScope, detector: detectorKey };
    const initial = restart ? 0 : screenedCount;
    void run("筛选打码区域", (signal, report, usage) => runMosaicScreen({
      targets, usable, rows, initial, detectorKind, detectorKey, detectorFile,
      modelName: detectorKind !== "grid" && detectorFile ? detectorFile.name : detectorLabels[detectorKind],
      concurrency: preferences.concurrency, screening: preferences.screening,
    }, signal, report, usage, {
      replaceRows, setRows, clearReviews, resetRedraw, read, prepareSources, loadMosaicDetector, createMosaicGridScanner, setProgress: text => setProgress(text, "screen"),
      onDevice: device => setStepRuns(previous => previous.screen ? { ...previous, screen: { ...previous.screen, device } } : previous),
    }), { id: "screen", targets, total: restart ? targets.length : screenTotal, completed: initial, summary: detectorLabels[detectorKind],
      parameters: [
        { scope: "config", label: "筛选范围", value: scope === "scenes" ? "场景图片" : "全部图片" },
        ...formatMosaicParameters("mosaicScreen", preferences).map(parameter =>
          detectorKind !== "grid" && detectorFile && parameter.label === "定位模型"
            ? { ...parameter, value: detectorFile.name } : parameter),
      ],
      resume: !restart });
  }
  function commitMaskEdits(edits: MosaicMaskCommit) {
    const nextRows = edits.rows;
    if (!nextRows) return true;
    stageMosaicEdits(gamePath, edits.candidates.map(({ id, candidate }) => {
      const row = nextRows[id];
      const { boxes, manualBoxes, review, redrawError, saved, reference, checked } = row;
      const stored = latestRows.current[id];
      const base = stored?.source === row.source ? stored : { source: row.source, boxes: [], checked: true };
      return { id, base, storedSource: stored?.source, patch: { boxes, manualBoxes, review, redrawError, saved, reference, checked },
        candidate: { value: candidate } };
    }));
    return true;
  }

  function startRedraw(plan: RedrawPlan, resume = false) {
    if (archiveReason) { showAppNotice(archiveReason); return; }
    if (resume && !canResumeMosaicRedraw(plan, usable, rows, protect)) {
      pendingRedraw.current = null;
      void enqueueArchiveWrite(() => writeMosaicRedrawPlan(gamePath, null)).catch(reportArchiveError);
      setStepRuns(previous => ({ ...previous, redraw: undefined }));
      setError("原图、蒙版、文字保护范围或画风分组已变更，请按当前选择重绘");
      return;
    }
    for (const target of plan.targets) {
      target.promptIds ??= {};
      for (const engine of target.pending) target.promptIds[engine] ??= crypto.randomUUID();
    }
    const models = plan.models.map(engine => mosaicModelLabels[engine]).join("、");
    const summary = plan.groupReferences ? "自动按组重绘 · " + models : models;
    const total = plan.targets.length;
    const initial = plan.targets.filter(target => !target.pending.size).length;
    const references = new Map(plan.targets.flatMap(({ style }) =>
      style.reference ? [[style.reference.id, style.reference.name] as const] : []));
    const groupCount = new Set(plan.targets.map(({ style }) => style.group)).size;
    const running = run("生成去码候选", (signal, report, usage) => runMosaicRedraw(plan, initial, signal, report, usage, {
      read, readSaved, mosaicInputKey, redrawMosaic: redrawWithConfirmation, recordGameCacheHit, update, setProgress: text => setProgress(text, "redraw"), setError,
      setPending: storePendingRedraw,
      onCandidate: async (image, version) => {
        if (redrawCancelRequested.current) throw new Error("重绘任务已取消");
        const current = candidateRows.current[image.id];
        const versions = current?.revision === image.sourceHash ? current.versions : [];
        const candidate = { revision: image.sourceHash, versions: [...versions.filter(item => item.id !== version.id), version] };
        await enqueueArchiveWrite(() => writeMosaicRedrawCandidates(gamePath, [[image.id, candidate]]));
        updateCandidates({ ...candidateRows.current, [image.id]: candidate });
        if (isPreviewing(image)) setPreferredResult(version.id);
      },
    }), { id: "redraw", targets: plan.targets.map(target => target.image), total, completed: initial, summary, parameters: [
      ...plan.models.map((engine): BenchmarkParameter => ({
        scope: "config", label: mosaicModelLabels[engine], value: mosaicRedrawStepCount(plan, engine) + " 步",
      })),
      { scope: "config", label: "保护已识别文字", value: protect ? "开启" : "关闭" },
      ...(plan.groupReferences ? [{ scope: "config" as const, label: "画风参考", value: "优先复用组内结果，否则首张无参考重绘" }]
        : references.size ? [{ scope: "config" as const, label: "画风参考",
          value: groupCount === 1 ? references.values().next().value! : "按组使用 " + references.size + " 张参考图" }] : []),
    ], resume });
    if (running) {
      redrawTask.current = running;
      void running.finally(() => { if (redrawTask.current === running) redrawTask.current = undefined; }).catch(console.error);
    }
  }
  function canRedrawImage(row: Result) {
    return preferences.refine === false || !!row.saved || !!row.manualBoxes || isReviewed(row);
  }

  function generate(targets: UnityImage[], models: MosaicModel[], mode: "regular" | "reference" | "automatic" = "regular") {
    const usableTargets = targets.filter(image => resultFor(rows, image).boxes.length);
    if (!usableTargets.length) return;
    if (usableTargets.some(image => !canRedrawImage(resultFor(rows, image)))) {
      setError("请先完成视觉复筛，再重绘所选图片");
      return;
    }
    const groups = new Map<string, RedrawPlan["targets"]>();
    for (const image of usableTargets) {
      const style = mosaicRedrawStyle(image, rows, redrawReferences);
      if (mode !== "regular") style.reference = undefined;
      const batch = groups.get(style.group) ?? [];
      batch.push({ image, boxes: resultFor(rows, image).boxes, keep: keepText(image, protect), pending: new Set(models), style });
      groups.set(style.group, batch);
    }
    const groupReferences = mode === "automatic" ? new Map([...groups].map(([group, batch]) =>
      [group, existingRedraw.references.get(group) ?? { image: batch[0].image, source: "generate" as const }])) : undefined;
    startRedraw({ targets: [...groups.values()].flat(), models, steps, referenceGuide: mode === "reference", groupReferences });
  }

  function redrawCurrent(models: MosaicModel[]) {
    if (!active || actionsDisabled || archiveReason || pendingRedraw.current || isBenchmarkRunning() || waitForDraftSave()) return;
    if (!activeResult?.boxes.length) {
      if (source?.id !== active.id || source.revision !== active.sourceHash || !source.blob) {
        showAppNotice("请等待原图读取完成");
        return;
      }
      if (masks.tool !== "add") masks.toggleTool("add");
      showAppNotice("请在原图框选要重绘的区域，保存蒙版后再开始重绘");
      return;
    }
    generate([active], models);
  }

  async function openCurrentInComfy(source: Blob) {
    if (!active || !activeResult) return;
    try {
      const { seed, reference } = mosaicRedrawStyle(active, rows, redrawReferences);
      const workflow = await prepareMosaicComfyWorkflow({
        name: active.name, source, boxes: activeResult.boxes, keep: keepText(active, protect), model, steps, seed,
        reference: reference && await readSaved(reference, new AbortController().signal),
      });
      window.dispatchEvent(new CustomEvent(openMosaicComfyWorkflowEvent, { detail: workflow }));
    } catch (error) {
      showAppNotice(error instanceof Error ? error.message : String(error), "error");
    }
  }

  function saveGroupReference(image: UnityImage) {
    if (task.current || actionsDisabled || isBenchmarkRunning() || waitForDraftSave()) return;
    try {
      replaceRows(assignMosaicRedrawReference(latestRows.current, usable, image));
      showAppNotice("已设为本组画风参考");
    } catch (error) {
      showAppNotice(error instanceof Error ? error.message : "无法保存画风参考", "error");
    }
  }

  function approve(image: UnityImage, blob: Blob, asReference = false) {
    void run(asReference ? "采用为本组参考" : "保存已采用去码图", async signal => {
      if (storage) await storage.save(image, blob, signal);
      else await saveCandidate(image, blob, signal);
      masks.clearUndo();
      const adopted = { saved: true, checked: true, discardedHash: undefined, redrawError: undefined };
      if (asReference) {
        const current = latestRows.current;
        const next = { ...current, [image.id]: { ...resultFor(current, image), ...adopted } };
        replaceRows(assignMosaicRedrawReference(next, usable, image));
      } else {
        update(image, adopted);
      }
      if (isPreviewing(image)) {
        setApproved({ id: image.id, revision: image.sourceHash, blob });
        setPreferredResult("saved");
      }
      setProgress((asReference ? "本组参考图 · " : "已保存 · ") + image.name);
      if (asReference) showAppNotice("已采用并设为本组画风参考");
    });
  }

  async function patch(undo: boolean) {
    if (waitForDraftSave()) return;
    if (storage) {
      const targets = undo ? included : saved.filter(image => !storage.index[image.id]?.included);
      if (!targets.length) return;
      const title = undo ? "从生成清单移除" : "纳入补丁生成";
      void run(title, async signal => {
        await storage.select(targets, !undo, signal);
        setProgress(title + " · " + targets.length + " 张");
      });
      return;
    }
    const targets = undo ? selected : saved;
    const title = undo ? "撤销所选去码图" : "应用所选去码图";
    if (!targets.length || !await confirmation.confirm("请关闭游戏后继续。将处理当前场景组中所选的 " + targets.length + " 张图片。", { title, okLabel: title })) return;
    void run(title, async signal => {
      const detail = await writeMosaicPatch(targets.map(image => image.id), undo, signal);
      const layers = undo && detail.retained ? ` · 保留 ${detail.retained} 张译图`
        : detail.composed ? ` · ${detail.composed} 张与译图合成` : "";
      const message = `${title}完成 · ${detail.files} 张${layers}`;
      showAppNotice(message);
      setProgress(message);
    });
  }

  const previousScreen = lastScreen.current;
  const sameScreen = previousScreen?.detector === detectorKey && previousScreen.scope.length === currentScope.length &&
    (previousScreen.scope === currentScope || previousScreen.scope.every((image, i) =>
      image.id === currentScope[i].id && image.sourceHash === currentScope[i].sourceHash));
  const stoppedScreen = sameScreen && stepRuns.screen?.state === "stopped";
  const screenAction = !remaining.length && screenedCount ? "重新筛选"
    : screenedCount || stoppedScreen ? "继续筛选" : otherDetectorCount ? "重新筛选" : "开始筛选";
  const lastScreenRun = stepRuns.screen;
  const idleScreen: StepRun = {
    state: screenTotal && !remaining.length ? "done" : screenedCount ? "stopped"
      : hasScreenFailure ? "error" : "pending",
    total: screenTotal, completed: screenedCount,
  };
  const screenStatus = lastScreenRun?.state === "running" ? lastScreenRun : {
    ...(sameScreen ? lastScreenRun : undefined),
    ...idleScreen,
    state: sameScreen && (lastScreenRun?.state === "error" || lastScreenRun?.state === "stopped") ? lastScreenRun.state : idleScreen.state,
  };
  const refineStatus: StepRun = stepRuns.refine?.state==="running" ? stepRuns.refine : {
    ...(previousReview ? stepRuns.refine : undefined),
    state:reviewTotal && !pendingReview.length ? "done"
      : previousReview && stepRuns.refine?.state==="error" ? "error"
      : (previousReview && stepRuns.refine?.state==="stopped") || reviewedCount ? "stopped" : "pending",
    total:reviewTotal,completed:reviewedCount,
  };
  const canClearStep = (state?: GameProgressState) => state === "stopped" || state === "error" || state === "done";
  const canClearRefine = canClearStep(refineStatus.state) || canClearStep(stepRuns.refine?.state) ||
    Object.values(rows).some(row => !row.saved && (row.refined || row.refineError || row.beforeRefine));
  const canClearRedraw = canClearStep(stepRuns.redraw?.state) || Object.keys(candidates).length > 0 ||
    Object.values(rows).some(row => !!row.redrawError);
  const canClear = canClearStep(screenStatus.state) || canClearRefine || canClearRedraw ||
    usable.some(image => resultFor(rows, image).saved && !storage?.index[image.id]?.included);
  const pausedRedraw = (stepRuns.redraw?.state === "stopped" || stepRuns.redraw?.state === "error") ? pendingRedraw.current : null;
  const redrawRemaining = pausedRedraw?.targets.filter(target => target.pending.size).length ?? 0;
  const reviewCheckpoint = resumableMosaicMetrics(gamePath, "refine", true);
  const hasUnfinishedReview = scoped.some(image => {
    const row = resultFor(rows, image);
    return row.checked && (row.scanned || row.refineError) && !row.saved && !row.manualBoxes && !isReviewed(row) &&
      (!!row.refineError || !!reviewCheckpoint);
  });
  const pausedScreen = (screenStatus.state === "stopped" || screenStatus.state === "error") && !!remaining.length;
  const formalMosaicStep = busy ? progressStep :
    hasUnfinishedReview ? "refine" : pausedScreen ? "screen" : redrawRemaining ? "redraw" : undefined;
  const formalMosaicRun = formalMosaicStep === "refine" ? refineStatus :
    formalMosaicStep === "screen" ? screenStatus : formalMosaicStep === "redraw" ? stepRuns.redraw : undefined;
  const mosaicStepLabels = { screen: "筛选打码图片", refine: "复筛打码图片", redraw: "重绘打码区域" };
  useFormalWorkflowActivity(!!busy, gamePath.split(/[\\/]/).filter(Boolean).at(-1) || gamePath,
    formalMosaicStep ? mosaicStepLabels[formalMosaicStep] : busy,
    formalMosaicRun?.completed, formalMosaicRun?.total,
    !busy && !!formalMosaicStep, busy ? progress :
      formalMosaicRun?.state === "error" ? "失败待重试" : "已中止，等待继续");
  const listRedraw: UnityImage[] = [];
  let noMask = 0, awaitingReview = 0, alreadyGenerated = 0;
  for (const image of visible) {
    const row = resultFor(rows, image);
    if (!row.checked) continue;
    if (existingRedraw.ready.has(image.id)) { alreadyGenerated++; continue; }
    if (!row.boxes.length) { noMask++; continue; }
    if (!canRedrawImage(row)) { awaitingReview++; continue; }
    listRedraw.push(image);
  }
  const redrawGroup = selected.filter(image => image.id !== reference?.id &&
    resultFor(rows, image).boxes.length && canRedrawImage(resultFor(rows, image)));
  const redrawSkipped = [
    noMask && noMask + " 张缺蒙版", awaitingReview && awaitingReview + " 张待复筛", alreadyGenerated && alreadyGenerated + " 张已生成",
  ].filter(Boolean).join(" · ");
  const benchmarkProgress = useBenchmarkProgress(gamePath);
  const testing = useBenchmarkRunning();
  const testTitle = testing ? benchmarkBlockingReason : undefined;
  useEffect(() => {
    if (actionsDisabled || !paneVisible) setGroupMenu(null);
  }, [actionsDisabled, paneVisible]);

  function openGroupMenu(event: ReactMouseEvent<HTMLElement>, key: string | undefined) {
    if (actionsDisabled || !key || !isIndependentGroup(key) || !imageGroup.has(key)) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: bounds.left, y: bounds.bottom };
    setGroupMenu({ group: key, ...getFixedMenuPoint(point.x, point.y, 166, 55) });
  }

  async function deleteGroup(key: string) {
    setGroupMenu(null);
    if (actionsDisabled || task.current || !isIndependentGroup(key)) return;
    const count = imageGroup.get(key)?.length;
    if (!count || !await confirmation.confirm(`删除这个独立组？组内 ${count} 张图片将恢复默认分组，蒙版和处理结果会保留。`, {
      title: "删除独立组", okLabel: "删除",
    }) || task.current) return;
    const members = imageGroup.get(key) ?? [];
    const next = dissolveIndependentGroup(latestRows.current, key);
    stageImageEdits(members, image => {
      const { group, manualGroup, reference } = resultFor(next, image);
      return { group, manualGroup, reference };
    });
  }

  function clearStepProgress(step: "refine" | "redraw", resetRedraw = false) {
    masks.clearUndo();
    clearGamePerformance(mosaicMetricScope(gamePath,step),[step]);
    if (step === "refine") clearGamePerformance(deploymentMetricScope(gamePath, "mosaic"), ["mosaic"]);
    if (resetRedraw) clearGamePerformance(mosaicMetricScope(gamePath,"redraw"),["redraw"]);
    setStepRuns(previous => ({ ...previous, [step]: undefined, ...(resetRedraw && { redraw: undefined }) }));
    if (progressStep === step || resetRedraw && progressStep === "redraw") {
      setProgressStep(undefined);
      setProgress("");
      setError("");
    }
  }

  async function clearRefine() {
    if (waitForDraftSave()) return;
    if (actionsDisabled || !canClearRefine) return;
    if (!await confirmation.confirm("清理本工程的复筛进度和结果，并恢复已有的初筛记录？", {
      title: "清理复筛", okLabel: "清理",
    }) || task.current) return;

    const changedMasks = new Set<string>();
    const next: Results = {};
    for (const [id, row] of Object.entries(rows)) {
      const cleared = clearReviewResult(row);
      next[id] = cleared;
      if (cleared.boxes !== row.boxes && JSON.stringify(cleared.boxes) !== JSON.stringify(row.boxes)) changedMasks.add(id);
    }
    try { replaceRows(next); }
    catch { showAppNotice("无法保存图片去码筛选记录", "error"); return; }
    clearMosaicReviews(gamePath);
    const resetRedraw = changedMasks.size > 0 && resetDerivedRedraw(changedMasks);
    lastReview.current = null;
    clearStepProgress("refine", resetRedraw);
    showAppNotice("已清理复筛");
  }

  async function cancelRedrawPrompt() {
    const promptId = localStorage.getItem(redrawPromptKey);
    if (!promptId) return;
    await cancelMosaicRedraw(promptId);
    if (localStorage.getItem(redrawPromptKey) === promptId) localStorage.removeItem(redrawPromptKey);
  }

  async function cancelRedrawTask() {
    const running = redrawTask.current;
    if (redrawCancelRequested.current || (!pausedRedraw && !running) || (task.current && !running)) return;
    redrawCancelRequested.current = true;
    setRedrawCancelling(true);
    if (running) task.current?.abort();
    setProgress("正在取消重绘任务…", "redraw");
    try {
      await cancelRedrawPrompt();
      await running;
      await storePendingRedraw(null);
      clearStepProgress("redraw");
      showAppNotice("已取消当前重绘任务");
    } catch (error) {
      showAppNotice("无法取消当前重绘任务：" + String(error), "error");
    } finally {
      redrawCancelRequested.current = false;
      setRedrawCancelling(false);
      setProgress("");
    }
  }

  async function clearRedraw() {
    if (waitForDraftSave()) return;
    if (actionsDisabled || !canClearRedraw) return;
    if (!await confirmation.confirm("清理未采用的重绘候选和重绘进度？已采用的去码图会保留。", {
      title: "清理重绘", okLabel: "清理",
    }) || task.current) return;

    const next = Object.fromEntries(Object.entries(rows).map(([id, row]) =>
      [id, row.redrawError ? { ...row, redrawError: undefined } : row]));
    try {
      await cancelRedrawPrompt();
      await enqueueArchiveWrite(() => clearMosaicRedrawArchive(gamePath));
      replaceRows(next);
    } catch (error) { reportArchiveError(error); return; }
    pendingRedraw.current = null;
    updateCandidates({});
    setPreferredResult(undefined);
    clearStepProgress("redraw");
    showAppNotice("已清理重绘");
  }

  async function clearTask() {
    if (waitForDraftSave()) return;
    if (!canClear || actionsDisabled) return;
    const count = usable.filter(image => {
      const row = resultFor(rows, image);
      return row.scanned || row.refined || row.manualChecked || row.saved && !storage?.index[image.id]?.included ||
        row.boxes.length || mosaicProcessingError(row) || row.manualGroup || candidates[image.id]?.revision === image.sourceHash;
    }).length;
    if (count > 0 && !await confirmation.confirm(`清除本次任务中 ${count} 张图片的筛选、选择、采用结果和进度？已纳入补丁的去码图将保留。`, {
      title: "清理图片去码任务", okLabel: "清理",
    })) return;
    if (task.current) return;

    if (deploymentHandle && !storage) {
      await run("正在清理图片去码任务", async signal => {
        const cached = await readSavedMosaicSources(gamePath, signal);
        signal.throwIfAborted();
        await resetTask(cached);
      });
    } else {
      await resetTask({});
    }
  }

  async function resetTask(cached: Readonly<Record<string, string>>) {
    const next: Results = {};
    for (const image of usable) {
      const entry = storage?.index[image.id];
      const row = resultFor(latestRows.current, image);
      if (!storage && (row.saved || row.discardedHash === image.sourceHash || cached[image.id] === image.sourceHash)) {
        next[image.id] = { ...defaultResult(image), discardedHash: image.sourceHash };
        continue;
      }
      if (entry?.source !== image.sourceHash) continue;
      // The cache has no selective deletion endpoint. Remember which confirmation was cleared,
      // while keeping results already in the patch index available.
      next[image.id] = entry.included ? { ...defaultResult(image), saved: true }
        : { ...defaultResult(image), discardedHash: entry.hash };
    }
    try {
      await enqueueArchiveWrite(() => clearMosaicRedrawArchive(gamePath));
      replaceRows(next);
    } catch (error) { reportArchiveError(error); return; }
    clearMosaicReviews(gamePath);
    lastScreen.current = null;
    lastReview.current = null;
    pendingRedraw.current = null;
    masks.clearUndo();
    for (const step of ["screen","refine","redraw"] as const)
      clearGamePerformance(mosaicMetricScope(gamePath,step),[step]);
    clearGamePerformance(deploymentMetricScope(gamePath, "mosaic"), ["mosaic"]);
    setStepRuns({});
    setProgressStep(undefined);
    setProgress("");
    setError("");
    setGroupPages({});
    setImageFilters(allGameImageFilters);
    setApproved(undefined);
    updateCandidates({});
    setPreferredResult(undefined);
    masks.resetDrawing();
    showAppNotice("已清理图片去码任务");
  }

  const busyReason = busy ? "正在处理，先中止或等待" : disabled ? "请等待其他工程操作完成" : undefined;
  const { failureCount, unresolvedRefineFailures, retryCount } = useMemo(() => {
    let failureCount = 0, unresolvedRefineFailures = 0, retryCount = 0;
    for (const image of scoped) {
      const row = resultFor(rows, image);
      if (mosaicFilterPhase(row) === "failed") failureCount++;
      if (row.refineError) {
        unresolvedRefineFailures++;
        if (refineRetries.get(image.id) === image.sourceHash) retryCount++;
      }
    }
    return { failureCount, unresolvedRefineFailures, retryCount };
  }, [scoped, rows, refineRetries]);
  const activeFailure = mosaicProcessingError(activeResult);
  const activeRetry = active && activeResult?.refineError && isRefineRetrying(active);
  const toggleFailureFilter = () => {
    setImageFilters(failuresOnly ? allGameImageFilters : { ...allGameImageFilters, pending: false, done: false });
    setCollapsed(previous => ({ ...previous, failed: false }));
    setQuery(""); setGroupPages({}); setActiveId("");
  };
  const redrawBlocked = testTitle ?? busyReason ?? draftReason ?? archiveReason;
  const pendingRedrawReason = pausedRedraw ? "请先继续或清理上一次重绘任务" : undefined;
  const redrawReason = redrawBlocked ?? pendingRedrawReason ?? (!activeSaved && !activeResult?.boxes.length ? "先在图上框选打码区域" : undefined);
  const batchReason = redrawBlocked ?? (!pausedRedraw && !listRedraw.length ? redrawSkipped || "先勾选已有蒙版的图片" : undefined);
  const groupRedrawReason = redrawBlocked ?? pendingRedrawReason ?? (!redrawGroup.length ? "本组没有可重绘的已勾选图片" : undefined);
  const guidedCandidate = active ? draftCandidates[active.id] : undefined;
  const referenceCandidate = !reference && guidedCandidate?.revision === active?.sourceHash
    ? guidedCandidate?.versions.filter(version => !!version.referenceGroup && version.referenceGroup === group).at(-1)?.blob : undefined;
  const guideRemaining = redrawGroup.filter(image => (reference || image.id !== active?.id) && !resultFor(rows, image).saved);
  const guideReason = redrawBlocked ?? pendingRedrawReason;
  const guideCandidateReason = guideReason ?? (!activeResult?.boxes.length ? "请先为当前图片保存蒙版"
    : active && !canRedrawImage(resultFor(rows, active)) ? "请先完成当前图片的视觉复筛" : undefined);
  const referenceFlow = !active || members.length < 2 ? undefined
    : reference ? {
      detail: "参考图：" + reference.name + " · 剩余可重绘 " + guideRemaining.length + " 张",
      label: "按参考重绘本组剩余 · " + guideRemaining.length + " 张",
      reason: guideReason ?? (!guideRemaining.length ? "请勾选本组其他已就绪的图片" : undefined),
      run: () => generate(guideRemaining, [model]),
    } : activeSaved ? {
      detail: "当前图片已采用，可以直接设为本组参考。",
      label: "设为参考并保存",
      reason: guideReason,
      run: () => saveGroupReference(active),
    } : referenceCandidate ? {
      detail: "请检查右侧候选，满意后点「采用为本组参考」。",
      label: "重新生成参考候选",
      reason: guideCandidateReason,
      run: () => generate([active], [model], "reference"),
    } : {
      detail: "先用当前图片生成无参考候选，确认后再重绘本组其他图片。",
      label: "生成无参考候选",
      reason: guideCandidateReason,
      run: () => generate([active], [model], "reference"),
    };
  if (deploymentHandle && !paneVisible) return null;
  const getRow = (image: UnityImage) => resultFor(draftRows, image);
  const isAdopted = (image: UnityImage) => !!resultFor(rows, image).saved;
  const hiddenStyle = paneVisible ? undefined : { display: "none" };
  const screenSummary = detectorKind !== "grid" && detectorFile
    ? "自定义检测 · " + detectorFile.name : detectorLabels[detectorKind];
  const cardMeasurement = (id: MosaicStep) => {
    const formalMeasurement = mosaicCardMetrics(gamePath, id);
    return { formalMeasurement, measured: groupMosaicModels(formalMeasurement) };
  };
  return <section className="unity-offline-workbench unity-image-workbench game-mosaic-workbench" aria-label="图片去码" hidden={!paneVisible} style={hiddenStyle}>
    {confirmation.dialog}
    {createPortal(<MosaicStepCards paneVisible={paneVisible} hiddenStyle={hiddenStyle}
      busy={!!busy} aborting={task.current?.signal.aborted} actionsDisabled={actionsDisabled || !!draftReason}
      onStop={id => id === "redraw" ? void cancelRedrawTask() : stopMosaicBatch(task.current, text => setProgress(text, id))}
      preferences={preferences} changePreferences={changePreferences} detectorLabels={detectorLabels} reviewModels={reviewModels}
      testing={testing} parametersLocked={disabled} testTitle={testTitle} benchmarkProgress={benchmarkProgress} measurements={{
        screen: cardMeasurement("screen"), refine: cardMeasurement("refine"), redraw: cardMeasurement("redraw"),
      }} now={performance.now()} progress={progress} statusLineStep={statusLineStep} error={error}
      screen={{
        status: screenStatus, summary: screenSummary, action: screenAction, targetCount: screenTargets.length, screenedCount,
        remainingCount: remaining.length, otherDetectorCount, canClear, detectorFile,
        changeScope: scope => { changePreferences({ scope }); setGroupPages({}); },
        chooseDetectorFile: file => {
          if (!task.current && !disabled && !isBenchmarkRunning()) setDetectorFile(gameDetectorFile(gamePath, file));
        },
        useBuiltInDetector: () => {
          if (task.current || disabled || isBenchmarkRunning()) return;
          clearGameDetectorFile(gamePath);
          setDetectorFile(undefined);
        },
        start: screen, clear: clearTask,
      }} refine={{
        status: refineStatus, targetCount: checkedReviewScope.length, pendingCount: pendingReview.length, reviewedCount,
        wasStopped: stepRuns.refine?.state === "stopped", canClear: canClearRefine, modelFilter: refineModelFilter,
        setModelFilter: setRefineModelFilter, guardFilter: refineGuardFilter, setGuardFilter: setRefineGuardFilter,
        start: refine, clear: clearRefine,
      }} redraw={{
        status: stepRuns.redraw, targetCount: listRedraw.length, groupTargetCount: redrawGroup.length,
        remainingCount: redrawRemaining, paused: !!pausedRedraw, skipped: redrawSkipped, canClear: canClearRedraw,
        cancelling: redrawCancelling, cancel: cancelRedrawTask,
        batchReason, groupReason: groupRedrawReason, referenceFlow,
        start: () => pausedRedraw ? startRedraw(pausedRedraw, true) : generate(listRedraw, [model], "automatic"),
        startGroup: () => generate(redrawGroup, [model]), clear: clearRedraw,
      }} unresolvedRefineFailures={unresolvedRefineFailures} retryCount={retryCount} />, controls)}
    <MosaicGroupTree listId={listId} filterMenu={filterMenu} filters={{ query, needle, scope, imageFilters, failuresOnly }}
      onImageFiltersChange={(filters: GameImageFilters) => {
        setImageFilters(filters);
        setActiveId("");
        setGroupPages({});
      }}
      onQueryChange={value => { setQuery(value); setActiveId(""); setGroupPages({}); }}
      onToggleFailureFilter={toggleFailureFilter} counts={{ ...counts, visible: visible.length, failed: failureCount }}
      active={active} groups={groups} ordered={ordered} refineChanges={refineChanges} groupPages={groupPages} setGroupPages={setGroupPages}
      collapsed={collapsed} setCollapsed={setCollapsed} listView={listView} setListView={switchListView}
      onBrowsePreviewKeyDown={event => galleryNavigation.current?.(event)}
      originalGallery={<MosaicOriginalGallery images={visible} activeId={active?.id} navigationRef={galleryNavigation}
          page={galleryPage} onPage={setGalleryPage} selectedIds={gallerySelectedIds} setSelectedIds={setGallerySelectedIds}
          query={needle} read={read} status={imageStatus} getRow={getRow} isAdopted={isAdopted}
          draftChanges={draftChanges} disabled={actionsDisabled} onPreview={selectPreview} onCheck={setMosaicChecked}
          hasDraft={image => drafts.has(image.id)} onDiscard={discardImageDraft} />}
      actionsDisabled={actionsDisabled} getRow={getRow} isAdopted={isAdopted} draftChanges={draftChanges} imageStatus={imageStatus} refineMovementFor={refineMovementFor}
      isRefineRetrying={isRefineRetrying} selectPreview={selectPreview} setMosaicChecked={setMosaicChecked}
      groupMenu={groupMenu} openGroupMenu={openGroupMenu} closeGroupMenu={closeGroupMenu} deleteGroup={deleteGroup}>
      <MosaicPreview active={active} activeResult={activeResult} visibleCount={visible.length} paneVisible={paneVisible}
        source={source} approved={approved} activeSaved={activeSaved} candidate={active && draftCandidates[active.id]}
        preferredResult={preferredResult} setPreferredResult={setPreferredResult} masks={masks}
        getViewerNeighbors={getViewerNeighbors} onViewerImage={selectViewerImage}
        actionsDisabled={actionsDisabled} busyReason={busyReason ?? draftReason} redrawReason={redrawReason} testTitle={testTitle} model={model}
        onRedraw={redrawCurrent} onOpenComfy={openCurrentInComfy}
        onApprove={blob => { if (active) approve(active, blob, blob === referenceCandidate); }}
        referenceCandidate={referenceCandidate}
        resultActions={active && <div className="unity-image-button-group game-mosaic-current-file-actions">
          <button type="button" className="unity-btn is-secondary" aria-label="撤销当前图片改动"
            disabled={actionsDisabled || testing || !drafts.has(active.id)} onClick={() => discardImageDraft(active)}>撤销改动</button>
          <button type="button" className="unity-btn unity-btn-primary"
            disabled={actionsDisabled || testing || !drafts.has(active.id)} onClick={() => void saveImageDraft(active)}>保存当前图片</button>
        </div>}
        header={active &&
          <div className="unity-image-actions game-mosaic-detail-header">
            <div className="game-mosaic-image-heading">
              <strong data-tooltip={active.file}><SearchHighlight text={active.name} query={needle} /></strong>
              <MosaicImageBadges adopted={activeSaved} reference={activeIsReference} />
            </div>
            {draftReason && <span className="game-mosaic-detail-hint" data-tooltip={draftReason}>{draftReason}</span>}
            <div className="unity-image-button-group">
              <span data-tooltip={isIndependentGroup(group) ? "右键管理当前独立组" : undefined}
                onContextMenu={event => openGroupMenu(event, group)}>{members.length} 张 · 本组已选 {selected.length} 张</span>
              <div className="game-mosaic-group-picker">
                <UnityDescriptionSelect label="移动到处理分组…" value={activeResult?.manualStatus ?? ""} menuWidth={188} disabled={actionsDisabled || testing || !!activeResult?.saved}
                  choices={[
                    ...mosaicStatusChoices(),
                    ...(activeResult?.manualStatus ? [{ value: "auto", label: "恢复自动分组" }] : []),
                  ]}
                  onChange={moveToStatus} />
              </div>
              <button type="button" className="unity-btn" data-tooltip={activeSaved ? "组内重绘时使用这张已采用的去码图作为画风参考" : "先重绘当前图并采用一版，才能设为本组基准"}
                disabled={actionsDisabled || !activeSaved || activeIsReference}
                onClick={() => stageImageEdits(members, image => ({ reference: image.id === active.id, group, manualGroup: true }))}>
                {activeIsReference ? "已是本组基准" : activeSaved ? "设置为本组基准" : "需要先采用一版"}
              </button>
              {activeSaved && <button type="button" className="unity-btn" disabled={actionsDisabled || testing}
                data-tooltip={withdrawalStaged ? "取消尚未保存的撤回" : "保存后撤回采用，并从下次生成的补丁中移除"}
                onClick={toggleAdoptionWithdrawal}>{withdrawalStaged ? "取消撤回" : "撤回采用"}</button>}
              {draftReference && !activeIsReference && <span>参考图 {draftReference.name}</span>}
            </div>
          </div>
        }
        notice={<>{draftReason && <p className="visually-hidden" role="status">{draftReason}</p>}
           {active && !visible.includes(active) && <button type="button" className="unity-btn" onClick={() => {
             setImageFilters(allGameImageFilters);
             if (listView === "browse") {
               const index = currentScope.indexOf(active);
               if (index >= 0) setGalleryPage(Math.floor(index / mosaicGalleryPageSize));
             } else {
               const keyOf = (image: UnityImage) => listView === "picture" ? pictureGroupKey(resultFor(rows, image)) : imageStatus(image);
               const target = keyOf(active);
               const index = currentScope.filter(image => keyOf(image) === target).indexOf(active);
               setCollapsed(previous => ({ ...previous, [target]: false }));
               if (index >= 0) setGroupPages(previous => ({ ...previous, [target]: Math.floor(index / mosaicGroupPageSize) }));
             }
           }}>定位到列表</button>}
           {confirmationNotice && <p className="hint" role="status">{confirmationNotice}</p>}
          {activeFailure ? <p className={activeRetry ? "hint" : "game-mosaic-error"}>
            {activeRetry && "重试中 · 上次"}{activeFailure}
          </p> : activeResult?.review && <p className="hint">{activeResult.review}</p>}</>}
        footer={packageOnly ? undefined :
          <div className="unity-image-actions">
            <button className="unity-btn" disabled={testing || actionsDisabled || !!draftReason || (storage ? saved.length === included.length : !saved.length)} title={testTitle} onClick={() => void patch(false)}>
              {storage ? `纳入生成 · ${saved.length - included.length} 张` : `应用已采用去码图 · ${saved.length} 张`}
            </button>
            <button className="unity-btn" disabled={testing || actionsDisabled || !!draftReason || (storage ? !included.length : !selected.length)} title={testTitle} onClick={() => void patch(true)}>
              {storage ? "从生成清单移除" : "撤销本组所选"}
            </button>
          </div>
        } />
    </MosaicGroupTree>
  </section>;
}
