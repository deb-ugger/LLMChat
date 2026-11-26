import { Image as NativeImage } from "@tauri-apps/api/image";
import { isTauri } from "@tauri-apps/api/core";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { AnnotatedImage, AnnotatedSampleSet } from "../benchmark/imageSampleSet";
import { datasetParts, type DatasetPart } from "../benchmark/trainingDatasets";
import type { MosaicBox } from "../gameMosaic";
import { getFixedMenuPoint } from "../viewportLayout";
import { showAppNotice } from "./AppNotice";
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

export function TrainingDatasetImage({ image, read, masks, editable, busy, onChange, onUndo, canUndo, onRedo, canRedo, onPreview, onContextMenu, readOnlyHint }: {
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
  const anchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | undefined>(undefined);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const [drawing, setDrawing] = useState(true);
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
      setFit(Math.max(.01, Math.min(4, (element.clientWidth - 74) / image.width, (element.clientHeight - 26) / image.height)));
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [image.width, image.height]);
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
  function fitImage() {
    anchor.current = undefined;
    setManualZoom(undefined);
    requestAnimationFrame(() => {
      const view = viewport.current;
      if (view) { view.scrollLeft = (view.scrollWidth - view.clientWidth) / 2; view.scrollTop = (view.scrollHeight - view.clientHeight) / 2; }
    });
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
  }, [zoom, viewportSize]);
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
  function copySelected() {
    const mask = current.current[selectedRef.current];
    if (!editable || busy || !mask) return;
    const dx = Math.min(10, image.width - mask.box[2]), dy = Math.min(10, image.height - mask.box[3]);
    const box: MosaicBox = [mask.box[0] + dx, mask.box[1] + dy, mask.box[2] + dx, mask.box[3] + dy];
    const next = [...current.current, { ...mask, box }]; persist(next); selectMask(next.length - 1, true);
  }
  function cancelGesture() {
    if (drag.current) { display(drag.current.before); drag.current = undefined; selectMask(Math.min(selectedRef.current, current.current.length - 1)); }
    pan.current = undefined;
  }
  function point(event: PointerEvent): [number,number] {
    const r = bitmap.current!.getBoundingClientRect();
    return [clamp(Math.round((event.clientX-r.left)/r.width*image.width),0,image.width),
      clamp(Math.round((event.clientY-r.top)/r.height*image.height),0,image.height)];
  }
  function move(event: PointerEvent) {
    if (pan.current && viewport.current) {
      viewport.current.scrollLeft = pan.current.left - (event.clientX - pan.current.x);
      viewport.current.scrollTop = pan.current.top - (event.clientY - pan.current.y); return;
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
    if (pan.current) { pan.current = undefined; return; }
    const gesture = drag.current;
    if (!gesture) return;
    move(event); drag.current = undefined;
    const mask = current.current[gesture.index];
    if (!mask || mask.box[2] <= mask.box[0] || mask.box[3] <= mask.box[1]) { display(gesture.before); return; }
    if (JSON.stringify(current.current) !== JSON.stringify(gesture.before)) persist(current.current);
    if (gesture.mode === "draw") choosePart(gesture.index,event.clientX,event.clientY);
  }
  const known = drafts.filter(mask => !!mask.part).length;
  const hasSelection = selected >= 0 && selected < drafts.length;
  const tools = [
    { id: "fit", label: "适应画布", shortcut: "F", icon: "M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5", run: fitImage },
    { id: "out", label: "缩小标注画布", shortcut: "-", icon: "M5 12h14", run: () => changeZoom(zoom / 1.1) },
    { id: "scale", label: "恢复100%比例", shortcut: "0", text: Math.round(zoom * 100) + "%", run: () => changeZoom(1) },
    { id: "in", label: "放大标注画布", shortcut: "+", icon: "M5 12h14M12 5v14", run: () => changeZoom(zoom * 1.1) },
    { id: "draw", label: "框选模式", shortcut: "B", icon: "M4 4h16v16H4zM1 4h6M4 1v6M17 20h6M20 17v6", pressed: drawing, disabled: !editable || busy, run: () => setDrawing(value => !value) },
    { id: "delete", label: "删除选中框", shortcut: "Delete", icon: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6", disabled: !editable || busy || !hasSelection, run: () => remove(selectedRef.current) },
    { id: "copy", label: "复制选中框", shortcut: "C", icon: "M8 8h12v12H8zM16 4H4v12", disabled: !editable || busy || !hasSelection, run: copySelected },
    { id: "undo", label: "撤销标注", shortcut: "Ctrl+Z", icon: "m8 5-4 4 4 4M4 9h10a5 5 0 0 1 0 10h-3", disabled: !canUndo || busy, run: onUndo },
    { id: "preview", label: "查看原图", shortcut: "V", icon: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6", run: onPreview },
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
    const tool = tools.find(tool => tool.shortcut.toLowerCase() === key || tool.id === "in" && key === "=");
    if (!tool || tool.disabled) return;
    event.preventDefault(); event.stopPropagation(); tool.run();
  }}>
    <header className="training-dataset-editor-tools">
      <div className="training-dataset-editor-identity">
        <strong title={image.sourceDirectory || image.file}>{image.name}</strong>
        <span>{image.width} × {image.height}</span>
        <span className="hint">已标部位 {known} / {drafts.length} 框</span>
      </div>
    </header>
    <div className="training-dataset-editor-main">
    <div className="training-dataset-canvas-frame">
    <div ref={viewport} tabIndex={0} className="training-dataset-canvas" data-drawing={drawing && editable} aria-label="图片画布" onContextMenu={onContextMenu}
      onDoubleClick={event => { if (pointerHit.current >= 0) { event.stopPropagation(); choosePart(pointerHit.current,event.clientX,event.clientY); } }}
      onPointerDown={event => {
        pointerHit.current = -1;
        if (event.button !== 0 || busy) return;
        const index = (event.target as HTMLElement).closest<HTMLElement>("[data-canvas-mask]")?.dataset.canvasMask;
        pointerHit.current = index === undefined ? -1 : Number(index);
        if (index !== undefined) selectMask(Number(index));
        const inside = bitmap.current?.contains(event.target as Node);
        if (index === undefined && (!drawing || !editable)) {
          event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
          pan.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; return;
        }
        if (!editable || !inside) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll:true }); event.currentTarget.setPointerCapture(event.pointerId);
        partsMenu.current?.hidePopover(); contextMenu.current?.hidePopover();
        const p = point(event), before = copy(current.current);
        if (index !== undefined) {
          const handle = (event.target as HTMLElement).dataset.handle;
          drag.current = { mode:handle === undefined ? "move" : "resize",index:Number(index),handle:Number(handle),start:p,before,box:[...current.current[Number(index)].box] };
        } else {
          const i = current.current.length; display([...current.current,{box:[p[0],p[1],p[0],p[1]],part:""}]); selectMask(i);
          drag.current = { mode:"draw",index:i,handle:0,start:p,before };
        }
      }} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}>
      <div className="training-dataset-canvas-track" style={{ paddingInline: viewportSize.width, paddingBlock: viewportSize.height }}><div ref={bitmap} className="training-dataset-canvas-image" style={{width:image.width*zoom,height:image.height*zoom}}>
        {picture.url ? <img src={picture.url} alt={image.name} draggable={false} /> : <span>{picture.failed ? "图片读取失败" : "正在读取图片…"}</span>}
        {drafts.map((mask,index) => <span key={index} className="training-dataset-canvas-mask" role="button" tabIndex={0}
          aria-label={"蒙版 "+(index+1)+"："+(mask.part ? datasetParts[mask.part] : "未知")} aria-pressed={selected === index}
          data-canvas-mask={index} data-selected={selected === index}
          style={{left:mask.box[0]*zoom,top:mask.box[1]*zoom,width:(mask.box[2]-mask.box[0])*zoom,height:(mask.box[3]-mask.box[1])*zoom}}
          onDoubleClick={event => { event.stopPropagation(); choosePart(index,event.clientX,event.clientY); }}
          onContextMenu={event => {
            if (!editable || busy) return;
            event.preventDefault(); event.stopPropagation();
            selectMask(index); menuPosition(contextMenu.current,event.clientX,event.clientY,88);
          }} onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); const r=event.currentTarget.getBoundingClientRect();choosePart(index,r.left,r.bottom); }
          }}>
          <b>{index+1} {mask.part ? datasetParts[mask.part] : "未知"}</b>
          {editable && selected === index && handles.map(([x,y],handle) => <i key={handle} data-handle={handle} style={{left:x*100+"%",top:y*100+"%"}} />)}
        </span>)}
      </div></div>
    </div>
      <aside className="game-mosaic-image-tools" role="group" aria-label="标注画布工具" onDoubleClick={event => event.stopPropagation()}>
        {tools.map(tool => <button key={tool.id} type="button" className="game-mosaic-image-tool" data-tool={tool.id}
          aria-label={tool.label} aria-pressed={tool.pressed} aria-keyshortcuts={tool.id === "undo" ? "Control+Z Meta+Z" : tool.shortcut === "+" ? "Plus" : tool.shortcut}
          data-tooltip={tool.label + " · " + tool.shortcut} disabled={tool.disabled} onClick={tool.run}>
          {tool.text ?? <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={tool.icon} /></svg>}
        </button>)}
      </aside>
    </div>
    <section className="training-dataset-regions" aria-label="区域清单">
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
      : saving ? "正在写入工作副本…" : editable ? "滚轮缩放 · 拖空白处画框 · 双击框改部位 · 方向键微移 · Ctrl+Z 撤销 · Ctrl+Shift+Z 重做" : readOnlyHint || "只读数据集，创建标注副本后可编辑"}</div>
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
