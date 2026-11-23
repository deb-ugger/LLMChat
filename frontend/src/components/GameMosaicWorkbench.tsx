import { publishMosaicBenchmarkSource } from "../gameMosaicBenchmark";
import { mosaicInitialScreening, mosaicManualStatuses, mosaicProcessingError, mosaicScreeningStatus, mosaicStatusLabels, type MosaicStatus } from "../gameMosaicStatus";
import { api } from "../api";
import { requestGameModelJson } from "../gameModelRequest";
import { gameAvailableModels } from "./GameTranslationTabs";
import { refineMosaicBatch, mosaicReviewKey, matchesMosaicReviewKey, mergeMosaicErrorUpdates, mosaicErrorUpdateEvent, mosaicRowsStorageKey, readMosaicRows, readMosaicReviews, savedMosaicScan, clearMosaicReviews, type MosaicErrorUpdate } from "../gameMosaicRefine";
import { createContext, useContext, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "../api";
import { beginGameStep, clearGamePerformance, finishGameStep, recordGameCacheHit, recordGameRequest, gameStepSelections, measureGameAsync, reportGameStepItems, stepPerformance, sumModelServiceTiming, type StepPerformance } from "../gameModelPerformance";
import { readMosaicSettings, saveMosaicSettings, clearGameDetectorFile, gameDetectorFile, openDeploymentDetector, loadMosaicDetector, matchesMosaicDetectorKey, mosaicDetectorKey, mosaicInputKey, mosaicModelLabels, redrawMosaic, createMosaicGridScanner, type MosaicModel } from "../gameMosaic";
import type { UnityImage } from "../unityOffline";
import { deploymentMetricScope, measureDeploymentStage } from "../unityWorkflow";
import { showAppNotice } from "./AppNotice";
import { useGameActionConfirm } from "./GameActionConfirm";
import { usePersistedModelFilter } from "./ModelFilterSelect";
import { benchmarkBlockingReason, isBenchmarkRunning, useBenchmarkProgress, useBenchmarkRunning, useFormalWorkflowActivity } from "../benchmark/benchmarkRunner";
import { GameImageListPagination } from "./GameImageBrowserLayout";
import { type GameProgressState } from "./GameStepProgress";
import { SearchHighlight } from "./SearchHighlight";
import { UnityDescriptionSelect } from "./UnityDescriptionSelect";
import { getFixedMenuPoint } from "../viewportLayout";
import { MosaicGroupTree, mosaicStatusPageSize } from "./game-mosaic/MosaicGroupTree";
import { canResumeMosaicRedraw, clearReviewResult, defaultResult, keepText, performMosaicReviews, refineMovementFor,
  restoreDefaultSelection, resultFor, reviewedResult, runAutomaticMosaic, runMosaicBatch, runMosaicRedraw, runMosaicRefine,
  runMosaicScreen, sameReview, stopMosaicBatch } from "./game-mosaic/mosaicBatchRunner";
import { MosaicStepCards } from "./game-mosaic/MosaicStepCards";
import { MosaicPreview } from "./game-mosaic/MosaicPreview";
import { confirmationBoxes, saveGameImageConfirmation, supportsGameImageConfirmation, useImageConfirmationNotice } from "../gameImageConfirmation";
import { useMosaicMasks } from "./game-mosaic/useMosaicMasks";
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

function beginMosaicStepUsage(gamePath: string, step: MosaicStep, resume: boolean, refresh = () => {}): MosaicStepUsage {
  const scope = mosaicMetricScope(gamePath,step);
  const previous = resumableMosaicMetrics(gamePath,step,resume);
  if (!previous) clearGamePerformance(scope,[step]);
  beginGameStep(scope, step);
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
    finish: (completed: boolean) => finishGameStep(scope, completed),
  };
}
export const GameMosaicCompletionContext = createContext<((completed: boolean) => void) | null>(null);

export type { GameMosaicDeploymentHandle, MosaicCandidateIndex } from "./game-mosaic/mosaicWorkbenchTypes";

function mosaicStatus(row: Result, included: boolean): MosaicStatus {
  if (row.manualStatus && !row.saved) return row.manualStatus;
  const state = mosaicScreeningStatus(row);
  return state === "failed" || !row.saved ? state : included ? "included" : "confirmed";
}
const detectorLabels = { grid: "方格规则", anime: "高召回初筛（分类＋定位）" };
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

