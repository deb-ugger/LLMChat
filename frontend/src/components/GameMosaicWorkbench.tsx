import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "../api";
import { groupMosaicScenes, loadLadaDetector, mapMosaicBoxes, mosaicInputKey, mosaicModelLabels, redrawMosaic, scanMosaic, type MosaicBox, type MosaicModel } from "../gameMosaic";
import type { UnityImage } from "../unityOffline";
import { showAppNotice } from "./AppNotice";
import { useGameActionConfirm } from "./GameActionConfirm";
import "../gameMosaic.css";

type Result = { source: string; boxes: MosaicBox[]; checked: boolean; group?: string; manualGroup?: boolean;
  scanned?: boolean; manualBoxes?: boolean; manualChecked?: boolean; reason?: string; signature?: number[]; saved?: boolean; reference?: boolean };
type Results = Record<string, Result>;
type Candidates = Partial<Record<MosaicModel, Blob>>;
type Props = {
  gamePath: string; images: readonly UnityImage[]; backupMode: string;
  read: (image: UnityImage, signal: AbortSignal) => Promise<Blob>;
  controls: HTMLElement; steps: ReactNode; onBusy?: (busy: boolean) => void;
};

const defaultResult = (image: UnityImage): Result => ({ source: image.sourceHash, boxes: [], checked: false });
function resultFor(rows: Results, image: UnityImage) {
  const row = rows[image.id];
  return row?.source === image.sourceHash ? row : defaultResult(image);
}

function useBlobUrl(blob?: Blob) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!blob) { setUrl(""); return; }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
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

