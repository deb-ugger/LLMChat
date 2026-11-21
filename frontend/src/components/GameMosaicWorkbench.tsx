import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "../api";
import { gameDuration } from "../gameModelPerformance";
import { readMosaicSettings, saveMosaicSettings, clearGameDetectorFile, gameDetectorFile, openDeploymentDetector, groupMosaicScenes, loadLadaDetector, mapMosaicBoxes, mosaicInputKey, mosaicModelLabels, redrawMosaic, createMosaicGridScanner, type LadaDevice, type MosaicBox, type MosaicModel } from "../gameMosaic";
import type { UnityImage } from "../unityOffline";
import { showAppNotice } from "./AppNotice";
import { useGameActionConfirm } from "./GameActionConfirm";
import { GameFlowCard } from "./GameFlowCard";
import { GameImageFilter, GameImageListPagination, GameImagePreviewFrame, GameImageSplit } from "./GameImageBrowserLayout";
import { GameProgressBar, gameProgressLabels, type GameProgressState } from "./GameStepProgress";
import { SearchHighlight } from "./SearchHighlight";
import "../gameMosaic.css";

type Result = { source: string; boxes: MosaicBox[]; checked: boolean; group?: string; manualGroup?: boolean;
  scanned?: boolean; detector?: string; manualBoxes?: boolean; manualChecked?: boolean; reason?: string; review?: string; signature?: string | number[]; saved?: boolean; reference?: boolean; discardedHash?: string };
type Results = Record<string, Result>;
type Candidates = Partial<Record<MosaicModel, Blob>>;
type ResultVersion = { id: MosaicModel; blob: Blob; seconds?: number };
type MosaicStep = "screen" | "redraw";
type StepRun = { state: GameProgressState; completed: number; total: number; started?: number; elapsed?: number; summary?: string; device?: LadaDevice };
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
  gamePath: string; images: readonly UnityImage[]; backupMode?: string; storage?: MosaicStorage;
  read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>;
  prepareSources?: (images: readonly UnityImage[], signal: AbortSignal) => Promise<Record<string, string>>;
  controls: HTMLElement; visible?: boolean; disabled?: boolean; onBusy?: (busy: boolean) => void;
  deploymentHandle?: { current: GameMosaicDeploymentHandle | null };
};

const defaultResult = (image: UnityImage): Result => ({ source: image.sourceHash, boxes: [], checked: false });
const mosaicPageSize = 40;
const mosaicStatusLabels = {
  pending: "待筛选", review: "待复核", candidate: "疑似有码",
  confirmed: "已确认", included: "已纳入补丁", clear: "未发现",
} as const;
type MosaicStatus = keyof typeof mosaicStatusLabels;
function mosaicStatus(row: Result, included: boolean): MosaicStatus {
  if (row.saved) return included ? "included" : "confirmed";
  if (row.reason || row.review) return "review";
  if (row.boxes.length) return "candidate";
  return row.scanned ? "clear" : "pending";
}
const detectorLabels = { grid: "方格规则", lada: "Lada v4 Fast（内置）", "lada-accurate": "Lada v4 Accurate（内置）" };
function resultFor(rows: Results, image: UnityImage) {
  const row = rows[image.id];
  return row?.source === image.sourceHash ? row : defaultResult(image);
}

