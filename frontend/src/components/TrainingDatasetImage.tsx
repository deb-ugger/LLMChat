import { Image as NativeImage } from "@tauri-apps/api/image";
import { isTauri } from "@tauri-apps/api/core";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { AnnotatedImage, AnnotatedSampleSet } from "../benchmark/imageSampleSet";
import { datasetParts, type DatasetPart } from "../benchmark/trainingDatasets";
import type { MosaicBox } from "../gameMosaic";
import { getFixedMenuPoint } from "../viewportLayout";
import { showAppNotice } from "./AppNotice";
import { MaskResizeControls } from "./game-mosaic/MosaicPreview";
import "../gameMosaic.css";

export type DatasetMask = { box: MosaicBox; part: DatasetPart | "" };

export function useSamplePicture(image: AnnotatedImage, read: AnnotatedSampleSet["read"]) {
  const [picture, setPicture] = useState<{ blob?: Blob; url: string; failed: boolean }>({ url: "", failed: false });
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    setPicture({ url: "", failed: false });
    void read(image, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setPicture({ blob, url, failed: false });
    }).catch(() => { if (!controller.signal.aborted) setPicture({ url: "", failed: true }); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [image.id, image.sourceHash, read]);
  return picture;
}

export function SamplePicture({ image, read }: { image: AnnotatedImage; read: AnnotatedSampleSet["read"] }) {
  const picture = useSamplePicture(image, read);
  return picture.url ? <img src={picture.url} alt="" draggable={false} />
    : <span className="training-dataset-picture-state">{picture.failed ? "图片读取失败" : "读取中…"}</span>;
}

export async function copyDatasetPicture(image: AnnotatedImage, read: AnnotatedSampleSet["read"]) {
  const blob = await read(image, new AbortController().signal);
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法读取图片像素");
    context.drawImage(bitmap, 0, 0);
    if (isTauri()) {
      const native = await NativeImage.new(new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer), bitmap.width, bitmap.height);
      try { await writeImage(native); } finally { await native.close(); }
    } else {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": await canvas.convertToBlob({ type: "image/png" }) })]);
    }
    showAppNotice("已复制图片", "success");
  } finally { bitmap.close(); }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const rectangle = (a: number[], b: number[]): MosaicBox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
const minimapMax = 120;

type CanvasLayout = { L: number; T: number; W: number; H: number };

function clampCanvasScroll(view: HTMLDivElement, layout: CanvasLayout) {
  const { L, T, W, H } = layout;
  const vw = view.clientWidth, vh = view.clientHeight;
  const axis = (value: number, start: number, size: number, port: number, limit: number) => {
    const maxScroll = Math.max(0, limit - port);
    if (size <= port) return clamp(value, 0, maxScroll);
    const min = start + 0.5 * size - port;
    const max = start + 0.5 * size;
    const next = min > max ? (min + max) / 2 : clamp(value, min, max);
    return clamp(next, 0, maxScroll);
  };
  const s = axis(view.scrollLeft, L, W, vw, view.scrollWidth);
  const t = axis(view.scrollTop, T, H, vh, view.scrollHeight);
  if (s !== view.scrollLeft) view.scrollLeft = s;
  if (t !== view.scrollTop) view.scrollTop = t;
  return { left: s, top: t };
}

