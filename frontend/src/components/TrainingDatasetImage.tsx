import { Image as NativeImage } from "@tauri-apps/api/image";
import { isTauri } from "@tauri-apps/api/core";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { AnnotatedImage, AnnotatedSampleSet } from "../benchmark/imageSampleSet";
import { datasetParts, type DatasetPart } from "../benchmark/trainingDatasets";
import type { MosaicBox } from "../gameMosaic";
import { getFixedMenuPoint } from "../viewportLayout";
import { showAppNotice } from "./AppNotice";

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
  }, [image.sourceHash, read]);
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

export function TrainingDatasetImage({ image, read, masks, editing = false, busy, onSave, onClose }: {
  image: AnnotatedImage; read: AnnotatedSampleSet["read"]; masks: DatasetMask[];
  editing?: boolean; busy: boolean; onSave: (masks: DatasetMask[]) => void; onClose: () => void;
}) {
  const picture = useSamplePicture(image, read);
  const dialog = useRef<HTMLDialogElement>(null), stage = useRef<HTMLDivElement>(null), bitmap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1), [pan, setPan] = useState({ x: 0, y: 0 });
  const [drafts, setDrafts] = useState(() => masks.map(mask => ({ ...mask, box: [...mask.box] as MosaicBox })));
  const [history, setHistory] = useState<{ masks: DatasetMask[]; selected: number }[]>([]);
  const [selected, setSelected] = useState(Math.max(0, masks.length - 1));
  const [drawing, setDrawing] = useState(editing && masks.length === 0);
  const gesture = useRef<{ mode: "pan" | "draw" | "move" | "resize"; point: [number, number]; pan: typeof pan; box?: MosaicBox; corner?: number; undoSaved?: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    const fit = () => {
      if (!stage.current) return;
      setZoom(clamp(Math.min((stage.current.clientWidth - 32) / image.width, (stage.current.clientHeight - 32) / image.height), .25, 4));
      setPan({ x: 0, y: 0 });
    };
    fit();
    const observer = new ResizeObserver(fit);
    if (stage.current) observer.observe(stage.current);
    return () => { observer.disconnect(); dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [image.width, image.height]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); setZoom(value => clamp(value * Math.exp(-event.deltaY * .002), .25, 4)); };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  function point(event: PointerEvent): [number, number] {
    const rect = bitmap.current!.getBoundingClientRect();
    return [clamp(Math.round((event.clientX - rect.left) / rect.width * image.width), 0, image.width),
      clamp(Math.round((event.clientY - rect.top) / rect.height * image.height), 0, image.height)];
  }
  function rememberChange() {
    setHistory(values => [...values.slice(-99), { masks: drafts, selected }]);
  }
  function undoEdit() {
    const previous = history.at(-1);
    if (!previous || busy || gesture.current) return;
    setDrafts(previous.masks); setSelected(previous.selected); setDrawing(false);
    setHistory(values => values.slice(0, -1));
  }
  function changeBox(box: MosaicBox, checkpoint = false) {
    if (drafts[selected]?.box.every((value, index) => value === box[index])) return;
    if (checkpoint || (gesture.current && !gesture.current.undoSaved)) {
      rememberChange();
      if (gesture.current) gesture.current.undoSaved = true;
    }
    setDrafts(values => values.map((value, index) => index === selected ? { ...value, box } : value));
  }
  const active = drafts[selected];
  const copy = () => {
    menu.current?.hidePopover();
    void copyDatasetPicture(image, read).catch(error => showAppNotice(String(error), "error"));
  };
  return <dialog ref={dialog} className="training-image-viewer" aria-label={editing ? "编辑蒙版" : "查看原图"}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => {
      event.stopPropagation();
      if (editing && !busy && !event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey &&
          !event.shiftKey && event.key.toLowerCase() === "z" &&
          !(event.target as Element).closest("input,textarea,[contenteditable]")) {
        event.preventDefault(); undoEdit();
      }
    }}>
    <header><strong title={image.name}>{image.name}</strong>
      {editing && <button type="button" className="unity-btn" aria-pressed={drawing} disabled={busy}
        onClick={() => setDrawing(!drawing)}>{drawing ? "取消绘制" : "添加蒙版"}</button>}
      {editing && <button type="button" className="unity-btn" disabled={busy || !history.length}
        data-tooltip="撤销蒙版或部位修改 · Ctrl+Z，保留最近 100 次操作" onClick={undoEdit}>撤销</button>}
      <button type="button" className="unity-btn" aria-label="缩小原图" onClick={() => setZoom(value => clamp(value / 1.2, .25, 4))}>−</button>
      <button type="button" className="unity-btn" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>100%</button>
      <button type="button" className="unity-btn" aria-label="放大原图" onClick={() => setZoom(value => clamp(value * 1.2, .25, 4))}>+</button>
      <button type="button" className="unity-btn" disabled={busy} aria-label="关闭原图" onClick={onClose}>关闭</button>
    </header>
    <div className="training-image-viewer-content" data-editing={editing}>
      <div ref={stage} className="training-image-viewer-stage" data-drawing={drawing} onPointerDown={event => {
        if (event.button !== 0 || busy || !bitmap.current) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        const target = event.target as HTMLElement;
        const corner = target.dataset.corner;
        const index = target.closest<HTMLElement>("[data-mask-index]")?.dataset.maskIndex;
        if (editing && drawing && bitmap.current.contains(target)) {
          const p = point(event); const index = drafts.length;
          rememberChange();
          setDrafts(values => [...values, { box: [p[0], p[1], p[0], p[1]], part: "" }]); setSelected(index);
          gesture.current = { mode: "draw", point: p, pan, undoSaved: true };
        } else if (editing && index !== undefined) {
          const i = Number(index); setSelected(i);
          gesture.current = { mode: corner === undefined ? "move" : "resize", corner: Number(corner), point: point(event), pan, box: drafts[i].box };
        } else gesture.current = { mode: "pan", point: [event.clientX, event.clientY], pan };
      }} onPointerMove={event => {
        const start = gesture.current;
        if (!start) return;
        if (start.mode === "pan") {
          const scale = event.currentTarget.currentCSSZoom || 1;
          setPan({ x: start.pan.x + (event.clientX - start.point[0]) / scale, y: start.pan.y + (event.clientY - start.point[1]) / scale });
          return;
        }
        const p = point(event);
        if (start.mode === "draw") changeBox(rectangle(start.point, p));
        else if (start.box && start.mode === "move") {
          const [x0,y0,x1,y1] = start.box;
          const dx = clamp(p[0] - start.point[0], -x0, image.width - x1), dy = clamp(p[1] - start.point[1], -y0, image.height - y1);
          changeBox([x0+dx,y0+dy,x1+dx,y1+dy]);
        } else if (start.box) {
          const [x0,y0,x1,y1] = start.box, opposite = start.corner === 0 ? [x1,y1] : start.corner === 1 ? [x0,y1] : start.corner === 2 ? [x0,y0] : [x1,y0];
          changeBox(rectangle(opposite, p));
        }
      }} onPointerUp={() => {
        if (gesture.current?.mode === "draw") setDrawing(false);
        gesture.current = undefined;
        setDrafts(values => values.filter(mask => mask.box[2] > mask.box[0] && mask.box[3] > mask.box[1]));
      }} onPointerCancel={() => { gesture.current = undefined; }} onContextMenu={event => {
        event.preventDefault();
        if (!menu.current) return;
        const p = getFixedMenuPoint(event.clientX, event.clientY, 150, 42);
        menu.current.style.left = p.x + "px"; menu.current.style.top = p.y + "px"; menu.current.showPopover();
        menu.current.querySelector("button")?.focus({ preventScroll: true });
      }}>
        <div ref={bitmap} className="training-image-viewer-bitmap" style={{ width: image.width, height: image.height,
          transform: "translate(-50%, -50%) translate(" + pan.x + "px," + pan.y + "px) scale(" + zoom + ")" }}>
          {picture.url ? <img src={picture.url} alt={image.name} draggable={false} /> : <span>{picture.failed ? "图片读取失败" : "读取中…"}</span>}
          {drafts.map((mask, index) => <span key={index} className="training-image-edit-mask" data-mask-index={index}
            data-selected={index === selected} style={{ left: mask.box[0], top: mask.box[1], width: mask.box[2]-mask.box[0], height: mask.box[3]-mask.box[1], borderWidth: 2 / zoom }}>
            <b style={{ fontSize: 12 / zoom }}>{index + 1}{mask.part ? " · " + datasetParts[mask.part] : " · 未知"}</b>
            {editing && index === selected && [0,1,2,3].map(corner => <i key={corner} data-corner={corner} style={{ width: 8 / zoom, height: 8 / zoom }} />)}
          </span>)}
        </div>
        <output className="training-image-viewer-scale">{Math.round(zoom * 100)}% · {image.width} × {image.height}</output>
      </div>
      {editing && <aside className="training-image-editor">
        <h3>蒙版与部位</h3><p className="hint">拖动框可移动，拖动角点可调整。保存后写入工作副本。</p>
        <ul>{drafts.map((mask, index) => <li key={index}><button className="unity-btn" type="button" aria-pressed={selected === index}
          onClick={() => setSelected(index)}>蒙版 {index + 1} · {mask.part ? datasetParts[mask.part] : "未知"}</button></li>)}</ul>
        {active && <>
          <label>部位<select aria-label="蒙版部位" disabled={busy} value={active.part} onChange={event => {
            const part = event.target.value as DatasetPart | "";
            rememberChange();
            setDrafts(values => values.map((mask, index) => index === selected ? { ...mask, part } : mask));
          }}><option value="">未知</option>{Object.entries(datasetParts).map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <dl>{active.box.map((value, coordinate) => <div key={coordinate}><dt>{["左","上","右","下"][coordinate]}</dt><dd><input type="number" aria-label={"蒙版" + ["左","上","右","下"][coordinate]}
            value={value} min={0} max={coordinate % 2 === 0 ? image.width : image.height} disabled={busy} onChange={event => {
              const next = [...active.box] as MosaicBox; next[coordinate] = clamp(Math.round(Number(event.target.value)), 0, coordinate % 2 === 0 ? image.width : image.height); changeBox(next, true);
            }} /></dd></div>)}</dl>
          <button type="button" className="unity-btn" disabled={busy} onClick={() => { rememberChange(); setDrafts(values => values.filter((_,index) => index !== selected)); setSelected(0); }}>删除蒙版</button>
        </>}
        <button type="button" className="unity-btn unity-btn-primary" disabled={busy || drafts.some(mask => mask.box[2] <= mask.box[0] || mask.box[3] <= mask.box[1])}
          onClick={() => onSave(drafts)}>保存蒙版与部位</button>
      </aside>}
    </div>
    <div ref={menu} popover="auto" className="unity-gallery-menu" role="menu" aria-label="原图操作" style={{ inset: "auto", margin: 0 }}>
      <button type="button" role="menuitem" onClick={copy}>复制图片</button>
    </div>
  </dialog>;
}
