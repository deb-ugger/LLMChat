import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "../api";
import { gameDuration } from "../gameModelPerformance";
import { groupMosaicScenes, loadLadaDetector, mapMosaicBoxes, mosaicInputKey, mosaicModelLabels, redrawMosaic, createMosaicGridScanner, type MosaicBox, type MosaicModel } from "../gameMosaic";
import type { UnityImage } from "../unityOffline";
import { showAppNotice } from "./AppNotice";
import { useGameActionConfirm } from "./GameActionConfirm";
import { GameFlowCard } from "./GameFlowCard";
import { GameImageFilter, GameImageListPagination, GameImagePreviewFrame, GameImageSplit } from "./GameImageBrowserLayout";
import { GameProgressBar, gameProgressLabels, type GameProgressState } from "./GameStepProgress";
import { SearchHighlight } from "./SearchHighlight";
import "../gameMosaic.css";

type Result = { source: string; boxes: MosaicBox[]; checked: boolean; group?: string; manualGroup?: boolean;
  scanned?: boolean; detector?: string; manualBoxes?: boolean; manualChecked?: boolean; reason?: string; signature?: string | number[]; saved?: boolean; reference?: boolean };
type Results = Record<string, Result>;
type Candidates = Partial<Record<MosaicModel, Blob>>;
type MosaicStep = "screen" | "redraw";
type StepRun = { state: GameProgressState; completed: number; total: number; started?: number; elapsed?: number; summary?: string };
type ImagePreview = { id: string; revision: string; blob?: Blob; error?: string };
export type MosaicCandidateIndex = Record<string, { source: string; included: boolean }>;
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
};

const defaultResult = (image: UnityImage): Result => ({ source: image.sourceHash, boxes: [], checked: false });
const mosaicPageSize = 40;
const detectorLabels = { grid: "方格规则", lada: "Lada 专用检测" };
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