export function GameMosaicWorkbench({ gamePath, images, backupMode, read, controls, steps: workflowSteps, onBusy }: Props) {
  const task = useRef<AbortController | null>(null);
  const savedKey = "llmchat-game-mosaic:" + gamePath;
  const [rows, setRows] = useState<Results>(() => {
    try { return JSON.parse(localStorage.getItem(savedKey) || "{}") || {}; } catch { return {}; }
  });
  const [query, setQuery] = useState("");
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
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState<{ id: string; revision: string; blob: Blob }>();
  const [approved, setApproved] = useState<{ id: string; revision: string; blob: Blob }>();
  const [candidates, setCandidates] = useState<Record<string, { revision: string; values: Candidates; seconds: Partial<Record<MosaicModel, number>> }>>({});
  const [view, setView] = useState<"original" | "saved" | MosaicModel>("original");
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
  const matches = scoped.filter(image => !needle || (image.name + " " + image.file).toLowerCase().includes(needle));
  const active = usable.find(image => image.id === activeId) ?? matches[0];
  const activeResult = active && resultFor(rows, active);
  const group = active && (activeResult?.group || active.id);
  const imageGroup = useMemo(() => {
    const grouped = new Map<string, UnityImage[]>();
    for (const image of usable) {
      const key = resultFor(rows, image).group || image.id;
      const listed = grouped.get(key);
      if (listed) listed.push(image); else grouped.set(key, [image]);
    }
    return grouped;
  }, [rows, usable]);
  const members = group ? imageGroup.get(group) || [] : [];
  const reference = members.find(image => resultFor(rows, image).reference && resultFor(rows, image).saved);
  const currentScope = sceneFilter && group ? members : matches;
  const visible = currentScope.filter(image => {
    const row = resultFor(rows, image);
    return statusFilter === "all" || (statusFilter === "candidate" ? row.boxes.length > 0 : statusFilter === "unknown" ? !row.scanned || !!row.reason : row.scanned && !row.reason && !row.boxes.length);
  });
  const selected = members.filter(image => resultFor(rows, image).checked);
  const saved = selected.filter(image => resultFor(rows, image).saved);
  const result = active && candidates[active.id]?.revision === active.sourceHash ? candidates[active.id] : undefined;
  const values = result?.values;
  const displayed = view === "original" ? source?.id === active?.id && source?.revision === active?.sourceHash ? source?.blob : undefined
    : view === "saved" ? approved?.id === active?.id && approved?.revision === active?.sourceHash ? approved?.blob : undefined : values?.[view];
  const display = useBlobUrl(displayed);
  const activeSaved = !!activeResult?.saved;

  useEffect(() => () => { task.current?.abort(); onBusy?.(false); }, [onBusy]);
  useEffect(() => {
    try { localStorage.setItem(savedKey, JSON.stringify(rows)); }
    catch { showAppNotice("无法保存图片去码筛选记录", "error"); }
  }, [savedKey, rows]);

  const candidatePath = (image: UnityImage) => API_BASE + "/api/game-images/mosaic?" +
    new URLSearchParams({ gamePath, id: image.id, sourceHash: image.sourceHash });
  const readSaved = async (image: UnityImage, signal: AbortSignal) =>
    (await mosaicResponse(await fetch(candidatePath(image), { signal, cache: "no-store" }))).blob();

  useEffect(() => {
    const image = active;
    if (!image) return;
    const controller = new AbortController();
    setView("original"); setDrawing(false); setDraft(undefined); anchor.current = null;
    void read(image, controller.signal).then(blob => {
      if (!controller.signal.aborted) setSource({ id: image.id, revision: image.sourceHash, blob });
    }).catch(cause => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, [active, read]);

  useEffect(() => {
    if (view !== "saved" || !active || !activeSaved) return;
    const controller = new AbortController();
    void readSaved(active, controller.signal).then(blob => {
      if (!controller.signal.aborted) setApproved({ id: active.id, revision: active.sourceHash, blob });
    }).catch(cause => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, [active, activeSaved, view]);

  function update(image: UnityImage, edit: Partial<Result>) {
    setRows(previous => ({ ...previous, [image.id]: { ...resultFor(previous, image), ...edit } }));
  }

  async function run(label: string, work: (signal: AbortSignal) => Promise<void>) {
    if (task.current) return;
    const controller = new AbortController();
    task.current = controller;
    onBusy?.(true);
    setBusy(label); setProgress(label); setError("");
    try {
      await work(controller.signal);
      if (controller.signal.aborted) setProgress("已停止后续任务");
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      else setProgress("已停止后续任务");
    } finally {
      task.current = null; setBusy("");
      onBusy?.(false);
    }
  }

  function screen() {
    const targets = currentScope;
    void run("筛选打码区域", async signal => {
      if (detectorKind === "lada" && !detectorFile) throw new Error("请选择 Lada v4 的 ONNX 文件");
      const detector = detectorKind === "lada" && detectorFile ? await loadLadaDetector(detectorFile) : undefined;
      const screened: Results = {};
      let failures = 0;
      let completed = 0;
      try {
        for (const image of targets) {
          signal.throwIfAborted();
          const old = resultFor(rows, image);
          const detail = completed + 1 + " / " + targets.length + " · " + image.name;
          setProgress(detail);
          try {
            const input = await read(image, signal);
            const { boxes, signature } = await (detector ? detector.scan(input) : scanMosaic(input));
            screened[image.id] = { ...old, boxes: old.manualBoxes || old.saved ? old.boxes : boxes,
              checked: old.manualChecked || old.manualBoxes || old.saved ? old.checked : boxes.length > 0,
              signature, scanned: true, reason: undefined };
          } catch (cause) {
            if (signal.aborted) throw cause;
            failures++;
            screened[image.id] = { ...old, reason: cause instanceof Error ? cause.message : String(cause) };
          }
          completed++;
        }
      } finally {
        await detector?.release();
        setRows(previous => {
          const next = { ...previous, ...screened };
          const proposals = groupMosaicScenes(usable.flatMap(image => {
            const row = resultFor(next, image);
            return row.signature && !row.manualGroup && !row.saved && !row.reference ? [{ ...image, signature: row.signature }] : [];
          }));
          for (const list of proposals) for (const image of list) next[image.id] = { ...next[image.id], group: "scene-" + list[0].id };
          return next;
        });
      }
      setProgress("筛选完成 · " + completed + " 张" + (failures ? " · " + failures + " 张读取失败" : ""));
    });
  }

  function editMask(image: UnityImage, boxes: MosaicBox[]) {
    update(image, { boxes, manualBoxes: true, saved: false, reference: false, checked: boxes.length > 0 });
    setCandidates(previous => {
      const next = { ...previous };
      delete next[image.id];
      return next;
    });
    setView("original");
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
    void run("生成去码候选", async signal => {
      const usableTargets = targets.filter(image => resultFor(rows, image).boxes.length);
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
            const title = (index + 1) + " / " + usableTargets.length + " · " + image.name + " · " + mosaicModelLabels[engine];
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
            if (image.id === active?.id) setView(engine);
          }
        } catch (cause) {
          if (signal.aborted) throw cause;
          failures.push(image.name + " · " + String(cause));
        }
      }
      setProgress("候选生成完成 · " + usableTargets.length + " 张");
      if (failures.length) setError(failures.join("\n"));
    });
  }

  function approve(image: UnityImage, blob: Blob) {
    void run("保存已确认候选", async signal => {
      await mosaicResponse(await fetch(candidatePath(image), { method: "POST", headers: { "Content-Type": "image/png" }, body: blob, signal }));
      update(image, { saved: true, checked: true });
      setApproved({ id: image.id, revision: image.sourceHash, blob }); setView("saved");
      setProgress("已保存 · " + image.name);
    });
  }

  async function patch(undo: boolean) {
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

  const tabs = [
    { id: "original" as const, label: "原图", enabled: true },
    { id: "saved" as const, label: "已确认", enabled: activeSaved },
    ...(["turbo", "2511"] as const).map(id => ({ id, label: (id === "turbo" ? "Turbo" : "2511") +
      (result?.seconds[id] != null ? " · " + result.seconds[id]!.toFixed(1) + " 秒" : ""), enabled: !!values?.[id] })),
  ];
  const activeBoxes = [...(activeResult?.boxes || []), ...(draft ? [draft] : [])];
  const candidate = view === "turbo" || view === "2511" ? values?.[view] : undefined;

  return <section className="game-mosaic-workbench" aria-label="图片去码">
    {confirmation.dialog}
    {createPortal(<div className="engine-workflow-content">
      {workflowSteps}
      <div className="game-mosaic-controls">
        <div className="game-mosaic-toolbar">
          <select aria-label="筛选范围" value={scope} disabled={!!busy} onChange={event => setScope(event.target.value as typeof scope)}>
            <option value="scenes">场景图片</option><option value="all">全部图片</option>
          </select>
          <select aria-label="打码筛选方式" value={detectorKind} disabled={!!busy} onChange={event => setDetectorKind(event.target.value as typeof detectorKind)}>
            <option value="grid">方格规则</option><option value="lada">Lada 专用检测 · 本地 ONNX</option>
          </select>
          {detectorKind === "lada" && <label>检测权重 <input type="file" accept=".onnx" disabled={!!busy} onChange={event => setDetectorFile(event.target.files?.[0])} /></label>}
          <button className="unity-btn unity-btn-primary" disabled={!!busy || !currentScope.length || detectorKind === "lada" && !detectorFile} onClick={screen}>筛选打码 · {currentScope.length} 张</button>
          {busy && <button className="unity-btn" onClick={() => { task.current?.abort(); setProgress("等待当前任务返回后停止后续任务"); }}>停止后续任务</button>}
        </div>
        <div className="game-mosaic-toolbar">
          <select aria-label="去码模型" value={model} disabled={!!busy} onChange={event => { const next = event.target.value as MosaicModel; setModel(next); setSteps(next === "turbo" ? 8 : 20); }}>
            <option value="turbo">{mosaicModelLabels.turbo}</option><option value="2511">{mosaicModelLabels["2511"]}</option>
          </select>
          {model === "2511" && <label>步数 <input type="number" min={1} max={100} value={steps} disabled={!!busy} onChange={event => setSteps(Math.max(1, Math.min(100, Number(event.target.value) || 1)))} /></label>}
          <label><input type="checkbox" checked={protect} disabled={!!busy} onChange={event => setProtect(event.target.checked)} />保护已识别文字</label>
        </div>
        {progress && <p className="game-mosaic-progress" role="status">{progress}</p>}
        {error && <p className="game-mosaic-error" role="alert">{error}</p>}
      </div>
    </div>, controls)}
    <div className="game-mosaic-body-grid">
      <aside className="game-mosaic-list">
        <div className="game-mosaic-toolbar">
          <input type="search" aria-label="筛选文件名" placeholder="筛选文件名" value={query} disabled={!!busy} onChange={event => { setQuery(event.target.value); setActiveId(""); setSceneFilter(false); }} />
          <select aria-label="筛选状态" value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="all">全部状态</option><option value="candidate">疑似打码</option><option value="unknown">待复核</option><option value="clear">未发现</option>
          </select>
          <label><input type="checkbox" checked={sceneFilter} disabled={!group} onChange={event => setSceneFilter(event.target.checked)} />仅本组</label>
        </div>
        <ul>{visible.slice(0, 350).map(image => {
          const row = resultFor(rows, image);
          const groupSize = imageGroup.get(row.group || image.id)?.length || 1;
          return <li key={image.id} className={image.id === active?.id ? "is-current" : undefined}>
            <input type="checkbox" aria-label={"勾选去码 " + image.name} checked={row.checked} disabled={!!busy} onChange={event => update(image, { checked: event.target.checked, manualChecked: true })} />
            <button type="button" disabled={!!busy} onClick={() => { setActiveId(image.id); setError(""); }}>
              <strong title={image.file}>{image.name}</strong>
              <small>{row.saved ? "已确认" : row.reason ? "待复核" : row.boxes.length ? "疑似打码 · " + row.boxes.length + " 区域" : row.scanned ? "未发现" : "未筛选"} · {groupSize} 张一组</small>
            </button>
          </li>;
        })}</ul>
        {visible.length > 350 && <p>显示前 350 张，请用文件名或状态缩小范围。</p>}
      </aside>
      {active && activeResult && <section className="game-mosaic-preview" aria-label="去码预览">
        <div className="game-mosaic-toolbar">
          <strong title={active.file}>{active.name}</strong>
          <span>{members.length} 张 · 本组已选 {selected.length} 张</span>
          <select aria-label="移动当前图片到场景组" disabled={!!busy} value="" onChange={event => {
            const next = event.target.value;
            if (next) update(active, { group: next === "new" ? crypto.randomUUID() : next, manualGroup: true, reference: false });
          }}>
            <option value="">移动当前图</option><option value="new">新建独立组</option>
            {[...imageGroup].filter(([key]) => key !== group).slice(0, 350).map(([key, list]) => <option key={key} value={key}>{list[0].name} · {list.length} 张</option>)}
          </select>
          <button className="unity-btn" disabled={!!busy || !activeSaved || reference?.id === active.id} onClick={() => setRows(previous => {
            const next = { ...previous };
            for (const image of members) next[image.id] = { ...resultFor(previous, image), reference: image.id === active.id, group, manualGroup: true };
            return next;
          })}>设为组参考</button>
          {reference && <span>参考图 {reference.name}</span>}
        </div>
        <div className="game-mosaic-toolbar">
          {tabs.filter(tab => tab.enabled).map(tab => <button key={tab.id} className={"unity-btn" + (view === tab.id ? " unity-btn-primary" : "")}
            aria-pressed={view === tab.id} disabled={!!busy} onClick={() => { setDrawing(false); setView(tab.id); }}>{tab.label}</button>)}
          <button className="unity-btn" aria-pressed={drawing} disabled={!!busy || !source} onClick={() => { setView("original"); setDrawing(value => !value); }}>框选蒙版</button>
          <button className="unity-btn" disabled={!!busy || !activeResult.boxes.length} onClick={() => editMask(active, activeResult.boxes.slice(0, -1))}>删除最后一框</button>
          <button className="unity-btn" disabled={!!busy || !activeResult.boxes.length} onClick={() => editMask(active, [])}>清空蒙版</button>
          <button className="unity-btn" disabled={!!busy || !activeResult.boxes.length || members.length < 2} onClick={() => {
            for (const image of members) if (!resultFor(rows, image).boxes.length && Math.abs(image.width / image.height / (active.width / active.height) - 1) <= 0.04)
              editMask(image, mapMosaicBoxes(activeResult.boxes, active, image));
          }}>复制蒙版到组内空白图</button>
        </div>
        {activeResult.reason && <p className="game-mosaic-error">{activeResult.reason}</p>}
        {display && <div className="game-mosaic-stage" style={{ aspectRatio: active.width + " / " + active.height, maxWidth: active.width }}>
          <img src={display} alt={active.name} draggable={false} />
          {view === "original" && <svg viewBox={`0 0 ${active.width} ${active.height}`} className={drawing ? "is-drawing" : undefined}
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
          </svg>}
        </div>}
        <div className="game-mosaic-toolbar">
          <button className="unity-btn" disabled={!!busy || !activeResult.boxes.length} onClick={() => generate([active], [model])}>重绘当前图</button>
          <button className="unity-btn" disabled={!!busy || !activeResult.boxes.length} onClick={() => generate([active], ["turbo", "2511"])}>对比两种模型</button>
          <button className="unity-btn" disabled={!!busy || !reference || !selected.some(image => image.id !== reference.id && resultFor(rows, image).boxes.length)}
            onClick={() => generate(selected.filter(image => image.id !== reference?.id), [model])}>重绘本组所选</button>
          <button className="unity-btn unity-btn-primary" disabled={!!busy || !candidate} onClick={() => candidate && approve(active, candidate)}>确认当前候选</button>
        </div>
        <div className="game-mosaic-toolbar">
          <button className="unity-btn" disabled={!!busy || !saved.length} onClick={() => void patch(false)}>应用已确认 · {saved.length} 张</button>
          <button className="unity-btn" disabled={!!busy || !selected.length} onClick={() => void patch(true)}>撤销本组所选</button>
        </div>
      </section>}
    </div>
  </section>;
}
