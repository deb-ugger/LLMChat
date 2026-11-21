import { publishMosaicBenchmarkSource } from "../gameMosaicBenchmark";
import { api, type Settings } from "../api";
import { requestGameModelJson } from "../gameModelRequest";
import { gameAvailableModels } from "./GameTranslationTabs";
import { refineMosaicBatch, mosaicReviewKey, readMosaicReviews, clearMosaicReviews } from "../gameMosaicRefine";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "../api";
import { beginGameStep, clearGamePerformance, finishGameStep, gameDuration, recordGameRequest, gameStepSelections, measureGameAsync, reportGameStepItems, stepPerformance, type StepPerformance } from "../gameModelPerformance";
import { readMosaicSettings, saveMosaicSettings, clearGameDetectorFile, gameDetectorFile, openDeploymentDetector, groupMosaicScenes, loadMosaicDetector, mapMosaicBoxes, mosaicInputKey, mosaicModelLabels, redrawMosaic, createMosaicGridScanner, type MosaicDevice, type MosaicBox, type MosaicModel, type MosaicScan } from "../gameMosaic";
import type { UnityImage } from "../unityOffline";
import { deploymentMetricScope } from "../unityWorkflow";
import { showAppNotice } from "./AppNotice";
import { useGameActionConfirm } from "./GameActionConfirm";
import { GameFlowCard } from "./GameFlowCard";
import { GameMetricHint, GameModelUsage } from "./GameFlowSequence";
import { benchmarkBlockingReason, isBenchmarkRunning, useBenchmarkProgress, useBenchmarkRunning } from "../benchmark/benchmarkRunner";
import { GameImageFilter, GameImageListPagination, GameImagePreviewFrame, GameImageSplit } from "./GameImageBrowserLayout";
import { GameImageViewer, useImageBlobUrl, type GameImageViews } from "./GameImageViewer";
import { GameProgressBar, gameProgressLabels, type GameProgressState } from "./GameStepProgress";
import { SearchHighlight } from "./SearchHighlight";
import "../gameMosaic.css";

type InitialScreening = { boxes: MosaicBox[]; checked: boolean; scanned?: boolean; detector?: string; reason?: string; review?: string };
type RefineMovement = { from: MosaicStatus; to: MosaicStatus; checkedBefore: boolean; checkedAfter: boolean };
type Result = { source: string; beforeRefine?: InitialScreening; refineMovement?: RefineMovement; boxes: MosaicBox[]; checked: boolean; group?: string; manualGroup?: boolean;
  scanned?: boolean; detector?: string; manualBoxes?: boolean; manualChecked?: boolean; reason?: string; review?: string; refineError?: string; refined?: string; refineQuickExcluded?: boolean; signature?: string | number[]; saved?: boolean; reference?: boolean; discardedHash?: string };
type Results = Record<string, Result>;
type Candidates = Partial<Record<MosaicModel, Blob>>;
type RedrawPlan = {
  targets: { image: UnityImage; boxes: MosaicBox[]; keep: MosaicBox[]; pending: Set<MosaicModel> }[];
  models: MosaicModel[];
  steps: number;
  seed: number;
  reference?: UnityImage;
  referenceBlob?: Blob;
};
type ResultVersion = { id: MosaicModel; blob: Blob; seconds?: number };
type MosaicStep = "screen" | "refine" | "redraw";
type StepRun = {
  state: GameProgressState; completed: number; total: number; started?: number; elapsed?: number;
  summary?: string; device?: MosaicDevice; prepared?: number; models?: StepPerformance["models"];
  batchStarted?: number; batchElapsed?: number; processed?: number; failed?: number;
} & Partial<StepPerformance>;
type StepReport = number | Partial<Pick<StepRun, "completed" | "prepared" | "processed" | "failed">>;

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