function MosaicOriginalThumbnail({ image, read }: { image: UnityImage; read: Props["read"] }) {
  const thumbnail = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"waiting" | "ready" | "error">("waiting");

  useEffect(() => {
    const canvas = thumbnail.current!;
    const controller = new AbortController();
    setState("waiting");

    async function load() {
      try {
        const blob = await read(image, controller.signal);
        if (controller.signal.aborted) return;
        const scale = Math.min(1, 180 / Math.max(image.width, image.height));
        const bitmap = await createImageBitmap(blob, {
          resizeWidth: Math.max(1, Math.round(image.width * scale)),
          resizeHeight: Math.max(1, Math.round(image.height * scale)),
        });
        try {
          if (controller.signal.aborted) return;
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
          setState("ready");
        } finally { bitmap.close(); }
      } catch {
        if (!controller.signal.aborted) setState("error");
      }
    }

    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void load();
    });
    observer.observe(canvas.parentElement!);
    return () => { observer.disconnect(); controller.abort(); };
  }, [image, read]);

  return <span className="game-mosaic-original-thumbnail">
    <canvas ref={thumbnail} aria-hidden="true" hidden={state !== "ready"} />
    {state === "error" && <span>缩略图无法读取</span>}
  </span>;
}

function MosaicOriginalGallery({ images, activeId, query, read, checked, status, disabled, onPreview, onCheck }: {
  images: readonly UnityImage[];
  activeId?: string;
  query: string;
  read: Props["read"];
  checked: (image: UnityImage) => boolean;
  status: (image: UnityImage) => MosaicStatus;
  disabled: boolean;
  onPreview: (id: string) => void;
  onCheck: (images: readonly UnityImage[], checked: boolean) => void;
}) {
  const [selectedIds, setSelectedIds] = useState(() => new Set<string>());
  const [page, setPage] = useState(0);
  const grid = useRef<HTMLUListElement>(null);
  const pages = Math.max(1, Math.ceil(images.length / 24));
  const currentPage = Math.min(page, pages - 1);
  const visible = images.slice(currentPage * 24, (currentPage + 1) * 24);
  const chosen = images.filter(image => selectedIds.has(image.id));
  const selectPage = () => setSelectedIds(new Set(visible.map(image => image.id)));

  function applyCheck(value: boolean) {
    onCheck(chosen, value);
    setSelectedIds(new Set());
  }

  function changePage(next: number) {
    setPage(next);
    if (grid.current) grid.current.scrollTop = 0;
  }

  return <section className="game-mosaic-original-browser" aria-label="原图批量浏览"
    onKeyDown={event => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a" ||
          (event.target as HTMLElement).closest("input, select, textarea, [contenteditable]")) return;
      event.preventDefault();
      selectPage();
    }}>
    <div className="game-mosaic-original-browser-controls">
      <div className="game-mosaic-original-selection">
        <span role="status">选中 {chosen.length} 张</span>
        <button type="button" className="unity-btn" disabled={!visible.length}
          onClick={selectPage}>全选本页</button>
        <button type="button" className="unity-btn" disabled={disabled || !chosen.some(image => !checked(image))}
          onClick={() => applyCheck(true)}>批量勾选</button>
        <button type="button" className="unity-btn" disabled={disabled || !chosen.some(checked)}
          onClick={() => applyCheck(false)}>批量取消勾选</button>
      </div>
    </div>
    <ul ref={grid} className="game-mosaic-original-grid">
      {visible.map(image => <li key={image.id}>
        <button type="button" className="game-mosaic-original-tile" aria-pressed={selectedIds.has(image.id)}
          aria-current={image.id === activeId || undefined}
          data-tooltip={image.file + "\n" + image.width + " × " + image.height + " · " + mosaicStatusLabels[status(image)]}
          onClick={event => {
            const additive = event.ctrlKey || event.metaKey;
            setSelectedIds(previous => {
              if (!additive) return new Set([image.id]);
              const next = new Set(previous);
              if (next.has(image.id)) next.delete(image.id); else next.add(image.id);
              return next;
            });
            onPreview(image.id);
          }}>
          <MosaicOriginalThumbnail image={image} read={read} />
          <strong><SearchHighlight text={image.name} query={query} /></strong>
          <small>{image.width} × {image.height}</small>
          <small>{mosaicStatusLabels[status(image)]} · {checked(image) ? "已勾选" : "未勾选"}</small>
        </button>
      </li>)}
      {!visible.length && <li className="hint">没有符合筛选条件的图片。</li>}
    </ul>
    <GameImageListPagination label="原图分页" page={currentPage} pages={pages} onPage={changePage} />
  </section>;
}