export function GameMosaicWorkbench({ gamePath, images, backupMode, storage, read, prepareSources, controls, visible: paneVisible = true, disabled = false, onBusy }: Props) {
  const task = useRef<AbortController | null>(null);
  const savedKey = "llmchat-game-mosaic:" + gamePath;
  const [rows, setRows] = useState<Results>(() => {
    try { return JSON.parse(localStorage.getItem(savedKey) || "{}") || {}; } catch { return {}; }
  });
  useEffect(() => {
    if (!storage) return;
    setRows(previous => {
      const next = { ...previous };
      for (const image of images) {
        const saved = storage.index[image.id]?.source === image.sourceHash;
        const row = resultFor(previous, image);
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
  const filterMenu = useRef<HTMLDivElement>(null);
  const [configured, setConfigured] = useState<MosaicStep | null>(null);
  const [scope, setScope] = useState<"scenes" | "all">("scenes");
  const [detectorKind, setDetectorKind] = useState<"grid" | "lada">("grid");
  const [detectorFile, setDetectorFile] = useState<File>();
  const [sceneFilter, setSceneFilter] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "candidate" | "unknown" | "clear">("all");
  const [model, setModel] = useState<MosaicModel>("turbo");
  const [steps, setSteps] = useState(8);
  const [protect, setProtect] = useState(true);
  const [activeId, setActiveId] = useState("");
  const [busy, setBusy] = useState("");
  const [progressStep, setProgressStep] = useState<MosaicStep>();
  const [stepRuns, setStepRuns] = useState<Partial<Record<MosaicStep, StepRun>>>({});
  const [, refreshElapsed] = useState(0);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState<ImagePreview>();
  const [approved, setApproved] = useState<ImagePreview>();
  const [candidates, setCandidates] = useState<Record<string, { revision: string; values: Candidates; seconds: Partial<Record<MosaicModel, number>> }>>({});
  const [preferredResult, setPreferredResult] = useState<"saved" | MosaicModel>("saved");
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<MosaicBox>();
  const anchor = useRef<[number, number] | null>(null);
  const confirmation = useGameActionConfirm(() => {});
  const usable = useMemo(() => images.filter(image => image.sourceFile && image.width > 0 && image.height > 0)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), [images]);
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
  const visible = useMemo(() => statusFilter === "all" ? currentScope : currentScope.filter(image => {
    const row = resultFor(rows, image);
    return statusFilter === "candidate" ? row.boxes.length > 0 : statusFilter === "unknown" ? !row.scanned || !!row.reason : row.scanned && !row.reason && !row.boxes.length;
  }), [currentScope, rows, statusFilter]);
  const pages = Math.max(1, Math.ceil(visible.length / mosaicPageSize));
  const currentPage = Math.min(page, pages - 1);
  const pageImages = visible.slice(currentPage * mosaicPageSize, (currentPage + 1) * mosaicPageSize);
  const active = pageImages.find(image => image.id === activeId) ?? pageImages[0];
  const activeResult = active && resultFor(rows, active);
  const group = active && (activeResult?.group || active.id);
  const members = group ? imageGroup.get(group) || [] : [];
  const reference = members.find(image => resultFor(rows, image).reference && resultFor(rows, image).saved);
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [currentPage, needle, scope, sceneFilter, statusFilter]);
  const selected = members.filter(image => resultFor(rows, image).checked);
  const saved = selected.filter(image => resultFor(rows, image).saved);
  const included = saved.filter(image => storage?.index[image.id]?.included);
  const result = active && candidates[active.id]?.revision === active.sourceHash ? candidates[active.id] : undefined;
  const values = result?.values;
  const activeSaved = !!activeResult?.saved;
  const resultOptions = [
    ...(activeSaved ? [{ id: "saved" as const, label: "已确认" }] : []),
    ...(["turbo", "2511"] as const).flatMap(id => {
      const seconds = result?.seconds[id];
      return values?.[id] ? [{ id, label: mosaicModelLabels[id] + (seconds == null ? "" : ` · ${seconds.toFixed(1)} 秒`) }] : [];
    }),
  ];
  const view = resultOptions.find(option => option.id === preferredResult)?.id ?? resultOptions[0]?.id;
  const candidate = view && view !== "saved" ? values?.[view] : undefined;
  const original = source && source.id === active?.id && source.revision === active.sourceHash ? source : undefined;
  const confirmed = approved && approved.id === active?.id && approved.revision === active.sourceHash ? approved : undefined;
  const originalUrl = useBlobUrl(original?.blob);
  const resultUrl = useBlobUrl(view === "saved" ? confirmed?.blob : candidate);
  const counts = useMemo(() => visible.reduce((total, image) => {
    const row = resultFor(rows, image);
    if (row.checked) total.checked++;
    if (row.saved) total.saved++;
    return total;
  }, { checked: 0, saved: 0 }), [visible, rows]);

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
  const readSaved = async (image: UnityImage, signal: AbortSignal) =>
    storage ? storage.read(image, signal) : (await mosaicResponse(await fetch(candidatePath(image), { signal, cache: "no-store" }))).blob();

  useEffect(() => {
    const image = active;
    if (!image) return;
    const controller = new AbortController();
    setPreferredResult("saved"); setDrawing(false); setDraft(undefined); anchor.current = null;
    void read(image, controller.signal).then(blob => {
      if (!controller.signal.aborted) setSource({ id: image.id, revision: image.sourceHash, blob });
    }).catch(cause => {
      if (!controller.signal.aborted) setSource({ id: image.id, revision: image.sourceHash, error: String(cause) });
    });
    return () => controller.abort();
  }, [active, read]);

  useEffect(() => {
    if (view !== "saved" || !active || !activeSaved) return;
    const controller = new AbortController();
    void readSaved(active, controller.signal).then(blob => {
      if (!controller.signal.aborted) setApproved({ id: active.id, revision: active.sourceHash, blob });
    }).catch(cause => {
      if (!controller.signal.aborted) setApproved({ id: active.id, revision: active.sourceHash, error: String(cause) });
    });
    return () => controller.abort();
  }, [active, activeSaved, view]);

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

  const detectorKey = detectorKind === "grid" ? "grid" : detectorFile
    ? JSON.stringify(["lada", detectorFile.name, detectorFile.size, detectorFile.lastModified]) : "";
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
      if (detectorKind === "lada" && !detectorFile) throw new Error("请选择 Lada v4 的 ONNX 文件");
      const lada = detectorKind === "lada" && detectorFile ? await loadLadaDetector(detectorFile) : undefined;
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
                const { boxes, signature } = await scanner.scan(input);
                batch[image.id] = { ...old, boxes: old.manualBoxes || old.saved ? old.boxes : boxes,
                  checked: old.manualChecked || old.manualBoxes || old.saved ? old.checked : boxes.length > 0,
                  signature: btoa(String.fromCharCode(...signature)), detector: detectorKey, scanned: true, reason: undefined };
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
      update(image, { saved: true, checked: true });
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
      const response = await mosaicResponse(await fetch(API_BASE + "/api/game-images/" + (undo ? "mosaic-uninstall" : "mosaic-apply"), {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gamePath, imageIds: targets.map(image => image.id), backupMode }),
      }));
      const detail = await response.json();
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
  const idleScreen: StepRun = { state: currentScope.length && screenedCount === currentScope.length ? "done" : screenedCount ? "stopped" : "pending",
    total: currentScope.length, completed: screenedCount };
  const redrawGroup = selected.filter(image => image.id !== reference?.id && resultFor(rows, image).boxes.length);
  const stepCard = (id: MosaicStep, title: string, summary: string, actions: ReactNode, settings: ReactNode) => {
    const lastRun = stepRuns[id];
    const status: StepRun | undefined = id === "screen" && lastRun?.state !== "running"
      ? { ...idleScreen, state: sameScreen && lastRun && (lastRun.state === "error" || lastRun.state === "stopped") ? lastRun.state : idleScreen.state,
          elapsed: sameScreen ? lastRun?.elapsed : undefined }
      : lastRun;
    const state = status?.state || "pending";
    const running = state === "running";
    const percent = status?.total ? status.completed / status.total * 100 : undefined;
    const elapsed = status?.elapsed ?? (status?.started == null ? undefined : performance.now() - status.started);
    const expanded = configured === id;
    return <GameFlowCard title={title} state={state} current={running} expanded={expanded}
      toggleTooltip={expanded ? "收起设置" : "展开设置"} onToggle={() => setConfigured(expanded ? null : id)}
      status={<>{gameProgressLabels[state]}{elapsed != null && <> · <span className="game-flow-metric">{gameDuration(elapsed)}</span></>}</>}
      summary={<div className="game-mosaic-step-summary">
        <span>{running ? status?.summary : summary}</span>
        {status?.total ? <small className="game-flow-model-rates">
          <span>{status.completed} / {status.total} 张</span><span>{Math.round(percent ?? 0)}%</span>
        </small> : null}
        {(running || id === "screen" && (!!status?.completed || stoppedScreen)) && <GameProgressBar label={`${title}进度`} value={percent} />}
      </div>}
      actions={running ? <button type="button" className="unity-btn game-flow-start" disabled={task.current?.signal.aborted} onClick={() => {
        task.current?.abort(); setProgress("等待当前任务返回后停止后续任务");
      }}>{task.current?.signal.aborted ? "正在中止" : "中止"}</button> : actions}
      configuration={expanded && <div className="game-mosaic-step-settings">{settings}</div>} />;
  };

  const actionsDisabled = !!busy || disabled;
  const hiddenStyle = paneVisible ? undefined : { display: "none" };
  const previewWidth = active ? Math.min(active.width, 320 * active.width / active.height) : 0;
  const screenSummary = detectorKind === "lada" && detectorFile
    ? `${detectorLabels.lada} · ${detectorFile.name}` : detectorLabels[detectorKind];
  return <section className="unity-offline-workbench unity-image-workbench game-mosaic-workbench" aria-label="图片去码" hidden={!paneVisible} style={hiddenStyle}>
    {confirmation.dialog}
    {createPortal(<div className="game-mosaic-controls game-flow" hidden={!paneVisible} style={hiddenStyle}>
      <div className="game-flow-list"><ol>
        {stepCard("screen", "筛选打码图片", screenSummary,
          <button type="button" className="unity-btn unity-btn-primary game-flow-start" disabled={actionsDisabled || !currentScope.length || detectorKind === "lada" && !detectorFile}
            onClick={() => screen()}>{screenAction}</button>, <>
          {screenedCount > 0 && remaining.length > 0 && <button type="button" className="unity-btn" disabled={actionsDisabled}
            onClick={() => screen(true)}>重新筛选全部范围</button>}
          <label>筛选范围<select aria-label="筛选范围" value={scope} disabled={!!busy} onChange={event => { setScope(event.target.value as typeof scope); setPage(0); }}>
            <option value="scenes">场景图片</option><option value="all">全部图片</option>
          </select></label>
          <label>筛选方式<select aria-label="打码筛选方式" value={detectorKind} disabled={!!busy} onChange={event => setDetectorKind(event.target.value as typeof detectorKind)}>
            <option value="grid">{detectorLabels.grid}</option><option value="lada">{detectorLabels.lada}</option>
          </select></label>
          {detectorKind === "lada" && <label>本地模型
            <input type="file" accept=".onnx" disabled={!!busy} onChange={event => setDetectorFile(event.target.files?.[0])} />
          </label>}
        </>)}
        {stepCard("redraw", "重绘打码区域", mosaicModelLabels[model], <>
          <button type="button" className="unity-btn unity-btn-primary game-flow-start" disabled={actionsDisabled || !activeResult?.boxes.length}
            onClick={() => active && generate([active], [model])}>重绘当前图</button>
          <button type="button" className="unity-btn" disabled={actionsDisabled || !reference || !redrawGroup.length}
            onClick={() => generate(redrawGroup, [model])}>重绘本组所选</button>
          <button type="button" className="unity-btn" disabled={actionsDisabled || !activeResult?.boxes.length}
            onClick={() => active && generate([active], ["turbo", "2511"])}>对比两种模型</button>
        </>, <>
          <label>去码模型<select aria-label="去码模型" value={model} disabled={!!busy} onChange={event => {
            const next = event.target.value as MosaicModel; setModel(next); setSteps(next === "turbo" ? 8 : 20);
          }}>
            <option value="turbo">{mosaicModelLabels.turbo}</option><option value="2511">{mosaicModelLabels["2511"]}</option>
          </select></label>
          {model === "2511" && <label>步数<input type="number" min={1} max={100} value={steps} disabled={!!busy}
            onChange={event => setSteps(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} /></label>}
          <label className="game-mosaic-checkbox"><input type="checkbox" checked={protect} disabled={!!busy}
            onChange={event => setProtect(event.target.checked)} />保护已识别文字</label>
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
          <option value="all">全部状态</option><option value="candidate">疑似打码</option><option value="unknown">待复核</option><option value="clear">未发现</option>
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
    <GameImageSplit listId={listId} listLabel="去码图片列表" listClassName="game-mosaic-list" widthKey="game-mosaic-image-list-width"
      list={<>
        <ul ref={listRef}>{pageImages.map(image => {
          const row = resultFor(rows, image);
          const groupSize = imageGroup.get(row.group || image.id)?.length || 1;
          const status = row.saved ? storage?.index[image.id]?.included ? "已纳入补丁" : "已确认"
            : row.reason ? "待复核" : row.boxes.length ? `疑似打码 · ${row.boxes.length} 区域` : row.scanned ? "未发现" : "未筛选";
          const detail = `${image.width} × ${image.height} · ${status}${groupSize > 1 ? ` · ${groupSize} 张一组` : ""}`;
          return <li key={image.id} className={`unity-image-item${image.id === active?.id ? " is-selected" : ""}`}>
            <input type="checkbox" aria-label={"勾选去码 " + image.name} checked={row.checked} disabled={!!busy} onChange={event => update(image, { checked: event.target.checked, manualChecked: true })} />
            <button type="button" aria-current={image.id === active?.id || undefined} data-tooltip={image.file + "\n" + detail} disabled={!!busy}
              onClick={() => { setActiveId(image.id); setError(""); }}>
              <strong><SearchHighlight text={image.name} query={needle} /></strong>
              <small>{detail}</small>
            </button>
          </li>;
        })}</ul>
        <GameImageListPagination label="去码图片列表分页" page={currentPage} pages={pages} onPage={setPage} />
      </>}>
      {!visible.length && <div className="unity-offline-empty">没有符合筛选条件的图片。</div>}
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
            <button className="unity-btn" disabled={!!busy || !activeSaved || reference?.id === active.id} onClick={() => setRows(previous => {
              const next = { ...previous };
              for (const image of members) next[image.id] = { ...resultFor(previous, image), reference: image.id === active.id, group, manualGroup: true };
              return next;
            })}>设为组参考</button>
            {reference && <span>参考图 {reference.name}</span>}
          </div>
        </div>
        <div className="unity-image-actions">
          <button className="unity-btn" aria-pressed={drawing} disabled={!!busy || !originalUrl}
            onClick={() => setDrawing(value => !value)}>框选蒙版</button>
          <button className="unity-btn" disabled={!!busy || !activeResult.boxes.length} onClick={() => editMask(active, activeResult.boxes.slice(0, -1))}>删除最后一框</button>
          <button className="unity-btn" disabled={!!busy || !activeResult.boxes.length} onClick={() => editMask(active, [])}>清空蒙版</button>
          <button className="unity-btn" disabled={!!busy || !activeResult.boxes.length || members.length < 2} onClick={() => {
            for (const image of members) if (!resultFor(rows, image).boxes.length && Math.abs(image.width / image.height / (active.width / active.height) - 1) <= 0.04)
              editMask(image, mapMosaicBoxes(activeResult.boxes, active, image));
          }}>复制蒙版到组内空白图</button>
        </div>
        {activeResult.reason && <p className="game-mosaic-error">{activeResult.reason}</p>}
        <div className="unity-image-previews">
          <GameImagePreviewFrame caption="原图" fallback={original?.error
            ? <p className="game-mosaic-error" role="alert">{original.error}</p> : <p className="hint">正在读取图片…</p>}>
            {originalUrl && <div className="unity-image-stage game-mosaic-stage" style={{ width: previewWidth }}>
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
                  fill="#f4353540" stroke="#e0393c" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
              </svg>
            </div>}
          </GameImagePreviewFrame>
          <GameImagePreviewFrame caption={<>去码结果
            {resultOptions.length > 1 ? <select aria-label="查看去码结果" value={view} disabled={!!busy}
              onChange={event => setPreferredResult(event.target.value as "saved" | MosaicModel)}>
              {resultOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select> : resultOptions[0] && <small>{resultOptions[0].label}</small>}
          </>} fallback={view === "saved" && confirmed?.error
            ? <p className="game-mosaic-error" role="alert">{confirmed.error}</p>
            : <p className="hint">{view ? "正在读取图片…" : "尚未生成去码结果"}</p>}>
            {resultUrl && <div className="unity-image-stage" style={{ width: previewWidth }}>
              <img src={resultUrl} alt={`${active.name} 去码结果`} draggable={false} />
            </div>}
          </GameImagePreviewFrame>
        </div>
        <div className="unity-image-actions">
          <button className="unity-btn unity-btn-primary" disabled={actionsDisabled || !candidate} onClick={() => candidate && approve(active, candidate)}>确认当前候选</button>
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