function beginMosaicStepUsage(gamePath: string, step: MosaicStep, resume: boolean, refresh = () => {}) {
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
type MosaicStepUsage = ReturnType<typeof beginMosaicStepUsage>;
type ImagePreview = { id: string; revision: string; blob?: Blob; error?: string };
export const GameMosaicCompletionContext = createContext<((completed: boolean) => void) | null>(null);

export type GameMosaicDeploymentHandle = {
  prepare: (signal: AbortSignal, ids?: string[]) => Promise<{ ids: string[]; patchId: string; path: string }>;
  automatic: (signal: AbortSignal) => Promise<string[]>;
  selectedIds: () => string[];
  apply: (ids: string[], undo?: boolean, patchId?: string) => Promise<number>;
};

export type MosaicCandidateIndex = Record<string, { source: string; hash: string; included: boolean }>;
type MosaicStorage = {
  index: MosaicCandidateIndex;
  read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>;
  save: (image: UnityImage, blob: Blob, signal: AbortSignal) => Promise<void>;
  select: (images: UnityImage[], include: boolean, signal: AbortSignal) => Promise<void>;
};
type Props = {
  settings?: Settings; gamePath: string; images: readonly UnityImage[]; backupMode?: string; storage?: MosaicStorage;
  read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>;
  prepareSources?: (images: readonly UnityImage[], signal: AbortSignal) => Promise<Record<string, string>>;
  controls: HTMLElement; visible?: boolean; disabled?: boolean; onBusy?: (busy: boolean) => void;
  deploymentHandle?: { current: GameMosaicDeploymentHandle | null };
};

const defaultResult = (image: UnityImage): Result => ({ source: image.sourceHash, boxes: [], checked: true });
const mosaicPageSize = 40;
const mosaicStatusLabels = {
  pending: "待筛选", review: "待复核", candidate: "疑似有码",
  confirmed: "已确认", included: "已纳入补丁", clear: "未发现",
} as const;
type MosaicStatus = keyof typeof mosaicStatusLabels;
function mosaicStatus(row: Result, included: boolean): MosaicStatus {
  if (row.saved) return included ? "included" : "confirmed";
  if (row.reason || row.refineError || row.review) return "review";
  if (row.boxes.length) return "candidate";
  return row.scanned ? "clear" : "pending";
}
const detectorLabels = { grid: "方格规则", anime: "高召回初筛（分类＋定位）" };
function resultFor(rows: Results, image: UnityImage) {
  const row = rows[image.id];
  return row?.source === image.sourceHash ? row : defaultResult(image);
}

function restoreDefaultSelection(row: Result): Result {
  if (row.checked || row.manualChecked || row.manualBoxes || row.saved || row.discardedHash || row.refined || row.refineError)
    return row;
  const checked = !row.scanned || (!row.reason && (row.boxes.length > 0 || !!row.review));
  return checked ? { ...row, checked } : row;
}

function rememberInitialScreening(row: Result): InitialScreening {
  const { boxes, checked, scanned, detector, reason, review } = row;
  return row.beforeRefine ?? { boxes, checked, scanned, detector, reason, review };
}

function attachRefineMovement(before: Result, after: Result): Result {
  const initial = rememberInitialScreening(before);
  return { ...after, beforeRefine: initial, refineMovement: {
    from: mosaicStatus({ ...before, ...initial, scanned:initial.scanned, reason:initial.reason, review:initial.review,
      refineError:undefined },false),
    to: mosaicStatus(after,false),
    checkedBefore: initial.checked,
    checkedAfter: after.checked,
  } };
}

function reviewedResult(row: Result, scan: MosaicScan, reviewKey: string, detectorKey: string): Result {
  return attachRefineMovement(row, { ...row,
    boxes: scan.review ? scan.reviewBoxes || scan.boxes : scan.boxes,
    checked: row.manualChecked ? row.checked : !!scan.boxes.length && !scan.review,
    refined: reviewKey, refineQuickExcluded: scan.quickExcluded, scanned: true, detector: detectorKey,
    reason: undefined, refineError: undefined, review: scan.review });
}

function clearReviewResult(row: Result): Result {
  const hadLegacyError = row.scanned && !!row.reason;
  if (row.saved || !(row.beforeRefine || row.refined || row.refineError || hadLegacyError)) return row;
  const { beforeRefine, refineMovement, refined, refineError, refineQuickExcluded, ...rest } = row;
  if (!beforeRefine || row.manualBoxes) {
    return restoreDefaultSelection({ ...rest,
      reason: hadLegacyError ? undefined : row.reason,
      review: refined && row.review && !row.manualBoxes ? "候选区域待复核" : row.review,
    });
  }
  return restoreDefaultSelection({ ...rest, ...beforeRefine,
    scanned: beforeRefine.scanned, detector: beforeRefine.detector, reason: beforeRefine.reason,
    checked: row.manualChecked ? row.checked : beforeRefine.checked,
    review: row.manualChecked ? row.review : beforeRefine.review });
}

function MosaicResultVersion({ version, letter, imageName, disabledReason, onApprove, onOpen }: {
  version: ResultVersion; letter?: string; imageName: string;
  disabledReason?: string; onApprove: (blob: Blob) => void; onOpen?: () => void;
}) {
  const url = useImageBlobUrl(version.blob);
  const modelName = mosaicModelLabels[version.id];
  return <div className="game-mosaic-result-version">
    <GameImagePreviewFrame onDoubleClick={url ? onOpen : undefined} caption={<>
      <span>{letter && `${letter} · `}{modelName}</span>
      {version.seconds != null && <small>{version.seconds.toFixed(1)} 秒</small>}
    </>} fallback={<p className="hint">正在读取图片…</p>}>
      {url && <div className="unity-image-stage">
        <img src={url} alt={`${imageName} · ${modelName} 去码结果`} draggable={false} />
      </div>}
    </GameImagePreviewFrame>
    <button type="button" className="unity-btn" aria-label={`确认 ${modelName} 候选`}
      disabled={!!disabledReason} title={disabledReason} data-tooltip={disabledReason}
      onClick={() => onApprove(version.blob)}>确认此版</button>
  </div>;
}

async function mosaicResponse(response: Response) {
  if (!response.ok) throw new Error((await response.json()).error || "图片去码操作失败");
  return response;
}

function keepText(image: UnityImage, protect: boolean): MosaicBox[] {
  if (!protect) return [];
  return image.regions.filter(region => region.text.trim() && Number.isFinite(region.x0 + region.x1 + region.y0 + region.y1))
    .map((region): MosaicBox => [Math.max(0, Math.floor(region.x0)), Math.max(0, Math.floor(region.y0)),
      Math.min(image.width, Math.ceil(region.x1)), Math.min(image.height, Math.ceil(region.y1))])
    .filter(([left, top, right, bottom]) => left < right && top < bottom);
}

export function GameMosaicWorkbench({ settings, gamePath, images, backupMode, storage, read, prepareSources, controls, visible: paneVisible = true, disabled = false, onBusy, deploymentHandle }: Props) {
  const task = useRef<AbortController | null>(null);
  const onCompletionChange = useContext(GameMosaicCompletionContext);
  const savedKey = "llmchat-game-mosaic:" + gamePath;
  const [rows, setRows] = useState<Results>(() => {
    try {
      const saved: Results = JSON.parse(localStorage.getItem(savedKey) || "{}") || {};
      for (const id of Object.keys(saved)) saved[id] = restoreDefaultSelection(saved[id]);
      return saved;
    } catch { return {}; }
  });
  useLayoutEffect(() => {
    publishMosaicBenchmarkSource(gamePath,rows);
  }, [gamePath,rows]);
  useLayoutEffect(() => () => publishMosaicBenchmarkSource(gamePath),[gamePath]);
  useEffect(() => {
    if (!storage) return;
    setRows(previous => {
      const next = { ...previous };
      for (const image of images) {
        const entry = storage.index[image.id];
        const row = resultFor(previous, image);
        const saved = entry?.source === image.sourceHash && (entry.included || entry.hash !== row.discardedHash);
        if (saved !== !!row.saved)
          next[image.id] = { ...row, saved, checked: row.manualChecked ? row.checked : saved || row.checked };
      }
      return next;
    });
  }, [images, storage?.index]);
  const [query, setQuery] = useState("");
  const [groupPages, setGroupPages] = useState<Partial<Record<MosaicStatus, number>>>({});
  const [collapsed, setCollapsed] = useState<Partial<Record<MosaicStatus, boolean>>>(() =>
    Object.fromEntries(Object.keys(mosaicStatusLabels).map(id => [id, true])));
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [keyboardTarget, setKeyboardTarget] = useState<string>();
  const filterMenu = useRef<HTMLDivElement>(null);
  const [configured, setConfigured] = useState<MosaicStep | null>(null);
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
  const [statusFilter, setStatusFilter] = useState<"all" | MosaicStatus>("all");
  const [activeId, setActiveId] = useState<string | null>("");
  const [busy, setBusy] = useState("");
  const [progressStep, setProgressStep] = useState<MosaicStep>();
  const [stepRuns, setStepRuns] = useState<Partial<Record<MosaicStep, StepRun>>>({});
  const pendingRedraw = useRef<RedrawPlan | null>(null);
  const lastReview = useRef<{ key: string; images: Map<string, string> } | null>(null);
  const [, refreshElapsed] = useState(0);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState<ImagePreview>();
  const [approved, setApproved] = useState<ImagePreview>();
  const [candidates, setCandidates] = useState<Record<string, { revision: string; values: Candidates; seconds: Partial<Record<MosaicModel, number>> }>>({});
  const [preferredResult, setPreferredResult] = useState<"saved" | MosaicModel>();
  const previews = useRef<HTMLDivElement>(null);
  const [previewAreaWidth, setPreviewAreaWidth] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const [viewer, setViewer] = useState<{ title: string; views: GameImageViews; initialIndex: number } | null>(null);
  const [draft, setDraft] = useState<MosaicBox>();
  const anchor = useRef<[number, number] | null>(null);
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
    const selectedRows = scoped.map(image => resultFor(rows, image)).filter(row => row.checked);
    onCompletionChange(selectedRows.length > 0 && selectedRows.every(row => row.saved === true));
  }, [onCompletionChange, rows, scoped]);
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
  const visible = useMemo(() => statusFilter === "all" ? currentScope : currentScope.filter(image =>
    mosaicStatus(resultFor(rows, image), !!storage?.index[image.id]?.included) === statusFilter),
    [currentScope, rows, statusFilter, storage?.index]);
  const { ordered, groups } = useMemo(() => {
    const grouped = new Map<MosaicStatus, UnityImage[]>();
    for (const image of visible) {
      const status = mosaicStatus(resultFor(rows, image), !!storage?.index[image.id]?.included);
      const list = grouped.get(status);
      if (list) list.push(image);
      else grouped.set(status, [image]);
    }
    const groups = new Map<MosaicStatus, UnityImage[]>();
    for (const status of Object.keys(mosaicStatusLabels) as MosaicStatus[]) {
      const images = grouped.get(status);
      if (statusFilter === "all" || statusFilter === status) groups.set(status, images || []);
    }
    return { groups, ordered: [...groups].filter(([id]) => !collapsed[id]).flatMap(([id, images]) => images.map(image => ({ id, image }))) };
  }, [visible, rows, storage?.index, collapsed, statusFilter]);
  const refineChanges = useMemo(() => {
    const changes = new Map<MosaicStatus, { added: number; removed: number }>();
    for (const image of currentScope) {
      const row = resultFor(rows,image);
      const movement = row.refineMovement ?? (row.beforeRefine && (row.refined || row.refineError) && !row.saved
        ? attachRefineMovement(row,row).refineMovement : undefined);
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
  const activeResult = active && resultFor(rows, active);
  const group = active && (activeResult?.group || active.id);
  const members = group ? imageGroup.get(group) || [] : [];
  const reference = members.find(image => resultFor(rows, image).reference && resultFor(rows, image).saved);
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [needle, scope, sceneFilter, statusFilter]);
  useLayoutEffect(() => {
    if (!keyboardTarget) return;
    const button = listRef.current?.querySelector<HTMLButtonElement>(
      `button[data-mosaic-row="${CSS.escape(keyboardTarget)}"]`);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest" });
    setKeyboardTarget(undefined);
  }, [keyboardTarget, groupPages, collapsed]);

  function navigateList(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (busy || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const element = event.target as HTMLElement;
    if (element.matches("input:not([type=checkbox]), select, textarea")) return;
    const summary = element.closest<HTMLElement>("summary[data-mosaic-status]");
    if (summary) {
      const status = summary.dataset.mosaicStatus as MosaicStatus;
      event.preventDefault();
      if (event.key === "ArrowLeft" || event.key === "ArrowRight")
        setCollapsed(previous => ({ ...previous, [status]: event.key === "ArrowLeft" }));
      else {
        const headings = [...listRef.current!.querySelectorAll<HTMLElement>("summary[data-mosaic-status]")];
        headings[Math.max(0, Math.min(headings.length - 1, headings.indexOf(summary) + (event.key === "ArrowUp" ? -1 : 1)))]?.focus();
      }
      return;
    }
    if (!ordered.length) return;
    event.preventDefault();
    const focused = element.closest<HTMLElement>("[data-mosaic-item]")?.dataset.mosaicItem;
    const index = ordered.findIndex(item => item.image.id === (focused || active?.id));
    let next = Math.max(0, index);
    if (index >= 0 && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      next = Math.max(0, Math.min(ordered.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
    } else if (index >= 0) {
      const status = ordered[index].id;
      const images = groups.get(status)!;
      const local = images.findIndex(image => image.id === ordered[index].image.id);
      const page = Math.min(groupPages[status] || 0, Math.ceil(images.length / mosaicPageSize) - 1);
      const destination = page + (event.key === "ArrowLeft" ? -1 : 1);
      if (destination < 0 || destination * mosaicPageSize >= images.length) return;
      const image = images[Math.min(images.length - 1, destination * mosaicPageSize + local % mosaicPageSize)];
      next = ordered.findIndex(item => item.image.id === image.id);
    }
    const { id: status, image } = ordered[next];
    const id = image.id;
    const local = groups.get(status)!.findIndex(item => item.id === id);
    setGroupPages(previous => ({ ...previous, [status]: Math.floor(local / mosaicPageSize) }));
    setActiveId(id);
    setKeyboardTarget(id);
    setError("");
  }

  const selected = members.filter(image => resultFor(rows, image).checked);
  const saved = selected.filter(image => resultFor(rows, image).saved);
  const included = saved.filter(image => storage?.index[image.id]?.included);
  const result = active && candidates[active.id]?.revision === active.sourceHash ? candidates[active.id] : undefined;
  const activeSaved = !!activeResult?.saved;
  const versions: ResultVersion[] = (["turbo", "2511"] as const).flatMap(id => {
    const blob = result?.values[id];
    return blob ? [{ id, blob, seconds: result?.seconds[id] }] : [];
  });
  const preferredVersion = versions.find(version => version.id === preferredResult) ?? versions[0];
  const showSaved = activeSaved && (preferredResult === "saved" || !preferredVersion);
  const comparing = versions.length === 2 && !showSaved;
  // Leave room for three 560px images, their frames and the two gaps between them.
  const sideBySide = comparing && previewAreaWidth >= 3 * 560 + 62 * document.documentElement.currentCSSZoom;
  const original = source && source.id === active?.id && source.revision === active.sourceHash ? source : undefined;
  const confirmed = approved && approved.id === active?.id && approved.revision === active.sourceHash ? approved : undefined;
  const originalUrl = useImageBlobUrl(original?.blob);
  const savedUrl = useImageBlobUrl(showSaved ? confirmed?.blob : undefined);
  const openPreview = (id: "original" | "saved" | MosaicModel) => {
    if (drawing || !active) return;
    const { name: title, width, height } = active;
    const originalView = { id: "original", label: "原图", src: original?.blob };
    const savedView = { id: "saved", label: "去码结果 · 已确认", src: activeSaved ? confirmed?.blob : undefined };
    const candidateViews = versions.map((version, index) => ({
      id: version.id,
      label: (versions.length === 2 ? "候选 " + (index === 0 ? "A" : "B") : "去码结果") + " · " + mosaicModelLabels[version.id],
      src: version.blob,
    }));
    const ordered = showSaved ? [originalView, savedView, ...candidateViews] : [originalView, ...candidateViews, savedView];
    const available = ordered.flatMap(view => view.src ? [{ ...view, src: view.src, width, height }] : []);
    const initialIndex = available.findIndex(view => view.id === id);
    const [first, ...others] = available;
    if (initialIndex >= 0 && first) setViewer({ title, views: [first, ...others], initialIndex });
  };

  const counts = useMemo(() => visible.reduce((total, image) => {
    const row = resultFor(rows, image);
    if (row.checked) total.checked++;
    if (row.saved && !storage?.index[image.id]?.included) total.saved++;
    return total;
  }, { checked: 0, saved: 0 }), [visible, rows, storage?.index]);

  useLayoutEffect(() => {
    const element = previews.current;
    if (!element) return;
    const updateWidth = () => setPreviewAreaWidth(element.getBoundingClientRect().width);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);

  useEffect(() => () => { task.current?.abort(); onBusy?.(false); }, [onBusy]);
  useEffect(() => {
    if (!paneVisible) { filterMenu.current?.hidePopover(); setViewer(null); }
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

  const candidatePath = (image: UnityImage) => API_BASE + "/api/game-images/mosaic?" +
    new URLSearchParams({ gamePath, id: image.id, sourceHash: image.sourceHash });
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
    deploymentHandle.current = {
      selectedIds: () => selected.map(image => image.id),
      automatic: async signal => {
        const ids = new Set(selected.map(image => image.id));
        const status = await mosaicResponse(await fetch(API_BASE + "/api/game-images/mosaic-status", {
          method: "POST", signal, headers: { "Content-Type":"application/json" }, body: JSON.stringify({ gamePath })
        }));
        const { candidates: existing } = await status.json() as { candidates: Record<string,string> };
        for (const image of usable) {
          const row = resultFor(rows, image);
          if (existing[image.id] === image.sourceHash && row.discardedHash !== image.sourceHash && !(row.manualChecked && !row.checked))
            ids.add(image.id);
        }
        const unscreened = scoped.filter(image => !ids.has(image.id) && !(resultFor(rows, image).manualChecked && !resultFor(rows, image).checked));
        if (!unscreened.length) return [...ids];
        const reviews=preferences.refine!==false ? await performReviews(unscreened.filter(image=>!resultFor(rows,image).manualBoxes),signal,(_completed,detail)=>setProgress(detail),false,true) : undefined;
        if(reviews?.failed)throw new Error(reviews.failed+" 张图片复筛失败");
        const detector = reviews ? undefined : await openDeploymentDetector(gamePath, preferences, signal);
        try {
          for (const image of unscreened) {
            signal.throwIfAborted();
            const row = resultFor(rows, image);
            const source = await read(image, signal);
            const scan = row.manualBoxes ? {boxes:row.boxes} : reviews?.results.get(image.id) ||
              (row.scanned && row.detector === detectorKey && !row.reason
                ? { boxes: row.boxes, review: row.review, reviewBoxes: row.boxes } : await detector!.scan(source));
            if (scan.review && !row.manualChecked) {
              update(image, { scanned:true, detector:detectorKey, review:scan.review, boxes:scan.reviewBoxes || [], checked:false });
              throw new Error(image.name + " · " + scan.review);
            }
            const boxes = scan.boxes;
            if (!boxes.length) { update(image, { boxes, scanned:true, detector:detectorKey, reason:undefined }); continue; }
            const rendered = await redrawMosaic({ source, boxes, keep: keepText(image, protect), model, steps, seed: 1, signal, progress: setProgress });
            await mosaicResponse(await fetch(candidatePath(image), { method: "POST", headers: { "Content-Type": "image/png" }, body: rendered, signal }));
            ids.add(image.id);
            update(image, { boxes, scanned: true, detector: detectorKey, saved: true, checked: true, discardedHash: undefined });
          }
          return [...ids];
        } finally { await detector?.release(); }
      },
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
    setPreferredResult(undefined); setDrawing(false); setDraft(undefined); anchor.current = null;
    void read(image, controller.signal).then(blob => {
      if (!controller.signal.aborted) setSource({ id: image.id, revision: image.sourceHash, blob });
    }).catch(cause => {
      if (!controller.signal.aborted) setSource({ id: image.id, revision: image.sourceHash, error: String(cause) });
    });
    return () => controller.abort();
  }, [active, read, loadPreviews]);

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

  async function run(label: string, work: (signal: AbortSignal, report: (progress: StepReport) => void, usage?: MosaicStepUsage) => Promise<void | boolean>,
    step?: { id: MosaicStep; total: number; completed?: number; summary: string; resume?: boolean }) {
    if (task.current || disabled || isBenchmarkRunning()) return;
    const controller = new AbortController();
    task.current = controller;
    onBusy?.(true);
    const batchStarted = performance.now();
    const elapsedBefore = step ? resumableMosaicMetrics(gamePath,step.id,!!step.resume)?.elapsedMs ?? 0 : 0;
    const started = batchStarted - elapsedBefore;
    setProgressStep(step?.id);
    if (step) setStepRuns(previous => ({ ...previous, [step.id]: {
      state: "running", completed: step.completed ?? 0, total: step.total, summary: step.summary, started, batchStarted,
    } }));
    setBusy(label); setProgress(label); setError("");
    const updateStep = (edit: Partial<StepRun>) => {
      if (!step) return;
      setStepRuns(previous => {
        const current = previous[step.id];
        return current ? { ...previous, [step.id]: { ...current, ...edit } } : previous;
      });
    };
    let usage: MosaicStepUsage | undefined;
    let state: GameProgressState = "error";
    try {
      if (step) {
        usage = beginMosaicStepUsage(gamePath, step.id, !!step.resume,
          () => { if (usage) updateStep(usage.snapshot()); });
        usage.refresh();
      }
      const completed = await work(controller.signal, progress => {
        const counts = typeof progress === "number" ? { completed: progress } : progress;
        const itemsDone = counts.processed ?? counts.completed;
        if (itemsDone !== undefined) usage?.recordItems(itemsDone, counts.failed);
        updateStep({ ...usage?.snapshot(), ...counts });
      }, usage);
      const stopped = controller.signal.aborted && !(step?.id === "redraw" && completed === true);
      if (stopped) setProgress("已停止后续任务");
      state = stopped ? "stopped" : completed === false ? "error" : "done";
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      else setProgress("已停止后续任务");
      state = controller.signal.aborted ? "stopped" : "error";
    } finally {
      const ended = performance.now();
      usage?.finish(state === "done");
      updateStep({ ...usage?.snapshot(), state, elapsed: ended - started, batchElapsed: ended - batchStarted });
      task.current = null; setBusy("");
      onBusy?.(false);
    }
  }

  const detectorKey = detectorKind === "grid" ? "grid-v2" : detectorFile
    ? JSON.stringify(["custom-yolo-presence-v1", detectorFile.name, detectorFile.size, detectorFile.lastModified]) : detectorKind + "-2d-presence-v1";
  const reviewKey = mosaicReviewKey(preferences, detectorFile);
  const reviewModels = settings ? gameAvailableModels(settings) : ["qwen3-vl:8b-instruct"];
  function applyReview(image: UnityImage, scan: MosaicScan) {
    setRows(previous => {
      const old = resultFor(previous,image);
      if (old.manualBoxes || old.saved) return previous;
      return { ...previous, [image.id]: reviewedResult(old, scan, reviewKey, detectorKey) };
    });
  }
  useEffect(() => {
    const completed=readMosaicReviews(gamePath,reviewKey);
    setRows(previous => {
      const next={...previous};let changed=false;
      for(const image of usable) {
        const record=completed[image.id],old=resultFor(previous,image);
        if(record?.source!==image.sourceHash || (old.refined===reviewKey && !!old.refineQuickExcluded===!!record.scan.quickExcluded) || old.manualBoxes || old.saved)continue;
        next[image.id] = reviewedResult(old, record.scan, reviewKey, detectorKey);
        changed=true;
      }
      return changed?next:previous;
    });
  },[gamePath,usable,reviewKey,detectorKey]);
  const reviewSessionKey = JSON.stringify([reviewKey, detectorKey, scope, needle, scopedGroup]);
  const previousReview = lastReview.current?.key === reviewSessionKey ? lastReview.current : undefined;
  const isReviewed = (row: Result) => row.refined === reviewKey && !row.refineQuickExcluded;
  const checkedReviewScope: UnityImage[] = [];
  const pendingReview: UnityImage[] = [];
  let reviewedCount = 0;
  for (const image of currentScope) {
    const row = resultFor(rows,image);
    if (!row.scanned || row.saved || row.manualBoxes) continue;
    if (row.checked) checkedReviewScope.push(image);
    if (isReviewed(row)) {
      if (row.checked || previousReview?.images.get(image.id) === image.sourceHash) reviewedCount++;
    } else if (row.checked) pendingReview.push(image);
  }
  const reviewTotal = reviewedCount + pendingReview.length;
  async function performReviews(targets: readonly UnityImage[], signal: AbortSignal, report?: (completed:number,detail:string)=>void,
    restart=false, automatic=false, metrics?: { onPreparation: (prepared: number) => void; onFailure: () => void; usage?: MosaicStepUsage }) {
    const configuration=settings || await api.getSettings();
    const reviewSettings=automatic ? {...preferences,refineScope:preferences.refineIncludeMissed?"all" as const:"suspected" as const} : preferences;
    const cached = automatic && !restart ? readMosaicReviews(gamePath,reviewKey) : undefined;
    const isCached = (image: UnityImage) => {
      const old = cached?.[image.id];
      return old?.source === image.sourceHash && !(reviewSettings.refineScope === "all" && old.scan.quickExcluded);
    };
    const ownedUsage = !metrics?.usage && targets.some(image => !isCached(image))
      ? beginMosaicStepUsage(gamePath,"refine",!restart) : undefined;
    const usage = metrics?.usage ?? ownedUsage;
    let processed = 0, failures = 0;
    const requestConcurrency = metrics?.usage && Math.min(targets.length, Math.max(1, Math.min(2, reviewSettings.refineConcurrency ?? 1)));
    const selections = usage && gameStepSelections(usage.scope, "refine", requestConcurrency);
    let succeeded = false;
    try {
      const result = await refineMosaicBatch(targets,{root:gamePath,settings:reviewSettings,signal,modelFile:detectorFile,read,prepare:prepareSources,restart,timingScope:usage?.scope,
        request:(model,prompt,image,signal,lanes)=>requestGameModelJson(configuration,model,prompt,signal,image,"game-images",undefined,{role:"mosaic",selection:selections?.(lanes)})
          .finally(() => usage?.refresh()),
       onResult: (image,scan) => {
         applyReview(image,scan);
         if (ownedUsage && !isCached(image)) ownedUsage.recordItems(++processed,failures);
       },
       onError: (image,error) => {
         metrics?.onFailure();
         if (ownedUsage) { failures++; ownedUsage.recordItems(++processed,failures); }
         setRows(previous => {
           const row = resultFor(previous, image);
           return { ...previous, [image.id]: attachRefineMovement(row,{ ...row,
             refineError: error, refined: undefined, refineQuickExcluded: undefined }) };
         });
       },
        onProgress: report,
        onPreparation:metrics?.onPreparation});
       succeeded = result.failed === 0;
       return result;
     } finally { ownedUsage?.finish(succeeded); }
  }
  function refine(restart=false) {
    const targets = restart ? checkedReviewScope : pendingReview;
    if (!targets.length) return;
    const initial = restart ? 0 : reviewedCount;
    void run("复筛打码图片",async(signal,report,usage)=>{
      const tracked = restart ? new Map<string, string>() : new Map(previousReview?.images);
      for (const image of checkedReviewScope) tracked.set(image.id, image.sourceHash);
      lastReview.current = { key: reviewSessionKey, images: tracked };
      if (restart) setRows(previous => {
        const next = { ...previous };
        for (const image of targets) next[image.id] = { ...resultFor(previous,image), refined: undefined, refineQuickExcluded: undefined };
        return next;
      });
      let completed = 0, failed = 0;
      const reportBatch = () => report({ completed: initial + completed, processed: completed + failed, failed });
      const result = await performReviews(targets,signal,(count,detail)=>{
        completed = count;
        reportBatch();
        setProgress(detail);
      },restart,false,{
        onPreparation: prepared => report({ prepared: initial + prepared }),
        onFailure: () => { failed++; reportBatch(); },
        usage,
      });
      const uncertain=[...result.results.values()].filter(scan=>scan.review).length;
      setProgress("本轮复筛结束 · "+uncertain+" 张待人工确认");
      if(result.failed)setError(result.failed+" 张复筛失败，请查看待复核分组");
      return !result.failed;
    },{id:"refine",total:restart ? targets.length : reviewTotal,completed:initial,summary:preferences.refineModel || "qwen3.5:latest",
      resume: !restart});
  }
  const lastScreen = useRef<{ scope: readonly UnityImage[]; detector: string } | null>(null);
  const screenTargets = currentScope.filter(image => resultFor(rows, image).checked);
  const isScreened = (image: UnityImage) => {
    const row = resultFor(rows, image);
    return row.scanned && (row.detector ?? "grid") === detectorKey;
  };
  const remaining = screenTargets.filter(image => !isScreened(image));
  const screenedCount = currentScope.filter(isScreened).length;
  const screenTotal = screenedCount + remaining.length;

  function screen(restart = remaining.length === 0) {
    const targets = restart ? screenTargets : remaining;
    if (!targets.length) return;
    lastScreen.current = { scope: currentScope, detector: detectorKey };
    const initial = restart ? 0 : screenedCount;
    void run("筛选打码区域", async (signal, report, usage) => {
      const lanes = Math.min(targets.length, Math.max(1, Math.min(4, preferences.concurrency ?? 2)));
      const modelName = detectorKind !== "grid" && detectorFile ? detectorFile.name : detectorLabels[detectorKind];
      const detector = detectorKind !== "grid" ? await loadMosaicDetector(detectorFile, {
        signal,
        onDevice: device => setStepRuns(previous => previous.screen
          ? { ...previous, screen: { ...previous.screen, device } }
          : previous),
      }) : undefined;
      if (restart) setRows(previous => {
        const next = { ...previous };
        for (const image of targets) next[image.id] = { ...resultFor(previous, image), scanned: false };
        return next;
      });
      let batch: Results = {};
      let cursor = 0, completed = initial, failures = 0;
      const reportBatch = () => report({ completed, processed: completed - initial, failed: failures });
      let lastReport = 0;
      const checkpoint = () => {
        const changes = batch;
        batch = {};
        setRows(previous => ({ ...previous, ...changes }));
      };
      async function lane() {
        const scanner = detector ?? createMosaicGridScanner();
        try {
          while (!signal.aborted && cursor < targets.length) {
            const start = cursor;
            cursor += prepareSources ? 16 : 1;
            const next = targets.slice(start, cursor);
            const errors: Record<string, string> = prepareSources ? await prepareSources(next, signal) : {};
            for (const image of next) {
              if (signal.aborted) break;
              const old = resultFor(rows, image);
              try {
                const prepareError = errors[image.id];
                if (prepareError) throw new Error(prepareError);
                const input = await read(image, signal);
                if (signal.aborted) break;
                const scan = await usage!.measure(modelName, lanes, () => scanner.scan(input));
                const { signature } = scan;
                const boxes = scan.boxes.length ? scan.boxes : scan.reviewBoxes || [];
                batch[image.id] = { ...old, boxes: old.manualBoxes || old.saved ? old.boxes : boxes,
                  checked: old.manualChecked || old.manualBoxes || old.saved ? old.checked : boxes.length > 0 || !!scan.review,
                  signature: btoa(String.fromCharCode(...signature)), detector: detectorKey, scanned: true, beforeRefine:undefined, refineMovement:undefined, refined:undefined, refineQuickExcluded:undefined, refineError:undefined, reason: undefined, review: old.manualChecked || old.manualBoxes || old.saved ? undefined : scan.review };
              } catch (cause) {
                if (signal.aborted) break;
                failures++;
                batch[image.id] = { ...old, scanned: false, reason: cause instanceof Error ? cause.message : String(cause) };
              }
              completed++;
              if ((completed - initial) % 64 === 0) checkpoint();
              const now = performance.now();
              if (now - lastReport >= 150) {
                reportBatch();
                setProgress(image.name);
                lastReport = now;
              }
            }
          }
        } finally { if (!detector) await scanner.release(); }
      }
      try {
        const settled = await Promise.allSettled(Array.from({ length: lanes }, lane));
        for (const item of settled) if (item.status === "rejected") throw item.reason;
      } finally {
        checkpoint();
        reportBatch();
        await detector?.release();
      }
      setRows(previous => {
        const next = { ...previous };
        const proposals = groupMosaicScenes(usable.flatMap(image => {
          const row = resultFor(next, image);
          if (!row.signature || row.manualGroup || row.saved || row.reference) return [];
          const signature = typeof row.signature === "string" ? Array.from(atob(row.signature), c => c.charCodeAt(0)) : row.signature;
          return [{ ...image, signature }];
        }));
        for (const list of proposals) for (const image of list) next[image.id] = { ...next[image.id], group: "scene-" + list[0].id };
        return next;
      });
      setProgress([failures ? failures + " 张读取失败，可在待复核列表查看。" : "", detector?.reused ? "已复用 " + detector.reused + " 张相同图片的检测结果" : ""].filter(Boolean).join(" · "));
      return failures === 0;
    }, { id: "screen", total: restart ? targets.length : screenTotal, completed: initial, summary: detectorLabels[detectorKind], resume: !restart });
  }

  function editMask(image: UnityImage, boxes: MosaicBox[]) {
    update(image, { boxes, manualBoxes: true, review:undefined, saved: storage ? resultFor(rows, image).saved : false, reference: false, checked: boxes.length > 0 });
    setCandidates(previous => {
      const next = { ...previous };
      delete next[image.id];
      return next;
    });
  }

  function position(event: PointerEvent<SVGSVGElement>, image: UnityImage): [number, number] {
    const box = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(image.width, Math.round((event.clientX - box.left) * image.width / box.width))),
      Math.max(0, Math.min(image.height, Math.round((event.clientY - box.top) * image.height / box.height)))];
  }

  function bounds(a: [number, number], b: [number, number]): MosaicBox {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }

  function startRedraw(plan: RedrawPlan, resume = false) {
    if (resume) {
      const current = new Map(usable.map(image => [image.id, image]));
      const unchanged = plan.targets.every(({image,boxes,keep}) => {
        const latest = current.get(image.id);
        return latest?.sourceHash === image.sourceHash &&
          JSON.stringify(resultFor(rows,latest).boxes) === JSON.stringify(boxes) &&
          JSON.stringify(keepText(latest,protect)) === JSON.stringify(keep);
      });
      if (!unchanged) {
        pendingRedraw.current = null;
        setStepRuns(previous => ({ ...previous, redraw: undefined }));
        setError("原图、蒙版或文字保护范围已变更，请按当前选择重绘");
        return;
      }
    }
    const summary = plan.models.map(engine => mosaicModelLabels[engine]).join("、");
    const total = plan.targets.length;
    const initial = plan.targets.filter(target => !target.pending.size).length;
    let completed = initial;
    void run("生成去码候选", async (signal, report, usage) => {
      pendingRedraw.current = plan;
      if (plan.reference && !plan.referenceBlob) plan.referenceBlob = await readSaved(plan.reference, signal);
      const cache = new Map<string, { blob: Blob; seconds: number }>();
      const failures: string[] = [];
      for (const { image, boxes, keep, pending } of plan.targets) {
        if (!pending.size) continue;
        signal.throwIfAborted();
        try {
          const original = await read(image, signal);
          const input = await mosaicInputKey(original, boxes);
          for (const engine of pending) {
            signal.throwIfAborted();
            const title = image.name + " · " + mosaicModelLabels[engine];
            setProgress(title);
            const stepCount = plan.models.length === 1 ? plan.steps : engine === "turbo" ? 8 : 20;
            const reference = image.id === plan.reference?.id ? undefined : plan.referenceBlob;
            const key = JSON.stringify([engine, stepCount, input, keep, !!reference]);
            let outcome = cache.get(key);
            if (!outcome) {
              const start = performance.now();
              try {
                const blob = await usage!.measure(mosaicModelLabels[engine], 1, () => redrawMosaic({
                  source: original, boxes, keep, model: engine, steps: stepCount, seed: plan.seed, signal, reference,
                  keepResultOnStop: true,
                  progress: detail => setProgress(title + " · " + detail),
                }));
                usage!.refresh();
                outcome = { blob, seconds: (performance.now() - start) / 1000 };
                cache.set(key, outcome);
              } catch (cause) {
                if (signal.aborted) throw cause;
                failures.push(title + " · " + String(cause));
                continue;
              }
            }
            const { blob, seconds } = outcome;
            setCandidates(previous => {
              const current = previous[image.id]?.revision === image.sourceHash ? previous[image.id] : undefined;
              return { ...previous, [image.id]: { revision: image.sourceHash,
                values: { ...current?.values, [engine]: blob }, seconds: { ...current?.seconds, [engine]: seconds } } };
            });
            if (image.id === active?.id) setPreferredResult(engine);
            pending.delete(engine);
            if (!pending.size) {
              completed++;
              report({ completed, processed: completed - initial });
            }
          }
        } catch (cause) {
          if (signal.aborted) throw cause;
          failures.push(image.name + " · " + String(cause));
        }
      }
      if (completed === total) pendingRedraw.current = null;
      setProgress("");
      if (failures.length) setError(failures.join("\n"));
      return completed === total;
    }, { id: "redraw", total, completed, summary, resume });
  }

  function generate(targets: UnityImage[], models: MosaicModel[]) {
    const usableTargets = targets.filter(image => resultFor(rows, image).boxes.length);
    if (!usableTargets.length) return;
    if (preferences.refine !== false && usableTargets.some(image => {
      const row = resultFor(rows,image);
      return !row.saved && !row.manualBoxes && row.refined !== reviewKey;
    })) {
      setError("请先完成视觉复筛，再重绘所选图片");
      return;
    }
    const seed = parseInt((group || "ab").replace(/[^a-f0-9]/gi, "").slice(-8) || "1", 16);
    startRedraw({ targets: usableTargets.map(image => ({ image, boxes: resultFor(rows,image).boxes,
      keep: keepText(image,protect), pending: new Set(models) })), models, steps, seed, reference });
  }

  function approve(image: UnityImage, blob: Blob) {
    void run("保存已确认候选", async signal => {
      if (storage) await storage.save(image, blob, signal);
      else await mosaicResponse(await fetch(candidatePath(image), { method: "POST", headers: { "Content-Type": "image/png" }, body: blob, signal }));
      update(image, { saved: true, checked: true, discardedHash: undefined });
      setApproved({ id: image.id, revision: image.sourceHash, blob }); setPreferredResult("saved");
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

  const activeBoxes = [...(activeResult?.boxes || []), ...(draft ? [draft] : [])];
  const previousScreen = lastScreen.current;
  const sameScreen = previousScreen?.detector === detectorKey && previousScreen.scope.length === currentScope.length &&
    (previousScreen.scope === currentScope || previousScreen.scope.every((image, i) =>
      image.id === currentScope[i].id && image.sourceHash === currentScope[i].sourceHash));
  const stoppedScreen = sameScreen && stepRuns.screen?.state === "stopped";
  const screenAction = screenTargets.length && !remaining.length ? "重新筛选"
    : screenedCount || stoppedScreen ? "继续筛选" : "开始筛选";
  const lastScreenRun = stepRuns.screen;
  const idleScreen: StepRun = {
    state: screenTotal && !remaining.length ? "done" : screenedCount ? "stopped"
      : currentScope.some(image => resultFor(rows, image).reason) ? "error" : "pending",
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
  const canClearRefine = canClearStep(refineStatus.state) || canClearStep(stepRuns.refine?.state);
  const canClearRedraw = canClearStep(stepRuns.redraw?.state) || Object.keys(candidates).length > 0;
  const canClear = canClearStep(screenStatus.state) || canClearRefine || canClearRedraw;
  const pausedRedraw = (stepRuns.redraw?.state === "stopped" || stepRuns.redraw?.state === "error") ? pendingRedraw.current : null;
  const redrawRemaining = pausedRedraw?.targets.filter(target => target.pending.size).length ?? 0;
  const redrawGroup = selected.filter(image => image.id !== reference?.id && resultFor(rows, image).boxes.length);
  const benchmarkProgress = useBenchmarkProgress(gamePath);
  const testing = useBenchmarkRunning();
  const testTitle = testing ? benchmarkBlockingReason : undefined;
  const benchmarkSteps = { screen: "mosaicScreen", refine: "mosaicRefine", redraw: "mosaicRedraw" } as const;
  const stepCard = (id: MosaicStep, title: string, summary: string, actions: ReactNode, settings: ReactNode) => {
    const status = id === "screen" ? screenStatus : id === "refine" ? refineStatus : stepRuns.redraw;
    const state = status?.state || "pending";
    const running = state === "running";
    const percent = status?.total ? status.completed / status.total * 100 : undefined;
    const measured = groupMosaicModels(mosaicCardMetrics(gamePath, id));
    const elapsed = measured.taskId ? measured.elapsedMs : status?.elapsed ??
      (status?.started == null ? undefined : performance.now() - status.started);
    const expanded = configured === id;
    const toggle = () => setConfigured(expanded ? null : id);
    const modelTitle = (running || id === "redraw" && pausedRedraw) ? status?.summary : summary;
    const models = Object.entries(measured.models);
    const showModelNames = models.length > 1 || models[0]?.[1].model !== modelTitle;
    const detection = id === "screen" ? models[0]?.[1] : undefined;
    const detectionMs = detection?.requests ? detection.requestMs / detection.requests : 0;
    const batchElapsed = status?.batchElapsed ?? (status?.batchStarted === undefined ? 0 : performance.now() - status.batchStarted);
    const imageRate = status?.processed && batchElapsed > 0 ? status.processed * 1000 / batchElapsed : undefined;
    const benchmark = benchmarkProgress?.step === benchmarkSteps[id] ? benchmarkProgress : undefined;
    return <GameFlowCard title={title} state={state} benchmark={benchmark} current={running || !!benchmark} expanded={expanded}
      toggleTooltip={expanded ? "收起设置" : "展开设置"} onToggle={toggle}
      status={<>{gameProgressLabels[state]}{elapsed != null && <> · <span className="game-flow-metric">{gameDuration(elapsed)}</span></>}</>}
      summary={(!benchmark || running) && <div className="game-mosaic-step-summary">
        <span data-tooltip={status?.device?.reason}>{modelTitle}
          {status?.device && (status.device.kind === "gpu" ? " · GPU（WebGPU）" : " · CPU")}
        </span>
        {status?.total ? <small className="game-flow-model-rates">
          <span>{status.completed} / {status.total} 张</span><span>{Math.round(percent ?? 0)}%</span>
          {id === "refine" && status.prepared !== undefined && status.prepared > status.completed &&
            <span>候选已准备 {status.prepared} / {status.total} 张</span>}
        </small> : null}
        {expanded && (imageRate !== undefined || detection || !!status?.failed) &&
          <small className="game-flow-model-rates">
            {imageRate !== undefined && <GameMetricHint onClick={toggle} detail="本批已处理张数除以整批经过时间。含读图、准备、等待和结果处理，不含步骤结束后的异步保存。">
              <span className="game-flow-metric">{imageRate.toFixed(imageRate < 0.1 ? 3 : 2)}</span> 张/秒
            </GameMetricHint>}
            {detection && <>
              <GameMetricHint onClick={toggle} detail="本地检测调用的单张平均耗时，含检测内部的解码与图像处理，不含调用前读图及返回后的结果整理和写回。">
                检测每张 <span className="game-flow-metric">{detectionMs.toFixed(detectionMs < 10 ? 1 : 0)}</span> 毫秒
              </GameMetricHint>
              <span>并发 <span className="game-flow-metric">{detection.concurrency}</span></span>
              <span>请求 <span className="game-flow-metric">{detection.requests} 次</span></span>
            </>}
            {!!status?.failed && <span>失败 <span className="game-flow-metric">{status.failed} 张</span></span>}
          </small>}
        {expanded && running && id === "refine" && !models.length && <small className="game-flow-model-rates" role="status">
          {(status?.prepared ?? 0) < (status?.total ?? 0) ? "正在准备候选区域" : "等待模型请求开始"} · 模型速率 —
        </small>}
        {expanded && id !== "screen" && models.map(([key, model]) => <div key={key}>
          {showModelNames && <span className="game-flow-model-name">{model.model.split("/").at(-1)}</span>}
          {running && id === "refine" && !model.tokens && model.requests > 0 ? <small className="game-flow-model-rates" role="status">
            已发送 {model.requests} 次请求 · 速率在模型返回后更新
          </small> : <GameModelUsage model={model} wallRequestMs={measured.modelWallTiming?.[model.model]?.requestMs}
            perImage={id !== "refine"} onToggle={toggle} />}
        </div>)}
        {(status?.total || id === "screen") && <GameProgressBar label={`${title}进度`} value={percent ?? 0} />}
      </div>}
      actions={running ? <button type="button" className="unity-btn game-flow-start" disabled={task.current?.signal.aborted} onClick={() => {
        task.current?.abort();
        setProgress(id === "redraw" ? "等待当前候选返回，随后暂停重绘" : "正在保存进度并停止后续任务");
      }}>{task.current?.signal.aborted ? "正在中止" : "中止"}</button> : actions}
      configuration={expanded && <div className="game-mosaic-step-settings">{settings}</div>} />;
  };

  const actionsDisabled = !!busy || disabled;
  function clearStepProgress(step: "refine" | "redraw", resetRedraw = false) {
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

    clearMosaicReviews(gamePath);
    const changedMasks = new Set<string>();
    const next: Results = {};
    for (const [id, row] of Object.entries(rows)) {
      const cleared = clearReviewResult(row);
      next[id] = cleared;
      if (cleared.boxes !== row.boxes && JSON.stringify(cleared.boxes) !== JSON.stringify(row.boxes)) changedMasks.add(id);
    }
    const resetRedraw = pendingRedraw.current?.targets.some(({ image }) => changedMasks.has(image.id)) ?? false;
    if (resetRedraw) pendingRedraw.current = null;
    if (changedMasks.size) {
      setCandidates(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !changedMasks.has(id))));
      if (active && changedMasks.has(active.id)) setPreferredResult(undefined);
    }
    setRows(next);
    lastReview.current = null;
    clearStepProgress("refine", resetRedraw);
    showAppNotice("已清理复筛");
  }

  async function clearRedraw() {
    if (actionsDisabled || !canClearRedraw) return;
    if (!await confirmation.confirm("清理未确认的重绘候选和重绘进度？已确认的去码图会保留。", {
      title: "清理重绘", okLabel: "清理",
    }) || task.current) return;

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
      return row.scanned || row.manualChecked || row.saved && !storage?.index[image.id]?.included ||
        row.boxes.length || row.reason || row.refineError || row.manualGroup || candidates[image.id]?.revision === image.sourceHash;
    }).length;
    if (count > 0 && !await confirmation.confirm(`清除本次任务中 ${count} 张图片的筛选、选择、确认结果和进度？已纳入补丁的去码图将保留。`, {
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
    clearMosaicReviews(gamePath);
    setRows(next);
    lastScreen.current = null;
    lastReview.current = null;
    pendingRedraw.current = null;
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
    setDrawing(false);
    setDraft(undefined);
    anchor.current = null;
    showAppNotice("已清理图片去码任务");
  }

  const busyReason = busy ? "正在处理，先中止或等待" : disabled ? "请等待其他工程操作完成" : undefined;
  const redrawReason = testTitle ?? busyReason ?? (!activeResult?.boxes.length ? "先在图上框选打码区域" : undefined);
  const batchReason = testTitle ?? busyReason ?? (!pausedRedraw && !redrawGroup.length ? "先勾选本组中已框选蒙版的待重绘图片" : undefined);
  if (deploymentHandle && !paneVisible) return null;
  const hiddenStyle = paneVisible ? undefined : { display: "none" };
  const screenSummary = detectorKind !== "grid" && detectorFile
    ? "自定义检测 · " + detectorFile.name : detectorLabels[detectorKind];
  return <section className="unity-offline-workbench unity-image-workbench game-mosaic-workbench" aria-label="图片去码" hidden={!paneVisible} style={hiddenStyle}>
    {confirmation.dialog}
    {paneVisible && viewer && <GameImageViewer {...viewer} onClose={() => setViewer(null)} />}
    {createPortal(<div className="game-mosaic-controls game-flow" hidden={!paneVisible} style={hiddenStyle}>
      <div className="game-flow-list"><ol>
        {stepCard("screen", "筛选打码图片", screenSummary, <>
          <button type="button" className="unity-btn unity-btn-primary game-flow-start" disabled={testing || actionsDisabled || !screenTargets.length} title={testTitle}
            onClick={() => screen()}>{screenAction}</button>
          {canClear && <button type="button" className="unity-btn game-flow-clear" disabled={actionsDisabled}
            onClick={() => void clearTask()}>清理</button>}
        </>, <>
          {screenedCount > 0 && remaining.length > 0 && <button type="button" className="unity-btn is-secondary" disabled={testing || actionsDisabled} title={testTitle}
            onClick={() => screen(true)}>重新筛选已勾选图片</button>}
          <label>筛选范围<select aria-label="筛选范围" value={scope} disabled={!!busy} onChange={event => { changePreferences({ scope: event.target.value as typeof scope }); setGroupPages({}); }}>
            <option value="scenes">场景图片</option><option value="all">全部图片</option>
          </select></label>
          <label>筛选并发<select aria-label="去码筛选并发" value={preferences.concurrency ?? 2} disabled={!!busy} onChange={event=>changePreferences({concurrency:Number(event.target.value)})}>
            {[1,2,4].map(value=><option key={value} value={value}>{value}</option>)}
          </select></label>
          <label>筛选方式<select aria-label="打码筛选方式" value={detectorKind} disabled={!!busy} onChange={event => changePreferences({ detector: event.target.value as typeof detectorKind })}>
            <option value="grid">{detectorLabels.grid}</option><option value="anime">{detectorLabels.anime}</option>
          </select></label>
          {detectorKind !== "grid" && <label>自定义定位 ONNX（可选）
            <input type="file" accept=".onnx" disabled={!!busy} onChange={event => setDetectorFile(gameDetectorFile(gamePath, event.target.files?.[0]))} />
            {detectorFile && <button type="button" className="unity-btn" disabled={!!busy} onClick={()=>{clearGameDetectorFile(gamePath);setDetectorFile(undefined);}}>使用内置模型</button>}
          </label>}
        </>)}
        {stepCard("refine","复筛打码图片",preferences.refineModel || "qwen3.5:latest", <>
          <button type="button" className="unity-btn game-flow-start" disabled={testing || actionsDisabled || !checkedReviewScope.length} title={testTitle}
            onClick={()=>refine(!pendingReview.length)}>{!pendingReview.length&&checkedReviewScope.length?"重新复筛":reviewedCount||stepRuns.refine?.state==="stopped"?"继续复筛":"开始复筛"}</button>
          {canClearRefine && <button type="button" className="unity-btn game-flow-clear"
            aria-label="清理复筛" disabled={actionsDisabled} onClick={() => void clearRefine()}>清理</button>}
        </>,<>
          <label>候选区域推理模型<select aria-label="去码复筛视觉模型" value={preferences.refineModel || "qwen3.5:latest"} disabled={!!busy} onChange={e=>changePreferences({refineModel:e.target.value})}>
            {[...new Set(["qwen3.5:latest",...reviewModels])].map(model=><option key={model} value={model}>{model.split("/").pop()}</option>)}
          </select></label>
          <label>纹理与漏检复核模型<select aria-label="去码纹理复核模型" value={preferences.refineGuardModel || "qwen3-vl:8b-instruct"} disabled={!!busy} onChange={e=>changePreferences({refineGuardModel:e.target.value})}>
            {[...new Set(["qwen3-vl:8b-instruct",...reviewModels])].map(model=><option key={model} value={model}>{model.split("/").pop()}</option>)}
          </select></label>
          <p className="hint">推理模型核对检测候选，复核模型检查纹理补检和未检出图片。按模型分批处理，思考模型逐图复筛耗时较长。</p>
          <label>复筛并发<select value={preferences.refineConcurrency ?? 1} disabled={!!busy} onChange={e=>changePreferences({refineConcurrency:Number(e.target.value)})}><option value={1}>1</option><option value={2}>2</option></select></label>
          <label className="game-mosaic-checkbox"><input type="checkbox" checked={!!preferences.refineIncludeMissed} disabled={!!busy} onChange={e=>changePreferences({refineIncludeMissed:e.target.checked})}/>自动流程使用大模型补查未发现（耗时长）</label>
          <label className="game-mosaic-checkbox"><input type="checkbox" checked={preferences.refine!==false} disabled={!!busy} onChange={e=>changePreferences({refine:e.target.checked})}/>自动流程执行视觉复筛</label>
        </>)}
        {stepCard("redraw", "重绘打码区域", mosaicModelLabels[model], <>
          <button type="button" className="unity-btn game-flow-start" disabled={!!batchReason} title={testTitle}
            data-tooltip={batchReason ?? (pausedRedraw ? "按上一次重绘的图片及配置继续" : undefined)}
            onClick={() => pausedRedraw ? startRedraw(pausedRedraw,true) : generate(redrawGroup, [model])}>
            {pausedRedraw ? "继续重绘 · 剩余 " + redrawRemaining : "重绘本组所选 · " + redrawGroup.length} 张
          </button>
          {canClearRedraw && <button type="button" className="unity-btn game-flow-clear"
            aria-label="清理重绘" disabled={actionsDisabled} onClick={() => void clearRedraw()}>清理</button>}
        </>, <>
          <label>去码模型<select aria-label="去码模型" value={model} disabled={!!busy} onChange={event => {
            const next = event.target.value as MosaicModel; changePreferences({ model: next, steps: next === "turbo" ? 8 : 20 });
          }}>
            <option value="turbo">{mosaicModelLabels.turbo}</option><option value="2511">{mosaicModelLabels["2511"]}</option>
          </select></label>
          {model === "2511" && <label>步数<input type="number" min={1} max={100} value={steps} disabled={!!busy}
            onChange={event => changePreferences({ steps: Math.max(1, Math.min(100, Number(event.target.value) || 1)) })} /></label>}
          <label className="game-mosaic-checkbox"><input type="checkbox" checked={protect} disabled={!!busy}
            onChange={event => changePreferences({ protect: event.target.checked })} />保护已识别文字</label>
        </>)}
      </ol></div>
      {(progress || error) && <div className="game-flow-progress">
        {progress && <p className="game-mosaic-progress" role="status">{progress}</p>}
        {error && <p className="game-mosaic-error" role="alert">{error}</p>}
      </div>}
    </div>, controls)}
    <div className="unity-offline-toolbar unity-image-toolbar">
      <GameImageFilter menuRef={filterMenu}>
        <label className="game-mosaic-filter-status">状态<select aria-label="筛选状态" value={statusFilter} onChange={event => { setStatusFilter(event.target.value as typeof statusFilter); setGroupPages({}); }}>
          <option value="all">全部状态</option>{(Object.entries(mosaicStatusLabels) as [MosaicStatus, string][]).map(([id, label])=><option key={id} value={id}>{label}</option>)}
        </select></label>
        <label><input type="checkbox" checked={sceneFilter} disabled={!sceneFilter && !active} onChange={event => {
          if (event.target.checked && active) setActiveId(active.id);
          setSceneFilter(event.target.checked);
          setGroupPages({});
        }} />仅本组</label>
      </GameImageFilter>
      <span className="unity-image-statistics">{visible.length} 张图片 · 已选 {counts.checked} 张 · 已确认 {counts.saved} 张</span>
      <input type="search" aria-label="搜索去码图片" data-tooltip="搜索文件名和路径" placeholder="搜索" value={query} disabled={!!busy}
        onChange={event => { setQuery(event.target.value); setActiveId(""); setSceneFilter(false); setGroupPages({}); }} />
    </div>
    <GameImageSplit listId={listId} listLabel="去码图片列表" listClassName="game-mosaic-list" widthKey="game-mosaic-image-list-width" onListKeyDown={navigateList}
      list={<>
        <ul ref={listRef}>{[...groups].map(([id, items]) => {
          const label = mosaicStatusLabels[id];
          const pages = Math.max(1, Math.ceil(items.length / mosaicPageSize));
          const page = Math.min(groupPages[id] || 0, pages - 1);
          const checked = items.filter(image => resultFor(rows, image).checked).length;
          const delta = refineChanges.get(id);
          return <li key={id} className="game-mosaic-status-group">
            <details className="unity-image-result-group" open={!collapsed[id]} onToggle={event => {
              const closed = !event.currentTarget.open;
              setCollapsed(previous => previous[id] === closed ? previous : { ...previous, [id]: closed });
            }}>
              <summary tabIndex={0} data-mosaic-status={id}><span>{label} · {items.length}</span>
                {delta && <span className="unity-image-change-counts">
                  {delta.added > 0 && <span className="is-added" title="复筛移入">+{delta.added}</span>}
                  {delta.removed > 0 && <span className="is-removed" title="复筛移出">−{delta.removed}</span>}
                </span>}
                <input type="checkbox" className="unity-image-group-check" aria-label={"全选：" + label}
                  disabled={!!busy || !items.length} checked={!!items.length && checked === items.length}
                  ref={node => { if (node) node.indeterminate = checked > 0 && checked < items.length; }}
                  onClick={event => event.stopPropagation()} onChange={event => {
                    const checked = event.target.checked;
                    setRows(previous => {
                      const next = { ...previous };
                      for (const image of items) {
                        const row=resultFor(previous,image);
                        next[image.id]={...row,checked,manualChecked:true,review:row.boxes.length?undefined:row.review};
                      }
                      return next;
                    });
                  }}/>
              </summary>
            <ul>{!collapsed[id] && items.slice(page*mosaicPageSize,(page+1)*mosaicPageSize).map(image => {
                const row = resultFor(rows, image);
                const state = mosaicStatus(row, !!storage?.index[image.id]?.included);
                const status = mosaicStatusLabels[state] + (state === "candidate" ? ` · ${row.boxes.length} 区域` : "");
                const movement = row.refineMovement;
                const change = movement && movement.from !== movement.to
                  ? " · 复筛 " + mosaicStatusLabels[movement.from] + " → " + mosaicStatusLabels[movement.to] : "";
                const detail = `${image.width} × ${image.height} · ${status}` + change;
                return <li key={image.id} data-mosaic-item={image.id} className={`unity-image-item${image.id === active?.id ? " is-selected" : ""}`}>
                  <input type="checkbox" aria-label={"勾选去码 " + image.name} checked={row.checked} disabled={!!busy} onChange={event => update(image, { checked: event.target.checked, manualChecked: true, review: row.boxes.length ? undefined : row.review })} />
                  <button type="button" data-mosaic-row={image.id} aria-current={image.id === active?.id || undefined} data-tooltip={image.file + "\n" + detail} disabled={!!busy}
                    onClick={() => { setActiveId(image.id); setError(""); }}>
                    <strong><SearchHighlight text={image.name} query={needle} /></strong>
                    <small>{detail}</small>
                  </button>
                </li>;
            })}</ul>
            {!collapsed[id] && <GameImageListPagination label={label+"列表分页"} page={page} pages={pages} onPage={page => setGroupPages(previous => ({...previous,[id]:page}))}/>}
            </details></li>;
        })}</ul>
      </>}>
      {!active && <div className="unity-offline-empty">{visible.length ? "从左侧列表选择图片预览" : "没有符合筛选条件的图片。"}</div>}
      {active && activeResult && <section className="unity-image-detail" aria-label="去码预览">
        <div className="unity-image-actions">
          <strong data-tooltip={active.file}><SearchHighlight text={active.name} query={needle} /></strong>
          <div className="unity-image-button-group">
            <span>{members.length} 张 · 本组已选 {selected.length} 张</span>
            <select aria-label="移动当前图片到场景组" disabled={!!busy} value="" onChange={event => {
              const next = event.target.value;
              if (next) update(active, { group: next === "new" ? crypto.randomUUID() : next, manualGroup: true, reference: false });
            }}>
              <option value="" disabled>移动到分组…</option><option value="new">新建独立组</option>
              {[...imageGroup].filter(([key]) => key !== group).slice(0, 350).map(([key, list]) => <option key={key} value={key}>{list[0].name} · {list.length} 张</option>)}
            </select>
            <button className="unity-btn" data-tooltip={activeSaved ? "组内重绘时使用这张已确认图作为画风参考" : "先重绘当前图并确认一版，即可将结果用作组内画风参考"} disabled={!!busy || !activeSaved || reference?.id === active.id} onClick={() => setRows(previous => {
              const next = { ...previous };
              for (const image of members) next[image.id] = { ...resultFor(previous, image), reference: image.id === active.id, group, manualGroup: true };
              return next;
            })}>{reference?.id === active.id ? "本组参考图" : "用作本组画风参考"}</button>
            {reference && <span>参考图 {reference.name}</span>}
          </div>
        </div>
        <div className="unity-image-actions">
          <button type="button" className="unity-btn unity-btn-primary" disabled={!!redrawReason} title={testTitle}
            data-tooltip={redrawReason} onClick={() => generate([active], [model])}>重绘当前图</button>
          <button className="unity-btn" aria-pressed={drawing} disabled={!!busy || !originalUrl}
            onClick={() => setDrawing(value => !value)}>框选蒙版</button>
          <button className="unity-btn is-ghost" disabled={!!busy || !activeResult.boxes.length} onClick={() => editMask(active, activeResult.boxes.slice(0, -1))}>删除最后一框</button>
          <button className="unity-btn is-ghost is-danger" disabled={!!busy || !activeResult.boxes.length} onClick={() => editMask(active, [])}>清空蒙版</button>
          <button className="unity-btn is-ghost" disabled={!!busy || !activeResult.boxes.length || members.length < 2} onClick={() => {
            for (const image of members) if (!resultFor(rows, image).boxes.length && Math.abs(image.width / image.height / (active.width / active.height) - 1) <= 0.04)
              editMask(image, mapMosaicBoxes(activeResult.boxes, active, image));
          }}>复制蒙版到组内空白图</button>
        </div>
        {activeResult.review && <p className="hint">{activeResult.review}</p>}
        {(activeResult.refineError || activeResult.reason) && <p className="game-mosaic-error">{activeResult.refineError || activeResult.reason}</p>}
        <div ref={previews} className={`unity-image-previews${sideBySide ? " is-mosaic-comparison" : ""}`}
          style={{ "--mosaic-image-aspect": active.width / active.height } as CSSProperties}>
          <div className="unity-image-actions game-mosaic-results-bar">
            <strong>去码结果</strong>
            {activeSaved && preferredVersion && <button type="button" className="unity-btn" onClick={() => {
              setPreferredResult(showSaved ? preferredVersion.id : "saved");
            }}>{showSaved ? "查看候选" : "查看已确认"}</button>}
            <button type="button" className="unity-btn is-secondary" disabled={!!redrawReason} title={testTitle} data-tooltip={redrawReason}
              onClick={() => generate([active], ["turbo", "2511"])}>两种模型各生成一版</button>
            {comparing && !sideBySide && <div className="game-mosaic-version-picker" role="group" aria-label="切换去码候选"
              onKeyDown={event => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const index = event.key === "ArrowLeft" ? 0 : 1;
                setPreferredResult(versions[index].id);
                event.currentTarget.querySelectorAll("button")[index].focus();
              }}>
              {versions.map((version, index) => <button key={version.id} type="button" className="unity-btn"
                aria-label={`${index === 0 ? "A" : "B"} · ${mosaicModelLabels[version.id]}`}
                aria-pressed={version.id === preferredVersion.id} onClick={() => setPreferredResult(version.id)}>
                {index === 0 ? "A" : "B"}
              </button>)}
            </div>}
          </div>
          <GameImagePreviewFrame caption="原图" onDoubleClick={!drawing && originalUrl ? () => openPreview("original") : undefined} fallback={original?.error
            ? <p className="game-mosaic-error" role="alert">{original.error}</p> : <p className="hint">正在读取图片…</p>}>
            {originalUrl && <div className="unity-image-stage game-mosaic-stage">
              <img src={originalUrl} alt={`${active.name} 原图`} draggable={false} />
              <svg viewBox={`0 0 ${active.width} ${active.height}`} className={drawing ? "is-drawing" : undefined}
                aria-label="去码蒙版" onPointerDown={event => {
                  if (!drawing || busy || event.button !== 0) return;
                  anchor.current = position(event, active); event.currentTarget.setPointerCapture(event.pointerId);
                }} onPointerMove={event => {
                  if (anchor.current) setDraft(bounds(anchor.current, position(event, active)));
                }} onPointerUp={event => {
                  if (!anchor.current) return;
                  const box = bounds(anchor.current, position(event, active));
                  anchor.current = null; setDraft(undefined);
                  if (box[2] - box[0] >= 4 && box[3] - box[1] >= 4) editMask(active, [...activeResult.boxes, box]);
                }} onPointerCancel={() => { anchor.current = null; setDraft(undefined); }}>
                {activeBoxes.map(([left, top, right, bottom], index) => <rect key={index} x={left} y={top} width={right - left} height={bottom - top}
                  fill="color-mix(in srgb, var(--danger) 25%, transparent)" stroke="var(--danger)" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
              </svg>
            </div>}
          </GameImagePreviewFrame>
          {showSaved ? <GameImagePreviewFrame caption="已确认" onDoubleClick={!drawing && savedUrl ? () => openPreview("saved") : undefined} fallback={confirmed?.error
            ? <p className="game-mosaic-error" role="alert">{confirmed.error}</p> : <p className="hint">正在读取图片…</p>}>
            {savedUrl && <div className="unity-image-stage">
              <img src={savedUrl} alt={`${active.name} 已确认去码结果`} draggable={false} />
            </div>}
          </GameImagePreviewFrame> : preferredVersion ? (sideBySide ? versions : [preferredVersion]).map(version =>
            <MosaicResultVersion key={version.id} version={version}
              letter={comparing ? version.id === "turbo" ? "A" : "B" : undefined}
              imageName={active.name} disabledReason={busyReason} onApprove={blob => approve(active, blob)}
              onOpen={drawing ? undefined : () => openPreview(version.id)} />
          ) : <GameImagePreviewFrame fallback={<p className="hint">尚未生成去码结果</p>} />}
        </div>
        <div className="unity-image-actions">
          <button className="unity-btn" disabled={testing || actionsDisabled || (storage ? saved.length === included.length : !saved.length)} title={testTitle} onClick={() => void patch(false)}>
            {storage ? `纳入生成 · ${saved.length - included.length} 张` : `应用已确认 · ${saved.length} 张`}
          </button>
          <button className="unity-btn" disabled={testing || actionsDisabled || (storage ? !included.length : !selected.length)} title={testTitle} onClick={() => void patch(true)}>
            {storage ? "从生成清单移除" : "撤销本组所选"}
          </button>
        </div>
      </section>}
    </GameImageSplit>
  </section>;
}