export function TrainingDatasetImage({ image, read, masks, editable, busy, onChange, onUndo, canUndo, onRedo, canRedo, onContextMenu, readOnlyHint }: {
  image: AnnotatedImage; read: AnnotatedSampleSet["read"]; masks: DatasetMask[]; editable: boolean; busy: boolean;
  onChange: (masks: DatasetMask[]) => Promise<void>; onUndo: () => void; canUndo: boolean;
  onRedo: () => void; canRedo: boolean;
  onPreview: () => void; onContextMenu: (event: MouseEvent<HTMLDivElement>) => void; readOnlyHint?: string;
}) {
  const picture = useSamplePicture(image, read);
  const viewport = useRef<HTMLDivElement>(null), bitmap = useRef<HTMLDivElement>(null), table = useRef<HTMLDivElement>(null);
  const partsMenu = useRef<HTMLDivElement>(null), contextMenu = useRef<HTMLDivElement>(null);
  const [drafts, setDrafts] = useState(() => masks.map(mask => ({ ...mask, box: [...mask.box] as MosaicBox })));
  const current = useRef(drafts), pending = useRef(0), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState(-1), selectedRef = useRef(-1), pointerHit = useRef(-1);
  const [fit, setFit] = useState(1), [manualZoom, setManualZoom] = useState<number>();
  const zoom = manualZoom ?? fit;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const displaySize = useMemo(() => ({
    width: image.width * zoom,
    height: image.height * zoom,
  }), [image.width, image.height, zoom]);
  const canvasPadding = useMemo(() => {
    const vw = viewportSize.width || 1;
    const vh = viewportSize.height || 1;
    const { width: iw, height: ih } = displaySize;
    const slack = 56;
    const padX = iw <= vw ? Math.max(12, (vw - iw) / 2) : Math.max(slack, Math.min(vw * 0.45, iw * 0.35));
    const padY = ih <= vh ? Math.max(12, (vh - ih) / 2) : Math.max(slack, Math.min(vh * 0.45, ih * 0.35));
    return { padX, padY };
  }, [viewportSize, displaySize]);
  const [panScroll, setPanScroll] = useState({ left: 0, top: 0 });
  const [canvasLayout, setCanvasLayout] = useState<CanvasLayout>();
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | undefined>(undefined);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const [tool, setTool] = useState<"add" | "select">("select");
  const [panning, setPanning] = useState(false);
  const drawing = tool === "add";
  const signature = JSON.stringify(masks);
  const drag = useRef<{ mode: "draw" | "move" | "resize"; index: number; handle: number; start: [number,number]; before: DatasetMask[]; box?: MosaicBox } | undefined>(undefined);
  const handles = [[0,0],[.5,0],[1,0],[1,.5],[1,1],[.5,1],[0,1],[0,.5]];
  const copy = (values: DatasetMask[]) => values.map(mask => ({ ...mask, box: [...mask.box] as MosaicBox }));
  function display(values: DatasetMask[]) { current.current = values; setDrafts(values); }
  useLayoutEffect(() => {
    if (!pending.current && !drag.current && (!error || signature === JSON.stringify(current.current))) {
      display(copy(masks));
      setError("");
      if (selectedRef.current >= masks.length) { selectedRef.current = masks.length - 1; setSelected(masks.length - 1); }
    }
  }, [signature]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      setViewportSize({ width: element.clientWidth, height: element.clientHeight });
      setFit(Math.max(.01, Math.min(4, (element.clientWidth - 58) / image.width, (element.clientHeight - 12) / image.height)));
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [image.width, image.height]);
  function measureCanvasLayout(): CanvasLayout | undefined {
    const imageEl = bitmap.current;
    if (!imageEl) return;
    return { L: imageEl.offsetLeft, T: imageEl.offsetTop, W: imageEl.offsetWidth, H: imageEl.offsetHeight };
  }
  function syncCanvasScroll() {
    const view = viewport.current;
    if (!view) return;
    const layout = measureCanvasLayout();
    if (!layout) return;
    setPanScroll(clampCanvasScroll(view, layout));
    setCanvasLayout(layout);
  }
  function panToImagePoint(nx: number, ny: number) {
    const view = viewport.current, layout = measureCanvasLayout();
    if (!view || !layout) return;
    const { L, T, W, H } = layout;
    view.scrollLeft = L + nx * W - view.clientWidth / 2;
    view.scrollTop = T + ny * H - view.clientHeight / 2;
    syncCanvasScroll();
  }
  const minimap = useMemo(() => {
    if (!canvasLayout || !picture.url) return undefined;
    const { L, T, W, H } = canvasLayout;
    const vw = viewportSize.width, vh = viewportSize.height;
    if (!vw || !vh || !W || !H) return undefined;
    const scale = minimapMax / Math.max(W, H);
    const mapW = W * scale, mapH = H * scale;
    const { left: s, top: t } = panScroll;
    const iL = Math.max(L, s), iT = Math.max(T, t);
    const iR = Math.min(L + W, s + vw), iB = Math.min(T + H, t + vh);
    const iW = Math.max(0, iR - iL), iH = Math.max(0, iB - iT);
    return {
      mapW, mapH, url: picture.url,
      view: { left: (iL - L) / W * mapW, top: (iT - T) / H * mapH, width: iW / W * mapW, height: iH / H * mapH },
    };
  }, [canvasLayout, panScroll, viewportSize, picture.url]);
  function changeZoom(value: number, clientX?: number, clientY?: number) {
    const view = viewport.current, imageElement = bitmap.current;
    if (!view || !imageElement || drag.current || pan.current) return;
    const next = clamp(value, .25, 4);
    if (next === zoomRef.current) return;
    const v = view.getBoundingClientRect(), r = imageElement.getBoundingClientRect();
    const x = clientX ?? v.left + view.clientLeft + view.clientWidth / 2;
    const y = clientY ?? v.top + view.clientTop + view.clientHeight / 2;
    // Wheel events can arrive before React paints the previous zoom; read the displayed image geometry.
    anchor.current = { x: (x - r.left) / r.width * image.width, y: (y - r.top) / r.height * image.height, clientX: x, clientY: y };
    zoomRef.current = next;
    setManualZoom(next);
  }
  useLayoutEffect(() => {
    const view = viewport.current, imageElement = bitmap.current;
    if (!view || !imageElement) return;
    const point = anchor.current;
    if (point) {
      const r = imageElement.getBoundingClientRect();
      view.scrollLeft += r.left + point.x * zoom - point.clientX;
      view.scrollTop += r.top + point.y * zoom - point.clientY;
      anchor.current = undefined;
    } else {
      view.scrollLeft = (view.scrollWidth - view.clientWidth) / 2;
      view.scrollTop = (view.scrollHeight - view.clientHeight) / 2;
    }
    syncCanvasScroll();
  }, [zoom, viewportSize, canvasPadding, picture.url]);
  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.clientHeight : 1);
      changeZoom(zoomRef.current * Math.exp(-clamp(pixels, -100, 100) * Math.log(1.1) / 100), event.clientX, event.clientY);
    };
    view.addEventListener("wheel", wheel, { passive: false });
    return () => view.removeEventListener("wheel", wheel);
  }, []);
  function persist(values: DatasetMask[]) {
    const next = copy(values); display(next); pending.current++; setSaving(true);
    void onChange(next).then(() => setError("")).catch(cause => {
      setError(String(cause)); showAppNotice("标注写入失败：" + String(cause), "error");
    }).finally(() => { pending.current--; if (!pending.current) setSaving(false); });
  }
  function selectMask(index: number, reveal = false) {
    selectedRef.current = index; setSelected(index);
    requestAnimationFrame(() => {
      const row = table.current?.querySelector<HTMLElement>('[data-mask-row="' + index + '"]');
      if (row && table.current) {
        const r = row.getBoundingClientRect(), v = table.current.getBoundingClientRect();
        const top = v.top + (table.current.querySelector("thead")?.getBoundingClientRect().height ?? 0);
        if (r.top < top) table.current.scrollTop += r.top - top;
        else if (r.bottom > v.bottom) table.current.scrollTop += r.bottom - v.bottom;
      }
      const mask = current.current[index], view = viewport.current, picture = bitmap.current;
      if (!reveal || !mask || !view || !picture) return;
      const left = picture.offsetLeft + mask.box[0] * zoom, top = picture.offsetTop + mask.box[1] * zoom;
      const right = picture.offsetLeft + mask.box[2] * zoom, bottom = picture.offsetTop + mask.box[3] * zoom;
      if (left < view.scrollLeft) view.scrollLeft = Math.max(0,left-12);
      else if (right > view.scrollLeft+view.clientWidth) view.scrollLeft = right-view.clientWidth+12;
      if (top < view.scrollTop) view.scrollTop = Math.max(0,top-12);
      else if (bottom > view.scrollTop+view.clientHeight) view.scrollTop = bottom-view.clientHeight+12;
      syncCanvasScroll();
    });
  }
  function menuPosition(menu: HTMLDivElement | null, x: number, y: number, height: number) {
    if (!menu) return;
    const p = getFixedMenuPoint(x,y,170,height);
    menu.style.left = p.x+"px"; menu.style.top = p.y+"px"; menu.showPopover();
    menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll:true });
  }
  function choosePart(index: number, x: number, y: number) {
    if (!editable || busy) return;
    selectMask(index); contextMenu.current?.hidePopover(); requestAnimationFrame(() => menuPosition(partsMenu.current,x,y,160));
  }
  function updatePart(index: number, part: DatasetPart | "") {
    if (!editable || busy || !current.current[index]) return;
    selectMask(index); persist(current.current.map((mask,i) => i === index ? { ...mask,part } : mask));
    partsMenu.current?.hidePopover(); viewport.current?.focus({ preventScroll:true });
  }
  function remove(index: number) {
    if (!editable || busy || !current.current[index]) return;
    persist(current.current.filter((_,i) => i !== index));
    selectMask(Math.min(index,current.current.length-1)); contextMenu.current?.hidePopover();
    viewport.current?.focus({ preventScroll:true });
  }
  function changeTool(next: "add" | "select") {
    cancelGesture(); selectMask(-1); setTool(next);
    viewport.current?.focus({ preventScroll: true });
  }
  function clearMasks() {
    if (!editable || busy || !current.current.length) return;
    if (tool !== "add" && selectedRef.current >= 0) remove(selectedRef.current);
    else { persist([]); selectMask(-1); }
  }
  function cancelGesture() {
    if (drag.current) { display(drag.current.before); drag.current = undefined; selectMask(Math.min(selectedRef.current, current.current.length - 1)); }
    const wasPanning = !!pan.current;
    pan.current = undefined; setPanning(false);
    if (wasPanning) syncCanvasScroll();
  }
  function point(event: PointerEvent): [number,number] {
    const r = bitmap.current!.getBoundingClientRect();
    return [clamp(Math.round((event.clientX-r.left)/r.width*image.width),0,image.width),
      clamp(Math.round((event.clientY-r.top)/r.height*image.height),0,image.height)];
  }
  function move(event: PointerEvent) {
    if (pan.current && viewport.current) {
      viewport.current.scrollLeft = pan.current.left - (event.clientX - pan.current.x);
      viewport.current.scrollTop = pan.current.top - (event.clientY - pan.current.y);
      return;
    }
    const gesture = drag.current;
    if (!gesture) return;
    const p = point(event), values = copy(current.current);
    let box: MosaicBox;
    if (gesture.mode === "draw") box = rectangle(gesture.start,p);
    else {
      const original = gesture.box!, dx = p[0]-gesture.start[0], dy = p[1]-gesture.start[1];
      box = [...original];
      if (gesture.mode === "move") {
        const x = clamp(dx,-original[0],image.width-original[2]), y = clamp(dy,-original[1],image.height-original[3]);
        box = [original[0]+x,original[1]+y,original[2]+x,original[3]+y];
      } else {
        const [horizontal,vertical] = handles[gesture.handle];
        if (horizontal === 0) box[0] = clamp(original[0]+dx,0,original[2]-1);
        if (horizontal === 1) box[2] = clamp(original[2]+dx,original[0]+1,image.width);
        if (vertical === 0) box[1] = clamp(original[1]+dy,0,original[3]-1);
        if (vertical === 1) box[3] = clamp(original[3]+dy,original[1]+1,image.height);
      }
    }
    values[gesture.index] = { ...values[gesture.index],box }; display(values);
  }
  function finish(event: PointerEvent) {
    if (pan.current) { pan.current = undefined; setPanning(false); syncCanvasScroll(); return; }
    const gesture = drag.current;
    if (!gesture) return;
    move(event); drag.current = undefined;
    const mask = current.current[gesture.index];
    if (!mask || mask.box[2] <= mask.box[0] || mask.box[3] <= mask.box[1]) { display(gesture.before); return; }
    if (JSON.stringify(current.current) !== JSON.stringify(gesture.before)) persist(current.current);
    if (gesture.mode === "draw") { setTool("select"); choosePart(gesture.index,event.clientX,event.clientY); }
  }
  const known = drafts.filter(mask => !!mask.part).length;
  const hasSelection = tool !== "add" && selected >= 0 && selected < drafts.length;
  const canSelectMask = editable && !busy && tool !== "add";
  const imageTools = [
    { id: "redraw", label: "重绘当前图 · 标注页不支持", key: "r", shortcut: "R", disabled: true, reason: "标注页不支持重绘",
      icon: "m7 4 13 8-13 8V4Z", run: () => {} },
    { id: "draw", label: "添加蒙版", key: "b", shortcut: "B", disabled: !editable || busy || !picture.url, pressed: tool === "add",
      icon: "M9 4H4v5m11-5h5v5m0 6v5h-5m-6 0H4v-5m5-3h6m-3-3v6", run: () => changeTool("add") },
    { id: "select", label: "框选蒙版", key: "v", shortcut: "V", disabled: !editable || busy || !picture.url, pressed: tool === "select",
      icon: "M9 4H4v5m11-5h5v5m0 6v5h-5m-6 0H4v-5M12 4h.01M4 12h.01M20 12h.01M12 20h.01", run: () => changeTool("select") },
    { id: "remove", label: "删除最后一框", key: "d", shortcut: "D", disabled: !editable || busy || !drafts.length,
      icon: "M5 5h14v14H5zM9 12h6", run: () => remove(current.current.length - 1) },
    { id: "clear", label: hasSelection ? "清空选中蒙版" : "清空蒙版", key: "delete", modifier: hasSelection ? undefined : "shift",
      shortcut: hasSelection ? "Delete" : "Shift+Delete", disabled: !editable || busy || !drafts.length,
      icon: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6", run: clearMasks },
    { id: "copy", label: "复制蒙版到组内空白图 · 标注页不支持", key: "c", shortcut: "C", disabled: true, reason: "标注页不支持复制到组内空白图",
      icon: "M8 8h12v12H8zM16 4H4v12", run: () => {} },
    { id: "undo", label: "撤销蒙版编辑", key: "z", modifier: "command", shortcut: "Ctrl+Z",
      disabled: !canUndo || busy, icon: "m8 5-4 4 4 4M4 9h10a5 5 0 0 1 0 10h-3", run: onUndo },
  ];
  return <section className="training-dataset-editor" style={{ flex: "1 1 0" }} aria-label="图片标注" onKeyDown={event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey ||
      partsMenu.current?.matches(":popover-open") || contextMenu.current?.matches(":popover-open") ||
      (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]"))) return;
    const key = event.key.toLowerCase(), command = event.ctrlKey || event.metaKey;
    if (key === "escape") { event.preventDefault(); event.stopPropagation(); cancelGesture(); return; }
    if (command && (key === "z" || key === "y")) {
      event.preventDefault(); event.stopPropagation();
      if (drag.current || pan.current) { cancelGesture(); return; }
      const redo = key === "y" || event.shiftKey;
      if (!busy && (redo ? canRedo : canUndo)) (redo ? onRedo : onUndo)(); return;
    }
    if (command) return;
    if (hasSelection && editable && !busy && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 10 : 1, index = selectedRef.current, box = current.current[index].box;
      const dx = clamp(event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, -box[0], image.width - box[2]);
      const dy = clamp(event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0, -box[1], image.height - box[3]);
      if (dx || dy) persist(current.current.map((mask, i) => i === index ? { ...mask, box: [box[0]+dx, box[1]+dy, box[2]+dx, box[3]+dy] } : mask));
      return;
    }
    if (event.repeat) return;
    const modifier = command ? "command" : event.shiftKey ? "shift" : undefined;
    const action = imageTools.find(item => item.key === key && (item.modifier === modifier ||
      (item.id === "clear" && hasSelection && modifier === "shift")));
    if (!action || action.disabled) return;
    event.preventDefault(); event.stopPropagation(); action.run();
  }}>
    <header className="training-dataset-editor-tools">
      <div className="training-dataset-editor-identity">
        <strong title={image.sourceDirectory || image.file}>{image.name}</strong>
        <span className="training-dataset-meta-chip">{image.width} × {image.height}</span>
        <span className="training-dataset-meta-chip" data-marked={known === drafts.length && drafts.length > 0}>
          已标 {known} / {drafts.length}
        </span>
        <button type="button" className="training-dataset-meta-chip training-dataset-zoom-chip" data-tooltip="滚轮缩放；双击恢复 100%"
          onDoubleClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button>
      </div>
      <p className="training-dataset-editor-status" role="status">{error ? <>写入失败：{error}</> : saving ? "正在写入…" : null}</p>
    </header>
    <div className="training-dataset-editor-main">
    <div className="training-dataset-canvas-frame game-mosaic-original-viewport">
    <div ref={viewport} tabIndex={0} className={`training-dataset-canvas game-mosaic-image-area${!drawing ? " is-pan-ready" : ""}${panning ? " is-panning" : ""}`} data-drawing={drawing && editable} aria-label="图片画布" onScroll={() => { if (!pan.current) syncCanvasScroll(); }} onContextMenu={onContextMenu}
      onDoubleClick={event => { if (pointerHit.current >= 0) { event.stopPropagation(); choosePart(pointerHit.current,event.clientX,event.clientY); } }}
      onPointerDown={event => {
        pointerHit.current = -1;
        if (busy) return;
        if (event.button !== 0 && event.button !== 1) return;
        const target = event.target as Element;
        const middlePan = event.button === 1;
        const edge = target.getAttribute("data-mosaic-resize");
        const hit = edge && selectedRef.current >= 0 ? String(selectedRef.current) : target.closest("[data-mosaic-box]")?.getAttribute("data-mosaic-box") ?? undefined;
        pointerHit.current = hit === undefined ? -1 : Number(hit);
        const index = drawing ? undefined : hit;
        const wasSelected = index !== undefined && selectedRef.current === Number(index);
        if (index !== undefined && !middlePan) selectMask(Number(index));
        const inside = bitmap.current?.contains(event.target as Node);
        if (!drawing && (middlePan || index === undefined)) {
          event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
          if (!middlePan) selectMask(-1);
          setPanning(true);
          pan.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; return;
        }
        if (!editable || !inside) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll:true }); event.currentTarget.setPointerCapture(event.pointerId);
        partsMenu.current?.hidePopover(); contextMenu.current?.hidePopover();
        const p = point(event), before = copy(current.current);
        if (index !== undefined) {
          if (!edge && !wasSelected) return;
          const handle = edge ? ["nw", "n", "ne", "e", "se", "s", "sw", "w"].indexOf(edge) : -1;
          drag.current = { mode:edge ? "resize" : "move",index:Number(index),handle,start:p,before,box:[...current.current[Number(index)].box] };
        } else {
          const i = current.current.length; display([...current.current,{box:[p[0],p[1],p[0],p[1]],part:""}]); selectMask(i);
          drag.current = { mode:"draw",index:i,handle:0,start:p,before };
        }
      }} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}>
      <div className="training-dataset-canvas-track" style={{
        paddingLeft: canvasPadding.padX, paddingRight: canvasPadding.padX,
        paddingTop: canvasPadding.padY, paddingBottom: canvasPadding.padY,
      }}><div ref={bitmap} className="training-dataset-canvas-image game-mosaic-stage" style={{ width: displaySize.width, height: displaySize.height, ["--mosaic-preview-zoom" as string]: String(zoom) }}>
        {picture.url ? <img src={picture.url} alt={image.name} draggable={false} /> : <span>{picture.failed ? "图片读取失败" : "正在读取图片…"}</span>}
        <svg viewBox={`0 0 ${image.width} ${image.height}`} className={editable ? "is-editing" : undefined} aria-label="去码蒙版"
          style={tool === "select" ? { cursor: panning ? "grabbing" : "grab" } : undefined}>
        {drafts.map((mask,index) => <rect key={index} x={mask.box[0]} y={mask.box[1]} width={mask.box[2]-mask.box[0]} height={mask.box[3]-mask.box[1]}
          className={`game-mosaic-mask${hasSelection && selected === index ? " is-selected" : ""}${canSelectMask ? " is-clickable" : ""}`}
          data-mosaic-box={index} vectorEffect="non-scaling-stroke" role={canSelectMask ? "button" : undefined} tabIndex={canSelectMask ? 0 : undefined}
          aria-label={canSelectMask ? `蒙版 ${index + 1}` : undefined} aria-pressed={canSelectMask ? selected === index : undefined}
          onDoubleClick={event => { event.stopPropagation(); choosePart(index,event.clientX,event.clientY); }}
          onContextMenu={event => {
            if (!editable || busy) return;
            event.preventDefault(); event.stopPropagation();
            selectMask(index); menuPosition(contextMenu.current,event.clientX,event.clientY,88);
          }} onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); selectMask(index); }
          }} />)}
        {canSelectMask && hasSelection && <MaskResizeControls box={drafts[selected].box} />}
        </svg>
      </div></div>
    </div>
      {minimap && <div className="training-dataset-canvas-minimap" role="img" aria-label="画布导航"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          const inner = event.currentTarget.querySelector(".training-dataset-minimap-image")!.getBoundingClientRect();
          panToImagePoint(clamp((event.clientX - inner.left) / inner.width, 0, 1), clamp((event.clientY - inner.top) / inner.height, 0, 1));
        }}>
        <span className="training-dataset-minimap-image" style={{ width: minimap.mapW, height: minimap.mapH }}>
          <img src={minimap.url} alt="" draggable={false} />
          <span className="training-dataset-minimap-viewport" style={{
            left: minimap.view.left, top: minimap.view.top, width: minimap.view.width, height: minimap.view.height,
          }} aria-hidden="true" />
        </span>
      </div>}
      <div className="game-mosaic-image-tools" role="group" aria-label="原图蒙版工具"
        onDoubleClick={event => event.stopPropagation()}>
        {imageTools.map(tool => <button key={tool.id} type="button" className="game-mosaic-image-tool" data-tool={tool.id}
          aria-label={tool.label} aria-pressed={tool.pressed}
          aria-keyshortcuts={tool.modifier === "command" ? "Control+Z Meta+Z" : tool.id === "clear" && hasSelection ? "Delete Shift+Delete" : tool.shortcut}
          data-tooltip={[tool.label + " · " + tool.shortcut, tool.reason].filter(Boolean).join("\n")} disabled={tool.disabled} onClick={tool.run}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={tool.icon} /></svg>
        </button>)}
      </div>
    </div>
    <section className="training-dataset-regions" aria-label="区域清单">
      <header className="training-dataset-regions-head">
        <h4>蒙版</h4>
        <span>{drafts.length ? `${drafts.length} 框` : "暂无"}</span>
      </header>
      <div ref={table} className="training-dataset-region-table"><table><thead><tr>
        <th>#</th><th>部位</th><th>左</th><th>上</th><th>右</th><th>下</th><th>操作</th>
      </tr></thead><tbody>{drafts.map((mask,index) => <tr key={index} data-mask-row={index} aria-selected={selected === index} tabIndex={0}
        onClick={() => selectMask(index,true)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault();selectMask(index,true); } }}>
        <td>{index+1}</td><td><select aria-label={"蒙版 "+(index+1)+" 部位"} value={mask.part} disabled={!editable || busy}
          onChange={event => updatePart(index,event.target.value as DatasetPart | "")}><option value="">未知</option>
          {Object.entries(datasetParts).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></td>
        {mask.box.map((coordinate,i) => <td key={i}>{coordinate}</td>)}
        <td><button type="button" className="unity-btn" disabled={!editable || busy} onClick={event => {event.stopPropagation();remove(index);}}>删除</button></td>
      </tr>)}</tbody></table>{!drafts.length && <p className="hint">暂无蒙版框</p>}</div>
    </section>
    </div>
    <div className="training-dataset-write-state" role="status">{error ? <>写入失败：{error} <button className="unity-btn" type="button" onClick={() => persist(current.current)}>重试写入</button></>
      : saving ? "正在写入工作副本…" : editable ? `${drawing ? "添加蒙版：拖动画框" : "框选蒙版：拖空白或中键平移，B 添加蒙版"} · 双击框改部位 · Ctrl+Z 撤销 · Ctrl+Shift+Z 重做` : readOnlyHint || "只读数据集，创建标注副本后可编辑"}</div>
    <div ref={partsMenu} popover="auto" className="unity-gallery-menu" role="menu" aria-label="选择部位" style={{inset:"auto",margin:0}}
      onKeyDown={event => { event.stopPropagation(); if (["ArrowUp","ArrowDown","Home","End"].includes(event.key)) {
        event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll("button")],i=buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next=event.key==="Home"?0:event.key==="End"?3:(i+(event.key==="ArrowDown"?1:3))%4;buttons[next]?.focus();
      } }}>
      {([...Object.entries(datasetParts),["","未知"]] as [DatasetPart | "",string][]).map(([part,label]) => <button key={part} type="button" role="menuitemradio"
        aria-checked={current.current[selected]?.part === part} onClick={() => updatePart(selectedRef.current,part)}>{label}</button>)}
    </div>
    <div ref={contextMenu} popover="auto" className="unity-gallery-menu" role="menu" aria-label="蒙版操作" style={{inset:"auto",margin:0}} onKeyDown={event => event.stopPropagation()}>
      <button type="button" role="menuitem" onClick={() => {const r=contextMenu.current!.getBoundingClientRect();choosePart(selectedRef.current,r.left,r.top);}}>改部位</button>
      <button type="button" role="menuitem" onClick={() => remove(selectedRef.current)}>删除框</button>
    </div>
  </section>;
}