function useBlobUrl(blob?: Blob) {
  const [preview, setPreview] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setPreview({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return preview && preview.blob === blob ? preview.url : "";
}

function MosaicResultVersion({ version, letter, imageName, disabledReason, onApprove }: {
  version: ResultVersion; letter?: string; imageName: string;
  disabledReason?: string; onApprove: (blob: Blob) => void;
}) {
  const url = useBlobUrl(version.blob);
  const modelName = mosaicModelLabels[version.id];
  return <div className="game-mosaic-result-version">
    <GameImagePreviewFrame caption={<>
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

export function GameMosaicWorkbench({ gamePath, images, backupMode, storage, read, prepareSources, controls, visible: paneVisible = true, disabled = false, onBusy, deploymentHandle }: Props) {
  const task = useRef<AbortController | null>(null);
  const onCompletionChange = useContext(GameMosaicCompletionContext);
  const savedKey = "llmchat-game-mosaic:" + gamePath;
  const [rows, setRows] = useState<Results>(() => {
    try { return JSON.parse(localStorage.getItem(savedKey) || "{}") || {}; } catch { return {}; }
  });
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
  const [page, setPage] = useState(0);
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
  const [draft, setDraft] = useState<MosaicBox>();
  const anchor = useRef<[number, number] | null>(null);
  const confirmation = useGameActionConfirm(() => {});
  const usable = useMemo(() => images.filter(image => image.sourceFile && image.width > 0 && image.height > 0)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), [images]);
  useEffect(() => {
    if (!onCompletionChange) return;
    const selectedRows = usable.map(image => resultFor(rows, image)).filter(row => row.checked);
    onCompletionChange(selectedRows.length > 0 && selectedRows.every(row => row.saved === true));
  }, [onCompletionChange, rows, usable]);
  useEffect(() => () => onCompletionChange?.(false), [onCompletionChange]);
  const scenes = useMemo(() => {
    const files = usable.filter(image => /(?:^|[\\/])img[\\/]pictures[\\/]/i.test(image.file));
    return files.length ? files : usable;
  }, [usable]);
  const scoped = scope === "scenes" ? scenes : usable;
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
      if (images?.length) groups.set(status, images);
    }
    return { groups, ordered: [...groups].flatMap(([id, images]) => images.map(image => ({ id, image }))) };
  }, [visible, rows, storage?.index]);
  const pages = Math.max(1, Math.ceil(ordered.length / mosaicPageSize));
  const currentPage = Math.min(page, pages - 1);
  const pageImages = ordered.slice(currentPage * mosaicPageSize, (currentPage + 1) * mosaicPageSize);
  const pageGroups = new Map<MosaicStatus, UnityImage[]>();
  for (const { id, image } of pageImages) {
    const list = pageGroups.get(id);
    if (list) list.push(image);
    else pageGroups.set(id, [image]);
  }
  const active = activeId === null ? undefined : (pageImages.find(item => item.image.id === activeId) ?? pageImages[0])?.image;
  const activeResult = active && resultFor(rows, active);
  const group = active && (activeResult?.group || active.id);
  const members = group ? imageGroup.get(group) || [] : [];
  const reference = members.find(image => resultFor(rows, image).reference && resultFor(rows, image).saved);
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [currentPage, needle, scope, sceneFilter, statusFilter]);
  useLayoutEffect(() => {
    if (!keyboardTarget) return;
    const button = listRef.current?.querySelector<HTMLButtonElement>(
      `button[data-mosaic-row="${CSS.escape(keyboardTarget)}"]`);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest" });
    setKeyboardTarget(undefined);
  }, [keyboardTarget, currentPage]);

  function navigateList(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (busy || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const element = event.target as HTMLElement;
    if (element.matches("input:not([type=checkbox]), select, textarea")) return;
    if (!ordered.length) return;
    event.preventDefault();
    const focused = element.closest<HTMLElement>("[data-mosaic-item]")?.dataset.mosaicItem;
    const index = ordered.findIndex(item => item.image.id === (focused || active?.id));
    let next = currentPage * mosaicPageSize;
    if (index >= 0 && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      next = Math.max(0, Math.min(ordered.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
    } else if (index >= 0) {
      const destination = currentPage + (event.key === "ArrowLeft" ? -1 : 1);
      if (destination < 0 || destination >= pages) return;
      next = Math.min(ordered.length - 1, destination * mosaicPageSize + index % mosaicPageSize);
    }
    const id = ordered[next].image.id;
    setPage(Math.floor(next / mosaicPageSize));
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
  const originalUrl = useBlobUrl(original?.blob);
  const savedUrl = useBlobUrl(showSaved ? confirmed?.blob : undefined);
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
  useEffect(() => { if (!paneVisible) filterMenu.current?.hidePopover(); }, [paneVisible]);
  useEffect(() => {
    if (!paneVisible || !busy || !progressStep) return;
    const timer = window.setInterval(() => refreshElapsed(value => value + 1), 1000);
    return () => window.clearInterval(timer);
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
        const detector = await openDeploymentDetector(gamePath, preferences, signal);
        try {
          for (const image of unscreened) {
            signal.throwIfAborted();
            const row = resultFor(rows, image);
            const source = await read(image, signal);
            const scan = row.manualBoxes || row.scanned && row.detector === detectorKey && !row.reason
              ? { boxes: row.boxes, review: row.review, reviewBoxes: row.boxes } : await detector.scan(source);
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
        } finally { await detector.release(); }
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
    if (!loadPreviews || !showSaved || !active) return;
    const controller = new AbortController();
    void readSaved(active, controller.signal).then(blob => {
      if (!controller.signal.aborted) setApproved({ id: active.id, revision: active.sourceHash, blob });
    }).catch(cause => {
      if (!controller.signal.aborted) setApproved({ id: active.id, revision: active.sourceHash, error: String(cause) });
    });
    return () => controller.abort();
  }, [active, showSaved, loadPreviews]);

  function update(image: UnityImage, edit: Partial<Result>) {
    setRows(previous => ({ ...previous, [image.id]: { ...resultFor(previous, image), ...edit } }));
  }

  async function run(label: string, work: (signal: AbortSignal, report: (completed: number) => void) => Promise<void | boolean>,
    step?: { id: MosaicStep; total: number; completed?: number; summary: string }) {
    if (task.current || disabled) return;
    const controller = new AbortController();
    task.current = controller;
    onBusy?.(true);
    const started = performance.now();
    setProgressStep(step?.id);
    if (step) setStepRuns(previous => ({ ...previous, [step.id]: { state: "running", completed: step.completed ?? 0, total: step.total, summary: step.summary, started } }));
    setBusy(label); setProgress(label); setError("");
    const updateStep = (edit: Partial<StepRun>) => {
      if (!step) return;
      setStepRuns(previous => {
        const current = previous[step.id];
        return current ? { ...previous, [step.id]: { ...current, ...edit } } : previous;
      });
    };
    try {
      const completed = await work(controller.signal, count => updateStep({ completed: count }));
      if (controller.signal.aborted) setProgress("已停止后续任务");
      updateStep({ state: controller.signal.aborted ? "stopped" : completed === false ? "error" : "done", elapsed: performance.now() - started });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      else setProgress("已停止后续任务");
      updateStep({ state: controller.signal.aborted ? "stopped" : "error", elapsed: performance.now() - started });
    } finally {
      task.current = null; setBusy("");
      onBusy?.(false);
    }
  }

  const detectorKey = detectorKind === "grid" ? "grid-v2" : detectorFile
    ? JSON.stringify(["lada-alpha-v3", detectorFile.name, detectorFile.size, detectorFile.lastModified]) : detectorKind + "-v4-640-alpha-v3";
  const lastScreen = useRef<{ scope: readonly UnityImage[]; detector: string } | null>(null);
  const remaining = useMemo(() => currentScope.filter(image => {
    const row = resultFor(rows, image);
    return !row.scanned || !!row.reason || (row.detector ?? "grid") !== detectorKey;
  }), [currentScope, rows, detectorKey]);
  const screenedCount = currentScope.length - remaining.length;

  function screen(restart = remaining.length === 0) {
    const targets = restart ? currentScope : remaining;
    if (!targets.length) return;
    lastScreen.current = { scope: currentScope, detector: detectorKey };
    const initial = restart ? 0 : screenedCount;
    void run("筛选打码区域", async (signal, report) => {
      const lada = detectorKind !== "grid" ? await loadLadaDetector(detectorFile, {
        signal, variant: detectorKind === "lada-accurate" ? "accurate" : "fast",
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
      let lastReport = 0;
      const checkpoint = () => {
        const changes = batch;
        batch = {};
        setRows(previous => ({ ...previous, ...changes }));
      };
      async function lane() {
        const scanner = lada ?? createMosaicGridScanner();
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
                const scan = await scanner.scan(input);
                const { signature } = scan;
                const boxes = scan.boxes.length ? scan.boxes : scan.reviewBoxes || [];
                batch[image.id] = { ...old, boxes: old.manualBoxes || old.saved ? old.boxes : boxes,
                  checked: old.manualChecked || old.manualBoxes || old.saved ? old.checked : scan.boxes.length > 0,
                  signature: btoa(String.fromCharCode(...signature)), detector: detectorKey, scanned: true, reason: undefined, review: old.manualChecked || old.manualBoxes || old.saved ? undefined : scan.review };
              } catch (cause) {
                if (signal.aborted) break;
                failures++;
                batch[image.id] = { ...old, scanned: false, reason: cause instanceof Error ? cause.message : String(cause) };
              }
              completed++;
              if ((completed - initial) % 64 === 0) checkpoint();
              const now = performance.now();
              if (now - lastReport >= 150) {
                report(completed);
                setProgress(image.name);
                lastReport = now;
              }
            }
          }
        } finally { if (!lada) await scanner.release(); }
      }
      try {
        const lanes = lada || navigator.hardwareConcurrency < 4 || targets.some(image => image.width * image.height > 8_000_000) ? 1 : 2;
        const settled = await Promise.allSettled(Array.from({ length: Math.min(lanes, targets.length) }, lane));
        for (const item of settled) if (item.status === "rejected") throw item.reason;
      } finally {
        checkpoint();
        report(completed);
        await lada?.release();
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
      setProgress(failures ? `${failures} 张读取失败，可在待复核列表查看。` : "");
      return failures === 0;
    }, { id: "screen", total: currentScope.length, completed: initial, summary: detectorLabels[detectorKind] });
  }

  function editMask(image: UnityImage, boxes: MosaicBox[]) {
    update(image, { boxes, manualBoxes: true, saved: storage ? resultFor(rows, image).saved : false, reference: false, checked: boxes.length > 0 });
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

  function generate(targets: UnityImage[], models: MosaicModel[]) {
    const usableTargets = targets.filter(image => resultFor(rows, image).boxes.length);
    if (!usableTargets.length) return;
    void run("生成去码候选", async (signal, report) => {
      const ref = reference && await readSaved(reference, signal);
      const seed = parseInt((group || "ab").replace(/[^a-f0-9]/gi, "").slice(-8) || "1", 16);
      const cache = new Map<string, { blob: Blob; seconds: number }>();
      const failures: string[] = [];
      for (const [index, image] of usableTargets.entries()) {
        signal.throwIfAborted();
        try {
          const original = await read(image, signal);
          const boxes = resultFor(rows, image).boxes;
          const keep = keepText(image, protect);
          const input = await mosaicInputKey(original, boxes);
          for (const engine of models) {
            signal.throwIfAborted();
            const title = image.name + " · " + mosaicModelLabels[engine];
            setProgress(title);
            const stepCount = models.length === 1 ? steps : engine === "turbo" ? 8 : 20;
            const key = JSON.stringify([engine, stepCount, input, keep, image.id === reference?.id ? "" : reference?.id]);
            let outcome = cache.get(key);
            if (!outcome) {
              const start = performance.now();
              try {
                const blob = await redrawMosaic({
                  source: original, boxes, keep, model: engine, steps: stepCount, seed, signal,
                  reference: image.id === reference?.id ? undefined : ref,
                  progress: detail => setProgress(title + " · " + detail),
                });
                outcome = { blob, seconds: (performance.now() - start) / 1000 };
                cache.set(key, outcome);
              } catch (cause) {
                if (signal.aborted) throw cause;
                failures.push(image.name + " · " + mosaicModelLabels[engine] + " · " + String(cause));
                continue;
              }
            }
            const { blob, seconds } = outcome;
            setCandidates(previous => ({ ...previous, [image.id]: {
              revision: image.sourceHash, values: { ...previous[image.id]?.values, [engine]: blob },
              seconds: { ...previous[image.id]?.seconds, [engine]: seconds },
            } }));
            if (image.id === active?.id) setPreferredResult(engine);
          }
        } catch (cause) {
          if (signal.aborted) throw cause;
          failures.push(image.name + " · " + String(cause));
        }
        report(index + 1);
      }
      setProgress("");
      if (failures.length) setError(failures.join("\n"));
      return failures.length === 0;
    }, { id: "redraw", total: usableTargets.length, summary: models.map(engine => mosaicModelLabels[engine]).join("、") });
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
  const screenAction = currentScope.length && !remaining.length ? "重新筛选"
    : screenedCount || stoppedScreen ? "继续筛选" : "开始筛选";
  const lastScreenRun = stepRuns.screen;
  const idleScreen: StepRun = {
    state: currentScope.length && screenedCount === currentScope.length ? "done" : screenedCount ? "stopped"
      : currentScope.some(image => resultFor(rows, image).reason) ? "error" : "pending",
    total: currentScope.length, completed: screenedCount,
  };
  const screenStatus = lastScreenRun?.state === "running" ? lastScreenRun : {
    ...idleScreen,
    state: sameScreen && (lastScreenRun?.state === "error" || lastScreenRun?.state === "stopped") ? lastScreenRun.state : idleScreen.state,
    elapsed: sameScreen ? lastScreenRun?.elapsed : undefined,
    device: sameScreen ? lastScreenRun?.device : undefined,
  };
  const canClear = [screenStatus.state, stepRuns.redraw?.state].some(state => state === "stopped" || state === "error" || state === "done");
  const redrawGroup = selected.filter(image => image.id !== reference?.id && resultFor(rows, image).boxes.length);
  const stepCard = (id: MosaicStep, title: string, summary: string, actions: ReactNode, settings: ReactNode) => {
    const status = id === "screen" ? screenStatus : stepRuns.redraw;
    const state = status?.state || "pending";
    const running = state === "running";
    const percent = status?.total ? status.completed / status.total * 100 : undefined;
    const elapsed = status?.elapsed ?? (status?.started == null ? undefined : performance.now() - status.started);
    const expanded = configured === id;
    return <GameFlowCard title={title} state={state} current={running} expanded={expanded}
      toggleTooltip={expanded ? "收起设置" : "展开设置"} onToggle={() => setConfigured(expanded ? null : id)}
      status={<>{gameProgressLabels[state]}{elapsed != null && <> · <span className="game-flow-metric">{gameDuration(elapsed)}</span></>}</>}
      summary={<div className="game-mosaic-step-summary">
        <span data-tooltip={status?.device?.reason}>{running ? status?.summary : summary}
          {status?.device && (status.device.kind === "gpu" ? " · GPU（WebGPU）" : " · CPU")}
        </span>
        {status?.total ? <small className="game-flow-model-rates">
          <span>{status.completed} / {status.total} 张</span><span>{Math.round(percent ?? 0)}%</span>
        </small> : null}
        {(running || id === "screen") && <GameProgressBar label={`${title}进度`} value={percent ?? 0} />}
      </div>}
      actions={running ? <button type="button" className="unity-btn game-flow-start" disabled={task.current?.signal.aborted} onClick={() => {
        task.current?.abort(); setProgress("等待当前任务返回后停止后续任务");
      }}>{task.current?.signal.aborted ? "正在中止" : "中止"}</button> : actions}
      configuration={expanded && <div className="game-mosaic-step-settings">{settings}</div>} />;
  };

  const actionsDisabled = !!busy || disabled;
  async function clearTask() {
    if (!canClear || actionsDisabled) return;
    const count = usable.filter(image => {
      const row = resultFor(rows, image);
      return row.scanned || row.checked || row.saved && !storage?.index[image.id]?.included ||
        row.boxes.length || row.reason || row.manualGroup || candidates[image.id]?.revision === image.sourceHash;
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
    setRows(next);
    lastScreen.current = null;
    setStepRuns({});
    setProgressStep(undefined);
    setProgress("");
    setError("");
    setPage(0);
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
  const redrawReason = busyReason ?? (!activeResult?.boxes.length ? "先在图上框选打码区域" : undefined);
  const batchReason = busyReason ?? (!redrawGroup.length ? "先勾选本组中已框选蒙版的待重绘图片" : undefined);
  if (deploymentHandle && !paneVisible) return null;
  const hiddenStyle = paneVisible ? undefined : { display: "none" };
  const screenSummary = detectorKind !== "grid" && detectorFile
    ? `${detectorLabels.lada} · ${detectorFile.name}` : detectorLabels[detectorKind];
  return <section className="unity-offline-workbench unity-image-workbench game-mosaic-workbench" aria-label="图片去码" hidden={!paneVisible} style={hiddenStyle}>
    {confirmation.dialog}
    {createPortal(<div className="game-mosaic-controls game-flow" hidden={!paneVisible} style={hiddenStyle}>
      <div className="game-flow-list"><ol>
        {stepCard("screen", "筛选打码图片", screenSummary, <>
          <button type="button" className="unity-btn unity-btn-primary game-flow-start" disabled={actionsDisabled || !currentScope.length}
            onClick={() => screen()}>{screenAction}</button>
          {canClear && <button type="button" className="unity-btn game-flow-clear" disabled={actionsDisabled}
            onClick={() => void clearTask()}>清理</button>}
        </>, <>
          {screenedCount > 0 && remaining.length > 0 && <button type="button" className="unity-btn" disabled={actionsDisabled}
            onClick={() => screen(true)}>重新筛选全部范围</button>}
          <label>筛选范围<select aria-label="筛选范围" value={scope} disabled={!!busy} onChange={event => { changePreferences({ scope: event.target.value as typeof scope }); setPage(0); }}>
            <option value="scenes">场景图片</option><option value="all">全部图片</option>
          </select></label>
          <label>筛选方式<select aria-label="打码筛选方式" value={detectorKind} disabled={!!busy} onChange={event => changePreferences({ detector: event.target.value as typeof detectorKind })}>
            <option value="grid">{detectorLabels.grid}</option><option value="lada">{detectorLabels.lada}</option><option value="lada-accurate">{detectorLabels["lada-accurate"]}</option>
          </select></label>
          {detectorKind !== "grid" && <label>自定义 ONNX（可选）
            <input type="file" accept=".onnx" disabled={!!busy} onChange={event => setDetectorFile(gameDetectorFile(gamePath, event.target.files?.[0]))} />
            {detectorFile && <button type="button" className="unity-btn" disabled={!!busy} onClick={()=>{clearGameDetectorFile(gamePath);setDetectorFile(undefined);}}>使用内置模型</button>}
          </label>}
        </>)}
        {stepCard("redraw", "重绘打码区域", mosaicModelLabels[model],
          <button type="button" className="unity-btn game-flow-start" disabled={!!batchReason} data-tooltip={batchReason}
            onClick={() => generate(redrawGroup, [model])}>重绘本组所选 · {redrawGroup.length} 张</button>, <>
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
        <label className="game-mosaic-filter-status">状态<select aria-label="筛选状态" value={statusFilter} onChange={event => { setStatusFilter(event.target.value as typeof statusFilter); setPage(0); }}>
          <option value="all">全部状态</option>{(Object.entries(mosaicStatusLabels) as [MosaicStatus, string][]).map(([id, label])=><option key={id} value={id}>{label}</option>)}
        </select></label>
        <label><input type="checkbox" checked={sceneFilter} disabled={!sceneFilter && !active} onChange={event => {
          if (event.target.checked && active) setActiveId(active.id);
          setSceneFilter(event.target.checked);
          setPage(0);
        }} />仅本组</label>
      </GameImageFilter>
      <span className="unity-image-statistics">{visible.length} 张图片 · 已选 {counts.checked} 张 · 已确认 {counts.saved} 张</span>
      <input type="search" aria-label="搜索去码图片" data-tooltip="搜索文件名和路径" placeholder="搜索" value={query} disabled={!!busy}
        onChange={event => { setQuery(event.target.value); setActiveId(""); setSceneFilter(false); setPage(0); }} />
    </div>
    <GameImageSplit listId={listId} listLabel="去码图片列表" listClassName="game-mosaic-list" widthKey="game-mosaic-image-list-width" onListKeyDown={navigateList}
      list={<>
        <ul ref={listRef}>{[...pageGroups].map(([id, items]) => {
          const label = mosaicStatusLabels[id];
          return <li key={id} className="game-mosaic-scene-group">
            <div className="game-mosaic-scene-heading" data-tooltip={label}><strong>{label}</strong>
              <span>{groups.get(id)?.length ?? items.length} 张</span>
            </div>
            <ul>{items.map(image => {
                const row = resultFor(rows, image);
                const state = mosaicStatus(row, !!storage?.index[image.id]?.included);
                const status = mosaicStatusLabels[state] + (state === "candidate" ? ` · ${row.boxes.length} 区域` : "");
                const detail = `${image.width} × ${image.height} · ${status}`;
                return <li key={image.id} data-mosaic-item={image.id} className={`unity-image-item${image.id === active?.id ? " is-selected" : ""}`}>
                  <input type="checkbox" aria-label={"勾选去码 " + image.name} checked={row.checked} disabled={!!busy} onChange={event => update(image, { checked: event.target.checked, manualChecked: true, review: undefined })} />
                  <button type="button" data-mosaic-row={image.id} aria-current={image.id === active?.id || undefined} data-tooltip={image.file + "\n" + detail} disabled={!!busy}
                    onClick={() => { setActiveId(image.id); setError(""); }}>
                    <strong><SearchHighlight text={image.name} query={needle} /></strong>
                    <small>{detail}</small>
                  </button>
                </li>;
            })}</ul></li>;
        })}</ul>
        <GameImageListPagination label="去码图片列表分页" page={currentPage} pages={pages} onPage={setPage} />
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
          <button type="button" className="unity-btn unity-btn-primary" disabled={!!redrawReason}
            data-tooltip={redrawReason} onClick={() => generate([active], [model])}>重绘当前图</button>
          <button className="unity-btn" aria-pressed={drawing} disabled={!!busy || !originalUrl}
            onClick={() => setDrawing(value => !value)}>框选蒙版</button>
          <button className="unity-btn" disabled={!!busy || !activeResult.boxes.length} onClick={() => editMask(active, activeResult.boxes.slice(0, -1))}>删除最后一框</button>
          <button className="unity-btn" disabled={!!busy || !activeResult.boxes.length} onClick={() => editMask(active, [])}>清空蒙版</button>
          <button className="unity-btn" disabled={!!busy || !activeResult.boxes.length || members.length < 2} onClick={() => {
            for (const image of members) if (!resultFor(rows, image).boxes.length && Math.abs(image.width / image.height / (active.width / active.height) - 1) <= 0.04)
              editMask(image, mapMosaicBoxes(activeResult.boxes, active, image));
          }}>复制蒙版到组内空白图</button>
        </div>
        {activeResult.review && <p className="hint">{activeResult.review}</p>}
        {activeResult.reason && <p className="game-mosaic-error">{activeResult.reason}</p>}
        <div ref={previews} className={`unity-image-previews${sideBySide ? " is-mosaic-comparison" : ""}`}
          style={{ "--mosaic-image-aspect": active.width / active.height } as CSSProperties}>
          <div className="unity-image-actions game-mosaic-results-bar">
            <strong>去码结果</strong>
            {activeSaved && preferredVersion && <button type="button" className="unity-btn" onClick={() => {
              setPreferredResult(showSaved ? preferredVersion.id : "saved");
            }}>{showSaved ? "查看候选" : "查看已确认"}</button>}
            <button type="button" className="unity-btn" disabled={!!redrawReason} data-tooltip={redrawReason}
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
          <GameImagePreviewFrame caption="原图" fallback={original?.error
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
          {showSaved ? <GameImagePreviewFrame caption="已确认" fallback={confirmed?.error
            ? <p className="game-mosaic-error" role="alert">{confirmed.error}</p> : <p className="hint">正在读取图片…</p>}>
            {savedUrl && <div className="unity-image-stage">
              <img src={savedUrl} alt={`${active.name} 已确认去码结果`} draggable={false} />
            </div>}
          </GameImagePreviewFrame> : preferredVersion ? (sideBySide ? versions : [preferredVersion]).map(version =>
            <MosaicResultVersion key={version.id} version={version}
              letter={comparing ? version.id === "turbo" ? "A" : "B" : undefined}
              imageName={active.name} disabledReason={busyReason} onApprove={blob => approve(active, blob)} />
          ) : <GameImagePreviewFrame fallback={<p className="hint">尚未生成去码结果</p>} />}
        </div>
        <div className="unity-image-actions">
          <button className="unity-btn" disabled={actionsDisabled || (storage ? saved.length === included.length : !saved.length)} onClick={() => void patch(false)}>
            {storage ? `纳入生成 · ${saved.length - included.length} 张` : `应用已确认 · ${saved.length} 张`}
          </button>
          <button className="unity-btn" disabled={actionsDisabled || (storage ? !included.length : !selected.length)} onClick={() => void patch(true)}>
            {storage ? "从生成清单移除" : "撤销本组所选"}
          </button>
        </div>
      </section>}
    </GameImageSplit>
  </section>;
}