export function GameMosaicWorkbench({ settings, gamePath, images, backupMode, storage, read, prepareSources, controls, visible: paneVisible = true, disabled = false, onBusy, deploymentHandle, packageOnly = false, onDeploymentSelectionChange }: Props & { packageOnly?: boolean; onDeploymentSelectionChange?: (ids: string[]) => void }) {
  const task = useRef<AbortController | null>(null);
  const onCompletionChange = useContext(GameMosaicCompletionContext);
  const savedKey = mosaicRowsStorageKey(gamePath);
  const [rows, setRows] = useState<Results>(() => {
    try {
      const saved = readMosaicRows<Result>(gamePath);
      for (const id of Object.keys(saved)) saved[id] = restoreDefaultSelection(saved[id]);
      return saved;
    } catch { return {}; }
  });
  const latestRows = useRef(rows);
  latestRows.current = rows;
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
  const [groupPages, setGroupPages] = useState<Partial<Record<MosaicStatus, number>>>({});
  const [collapsed, setCollapsed] = useState<Partial<Record<MosaicStatus, boolean>>>(() =>
    Object.fromEntries(Object.keys(mosaicStatusLabels).map(id => [id, id !== "failed"])));
  const listId = useId();
  const filterMenu = useRef<HTMLDivElement>(null);
  const [configured, setConfigured] = useState<MosaicStep | null>(null);
  const [groupMenu, setGroupMenu] = useState<MosaicGroupMenu | null>(null);
  const closeGroupMenu = useCallback(() => setGroupMenu(null), []);
  const [preferences, setPreferences] = useState(() => readMosaicSettings(gamePath));
  const { scope, detector: detectorKind, model, steps, protect } = preferences;
  const changePreferences = (patch: Partial<typeof preferences>) => saveMosaicSettings(gamePath, { ...preferences, ...patch });
  useEffect(() => {
    const refresh = () => setPreferences(readMosaicSettings(gamePath));
    refresh(); window.addEventListener("game-mosaic-settings", refresh);
    return () => window.removeEventListener("game-mosaic-settings", refresh);
  }, [gamePath]);
  const [detectorFile, setDetectorFile] = useState(() => gameDetectorFile(gamePath));
  const [sceneFilter, setSceneFilter] = useState(false);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [activeId, setActiveId] = useState<string | null>("");
  const [browseOriginals, setBrowseOriginals] = useState(false);
  const [busy, setBusy] = useState("");
  const [progressStep, setProgressStep] = useState<MosaicStep>();
  const [stepRuns, setStepRuns] = useState<Partial<Record<MosaicStep, StepRun>>>({});
  const pendingRedraw = useRef<RedrawPlan | null>(null);
  const lastReview = useRef<MosaicReviewSession | null>(null);
  const [refineRetries, setRefineRetries] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [, refreshElapsed] = useState(0);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState<ImagePreview>();
  const [approved, setApproved] = useState<ImagePreview>();
  const [candidates, setCandidates] = useState<Record<string, MosaicCandidate>>({});
  const [preferredResult, setPreferredResult] = useState<"saved" | MosaicModel>();
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
  const matches = useMemo(() => needle ? scoped.filter(image => (image.name + " " + image.file).toLowerCase().includes(needle)) : scoped, [needle, scoped]);
  const imageGroup = useMemo(() => {
    const grouped = new Map<string, UnityImage[]>();
    for (const image of usable) {
      const key = resultFor(rows, image).group || image.id;
      const listed = grouped.get(key);
      if (listed) listed.push(image); else grouped.set(key, [image]);
    }
    return grouped;
  }, [rows, usable]);
  const groupAnchor = sceneFilter ? usable.find(image => image.id === activeId) ?? matches[0] : undefined;
  const scopedGroup = groupAnchor && (resultFor(rows, groupAnchor).group || groupAnchor.id);
  const currentScope = scopedGroup ? imageGroup.get(scopedGroup) ?? [] : matches;
  const imageStatus = useCallback((image: UnityImage) => mosaicStatus(resultFor(rows, image),
    !!storage?.index[image.id]?.included), [rows, storage?.index]);
  const isRefineRetrying = (image: UnityImage) => refineRetries.get(image.id) === image.sourceHash;
  const visible = useMemo(() => failuresOnly ? currentScope.filter(image => imageStatus(image) === "failed") : currentScope,
    [currentScope, failuresOnly, imageStatus]);
  const { ordered, groups } = useMemo(() => {
    const grouped = new Map<MosaicStatus, UnityImage[]>();
    for (const image of visible) {
      const status = imageStatus(image);
      const list = grouped.get(status);
      if (list) list.push(image);
      else grouped.set(status, [image]);
    }
    const groups = new Map<MosaicStatus, UnityImage[]>();
    for (const status of Object.keys(mosaicStatusLabels) as MosaicStatus[]) {
      const images = grouped.get(status);
      if (images?.length) groups.set(status, images);
    }
    return { groups, ordered: [...groups].filter(([id]) => !collapsed[id]).flatMap(([id, images]) => images.map(image => ({ id, image }))) };
  }, [visible, imageStatus, collapsed]);
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
  const active = activeId === null ? undefined : visible.find(image => image.id === activeId) ?? ordered[0]?.image;
  const previewedImage = useRef(active);
  previewedImage.current = active;
  const isPreviewing = (image: UnityImage) => previewedImage.current?.id === image.id && previewedImage.current.sourceHash === image.sourceHash;
  const activeResult = active && resultFor(rows, active);
  const group = active && (activeResult?.group || active.id);
  const members = group ? imageGroup.get(group) || [] : [];
  const reference = members.find(image => resultFor(rows, image).reference && resultFor(rows, image).saved);
  const actionsDisabled = !!busy || disabled;
  const masks = useMosaicMasks({ gamePath, active, activeResult, members, usable, rows, candidates,
    getRows: () => latestRows.current, hasStorage: !!storage, blocked: () => !!task.current || disabled,
    actionsDisabled, commit: commitMaskEdits });

  function selectPreview(id: string) {
    setActiveId(id);
    if (!busy && !disabled) setError("");
  }

  const selected = members.filter(image => resultFor(rows, image).checked);
  const saved = selected.filter(image => resultFor(rows, image).saved);
  const included = saved.filter(image => storage?.index[image.id]?.included);
  const activeSaved = !!activeResult?.saved;
  const confirmationNotice = useImageConfirmationNotice(gamePath, active, "mosaic", activeSaved && !storage && !busy);
  const counts = useMemo(() => visible.reduce((total, image) => {
    const row = resultFor(rows, image);
    if (row.checked) total.checked++;
    if (row.saved && !storage?.index[image.id]?.included) total.saved++;
    return total;
  }, { checked: 0, saved: 0 }), [visible, rows, storage?.index]);

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
    try { localStorage.setItem(savedKey, JSON.stringify(rows)); }
    catch { showAppNotice("无法保存图片去码筛选记录", "error"); }
  }, [savedKey, rows]);

  function replaceRows(next: Results) {
    localStorage.setItem(savedKey, JSON.stringify(next));
    setRows(next);
  }

  function resetDerivedRedraw(ids: ReadonlySet<string>) {
    const redraw = pendingRedraw.current;
    const affected = !!redraw?.targets.some(({ image }) => ids.has(image.id)) ||
      Object.keys(candidates).some(id => ids.has(id));
    if (redraw) {
      const targets = redraw.targets.filter(({ image }) => !ids.has(image.id));
      pendingRedraw.current = targets.length ? { ...redraw, targets } : null;
    }
    setCandidates(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !ids.has(id))));
    if (active && ids.has(active.id)) setPreferredResult(undefined);
    return affected && !pendingRedraw.current && !Object.keys(candidates).some(id => !ids.has(id));
  }

  const candidatePath = (image: UnityImage) => API_BASE + "/api/game-images/mosaic?" +
    new URLSearchParams({ gamePath, id: image.id, sourceHash: image.sourceHash });
  const renderedMosaics = useRef(new WeakMap<Blob, Pick<Parameters<typeof redrawMosaic>[0], "boxes" | "keep" | "model">>());
  const redrawWithConfirmation = async (input: Parameters<typeof redrawMosaic>[0]) => {
    const clone = (rect: typeof input.boxes[number]): typeof input.boxes[number] => [...rect];
    const evidence = { boxes: input.boxes.map(clone), keep: input.keep.map(clone), model: input.model };
    const blob = await redrawMosaic({ ...input, ...evidence });
    renderedMosaics.current.set(blob, evidence);
    return blob;
  };

  const saveCandidate = async (image: UnityImage, blob: Blob, signal: AbortSignal) => {
    const metadata = renderedMosaics.current.get(blob);
    if (!metadata && supportsGameImageConfirmation(image)) throw new Error("候选缺少重绘框，请重新生成后采用");
    await mosaicResponse(await fetch(candidatePath(image), { method: "POST", headers: { "Content-Type": "image/png" }, body: blob, signal }));
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
    void fetch(API_BASE + "/api/game-images/mosaic-status", {
      method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gamePath }),
    }).then(mosaicResponse).then(response => response.json() as Promise<{ candidates: Record<string, string> }>).then(({ candidates }) => {
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
        read, performReviews, openDetector: (signal, timingScope) => openDeploymentDetector(gamePath, preferences, signal, timingScope),
        savedMosaicScan, redrawMosaic: redrawWithConfirmation, reportGameStepItems, recordGameCacheHit, measureGameAsync, update, setProgress, clearReviews,
        readExisting: async signal => {
          const status = await mosaicResponse(await fetch(API_BASE + "/api/game-images/mosaic-status", {
            method: "POST", signal, headers: { "Content-Type":"application/json" }, body: JSON.stringify({ gamePath })
          }));
          const { candidates } = await status.json() as { candidates: Record<string, string> };
          return candidates;
        },
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

  function setMosaicChecked(images: readonly UnityImage[], checked: boolean) {
    setRows(previous => {
      const next = { ...previous };
      for (const image of images) {
        const row = resultFor(previous, image);
        next[image.id] = { ...row, checked, manualChecked: true };
      }
      return next;
    });
  }

  function moveToStatus(value: string) {
    if (!active || !activeResult || activeSaved || actionsDisabled) return;
    const manualStatus = mosaicManualStatuses.find(status => status === value);
    if (!manualStatus && value !== "auto") return;
    const target = mosaicStatus({ ...activeResult, manualStatus }, false);
    const index = currentScope.filter(image => image.id === active.id || imageStatus(image) === target)
      .findIndex(image => image.id === active.id);
    update(active, { manualStatus });
    setActiveId(active.id);
    setFailuresOnly(false);
    setCollapsed(previous => ({ ...previous, [target]: false }));
    if (index >= 0) setGroupPages(previous => ({ ...previous, [target]: Math.floor(index / mosaicStatusPageSize) }));
  }

  function run(label: string, work: MosaicBatchWork, step?: MosaicBatchStep) {
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
        setBusy(label); setProgress(label); setError("");
      },
      beginUsage: (id, resume, refresh) => beginMosaicStepUsage(gamePath, id, resume, refresh),
      setProgress, setError,
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

  const detectorKey = mosaicDetectorKey(detectorKind, detectorFile);
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
  const reviewSessionKey = JSON.stringify([reviewKey, detectorKey, scope, needle, scopedGroup]);
  const previousReview = lastReview.current?.key === reviewSessionKey ? lastReview.current : undefined;
  const isReviewed = (row: Result) => matchesMosaicReviewKey(row.refined, reviewKey) && !row.refineQuickExcluded && !row.refineError;
  const checkedReviewScope: UnityImage[] = [];
  const pendingReview: UnityImage[] = [];
  let reviewedCount = 0;
  for (const image of currentScope) {
    const row = resultFor(rows,image);
    if ((!row.scanned && !row.refined && !row.refineError) || row.saved || row.manualBoxes) continue;
    if (row.checked) checkedReviewScope.push(image);
    if (isReviewed(row)) {
      if (row.checked || row.beforeRefine?.checked && !row.manualChecked ||
          previousReview?.images.get(image.id) === image.sourceHash) reviewedCount++;
    } else if (row.checked) pendingReview.push(image);
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
      replaceRows, clearReviews, resetRedraw, performReviews, setProgress, setError,
      trackReview: session => { lastReview.current = session; },
    }), {id:"refine",total:restart ? targets.length : reviewTotal,completed:initial,summary:preferences.refineModel || "qwen3.5:latest",
      resume: !restart});
  }
  const lastScreen = useRef<{ scope: readonly UnityImage[]; detector: string } | null>(null);
  const screenTargets: UnityImage[] = [];
  const remaining: UnityImage[] = [];
  let screenedCount = 0, otherDetectorCount = 0, hasScreenFailure = false;
  for (const image of currentScope) {
    const row = resultFor(rows, image);
    const initial = mosaicInitialScreening(row);
    if (row.checked) screenTargets.push(image);
    if (initial.scanned && !initial.reason && matchesMosaicDetectorKey(initial.detector, detectorKey)) {
      screenedCount++;
      continue;
    }
    if (initial.scanned && !initial.reason) otherDetectorCount++;
    if (initial.reason) hasScreenFailure = true;
    if (row.checked) remaining.push(image);
  }
  const screenTotal = screenedCount + remaining.length;

  function screen(restart = remaining.length === 0 || (screenedCount === 0 && otherDetectorCount > 0)) {
    const targets = restart ? screenTargets : remaining;
    if (!targets.length) return;
    lastScreen.current = { scope: currentScope, detector: detectorKey };
    const initial = restart ? 0 : screenedCount;
    void run("筛选打码区域", (signal, report, usage) => runMosaicScreen({
      targets, usable, rows, initial, detectorKind, detectorKey, detectorFile,
      modelName: detectorKind !== "grid" && detectorFile ? detectorFile.name : detectorLabels[detectorKind],
      concurrency: preferences.concurrency,
    }, signal, report, usage, {
      replaceRows, setRows, clearReviews, resetRedraw, read, prepareSources, loadMosaicDetector, createMosaicGridScanner, setProgress,
      onDevice: device => setStepRuns(previous => previous.screen ? { ...previous, screen: { ...previous.screen, device } } : previous),
    }), { id: "screen", total: restart ? targets.length : screenTotal, completed: initial, summary: detectorLabels[detectorKind], resume: !restart });
  }
  function commitMaskEdits(edits: MosaicMaskCommit) {
    if (edits.rows) {
      try {
        replaceRows(edits.rows);
        latestRows.current = edits.rows;
      } catch {
        showAppNotice("无法保存图片去码筛选记录", "error");
        return false;
      }
    }
    setCandidates(previous => {
      const next = { ...previous };
      for (const { id, candidate } of edits.candidates) {
        if (candidate) next[id] = candidate; else delete next[id];
      }
      return next;
    });
    return true;
  }

  function startRedraw(plan: RedrawPlan, resume = false) {
    if (resume && !canResumeMosaicRedraw(plan, usable, rows, protect)) {
      pendingRedraw.current = null;
      setStepRuns(previous => ({ ...previous, redraw: undefined }));
      setError("原图、蒙版或文字保护范围已变更，请按当前选择重绘");
      return;
    }
    const summary = plan.models.map(engine => mosaicModelLabels[engine]).join("、");
    const total = plan.targets.length;
    const initial = plan.targets.filter(target => !target.pending.size).length;
    void run("生成去码候选", (signal, report, usage) => runMosaicRedraw(plan, initial, signal, report, usage, {
      read, readSaved, mosaicInputKey, redrawMosaic: redrawWithConfirmation, recordGameCacheHit, update, setProgress, setError,
      setPending: next => { pendingRedraw.current = next; },
      onCandidate: (image, engine, blob, seconds) => {
        setCandidates(previous => {
          const current = previous[image.id]?.revision === image.sourceHash ? previous[image.id] : undefined;
          return { ...previous, [image.id]: { revision: image.sourceHash,
            values: { ...current?.values, [engine]: blob }, seconds: { ...current?.seconds, [engine]: seconds } } };
        });
        if (isPreviewing(image)) setPreferredResult(engine);
      },
    }), { id: "redraw", total, completed: initial, summary, resume });
  }
  function generate(targets: UnityImage[], models: MosaicModel[]) {
    const usableTargets = targets.filter(image => resultFor(rows, image).boxes.length);
    if (!usableTargets.length) return;
    if (preferences.refine !== false && usableTargets.some(image => {
      const row = resultFor(rows,image);
      return !row.saved && !row.manualBoxes && !isReviewed(row);
    })) {
      setError("请先完成视觉复筛，再重绘所选图片");
      return;
    }
    const seed = parseInt((group || "ab").replace(/[^a-f0-9]/gi, "").slice(-8) || "1", 16);
    startRedraw({ targets: usableTargets.map(image => ({ image, boxes: resultFor(rows,image).boxes,
      keep: keepText(image,protect), pending: new Set(models) })), models, steps, seed, reference });
  }

  function approve(image: UnityImage, blob: Blob) {
    void run("保存已采用去码图", async signal => {
      if (storage) await storage.save(image, blob, signal);
      else await saveCandidate(image, blob, signal);
      masks.clearUndo();
      update(image, { saved: true, checked: true, discardedHash: undefined, redrawError: undefined });
      if (isPreviewing(image)) {
        setApproved({ id: image.id, revision: image.sourceHash, blob });
        setPreferredResult("saved");
      }
      setProgress("已保存 · " + image.name);
    });
  }

  async function patch(undo: boolean) {
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
  const canClear = canClearStep(screenStatus.state) || canClearRefine || canClearRedraw;
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
  const redrawGroup = selected.filter(image => image.id !== reference?.id && resultFor(rows, image).boxes.length);
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
    const current = latestRows.current;
    const next = dissolveIndependentGroup(current, key);
    if (next === current) return;
    try { replaceRows(next); }
    catch { showAppNotice("无法保存分组修改", "error"); return; }
    if (scopedGroup === key) {
      setSceneFilter(false);
      setGroupPages({});
    }
    showAppNotice("已删除独立组");
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

  async function clearRedraw() {
    if (actionsDisabled || !canClearRedraw) return;
    if (!await confirmation.confirm("清理未采用的重绘候选和重绘进度？已采用的去码图会保留。", {
      title: "清理重绘", okLabel: "清理",
    }) || task.current) return;

    const next = Object.fromEntries(Object.entries(rows).map(([id, row]) =>
      [id, row.redrawError ? { ...row, redrawError: undefined } : row]));
    try { replaceRows(next); }
    catch { showAppNotice("无法保存图片去码筛选记录", "error"); return; }
    pendingRedraw.current = null;
    setCandidates({});
    setPreferredResult(undefined);
    clearStepProgress("redraw");
    showAppNotice("已清理重绘");
  }

  async function clearTask() {
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

    const next: Results = {};
    for (const image of usable) {
      const entry = storage?.index[image.id];
      if (!storage && resultFor(rows, image).saved) {
        next[image.id] = { ...defaultResult(image), discardedHash: image.sourceHash };
        continue;
      }
      if (entry?.source !== image.sourceHash) continue;
      // The cache has no selective deletion endpoint. Remember which confirmation was cleared,
      // while keeping results already in the patch index available.
      next[image.id] = entry.included ? { ...defaultResult(image), saved: true }
        : { ...defaultResult(image), discardedHash: entry.hash };
    }
    try { replaceRows(next); }
    catch { showAppNotice("无法保存图片去码筛选记录", "error"); return; }
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
    setSceneFilter(false);
    setActiveId(null);
    setSource(undefined);
    setApproved(undefined);
    setCandidates({});
    setPreferredResult(undefined);
    masks.resetDrawing();
    showAppNotice("已清理图片去码任务");
  }

  const busyReason = busy ? "正在处理，先中止或等待" : disabled ? "请等待其他工程操作完成" : undefined;
  const { failureCount, unresolvedRefineFailures, retryCount } = useMemo(() => {
    let failureCount = 0, unresolvedRefineFailures = 0, retryCount = 0;
    for (const image of scoped) {
      const row = resultFor(rows, image);
      if (imageStatus(image) === "failed") failureCount++;
      if (row.refineError) {
        unresolvedRefineFailures++;
        if (refineRetries.get(image.id) === image.sourceHash) retryCount++;
      }
    }
    return { failureCount, unresolvedRefineFailures, retryCount };
  }, [scoped, rows, imageStatus, refineRetries]);
  const activeFailure = mosaicProcessingError(activeResult);
  const activeRetry = active && activeResult?.refineError && isRefineRetrying(active);
  const toggleFailureFilter = () => {
    setFailuresOnly(previous => !previous);
    setCollapsed(previous => ({ ...previous, failed: false }));
    setQuery(""); setSceneFilter(false); setGroupPages({}); setActiveId("");
  };
  const redrawReason = testTitle ?? busyReason ?? (!activeResult?.boxes.length ? "先在图上框选打码区域" : undefined);
  const batchReason = testTitle ?? busyReason ?? (!pausedRedraw && !redrawGroup.length ? "先勾选本组中已框选蒙版的待重绘图片" : undefined);
  if (deploymentHandle && !paneVisible) return null;
  const hiddenStyle = paneVisible ? undefined : { display: "none" };
  const screenSummary = detectorKind !== "grid" && detectorFile
    ? "自定义检测 · " + detectorFile.name : detectorLabels[detectorKind];
  const cardMeasurement = (id: MosaicStep) => {
    const formalMeasurement = mosaicCardMetrics(gamePath, id);
    return { formalMeasurement, measured: groupMosaicModels(formalMeasurement) };
  };
  return <section className="unity-offline-workbench unity-image-workbench game-mosaic-workbench" aria-label="图片去码" hidden={!paneVisible} style={hiddenStyle}>
    {confirmation.dialog}
    {createPortal(<MosaicStepCards paneVisible={paneVisible} hiddenStyle={hiddenStyle} configured={configured} onConfigure={setConfigured}
      busy={!!busy} aborting={task.current?.signal.aborted} actionsDisabled={actionsDisabled} onStop={id => stopMosaicBatch(task.current, id, setProgress)} preferences={preferences} changePreferences={changePreferences} detectorLabels={detectorLabels} reviewModels={reviewModels}
      testing={testing} testTitle={testTitle} benchmarkProgress={benchmarkProgress} measurements={{
        screen: cardMeasurement("screen"), refine: cardMeasurement("refine"), redraw: cardMeasurement("redraw"),
      }} now={performance.now()} progress={progress} error={error}
      screen={{
        status: screenStatus, summary: screenSummary, action: screenAction, targetCount: screenTargets.length, screenedCount,
        remainingCount: remaining.length, otherDetectorCount, canClear, detectorFile,
        changeScope: scope => { changePreferences({ scope }); setGroupPages({}); },
        chooseDetectorFile: file => setDetectorFile(gameDetectorFile(gamePath, file)),
        useBuiltInDetector: () => { clearGameDetectorFile(gamePath); setDetectorFile(undefined); },
        start: screen, clear: clearTask,
      }} refine={{
        status: refineStatus, targetCount: checkedReviewScope.length, pendingCount: pendingReview.length, reviewedCount,
        wasStopped: stepRuns.refine?.state === "stopped", canClear: canClearRefine, modelFilter: refineModelFilter,
        setModelFilter: setRefineModelFilter, guardFilter: refineGuardFilter, setGuardFilter: setRefineGuardFilter,
        start: refine, clear: clearRefine,
      }} redraw={{
        status: stepRuns.redraw, targetCount: redrawGroup.length, remainingCount: redrawRemaining, paused: !!pausedRedraw,
        canClear: canClearRedraw, batchReason,
        start: () => pausedRedraw ? startRedraw(pausedRedraw, true) : generate(redrawGroup, [model]), clear: clearRedraw,
      }} unresolvedRefineFailures={unresolvedRefineFailures} retryCount={retryCount} />, controls)}
    <MosaicGroupTree listId={listId} filterMenu={filterMenu} filters={{ query, needle, scope, sceneFilter, failuresOnly }}
      onSceneFilterChange={checked => {
        if (checked && active) setActiveId(active.id);
        setSceneFilter(checked);
        setGroupPages({});
      }}
      onQueryChange={value => { setQuery(value); setActiveId(""); setSceneFilter(false); setGroupPages({}); }}
      onToggleFailureFilter={toggleFailureFilter} counts={{ ...counts, visible: visible.length, failed: failureCount }}
      active={active} groups={groups} ordered={ordered} refineChanges={refineChanges} groupPages={groupPages} setGroupPages={setGroupPages}
      collapsed={collapsed} setCollapsed={setCollapsed} browseOriginals={browseOriginals} setBrowseOriginals={setBrowseOriginals}
      originalGallery={<MosaicOriginalGallery images={visible} activeId={active?.id}
          query={needle} read={read} status={imageStatus} checked={image => resultFor(rows, image).checked}
          disabled={actionsDisabled} onPreview={selectPreview} onCheck={setMosaicChecked} />}
      actionsDisabled={actionsDisabled} getRow={image => resultFor(rows, image)} imageStatus={imageStatus} refineMovementFor={refineMovementFor}
      isRefineRetrying={isRefineRetrying} selectPreview={selectPreview} setMosaicChecked={setMosaicChecked}
      groupMenu={groupMenu} openGroupMenu={openGroupMenu} closeGroupMenu={closeGroupMenu} deleteGroup={deleteGroup}>
      <MosaicPreview active={active} activeResult={activeResult} visibleCount={visible.length} paneVisible={paneVisible}
        source={source} approved={approved} activeSaved={activeSaved} candidate={active && candidates[active.id]}
        preferredResult={preferredResult} setPreferredResult={setPreferredResult} masks={masks}
        actionsDisabled={actionsDisabled} busyReason={busyReason} redrawReason={redrawReason} testTitle={testTitle} model={model}
        onRedraw={models => { if (active) generate([active], models); }}
        onApprove={blob => { if (active) approve(active, blob); }}
        header={active &&
          <div className="unity-image-actions">
            <strong data-tooltip={active.file}><SearchHighlight text={active.name} query={needle} /></strong>
            <div className="unity-image-button-group">
              <span data-tooltip={isIndependentGroup(group) ? "右键管理当前独立组" : undefined}
                onContextMenu={event => openGroupMenu(event, group)}>{members.length} 张 · 本组已选 {selected.length} 张</span>
              <div className="game-mosaic-group-picker">
                <UnityDescriptionSelect label="移动到处理分组…" value="" menuWidth={188} disabled={actionsDisabled || activeSaved}
                  choices={[
                    ...mosaicManualStatuses.filter(status => status !== imageStatus(active))
                      .map(status => ({ value: status, label: mosaicStatusLabels[status] })),
                    ...(activeResult?.manualStatus ? [{ value: "auto", label: "恢复自动分组" }] : []),
                  ]}
                  onChange={moveToStatus} />
              </div>
              <button className="unity-btn" data-tooltip={activeSaved ? "组内重绘时使用这张已采用的去码图作为画风参考" : "先重绘当前图并采用一版，即可将结果用作组内画风参考"} disabled={actionsDisabled || !activeSaved || reference?.id === active.id} onClick={() => setRows(previous => {
                const next = { ...previous };
                for (const image of members) next[image.id] = { ...resultFor(previous, image), reference: image.id === active.id, group, manualGroup: true };
                return next;
              })}>{reference?.id === active.id ? "本组参考图" : "用作本组画风参考"}</button>
              {reference && <span>参考图 {reference.name}</span>}
            </div>
          </div>
        }
        notice={<>{confirmationNotice && <p className="hint" role="status">{confirmationNotice}</p>}
          {activeFailure ? <p className={activeRetry ? "hint" : "game-mosaic-error"}>
            {activeRetry && "重试中 · 上次"}{activeFailure}
          </p> : activeResult?.review && <p className="hint">{activeResult.review}</p>}</>}
        footer={packageOnly ? undefined :
          <div className="unity-image-actions">
            <button className="unity-btn" disabled={testing || actionsDisabled || (storage ? saved.length === included.length : !saved.length)} title={testTitle} onClick={() => void patch(false)}>
              {storage ? `纳入生成 · ${saved.length - included.length} 张` : `应用已采用去码图 · ${saved.length} 张`}
            </button>
            <button className="unity-btn" disabled={testing || actionsDisabled || (storage ? !included.length : !selected.length)} title={testTitle} onClick={() => void patch(true)}>
              {storage ? "从生成清单移除" : "撤销本组所选"}
            </button>
          </div>
        } />
    </MosaicGroupTree>
  </section>;
}
